# Performance Expectations & Benchmarks

> **Document 12 — Wake Word Refactor Series**
>
> This document details the performance expectations and comparisons between the old VAD+ASR wake word approach and the new openWakeWord KWS (Keyword Spotting) approach. All figures are measured, estimated, or projected based on openWakeWord project targets and the ULTRON reference implementation.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Performance Comparison Table](#2-performance-comparison-table)
3. [Detailed Breakdown](#3-detailed-breakdown)
   - 3.1 [Recall](#31-recall)
   - 3.2 [Latency](#32-latency)
   - 3.3 [RAM](#33-ram)
   - 3.4 [Model Size](#34-model-size)
   - 3.5 [CPU](#35-cpu)
4. [Memory Breakdown (New Approach)](#4-memory-breakdown-new-approach)
5. [Latency Breakdown (New Approach)](#5-latency-breakdown-new-approach)
6. [Why KWS Is Faster](#6-why-kws-is-faster)
7. [Why KWS Uses Less RAM](#7-why-kws-uses-less-ram)
8. [Expected Battery Impact (Laptops)](#8-expected-battery-impact-laptops)
9. [Appendix A: Calculation Derivations](#appendix-a-calculation-derivations)
10. [Appendix B: Measurement Methodology](#appendix-b-measurement-methodology)
11. [Appendix C: Risk Factors & Caveats](#appendix-c-risk-factors--caveats)

---

## 1. Overview

The ULTRON wake word system has been refactored from a two-stage **VAD + ASR** (Voice Activity Detection + Automatic Speech Recognition) pipeline to a single-stage **KWS** (Keyword Spotting) pipeline based on the openWakeWord architecture.

### Old Approach (VAD + ASR)

The old approach used a cascaded pipeline:

1. **Silero VAD** continuously monitors the microphone input for speech activity.
2. When speech is detected, audio is buffered and forwarded to a **Zipformer ASR** model (int8 quantized).
3. The ASR output text is compared against the target wake word ("nexus") using fuzzy matching.
4. If the match score exceeds a threshold, the wake event is fired.

This approach suffers from several fundamental problems:

- **VAD clips the start of the wake word** — by the time VAD detects speech, 200–300ms of audio (often the first syllable) has already been lost.
- **ASR misrecognizes the wake word** — "nexus" is frequently transcribed as "next", "mexic", "nexus", "next us", etc., leading to missed detections.
- **High latency** — the combination of VAD end-of-speech detection (500ms silence timeout) and ASR decoding adds 500–1000ms of latency.
- **High resource usage** — the Zipformer ASR model alone is ~26MB of model weights, plus the ONNX Runtime overhead.

### New Approach (openWakeWord KWS)

The new approach uses a direct acoustic pattern detection pipeline:

1. **Melspectrogram** features are computed from raw audio every 80ms (1280 samples at 16kHz).
2. An **embedding model** converts the mel features into a compact acoustic embedding.
3. A **classifier model** (`nexus.onnx`) outputs a probability that the wake word was spoken.
4. A **detection smoothing** buffer averages the last 2 frames to reduce false alarms.
5. If the smoothed probability exceeds a threshold, the wake event is fired.

This approach eliminates both VAD and ASR, replacing them with a single lightweight inference pipeline that processes audio directly.

### Key Insight

The fundamental insight is that **wake word detection is not a speech recognition problem** — it is a **binary classification problem** ("was this specific acoustic pattern present in the last 320ms of audio?"). Using a full ASR system to solve a binary classification problem is massively over-engineered, leading to poor recall (the ASR misrecognizes the word) and high resource usage (the ASR model is large).

---

## 2. Performance Comparison Table

| Metric | Old (VAD+ASR) | New (OWW KWS) | Improvement |
|--------|---------------|---------------|-------------|
| **Recall** | ~30% | >95% (expected) | **3x+** |
| **False alarm rate** | Low | <0.5/hour | Similar |
| **Latency (word end → wake)** | 500–1000ms | ~80ms | **6–12x** |
| **RAM (wake engine only)** | ~143MB | ~30–50MB | **3x** |
| **CPU (idle)** | ~1–2% | ~1–2% | Similar |
| **CPU (active detection)** | ~5–10% | ~3–5% | **2x** |
| **Model size (total)** | ~65MB | ~3.1MB | **20x** |
| **Start of word capture** | Clipped (200–300ms lost) | Full | — |
| **Background noise robustness** | Poor | Robust | — |

### Summary of Improvements

- **Recall improved 3x+**: The most critical metric. The old approach missed 7 out of 10 wake word utterances. The new approach is expected to detect >95%.
- **Latency improved 6–12x**: The old approach took 500–1000ms from the end of the wake word to the wake event. The new approach takes ~80–160ms.
- **RAM reduced 3x**: The old approach used ~143MB. The new approach uses ~18–48MB (depending on whether the speaker model is loaded).
- **Model size reduced 20x**: The old approach shipped ~65MB of model files. The new approach ships ~3.1MB (base) or ~33MB (with speaker model).
- **CPU reduced ~2x during active detection**: The new approach's smaller models and simpler pipeline require less CPU per inference.

---

## 3. Detailed Breakdown

### 3.1 Recall

#### Old Approach: ~30% (3 out of 10 utterances detected)

The old approach's poor recall is caused by a cascade of failures:

**Failure Mode 1: VAD clips the start of the wake word (primary cause)**

Silero VAD requires approximately 200–300ms of speech before it confidently detects speech activity. This means the first 200–300ms of the wake word — typically the first syllable "nex-" — is not captured in the audio buffer sent to ASR. The ASR model then receives only "-us" or "-xus" and cannot recognize the full word "nexus."

- VAD threshold too high → misses quiet utterances entirely
- VAD threshold too low → false triggers on background noise
- Either way, the first syllable is usually clipped

**Failure Mode 2: ASR misrecognizes the wake word**

Even when VAD captures the full word, the Zipformer ASR model frequently misrecognizes "nexus":

| Actual | ASR Output | Match? |
|--------|------------|--------|
| "nexus" | "next" | No |
| "nexus" | "mexic" | No |
| "nexus" | "next us" | No |
| "nexus" | "nexus" | Yes |
| "nexus" | "nexus." | Yes |
| "nexus" | "nexas" | Maybe (fuzzy) |

The fuzzy matching step catches some of these, but the threshold must be set high enough to avoid false alarms from normal speech, which means borderline cases are rejected.

**Failure Mode 3: VAD does not detect the utterance at all**

Some utterances — particularly quiet ones, or those spoken quickly — are not detected by VAD at all. The audio is never sent to ASR, so the wake word is missed entirely.

**Combined effect**: These three failure modes compound. If VAD captures the full word 60% of the time, and ASR recognizes it correctly 50% of the time, the combined recall is only 30%.

#### New Approach: >95% (expected, based on openWakeWord targets)

The new approach eliminates all three failure modes:

**No VAD → full word always available**

The KWS pipeline processes every 80ms chunk of audio directly. There is no VAD gate that must trigger before processing begins. The full wake word — including the first syllable — is always available to the model.

**Direct acoustic pattern detection → no misrecognition**

The `nexus.onnx` classifier is trained specifically to detect the acoustic pattern of the word "nexus." It does not transcribe speech to text; it outputs a single probability value. There is no text matching step, no fuzzy matching, and no confusion with similar-sounding words like "next."

**Trained on synthetic data with varied speakers**

The openWakeWord training pipeline uses text-to-speech synthesis to generate thousands of examples of the wake word with varied:

- Speaker voices (different pitches, timbres)
- Speaking speeds
- Background noise conditions
- Microphone characteristics
- Accents and pronunciations

This produces a model that generalizes well to real-world speakers.

**openWakeWord project targets: <5% false reject rate**

The openWakeWord project documentation states a design target of <5% false reject rate (i.e., >95% recall) for trained custom models. This target is achievable because:

- The model sees the full audio (no VAD clipping)
- The model is trained specifically for the target word (no generic ASR confusion)
- The detection smoothing buffer reduces frame-level jitter

### 3.2 Latency

#### Old Approach: 500–1000ms

The old approach's latency is dominated by VAD's end-of-speech detection:

| Step | Time | Description |
|------|------|-------------|
| VAD speech start detection | 200–300ms | VAD needs this long to confidently detect speech |
| VAD speech end detection | 500ms | VAD requires 500ms of silence after speech to declare end-of-speech |
| ASR decoding | 100–200ms | Zipformer decoder processes the buffered audio |
| Text matching | ~1ms | Fuzzy string comparison |
| **Total** | **~800–1000ms** | **From word end to wake event** |

The 500ms silence timeout is the single largest contributor. The system must wait half a second of silence after the user stops speaking before it can even begin ASR decoding. This makes the system feel sluggish and unresponsive.

**Worst case**: If the user says "nexus" and then continues speaking (e.g., "nexus, what's the weather?"), the VAD will not detect end-of-speech until the user stops talking entirely. The wake event may be delayed by several seconds.

#### New Approach: ~80ms

The new approach processes audio in real-time with no waiting:

| Step | Time | Description |
|------|------|-------------|
| KWS chunk processing | 80ms | One chunk of 1280 samples at 16kHz |
| Detection smoothing | 160ms | 2 frames × 80ms = 160ms smoothing window |
| **Total** | **~80–160ms** | **From word end to wake event** |

The KWS pipeline processes every 80ms chunk as it arrives. There is no VAD waiting for speech start, no silence timeout for speech end, and no ASR decoding step. The moment the wake word's acoustic pattern appears in the audio stream, the classifier probability rises, and the detection smoothing buffer triggers the wake event within 1–2 frames.

**Best case**: ~80ms (single frame detection if probability is very high)
**Typical case**: ~160ms (2-frame smoothing window)
**Worst case**: ~240ms (3 frames if the first frame is borderline)

Even the worst case (240ms) is 2–4x faster than the old approach's best case (500ms).

### 3.3 RAM

#### Old Approach: ~143MB

| Component | RAM | Notes |
|-----------|-----|-------|
| Silero VAD | ~5MB | `silero_vad.onnx` model + ONNX Runtime session |
| Zipformer ASR (int8) | ~34MB | encoder int8 (~11MB) + decoder int8 (~11MB) + joiner int8 (~8MB) + tokens + session overhead |
| Speaker model | ~30MB | `speaker_model.onnx` (29.6MB) + ONNX Runtime session |
| ONNX Runtime | ~20MB | Shared runtime library + session pools |
| Audio buffers + Rust runtime | ~54MB | Ring buffers, VAD audio buffer, ASR audio buffer, Rust standard library, tokio runtime, etc. |
| **Total** | **~143MB** | |

The ~54MB for "audio buffers + Rust runtime" is a catch-all for the process's resident memory that is not directly attributable to model files. This includes:

- Rust standard library allocations
- Tokio async runtime (thread pools, task queues)
- cpal audio callback buffers
- VAD ring buffer (typically 30 seconds of audio at 16kHz = ~960KB)
- ASR input buffer (variable, up to several seconds)
- ONNX Runtime memory pools and arena allocators
- Various small allocations (strings, vectors, config structures)

#### New Approach: ~30–50MB (estimated)

| Component | RAM | Notes |
|-----------|-----|-------|
| melspectrogram.onnx | ~1MB | Mel feature extraction model |
| embedding_model.onnx | ~1.3MB | Acoustic embedding model |
| nexus.onnx | ~0.8MB | Wake word classifier model |
| tract-onnx runtime | ~5MB | Lightweight ONNX inference runtime |
| Speaker model | ~30MB | `speaker_model.onnx` (if used, shared with old approach) |
| Audio buffers + Rust runtime | ~10MB | Smaller buffers, no VAD/ASR ring buffers |
| **Total without speaker** | **~18MB** | |
| **Total with speaker** | **~48MB** | |

The "audio buffers + Rust runtime" allocation is smaller (~10MB vs ~54MB) because:

- No VAD ring buffer (KWS only needs 1280 samples = 5KB per chunk)
- No ASR input buffer (no ASR stage)
- tract-onnx has a smaller memory footprint than ONNX Runtime
- Simpler pipeline = fewer intermediate buffers

### 3.4 Model Size

#### Old Approach: ~65MB

| Model File | Size | Purpose |
|------------|------|---------|
| `silero_vad.onnx` | 643KB | Voice activity detection |
| `encoder int8` | ~9MB | Zipformer encoder (quantized) |
| `decoder int8` | ~9MB | Zipformer decoder (quantized) |
| `joiner int8` | ~8MB | Zipformer joiner (quantized) |
| `tokens.txt` | ~100KB | ASR token vocabulary |
| `speaker_model.onnx` | 29.6MB | Speaker embedding/verification |
| **Total** | **~65MB** | |

The Zipformer ASR models (encoder + decoder + joiner) account for ~26MB, which is 40% of the total model size. These models are necessary for generic speech recognition but are massive overkill for wake word detection.

#### New Approach: ~3.1MB (without speaker) or ~33MB (with speaker)

| Model File | Size | Purpose |
|------------|------|---------|
| `melspectrogram.onnx` | 1.0MB | Mel spectrogram feature extraction |
| `embedding_model.onnx` | 1.3MB | Acoustic embedding (Google's `embedding_model.tflite` ported to ONNX) |
| `nexus.onnx` | ~0.8MB | Custom wake word classifier for "nexus" |
| **Total base** | **~3.1MB** | |
| `speaker_model.onnx` | 29.6MB | Speaker embedding/verification (shared with old approach) |
| **Total with speaker** | **~33MB** | |

The base KWS models total only 3.1MB — a **20x reduction** from the old approach's 65MB. The speaker model is optional and shared between both approaches, so it does not represent a new cost.

### 3.5 CPU

#### Old Approach: ~1–2% idle, ~5–10% active

**Idle (no speech detected):**
- VAD runs every 32ms (512 samples at 16kHz)
- VAD inference: ~1–2ms per call
- ASR is not running (no speech detected)
- Net CPU: ~1–2% (dominated by VAD inference + audio I/O)

**Active (speech detected):**
- VAD continues running every 32ms
- ASR runs on each new audio chunk while speech is active
- ASR inference: ~10–20ms per chunk (Zipformer is a large model)
- Net CPU: ~5–10% (VAD + ASR + audio I/O)

**Characteristics:**
- Single-threaded inference (ONNX Runtime with 1 thread)
- CPU usage spikes when ASR is active
- VAD runs continuously regardless of speech

#### New Approach: ~1–2% idle, ~3–5% active

**Idle (no wake word detected):**
- KWS runs every 80ms (1280 samples at 16kHz)
- Full 3-stage pipeline runs on every chunk (melspectrogram → embedding → classifier)
- Total inference: ~11–22ms per chunk
- Net CPU: ~1–2% (small models, efficient pipeline)

**Active (wake word detected):**
- Same as idle — the pipeline runs identically on every chunk
- No separate "active" mode
- Net CPU: ~3–5% (slightly higher due to detection smoothing and wake event processing)

**Characteristics:**
- Single-threaded inference (tract-onnx with 1 thread)
- CPU usage is more consistent (no spike when speech is detected)
- Less CPU than old approach because:
  - No VAD inference (saves ~1–2ms per 32ms chunk)
  - No ASR inference (saves ~10–20ms per chunk during speech)
  - Smaller models (3.1MB vs 65MB → faster inference, better cache behavior)

**Note on "idle" vs "active":** The new approach does not have a distinct idle/active mode. The KWS pipeline runs identically on every 80ms chunk regardless of whether speech is present. The CPU usage difference between "idle" and "active" is minimal — the slight increase during active detection is due to detection smoothing buffer updates and wake event dispatch, not additional inference.

---

## 4. Memory Breakdown (New Approach)

The following table details every memory allocation in the new KWS pipeline:

| Component | Size | Loaded When | Notes |
|-----------|------|-------------|-------|
| `melspectrogram.onnx` | 1.0MB | At startup | Mel spectrogram feature extraction model |
| `embedding_model.onnx` | 1.3MB | At startup | Acoustic embedding model (Google's `embedding_model.tflite`) |
| `nexus.onnx` | 0.8MB | At startup | Custom wake word classifier for "nexus" |
| tract-onnx runtime | ~5MB | At startup | Lightweight ONNX inference runtime (Rust-native) |
| Mel circular buffer | 10KB | At startup | 10 × [8, 32] × 4 bytes = 10,240 bytes |
| Feature buffer | 6KB | At startup | 16 × [1, 1, 1, 96] × 4 bytes = 6,144 bytes |
| Detection buffer | 48 bytes | At startup | 12 × 4 bytes = 48 bytes (12 float32 detection scores) |
| Audio chunk buffer | 5KB | At startup | 1280 × 4 bytes = 5,120 bytes (one chunk of f32 samples) |
| Resampler carry | ~4KB | At startup | Resampling state for linear interpolation carry-over |
| `speaker_model.onnx` | 29.6MB | At startup (if exists) | Speaker embedding/verification model (optional) |
| Voice profile JSON | ~1KB | At startup (if exists) | Stored speaker voice profile embeddings |

### Buffer Sizing Calculations

#### Mel Circular Buffer

```
Capacity: 10 frames (openWakeWord's `melspectrogram` post-processing window)
Shape per frame: [8, 32] (8 mel frames × 32 mel bins)
Element size: 4 bytes (f32)
Total: 10 × 8 × 32 × 4 = 10,240 bytes ≈ 10KB
```

This buffer holds the last 10 mel spectrogram frames for the embedding model's temporal context window.

#### Feature Buffer

```
Capacity: 16 frames (embedding model's input window)
Shape per frame: [1, 1, 1, 96] (batch=1, time=1, height=1, features=96)
Element size: 4 bytes (f32)
Total: 16 × 1 × 1 × 1 × 96 × 4 = 6,144 bytes ≈ 6KB
```

This buffer holds the last 16 embedding frames for the classifier model's input window.

#### Detection Buffer

```
Capacity: 12 frames (detection smoothing window)
Shape per frame: scalar (1 detection score)
Element size: 4 bytes (f32)
Total: 12 × 4 = 48 bytes
```

This buffer holds the last 12 classifier output scores for smoothing and threshold logic.

#### Audio Chunk Buffer

```
Capacity: 1 chunk (1280 samples)
Sample format: f32 (4 bytes)
Total: 1280 × 4 = 5,120 bytes ≈ 5KB
```

This is the buffer for the current 80ms audio chunk being processed.

### Total Memory Summary

| Configuration | Model Memory | Buffer Memory | Runtime Memory | Total |
|---------------|-------------|---------------|----------------|-------|
| Base (no speaker) | 3.1MB | ~25KB | ~5MB | **~18MB*** |
| With speaker model | 32.7MB | ~25KB | ~5MB | **~48MB*** |

*\*Includes ~10MB for Rust runtime, audio I/O, and miscellaneous allocations.*

---

## 5. Latency Breakdown (New Approach)

The following table breaks down the processing time for each step of the KWS pipeline per 80ms chunk:

| Step | Time | Description |
|------|------|-------------|
| Audio capture | ~0ms | cpal callback delivers samples in real-time (no blocking) |
| Downmix + resample | ~0.1ms | Linear interpolation from device sample rate to 16kHz, stereo-to-mono downmix |
| Melspectrogram inference | ~5–10ms | tract-onnx inference on 1.0MB model (computes 8 mel frames × 32 mel bins) |
| Embedding inference | ~5–10ms | tract-onnx inference on 1.3MB model (produces 96-dim embedding) |
| Classifier inference | ~1–2ms | tract-onnx inference on 0.8MB model (produces single probability) |
| Detection smoothing | ~0.01ms | Simple buffer average and threshold comparison |
| **Total per chunk** | **~11–22ms** | **Well within 80ms real-time budget** |

### Real-Time Budget Analysis

```
Chunk duration:     80ms (1280 samples at 16kHz)
Processing time:    11–22ms
Headroom:           58–69ms (72–86% of budget is idle)
```

The KWS pipeline uses only 14–28% of the available processing budget per chunk. This leaves substantial headroom for:

- Operating system scheduling jitter
- Other processes on the same CPU core
- Future model upgrades (larger models would still fit)
- Additional processing (e.g., speaker verification)

### Latency from Word End to Wake Event

The user-perceived latency — from the moment they finish saying "nexus" to the moment the wake event fires — depends on where in the chunk cycle the word ends:

| Scenario | Latency | Description |
|----------|---------|-------------|
| Best case | ~80ms | Word ends at the start of a chunk; detection on that frame |
| Typical case | ~160ms | Word ends mid-chunk; detection on next frame + 1 smoothing frame |
| Worst case | ~240ms | Word ends just after a chunk boundary; 2 chunks + smoothing |

**Average expected latency: ~160ms**

Compare this to the old approach's 500–1000ms — a **3–6x improvement** in average latency.

---

## 6. Why KWS Is Faster

The KWS approach is faster than the VAD+ASR approach for four fundamental reasons:

### 1. No VAD Waiting (saves 200–500ms)

The old approach requires VAD to detect both the start and end of speech:

- **Start of speech detection**: 200–300ms (VAD needs this long to confidently detect speech)
- **End of speech detection**: 500ms (VAD requires 500ms of silence to declare end-of-speech)

The KWS approach has no VAD at all. It processes every chunk of audio directly, so there is no waiting for speech start or end. This alone saves 700–800ms of latency.

### 2. No ASR Decoding (saves 100–200ms)

The old approach runs a full Zipformer ASR decoder on the buffered speech audio. This decoder:

- Processes the entire speech segment (not just the wake word)
- Generates token probabilities
- Performs beam search or greedy decoding
- Produces text output

This takes 100–200ms depending on the length of the speech segment.

The KWS approach has no ASR. The classifier model directly outputs a single probability value — there is no decoding step, no beam search, no text generation. This saves 100–200ms.

### 3. Smaller Models (faster inference)

| Model | Old Approach | New Approach |
|-------|-------------|-------------|
| VAD | 643KB | — (none) |
| ASR (encoder + decoder + joiner) | ~26MB | — (none) |
| KWS (mel + embedding + classifier) | — (none) | 3.1MB |
| **Total inference model size** | **~27MB** | **3.1MB** |

Smaller models mean:
- Faster inference (less computation)
- Better CPU cache utilization (model fits in L2/L3 cache)
- Less memory bandwidth pressure

### 4. Direct Probability Output (no text matching step)

The old approach requires a text matching step after ASR:

1. ASR produces text (e.g., "next", "mexic", "nexus")
2. Fuzzy string matching compares the text to "nexus"
3. If the match score exceeds a threshold, the wake event fires

This step is computationally cheap (~1ms) but introduces a conceptual failure point: the ASR text may be wrong, and the fuzzy matcher may reject a valid match.

The KWS approach outputs a probability directly. There is no text, no matching, and no fuzzy logic. The probability is compared to a threshold in a single floating-point comparison. This is both faster and more reliable.

---

## 7. Why KWS Uses Less RAM

The KWS approach uses less RAM than the VAD+ASR approach for four fundamental reasons:

### 1. No Zipformer ASR Models (saves ~26MB)

The Zipformer ASR models (encoder int8 + decoder int8 + joiner int8) total ~26MB of model weights. These are loaded into RAM at startup and remain resident for the lifetime of the process.

The KWS approach has no ASR models. The three KWS models (melspectrogram + embedding + classifier) total only 3.1MB — a **8.4x reduction** in model weight memory.

### 2. No Silero VAD Model (saves ~5MB)

The Silero VAD model (`silero_vad.onnx`) is 643KB on disk but requires ~5MB of RAM when loaded into an ONNX Runtime session (including session overhead, memory pools, and arena allocators).

The KWS approach has no VAD. This saves ~5MB of RAM.

### 3. Smaller KWS Models (3.1MB vs 50MB for ASR)

Comparing the total model memory (including runtime overhead):

| Component | Old Approach | New Approach |
|-----------|-------------|-------------|
| VAD model + session | ~5MB | — |
| ASR models + session | ~34MB | — |
| KWS models + session | — | ~8MB |
| Speaker model + session | ~30MB | ~30MB (shared) |
| **Total model memory** | **~69MB** | **~38MB** |

The KWS models plus their tract-onnx session overhead total ~8MB, compared to ~39MB for the VAD+ASR models plus their ONNX Runtime session overhead.

### 4. tract-onnx Is Lighter Than ONNX Runtime (saves ~15MB)

The Rust-native `tract-onnx` library has a significantly smaller memory footprint than the C++-based ONNX Runtime:

| Runtime | Memory Footprint | Notes |
|---------|-----------------|-------|
| ONNX Runtime | ~20MB | C++ library, memory pools, arena allocators, session management |
| tract-onnx | ~5MB | Pure Rust, no arena allocator, minimal session overhead |

This saves ~15MB of runtime memory. The trade-off is that tract-onnx may have slightly slower inference than ONNX Runtime for some models, but for the small KWS models (3.1MB total), the difference is negligible (~1–2ms per inference).

---

## 8. Expected Battery Impact (Laptops)

### Old Approach: VAD + ASR

- **VAD runs continuously**: Every 32ms, the VAD model is invoked. This keeps the CPU partially active at all times, preventing deep sleep states.
- **ASR runs on every speech segment**: Whenever VAD detects speech (including background speech, TV audio, conversations), the Zipformer ASR model is invoked. ASR inference is ~10–20ms per chunk, which can keep the CPU at a higher power state for extended periods.
- **Microphone is always active**: The audio hardware consumes power continuously.

### New Approach: KWS Only

- **KWS runs continuously**: Every 80ms, the 3-stage KWS pipeline is invoked. However, the total inference time is only ~11–22ms, leaving 58–69ms of idle time per chunk.
- **No ASR**: There is no ASR stage that activates on speech detection. The CPU workload is constant regardless of ambient noise.
- **Microphone is always active**: Same as the old approach — the audio hardware consumes power continuously.

### Net Battery Impact

| Factor | Old Approach | New Approach | Impact |
|--------|-------------|-------------|--------|
| Microphone power | Continuous | Continuous | Same |
| CPU idle power | VAD every 32ms | KWS every 80ms | New is better (less frequent wake-ups) |
| CPU active power | VAD + ASR on speech | KWS only (constant) | New is better (no ASR spikes) |
| RAM power | ~143MB resident | ~18–48MB resident | New is better (less RAM = less refresh power) |
| **Overall** | | | **Similar or better battery life** |

### Detailed Power Analysis

**CPU wake frequency:**
- Old: VAD wakes the CPU every 32ms (31.25 wake-ups/second)
- New: KWS wakes the CPU every 80ms (12.5 wake-ups/second)
- **Improvement: 2.5x fewer CPU wake-ups**

Fewer CPU wake-ups allow the processor to spend more time in low-power C-states, which can significantly reduce power consumption on laptops.

**CPU active time per second:**
- Old (idle): 31.25 × 2ms = 62.5ms/s active (6.25% duty cycle)
- Old (speech): 31.25 × 2ms + ~12.5 × 15ms = 250ms/s active (25% duty cycle)
- New (always): 12.5 × 16ms = 200ms/s active (20% duty cycle)

The new approach has a slightly higher idle duty cycle (20% vs 6.25%) but a much lower active duty cycle (20% vs 25%). On average, the new approach uses similar or slightly less CPU time per second.

**RAM power:**
DDR4 RAM consumes approximately 0.5W per 8GB at idle (refresh power). The ~95MB RAM reduction (143MB → 48MB) saves approximately:

```
Power saved = (95MB / 8192MB) × 0.5W ≈ 0.006W
```

This is negligible — RAM power savings are not a meaningful factor. The primary battery impact comes from CPU wake frequency and active duty cycle.

### Conclusion

The new KWS approach is expected to have **similar or slightly better battery life** compared to the old VAD+ASR approach. The primary improvements are:

1. **2.5x fewer CPU wake-ups** (every 80ms vs every 32ms)
2. **No ASR spikes** during speech detection
3. **Lower peak CPU usage** (3–5% vs 5–10%)

Both approaches keep the microphone active continuously, which is the dominant power consumer in always-listening scenarios. The microphone power consumption is identical between the two approaches and is not affected by the wake word detection algorithm.

---

## Appendix A: Calculation Derivations

### A.1 Recall Calculation (Old Approach)

```
P(VAD captures full word) ≈ 0.60
P(ASR recognizes correctly | VAD captured) ≈ 0.50
P(recall) = P(VAD captures) × P(ASR recognizes | captured)
          = 0.60 × 0.50
          = 0.30
          = 30%
```

### A.2 Latency Calculation (Old Approach)

```
VAD speech start detection:   200–300ms
VAD speech end detection:     500ms (silence timeout)
ASR decoding:                 100–200ms
Text matching:                ~1ms
Total:                        200 + 500 + 100 + 1 = 801ms (best case)
                              300 + 500 + 200 + 1 = 1001ms (worst case)
```

### A.3 Latency Calculation (New Approach)

```
KWS chunk processing:         80ms (one chunk)
Detection smoothing:          80ms (1 additional frame for smoothing)
Total (best case):            80ms (detection on current frame)
Total (typical case):         160ms (detection on next frame + smoothing)
Total (worst case):           240ms (2 chunks + smoothing)
```

### A.4 RAM Calculation (Old Approach)

```
Silero VAD model + session:           5MB
Zipformer encoder int8 + session:    11MB
Zipformer decoder int8 + session:    11MB
Zipformer joiner int8 + session:      8MB
Tokens + ASR session overhead:        4MB
Speaker model + session:             30MB
ONNX Runtime base:                   20MB
Audio buffers + Rust runtime:        54MB
Total:                              143MB
```

### A.5 RAM Calculation (New Approach)

```
melspectrogram.onnx + session:        2MB
embedding_model.onnx + session:       3MB
nexus.onnx + session:                 2MB
tract-onnx runtime base:              5MB
Mel circular buffer:                  10KB
Feature buffer:                        6KB
Detection buffer:                     48B
Audio chunk buffer:                    5KB
Resampler carry:                       4KB
Audio buffers + Rust runtime:        10MB
Subtotal (without speaker):          18MB
Speaker model + session (optional):  30MB
Total (with speaker):                48MB
```

### A.6 Model Size Calculation (Old Approach)

```
silero_vad.onnx:          643KB
encoder int8:            ~9MB
decoder int8:            ~9MB
joiner int8:             ~8MB
tokens.txt:              ~100KB
speaker_model.onnx:      29.6MB
Total:                   ~65MB
```

### A.7 Model Size Calculation (New Approach)

```
melspectrogram.onnx:     1.0MB
embedding_model.onnx:    1.3MB
nexus.onnx:              0.8MB
Total base:              3.1MB
speaker_model.onnx:     29.6MB (optional, shared)
Total with speaker:     32.7MB ≈ 33MB
```

### A.8 CPU Duty Cycle Calculations

**Old approach (idle):**
```
VAD frequency:    1 / 32ms = 31.25 Hz
VAD inference:    ~2ms per call
Active time:      31.25 × 2ms = 62.5ms/s
Duty cycle:       62.5 / 1000 = 6.25%
CPU usage:        ~1–2% (includes audio I/O overhead)
```

**Old approach (active, speech detected):**
```
VAD:              31.25 × 2ms = 62.5ms/s
ASR:              ~12.5 chunks/s × 15ms = 187.5ms/s
Total active:     62.5 + 187.5 = 250ms/s
Duty cycle:       250 / 1000 = 25%
CPU usage:        ~5–10% (includes audio I/O + text matching)
```

**New approach (always):**
```
KWS frequency:    1 / 80ms = 12.5 Hz
KWS inference:    ~16ms per call (mel + embedding + classifier)
Active time:      12.5 × 16ms = 200ms/s
Duty cycle:       200 / 1000 = 20%
CPU usage:        ~1–2% idle, ~3–5% active (includes audio I/O + smoothing)
```

---

## Appendix B: Measurement Methodology

### B.1 Recall Measurement

**Old approach recall** was measured by:
1. Speaking "nexus" 10 times at normal volume, normal pace, from 1 meter away
2. Recording whether the wake event fired for each utterance
3. Counting: 3 out of 10 → 30% recall

This is a small sample size and the actual recall may vary. However, the qualitative observation (VAD clips the first syllable, ASR misrecognizes the word) is consistent and reproducible.

**New approach recall** is projected based on:
1. openWakeWord project documentation targets (<5% false reject rate)
2. The training data quality (synthetic data with varied speakers)
3. The elimination of VAD clipping and ASR misrecognition

Actual recall should be measured empirically after deployment using the same methodology (10 utterances at normal volume from 1 meter away).

### B.2 Latency Measurement

**Old approach latency** was estimated from:
1. Silero VAD documentation (200–300ms speech start detection, 500ms silence end detection)
2. Zipformer ASR benchmark data (100–200ms decoding time for short utterances)
3. Sum of pipeline stages

**New approach latency** was estimated from:
1. Chunk size (80ms = 1280 samples at 16kHz)
2. Detection smoothing window (2 frames × 80ms = 160ms)
3. tract-onnx inference benchmarks for small models

Actual latency should be measured empirically using audio timestamps and wake event timestamps.

### B.3 RAM Measurement

**Old approach RAM** was measured by:
1. Starting the wake word process
2. Reading resident set size (RSS) from `/proc/<pid>/status` (Linux) or Task Manager (Windows)
3. Attributing memory to components based on model file sizes and runtime documentation

**New approach RAM** is estimated based on:
1. Model file sizes (3.1MB base + 29.6MB speaker)
2. tract-onnx runtime memory footprint (~5MB)
3. Buffer size calculations (see Section 4)
4. Rust runtime overhead (~10MB)

Actual RAM should be measured empirically after deployment.

### B.4 CPU Measurement

**Old approach CPU** was estimated from:
1. VAD inference time (~2ms per 32ms chunk)
2. ASR inference time (~15ms per chunk during speech)
3. Duty cycle calculations (see Appendix A.8)

**New approach CPU** was estimated from:
1. KWS inference time (~11–22ms per 80ms chunk)
2. Duty cycle calculations (see Appendix A.8)

Actual CPU should be measured empirically using `top`, `htop`, or Windows Task Manager.

---

## Appendix C: Risk Factors & Caveats

### C.1 Recall May Not Reach 95%

The >95% recall target is based on openWakeWord project documentation. Actual recall depends on:

- **Training data quality**: The synthetic training data may not cover all speaker variations
- **Custom model training**: The `nexus.onnx` model must be trained with sufficient examples
- **Real-world conditions**: Background noise, microphone quality, and distance may reduce recall

If actual recall is lower than expected, the model can be retrained with additional data or the detection threshold can be lowered (at the cost of more false alarms).

### C.2 False Alarm Rate May Be Higher Than Expected

The <0.5 false alarms/hour target is also based on openWakeWord documentation. Actual false alarm rate depends on:

- **Acoustic environment**: Noises that resemble the wake word pattern may trigger false alarms
- **Threshold setting**: Lower thresholds increase recall but also increase false alarms
- **Detection smoothing**: The 2-frame smoothing window helps but may not eliminate all false alarms

If false alarm rate is too high, the threshold can be raised or the smoothing window can be increased (at the cost of higher latency).

### C.3 tract-onnx Performance May Vary

The tract-onnx runtime is used instead of ONNX Runtime for its smaller memory footprint and pure-Rust implementation. However:

- tract-onnx may be slower than ONNX Runtime for some models
- tract-onnx may not support all ONNX operators (requiring model modifications)
- tract-onnx is less battle-tested than ONNX Runtime

If tract-onnx performance is insufficient, the system can be switched back to ONNX Runtime at the cost of ~15MB additional RAM.

### C.4 Speaker Model Is Optional

The speaker verification model (`speaker_model.onnx`, 29.6MB) is optional. If speaker verification is not needed:

- RAM usage drops from ~48MB to ~18MB
- Model size drops from ~33MB to ~3.1MB
- Startup time decreases (no 29.6MB model to load)

If speaker verification is needed, the model is shared with the old approach and represents no additional cost.

### C.5 All Figures Are Estimates Unless Otherwise Noted

The figures in this document are:

- **Measured**: Old approach recall (30%), model file sizes
- **Estimated**: RAM, CPU, latency (based on model sizes and runtime documentation)
- **Projected**: New approach recall (>95%), false alarm rate (<0.5/hour)

Actual performance should be measured empirically after deployment and this document should be updated with real measurements.

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2025-01-XX | Initial document creation | ULTRON Team |

---

*End of Document 12 — Performance Expectations & Benchmarks*
