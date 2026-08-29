# Change: Boot Greeting

**Commit:** `f4e6ac6` (part of: "feat: boot/wake greeting + non-blocking sidecar + no browser on boot")
**Date:** 2026-08-19

---

## Problem

The user wanted NEXUS to speak "Hello sir, how can I assist you today?" automatically after a system restart, like a Siri-like greeting.

## Requirements

- Greet on **fresh boot** (not on manual launch hours later).
- Greet on **wake from sleep**.
- **Don't greet** during a meeting.
- **Don't greet** when manually paused.
- **Don't greet** mid-conversation.
- **Don't greet** before the webview is ready (speechSynthesis must be available).

## Implementation

### Rust: `frontend_ready` command

Added a new IPC command in `commands.rs`:

```rust
const FRESH_BOOT_UPTIME_SECS: u64 = 15 * 60;

#[tauri::command]
pub fn frontend_ready<R: Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    let uptime = sysinfo::System::uptime();
    let fresh_boot = uptime < FRESH_BOOT_UPTIME_SECS;
    let (meeting, paused) = match app.try_state::<Arc<MeetingState>>() {
        Some(state) => (state.is_meeting_active(), state.is_paused()),
        None => (false, false),
    };
    let should_greet = fresh_boot && !meeting && !paused;
    Ok(should_greet)
}
```

**Why 15 minutes?** If the user manually launches NEXUS hours after boot, they don't want a greeting. 15 minutes is a safe window for autostart after login.

**Why the frontend signals readiness?** Rust doesn't push the greeting on a timer. The frontend calls `frontend_ready` after the webview loads. This ensures `speechSynthesis` is ready and the React app is mounted.

### Frontend: `greet()` function

Added in `main.tsx`:

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

### Frontend: Boot path

```typescript
if (isTauriRuntime) {
    import("@tauri-apps/api/core").then(async ({ invoke }) => {
        const shouldGreet = await invoke<boolean>("frontend_ready");
        if (shouldGreet) void greet();
    });
}
```

### Frontend: Sleep/wake path

```typescript
import("@tauri-apps/api/event").then(({ listen }) => {
    void listen("app:greeting", () => void greet());
});
```

## Non-Blocking

The greeting does **not** wait for the sidecar. The sidecar may still be cold-starting (3-8 seconds) when the greeting fires. This is fine — the greeting is entirely local (TTS only, no network).

## Files Changed

- `src-tauri/src/commands.rs` — added `frontend_ready` command.
- `src-tauri/src/lib.rs` — registered `frontend_ready` in the invoke handler.
- `frontend/src/main.tsx` — added `greet()` function + boot/sleep event listeners.

## Verification

- Binary symbol check: `frontend_ready` and `app:greeting` found in compiled `nexus.exe`.
- Manual test (uptime 105 min): greeting correctly **skipped** (not a fresh boot).
- A real restart is needed to verify the greeting fires and is audible.
