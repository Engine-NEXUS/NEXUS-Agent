# Change: TTS Comma Pause Fix

**Commit:** `fb4c88c` ("fix: remove comma pause in 'Didn't catch that sir' TTS")
**Date:** 2026-08-19

---

## Problem

When NEXUS couldn't understand a command, it spoke "Didn't catch that, sir." The Web Speech API paused at the comma, creating an awkward silence: "Didn't catch that [pause] sir."

## Fix

Removed the comma from the TTS string:

```typescript
// Before:
void speak("Didn't catch that, sir");

// After:
void speak("Didn't catch that sir");
```

The same fix was applied to all Tier 3 error messages in `main.tsx`.

## Why the Comma Causes a Pause

The Web Speech API (`SpeechSynthesis`) interprets punctuation as prosody cues:
- Comma → short pause (~300 ms).
- Period → longer pause (~500 ms).
- Question mark → rising intonation + pause.

For short phrases like "Didn't catch that sir", the comma-induced pause feels unnatural. Removing the comma makes it flow as a single phrase.

## Files Changed

- `frontend/src/main.tsx` — removed commas from all "Didn't catch that sir" TTS calls (3 occurrences in the Tier 3 parameter capture error paths).
