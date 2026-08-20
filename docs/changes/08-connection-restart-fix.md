# Change: "Connection Not Found" on Restart — 3 Root Causes Fixed

**Commit:** `41474b9` ("fix: eliminate 'connection not found' on restart — 3 root causes fixed")
**Date:** 2026-08-19

---

## Problem

After restarting the laptop, NEXUS showed "connection not found" errors. The orb appeared but couldn't communicate with the backend.

## Three Root Causes

### 1. Sidecar not running after restart

The sidecar was a separate process that had to be started manually. After a restart, it wasn't running.

**Fix:** Auto-spawn the sidecar on NEXUS startup (`sidecar_manager::init()`). See [10-auto-spawn-sidecar.md](./10-auto-spawn-sidecar.md).

### 2. Frontend pointing at wrong URL

The frontend was using `VITE_SERVER_URL` from `.env.local`, which was a build-time fallback. If the runtime URL changed (e.g. port change from 8443 to 49152), the frontend still used the old URL.

**Fix:** Added `get_server_config` IPC command that reads `nexus-config.json` from the app data directory at runtime. The frontend calls this at startup to get the actual server URL, user ID, and device ID.

```rust
// commands.rs
#[tauri::command]
pub fn get_server_config<R: Runtime>(app: tauri::AppHandle<R>) -> Result<ServerConfig, String> {
    let dir = app.path().app_data_dir()?;
    let config_path = dir.join("nexus-config.json");
    if !config_path.exists() {
        return Ok(ServerConfig::default());
    }
    // ... read and parse ...
}
```

```typescript
// wsBridge.ts
async function getServerConfig() {
    const config = await tauriInvoke("get_server_config");
    cachedConfig = { url: config.server_url, ... };
    return cachedConfig;
}
```

### 3. No retry on WebSocket connect

If the sidecar wasn't ready yet (cold-starting), the WSS connection failed immediately with no retry.

**Fix:** Added exponential backoff retry in `openSession()`:

```typescript
const maxRetries = 5;
const baseDelayMs = 1000;
for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
        const sessionId = await tauriInvoke("open_session", { url, token, userId, deviceId });
        return sessionId;
    } catch (err) {
        const delay = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
        await new Promise(r => setTimeout(r, delay));
    }
}
throw new Error(`backend session failed after ${maxRetries} retries`);
```

## Files Changed

- `src-tauri/src/commands.rs` — added `get_server_config` and `save_server_config` IPC commands.
- `src-tauri/src/lib.rs` — registered commands in invoke handler; auto-creates default config on first launch.
- `frontend/src/net/wsBridge.ts` — added `getServerConfig()` + retry logic in `openSession()`.

## Result

After restart:
1. NEXUS auto-starts (autostart plugin).
2. Sidecar auto-spawns (background thread).
3. Frontend loads, reads config from `nexus-config.json`.
4. Frontend tries WSS → fails (sidecar not ready) → retries 1s, 2s, 4s, 8s.
5. Sidecar becomes healthy → WSS connects → no "connection not found" error.
