# 20 — STT Server Fix + Wake Word Reliability

**Date:** 2026-08-29
**Status:** Implemented and tested

## Part 1: STT Server Missing `__main__` Block

### Problem

The STT server (`server/stt_server.py`) loaded the whisper model
successfully but then exited immediately without starting the HTTP
server. The logs showed:

```
INFO NEXUS.stt loading whisper model=tiny.en device=cpu compute=int8
INFO NEXUS.stt whisper model loaded in 2.1s — ready for transcription
# ... then exits, no uvicorn server started
```

### Root cause

The file ended at the `/transcribe` endpoint definition with no
`if __name__ == "__main__"` block. The server could only be started
via `uvicorn stt_server:app --port 39217` (as documented in the
docstring), but the NEXUS app and our test scripts call
`python stt_server.py` directly.

### Fix

Added the `__main__` block at the end of `server/stt_server.py`:

```python
if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("NEXUS_STT_PORT", "39217"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
```

### Verification

```powershell
python stt_server.py
# → loads model in 2-3s
# → starts uvicorn on 127.0.0.1:39217
# → health check returns {"ok": true, "model": "tiny.en", ...}
```

---

## Part 2: Wake Word Reliability Assessment

### Current state

The wake word model (`nexus.onnx`, v22) has:
- **Accuracy:** 78.6%
- **Recall:** 58.2% (misses ~4 in 10 "NEXUS" utterances)
- **False positives:** 1.33/hour

### Detection pipeline

```
cpal (48kHz, 2ch) → downmix to mono → resample to 16kHz
  → silence gate (RMS < 0.0005 = skip)
  → AGC (amplify to target RMS 0.03, max 50x gain)
  → melspectrogram ONNX model
  → embedding ONNX model
  → nexus classifier ONNX model
  → probability score
  → if prob > 0.45 AND avg > threshold → wake
  → if prob > 0.5 (single-frame high-confidence) → wake immediately
```

### What's working

1. **Silence gate** — prevents false wakes on digital silence
2. **AGC** — amplifies quiet speech so whispered "NEXUS" is detected
3. **Single-frame high-confidence trigger** — if any frame hits 0.5+,
   wake immediately without waiting for multi-frame smoothing
4. **Baton pass** — the wake word engine continues working after voice
   commands (fixed in this session, see doc 17)

### What's not working well

1. **58.2% recall** — the model misses many "NEXUS" utterances
2. **Background speech interference** — the model sometimes triggers
   on non-wake speech (1.33 FP/hr)

### Why voice wake is unreliable

The model was trained on a limited dataset (Kaggle v22). The 58.2%
recall means that on average, the user needs to say "NEXUS" ~2 times
for it to be detected. This is a model quality issue, not a code bug.

### Possible improvements (not implemented)

1. **Retrain with more data** — collect more "NEXUS" samples from
   multiple speakers and environments
2. **Lower the threshold** — currently 0.45; lowering to 0.35 would
   increase recall but also increase false positives
3. **Use a larger model** — the current model is small for fast
   inference; a larger model would have better recall
4. **Multi-model ensemble** — run multiple models with different
   thresholds and OR their outputs
5. **Speaker adaptation** — fine-tune the model on the user's voice
   (the speaker verification infrastructure exists but is not wired)

### Current recommendation

The hotkey (`Ctrl+Shift+Space`) is the reliable way to wake NEXUS.
The voice wake word works but is unreliable (~58% recall). Users who
need reliable wake should use the hotkey. Voice wake is a convenience
feature that works some of the time.

---

## Testing Summary (2026-08-29)

### Tests passed

| Test | Result |
|---|---|
| Hotkey wake (Ctrl+Shift+Space) | ✅ Works |
| Cancel hotkey (Ctrl+Space) | ✅ Works |
| Voice wake (saying "NEXUS") | ⚠️ Works but unreliable (~58% recall) |
| PR analysis ("analyse PR 5 in servx") | ✅ Works end-to-end |
| "On it sir" spoken once (not twice) | ✅ Fixed |
| Baton pass (wake word survives after voice command) | ✅ Fixed |
| STT server starts with `python stt_server.py` | ✅ Fixed |
| Sidebar shows PR analysis result | ✅ Works |
| STT correction ("Analyze" → "analyse") | ✅ Works |
| Long-running query detection | ✅ Works |
| Audio volume RMS tracking | ✅ Implemented |
| Multi-turn VAD resume | ✅ Implemented |
| "Didn't catch that" retry (max 3) | ✅ Implemented |

### Known issues

| Issue | Status |
|---|---|
| Voice wake unreliable (58% recall) | Model quality — needs retraining |
| TTS WebSpeech errors on some utterances | Fallback to synth voice works |
| VAD misfire on short segments | Already handled (segment too short detection) |
