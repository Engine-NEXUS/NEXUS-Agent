# Feature: Boot & Wake Greeting

> On a fresh system boot (uptime < 15 min) or after waking from sleep, NEXUS speaks "Hello sir, how can I assist you today?" without any user action.

**Source files:**
- `src-tauri/src/commands.rs` — `frontend_ready` command (uptime check)
- `src-tauri/src/lib.rs` — sleep/wake watcher thread
- `frontend/src/main.tsx` — `greet()` function + event listeners

---

## Two Triggers

### 1. Fresh Boot Greeting

When NEXUS starts (via autostart after Windows login), the frontend calls `frontend_ready` once it has loaded. Rust checks:

```rust
const FRESH_BOOT_UPTIME_SECS: u64 = 15 * 60;

pub fn frontend_ready(app: AppHandle) -> Result<bool, String> {
    let uptime = sysinfo::System::uptime();
    let fresh_boot = uptime < FRESH_BOOT_UPTIME_SECS;
    let (meeting, paused) = ...; // from MeetingState
    let should_greet = fresh_boot && !meeting && !paused;
    Ok(should_greet)
}
```

If `should_greet` is `true`, the frontend calls `greet()`.

**Why 15 minutes?** If the user manually launches NEXUS hours after boot, they don't want a greeting. 15 minutes is a safe window for autostart after login.

### 2. Sleep / Wake Greeting

A background thread (`sleep-wake-watch`) monitors the wall clock:

```rust
std::thread::spawn(move || loop {
    let before = SystemTime::now();
    thread::sleep(Duration::from_secs(10));
    let gap = SystemTime::now().duration_since(before).unwrap_or_default();
    if gap > Duration::from_secs(60) {
        if !meeting && !paused {
            handle.emit("app:greeting", ());
        }
    }
});
```

**How it works:**
- `thread::sleep` uses the **monotonic clock** — it stops counting while the system is asleep.
- `SystemTime` uses the **wall clock** — it jumps forward across sleep.
- If `sleep(10s)` actually took 4 hours, the system slept. The 60-second threshold filters out brief scheduling delays.

When a sleep/wake is detected, Rust emits `app:greeting`. The frontend listens for this event and calls `greet()`.

## The Greet Function

```typescript
async function greet() {
  const { useAssistant } = await import("./store/assistant");
  const { speak } = await import("./audio/ttsPlayer");
  const s = useAssistant.getState();
  if (s.state !== "idle") return;  // Don't greet mid-conversation
  s.setVisible(true);
  s.setState("speaking");
  await speak("Hello sir, how can I assist you today?");
  s.setVisible(false);
  setTimeout(() => useAssistant.getState().reset(), 550);
}
```

## Suppression Conditions

The greeting is skipped if:
- **Not a fresh boot** (uptime > 15 min) — for the boot path.
- **Meeting active** — don't greet during a call.
- **Manually paused** — respect the user's pause.
- **Mid-conversation** (state ≠ idle) — don't interrupt an ongoing interaction.
- **TTS meeting check** — `speak()` itself checks `meeting_active` as a second layer.

## Why the Frontend Signals Readiness

Rust doesn't push the greeting on a timer. Instead, the frontend calls `frontend_ready` after the webview loads. This ensures:
- `speechSynthesis` is ready (voices loaded).
- The React app is mounted.
- The orb can be shown immediately.

If Rust pushed on a timer, the greeting might fire before the webview is ready → no speech, no visual.

## Non-Blocking

The greeting does **not** wait for the sidecar. The sidecar may still be cold-starting (3-8 seconds) when the greeting fires. This is fine — the greeting is entirely local (TTS only, no network).
