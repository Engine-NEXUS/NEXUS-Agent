# Feature: Sidecar Manager

> Auto-spawns the Python FastAPI sidecar on NEXUS startup, in the background, with no terminal window, and leaves it running for instant restart.

**Source files:**
- `src-tauri/src/sidecar_manager.rs` — the manager
- `src-tauri/src/lib.rs` — `std::thread::spawn(sidecar_manager::init)` (non-blocking)
- `server/sidecar/sidecar.py` — the sidecar itself

---

## What the Sidecar Is

The sidecar is a Python FastAPI app that bridges the thin client to the n8n backend:
- WebSocket `/ws` — text-only protocol (transcript up, result down).
- HTTP `/oauth/*` — Google + GitHub token exchange.
- HTTP `/apikeys/*` — encrypted API key storage.
- HTTP `/health` — liveness probe.

Without it, NEXUS can't communicate with the server.

## The Startup Problem

Python + uvicorn cold-start takes 3-8 seconds on a fresh boot. If the sidecar startup blocked the Tauri setup hook, the orb wouldn't appear for 3-8 seconds — making NEXUS feel broken.

## The Solution: Non-Blocking Spawn

```rust
// In lib.rs setup hook:
std::thread::spawn(sidecar_manager::init);
// Returns immediately — frontend loads while sidecar starts in background.
```

The frontend's WebSocket retry logic (1s → 2s → 4s → 8s backoff in `wsBridge.ts`) connects once the sidecar is ready.

## Sidecar Lifecycle

```
1. init() called (background thread)
2. Is sidecar already healthy on port 49152?
   YES → return (instant startup, sidecar was left running from last time)
   NO  → continue
3. Resolve sidecar directory:
   - Dev:  <project_root>/server/sidecar/
   - Prod: <exe_dir>/sidecar/ (if bundled)
4. Find Python:
   - Windows: prefer "pythonw" (no console window), then "python", "python3", "py"
   - macOS/Linux: "python3", "python"
5. Spawn:
   pythonw -m uvicorn sidecar.sidecar:app --host 127.0.0.1 --port 49152
   - Working dir: parent of sidecar/ (so `sidecar.sidecar:app` resolves)
   - .env loaded manually (uvicorn doesn't auto-load it)
   - stdout/stderr → log file in app data dir
   - Windows: CREATE_NO_WINDOW flag
6. Wait for health (poll TCP connect every 500ms, timeout 15s)
7. Store child handle in static Mutex (for optional shutdown)
```

## Why `pythonw.exe`?

On Windows, `python.exe` is a console-subsystem executable — it opens a terminal window. `CREATE_NO_WINDOW` helps but isn't bulletproof on Windows 11 + Windows Terminal.

`pythonw.exe` is the GUI-subsystem Python — it **can never** show a console window. It lives in the same install directory as `python.exe`, so it's on PATH whenever Python is.

## Why Port 49152?

- IANA dynamic/private range (49152-65535).
- Avoids conflicts with common dev ports: 3000, 5173 (Vite), 8000 (STT), 8080, 8443.
- Configurable via `NEXUS_SIDECAR_PORT` env var.

## Why Leave It Running?

The sidecar is **not killed** when NEXUS exits. This means:
- Next NEXUS launch: `is_sidecar_healthy(49152)` → YES → skip spawning → instant startup.
- The sidecar is stateless (credentials are in SQLite, sessions are ephemeral).
- Only one sidecar runs at a time (port conflict prevents duplicates).

## Log File Location

| OS | Path |
|----|------|
| Windows | `%LOCALAPPDATA%\com.nexus.assistant\sidecar.log` |
| macOS | `~/Library/Application Support/com.nexus.assistant/sidecar.log` |
| Linux | `~/.local/share/com.nexus.assistant/sidecar.log` |

The log is truncated on each startup (not appended).

## Package-Qualified Invocation

The sidecar uses relative imports (`from . import db`), so it must be launched as a package:

```
pythonw -m uvicorn sidecar.sidecar:app --host 127.0.0.1 --port 49152
```

Not `uvicorn sidecar:app` (that fails with `ImportError: attempted relative import with no known parent package`).

The working directory is set to the **parent** of the `sidecar/` directory so the `sidecar` package is importable.
