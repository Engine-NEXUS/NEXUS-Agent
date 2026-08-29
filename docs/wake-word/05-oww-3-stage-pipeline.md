# openWakeWord 3-Stage Model Pipeline

> Detailed explanation of the three-stage ONNX model pipeline:
> melspectrogram → embedding → classifier

---

## 1. Overview

The openWakeWord KWS engine processes audio through three sequential ONNX models. Each model transforms the audio data into a progressively more abstract representation, culminating in a single probability score for the wake word "NEXUS".

```
Audio (1280 samples, 80ms)
    │
    ▼ Stage 1: Feature Extraction
┌─────────────────────────┐
│ melspectrogram.onnx     │  Audio → Mel spectrogram
│ Input:  [1, 1760]       │  (1760 = 480 lookback + 1280 chunk)
│ Output: [8, 32]         │  (8 mel frames × 32 mel bins)
└──────────┬──────────────┘
           │
           ▼ Stage 2: Embedding
┌─────────────────────────┐
│ embedding_model.onnx    │  Mel → Speech embedding
│ Input:  [1, 76, 32, 1]  │  (76 mel frames from 10-chunk history)
│ Output: [1, 1, 1, 96]   │  (96-dimensional embedding)
└──────────┬──────────────┘
           │
           ▼ Stage 3: Classification
┌─────────────────────────┐
│ nexus.onnx              │  Embedding → Probability
│ Input:  [1, 16, 96]     │  (16 embeddings from history)
│ Output: [1, 1]          │  (probability 0.0 to 1.0)
└──────────┬──────────────┘
           │
           ▼
     Probability score
```

---

## 2. Stage 1: Melspectrogram Model

### 2.1 Purpose

Convert raw audio samples into a mel spectrogram — a time-frequency representation that captures the spectral content of audio in a way that approximates human hearing.

### 2.2 Model

- **File:** `melspectrogram.onnx` (1.0MB)
- **Source:** openWakeWord v0.6.0 pre-trained model
- **Runtime:** tract-onnx (pure Rust ONNX inference)

### 2.3 Input

```rust
const MEL_LOOKBACK: usize = 160 * 3;           // 480 samples
const OWW_CHUNK_SIZE: usize = 1280;             // 80ms chunk
const MEL_INPUT_SIZE: usize = MEL_LOOKBACK + OWW_CHUNK_SIZE;  // 1760 samples
```

- **Shape:** `[1, 1760]`
- **Content:** 480 samples of lookback from previous chunk + 1280 samples of current chunk
- **Lookback purpose:** Provides context from the previous chunk so mel frames at the start of the current chunk have full context

### 2.4 Output

```rust
const MELS_PER_CHUNK: usize = MEL_INPUT_SIZE / 160 - 3;  // 8
```

- **Shape:** `[8, 32]`
- **Content:** 8 mel frames, each with 32 mel bins
- **Hop size:** 160 samples (10ms at 16kHz)
- **Window size:** 400 samples (25ms at 16kHz)

### 2.5 Normalization

After inference, the mel values are normalized:

```rust
let updated = a.mapv(|v| (v / 10.0) + 2.0).into_tensor();
```

- Formula: `normalized = (raw / 10.0) + 2.0`
- Purpose: Scale the mel values to a range suitable for the embedding model
- This matches the normalization used in openWakeWord's Python implementation

### 2.6 Lookback Management

```rust
self.raw_lookback.copy_from_slice(&data[data.len() - MEL_LOOKBACK..]);
```

After each chunk, the last 480 samples are saved as lookback for the next chunk. This ensures continuity across chunk boundaries.

### 2.7 Mel Circular Buffer

```rust
const MEL_CIRC_SIZE: usize = 80 / MELS_PER_CHUNK;  // 10
```

- **Size:** 10 frames of [8, 32]
- **Purpose:** Rolling history of mel spectrograms (10 chunks × 80ms = 800ms lookback)
- **Implementation:** `CircularBuffer<10, Tensor>`
- Each chunk pushes 8 new mel frames, and the oldest 8 are discarded

---

## 3. Stage 2: Embedding Model

### 3.1 Purpose

Convert mel spectrogram frames into a fixed-length speech embedding — a compact representation that captures the phonetic content of the audio.

### 3.2 Model

- **File:** `embedding_model.onnx` (1.3MB)
- **Source:** openWakeWord v0.6.0 pre-trained model
- **Runtime:** tract-onnx

### 3.3 Input

```rust
// Stack 10 mel frames from circular buffer
let stacked_mels = Tensor::stack_tensors(0, &self.mel_spectrogram_buffer.to_vec())?;
// → [80, 32]

// Slice [4:80] → [76, 32]
let smaller = stacked_mels.slice(0, 4, 80)?;
// → [76, 32]

// Reshape for model input
let reshaped = smaller.into_shape(&[1, 76, 32, 1])?;
// → [1, 76, 32, 1]
```

- **Shape:** `[1, 76, 32, 1]`
- **Content:** 76 mel frames (from 10-chunk history, first 4 discarded) × 32 mel bins × 1 channel
- **Why slice [4:80]?** The first 4 mel frames are from the oldest chunk and may not contain relevant context for the current embedding

### 3.4 Output

- **Shape:** `[1, 1, 1, 96]`
- **Content:** 96-dimensional speech embedding
- **Purpose:** Compact representation of the phonetic content in the audio

### 3.5 Feature Buffer

```rust
const FEATURE_BUFFER_SIZE: usize = 16;
```

- **Size:** 16 frames of [1, 1, 1, 96]
- **Purpose:** Rolling history of embeddings (16 chunks × 80ms = 1.28s lookback)
- **Implementation:** `CircularBuffer<16, Tensor>`
- Each chunk pushes 1 new embedding, and the oldest is discarded

### 3.6 Final Feature Matrix

```rust
// Stack 16 embeddings
let stacked = Tensor::stack_tensors(0, &self.feature_buffer.to_vec())?;
// → [16, 1, 1, 96]

// Reshape for classifier
let reshaped = stacked.into_shape(&[self.feature_buffer.len(), 96])?;
// → [16, 96]
```

The final feature matrix `[16, 96]` represents 1.28 seconds of audio history, which is the input to the classifier.

---

## 4. Stage 3: NEXUS Classifier

### 4.1 Purpose

Classify the speech embeddings as either containing the wake word "NEXUS" or not. Output a single probability score.

### 4.2 Model

- **File:** `nexus.onnx` (~0.8MB)
- **Source:** Custom-trained using `train_nexus_oww.ipynb` (Google Colab)
- **Runtime:** tract-onnx
- **Architecture:** Small DNN (32-layer) trained on frozen embedding model outputs

### 4.3 Input

```rust
// Reshape features for classifier
let last = features.into_shape(&[1, FEATURE_BUFFER_SIZE, 96])?;
// → [1, 16, 96]
```

- **Shape:** `[1, 16, 96]`
- **Content:** 16 frames of 96-dimensional embeddings (1.28s of audio history)

### 4.4 Output

- **Shape:** `[1, 1]`
- **Content:** Probability score (0.0 to 1.0)
- **Interpretation:**
  - 0.0 = definitely not "NEXUS"
  - 1.0 = definitely "NEXUS"
  - 0.5 = threshold (default)

### 4.5 Training

The classifier is trained on:
- **Positive samples:** Synthetic TTS audio of "nexus" (varied speakers, accents, speeds)
- **Negative samples:** Adversarial words that sound similar + general speech + background noise
- **Frozen embedding model:** The embedding model is not retrained — only the classifier is trained on top of its outputs

See `06-model-training.md` for detailed training documentation.

---

## 5. Streaming State Summary

| State | Size | Lookback | Purpose |
|-------|------|----------|---------|
| `raw_lookback` | 480 samples | 30ms | Context for mel spectrogram at chunk start |
| `mel_spectrogram_buffer` | 10 × [8, 32] | 800ms | Rolling mel history for embedding input |
| `feature_buffer` | 16 × [1, 1, 1, 96] | 1.28s | Rolling embedding history for classifier input |
| `detections_buffer` | 12 × f32 | ~1s | Rolling probability scores for smoothing |

---

## 6. Data Flow Diagram (Detailed)

```
Chunk N (1280 samples)
    │
    ├── raw_lookback (480 samples from chunk N-1)
    │
    ▼
[1760 samples] → melspectrogram.onnx → [8, 32] mel frames
    │                                          │
    │                                          ├── push to mel_spectrogram_buffer
    │                                          │   (rolling 10 frames)
    │                                          │
    │                                          ▼
    │                               [80, 32] stacked mels
    │                                          │
    │                                          ├── slice [4:80] → [76, 32]
    │                                          ├── reshape → [1, 76, 32, 1]
    │                                          │
    │                                          ▼
    │                               embedding_model.onnx → [1, 1, 1, 96]
    │                                          │
    │                                          ├── push to feature_buffer
    │                                          │   (rolling 16 frames)
    │                                          │
    │                                          ▼
    │                               [16, 96] stacked embeddings
    │                                          │
    │                                          ├── reshape → [1, 16, 96]
    │                                          │
    │                                          ▼
    │                               nexus.onnx → probability (0.0-1.0)
    │                                          │
    │                                          ├── push to detections_buffer
    │                                          │   (rolling 12 frames)
    │                                          │
    │                                          ▼
    │                               Smoothed average → threshold check
    │                                          │
    │                                          ├── if > 0.5 AND ≥2 positive frames:
    │                                          │   → WAKE EVENT
    │                                          │
    └── save last 480 samples as raw_lookback for chunk N+1
```

---

## 7. Why Three Stages?

### 7.1 Why Not End-to-End (Audio → Probability)?

| Approach | Pros | Cons |
|----------|------|------|
| End-to-end | Simpler (one model) | Requires massive training data, large model, hard to train |
| Three-stage | Smaller classifier, leverages pre-trained models, easier to train | Three inference steps per chunk |

The three-stage approach is used because:
1. **melspectrogram and embedding models are pre-trained** — we don't need to train them
2. **Only the classifier needs training** — much smaller and easier to train
3. **Transfer learning** — the embedding model already knows how to extract speech features
4. **Smaller training dataset** — the classifier only needs to learn "nexus" vs "not nexus" on top of pre-trained features

### 7.2 Model Sizes

| Model | Size | Trainable? |
|-------|------|------------|
| melspectrogram.onnx | 1.0MB | No (pre-trained, frozen) |
| embedding_model.onnx | 1.3MB | No (pre-trained, frozen) |
| nexus.onnx | ~0.8MB | **Yes** (custom-trained) |
| **Total** | ~3.1MB | |

---

## 8. Inference Performance

| Stage | Model Size | Estimated Time | Notes |
|-------|-----------|---------------|-------|
| Melspectrogram | 1.0MB | ~5-10ms | Simple FFT-based operations |
| Embedding | 1.3MB | ~5-10ms | Small DNN |
| Classifier | 0.8MB | ~1-2ms | Very small DNN |
| **Total** | ~3.1MB | ~11-22ms | Well within 80ms budget |

The 80ms chunk interval gives us 80ms to process each chunk. With 11-22ms total inference time, we use only 14-28% of the budget — plenty of headroom.

---

## 9. Implementation Reference

The three-stage pipeline is implemented in `src-tauri/src/wakeword_oww.rs`:

- `AudioFeatures::new()` — loads melspectrogram and embedding models, initializes buffers
- `AudioFeatures::get_melspectrogram()` — Stage 1: audio → mel spectrogram
- `AudioFeatures::get_audio_features()` — Stage 2: mel → embedding (calls get_melspectrogram internally)
- `WakeEngine::detect_chunk()` — Stage 3: embedding → probability + detection logic
- `WakeEngine::process()` — orchestrates chunk buffering and calls detect_chunk
