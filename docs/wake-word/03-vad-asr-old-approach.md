# Old Approach: VAD + ASR Wake Word Detection

> Detailed explanation of the original VAD+ASR wake word detection pipeline.
> This is the LEGACY approach, replaced by openWakeWord KWS. Kept as a fallback via the `wakeword-sherpa` feature flag.

---

## 1. Overview

The original NEXUS wake word detection used a **VAD → ASR → text matching** pipeline:

```
cpal microphone
  → resampling to 16kHz mono
  → Silero VAD (512-sample / 32ms chunks)
  → speech segment detection
  → sherpa-onnx streaming ASR (Zipformer int8)
  → transcript text
  → substring/sound-alike matching
  → speaker verification
  → wake event
```

This approach achieved ~30% recall during testing — 3 out of 10 utterances detected. The structural problems are documented in `03-vad-asr-old-approach.md` (this file) and motivated the migration to openWakeWord KWS.

---

## 2. Components

### 2.1 Audio Capture (cpal)

- **Library:** cpal 0.15
- **Sample rate:** Device native (typically 48kHz)
- **Channels:** Device native (typically 2 = stereo)
- **Sample format:** Device native (F32, I16, or I32)
- **Callback:** Real-time audio thread, no allocations in hot path

### 2.2 Resampling

- **Source rate:** Device native (e.g., 48kHz)
- **Target rate:** 16kHz
- **Method:** Linear interpolation
- **Chunk size for VAD:** 512 samples (32ms at 16kHz)

### 2.3 Silero VAD

- **Model:** `silero_vad.onnx` (643KB)
- **Runtime:** sherpa-onnx (ONNX Runtime)
- **Input:** 512 samples (32ms) of 16kHz mono audio
- **Output:** Probability of speech (0.0 to 1.0)
- **Threshold:** 0.5 (configurable)
- **Silero VAD parameters:**
  - `min_silence_duration_ms`: 500 (wait 500ms of silence before ending segment)
  - `speech_pad_ms`: 200 (pad 200ms before/after speech)
  - `threshold`: 0.5

### 2.4 sherpa-onnx Streaming ASR

- **Model:** Zipformer int8 (encoder + decoder + joiner)
- **Total size:** ~26MB
- - `encoder-epoch-99-avg-1.int8.onnx`: ~9MB
  - `decoder-epoch-99-avg-1.int8.onnx`: ~9MB
  - `joiner-epoch-99-avg-1.int8.onnx`: ~8MB
  - `tokens.txt`: ~100KB
- **Runtime:** sherpa-onnx (ONNX Runtime)
- **Input:** Speech segments from VAD
- **Output:** Transcript text (streaming, token by token)
- **Mode:** Streaming (online) recognition

### 2.5 Text Matching

- **Personal variants:** `wake_variants` from voice profile (e.g., ["nexus", "nixis", "mexic"])
- **Global sound-alikes:** Hardcoded list (e.g., ["nexus", "nixis", "mixis", ...])
- **Matching:** Case-insensitive substring containment
- **No fuzzy matching:** No Levenshtein distance, no phonetic similarity

### 2.6 Speaker Verification

- **Model:** `speaker_model.onnx` (29.6MB)
- **Runtime:** sherpa-onnx (ONNX Runtime)
- **Input:** Speech segment
- **Output:** 256-dimensional speaker embedding
- **Verification:** Cosine similarity vs. stored profile embedding
- **Threshold:** 0.5 (configurable)

---

## 3. Pipeline Flow (Detailed)

### Step 1: Audio Capture

```
cpal callback fires (every ~10ms)
  → receives N samples in native format
  → downmixes to mono (average channels)
  → resamples to 16kHz (linear interpolation)
  → accumulates in 512-sample buffer
```

### Step 2: VAD Processing

```
Every 512 samples (32ms):
  → feed 512 samples to Silero VAD
  → get speech probability (0.0 to 1.0)
  → if probability > 0.5:
      → mark as speech
      → accumulate samples into speech segment buffer
  → if probability < 0.5:
      → increment silence counter
      → if silence > 500ms:
          → end speech segment
          → pass segment to ASR
```

### Step 3: ASR Processing

```
When VAD ends a speech segment:
  → feed segment to sherpa-onnx streaming ASR
  → ASR produces transcript text (token by token)
  → accumulate tokens into full transcript
  → when ASR signals end of segment:
      → pass full transcript to text matching
```

### Step 4: Text Matching

```
Given transcript (e.g., "and learn to the good and mexic"):
  → normalize: lowercase, trim
  → for each variant in wake_variants:
      → if transcript contains variant:
          → match found, proceed to speaker verification
  → for each sound-alike in SOUND_ALIKES:
      → if transcript contains sound-alike:
          → match found, proceed to speaker verification
  → if no match:
      → do not wake
```

### Step 5: Speaker Verification

```
If text match found:
  → extract speaker embedding from speech segment
  → compute cosine similarity vs. stored profile embedding
  → if similarity > threshold (0.5):
      → wake event triggered
  → else:
      → do not wake (wrong speaker)
```

---

## 4. Observed Problems

### 4.1 Problem 1: VAD Clips Start of Words

**What happens:**
1. User starts saying "NEXUS"
2. VAD needs 200-300ms of continuous speech to trigger
3. By the time VAD says "speech started," the first 200-300ms of "NEXUS" is gone
4. ASR receives only the tail end: "XUS", "next", "us", "n"

**Evidence from our testing:**
- ASR produced: "next", "us", "n", "n" — consistent with clipped audio
- Only 3 out of 10 utterances even produced a speech segment
- Only 1 out of 10 was transcribed as "nexus"

### 4.2 Problem 2: VAD Splits Words

**What happens:**
1. User says "NEXUS" with a slight pause: "NE" ... "XUS"
2. VAD detects speech ("NE"), then silence (pause), then speech ("XUS")
3. VAD creates two segments: "NE" and "XUS"
4. ASR transcribes "NE" as "n" or "next"
5. ASR transcribes "XUS" as "us" or "ex"
6. Neither matches "nexus"

### 4.3 Problem 3: ASR Misrecognizes Words

**What happens:**
1. Even when VAD captures the full word
2. ASR may transcribe "NEXUS" as "mexic", "nixis", "lexis", "next us"
3. ASR optimizes for general transcription, not for catching one specific word
4. The Zipformer model has a <10% recognition rate for English keywords (sherpa-onnx #2678)

**Our observed ASR outputs for spoken "NEXUS":**
| ASR Output | Frequency |
|------------|-----------|
| nexus (correct) | 1/10 |
| mexic | 1/10 |
| nixis | 1/10 |
| next | 2/10 |
| us | 1/10 |
| n | 1/10 |
| (no segment) | 3/10 |

### 4.4 Problem 4: High Latency

**Breakdown:**
- VAD speech start detection: 200-300ms
- VAD speech end detection (silence timeout): 500ms
- ASR decoding: 100-200ms
- Text matching: <1ms
- Speaker verification: 50-100ms
- **Total: 850-1100ms from word end to wake event**

### 4.5 Problem 5: High RAM Usage

**Breakdown:**
- Silero VAD model: ~5MB
- Zipformer ASR models (int8): ~26MB
- Speaker model: ~30MB
- ONNX Runtime: ~20MB
- Audio buffers + Rust runtime: ~54MB
- **Total: ~143MB**

---

## 5. Mitigation Attempts

### 5.1 Sound-Alike Lists

We added a `sound_alikes` global list and `wake_variants` personal list to catch ASR misrecognitions:

```rust
pub const SOUND_ALIKES: &[&str] = &[
    "nexus", "nixis", "mixis", "mexic", "nixes", "lexis",
    "necess", "nexis", "nixus", "naxus", "noxus", "nexcus", "dnexus",
];
```

**Result:** Helped in some cases (e.g., "mexic" now triggers) but didn't solve the fundamental problem — VAD still clips and ASR still misrecognizes.

### 5.2 VAD Parameter Tuning

We tried:
- Lowering VAD threshold (0.5 → 0.3): more sensitive, but more false alarms
- Reducing silence timeout (500ms → 300ms): faster segment end, but more split words
- Increasing speech pad (200ms → 400ms): more context, but still clips start

**Result:** No combination of parameters solved the structural problems.

### 5.3 Enrollment Variants

We added enrollment-time ASR to capture how the user's "NEXUS" gets transcribed:
- User says "NEXUS" 5 times during enrollment
- ASR transcribes each clip
- All transcriptions are stored as `wake_variants`
- Runtime matching checks both personal variants and global sound-alikes

**Result:** Helped with consistent misrecognitions but didn't solve VAD clipping.

---

## 6. Why These Problems Are Structural

The VAD+ASR problems are **structural** — they cannot be fixed by tuning parameters:

| Problem | Why It's Structural |
|---------|---------------------|
| VAD clips start of words | VAD *by definition* needs time to detect speech. You can't detect speech before it starts. |
| VAD splits words | VAD *by definition* uses silence to segment. Any pause in speech creates a segment boundary. |
| ASR misrecognizes | ASR *by definition* transcribes all words, not just the target. It optimizes for overall accuracy, not keyword recall. |
| High latency | VAD+ASR *by definition* waits for speech to end before transcribing. You can't transcribe before the word is complete. |

**The only solution is to not use VAD+ASR for wake word detection.** Use a dedicated KWS model that scores every audio frame continuously.

---

## 7. Current Status

- **Feature flag:** `wakeword-sherpa` (not default)
- **Default:** `wakeword-oww` (openWakeWord KWS)
- **Code:** `src-tauri/src/wakeword.rs` (kept for fallback)
- **Models:** Still in `src-tauri/resources/` (silero_vad.onnx, Zipformer, speaker_model.onnx)
- **Speaker model:** Shared between old and new approaches

The old approach is kept as a fallback in case the new KWS engine has issues. To switch back:

```toml
[features]
default = ["wakeword-sherpa"]  # instead of "wakeword-oww"
```

---

## 8. Files

| File | Role |
|------|------|
| `src-tauri/src/wakeword.rs` | Old VAD+ASR engine |
| `src-tauri/src/voice_profile.rs` | Voice profile, variants, speaker verification |
| `src-tauri/resources/silero_vad.onnx` | Silero VAD model |
| `src-tauri/resources/encoder-epoch-99-avg-1.int8.onnx` | Zipformer encoder |
| `src-tauri/resources/decoder-epoch-99-avg-1.int8.onnx` | Zipformer decoder |
| `src-tauri/resources/joiner-epoch-99-avg-1.int8.onnx` | Zipformer joiner |
| `src-tauri/resources/tokens.txt` | ASR token vocabulary |
| `src-tauri/resources/speaker_model.onnx` | Speaker embedding model |
