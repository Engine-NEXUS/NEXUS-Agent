# Wake Variants and Sound-Alikes

> The wake_variants and sound_alikes system for pronunciation tolerance.
> Part of the OLD VAD+ASR approach. Data structures remain in voice_profile.rs for backward compatibility.

---

## 1. Overview

When using the old VAD+ASR approach, ASR may transcribe the same spoken word differently. The wake_variants and sound_alikes system was created to handle this variation.

**Note:** With the new openWakeWord KWS engine, this system is no longer used for wake word detection. The KWS model directly detects the acoustic pattern of "nexus" and doesn't need text matching. However, the data structures remain for backward compatibility and for users who switch back to the `wakeword-sherpa` feature.

---

## 2. The Problem

When the user says "NEXUS", ASR may transcribe it as:

| ASR Output | Frequency | Correct? |
|------------|-----------|----------|
| nexus | 1/10 | Yes |
| mexic | 1/10 | No (sound-alike) |
| nixis | 1/10 | No (sound-alike) |
| next | 2/10 | No (clipped) |
| us | 1/10 | No (clipped) |
| n | 1/10 | No (clipped) |
| (no segment) | 3/10 | N/A |

Every person pronounces "NEXUS" differently. Some say "nixus", "mexic", etc. Without a tolerance system, only the exact transcription "nexus" would trigger a wake — resulting in ~10% recall.

---

## 3. Two-List Approach

### 3.1 wake_variants (User-Specific)

- **Storage:** `voice_profile.json` → `wake_variants` field
- **Source:** Captured during enrollment (ASR transcribes each enrollment clip)
- **Accumulation:** Re-enrollment appends new variants (never wipes old data)
- **Cap:** 30 variants maximum (deduplicated)
- **Baseline:** Always includes "nexus" even if all ASR transcriptions are different
- **Backward compat:** Old profile JSON files without this field default to `["nexus"]`

```rust
#[serde(default = "default_wake_variants")]
pub wake_variants: Vec<String>,

fn default_wake_variants() -> Vec<String> {
    vec!["nexus".to_string()]
}
```

### 3.2 sound_alikes (Global)

- **Storage:** Hardcoded constant in `voice_profile.rs`
- **Scope:** Same for all users
- **Source:** Compiled from observed ASR mishearings during testing
- **Purpose:** Catch common mishearings without requiring enrollment

```rust
pub const SOUND_ALIKES: &[&str] = &[
    "nexus", "nixis", "mixis", "mexic", "nixes", "lexis",
    "necess", "nexis", "nixus", "naxus", "noxus", "nexcus", "dnexus",
];
```

---

## 4. Matching Rules

```rust
pub fn matches_wake_word(transcript: &str, wake_variants: &[String]) -> bool {
    let text = transcript.trim().to_lowercase();
    if text.is_empty() {
        return false;
    }

    // 1. Check personalized wake variants (from enrollment)
    for variant in wake_variants {
        if text.contains(variant.trim().to_lowercase()) {
            return true;
        }
    }

    // 2. Check global sound-alikes (common ASR mishearings)
    for &alike in SOUND_ALIKES {
        if text.contains(alike) {
            return true;
        }
    }

    false
}
```

### Step-by-step:

1. ASR produces a transcript (e.g., "and learn to the good and mexic")
2. Normalize: lowercase and trim → "and learn to the good and mexic"
3. Check for exact substring matches against `wake_variants`
4. Check for exact substring matches against `SOUND_ALIKES`
5. If either list matches → proceed to speaker verification
6. If speaker verification accepts → trigger wake
7. If neither list matches → do not wake

### Example:

```
Transcript: "and learn to the good and mexic"
Normalized: "and learn to the good and mexic"

Check wake_variants: ["nexus", "nixis", "mexic"]
  → "mexic" is a substring of the transcript → MATCH

Result: Wake word match found → proceed to speaker verification
```

---

## 5. No Fuzzy Matching

The system deliberately does NOT use:

| Matching Type | Used? | Why Not? |
|---------------|-------|----------|
| Exact substring | Yes | Simple, predictable, no false positives |
| Levenshtein distance | No | Too many false positives (e.g., "next" → "nexus" is distance 3) |
| Phonetic similarity | No | Complex, unreliable, language-dependent |
| "Within N characters" | No | Arbitrary threshold, hard to tune |
| Broad fuzzy fallback | No | Would trigger on almost any short word |

Only exact stored strings and exact substring containment are used.

---

## 6. Enrollment Behavior

### 6.1 Process

1. Enrollment receives ~5 audio clips from the setup flow
2. ASR runs on each enrollment clip to capture transcript variants
3. Speaker embeddings are extracted as before
4. Variants are appended to existing profile (not replacing)
5. Invalid or empty ASR transcripts are not added
6. Duplicate variants are deduplicated
7. "nexus" is always present even if all 5 ASR transcriptions are different
8. 30-variant maximum is enforced

### 6.2 add_wake_variants Function

```rust
pub fn add_wake_variants(&mut self, new_variants: &[String]) {
    for v in new_variants {
        let v = v.trim().to_lowercase();
        if v.is_empty() || v.len() < 3 {
            continue;  // Skip empty or too-short variants
        }
        if !self.wake_variants.contains(&v) {
            self.wake_variants.push(v);  // Append if not duplicate
        }
    }
    // Always ensure "nexus" is present
    if !self.wake_variants.contains(&"nexus".to_string()) {
        self.wake_variants.insert(0, "nexus".to_string());
    }
    // Cap at MAX_WAKE_VARIANTS — keep the most recently added
    if self.wake_variants.len() > MAX_WAKE_VARIANTS {
        let excess = self.wake_variants.len() - MAX_WAKE_VARIANTS;
        self.wake_variants.drain(0..excess);
    }
}
```

### 6.3 Re-Enrollment Accumulation

```rust
// In enroll():
if let Some(existing) = &self.profile {
    existing_variants = existing.wake_variants.clone();
    // ...
    tracing::info!(
        "Re-enrollment: preserving {} existing wake variants, appending new ones",
        existing_variants.len()
    );
}

let mut profile = VoiceProfile {
    // ...
    wake_variants: existing_variants,
};

profile.add_wake_variants(&wake_variants);  // Append new ones
```

- Old variants are preserved
- New variants are appended
- Duplicates are removed
- 30-variant cap is enforced (oldest excess variants are removed)

---

## 7. Backward Compatibility

### 7.1 Old Profile JSON

Old profile JSON files created before `wake_variants` was added:

```json
{
    "embedding": [0.123, ...],
    "num_clips": 5,
    "created_at": 1724000000,
    "updated_at": 1724000000,
    "threshold": 0.5
}
```

When loaded, `#[serde(default = "default_wake_variants")]` ensures:

```json
{
    "embedding": [0.123, ...],
    "num_clips": 5,
    "created_at": 1724000000,
    "updated_at": 1724000000,
    "threshold": 0.5,
    "wake_variants": ["nexus"]
}
```

### 7.2 Existing Embeddings

- Existing profile embeddings are NOT discarded during migration
- The `embedding`, `num_clips`, `created_at`, `updated_at`, and `threshold` fields are preserved
- Only `wake_variants` is added with the default value

---

## 8. Constants and Defaults

```rust
/// Maximum number of wake variants stored in a profile.
pub const MAX_WAKE_VARIANTS: usize = 30;

/// Default cosine similarity threshold for speaker verification.
pub const DEFAULT_THRESHOLD: f32 = 0.5;

/// Global list of words that sound like "NEXUS".
pub const SOUND_ALIKES: &[&str] = &[
    "nexus", "nixis", "mixis", "mexic", "nixes", "lexis",
    "necess", "nexis", "nixus", "naxus", "noxus", "nexcus", "dnexus",
];

/// Default wake variants — always includes "nexus".
fn default_wake_variants() -> Vec<String> {
    vec!["nexus".to_string()]
}
```

---

## 9. Note on KWS Migration

With the new openWakeWord KWS engine:

| Aspect | Old (VAD+ASR) | New (KWS) |
|--------|---------------|-----------|
| Wake detection | Text matching against variants | Acoustic pattern detection |
| wake_variants used? | Yes | No (KWS doesn't use text) |
| sound_alikes used? | Yes | No (KWS doesn't use text) |
| Data structures kept? | Yes | Yes (backward compat) |
| Enrollment captures ASR? | Yes | Still yes (for variants) |

The data structures remain in `voice_profile.rs` because:
1. Users can switch back to `wakeword-sherpa` feature
2. The enrollment flow still captures ASR transcripts
3. Removing the fields would break old profile JSON files
4. The variants may be useful for debugging or future features

---

## 10. Files

| File | Role |
|------|------|
| `src-tauri/src/voice_profile.rs` | `VoiceProfile`, `SOUND_ALIKES`, `matches_wake_word`, `add_wake_variants` |
| `src-tauri/src/wakeword.rs` | Old engine that uses `matches_wake_word` |
| `src-tauri/src/commands.rs` | IPC for enrollment (captures ASR variants) |
