# Change: Auto-Spawn Sidecar

**Commit:** `61c9c53` ("fix: auto-spawn sidecar + build production app (no more localhost:5173 error)")
**Date:** 2026-08-19

---

## Problem

Users had to manually start the Python sidecar before launching NEXUS. If they forgot, NEXUS couldn't communicate with the backend.

## Fix

Added `sidecar_manager.rs` — a module that auto-spawns the sidecar on NEXUS startup:

```rust
pub fn init() {
    let port = sidecar_port();

    // 1. Check if already running
    if is_sidecar_healthy(port) {
        tracing::info!("sidecar: already running on port {}", port);
        return;
    }

    // 2. Find sidecar directory (dev or prod)
    let sidecar_dir = match resolve_sidecar_dir() { ... };

    // 3. Find Python (prefer pythonw on Windows)
    let python = match find_python() { ... };

    // 4. Spawn
    let child = spawn_sidecar(&sidecar_dir, &python, port)?;

    // 5. Wait for health
    if wait_for_health(port) {
        tracing::info!("sidecar: healthy on port {}", port);
    }
}
```

## Sidecar Directory Resolution

The module tries multiple paths to find the sidecar:

```rust
fn resolve_sidecar_dir() -> Option<PathBuf> {
    // Dev: walk up from exe to find server/sidecar/sidecar.py
    // Dev: CARGO_MANIFEST_DIR/../server/sidecar
    // Prod: exe_dir/sidecar/ (if bundled alongside the .exe)
}
```

## Package-Qualified Invocation

The sidecar uses relative imports (`from . import db`), so it must be launched as a package:

```
pythonw -m uvicorn sidecar.sidecar:app --host 127.0.0.1 --port 49152
```

The working directory is set to the **parent** of the `sidecar/` directory so the `sidecar` package is importable.

## .env Loading

uvicorn doesn't auto-load `.env` files. The sidecar manager loads it manually:

```rust
let env_path = sidecar_dir.join(".env");
if env_path.exists() {
    if let Ok(content) = std::fs::read_to_string(&env_path) {
        for line in content.lines() {
            // Parse KEY=VALUE and set as env var
            cmd.env(key, val);
        }
    }
}
```

## Health Check

TCP connect to `127.0.0.1:port` with a 2-second timeout. Polls every 500ms for up to 15 seconds.

## Sidecar Reuse

The sidecar is **left running** after NEXUS exits. On the next launch, `is_sidecar_healthy()` succeeds → skip spawning → instant startup.

## Files Changed

- `src-tauri/src/sidecar_manager.rs` — new file (the manager).
- `src-tauri/src/lib.rs` — added `mod sidecar_manager;` and `sidecar_manager::init()` call in setup (later made non-blocking in `f4e6ac6`).

## Result

- Sidecar auto-starts with NEXUS — no manual intervention.
- No terminal window (uses `pythonw.exe`).
- Logs to file (not console).
- Reused on next launch (instant startup).
