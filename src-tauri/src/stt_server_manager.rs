//! STT server process manager — auto-spawns the faster-whisper STT server on startup.
//!
//! The STT server (server/stt_server.py) runs a local faster-whisper model
//! on port 8000. It receives raw PCM audio from the NEXUS client, transcribes
//! it to text, and returns the transcript. Audio NEVER leaves the device.
//!
//! Without this server, NEXUS cannot transcribe speech — every command
//! fails with "Didn't catch that, sir." because the STT endpoint is unreachable.
//!
//! This module mirrors sidecar_manager.rs:
//!   1. Checks if the STT server is already running (HTTP GET /health on port 8000).
//!   2. If not, spawns `python -m uvicorn stt_server:app` in the server directory.
//!   3. Waits up to 30 seconds for it to become healthy (model loading takes time).
//!   4. On Windows, uses CREATE_NO_WINDOW so no terminal pops up.
//!   5. Redirects stdout/stderr to a log file in the app data directory.
//!
//! Port: Default 8000. Override with NEXUS_STT_PORT env var.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

const DEFAULT_STT_PORT: u16 = 8000;
/// Longer than sidecar — faster-whisper model loading can take 10-20s on CPU.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);

static STT_CHILD: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));

/// Get the STT port — from env var or default.
fn stt_port() -> u16 {
    std::env::var("NEXUS_STT_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_STT_PORT)
}

/// Resolve the STT log file path in the app data directory.
fn resolve_log_path() -> PathBuf {
    if let Some(dir) = dirs_next::data_dir() {
        let app_dir = dir.join("com.nexus.assistant");
        let _ = std::fs::create_dir_all(&app_dir);
        app_dir.join("stt_server.log")
    } else {
        PathBuf::from("stt_server.log")
    }
}

/// Resolve the server directory containing stt_server.py.
///
/// Dev mode:  <project_root>/server/
/// Prod mode: <exe_dir>/server/  (if bundled alongside the .exe)
fn resolve_server_dir() -> Option<PathBuf> {
    let candidates = [
        // Dev: walk up from exe to find server/stt_server.py
        std::env::current_exe().ok().and_then(|e| {
            e.ancestors()
                .find(|a| a.join("server").join("stt_server.py").exists())
                .map(|a| a.join("server"))
        }),
        // Dev: CARGO_MANIFEST_DIR (set by cargo at compile time)
        option_env!("CARGO_MANIFEST_DIR").map(|d| {
            PathBuf::from(d).join("..").join("server")
        }),
        // Prod: alongside the .exe
        std::env::current_exe().ok().map(|e| {
            e.parent().unwrap_or(PathBuf::from(".").as_path()).join("server")
        }),
    ];

    for candidate in candidates.iter().flatten() {
        if candidate.join("stt_server.py").exists() {
            return Some(candidate.canonicalize().unwrap_or_else(|_| candidate.to_path_buf()));
        }
    }
    None
}

/// Find a usable Python executable (same logic as sidecar_manager).
fn find_python() -> Option<String> {
    #[cfg(target_os = "windows")]
    const CANDIDATES: &[&str] = &["pythonw", "python", "python3", "py"];
    #[cfg(not(target_os = "windows"))]
    const CANDIDATES: &[&str] = &["python3", "python"];

    for name in CANDIDATES {
        let mut cmd = Command::new(name);
        cmd.arg("--version");
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Check if the STT server is already running by attempting an HTTP health check.
fn is_stt_healthy(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    // TCP connect is faster than HTTP for health checking.
    // If the port is open, the server is listening.
    std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()
}

/// Spawn the STT server process — no terminal window, logs to file.
fn spawn_stt(server_dir: &PathBuf, python: &str, port: u16) -> std::io::Result<Child> {
    let mut cmd = Command::new(python);
    cmd.current_dir(server_dir);
    cmd.args([
        "-m", "uvicorn", "stt_server:app",
        "--host", "127.0.0.1",
        "--port", &port.to_string(),
    ]);

    // Pass through WHISPER_* env vars if set, otherwise use defaults
    // (base model, CPU, int8 compute — good balance for most hardware).
    // The stt_server.py reads these directly from os.getenv().

    // Redirect stdout/stderr to a log file.
    let log_path = resolve_log_path();
    let log_file = std::fs::File::create(&log_path)?;
    let log_stderr = log_file.try_clone()?;
    cmd.stdout(Stdio::from(log_file));
    cmd.stderr(Stdio::from(log_stderr));
    cmd.stdin(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
}

/// Wait for the STT server to become healthy.
/// The faster-whisper model loads lazily on first transcription request,
/// but uvicorn binds the port immediately on startup. So TCP connect is
/// sufficient to know the server is ready to accept requests.
fn wait_for_health(port: u16) -> bool {
    let start = Instant::now();
    while start.elapsed() < HEALTH_TIMEOUT {
        if is_stt_healthy(port) {
            return true;
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
    false
}

/// Initialize the STT server — call once during Tauri setup.
///
/// 1. If STT server is already running → do nothing.
/// 2. If not → spawn it and wait for health.
/// 3. Store the child handle so we can kill it on exit.
pub fn init() {
    let port = stt_port();

    // 1. Check if already running
    if is_stt_healthy(port) {
        tracing::info!("stt_server: already running on port {}", port);
        return;
    }

    // 2. Find server directory
    let server_dir = match resolve_server_dir() {
        Some(d) => d,
        None => {
            tracing::warn!("stt_server: could not locate server/stt_server.py — skipping auto-spawn");
            tracing::warn!("stt_server: start it manually: cd server && uvicorn stt_server:app --port {}", port);
            return;
        }
    };

    // 3. Find Python
    let python = match find_python() {
        Some(p) => p,
        None => {
            tracing::warn!("stt_server: Python not found on PATH — skipping auto-spawn");
            return;
        }
    };

    // 4. Spawn
    tracing::info!("stt_server: spawning in {} using {} on port {}", server_dir.display(), python, port);
    let child = match spawn_stt(&server_dir, &python, port) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("stt_server: failed to spawn: {e}");
            return;
        }
    };

    let pid = child.id();
    *STT_CHILD.lock().unwrap() = Some(child);
    tracing::info!("stt_server: spawned (PID {}), waiting for health...", pid);

    // 5. Wait for health
    if wait_for_health(port) {
        tracing::info!("stt_server: healthy on port {}", port);
    } else {
        let log_path = resolve_log_path();
        tracing::error!(
            "stt_server: did not become healthy within {}s — check logs at {}",
            HEALTH_TIMEOUT.as_secs(),
            log_path.display()
        );
    }
}

/// Kill the STT server process on app exit.
#[allow(dead_code)]
pub fn shutdown() {
    if let Some(mut child) = STT_CHILD.lock().unwrap().take() {
        tracing::info!("stt_server: shutting down (PID {})", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}
