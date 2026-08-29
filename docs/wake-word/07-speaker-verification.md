# Speaker Verification

> How NEXUS verifies that the detected wake word was spoken by an enrolled user.

---

## 1. Overview

Speaker verification is the **second stage** of wake word detection. After the KWS engine detects the acoustic pattern of "NEXUS", the speaker verifier checks whether the speaker matches the enrolled voice profile.

```
KWS detects "NEXUS" (acoustic pattern match)
    │
    ▼
Speaker Verification
    │
    ├── Profile enrolled? → Verify speaker embedding
    │   ├── Match → Trigger wake
    │   └── No match → Reject (wrong speaker)
    │
    └── No profile (open mode) → Accept any speaker
```

**Privacy:** Voice profiles are personalization data, not a security boundary. They never leave the device. They can be deleted at any time.

---

## 2. Speaker Embedding Model

### 2.1 Model

- **File:** `speaker_model.onnx` (29.6MB)
- **Runtime:** sherpa-onnx (ONNX Runtime)
- **Source:** sherpa-onnx pre-trained speaker embedding model
- **Embedding dimension:** 256

### 2.2 Configuration

```rust
let config = SpeakerEmbeddingExtractorConfig {
    model: Some(model_path.to_string_lossy().to_string()),
    num_threads: 1,
    debug: false,
    provider: Some("cpu".to_string()),
};
```

- **Threads:** 1 (single-threaded for low latency)
- **Provider:** CPU (no GPU needed)
- **Debug:** false

### 2.3 Model Resolution

The speaker model is checked in two locations:

```rust
// 1. New location: oww_dir/speaker_model.onnx
let speaker_model = oww_dir.join("speaker_model.onnx");

// 2. Old location (backward compat): sherpa_dir/speaker_model.onnx
let sherpa_dir = resource_dir.join("sherpa");
let alt = sherpa_dir.join("speaker_model.onnx");
```

This allows the speaker model to be shared between the old VAD+ASR and new KWS engines.

---

## 3. Voice Profile

### 3.1 Structure

```rust
pub struct VoiceProfile {
    /// The averaged embedding vector (256-dim).
    pub embedding: Vec<f32>,
    /// Number of clips used to create this profile.
    pub num_clips: usize,
    /// When the profile was created (Unix timestamp).
    pub created_at: i64,
    /// When the profile was last updated (Unix timestamp).
    pub updated_at: i64,
    /// The similarity threshold for verification.
    pub threshold: f32,
    /// Personalized wake-word variants from enrollment.
    #[serde(default = "default_wake_variants")]
    pub wake_variants: Vec<String>,
}
```

### 3.2 Storage

- **Format:** JSON file
- **Location:** `{app_data_dir}/voice_profile.json`
- **Path resolution:** `resolve_profile_path(app_data_dir)`
- **Backward compatibility:** `#[serde(default = "default_wake_variants")]` ensures old profiles without `wake_variants` default to `["nexus"]`

### 3.3 Example Profile JSON

```json
{
    "embedding": [0.123, -0.456, 0.789, ...],
    "num_clips": 5,
    "created_at": 1724000000,
    "updated_at": 1724000000,
    "threshold": 0.5,
    "wake_variants": ["nexus", "nixis", "mexic"]
}
```

---

## 4. Enrollment

### 4.1 Process

1. Capture ~5 audio clips of the user saying "NEXUS" (or any phrase)
2. Extract a 256-dim speaker embedding for each clip
3. Average the embeddings into a single voice profile
4. Save to disk as JSON

### 4.2 Requirements

```rust
pub const RECOMMENDED_ENROLLMENT_CLIPS: usize = 5;
pub const MIN_ENROLLMENT_CLIPS: usize = 3;
```

- **Recommended:** 5 clips for a stable profile
- **Minimum:** 3 clips required to create a profile
- **Clip length:** 1-5 seconds of speech per clip

### 4.3 Embedding Extraction

```rust
pub fn extract_embedding(&self, samples: &[f32]) -> anyhow::Result<Vec<f32>> {
    let stream = self.extractor.create_stream()?;
    stream.accept_waveform(16000, samples);
    
    // Add tail padding to help the model finalize
    let tail = vec![0.0f32; 8000]; // 0.5s at 16kHz
    stream.accept_waveform(16000, &tail);
    stream.input_finished();
    
    let embedding = self.extractor.compute(&stream)?;
    Ok(embedding)
}
```

- **Input:** 16kHz mono f32 audio samples
- **Tail padding:** 0.5 seconds of silence (helps the model finalize the embedding)
- **Output:** 256-dimensional embedding vector

### 4.4 Averaging

```rust
pub fn average_embeddings(embeddings: &[Vec<f32>]) -> anyhow::Result<Vec<f32>> {
    let dim = embeddings[0].len();
    let mut sum = vec![0.0f32; dim];
    for e in embeddings {
        for i in 0..dim {
            sum[i] += e[i];
        }
    }
    let n = embeddings.len() as f32;
    for v in &mut sum {
        *v /= n;
    }
    Ok(sum)
}
```

- Simple arithmetic mean of all clip embeddings
- Results in a single 256-dim profile embedding

### 4.5 Re-Enrollment

Re-enrollment **does not wipe** existing data:

```rust
if let Some(existing) = &self.profile {
    existing_variants = existing.wake_variants.clone();
    created_at = existing.created_at;
    total_clips = existing.num_clips + embeddings.len();
}
```

- `wake_variants` are preserved and new ones appended
- `created_at` is preserved
- `num_clips` accumulates (existing + new)
- `embedding` is replaced with new average (from new clips only)

### 4.6 Incremental Enrollment

```rust
pub fn add_clip(&mut self, samples: &[f32]) -> anyhow::Result<()> {
    let new_emb = self.extract_embedding(samples)?;
    let n = profile.num_clips as f32;
    for i in 0..dim {
        profile.embedding[i] = (profile.embedding[i] * n + new_emb[i]) / (n + 1.0);
    }
    profile.num_clips += 1;
}
```

- Weighted average: combines existing average with new embedding
- No need to re-process all previous clips
- Useful for adding clips one at a time

---

## 5. Verification

### 5.1 Cosine Similarity

```rust
pub fn cosine_similarity(&self, query: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for i in 0..query.len() {
        dot += self.embedding[i] * query[i];
        norm_a += self.embedding[i] * self.embedding[i];
        norm_b += query[i] * query[i];
    }
    let denom = (norm_a.sqrt() * norm_b.sqrt()).max(1e-8);
    dot / denom
}
```

- **Formula:** cos(A, B) = (A · B) / (|A| × |B|)
- **Range:** -1.0 to 1.0
- **Same speaker:** typically 0.5-0.98
- **Different speaker:** typically <0.3
- **Threshold:** 0.5 (default)

### 5.2 Verification Logic

```rust
pub fn verify(&self, samples: &[f32]) -> anyhow::Result<(bool, f32)> {
    if let Some(profile) = &self.profile {
        let emb = self.extract_embedding(samples)?;
        let sim = profile.cosine_similarity(&emb);
        let matched = sim >= profile.threshold;
        Ok((matched, sim))
    } else {
        // No profile enrolled — accept any speaker (open mode)
        Ok((true, 0.0))
    }
}
```

### 5.3 Threshold

```rust
pub const DEFAULT_THRESHOLD: f32 = 0.5;
```

| Threshold | Behavior |
|-----------|----------|
| 0.3 | Very lenient — accepts most speakers (high false accept) |
| 0.5 | Balanced (default) — accepts same speaker, rejects most others |
| 0.7 | Strict — may reject same speaker in noisy conditions |
| 0.9 | Very strict — only accepts very clean same-speaker audio |

### 5.4 Open Mode

When no voice profile is enrolled:
- Any speaker can trigger the wake word
- Verification always returns `(true, 0.0)`
- Log: "No voice profile — accepting any speaker"

---

## 6. KWS Integration (Current Status)

### 6.1 Current Implementation

In the new KWS engine (`wakeword_oww.rs`), speaker verification is integrated but has a TODO:

```rust
if detected {
    let accepted = if let Some(ref verifier) = self.speaker {
        if verifier.has_profile() {
            // TODO: implement audio ring buffer for proper speaker verification.
            // For now, accept — the KWS model is accurate enough.
            true
        } else {
            true // open mode
        }
    } else {
        true
    };
    
    if accepted {
        tracing::info!("OWW wake detected! (probability: {:.3})", prob);
        return true;
    }
}
```

### 6.2 The TODO: Audio Ring Buffer

**Problem:** The KWS engine processes audio in 80ms chunks. When a wake is detected, the engine doesn't have the full wake-word audio segment stored — it only has the current chunk.

**Solution (TODO):** Implement an audio ring buffer that:
1. Continuously stores the last ~2 seconds of audio
2. When KWS detects a wake, extracts the relevant audio segment from the ring buffer
3. Passes the segment to the speaker verifier for embedding extraction
4. Verifies the speaker before triggering the wake event

**Current workaround:** Accept all wakes without speaker verification. The KWS model is accurate enough that false wakes from wrong speakers are rare.

---

## 7. Privacy

### 7.1 What Stays Local

| Data | Location | Leaves Device? |
|------|----------|----------------|
| Voice profile JSON | `{app_data_dir}/voice_profile.json` | **No** |
| Speaker embeddings | In memory only | **No** |
| Speaker model | `resources/oww/speaker_model.onnx` | **No** |
| Audio for verification | In memory only (transient) | **No** |
| Enrollment audio clips | In memory only (transient) | **No** |

### 7.2 What Can Be Deleted

- The voice profile can be deleted at any time via `delete_profile()`
- This removes the JSON file and clears the in-memory profile
- The system reverts to open mode (any speaker can wake)

### 7.3 Not a Security Boundary

> Voice profiles are personalization data, not a security boundary.

- Speaker verification prevents accidental wakes from family members or TV audio
- It is NOT designed to resist determined impersonation
- Cosine similarity thresholds are not cryptographic
- For security, use explicit authentication (password, biometric unlock)

---

## 8. Files

| File | Role |
|------|------|
| `src-tauri/src/voice_profile.rs` | Voice profile, speaker verifier, wake variants |
| `src-tauri/src/commands.rs` | IPC commands for enrollment and status |
| `src-tauri/resources/oww/speaker_model.onnx` | Speaker embedding model (or `resources/sherpa/speaker_model.onnx`) |
| `{app_data_dir}/voice_profile.json` | Stored voice profile (created at enrollment) |
