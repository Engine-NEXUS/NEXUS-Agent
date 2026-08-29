# Feature: Meeting / Privacy Mode

> NEXUS automatically detects when another app is using the microphone (Google Meet, Zoom, Teams, Discord) and suppresses wake detection + TTS to avoid interrupting calls.

**Source files:**
- `src-tauri/src/meeting_detect.rs` — detection logic + shared state
- `src-tauri/src/lib.rs` — wiring (spawn loop, TTS event listeners)
- `src-tauri/src/tray.rs` — manual pause/resume
- `frontend/src/audio/ttsPlayer.ts` — TTS suppression check

**Detailed docs:** [../meeting-protection/01-meeting-detection.md](../meeting-protection/01-meeting-detection.md)

---

## The Problem

Without meeting detection, NEXUS would:
1. Hear "nexus" in a meeting conversation → wake up → start recording.
2. Speak TTS responses out loud during a call → embarrassing.
3. Hear its own TTS voice → self-trigger → infinite loop.

## The Solution: 4-Layer Suppression

```
Layer 0 — Manual pause (tray menu "Pause NEXUS")
  User explicitly pauses. Overrides everything.
  Must be manually cleared via "Resume NEXUS".

Layer 1 — WASAPI session detection (Windows, primary)
  Polls IAudioSessionManager2 every 2 seconds.
  Enumerates active audio capture sessions on the default microphone.
  If any OTHER process has an active capture session → meeting_active = true.
  Skips NEXUS's own PID and the Windows Audio Service (AudioSrv / audiodg).
  Works for ANY app that uses the mic — no app list needed.

Layer 2 — Process name detection (macOS/Linux fallback)
  Uses sysinfo to check for known meeting app processes:
    Zoom, Teams, Discord, Slack, Skype, Webex, OBS, etc.
  Less precise (can't tell if Chrome has a Meet tab vs browsing),
  but works on macOS/Linux and as a Windows backup.

Layer 3 — TTS-aware muting (all platforms)
  Frontend emits tts-started / tts-ended events.
  While TTS is playing, wake detection is suppressed.
  Prevents NEXUS from hearing its own voice.
```

## Decision Logic

```rust
fn should_suppress_wake(&self) -> bool {
    self.manual_pause       // Layer 0: user paused
    || self.tts_playing     // Layer 3: NEXUS is speaking
    || (self.detection_enabled && self.meeting_active)  // Layer 1+2
}

fn should_suppress_tts(&self) -> bool {
    self.detection_enabled && self.meeting_active
    // Note: manual pause does NOT suppress TTS —
    // the user might want to hear responses even when wake is paused.
}
```

## What Gets Suppressed

| Behavior | During meeting | During manual pause | During TTS |
|----------|---------------|--------------------|-----------:|
| Wake word detection | ❌ suppressed | ❌ suppressed | ❌ suppressed |
| Tier 3 commands | ❌ suppressed | ❌ suppressed | ❌ suppressed |
| TTS audio output | ❌ silenced | ✅ allowed | — |
| Hotkey wake | ✅ works | ✅ works | ✅ works |
| Tray click wake | ✅ works | ✅ works | ✅ works |

**The hotkey always works.** It's an explicit user action, not an automatic trigger.

## Hysteresis

To prevent flicker from transient audio sessions:
- **Activate** after 1 positive poll (~2 seconds).
- **Deactivate** after 2 negative polls (~4 seconds).

This means a brief notification sound won't trigger meeting mode, and a brief pause in mic usage won't end it prematurely.

## Frontend Integration

The frontend checks meeting state before speaking:
```typescript
async function isMeetingActive(): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<boolean>("meeting_active");
}

export async function speak(text: string): Promise<void> {
  const meeting = await isMeetingActive();
  if (meeting) {
    console.log("[TTS] Suppressed — meeting mode active");
    onEnd?.();
    return;  // Don't speak, but fire onEnd so state machine continues
  }
  // ... speak normally
}
```

This is a **second layer of defense** — even if the state machine reaches `speaking`, no audio is produced during a meeting.
