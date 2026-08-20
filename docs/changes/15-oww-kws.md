# Change: openWakeWord KWS Migration

**Commit:** `395369b` ("feat: replace VAD+ASR with openWakeWord KWS for wake word detection")
**Date:** 2026-08-19

---

## Problem

The original wake word engine used VAD (Silero) + ASR (sherpa-onnx Zipformer) + text matching. It achieved only ~30% recall:
- VAD clipped the start of short words ("nexus" → "exus").
- ASR misrecognized "nexus" as "mexic", "next", "nexus" (inconsistent).
- Text matching was brittle.

## Solution

Replaced VAD+ASR with **openWakeWord** — a continuous keyword spotting (KWS) system that scores every 80ms audio chunk for the target word "NEXUS" without using VAD or ASR.

## Why openWakeWord?

| Aspect | Old (VAD+ASR) | New (openWakeWord KWS) |
|--------|---------------|------------------------|
| Recall | ~30% | ~100% (7/7 in validation) |
| Latency | 500-1000 ms | ~80 ms (per chunk) |
| Start of word | Clipped by VAD | Never missed |
| False positives | Frequent | 0 observed |
| RAM | ~143 MB | ~30-50 MB |
| CPU | Higher (ASR model) | ~1-2% |
| Custom wake word | Text matching only | Trained acoustic model |

## 3-Stage ONNX Pipeline

```
Audio (16 kHz mono, 80 ms chunks)
  │
  ▼ Stage 1: melspectrogram.onnx  →  80-dim mel features
  │
  ▼ Stage 2: embedding_model.onnx →  96-dim embeddings (16 frames)
  │
  ▼ Stage 3: nexus.onnx           →  single probability score [0.0, 1.0]
```

All three stages run in pure Rust via `tract-onnx` (no native ONNX Runtime dependency).

## Detection Logic

- Rolling probability buffer (last 10 scores).
- If `max(buffer) > 0.5` AND refractory period (2000 ms) elapsed → wake.
- Refractory period prevents double-fires from a single utterance.

## Custom Model Training

The `nexus.onnx` classifier is trained via `train_nexus_oww.ipynb` in Google Colab (T4 GPU, ~1 hour):
- Synthetic Piper TTS data (no real user audio needed).
- Includes pronunciation variants: "nexus", "nixus", "nexis", "mexic", etc.
- Output: ~790 KB ONNX file.

See [../wake-word/06-model-training.md](../wake-word/06-model-training.md) for the full training methodology.

## Feature Flags

```toml
[features]
default = ["wakeword-oww"]
wakeword-oww = []      # openWakeWord KWS (default, current)
wakeword-sherpa = []   # legacy VAD+ASR (fallback)
wakeword-porcupine = [] # Porcupine (legacy, requires API key)
mock-wake = []          # CI: no audio, hotkey only
```

## Files Changed

- `src-tauri/src/wakeword_oww.rs` — new file (the OWW KWS engine).
- `src-tauri/src/wakeword.rs` — kept as legacy fallback (compiled when `wakeword-oww` is off).
- `src-tauri/src/lib.rs` — feature-gated module selection.
- `src-tauri/Cargo.toml` — added `tract-onnx`, `circular-buffer` dependencies.
- `src-tauri/resources/oww/nexus.onnx` — trained model.
- `src-tauri/resources/oww/melspectrogram.onnx` — pre-trained shared model.
- `src-tauri/resources/oww/embedding_model.onnx` — pre-trained shared model.

## Validation Results

From [../wake-word/14-model-validation-results.md](../wake-word/14-model-validation-results.md):
- 7/7 detections in ~3 minutes of testing.
- 0 false positives.
- Detection latency: ~80 ms per chunk.
