# NEXUS Documentation Index

> Complete technical documentation for the NEXUS floating desktop assistant.
> All documentation reflects the current state of the codebase as of 2026-08-19.

---

## Table of Contents

### Top-Level Architecture

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | High-level system architecture (thin client + fat server) |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Server deployment guide |

### Wake Word Detection (Detailed)

The wake word system went through a major architectural change. These documents
explain the full journey: research, decision-making, old approach, new approach,
training, validation, and every component in detail.

#### Research & Decisions

| # | Document | Description |
|---|----------|-------------|
| 01 | [wake-word-research.md](./wake-word/01-wake-word-research.md) | Research into how Alexa, Google, Siri, and open-source projects do wake word detection (2024-2026 data) |
| 02 | [wake-word-architecture-decision.md](./wake-word/02-wake-word-architecture-decision.md) | Why we chose openWakeWord over VAD+ASR, Porcupine, and other options — with comparison tables |

#### Old Approach (Deprecated)

| # | Document | Description |
|---|----------|-------------|
| 03 | [vad-asr-old-approach.md](./wake-word/03-vad-asr-old-approach.md) | Detailed explanation of the original VAD + ASR pipeline and why it failed |

#### New Approach (Current)

| # | Document | Description |
|---|----------|-------------|
| 04 | [oww-kws-new-approach.md](./wake-word/04-oww-kws-new-approach.md) | Detailed explanation of the new openWakeWord KWS pipeline |
| 05 | [oww-3-stage-pipeline.md](./wake-word/05-oww-3-stage-pipeline.md) | Deep dive: melspectrogram → embedding → classifier (the 3-stage ONNX pipeline) |

#### Model Training & Validation

| # | Document | Description |
|---|----------|-------------|
| 06 | [model-training.md](./wake-word/06-model-training.md) | How the custom "nexus" ONNX model was trained (Colab notebook, Piper TTS, synthetic data, full hyperparameters) |
| 13 | [colab-training-notebook.md](./wake-word/13-colab-training-notebook.md) | Cell-by-cell breakdown of `train_nexus_oww.ipynb` — what each cell does, why, and what it produces |
| 14 | [model-validation-results.md](./wake-word/14-model-validation-results.md) | Runtime validation results from 2026-08-19 — all tests passed, 7/7 detections, 0 false positives |

#### Speaker & Variants

| # | Document | Description |
|---|----------|-------------|
| 07 | [speaker-verification.md](./wake-word/07-speaker-verification.md) | Voice profile system: speaker embeddings, enrollment, verification, threshold calibration |
| 08 | [wake-variants-soundalikes.md](./wake-word/08-wake-variants-soundalikes.md) | The wake_variants + sound_alikes system for pronunciation tolerance |

#### Implementation

| # | Document | Description |
|---|----------|-------------|
| 09 | [audio-pipeline.md](./wake-word/09-audio-pipeline.md) | Audio capture: cpal, downmixing, resampling, chunking |
| 10 | [rust-integration.md](./wake-word/10-rust-integration.md) | Rust integration: tract-onnx, Cargo features, module wiring, feature flags |

#### Testing & Performance

| # | Document | Description |
|---|----------|-------------|
| 11 | [testing-strategy.md](./wake-word/11-testing-strategy.md) | Test plan: what to verify, how to test, expected results |
| 12 | [performance-expectations.md](./wake-word/12-performance-expectations.md) | Performance: RAM, CPU, latency comparisons between old and new approaches |

#### Tier 3: Direct Command Classification (Skip ASR)

Tier 3 extends the OWW pipeline to detect spoken commands directly from
audio — no Whisper, no transcript, no 27-second delay. When a command
classifier fires, NEXUS executes the action in ~200ms.

| # | Document | Description |
|---|----------|-------------|
| 15 | [tier3-command-classifiers.md](./wake-word/15-tier3-command-classifiers.md) | Tier 3 architecture: how command classifiers work, integration plan, safety |
| 16 | [tier3-decision-comparison.md](./wake-word/16-tier3-decision-comparison.md) | All 6 options considered for latency reduction, comparison matrix, why OWW classifiers were chosen |
| 17 | [tier3-resource-analysis.md](./wake-word/17-tier3-resource-analysis.md) | Measured RAM/CPU/latency breakdown, projected usage after Tier 3, GPU considerations |
| 18 | [tier3-training-approach.md](./wake-word/18-tier3-training-approach.md) | 4 training approaches compared, why per-command OWW classifiers + Colab was chosen |
| 19 | [tier3-testing-strategy.md](./wake-word/19-tier3-testing-strategy.md) | Test plan for Tier 3: functional, latency, false positive, cross-command, fallback, resource |

### Document Reading Order

If you're new to the project, read in this order:

1. **01-wake-word-research.md** — understand the landscape
2. **02-wake-word-architecture-decision.md** — understand why we chose this path
3. **03-vad-asr-old-approach.md** — understand what we had before
4. **04-oww-kws-new-approach.md** — understand what we have now
5. **05-oww-3-stage-pipeline.md** — understand how the model works internally
6. **06-model-training.md** — understand how the model was created
7. **13-colab-training-notebook.md** — understand the training notebook in detail
8. **14-model-validation-results.md** — see the validation test results
9. **16-tier3-decision-comparison.md** — understand the latency problem and all options
10. **15-tier3-command-classifiers.md** — understand the Tier 3 solution
11. **17-tier3-resource-analysis.md** — see the resource measurements
12. **18-tier3-training-approach.md** — understand the training approach
13. **19-tier3-testing-strategy.md** — see the test plan
14. The rest can be read in any order

---

## Quick Reference

| Aspect | Old (VAD+ASR) | New (openWakeWord KWS) | Tier 3 (Command Classifiers) |
|--------|---------------|------------------------|------------------------------|
| Architecture | VAD gate → ASR → text match | KWS sliding window → probability | OWW classifiers for known commands |
| Recall | ~30% | ~100% (7/7 in validation) | ~95%+ (trained per command) |
| Latency | 500-1000ms | ~80ms (wake) | **~200ms (command → action)** |
| Command latency | 27,000ms (Whisper base) | 27,000ms (still uses Whisper) | **~200ms (skips Whisper entirely)** |
| RAM | ~143 MB | ~30-50 MB | **~5 MB per command** (shared features) |
| Background noise | Poor | Robust | Robust (same pipeline) |
| Start of word | Clipped by VAD | Never missed | Never missed |
| Custom wake word | Text matching only | Trained acoustic model | Trained per command |
| Rust runtime | sherpa-onnx (native) | tract-onnx (pure Rust) | tract-onnx (pure Rust, same pipeline) |
| Model file | N/A | nexus.onnx (772 KB) | ~800 KB per command |
| False positives | Frequent | 0 observed | Controlled by threshold + negatives |
| STT fallback | N/A | Always used | **Only for unknown commands** |

---

## Model Files

| File | Size | Role |
|------|------|------|
| `src-tauri/resources/oww/nexus.onnx` | 790 KB | Custom trained wake word classifier |
| `src-tauri/resources/oww/melspectrogram.onnx` | 1.1 MB | Pre-trained mel spectrogram extractor |
| `src-tauri/resources/oww/embedding_model.onnx` | 1.3 MB | Pre-trained embedding extractor |
| `src-tauri/resources/oww/commands/*.onnx` | ~800 KB each | Tier 3 command classifiers (trained via Colab) |
| `src-tauri/resources/oww/commands/command_intents.json` | — | Intent mapping for command classifiers |
| `train_nexus_oww.ipynb` | — | Wake word training notebook (run in Google Colab) |
| `train_nexus_commands.ipynb` | — | Command classifier training notebook (run in Google Colab) |

---

## Current Status (2026-08-19)

| Component | Status | Notes |
|-----------|--------|-------|
| Wake word model (nexus.onnx) | TRAINED & VALIDATED | 7/7 detections, 0 false positives |
| 3-stage KWS pipeline | WORKING | mel → embedding → classifier |
| Audio capture (cpal) | WORKING | 48kHz stereo → 16kHz mono |
| Rust integration (tract-onnx) | WORKING | Pure Rust ONNX inference |
| Hotkey wake (Ctrl+Shift+Space) | WORKING | Preserved from before |
| Spoken wake ("nexus") | WORKING | 7 detections in ~3 min |
| Speaker verification | PENDING | Ring buffer + verification not yet implemented |
| Tier 3: Command classifiers (Rust) | IMPLEMENTED | Multi-classifier support in wakeword_oww.rs |
| Tier 3: Command event listener (frontend) | IMPLEMENTED | main.tsx listens for command-detected events |
| Tier 3: Training notebook | CREATED | train_nexus_commands.ipynb (run in Colab) |
| Tier 3: Command models | PENDING | Need to run Colab notebook to train 10 models |
| Tier 3: Testing | PENDING | Need trained models first, then run test plan |
| Extended testing | PENDING | Multi-speaker, noise, long-running |
| Installer | NOT STARTED | Deferred until all testing complete |
