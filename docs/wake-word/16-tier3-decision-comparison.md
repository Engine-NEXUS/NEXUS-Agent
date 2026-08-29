# Tier 3 Latency Reduction: Options Considered & Decision

> How we chose to reduce command latency from ~31 seconds to ~200ms.
> This document records every option evaluated, the comparison criteria,
> and the final decision for NEXUS.

---

## 1. The Problem

### Observed Latency (measured from logs)

```
15:05:47.317  OWW wake detected
              │
              │  4.5s  — VAD waiting for speech end
              │
15:05:51.806  Send 92KB audio to STT server (localhost:8000)
              │
              │  27.0s — Whisper base model on CPU + hallucination loop
              │         (beam_size=5, no max_new_tokens, no repetition filter)
              │
15:06:18.840  STT result: "open youtube open youtube youtube youtube..."
              │
              │  0.3ms — Registry hit + focus existing window
              │
15:06:18.860  YouTube focused
```

**Total: ~31 seconds. STT is 87% of the latency. App resolution is 0.3ms.**

### Root Causes

| Cause | Impact | Evidence |
|-------|--------|----------|
| Whisper `base` model on CPU | 27s inference | STT health: `model=base, device=cpu` |
| `beam_size=5` | 5x slower than greedy | Server config |
| No `max_new_tokens` cap | Unbounded generation | Repetition loop: "youtube" 200+ times |
| No `condition_on_previous_text=False` | Hallucination feedback | Repetitive output |
| VAD `min_silence_duration_ms=1500` | 1.5s+ wait after speech | 4.5s gap between wake and STT send |
| No NVIDIA GPU | No GPU acceleration | Intel Iris Xe integrated only |

### Hardware Constraints

| Component | Value |
|-----------|-------|
| CPU | Intel i7-1355U (10 cores, 12 threads) |
| RAM | 15.7 GB total, 4.6 GB free |
| GPU | Intel Iris Xe (integrated, 2GB shared) |
| NVIDIA GPU | **None** — `nvidia-smi` unavailable |
| VRAM | 0 GB dedicated |

### Resource Usage (measured live)

| Process | Working RAM | Peak RAM | Private RAM | CPU Time |
|---------|-------------|----------|-------------|----------|
| nexus.exe (Rust) | 67 MB | 69 MB | 20 MB | 221s |
| python.exe (STT) | 178 MB | **469 MB** | **1,579 MB** | 551s |
| node (dev server) | 143 MB | 232 MB | — | 18s |
| **Total stack** | **388 MB** | — | — | — |

---

## 2. Options Considered

Six options were evaluated, ranging from quick config fixes to full
architecture changes. Each was assessed for latency improvement, resource
impact, implementation risk, and compatibility with the existing codebase.

---

### Option 1: Tune Existing STT (Tier 1)

**Description:**
Keep Whisper but fix the configuration:
- Switch from `base` to `tiny` model
- `beam_size=1` (greedy decoding)
- `max_new_tokens=64` (cap generation)
- `condition_on_previous_text=False` (stop hallucination)
- `compression_ratio_threshold=1.5` (reject repetition)
- `hallucination_silence_threshold=1.0`
- Reduce VAD `min_silence_duration_ms` from 1500 to 500

**Expected latency:** ~2-4 seconds (down from 27s)

**Pros:**
- Minimal code changes (config only)
- No new dependencies
- No model training needed
- Fixes hallucination immediately
- Keeps full ASR for any command

**Cons:**
- Still 2-4s (not instant like Siri)
- `tiny` model is less accurate than `base`
- Still uses ~200-300 MB RAM for STT server
- Still CPU-bound (no GPU)

**Resource impact:**
- RAM: ~200 MB (down from 469 MB peak)
- CPU: Lower (tiny + beam_size=1)
- Model size: 37 MB (tiny) vs 75 MB (base)

**Implementation risk:** Very low — config changes only

**Verdict:** ✅ **Do this as an immediate fix** — but it's not the permanent solution

---

### Option 2: Streaming ASR (Tier 2)

**Description:**
Replace batch Whisper with a streaming ASR model that transcribes
in real-time as the user speaks, instead of waiting for speech to end
and then processing the whole clip.

Options researched:
- **sherpa-onnx streaming Zipformer** (already in Cargo.toml)
- **Whisper streaming** (whisper.cpp with streaming mode)
- **Paraformer streaming** (sherpa-onnx)

**Expected latency:** ~500ms after speech ends (partial results during speech)

**Pros:**
- Real-time partial transcripts
- User sees feedback faster
- No need to wait for full clip
- sherpa-onnx already in dependencies

**Cons:**
- Still produces text → still needs intent parser
- Still uses ~100-200 MB RAM
- Streaming Zipformer is less accurate than Whisper
- Requires significant refactoring of the audio pipeline
- Doesn't solve the fundamental "ASR → text → intent" indirection

**Resource impact:**
- RAM: ~100-200 MB (streaming models are smaller)
- CPU: Moderate (continuous inference)
- Model size: ~30-80 MB

**Implementation risk:** Medium — requires audio pipeline refactoring

**Verdict:** ❌ **Skip for now** — Tier 3 is a better long-term solution

---

### Option 3: ASR-free Spoken Language Understanding (SLU)

**Description:**
Train an end-to-end model that maps audio directly to structured intent,
bypassing text entirely. Based on Fluent Speech Commands (FSC) dataset.

Research sources:
- Fluent Speech Commands dataset (Fluent.ai, 30,043 utterances, 31 intents)
- "A Low Latency ASR-Free End to End SLU System" (Interspeech 2020)
- c-jg/slu (1M parameter Transformer, 7MB, 95%+ accuracy on FSC)
- SpeechBrain FSC recipe (99.6% accuracy with pre-training)

**Expected latency:** ~50ms on CPU (1M params, no text generation)

**Pros:**
- Lowest latency option (~50ms)
- Smallest model (~7 MB)
- No ASR dependency at all
- Directly outputs structured intents
- Designed for resource-constrained devices

**Cons:**
- Requires training a custom model from scratch
- FSC dataset is smart-home commands ("turn on lights"), not app-launching
- Would need custom labeled audio data for "open youtube" etc.
- No pre-trained model for app-launching commands exists
- Training requires GPU (Colab) and labeled audio data
- Doesn't handle open-ended queries (only fixed intent set)
- Different runtime from OWW (would need PyTorch/ONNX integration)

**Resource impact:**
- RAM: ~10-20 MB (tiny model)
- CPU: Very low (1M params)
- Model size: ~7 MB

**Implementation risk:** High — new model architecture, new training pipeline, new runtime

**Verdict:** ❌ **Skip** — too much custom work, no pre-trained model for our commands

---

### Option 4: Keyword Spotting (KWS) for Commands

**Description:**
Use sherpa-onnx's keyword spotting (KWS) to detect command phrases.
KWS is designed for wake words but can detect any phrase.

Research sources:
- sherpa-onnx KWS with Zipformer transducer (3.3M params)
- Pre-trained Chinese KWS model available
- English KWS requires custom training

**Expected latency:** ~80ms (streaming, 80ms chunks)

**Pros:**
- sherpa-onnx already in Cargo.toml
- Streaming (real-time detection)
- Small model (~3.3 MB)
- Well-documented Rust API
- Same pipeline as wake word

**Cons:**
- No pre-trained English command model
- Requires training per-command (similar to OWW approach)
- Transducer-based KWS is more complex than OWW's DNN classifier
- Keyword file format is BPE-token-based (less intuitive)
- Would need a separate pipeline from the OWW wake word

**Resource impact:**
- RAM: ~15 MB per model
- CPU: Low
- Model size: ~3.3 MB per model

**Implementation risk:** Medium — new training pipeline, but Rust API exists

**Verdict:** ❌ **Skip** — OWW approach (Option 5) is simpler and reuses existing pipeline

---

### Option 5: openWakeWord Command Classifiers (CHOSEN)

**Description:**
Train multiple OWW classifier models — one per command phrase.
Each model shares the same melspectrogram + embedding models as the
wake-word detector, just with a different classifier head.

The OWW pipeline already runs continuously for wake-word detection.
Adding command classifiers means running a few more tiny DNN models
on each 80ms chunk — negligible cost.

**Expected latency:** ~200ms (80ms detection + 80ms debounce + 0.3ms execute)

**Pros:**
- **Reuses existing pipeline** — melspectrogram, embedding, audio capture
- **Same runtime** — tract-onnx, already integrated in `wakeword_oww.rs`
- **Same training process** — extends the existing Colab notebook
- **Tiny models** — ~800 KB per command
- **No ASR** — direct audio → intent, no text generation
- **No hallucination** — binary classifier, can't repeat words
- **Parallel detection** — all command models run on each chunk
- **Confidence-gated** — falls back to STT if no command matches
- **Non-breaking** — STT path remains as fallback

**Cons:**
- Requires training one model per command (~15-25 min each on Colab)
- Limited to fixed command set (can't handle arbitrary queries)
- Cross-command negatives needed (so "open youtube" doesn't trigger "open gmail")
- False positive risk (mitigated by threshold + refractory period)

**Resource impact:**
- RAM: ~5 MB per model (shared features, tiny classifier)
- CPU: Low (tiny DNN, same as wake word)
- Model size: ~800 KB per model

**Implementation risk:** Low — extends existing code, same patterns

**Verdict:** ✅ **CHOSEN** — best balance of latency, simplicity, and compatibility

---

### Option 6: Browser Extension / CDP for App Control

**Description:**
Instead of optimizing speech recognition, optimize the app-launching side
by controlling the browser directly via Chrome DevTools Protocol (CDP) or
a browser extension with native messaging.

Research sources:
- Chrome DevTools Protocol documentation
- Playwright browser automation
- Browser extension + native messaging architecture

**Expected latency:** No impact on STT latency (orthogonal)

**Pros:**
- Can control existing browser tabs (reuse logins, sessions)
- Can open specific URLs in existing tabs
- More precise than `ShellExecuteW`

**Cons:**
- **Does not address the STT bottleneck** (27s → still 27s)
- Requires browser to expose debugging port (security concern)
- Complex setup (CDP connection, tab management)
- Not cross-platform consistent

**Resource impact:** Minimal (separate from STT)

**Implementation risk:** High — new subsystem, security implications

**Verdict:** ❌ **Skip for now** — doesn't solve the primary latency problem

---

## 3. Comparison Matrix

| Criteria | Option 1: Tune STT | Option 2: Streaming ASR | Option 3: ASR-free SLU | Option 4: KWS Commands | Option 5: OWW Commands | Option 6: Browser Control |
|----------|-------------------|------------------------|----------------------|----------------------|----------------------|--------------------------|
| **Latency** | 2-4s | 0.5-1s | ~50ms | ~80ms | **~200ms** | N/A (orthogonal) |
| **RAM** | ~200 MB | ~150 MB | ~15 MB | ~15 MB | **~5 MB/cmd** | Minimal |
| **Model size** | 37 MB | 30-80 MB | 7 MB | 3.3 MB | **0.8 MB/cmd** | N/A |
| **Accuracy** | Good (tiny) | Moderate | High (FSC) | High (trained) | **High (trained)** | N/A |
| **Hallucination** | Reduced | Possible | Impossible | Impossible | **Impossible** | N/A |
| **Training needed** | None | None | Custom from scratch | Per-command | **Per-command (reuse OWW)** | None |
| **Code changes** | Config only | Major refactor | Major (new runtime) | Medium | **Minor (extend existing)** | Major (new subsystem) |
| **New dependencies** | None | None | PyTorch/ONNX | None (sherpa exists) | **None (OWW exists)** | CDP client |
| **Breaking risk** | Very low | Medium | High | Medium | **Very low** | Medium |
| **Handles queries** | ✅ Yes | ✅ Yes | ❌ No | ❌ No | ❌ No (STT fallback) | N/A |
| **Cross-platform** | ✅ | ✅ | ✅ | ✅ | **✅** | ❌ (Chrome only) |
| **GPU needed** | No | No | No | No | **No** | No |

---

## 4. The Decision

### Chosen: Option 5 (OWW Command Classifiers) + Option 1 (STT Tuning) as fallback

**Rationale:**

1. **Option 5 wins on compatibility**: The OWW pipeline is already running.
   Adding command classifiers is a minor extension, not a new system.

2. **Option 5 wins on resource efficiency**: ~5 MB per command vs 200+ MB
   for any ASR-based approach. On a machine with only 4.6 GB free RAM,
   this matters.

3. **Option 5 wins on latency**: ~200ms is close to Siri/Google Assistant
   speed (~1s). The remaining gap is endpointing (debounce), not inference.

4. **Option 1 is the safety net**: For any command not covered by a
   classifier, the tuned STT path (tiny + beam_size=1) provides a
   2-4s fallback instead of 27s.

5. **Non-breaking by design**: The `command_intents.json` starts empty (`{}`).
   No classifiers are loaded until models are trained and placed in
   `resources/oww/commands/`. The STT path handles everything until then.

### Architecture (chosen)

```
User speaks
    │
    ▼
Audio → OWW pipeline (80ms chunks)
    │
    ├─ nexus.onnx → wake detected → STT fallback for unknown commands
    │
    └─ command classifiers (open_youtube.onnx, open_gmail.onnx, ...)
        │
        ├─ High confidence → execute DIRECTLY (~200ms, no STT)
        └─ No match → fall back to STT (~2-4s with tuned config)
```

### What we explicitly rejected

| Option | Why rejected |
|--------|-------------|
| ASR-free SLU (Option 3) | No pre-trained model for app commands; would need custom labeled dataset |
| Streaming ASR (Option 2) | Still produces text → still needs intent parsing; doesn't solve the indirection |
| KWS for commands (Option 4) | More complex than OWW; doesn't reuse existing pipeline |
| Browser control (Option 6) | Doesn't address the STT bottleneck (27s → still 27s) |

---

## 5. Implementation Summary

### What was built

| Component | File | Status |
|-----------|------|--------|
| Colab training notebook | `train_nexus_commands.ipynb` | ✅ Created |
| Rust: multi-classifier support | `src-tauri/src/wakeword_oww.rs` | ✅ Implemented |
| Frontend: command event listener | `frontend/src/main.tsx` | ✅ Implemented |
| Command intents placeholder | `src-tauri/resources/oww/commands/command_intents.json` | ✅ Created (empty) |
| Architecture documentation | `docs/wake-word/15-tier3-command-classifiers.md` | ✅ Created |
| This decision document | `docs/wake-word/16-tier3-decision-comparison.md` | ✅ Created |

### What was NOT changed (preserved)

| Component | Why preserved |
|-----------|--------------|
| `app_registry.rs` | App resolution is 0.3ms — not the bottleneck |
| `command_executor.rs` | Focus → launch → URL fallback unchanged |
| `window_manager.rs` | Window focus logic unchanged |
| `recorder.ts` | STT path remains as fallback |
| `vad.ts` | VAD still used for STT fallback |
| `stt.ts` | STT still used for unknown commands |
| `parser.ts` | Intent parser still used for STT fallback |
| `wsBridge.ts` | Backend communication unchanged |

### Compilation verification

```
cargo check  →  Finished (0 errors, 6 pre-existing warnings in voice_profile.rs)
tsc --noEmit →  Finished (0 errors)
```

---

## 6. Research Sources

### Academic papers

- **Fluent Speech Commands**: Lange et al., "Fluent Speech Commands: A Dataset
  for Spoken Language Understanding Research" (2019)
  — 30,043 utterances, 97 speakers, 31 intents, 248 phrasings

- **ASR-free SLU**: "A Low Latency ASR-Free End to End Spoken Language
  Understanding System" (Interspeech 2020)
  — 17-layer CNN, global max-pooling, streaming, microcontroller-targeted

- **Apple Hey Siri**: "Hey Siri: An On-device DNN-powered Voice Trigger
  for Apple's Personal Assistant" (Apple Machine Learning Research)
  — Always-on, <1mW, on-device, speaker-adaptive

- **Amazon Alexa**: On-device speech processing architecture
  — Wake word + intent classification on device, cloud for complex queries

### Open-source projects

- **openWakeWord** (dscripka/openWakeWord) — 2K stars, Apache 2.0
  — The framework NEXUS already uses for wake-word detection

- **sherpa-onnx** (k2-fsa/sherpa-onnx) — Next-gen Kaldi, ONNX runtime
  — Already in NEXUS Cargo.toml for speaker verification

- **c-jg/slu** — 1M param Transformer for Fluent Speech Commands
  — 7MB model, 95%+ accuracy, ~1ms inference on GPU

- **SpeechBrain** — FSC recipe with 99.6% accuracy
  — Pre-trained seq2seq SLU model

- **livekit-wakeword** — Conv-Attention classifier for OWW
  — Backward-compatible with OWW models, multilingual support

- **nibor1896/custom-wakeword-trainer** — Local OWW trainer for Windows
  — Working alternative to the bit-rotted official Colab notebook

- **soundevents** (Rust) — CED AudioSet sound-event classifiers
  — 6.4 MB tiny variant, ONNX, Rust inference

### Industry references

- **Picovoice**: "Wake Word Detection Guide 2026" — comprehensive technical overview
- **Google Colab**: Free tier T4 GPU (16GB VRAM, 12hr sessions, 15-30 GPU hours/week)

---

## 7. Cross-References

- [01-wake-word-research.md](./01-wake-word-research.md) — Initial wake-word research
- [02-wake-word-architecture-decision.md](./02-wake-word-architecture-decision.md) — Wake-word decision
- [05-oww-3-stage-pipeline.md](./05-oww-3-stage-pipeline.md) — OWW pipeline architecture
- [06-model-training.md](./06-model-training.md) — Wake-word training overview
- [13-colab-training-notebook.md](./13-colab-training-notebook.md) — Wake-word Colab notebook
- [15-tier3-command-classifiers.md](./15-tier3-command-classifiers.md) — Tier 3 architecture
- `train_nexus_commands.ipynb` — Command classifier training notebook
