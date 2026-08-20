# Feature: Wake Word Detection

> The "always-listening" ear of NEXUS. Detects the spoken word "NEXUS" (and sound-alikes) using a custom-trained ONNX model running in pure Rust.

**Source files:**
- `src-tauri/src/wakeword_oww.rs` — the engine
- `src-tauri/src/wakeword.rs` — legacy VAD+ASR fallback
- `src-tauri/resources/oww/nexus.onnx` — the trained model
- `train_nexus_oww.ipynb` — training notebook

**Detailed docs:** [../wake-word/](../wake-word/) (20 documents covering research, decision, training, validation, Tier 3)

---

## How It Works

```
Microphone (cpal, 48 kHz stereo)
  │
  ▼ downmix to mono + resample to 16 kHz
  │
  ▼ chunk into 1280-sample (80 ms) frames
  │
  ▼ feed to 3-stage ONNX pipeline (tract-onnx, pure Rust):
  │
  │  Stage 1: melspectrogram.onnx  →  80-dim mel features
  │  Stage 2: embedding_model.onnx →  96-dim embeddings (16 frames)
  │  Stage 3: nexus.onnx           →  single probability score [0.0, 1.0]
  │
  ▼ rolling probability buffer (last 10 scores)
  │
  ▼ if max(buffer) > 0.5 AND refractory period (2 s) elapsed:
  │
  ▼ (optional) speaker verification
  │
  ▼ emit wake  →  win.eval("window.__NEXUS_WAKE__()")
```

## Why openWakeWord, Not VAD+ASR?

| Aspect | Old (VAD+ASR) | New (openWakeWord KWS) |
|--------|---------------|------------------------|
| Recall | ~30% | ~100% (7/7 in validation) |
| Latency | 500-1000 ms | ~80 ms (per chunk) |
| Start of word | Clipped by VAD | Never missed |
| False positives | Frequent | 0 observed |
| RAM | ~143 MB | ~30-50 MB |
| CPU | Higher (ASR model) | ~1-2% |
| Custom wake word | Text matching only | Trained acoustic model |

## Sound-Alikes

The model is trained with synthetic Piper TTS data including pronunciation variants:
- "nexus", "nixus", "nexis", "nixis", "mexic", "next us"

This handles accents and mispronunciations without needing real user audio.

## Speaker Verification (Optional)

When a voice profile is enrolled (5 clips of the user saying "NEXUS"):
1. `sherpa-onnx` extracts a speaker embedding from the wake audio.
2. The embedding is compared to the stored profile via cosine similarity.
3. If similarity < threshold → wake is rejected (someone else said "nexus").

This prevents family members / roommates / TV ads from waking NEXUS.

## Meeting Suppression

The audio callback checks `MeetingState::should_suppress_wake()` on every 80 ms chunk:
- If a meeting is active → skip KWS inference (saves CPU, prevents accidental wakes).
- If TTS is playing → skip KWS (prevents NEXUS from hearing its own voice).
- If manually paused → skip KWS.
- **Hotkey still works** regardless of suppression state.
