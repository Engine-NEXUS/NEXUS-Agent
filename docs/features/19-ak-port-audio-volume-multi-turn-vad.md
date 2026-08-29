# 19 — AK Port: Audio Volume Tracking + Multi-Turn VAD

**Date:** 2026-08-29
**Source:** `Engine-NEXUS/AK` repo (commits `a8387ec`, `25d1f6c`)
**Status:** Implemented and tested

## Part 1: Audio Volume RMS Tracking

### Problem

The avatar had no real-time audio reactivity. The orb's animation was
purely state-driven (idle/listening/thinking/speaking) with no visual
feedback for how loud the user was speaking.

### Solution

Compute the RMS (root mean square) of each VAD audio frame and store it
in the assistant state. The avatar can use this to scale/pulse based on
microphone input volume.

### Implementation

**`frontend/src/store/assistant.ts`** — new store field:

```typescript
interface AssistantStore {
  // ... existing fields ...
  /** Current microphone audio volume (RMS, 0.0 - ~1.0) */
  audioVolume: number;
  setAudioVolume: (v: number) => void;
}

// Initial state:
audioVolume: 0,

// Setter:
setAudioVolume: (v) => set({ audioVolume: v }),

// Reset includes audioVolume:
reset: () => set({ state: "idle", speakSeq: null, audioVolume: 0 }),
```

**`frontend/src/audio/vad.ts`** — compute RMS per frame:

```typescript
function onVadFrame(probs: { isSpeech: number }, frame: Float32Array): void {
  if (!active || !frame || frame.length === 0) return;

  // Compute RMS volume and update store for avatar reactivity (AK port).
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
  }
  const rms = Math.sqrt(sum / frame.length);
  useAssistant.getState().setAudioVolume(rms);

  // ... rest of frame processing ...
}
```

RMS is reset to 0 in `stopVad()` and on speech end:

```typescript
export function stopVad(): void {
  active = false;
  useAssistant.getState().setAudioVolume(0);
  // ...
}
```

### Usage

The `audioVolume` value is available to the `Avatar` component via:

```typescript
const audioVolume = useAssistant((s) => s.audioVolume);
```

This can be used to scale the orb based on input volume, change the
mouth animation amplitude, or show a waveform-like effect.

---

## Part 2: Multi-Turn VAD Resume

### Problem

When STT returns an empty transcript ("didn't catch that"), NEXUS would
hide the orb and the user had to press the hotkey or say the wake word
again to retry. This is annoying for mishearing cases.

### Solution

Added a `resumeVad()` function that restarts VAD using the existing
mic stream (no new `getUserMedia()` call needed). After saying "didn't
catch that sir", NEXUS stays in listening state and the user can
immediately try again.

### Implementation

**`frontend/src/audio/vad.ts`** — new export:

```typescript
/**
 * Resume VAD using the existing stream (for multi-turn hot-mic loop).
 * Used by the "didn't catch that" retry flow.
 */
export async function resumeVad(): Promise<void> {
  if (micVad && micVadStream) {
    active = true;
    await micVad.start();
    console.log("[NEXUS] VAD: Silero VAD resumed (multi-turn loop)");
  } else if (micVadStream) {
    // Fallback: re-start from scratch if micVad was lost
    await startVad(micVadStream);
  }
}
```

---

## Part 3: "Didn't Catch That" Retry Logic

### Problem

Empty STT transcripts would immediately hide the orb.

### Solution

Added a retry counter (`didntCatchRetryCount`) with a max of 3 retries.
On empty transcript:

1. Say "Didn't catch that sir"
2. Wait for TTS to finish
3. Set state back to "listening"
4. Call `resumeVad()` to restart VAD
5. User can immediately speak again

After 3 failed retries, give up and hide the orb.

### Implementation (`frontend/src/audio/recorder.ts`)

```typescript
let didntCatchRetryCount = 0;
const MAX_DIDNT_CATCH_RETRIES = 3;

export function resetRetryCount(): void {
  didntCatchRetryCount = 0;
}

// In finishCapture / finishCaptureFromVad:
if (!transcript) {
  didntCatchRetryCount++;
  if (didntCatchRetryCount <= MAX_DIDNT_CATCH_RETRIES) {
    console.log(`[NEXUS] didn't catch that (retry ${didntCatchRetryCount}/${MAX_DIDNT_CATCH_RETRIES})`);
    useAssistant.getState().setState("speaking");
    await speak("Didn't catch that sir");
    await waitForTtsIdle();
    useAssistant.getState().setState("listening");
    import("./vad").then(({ resumeVad }) => resumeVad()).catch(() => {});
  } else {
    // Max retries exceeded — hide
    didntCatchRetryCount = 0;
    useAssistant.getState().setVisible(false);
    setTimeout(() => useAssistant.getState().reset(), 550);
  }
  captureInProgress = false;
  return;
}
// Successful transcript — reset retry counter
didntCatchRetryCount = 0;
```

Applied to both the `finishCapture` (ScriptProcessor path) and
`finishCaptureFromVad` (Silero VAD path).

### Safety

The retry counter prevents infinite loops from continuous noise. After
3 empty transcripts, NEXUS gives up and hides. The counter is reset on
any successful transcript.
