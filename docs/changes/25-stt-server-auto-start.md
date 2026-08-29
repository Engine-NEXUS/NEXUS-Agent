# 25 — STT Server Auto-Start

> **Commit:** `58af31e` — `fix: auto-start STT server — root cause of all command failures`
> **Date:** 2026-08-23
> **Status:** Complete

---

## Problem

The local STT server (`server/stt_server.py`) was not running. Port `8000` refused connections. This meant:

- Audio was captured correctly by the microphone
- `transcribe_audio()` failed with a connection error
- No transcript was ever produced
- No commands could be executed

NEXUS was completely non-functional for voice commands because the STT server had to be started manually with `uvicorn stt_server:app --host 127.0.0.1 --port 8000`.

---

## Root Cause

There was no mechanism to automatically start the STT server. Unlike the Python sidecar (which had `sidecar_manager.rs`), the STT server had no auto-start logic. If NEXUS was launched without manually starting the STT server first, all voice commands failed silently.

---

## Fix

### New Module: `stt_server_manager.rs`

Created a new Rust module that mirrors `sidecar_manager.rs`:

```rust
pub fn start_stt_server() {
    // 1. Check if STT is already running (health check on port 8000)
    // 2. If not, spawn: pythonw -m uvicorn stt_server:app --host 127.0.0.1 --port 8000
    // 3. Use CREATE_NO_WINDOW to hide the console on Windows
    // 4. Redirect stdout/stderr to a log file
    // 5. Poll health endpoint until ready (or timeout)
}
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `pythonw` not `python` | No console window flashes on screen |
| `CREATE_NO_WINDOW` | Windows-specific flag to suppress any window |
| Health polling | Wait until STT is ready before declaring success |
| Log redirection | Errors go to a file, not a popup |
| Non-blocking | Spawned in a background thread, doesn't delay NEXUS startup |
| Parallel to sidecar | Both start simultaneously at app launch |

### Startup Integration

In `src-tauri/src/lib.rs`:

```rust
// Start both the sidecar and STT server at app launch
sidecar_manager::start_sidecar();
stt_server_manager::start_stt_server();
```

### Health Check

The manager polls `http://127.0.0.1:8000/health` every 500ms for up to 30 seconds. Once it returns a 200 response, the STT server is marked as ready.

---

## Files Added/Modified

| File | Change |
|------|--------|
| `src-tauri/src/stt_server_manager.rs` | **NEW** — STT server lifecycle manager |
| `src-tauri/src/lib.rs` | Added `stt_server_manager::start_stt_server()` call at startup |

---

## Verification

- NEXUS launches → STT server starts automatically within ~5 seconds
- `http://127.0.0.1:8000/health` returns `{"status": "ok", "model": "..."}`
- Voice commands now produce transcripts
- No manual `uvicorn` command needed
