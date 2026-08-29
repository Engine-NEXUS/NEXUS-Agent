# Meeting / Privacy Mode

NEXUS automatically detects when another application is using the microphone
(Google Meet, Zoom, Teams, Discord, etc.) and suppresses wake-word detection,
command classification, and TTS to avoid interrupting calls.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MeetingState (shared atomics)                 │
│                                                                  │
│  manual_pause    meeting_active    tts_playing    detection_on  │
│  (AtomicBool)    (AtomicBool)      (AtomicBool)   (AtomicBool)  │
└──────┬──────────────┬────────────────┬──────────────┬───────────┘
       │              │                │              │
       │              │                │              │
  ┌────▼────┐  ┌──────▼──────┐  ┌──────▼──────┐  ┌────▼─────┐
  │ Tray    │  │ WASAPI      │  │ Frontend    │  │ Settings │
  │ Menu    │  │ Detection   │  │ TTS events  │  │ IPC      │
  │ (Layer 0)│  │ (Layer 1/2) │  │ (Layer 3)   │  │          │
  └─────────┘  └─────────────┘  └─────────────┘  └──────────┘
                      │
                      ▼
              ┌───────────────┐
              │ Audio Callback│
              │ (every 80ms)  │
              │               │
              │ if suppressed │
              │   drain audio │
              │   skip detect │
              └───────────────┘
```

## Detection Layers

### Layer 0 — Manual Pause (tray menu)

The user can manually pause NEXUS via the tray menu:
- Right-click tray icon → "Pause NEXUS" / "Resume NEXUS"
- Toggles `manual_pause` atomic flag
- Overrides all other layers
- Emits `meeting:paused` / `meeting:resumed` events to frontend
- The hotkey still works even when paused (explicit user action)

### Layer 1 — WASAPI Session Detection (Windows, primary)

Polls `IAudioSessionManager2` every 2 seconds:

1. Get the default microphone endpoint (`IMMDeviceEnumerator::GetDefaultAudioEndpoint`)
2. Activate `IAudioSessionManager2` on the device
3. Enumerate all active audio sessions
4. For each session:
   - Get the process ID via `IAudioSessionControl2::GetProcessId`
   - Skip NEXUS's own PID
   - Skip the Windows Audio Service (`audiodg.exe`, `AudioSrv`)
   - Check if the session state is `AudioSessionStateActive`
5. If any *other* process has an active capture session → meeting detected

**Advantages:**
- Detects ANY app using the mic — no app list needed
- Works for browser-based meetings (Chrome with Google Meet)
- Works for OBS, Audacity, Discord, Slack huddles, etc.
- Distinguishes "app is running" from "app is actively capturing"

**Files:** `src-tauri/src/meeting_detect.rs` → `check_wasapi_microphone_usage()`

### Layer 2 — Process Name Detection (macOS/Linux fallback)

Uses `sysinfo` to check for known meeting application processes:

```rust
const MEETING_PROCESS_NAMES: &[&str] = &[
    "Zoom.exe", "Teams.exe", "Discord.exe", "Slack.exe",
    "zoom.us", "Microsoft Teams", "Discord", "Slack",
    "zoom", "teams", "discord", "slack", "obs",
    // ... etc
];
```

**Limitation:** Detects if a meeting app is *running*, not if it's *actively
using the mic*. On macOS/Linux, there's no cross-platform API equivalent to
WASAPI for detecting active microphone sessions.

**Files:** `src-tauri/src/meeting_detect.rs` → `check_meeting_processes()`

### Layer 3 — TTS-Aware Wake Muting (all platforms)

When NEXUS is speaking (TTS), wake detection is suppressed to prevent
NEXUS from hearing its own voice and re-triggering.

**Flow:**
1. Frontend calls `speak()` in `ttsPlayer.ts`
2. Frontend emits `tts-started` Tauri event
3. Rust sets `tts_playing = true`
4. Audio callback skips detection on every chunk
5. When TTS ends, frontend emits `tts-ended`
6. Rust waits 500ms (grace period for audio decay)
7. Rust sets `tts_playing = false`
8. Wake detection resumes

**Files:**
- `frontend/src/audio/ttsPlayer.ts` — emits events
- `src-tauri/src/lib.rs` — listens for events, sets state
- `src-tauri/src/wakeword_oww.rs` — checks state in audio callback

## Decision Logic

```rust
fn should_suppress_wake(&self) -> bool {
    self.manual_pause                          // Layer 0
        || self.tts_playing                    // Layer 3
        || (self.detection_enabled             // Layer 1+2
            && self.meeting_active)
}
```

| State | Wake? | Commands? | TTS? | Hotkey? |
|-------|-------|-----------|------|---------|
| Normal | Yes | Yes | Yes | Yes |
| Meeting active | No | No | No | Yes |
| TTS playing | No | No | — | Yes |
| Manual pause | No | No | Yes | Yes |
| Detection disabled | Yes | Yes | Yes | Yes |

## Hysteresis

To prevent flicker from transient audio sessions:

- **Activate:** 1 consecutive positive poll (~2 seconds)
- **Deactivate:** 2 consecutive negative polls (~4 seconds)

This means a brief notification sound won't trigger meeting mode,
and a momentary drop in mic usage won't end it prematurely.

## TTS Suppression

When a meeting is detected, TTS is also suppressed:

```typescript
// frontend/src/audio/ttsPlayer.ts
export async function speak(text: string, onEnd?: () => void) {
    const meeting = await isMeetingActive();
    if (meeting) {
        console.log("[TTS] Suppressed — meeting mode active");
        onEnd?.();
        return;
    }
    // ... proceed with TTS
}
```

The frontend queries `meeting_active` IPC command before each `speak()` call.
If suppressed, the text is not spoken aloud — the caller can provide a
silent visual response instead (e.g., show text in the overlay).

**Note:** Manual pause does NOT suppress TTS. The user might want to hear
responses even when they've paused wake detection. Only auto-detected
meetings suppress TTS.

## IPC Commands

| Command | Returns | Description |
|---------|---------|-------------|
| `meeting_active` | `bool` | Is a meeting currently detected? |
| `is_nexus_paused` | `bool` | Is NEXUS manually paused? |
| `meeting_status` | `MeetingStatus` | Full status object |
| `set_meeting_detection` | `void` | Enable/disable auto-detection |

```typescript
interface MeetingStatus {
    meeting_active: boolean;
    paused: boolean;
    tts_playing: boolean;
    detection_enabled: boolean;
}
```

## Tray Menu

```
┌─────────────────────┐
│ Show Assistant      │
│─────────────────────│
│ Pause NEXUS         │  ← toggles to "Resume NEXUS"
│─────────────────────│
│ Settings…           │
│ Quit NEXUS          │
└─────────────────────┘
```

## Performance

- **Audio callback:** `should_suppress_wake()` uses `AtomicBool` with
  `Ordering::Relaxed` — no locks, ~5ns per check.
- **Detection loop:** Polls every 2 seconds in a separate tokio task.
  WASAPI enumeration takes ~1-5ms per poll.
- **Memory:** `MeetingState` is 4 bytes (4 × `AtomicBool`).
- **CPU:** Negligible — one `sysinfo` refresh or WASAPI poll every 2s.

## Testing

### Unit tests (9 tests, all passing)

```
test meeting_detect::tests::test_meeting_state_default ... ok
test meeting_detect::tests::test_manual_pause ... ok
test meeting_detect::tests::test_meeting_active ... ok
test meeting_detect::tests::test_tts_playing ... ok
test meeting_detect::tests::test_detection_disabled_overrides_meeting ... ok
test meeting_detect::tests::test_manual_pause_works_even_with_detection_disabled ... ok
test meeting_detect::tests::test_tts_playing_works_even_with_detection_disabled ... ok
test meeting_detect::tests::test_should_suppress_tts ... ok
test meeting_detect::tests::test_toggle_pause ... ok
```

### Manual testing checklist

- [ ] Open Zoom/Teams/Google Meet → NEXUS stops waking within ~2s
- [ ] Close meeting app → NEXUS resumes waking within ~4s
- [ ] Right-click tray → "Pause NEXUS" → wake stops immediately
- [ ] Right-click tray → "Resume NEXUS" → wake resumes immediately
- [ ] Trigger TTS → wake detection pauses during speech + 500ms after
- [ ] Hotkey (Ctrl+Shift+Space) works during meeting mode
- [ ] Hotkey works during manual pause
- [ ] TTS is suppressed when meeting is active
- [ ] TTS works when manually paused (but not in meeting)
- [ ] Brief notification sound doesn't trigger meeting mode (hysteresis)

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/meeting_detect.rs` | **NEW** — MeetingState, WASAPI detection, process detection, polling loop |
| `src-tauri/src/wakeword_oww.rs` | Added `MEETING_STATE` global, suppress detection in audio callback |
| `src-tauri/src/tray.rs` | Added "Pause NEXUS" / "Resume NEXUS" menu item |
| `src-tauri/src/lib.rs` | Wire up MeetingState, spawn detection loop, listen for TTS events |
| `src-tauri/src/commands.rs` | Added `meeting_active`, `is_nexus_paused`, `meeting_status`, `set_meeting_detection` IPC commands |
| `src-tauri/Cargo.toml` | Added Windows features: `Win32_Media_Audio`, `Win32_System_Com`, `Win32_System_Com_StructuredStorage`, `Win32_System_ProcessStatus` |
| `frontend/src/audio/ttsPlayer.ts` | Emit `tts-started`/`tts-ended` events, check `meeting_active` before speaking |

## Future Enhancements

- **macOS/Linux WASAPI equivalent:** Use `coreaudio` crate on macOS for
  actual mic session detection (instead of process name matching).
- **Per-app allowlist:** Let users exclude specific apps from meeting detection.
- **Calendar integration:** Auto-detect meetings from calendar events.
- **Visual indicator:** Show meeting mode status in the overlay/tray icon.
- **Whisper mode:** Reduce TTS volume instead of fully suppressing it.
