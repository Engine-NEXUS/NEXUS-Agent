# Change: Sleep/Wake Detection

**Commit:** `f4e6ac6` (part of: "feat: boot/wake greeting + non-blocking sidecar + no browser on boot")
**Date:** 2026-08-19

---

## Problem

The user wanted NEXUS to greet after waking from sleep, not just after a full restart.

## Approach

Detect sleep/wake by comparing the **monotonic clock** (used by `thread::sleep`) against the **wall clock** (`SystemTime`):

- `thread::sleep(10s)` uses the monotonic clock — it **stops counting** while the system is asleep.
- `SystemTime::now()` uses the wall clock — it **jumps forward** across sleep.
- If `sleep(10s)` actually took much longer (e.g. 4 hours), the system slept.

## Implementation

Added a background thread in `lib.rs`:

```rust
std::thread::Builder::new()
    .name("sleep-wake-watch".into())
    .spawn(move || loop {
        let before = std::time::SystemTime::now();
        std::thread::sleep(std::time::Duration::from_secs(10));
        let gap = std::time::SystemTime::now()
            .duration_since(before)
            .unwrap_or_default();
        if gap > std::time::Duration::from_secs(60) {
            if state.is_meeting_active() || state.is_paused() {
                tracing::info!("wake greeting skipped (meeting active or paused)");
                continue;
            }
            tracing::info!("system resumed from sleep (gap {gap:?}) — greeting");
            let _ = handle.emit("app:greeting", ());
        }
    })
    .ok();
```

## Threshold: 60 Seconds

A 60-second gap threshold filters out:
- Brief scheduling delays (GC pauses, high system load).
- Brief screen blanks (not a real sleep).

A real sleep/wake produces a gap of minutes to hours — well above 60 seconds.

## Suppression

The greeting is skipped if:
- **Meeting active** — don't greet during a call.
- **Manually paused** — respect the user's pause.

The frontend's `greet()` function also checks `state === "idle"` — don't greet mid-conversation.

## Frontend Listener

```typescript
import("@tauri-apps/api/event").then(({ listen }) => {
    void listen("app:greeting", () => void greet());
});
```

The same `greet()` function handles both boot and sleep/wake greetings.

## Verification

- Binary symbol check: `sleep-wake-watch` found in compiled `nexus.exe`.
- A real sleep/resume test is needed to verify the greeting fires on wake.

## Why Not Use OS Sleep/Wake Events?

Windows has `WM_POWERBROADCAST` messages for sleep/wake. macOS has `IOKit` / `NSWorkspace` notifications. Linux has `logind` signals.

However, the time-jump approach is:
- **Cross-platform** — no OS-specific code.
- **Simple** — 10 lines of Rust.
- **Reliable** — doesn't depend on event delivery (which can be missed if the window is hidden).

The tradeoff is a 10-second detection latency (the sleep interval). For a greeting, this is acceptable.
