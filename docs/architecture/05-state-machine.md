# NEXUS — Frontend State Machine

> The Zustand store `useAssistant` drives all UI transitions.
> This page documents every state, every transition, and the side effects that fire on each.

---

## 1. States

| State | Meaning | Visual | Mic | TTS | Network |
|-------|---------|--------|-----|-----|---------|
| `idle` | Waiting for wake. Orb hidden (or faded to 0.08 opacity after 4s). | Hidden / faded | Off | Off | No session |
| `listening` | User is speaking. Mic is on, VAD is running. | Orb visible, listening animation | On | Off | Session opening (retry) |
| `thinking` | STT done, transcript sent, waiting for server result. | Orb visible, thinking animation | Off | Off | Session open, waiting |
| `speaking` | NEXUS is speaking (ack or result). | Orb visible, speaking animation | Off | On | Session open |

---

## 2. Canonical Transitions

Defined in `frontend/src/store/assistant.ts`:

```typescript
const allowed: Record<AssistantState, AssistantState[]> = {
  idle:      ["listening"],
  listening: ["thinking", "idle"],
  thinking:  ["speaking", "idle"],
  speaking:  ["idle"],
};
```

### Transition Diagram

```
                wake / hotkey
   ┌─────────┐────────────────▶┌───────────┐
   │  idle   │                 │ listening │
   │         │◀────────────────│           │
   └─────────┘  cancel / 8s    └─────┬─────┘
       ▲           timeout           │ VAD silence + STT + transcript sent
       │                             ▼
       │                        ┌──────────┐
       │   done event           │ thinking │
       │◀───────────────────────│          │
       │                        └─────┬────┘
       │                              │ ack / result event
       │                              ▼
       │                        ┌──────────┐
       │◀───────────────────────│ speaking │
       │   done event           │          │
       │                        └──────────┘
```

---

## 3. Side Effects per Transition

### `idle → listening` (wake fires)

Triggered by `window.__NEXUS_WAKE__()` (called from Rust via `win.eval()` on hotkey or OWW detection).

1. `setVisible(true)` — show the orb immediately.
2. `setState("listening")`.
3. `getUserMedia({ audio: { channelCount:1, echoCancellation:true, noiseSuppression:true }})`.
4. `captureUntilSilence(micStream)` — start `ScriptProcessorNode` recording.
5. `openSession()` — open WSS to sidecar (retry with 1s→2s→4s→8s backoff).
6. `startVad(micStream)` — Silero VAD starts detecting speech/silence.
7. `set_click_through(false)` — orb becomes interactive.
8. **8-second auto-hide timer** starts: if still `listening` after 8s, abort and hide.

### `listening → thinking` (VAD silence + STT complete)

Triggered by `finishCapture()` in `recorder.ts` after VAD detects silence.

1. Stop VAD.
2. Downsample buffered Float32 from native SR (e.g. 48 kHz) to 16 kHz.
3. Convert to Int16 PCM.
4. `transcribeAudio(pcm)` — POST to `127.0.0.1:8000`.
5. `parseIntent(transcript)` — local regex + phonetic correction.
6. If local intent matches → `invoke("execute_command")` → skip to `speaking`.
7. If unknown → `sendTranscript(text)` → WSS to sidecar.
8. `setState("thinking")`.

### `thinking → speaking` (ack or result from server)

Triggered by `assistant:server` event with `kind: "ack"` or `kind: "result"`.

1. `addAssistantMessage(text)` — add to transcript.
2. `setState("speaking")`.
3. `speak(text)` — Web Speech API `SpeechSynthesis`.
4. Emit `tts-started` event → Rust suppresses wake detection (prevents self-triggering).
5. On `utterance.onend`:
   - Emit `tts-ended` event → Rust resumes wake detection after 500 ms grace.
   - For `ack`: transition back to `thinking` (server is still processing).
   - For `result`: wait for `done` event.

### `speaking → idle` (done event)

Triggered by `assistant:server` event with `kind: "done"`.

1. `sessionOpen = false`.
2. `stopTts()` — cancel any in-progress speech.
3. `reset()` → `setState("idle")`, `setSpeakSeq(null)`.
4. `setVisible(false)` — triggers CSS slide-down (0.5s).
5. After 600 ms: `invoke("hide_overlay")` — natively hide the window.
6. `set_click_through(true)` — orb passes clicks through again.

---

## 4. Barge-In (Interrupt)

If the user wakes NEXUS while it's in `speaking` or `thinking` state:

1. `stopTts()` — cancel speech immediately.
2. `stopVad()` + `abortCapture()` — clean up any in-progress recording.
3. Start `startListening()` from scratch.

This prevents the TTS `interrupted` error (which would fire if we called `speak()` without first calling `cancel()`).

---

## 5. Tier 3 Command Path (Bypasses the State Machine)

Tier 3 commands don't go through the normal `idle → listening → thinking → speaking` flow. Instead:

**Fixed command:**
1. `command-detected` event arrives.
2. `setVisible(true)` + `setState("speaking")` directly (skip `listening`).
3. `speak("Ok sir.")`.
4. `invoke("execute_command")`.
5. After 800 ms: `setVisible(false)` → `reset()`.

**Parameterized command:**
1. `command-detected` event arrives with `needs_param: true`.
2. `setState("speaking")` + `speak("On it sir")`.
3. Wait for TTS to finish.
4. `setState("listening")` + `captureParameter(3000)` — 3 s recording.
5. `setState("thinking")` + `transcribeAudio(pcm)` — STT the parameter.
6. `invoke("execute_command", { action, query: param })`.
7. `setState("speaking")` + `speak(result.message)`.
8. After 800 ms: `setVisible(false)` → `reset()`.

---

## 6. Boot Greeting Path (Bypasses the State Machine)

The greeting is a one-shot `speaking` burst that doesn't open a session:

1. `frontend_ready` IPC returns `true` (fresh boot).
2. `greet()`:
   - Check `state === "idle"` (skip if mid-conversation).
   - `setVisible(true)` + `setState("speaking")`.
   - `speak("Hello sir, how can I assist you today?")`.
   - `setVisible(false)`.
   - After 550 ms: `reset()`.

No session is opened. No transcript is sent. The sidecar may not even be ready yet.

---

## 7. Meeting / Pause Override

The `MeetingState` atomics in Rust can suppress the state machine indirectly:

- **Wake suppressed** → no `__NEXUS_WAKE__()` call → no `idle → listening` transition.
- **TTS suppressed** → `speak()` returns immediately without speaking → `onend` fires → state transitions proceed silently.
- **Hotkey NOT suppressed** → user can still wake NEXUS explicitly during a meeting.

The frontend also queries `meeting_active` before each `speak()` call, so even if the state machine reaches `speaking`, no audio is produced during a meeting.
