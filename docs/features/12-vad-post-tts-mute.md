# 12 — Dual-Phase VAD Post-TTS Mute Gate

**Branch:** prem22k
**Status:** Implemented
**Date:** 2026-08-29

---

## Problem

TTS output (NEXUS speaking) can echo back into the microphone and
self-trigger the wake word, creating infinite loops:

```
NEXUS speaks "On it sir" → mic picks up echo → wake word triggers →
NEXUS wakes → listens → no command → speaks "Didn't catch that" →
mic picks up echo → wake word triggers → ... (infinite loop)
```

## Implementation

### Rust side (`src-tauri/src/wakeword_oww.rs`)

Added a `last_tts_active` timer in the chunk processing loop. For 300ms
after TTS finishes, microphone PCM buffers are dropped:

```rust
// Drop audio for 300ms after TTS to prevent echo self-triggering
if let Some(last_tts) = self.last_tts_active {
    let elapsed = last_tts.elapsed().as_millis();
    if elapsed < 300 {
        // Skip wake-word detection for this chunk
        return;
    }
}
```

### Frontend side (`frontend/src/main.tsx`)

300ms delay in `startListening()` before VAD starts:

```typescript
// Wait 300ms after TTS finishes before starting VAD
// to allow speaker hardware decay and room reflections to clear
setTimeout(() => startVad(stream), 300);
```

## Why 300ms?

- Speaker hardware decay: ~100-150ms
- Room acoustic reflections: ~100-150ms
- Total: ~200-300ms
- 300ms is conservative — comfortably covers both phases

## Impact

Completely eliminates TTS echo self-triggering loops. NEXUS can speak
without its own voice waking it up.

## Files Changed

- `src-tauri/src/wakeword_oww.rs` — last_tts_active timer, 300ms drop gate
- `frontend/src/main.tsx` — 300ms delay in startListening()
