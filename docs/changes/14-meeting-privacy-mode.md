# Change: Meeting / Privacy Mode

**Commit:** `b793ebe` ("feat: meeting/privacy mode — auto-detect mic usage, suppress wake & TTS")
**Date:** 2026-08-19

---

## Problem

Without meeting detection, NEXUS would:
1. Hear "nexus" in a meeting conversation → wake up → start recording.
2. Speak TTS responses out loud during a call → embarrassing.
3. Hear its own TTS voice → self-trigger → infinite loop.

## Solution

Added a 4-layer suppression system:

### Layer 0 — Manual pause (tray menu)
User clicks "Pause NEXUS" → `manual_pause = true`. Overrides everything.

### Layer 1 — WASAPI session detection (Windows, primary)
Polls `IAudioSessionManager2` every 2 seconds. If any other process has an active capture session on the default microphone → `meeting_active = true`.

### Layer 2 — Process name detection (macOS/Linux fallback)
Uses `sysinfo` to check for known meeting app processes (Zoom, Teams, Discord, Slack, Skype, Webex, OBS).

### Layer 3 — TTS-aware muting (all platforms)
Frontend emits `tts-started` / `tts-ended` events. While TTS is playing, wake detection is suppressed.

## Decision Logic

```rust
fn should_suppress_wake(&self) -> bool {
    self.manual_pause
    || self.tts_playing
    || (self.detection_enabled && self.meeting_active)
}
```

## What Gets Suppressed

| Behavior | During meeting | During manual pause | During TTS |
|----------|---------------|--------------------|-----------:|
| Wake word | ❌ | ❌ | ❌ |
| Tier 3 commands | ❌ | ❌ | ❌ |
| TTS audio | ❌ | ✅ | — |
| Hotkey | ✅ | ✅ | ✅ |

## Hysteresis

- Activate after 1 positive poll (~2 seconds).
- Deactivate after 2 negative polls (~4 seconds).

Prevents flicker from transient audio sessions.

## Frontend Integration

The frontend checks `meeting_active` before speaking:
```typescript
const meeting = await invoke<boolean>("meeting_active");
if (meeting) {
    console.log("[TTS] Suppressed — meeting mode active");
    onEnd?.();
    return;  // Don't speak, but fire onEnd so state machine continues
}
```

## Files Changed

- `src-tauri/src/meeting_detect.rs` — new file (detection logic + shared state).
- `src-tauri/src/lib.rs` — added `mod meeting_detect;`, spawn detection loop, TTS event listeners.
- `src-tauri/src/wakeword_oww.rs` — added `set_meeting_state()` to check suppression on every chunk.
- `src-tauri/src/tray.rs` — added "Pause NEXUS" / "Resume NEXUS" toggle.
- `src-tauri/src/commands.rs` — added `meeting_active`, `is_nexus_paused`, `meeting_status`, `set_meeting_detection` IPC commands.
- `frontend/src/audio/ttsPlayer.ts` — added `isMeetingActive()` check before speaking.

## Tests

Added unit tests in `meeting_detect.rs`:
- `test_meeting_state_default` — no suppression by default.
- `test_manual_pause` — manual pause suppresses wake.
- `test_meeting_active` — meeting active suppresses wake.
- `test_tts_playing` — TTS playing suppresses wake.
- `test_detection_disabled_overrides_meeting` — disabled detection doesn't suppress.
- `test_manual_pause_works_even_with_detection_disabled` — manual pause always works.
- `test_tts_playing_works_even_with_detection_disabled` — TTS muting always works.
- `test_should_suppress_tts` — TTS suppression logic.
- `test_toggle_pause` — toggle behavior.
