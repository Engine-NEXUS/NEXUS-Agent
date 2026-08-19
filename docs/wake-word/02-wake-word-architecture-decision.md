# Wake Word Architecture Decision

> Why we chose openWakeWord (KWS) over VAD+ASR, Porcupine, and sherpa-onnx KWS.
> Includes comparison tables, evaluation criteria, and decision matrix.

---

## 1. The Decision

We needed to choose a wake word detection architecture for NEXUS. The original VAD+ASR approach had ~30% recall — unacceptable for a voice assistant. This document records the options considered, the evaluation criteria, and the final decision.

---

## 2. Options Considered

### Option A: Keep VAD+ASR (sherpa-onnx)

**Description:**
- Silero VAD detects speech segments
- Zipformer ASR transcribes each segment
- Text matching checks for "nexus" and sound-alikes
- Speaker verification as second stage

**Status:** Already implemented and working (with ~30% recall)

**Pros:**
- Already implemented
- No additional training needed
- Supports any wake word via text matching

**Cons:**
- ~30% recall (unacceptable)
- VAD clips start of words (structural problem)
- ASR misrecognizes words (structural problem)
- High latency (500-1000ms)
- High RAM (~143MB)

### Option B: openWakeWord (KWS)

**Description:**
- Train custom "nexus" model with synthetic TTS data
- 3-stage pipeline: melspectrogram → embedding → classifier
- 1280-sample (80ms) sliding window
- Pure Rust via tract-onnx
- No VAD, no ASR

**Pros:**
- Expected >95% recall
- Pure Rust (tract-onnx, no native deps)
- Open source (Apache 2.0)
- Custom model training with synthetic data
- No API key, no online activation
- Small model size (~3.1MB base + ~800KB classifier)
- Privacy: fully on-device

**Cons:**
- Need to train custom model (~1 hour on Colab)
- Training requires Linux (Piper TTS) → use Colab
- No pre-trained "nexus" model available
- Speaker verification needs separate integration

### Option C: Porcupine (Picovoice)

**Description:**
- Commercial wake word engine
- Type-to-train in their console (type "nexus", get model in seconds)
- Very accurate (11x more accurate than PocketSphinx)

**Pros:**
- Fastest training (seconds, not hours)
- Very high accuracy
- Cross-platform SDK
- No training data needed

**Cons:**
- **Requires API key** (devices must contact Picovoice server)
- **Online activation** required periodically
- **Not open source** (commercial product)
- Models are **platform-specific** (Linux model won't run on Windows)
- Free tier has limited device count
- Privacy concern: requires server communication

### Option D: sherpa-onnx KWS Module

**Description:**
- sherpa-onnx has a dedicated keyword spotting module
- Uses Zipformer model with keyword-specific decoding

**Pros:**
- Already have sherpa-onnx as dependency
- No new dependencies needed
- Open source (Apache 2.0)

**Cons:**
- **<10% recognition rate for English** with GigaSpeech model (known issue #2678)
- Wenetspeech model works for Chinese but not English
- Open vocabulary KWS requires careful parameter tuning (boosting scores, trigger thresholds)
- Not viable for English wake word detection

---

## 3. Evaluation Criteria

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Recall (false reject rate) | 10 | Must detect >95% of utterances |
| False alarm rate | 8 | Must not trigger falsely (<0.5/hour) |
| Latency | 7 | Must be fast (<200ms from word to wake) |
| RAM usage | 6 | Must be lightweight (<60MB) |
| CPU usage | 5 | Must be low (<5% at idle) |
| Background noise robustness | 8 | Must work in real environments |
| Custom wake word support | 9 | Must support "nexus" specifically |
| Privacy (on-device only) | 10 | No audio or biometrics to server |
| Open source | 7 | Must be open source for auditability |
| Rust support | 6 | Must have Rust integration |
| No external dependencies | 5 | No API keys, no online activation |
| Training difficulty | 4 | Should be easy to train/retrain |
| Model size | 4 | Should be small (<10MB) |
| Cross-platform | 5 | Must work on Windows, macOS, Linux |

---

## 4. Comparison Table

| Criterion | A: VAD+ASR | B: openWakeWord | C: Porcupine | D: sherpa-onnx KWS |
|-----------|------------|-----------------|--------------|-------------------|
| Recall (>95%) | ✗ (~30%) | ✓ (>95% expected) | ✓ (high) | ✗ (<10% English) |
| False alarm (<0.5/hr) | ✓ | ✓ (<0.5/hr target) | ✓ | ? |
| Latency (<200ms) | ✗ (500-1000ms) | ✓ (~80ms) | ✓ (~30ms) | ? (500ms+) |
| RAM (<60MB) | ✗ (~143MB) | ✓ (~30-50MB) | ✓ (small) | ✗ (~143MB) |
| CPU (<5% idle) | ✓ | ✓ | ✓ | ✓ |
| Background noise | ✗ (poor) | ✓ (robust) | ✓ (robust) | ✗ (poor) |
| Custom wake word | ✓ (text match) | ✓ (trainable) | ✓ (type-to-train) | ✓ (open vocab) |
| Privacy (on-device) | ✓ | ✓ | ✗ (online activation) | ✓ |
| Open source | ✓ | ✓ | ✗ | ✓ |
| Rust support | ✓ (sherpa-onnx) | ✓ (tract-onnx) | ✓ (SDK) | ✓ (sherpa-onnx) |
| No external deps | ✓ | ✓ | ✗ (API key) | ✓ |
| Training difficulty | N/A | Medium (Colab, 1hr) | Easy (seconds) | Hard (tuning) |
| Model size (<10MB) | ✗ (~65MB) | ✓ (~3.1MB) | ✓ (small) | ✗ (~65MB) |
| Cross-platform | ✓ | ✓ | ✓ | ✓ |

---

## 5. Decision Matrix

Score each option 1-5 on each criterion (5 = best), multiplied by weight:

| Criterion | Weight | A: VAD+ASR | B: openWakeWord | C: Porcupine | D: sherpa-onnx |
|-----------|--------|------------|-----------------|--------------|----------------|
| Recall | 10 | 1 (10) | 5 (50) | 5 (50) | 1 (10) |
| False alarm | 8 | 4 (32) | 4 (32) | 5 (40) | 3 (24) |
| Latency | 7 | 1 (7) | 5 (35) | 5 (35) | 2 (14) |
| RAM | 6 | 1 (6) | 4 (24) | 5 (30) | 1 (6) |
| CPU | 5 | 4 (20) | 4 (20) | 5 (25) | 4 (20) |
| Background noise | 8 | 1 (8) | 5 (40) | 5 (40) | 1 (8) |
| Custom wake word | 9 | 3 (27) | 5 (45) | 5 (45) | 3 (27) |
| Privacy | 10 | 5 (50) | 5 (50) | 1 (10) | 5 (50) |
| Open source | 7 | 5 (35) | 5 (35) | 1 (7) | 5 (35) |
| Rust support | 6 | 4 (24) | 5 (30) | 4 (24) | 4 (24) |
| No external deps | 5 | 5 (25) | 5 (25) | 1 (5) | 5 (25) |
| Training difficulty | 4 | 5 (20) | 3 (12) | 5 (20) | 2 (8) |
| Model size | 4 | 1 (4) | 5 (20) | 5 (20) | 1 (4) |
| Cross-platform | 5 | 5 (25) | 5 (25) | 5 (25) | 5 (25) |
| **TOTAL** | | **293** | **443** | **376** | **280** |

### Final Scores

| Rank | Option | Score | Verdict |
|------|--------|-------|---------|
| 1 | **B: openWakeWord** | **443** | **CHOSEN** |
| 2 | C: Porcupine | 376 | Rejected (privacy, not open source) |
| 3 | A: VAD+ASR | 293 | Rejected (30% recall, structural problems) |
| 4 | D: sherpa-onnx KWS | 280 | Rejected (<10% English recall) |

---

## 6. Final Decision: openWakeWord

openWakeWord won with a score of 443/560 (79%). Key reasons:

1. **Highest expected recall (>95%)** — the most important criterion
2. **Pure Rust (tract-onnx)** — no native ONNX Runtime dependency
3. **Open source (Apache 2.0)** — fully auditable
4. **Custom model training with synthetic data** — no real audio needed
5. **No API key, no online activation** — fully offline
6. **Small model size (~3.1MB)** — 20x smaller than VAD+ASR
7. **Privacy: fully on-device** — no server communication
8. **Has Rust port (oww-rs)** — proven integration path

---

## 7. Trade-offs Accepted

| Trade-off | Mitigation |
|-----------|------------|
| Need to train custom model (~1 hour) | One-time cost, use Google Colab (free) |
| Training requires Linux (Piper TTS) | Use Colab (Linux + GPU) |
| No pre-trained "nexus" model | Train with synthetic TTS data |
| Speaker verification needs integration | TODO: audio ring buffer for proper SV |
| tract-onnx may be slower than ONNX Runtime | Small models, single-threaded is sufficient |

---

## 8. What We Rejected and Why

### 8.1 VAD+ASR (Option A)

**Rejected because of three structural problems that cannot be fixed by tuning:**

1. **VAD clips start of words** — VAD needs 200-300ms to trigger, but "NEXUS" is only 600-800ms. By the time VAD triggers, 200-300ms of the word is gone. ASR gets incomplete audio.

2. **VAD segments can split words** — VAD uses silence thresholds. A slight pause between syllables causes VAD to split "NEXUS" into "NE" and "XUS" — neither recognizable.

3. **ASR is not optimized for keywords** — ASR optimizes for general transcription, not for catching one specific word. sherpa-onnx GigaSpeech has <10% recognition rate for English (issue #2678).

**Evidence:** Our testing showed ~30% recall (3 out of 10 utterances detected). This is unacceptable.

### 8.2 Porcupine (Option C)

**Rejected because of privacy and licensing concerns:**

1. **Requires API key** — devices must contact Picovoice server for activation
2. **Online activation required periodically** — can't work fully offline
3. **Not open source** — commercial product, can't audit the code
4. **Platform-specific models** — a model trained for Linux won't run on Windows
5. **Free tier limitations** — limited device count

**The privacy concern is fundamental:** NEXUS's architecture requires that no audio or biometric data leaves the device. Porcupine's online activation requirement violates this principle.

### 8.3 sherpa-onnx KWS (Option D)

**Rejected because of poor English performance:**

1. **<10% recognition rate for English** with GigaSpeech model (GitHub issue #2678)
2. The Wenetspeech model works well for Chinese (>90%) but not English
3. Open vocabulary KWS requires careful parameter tuning (boosting scores, trigger thresholds)
4. Even with tuning, the base model is not designed for English wake word detection

**This is a known, documented issue** — not something we can fix.

---

## 9. Implementation Summary

| Aspect | Decision |
|--------|----------|
| Engine | openWakeWord (KWS) |
| Runtime | tract-onnx (pure Rust) |
| Models | melspectrogram.onnx + embedding_model.onnx + nexus.onnx |
| Training | Google Colab notebook (Piper TTS, ~1 hour) |
| Feature flag | `wakeword-oww` (default) |
| Old engine | `wakeword-sherpa` (kept as fallback) |
| Speaker verification | Preserved (sherpa-onnx speaker model) |
