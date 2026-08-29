# Change: Non-Blocking Sidecar Startup

**Commit:** `f4e6ac6` (part of: "feat: boot/wake greeting + non-blocking sidecar + no browser on boot")
**Date:** 2026-08-19

---

## Problem

NEXUS took 5-10 seconds to become usable after a laptop restart. The orb didn't appear, and the app seemed frozen.

## Root Cause

The sidecar startup was **synchronous** in the Tauri setup hook:

```rust
// OLD (blocking):
sidecar_manager::init();  // waits 3-8s for Python cold-start
// ... rest of setup (window, hotkey, etc.) runs AFTER sidecar is healthy
```

Python + uvicorn cold-start takes 3-8 seconds on a fresh boot. During this time, the entire Tauri setup hook was blocked — no window, no hotkey, no orb.

## Fix

Move the sidecar spawn to a **background thread**:

```rust
// NEW (non-blocking):
std::thread::spawn(sidecar_manager::init);  // returns immediately
// ... rest of setup runs in parallel with sidecar startup
```

The frontend loads immediately. The frontend's WebSocket retry logic (in `wsBridge.ts`) connects once the sidecar is ready:

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
```

## Timeline Comparison

```
OLD (blocking):
  t=0s    setup hook starts
  t=0s    sidecar spawn begins
  t=5s    sidecar healthy
  t=5s    window_manager, hotkey, etc. run
  t=5.5s  orb visible to user
  Total: 5.5 seconds

NEW (non-blocking):
  t=0s    setup hook starts
  t=0s    sidecar spawn begins (background)
  t=0.1s  window_manager, hotkey, etc. run
  t=0.2s  orb visible to user
  t=0.2s  frontend loads, tries WSS → fails (sidecar not ready)
  t=1.2s  retry → fails
  t=3.2s  retry → fails
  t=5s    sidecar healthy
  t=5s    retry → success
  Total to orb: 0.2 seconds
  Total to backend ready: 5 seconds (but user can see the orb immediately)
```

## Sidecar Reuse

The sidecar is **left running** after NEXUS exits. On the next launch:
1. `is_sidecar_healthy(49152)` → TCP connect succeeds.
2. Skip spawning.
3. Instant startup (no Python cold-start).

This makes subsequent launches ~0.5 seconds to backend readiness.

## Files Changed

- `src-tauri/src/lib.rs` — changed `sidecar_manager::init()` to `std::thread::spawn(sidecar_manager::init)`.
