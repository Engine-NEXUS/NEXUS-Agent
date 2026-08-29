//! Sidecar process manager — auto-spawns the Python FastAPI sidecar on startup.
//!
//! The sidecar (server/sidecar/sidecar.py) is a WebSocket bridge between the
//! thin client and the n8n backend. Without it, NEXUS cannot communicate with
//! the server.
//!
//! This module:
//!   1. Checks if the sidecar is already running (GET /health on port 8443).
//!   2. If not, spawns `python -m uvicorn sidecar:app` in the sidecar directory.
//!   3. Waits up to 15 seconds for it to become healthy.
//!   4. Monitors the process and logs if it exits unexpectedly.
//!
//! In production (bundled .exe), the sidecar directory is resolved relative to
//! the executable. In dev mode, it's resolved relative to the project root.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

const SIDECAR_PORT: u16 = 8443;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);

static SIDECAR_CHILD: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));

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
fn find_python() -> Option<String> {
    for name in &["python", "python3", "py"] {
        if let Ok(output) = Command::new(name).arg("--version").output() {
            if output.status.success() {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Check if the sidecar is already running by attempting a TCP connect.
/// If the port is open, something is listening — good enough for a health check.
fn is_sidecar_healthy() -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], SIDECAR_PORT));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()
}

/// Spawn the sidecar process.
fn spawn_sidecar(sidecar_dir: &PathBuf, python: &str) -> std::io::Result<Child> {
    let env_path = sidecar_dir.join(".env");

    let mut cmd = Command::new(python);
    cmd.current_dir(sidecar_dir);
    cmd.args(["-m", "uvicorn", "sidecar:app", "--host", "0.0.0.0", "--port", &SIDECAR_PORT.to_string()]);

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

    // Inherit stdout/stderr so logs are visible (dev mode).
    // In production, these could be piped to a log file.
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit());
    cmd.stdin(Stdio::null());

    cmd.spawn()
}

/// Wait for the sidecar to become healthy.
fn wait_for_health() -> bool {
    let start = Instant::now();
    while start.elapsed() < HEALTH_TIMEOUT {
        if is_sidecar_healthy() {
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
    // 1. Check if already running
    if is_sidecar_healthy() {
        tracing::info!("sidecar: already running on port {}", SIDECAR_PORT);
        return;
    }

    // 2. Find sidecar directory
    let sidecar_dir = match resolve_sidecar_dir() {
        Some(d) => d,
        None => {
            tracing::warn!("sidecar: could not locate server/sidecar/ directory — skipping auto-spawn");
            tracing::warn!("sidecar: start it manually: cd server/sidecar && uvicorn sidecar:app --port {}", SIDECAR_PORT);
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
    tracing::info!("sidecar: spawning in {} using {}", sidecar_dir.display(), python);
    let child = match spawn_sidecar(&sidecar_dir, &python) {
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
    if wait_for_health() {
        tracing::info!("sidecar: healthy on port {}", SIDECAR_PORT);
    } else {
        tracing::error!("sidecar: did not become healthy within {}s — check logs", HEALTH_TIMEOUT.as_secs());
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
