# New Approach: openWakeWord KWS

> Detailed explanation of the new openWakeWord Keyword Spotting (KWS) pipeline.
> This replaces the old VAD+ASR approach as the default wake word engine.

---

## 1. Overview

The new wake word detection uses **openWakeWord** — a continuous keyword spotting (KWS) engine that scores every audio frame for the target word "NEXUS" without using VAD or ASR.

```
cpal microphone
  → resampling to 16kHz mono
  → 1280-sample / 80ms streaming chunks
  → melspectrogram model (audio → mel features)
  → embedding model (mel features → 96-dim embeddings)
  → custom NEXUS classifier (embeddings → probability)
  → rolling score buffer and threshold logic
  → speaker verification (optional, second stage)
  → wake event
```

**Key differences from the old approach:**
- **No VAD** — doesn't clip the start of words
- **No ASR** — doesn't need to transcribe, directly detects the acoustic pattern
- **Continuous scoring** — runs on every 80ms chunk, not just when VAD detects speech
- **Expected recall: >95%** (vs ~30% with VAD+ASR)

---

## 2. Why KWS Instead of VAD+ASR

| Problem with VAD+ASR | How KWS Solves It |
|----------------------|-------------------|
| VAD clips start of words (200-300ms lost) | No VAD — full word always available |
| VAD splits words at syllable pauses | No segmentation — words stay intact |
| ASR misrecognizes "nexus" as "mexic", "next", etc. | Direct acoustic pattern detection — no transcription |
| High latency (500-1000ms) | Low latency (~80-160ms) |
| High RAM (~143MB) | Low RAM (~30-50MB) |

See `03-vad-asr-old-approach.md` for detailed analysis of the old approach's problems.

---

## 3. Architecture

### 3.1 Three-Stage Model Pipeline

The KWS engine uses three ONNX models in sequence:

```
1280 samples (80ms of 16kHz mono audio)
    │
    ▼
┌─────────────────────┐
│ melspectrogram.onnx │  (1.0MB)
│ Audio → Mel features │
└─────────┬───────────┘
          │  [8, 32] mel frames per chunk
          ▼
┌─────────────────────┐
│ embedding_model.onnx│  (1.3MB)
│ Mel → 96-dim embed  │
└─────────┬───────────┘
          │  [1, 1, 1, 96] embedding per chunk
          ▼
┌─────────────────────┐
│ nexus.onnx          │  (~0.8MB, custom-trained)
│ Embedding → prob    │
└─────────┬───────────┘
          │  probability (0.0 to 1.0)
          ▼
    Score smoothing + threshold
```

### 3.2 Streaming State

The engine maintains streaming state across chunks:

| Buffer | Size | Purpose |
|--------|------|---------|
| `raw_lookback` | 480 samples | Last 3 mel hops from previous chunk (for context) |
| `mel_spectrogram_buffer` | 10 frames × [8, 32] | Rolling mel history (800ms lookback) |
| `feature_buffer` | 16 frames × [1, 1, 1, 96] | Rolling embedding history (1.28s lookback) |
| `detections_buffer` | 12 floats | Rolling probability scores (~1s smoothing window) |
| `chunk_buffer` | 1280 samples | Accumulates audio until a full chunk is ready |

### 3.3 Detection Logic

For each 80ms chunk:

1. **Feature extraction**: melspectrogram → embedding
2. **Classification**: classifier outputs a probability (0.0 to 1.0)
3. **Smoothing**: probability is pushed to `detections_buffer` (12-frame window)
4. **Threshold check**: calculate average of positive detections
5. **Minimum positive count**: require at least 2 positive detections (`MIN_POSITIVE_DETECTIONS`)
6. **Refractory period**: if detected, wait 2000ms before next detection (`NO_DETECTION_MS`)
7. **Speaker verification**: if detected and speaker profile exists, verify speaker (TODO: audio ring buffer)

### 3.4 Detection Threshold

```rust
pub threshold: f32 = 0.5;
```

- Default: 0.5
- Lower (0.3-0.4): more sensitive, more false alarms
- Higher (0.6-0.7): less sensitive, fewer false alarms
- Tuning: start at 0.5, lower if recall <90%, raise if false alarms >1/hour

---

## 4. Constants and Parameters

```rust
/// OWW processes 1280-sample chunks (80ms at 16kHz)
pub const OWW_CHUNK_SIZE: usize = 1280;

/// Melspectrogram lookback: 3 mel hops of 160 samples
const MEL_LOOKBACK: usize = 160 * 3;          // 480

/// Mel model input: lookback + one chunk
const MEL_INPUT_SIZE: usize = MEL_LOOKBACK + OWW_CHUNK_SIZE;  // 1760

/// Mel frames produced per chunk
const MELS_PER_CHUNK: usize = MEL_INPUT_SIZE / 160 - 3;       // 8

/// Mel circular buffer size (80 / MELS_PER_CHUNK)
const MEL_CIRC_SIZE: usize = 80 / MELS_PER_CHUNK;             // 10

/// Feature buffer: 16 frames of 96-dim embeddings
const FEATURE_BUFFER_SIZE: usize = 16;

/// Detection buffer: 12 frames (~1 sec) for smoothing
const DETECTION_BUFFER_SIZE: usize = 12;

/// Minimum positive detections before triggering
const MIN_POSITIVE_DETECTIONS: f32 = 2.0;

/// Refractory period after a detection (ms)
const NO_DETECTION_MS: u64 = 2000;
```

---

## 5. Processing Flow (Step by Step)

### Step 1: Audio Capture

```
cpal callback fires (every ~10ms)
  → receives N samples in native format (F32/I16/I32)
  → downmixes to mono (average all channels)
  → resamples to 16kHz (linear interpolation)
  → accumulates in chunk_buffer
```

### Step 2: Chunk Formation

```
When chunk_buffer >= 1280 samples:
  → extract 1280 samples
  → pass to detect_chunk()
```

### Step 3: Melspectrogram Extraction

```
1. Prepend 480 samples of lookback from previous chunk
   → total input: 1760 samples
2. Run melspectrogram model
   → output: [8, 32] mel frames
3. Normalize: (v / 10.0) + 2.0
4. Save last 480 samples as lookback for next chunk
5. Push mel frames to mel_spectrogram_buffer (rolling 10 frames)
```

### Step 4: Embedding Extraction

```
1. Stack 10 mel frames from buffer
   → [80, 32] stacked mel
2. Slice [4:80] → [76, 32]
3. Reshape to [1, 76, 32, 1]
4. Run embedding model
   → output: [1, 1, 1, 96] embedding
5. Push embedding to feature_buffer (rolling 16 frames)
6. Stack 16 embeddings
   → [16, 96] feature matrix
```

### Step 5: Classification

```
1. Reshape features to [1, 16, 96]
2. Run nexus.onnx classifier
   → output: probability (0.0 to 1.0)
3. Push probability to detections_buffer (rolling 12 frames)
```

### Step 6: Detection Decision

```
1. Calculate average of positive detections in buffer:
   - Count frames where probability > threshold
   - If count < MIN_POSITIVE_DETECTIONS (2): return 0.0
   - Average = sum of positive probabilities / count
   - If average > threshold: return average, else return 0.0
2. Check refractory period:
   - If last detection was < 2000ms ago: do not trigger
3. If average > threshold AND refractory passed:
   → trigger wake event
   → clear detections_buffer
   → update last_detection_time
```

### Step 7: Speaker Verification

```
If KWS triggers:
  → if speaker verifier exists AND has profile:
      → TODO: verify speaker from audio ring buffer
      → currently: accept (KWS is accurate enough)
  → if speaker verifier exists but no profile (open mode):
      → accept (anyone can wake)
  → if no speaker verifier:
      → accept
If accepted:
  → send wake event to frontend
```

---

## 6. Wake Event Dispatch

When a wake is detected and accepted:

```rust
// Send wake signal via channel
let _ = wake_tx.send(());

// In the run() async loop:
while rx.recv().await.is_some() {
    tracing::info!("wake-word: NEXUS detected → triggering wake");
    
    // Show and focus the main window
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.set_always_on_top(true);
        let _ = win.set_ignore_cursor_events(false);
        // Trigger frontend wake handler
        let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
    }
}
```

The frontend `window.__NEXUS_WAKE__()` handler:
1. Shows the overlay/avatar
2. Plays the "On it, sir" acknowledgement via local TTS
3. Starts recording for command STT
4. Sends transcript to backend via WebSocket
5. Receives result and speaks it via local TTS

---

## 7. Feature Flags

```toml
[features]
default = ["wakeword-oww"]
wakeword-porcupine = []   # legacy
wakeword-sherpa = []      # old VAD+ASR (fallback)
wakeword-oww = []         # new KWS (default)
mock-wake = []            # CI only (no audio capture)
```

- `wakeword-oww` (default): Uses the openWakeWord KWS engine
- `wakeword-sherpa`: Falls back to old VAD+ASR engine
- `mock-wake`: No audio capture, only hotkey works (for CI)

---

## 8. Files

| File | Role |
|------|------|
| `src-tauri/src/wakeword_oww.rs` | KWS engine implementation |
| `src-tauri/src/lib.rs` | Module wiring (feature flag selection) |
| `src-tauri/resources/oww/melspectrogram.onnx` | Mel spectrogram model (1.0MB) |
| `src-tauri/resources/oww/embedding_model.onnx` | Speech embedding model (1.3MB) |
| `src-tauri/resources/oww/nexus.onnx` | Custom NEXUS classifier (~0.8MB, trained via Colab) |
| `src-tauri/resources/oww/speaker_model.onnx` | Speaker embedding model (optional, 29.6MB) |
| `src-tauri/Cargo.toml` | Dependencies and feature flags |
