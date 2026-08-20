# Change: Sidecar Port Change (8443 → 49152)

**Commit:** `4c987d5` ("fix: silent sidecar (no terminal) + port 49152 (dev-friendly)")
**Date:** 2026-08-19

---

## Problem

The sidecar was running on port `8443`, which conflicts with:
- Common HTTPS dev servers.
- Some VPN/proxy tools.
- Various development environments.

This caused port conflicts and made it hard to run NEXUS alongside other dev tools.

## Fix

Changed the default port to `49152`:

```rust
// sidecar_manager.rs
const DEFAULT_SIDECAR_PORT: u16 = 49152;
```

## Why 49152?

- **IANA dynamic/private range** (49152-65535) — designed for ephemeral and private services.
- **No common conflicts** — avoids 3000, 5173 (Vite), 8000 (STT), 8080, 8443, 9000, etc.
- **Configurable** — override via `NEXUS_SIDECAR_PORT` env var.

## Files Changed

- `src-tauri/src/sidecar_manager.rs` — `DEFAULT_SIDECAR_PORT` changed from `8443` to `49152`.
- `src-tauri/src/commands.rs` — default `serverUrl` in `ServerConfig::default()` changed to `ws://127.0.0.1:49152/ws`.
- `src-tauri/src/lib.rs` — auto-created default config uses `ws://127.0.0.1:49152/ws`.
- `frontend/.env.local` — `VITE_SERVER_URL` changed to `ws://127.0.0.1:49152/ws`.
- `server/sidecar/sidecar.py` — default `SIDECAR_PORT` changed to `49152`.

## Verification

- `netstat` confirms port 49152 is listening after sidecar startup.
- `curl http://127.0.0.1:49152/health` returns `{"ok":true,"sessions":0,"protocol":"text-only"}`.
- No conflicts with other dev tools running on the machine.
