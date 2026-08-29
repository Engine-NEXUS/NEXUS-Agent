//! Sidecar process manager — auto-spawns the Python FastAPI sidecar on startup.
//!
//! The sidecar (server/sidecar/sidecar.py) is a WebSocket bridge between the
//! thin client and the n8n backend. Without it, NEXUS cannot communicate with
//! the server.
//!
//! This module:
//!   1. Checks if the sidecar is already running (TCP connect on configured port).
//!   2. If not, spawns `python -m uvicorn sidecar:app` in the sidecar directory.
//!   3. Waits up to 15 seconds for it to become healthy.
//!   4. On Windows, uses CREATE_NO_WINDOW so no terminal pops up.
//!   5. Redirects stdout/stderr to a log file in the app data directory.
//!
//! Port: Default 49152 (IANA dynamic/private range — avoids dev conflicts).
//!       Override with NEXUS_SIDECAR_PORT env var in .env.
//!
//! In production (bundled .exe), the sidecar directory is resolved relative to
//! the executable. In dev mode, it's resolved relative to the project root.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

/// Default port — IANA dynamic/private range (49152-65535).
/// This avoids conflicts with common dev ports (3000, 5173, 8000, 8080, 8443).
/// Override via NEXUS_SIDECAR_PORT in .env.
const DEFAULT_SIDECAR_PORT: u16 = 49152;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);

static SIDECAR_CHILD: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));

/// Get the sidecar port — from env var or default.
fn sidecar_port() -> u16 {
    std::env::var("NEXUS_SIDECAR_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_SIDECAR_PORT)
}

/// Resolve the log file path in the app data directory.
/// On Windows: %LOCALAPPDATA%\com.nexus.assistant\sidecar.log
/// On macOS:   ~/Library/Application Support/com.nexus.assistant/sidecar.log
/// On Linux:   ~/.local/share/com.nexus.assistant/sidecar.log
fn resolve_log_path() -> PathBuf {
    if let Some(dir) = dirs_next::data_dir() {
        let app_dir = dir.join("com.nexus.assistant");
        let _ = std::fs::create_dir_all(&app_dir);
        app_dir.join("sidecar.log")
    } else {
        PathBuf::from("sidecar.log")
    }
}

/// Resolve the sidecar directory.
///
/// Dev mode:  <project_root>/server/sidecar/
/// Prod mode: <exe_dir>/sidecar/  (if bundled alongside the .exe)
fn resolve_sidecar_dir() -> Option<PathBuf> {
    // Try dev mode: walk up from CARGO_MANIFEST_DIR or current exe to find server/sidecar
    let candidates = [
        // Dev: relative to the executable (cargo target dir → project root)
        std::env::current_exe().ok().and_then(|e| {
            e.ancestors()
                .find(|a| a.join("server").join("sidecar").join("sidecar.py").exists())
                .map(|a| a.join("server").join("sidecar"))
        }),
        // Dev: CARGO_MANIFEST_DIR (set by cargo at compile time)
        option_env!("CARGO_MANIFEST_DIR").map(|d| {
            PathBuf::from(d).join("..").join("server").join("sidecar")
        }),
        // Prod: alongside the .exe
        std::env::current_exe().ok().map(|e| {
            e.parent().unwrap_or(PathBuf::from(".").as_path()).join("sidecar")
        }),
    ];

    for candidate in candidates.iter().flatten() {
        if candidate.join("sidecar.py").exists() {
            return Some(candidate.canonicalize().unwrap_or_else(|_| candidate.to_path_buf()));
        }
    }
    None
}

/// Find a usable Python executable.
/// On Windows, prefers pythonw.exe — the windowless GUI-subsystem Python that
/// can NEVER show a console window (unlike python.exe, where CREATE_NO_WINDOW
/// is not bulletproof on Win11 + Windows Terminal). pythonw.exe lives in the
/// same install dir as python.exe, so it's on PATH whenever python is.
/// Uses CREATE_NO_WINDOW on Windows so detection probes don't flash a console.
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

/// Check if the sidecar is already running by attempting a TCP connect.
/// If the port is open, something is listening — good enough for a health check.
fn is_sidecar_healthy(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()
}

/// Spawn the sidecar process — no terminal window, logs to file.
fn spawn_sidecar(sidecar_dir: &PathBuf, python: &str, port: u16) -> std::io::Result<Child> {
    let env_path = sidecar_dir.join(".env");

    let mut cmd = Command::new(python);
    cmd.current_dir(sidecar_dir.parent().unwrap_or(sidecar_dir));
    cmd.args(["-m", "uvicorn", "sidecar.sidecar:app", "--host", "127.0.0.1", "--port", &port.to_string()]);

    // Load .env file manually (uvicorn doesn't auto-load .env)
    if env_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') { continue; }
                if let Some(eq_idx) = line.find('=') {
                    let key = &line[..eq_idx];
                    let val = &line[eq_idx + 1..];
                    cmd.env(key, val);
                }
            }
        }
    }

    // Redirect stdout/stderr to a log file (truncated on each startup).
    // This prevents a terminal window from appearing and keeps logs for debugging.
    let log_path = resolve_log_path();
    let log_file = std::fs::File::create(&log_path)?;
    let log_stderr = log_file.try_clone()?;
    cmd.stdout(Stdio::from(log_file));
    cmd.stderr(Stdio::from(log_stderr));
    cmd.stdin(Stdio::null());

    // Windows: CREATE_NO_WINDOW — prevents a console window from popping up.
    // This is the critical flag for silent background operation.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
}

/// Wait for the sidecar to become healthy.
fn wait_for_health(port: u16) -> bool {
    let start = Instant::now();
    while start.elapsed() < HEALTH_TIMEOUT {
        if is_sidecar_healthy(port) {
            return true;
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
    false
}

/// Initialize the sidecar — call once during Tauri setup.
///
/// 1. If sidecar is already running → do nothing.
/// 2. If not → spawn it and wait for health.
/// 3. Store the child handle so we can kill it on exit.
pub fn init() {
    let port = sidecar_port();

    // 1. Check if already running
    if is_sidecar_healthy(port) {
        tracing::info!("sidecar: already running on port {}", port);
        return;
    }

    // 2. Find sidecar directory
    let sidecar_dir = match resolve_sidecar_dir() {
        Some(d) => d,
        None => {
            tracing::warn!("sidecar: could not locate server/sidecar/ directory — skipping auto-spawn");
            tracing::warn!("sidecar: start it manually: cd server/sidecar && uvicorn sidecar:app --port {}", port);
            return;
        }
    };

    // 3. Find Python
    let python = match find_python() {
        Some(p) => p,
        None => {
            tracing::warn!("sidecar: Python not found on PATH — skipping auto-spawn");
            tracing::warn!("sidecar: install Python or start the sidecar manually");
            return;
        }
    };

    // 4. Spawn
    tracing::info!("sidecar: spawning in {} using {} on port {}", sidecar_dir.display(), python, port);
    let child = match spawn_sidecar(&sidecar_dir, &python, port) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("sidecar: failed to spawn: {e}");
            return;
        }
    };

    let pid = child.id();
    *SIDECAR_CHILD.lock().unwrap() = Some(child);
    tracing::info!("sidecar: spawned (PID {}), waiting for health...", pid);

    // 5. Wait for health
    if wait_for_health(port) {
        tracing::info!("sidecar: healthy on port {}", port);
    } else {
        let log_path = resolve_log_path();
        tracing::error!(
            "sidecar: did not become healthy within {}s — check logs at {}",
            HEALTH_TIMEOUT.as_secs(),
            log_path.display()
        );
    }
}

/// Kill the sidecar process on app exit.
/// Currently unused — the sidecar is left running so the next NEXUS launch
/// is instant (init() detects it's already healthy and skips spawning).
#[allow(dead_code)]
pub fn shutdown() {
    if let Some(mut child) = SIDECAR_CHILD.lock().unwrap().take() {
        tracing::info!("sidecar: shutting down (PID {})", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}
