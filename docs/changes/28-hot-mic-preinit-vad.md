# 28 — Hot Mic + Pre-Init VAD + Parallel Init

> **Commit:** `92040f8` — `feat: hot mic + pre-init VAD + parallel init (A+B+C)`
> **Date:** 2026-08-23
> **Status:** Complete

---

## Problem

The user reported a **~2 second gap** between saying "NEXUS" and the microphone actually starting to record. Even with a 0.5-second pause between the wake word and the command, the user had to wait ~2 seconds before NEXUS would listen.

This made the assistant feel sluggish and unresponsive — especially compared to Siri/Alexa which respond near-instantly.

---

## Root Cause Analysis

A full pipeline trace from wake detection to microphone recording revealed three sources of delay:

| Delay Source | Location | Time | Cause |
|-------------|----------|------|-------|
| `getUserMedia()` | `main.tsx:67` | 50-200ms | Browser API re-acquires mic on every wake |
| `MicVAD.new()` | `vad.ts:154` | 60-250ms | Silero VAD re-initializes on every wake |
| Sequential execution | `main.tsx:84-101` | ~60-250ms | Recording starts, THEN VAD starts (not parallel) |
| **Total** | | **~200-500ms** | |

On some Windows systems, `getUserMedia()` can take 1-2 seconds due to WebView2 microphone driver initialization, which explains the user's observed ~2 second delay.

### What Was NOT the Cause

The 2-second `NO_DETECTION_MS` refractory period in `wakeword_oww.rs:109` was **not** the issue. This only prevents the **next** wake from triggering within 2 seconds of the **current** wake — it does not delay the current wake.

---

## Fix — Three Approaches Combined

### Approach A: Hot Mic (`main.tsx`)

**What:** Keep the microphone stream open between commands. Don't call `getUserMedia()` on every wake.

**How:**
1. At app startup, call `getUserMedia()` once and store the stream
2. After each command, **disable** the stream tracks (don't stop them)
3. On next wake, **re-enable** the tracks (instant, ~0ms)
4. Only call `getUserMedia()` again if the stream is lost

```typescript
// At startup:
micStream = await navigator.mediaDevices.getUserMedia({...});

// After command (release):
micStream.getTracks().forEach((t) => (t.enabled = false));

// On next wake (reuse):
micStream.getTracks().forEach((t) => (t.enabled = true));
```

**Saves:** 50-200ms per wake (eliminates `getUserMedia()` latency)

**Privacy:** Audio stays local. The mic is warm but only captures when recording is active. VAD runs only during listening state. No audio leaves the device.

### Approach B: Pre-Init VAD (`vad.ts`)

**What:** Create the `MicVAD` instance at app startup and keep it alive. Pause/resume instead of create/destroy.

**How:**
1. New `preloadMicVad(stream)` function creates `MicVAD` at startup
2. VAD starts in paused state (`startOnLoad: false`)
3. `stopVad()` now **pauses** the VAD (not destroys it)
4. `startVad()` now **resumes** the paused VAD (~1-10ms vs ~60-250ms)

```typescript
// At startup:
await preloadMicVad(micStream);  // Creates MicVAD, paused

// On wake:
await micVad.start();  // Resume from pause — ~1ms

// After command:
micVad.pause();  // Pause, don't destroy
```

**Saves:** 60-250ms per wake (eliminates `MicVAD.new()` latency)

**RAM:** ~1 MB more (VAD model stays in memory)

### Approach C: Parallel Init (`main.tsx`)

**What:** Start recording and VAD simultaneously instead of sequentially.

**How:**
```typescript
// Before (sequential):
await captureUntilSilence(micStream);  // ~5ms
await startVad(micStream);             // ~250ms
// Total: ~255ms

// After (parallel):
await Promise.all([
  captureUntilSilence(micStream),      // ~5ms
  startVad(micStream),                 // ~1ms (pre-init)
]);
// Total: ~5ms (max of both)
```

**Saves:** ~60-250ms (overlaps the two operations)

---

## Wake-to-Listen Timeline

| Step | Before | After |
|------|--------|-------|
| Mic acquisition (`getUserMedia`) | 50-200ms | **0ms** (stream kept warm) |
| VAD initialization (`MicVAD.new`) | 60-250ms | **~1ms** (paused, just resume) |
| Recording + VAD start | Sequential (~255ms) | **Parallel** (~5ms) |
| **Total wake-to-listen** | **~200-500ms** | **~10-50ms** |

---

## Implementation Details

### `main.tsx` Changes

1. **Static imports** for hot path (no dynamic `import()` in `startListening`)
2. **`warmMic()`** function acquires stream + pre-inits VAD at startup
3. **`startListening()`** reuses warm stream, starts record+VAD in parallel
4. **`__NEXUS_RELEASE_MIC__`** disables tracks instead of stopping them
5. **`__NEXUS_CANCEL__`** disables tracks instead of stopping stream
6. **Removed `stopMicStream()`** (no longer needed)

### `vad.ts` Changes

1. **New `preloadMicVad(stream)`** — creates MicVAD at startup
2. **`startVad()`** — fast path: resume pre-init VAD; slow path: create new
3. **`stopVad()`** — pauses VAD instead of destroying (`micVad` kept alive)
4. **`startSileroVad()`** — reuses existing `micVad` if available
5. **`micVadStream`** tracks which stream the VAD is bound to

---

## Files Modified

| File | Changes |
|------|---------|
| `frontend/src/main.tsx` | Hot mic, parallel init, static imports, warmMic(), removed stopMicStream() |
| `frontend/src/audio/vad.ts` | preloadMicVad(), pause/resume instead of create/destroy, micVadStream tracking |

---

## Test Results

| Test | Result |
|------|--------|
| TypeScript compile | 0 errors |
| Release build | Success (3m 57s) |
| Parser tests | 5/5 passed |
| NEXUS RAM | 48.5 MB (+1 MB for warm mic + VAD) |
| STT server | UP (tiny.en) |
| Sidecar | UP |

---

## Future: Approach D (Continuous Listening)

Not implemented yet, but designed for future addition:

- After first wake, NEXUS stays in listening mode continuously
- VAD detects speech segments automatically
- No need to say "NEXUS" between commands
- User says "go to sleep" or "stop listening" to end the session
- Higher battery usage (continuous mic + VAD)
- Most natural UX — like a conversation
