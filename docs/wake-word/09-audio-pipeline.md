# Audio Pipeline

> How NEXUS captures microphone audio, downmixes to mono, resamples to 16kHz, and feeds fixed-size chunks to the KWS engine.

---

## 1. Overview

The audio pipeline is the foundation of wake word detection. It captures microphone audio via `cpal`, converts it to the format required by the KWS engine (16kHz mono f32), and feeds it in fixed-size chunks.

```
cpal callback (native SR, native channels, native format)
    │
    ▼
1. Downmix to mono f32
   (average channels, convert sample format)
    │
    ▼
2. Append to resampler carry buffer
    │
    ▼
3. Linear resample to 16kHz
   (fractional cursor, linear interpolation)
    │
    ▼
4. Accumulate in output buffer
    │
    ▼
5. While buffer >= chunk_size:
   Extract chunk → feed to engine
```

This pipeline is shared between the old VAD+ASR and new KWS approaches — only the chunk size differs:
- Old (VAD+ASR): 512 samples (32ms at 16kHz) for Silero VAD
- New (KWS): 1280 samples (80ms at 16kHz) for openWakeWord

---

## 2. Audio Capture (cpal)

### 2.1 Library

- **Library:** cpal 0.15
- **Host:** Default host (platform-dependent)
- **Device:** Default input device

### 2.2 Platform Hosts

| Platform | Host | Typical SR | Typical Channels | Typical Format |
|----------|------|-----------|-----------------|----------------|
| Windows | WASAPI | 48kHz | 2 (stereo) | F32 or I16 |
| macOS | CoreAudio | 44.1kHz or 48kHz | 1-2 | F32 |
| Linux | ALSA/PulseAudio | 44.1kHz or 48kHz | 1-2 | F32 or I16 |

### 2.3 Stream Configuration

```rust
let stream_config = cpal::StreamConfig {
    channels: default_config.channels(),
    sample_rate: default_config.sample_rate(),
    buffer_size: cpal::BufferSize::Default,
};
```

- **Sample rate:** Device native (typically 48kHz)
- **Channels:** Device native (typically 2 = stereo)
- **Sample format:** Device native (F32, I16, or I32)
- **Buffer size:** Default (let cpal choose)

### 2.4 Stream Lifecycle

```rust
let stream = build_result.map_err(|e| format!("build stream: {e}"))?;
stream.play().map_err(|e| format!("play stream: {e}"))?;
std::mem::forget(stream);  // Keep stream alive for app lifetime
```

- Stream is built for the specific sample format (I16, I32, or F32)
- Stream is started with `stream.play()`
- `std::mem::forget(stream)` prevents the stream from being dropped
- The stream runs for the entire application lifetime

---

## 3. Downmixing to Mono

### 3.1 Algorithm

For each frame (one sample per channel), average all channels:

```rust
let ch = native_channels.max(1);
let frames = data.len() / ch;
for i in 0..frames {
    let mut sum = 0.0f32;
    for c in 0..ch {
        sum += to_f32(data[i * ch + c]);
    }
    st.carry.push(sum / ch as f32);
}
```

- **Formula:** `sample_mono = (sample_ch0 + sample_ch1 + ... + sample_chN) / num_channels`
- **Handles any number of channels:** 1 (mono), 2 (stereo), 4 (quad), etc.
- **Sample conversion:** Uses the `to_f32` closure (format-dependent)

### 3.2 Sample Format Conversion

The callback handles three sample formats via a generic closure:

| Format | Conversion | Closure |
|--------|------------|---------|
| I16 | `s.to_sample::<f32>()` | `|s: i16| s.to_sample::<f32>()` |
| I32 | `s.to_sample::<f32>()` | `|s: i32| s.to_sample::<f32>()` |
| F32 | No conversion | `|s: f32| s` |

The `to_sample` trait from cpal handles the conversion:
- I16: `f32_sample = i16_sample as f32 / 32768.0`
- I32: `f32_sample = i32_sample as f32 / 2147483648.0`
- F32: no conversion needed

---

## 4. Resampling

### 4.1 ResampleState

```rust
pub struct ResampleState {
    pub ratio: f64,    // native_sr / target_sr
    pub frac: f64,     // fractional read cursor
    pub carry: Vec<f32>, // buffer of native mono samples
}
```

- **ratio:** `native_sr / target_sr` (e.g., 48000/16000 = 3.0)
- **frac:** Fractional read cursor (tracks position in carry buffer)
- **carry:** Buffer of native-rate mono samples awaiting resampling

### 4.2 Resampling Algorithm

```rust
let mut pos = st.frac;
while pos + ratio < st.carry.len() as f64 {
    let idx0 = pos.floor() as usize;
    let idx1 = (idx0 + 1).min(st.carry.len() - 1);
    let t = pos - idx0 as f64;
    let s = st.carry[idx0] as f64 * (1.0 - t) + st.carry[idx1] as f64 * t;
    produced.push(s as f32);
    pos += ratio;
}
let consumed = pos.floor() as usize;
st.carry.drain(0..consumed);
st.frac = pos - consumed as f64;
```

**Step-by-step:**
1. Append native mono samples to carry buffer
2. While enough samples in carry:
   a. Get position `pos` (integer part = `idx0`, fractional = `t`)
   b. Linear interpolation: `s = carry[idx0] * (1-t) + carry[idx1] * t`
   c. Append interpolated sample to output
   d. Advance `pos` by `ratio`
3. Drain consumed samples from carry buffer
4. Save fractional position (`frac`) for next callback

### 4.3 Why Linear Interpolation?

| Method | Pros | Cons |
|--------|------|------|
| Linear interpolation | Simple, fast, no dependencies | Not audiophile quality |
| Sinc interpolation | High quality | Computationally expensive |
| libsamplerate | High quality, optimized | External C dependency |
| rubato (Rust) | High quality, pure Rust | Heavier than needed for KWS |

Linear interpolation is used because:
1. **Simple and fast** — minimal CPU overhead
2. **Good enough for wake word detection** — not audiophile quality
3. **No external dependencies** — no libsamplerate, no rubato
4. **For 48kHz → 16kHz:** ratio is exactly 3.0 (integer, no interpolation needed)
5. **For 44.1kHz → 16kHz:** interpolation is needed but quality is sufficient

---

## 5. Chunking

### 5.1 Chunk Accumulation

```rust
// 3. Feed 1280-sample chunks to KWS engine
{
    let mut buf = out_buf.lock();
    buf.extend(produced);
    while buf.len() >= chunk_size {
        let chunk: Vec<f32> = buf.drain(0..chunk_size).collect();
        let mut eng = engine.lock();
        if eng.process(&chunk) {
            let _ = wake_tx.send(());
        }
    }
}
```

- Audio is accumulated in `out_buf` (shared, mutex-protected)
- When buffer has enough samples, a chunk is extracted
- Each chunk is fed to the engine's `process()` method
- If `process()` returns `true`, a wake event is sent

### 5.2 Chunk Sizes

| Engine | Chunk Size | Duration | Purpose |
|--------|-----------|----------|---------|
| Silero VAD (old) | 512 samples | 32ms | VAD processing |
| openWakeWord (new) | 1280 samples | 80ms | KWS processing |

### 5.3 Why 1280 Samples (80ms)?

openWakeWord processes audio in 1280-sample chunks because:
1. **Matches openWakeWord's design** — the model expects 80ms chunks
2. **Mel spectrogram hop size** — 160 samples (10ms), so 1280/160 = 8 mel frames per chunk
3. **Balance between latency and compute** — small enough for low latency, large enough for efficient batching

---

## 6. Audio Callback Flow (Detailed)

```
cpal callback fires (every ~10ms)
    │
    ├── Increment CALLBACK_COUNT (atomic)
    ├── Increment SAMPLE_COUNT by frames (atomic)
    ├── Every 200 callbacks: log total audio processed
    │
    ▼
1. Downmix to mono f32
   ├── Lock ResampleState mutex
   ├── For each frame: average all channels
   ├── Convert sample format via to_f32 closure
   └── Push mono f32 samples to carry buffer
    │
    ▼
2. Resample to 16kHz
   ├── Lock ResampleState mutex
   ├── While pos + ratio < carry.len():
   │   ├── Linear interpolation between carry[idx0] and carry[idx1]
   │   ├── Push interpolated sample to produced
   │   └── Advance pos by ratio
   ├── Drain consumed samples from carry
   └── Save fractional position (frac)
    │
    ▼
3. Feed chunks to engine
   ├── Lock out_buf mutex
   ├── Extend out_buf with produced samples
   ├── While out_buf.len() >= chunk_size (1280):
   │   ├── Extract 1280 samples from out_buf
   │   ├── Lock engine mutex
   │   ├── Call engine.process(&chunk)
   │   └── If process returns true: send wake signal
   └── Unlock out_buf mutex
```

---

## 7. Thread Safety

### 7.1 Mutex Protection

All shared state is protected by `parking_lot::Mutex`:

| State | Mutex | Contention |
|-------|-------|------------|
| `ResampleState` (carry, frac, ratio) | `Arc<Mutex<ResampleState>>` | Low (only audio callback) |
| `out_buf` (chunk accumulation) | `Arc<Mutex<Vec<f32>>>` | Low (only audio callback) |
| `WakeEngine` (KWS state) | `Arc<Mutex<WakeEngine>>` | Low (only audio callback) |

### 7.2 Why parking_lot::Mutex?

- **Faster than std::Mutex** — no syscall on uncontended lock
- **Fair** — prevents starvation
- **Never poisons** — no `PoisonError` handling needed
- **Small** — no additional dependencies beyond parking_lot

### 7.3 Audio Thread Constraints

The cpal callback runs on a high-priority audio thread:
- **No allocations in the hot path** — buffers are pre-allocated
- **No blocking operations** — mutex locks are brief
- **No I/O** — no file reads, no network calls
- **No logging in hot path** — only every 200 callbacks

---

## 8. Performance Considerations

### 8.1 Callback Frequency

- cpal callback fires approximately every 10ms
- Each callback processes ~480 samples (at 48kHz)
- After resampling: ~160 samples (at 16kHz)
- After ~8 callbacks: enough for one 1280-sample chunk

### 8.2 Memory Usage

| Buffer | Size | Purpose |
|--------|------|---------|
| ResampleState.carry | ~4KB | Native-rate mono samples awaiting resampling |
| out_buf | ~5KB | 16kHz mono samples awaiting chunking |
| chunk (per chunk) | 1280 × 4 bytes = 5KB | One 80ms chunk |
| Total audio buffers | ~14KB | Very small |

### 8.3 CPU Usage

| Operation | Estimated Time | Frequency |
|-----------|---------------|-----------|
| Downmix | ~0.01ms | Every ~10ms |
| Resample | ~0.1ms | Every ~10ms |
| Chunk extraction | ~0.01ms | Every ~80ms |
| KWS inference | ~11-22ms | Every ~80ms |
| **Total** | ~11-22ms per 80ms | ~14-28% of one core |

---

## 9. Debugging

### 9.1 Callback Logging

```rust
if n % 200 == 0 && n > 0 {
    let total = SAMPLE_COUNT.load(Ordering::Relaxed);
    tracing::debug!(
        "audio: {} callbacks, ~{:.1}s of audio processed",
        n, total as f64 / 16000.0
    );
}
```

- Logs every 200 callbacks (~2 seconds)
- Shows total callbacks and total audio processed (in seconds)
- Useful for verifying audio is flowing

### 9.2 Probability Logging

```rust
if prob > 0.1 {
    tracing::debug!("OWW probability: {:.3}", prob);
}
```

- Logs KWS probability when above 0.1
- Useful for tuning threshold
- Shows how close the model is to triggering

---

## 10. Files

| File | Functions |
|------|-----------|
| `src-tauri/src/wakeword_oww.rs` | `on_audio`, `start_audio_capture`, `ResampleState` |
| `src-tauri/src/wakeword.rs` | Same functions (old approach, 512-sample chunks) |
