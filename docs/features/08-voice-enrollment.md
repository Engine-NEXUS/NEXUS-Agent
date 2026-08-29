# Feature: Voice Enrollment & Speaker Verification

> Optional: only the enrolled user's voice can wake NEXUS. Prevents family members, roommates, and TV ads from triggering it.

**Source files:**
- `src-tauri/src/voice_profile.rs` — speaker embedding extraction + verification
- `src-tauri/src/commands.rs` — `enroll_voice`, `get_voice_profile_status`, `delete_voice_profile` IPC commands
- `frontend/src/setup/VoiceEnrollment.tsx` — enrollment UI (5 clips)

---

## How Enrollment Works

1. User opens Settings → Voice Enrollment section.
2. Clicks "Start Enrollment".
3. Records **5 clips** of themselves saying "NEXUS" (3 seconds each).
4. Each clip is sent to Rust as `Vec<f32>` (16 kHz mono PCM).
5. Rust extracts a **speaker embedding** from each clip using `sherpa-onnx` speaker model.
6. Embeddings are averaged into a voice profile.
7. ASR runs on each clip to capture wake-word variants (how the user pronounces "NEXUS").
8. The profile + variants are saved to disk as JSON.

## The Voice Profile

Stored in the app data directory (`voice_profile.json`):
```json
{
  "embeddings": [[...], [...], ...],  // 5 speaker embeddings
  "threshold": 0.6,                    // cosine similarity threshold
  "num_clips": 5,
  "wake_variants": ["nexus", "nixus"], // ASR-captured pronunciations
  "created_at": 1697...,
  "updated_at": 1697...
}
```

**The profile never leaves the device.** It's not sent to the server.

## Verification at Wake Time

When the wake word fires:
1. Extract a speaker embedding from the wake audio.
2. Compare it to each stored embedding via **cosine similarity**.
3. If the best similarity > threshold → wake is accepted.
4. If below threshold → wake is rejected (someone else said "nexus").

## Wake Variants

During enrollment, ASR transcribes each clip to capture how the user pronounces "NEXUS":
- User 1: "nexus" (standard)
- User 2: "nixus" (accent)
- User 3: "nexis" (dialect)

These variants are stored and used to broaden the wake word's tolerance for the enrolled user's pronunciation.

## Sound-Alikes

A fixed list of sound-alike spellings is always included:
```rust
pub const SOUND_ALIKES: &[&str] = &[
    "nexus", "nixus", "nexis", "nixis", "mexic", "next us",
];
```

These help the phonetic matcher in the intent parser recognize the wake word even if STT mishears it.

## Re-Enrollment

Re-enrollment **appends** new variants to existing ones — it doesn't wipe the profile. This lets the user add more clips over time to improve accuracy.

## Disabling

The user can delete the voice profile via Settings → "Delete Voice Profile". This disables speaker verification — anyone's voice can wake NEXUS.

## Status IPC

The frontend queries `get_voice_profile_status` to show:
- `enrolled`: true/false
- `num_clips`: 5
- `threshold`: 0.6
- `wake_variants`: ["nexus", "nixus"]
- `sound_alikes`: ["nexus", "nixus", ...]
