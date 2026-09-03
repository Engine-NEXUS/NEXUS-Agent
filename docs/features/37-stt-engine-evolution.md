# STT Engine Evolution — Moonshine → faster-whisper Journey

**Date:** 2026-08-31 (restored) through 2026-09-02 (self-learning)
**Status:** Production (faster-whisper tiny.en via Python sidecar)

---

## Problem Statement

NEXUS needs to convert the user's spoken commands into text (Speech-to-Text)
with:
- High accuracy on developer vocabulary ("analyse", "PR", "servx", "architecture")
- Low latency (< 1s after model load)
- Offline capability (no cloud API dependency)
- Reasonable RAM usage (< 350 MB during active transcription)
- Cross-platform (Windows, macOS, Linux)
- Hotword boosting (bias toward "nexus", "analyse", repo names)

---

## Approach 1: faster-whisper Python Sidecar (Original — 2026-08-30)

**This was the first working STT architecture.**

### Architecture
```
[cpal mic] → [Rust audio capture] → [HTTP POST WAV] → [Python sidecar]
                                                         ↓
[stt.rs] ← [HTTP response JSON] ← [faster-whisper tiny.en]
```

### Details
- **Model:** faster-whisper `tiny.en` (39M params, ~40 MB)
- **Server:** `server/stt_server.py` on `127.0.0.1:39217`
- **API:** `POST /transcribe` (multipart/form-data WAV), `GET /health`
- **Audio format:** 16kHz, mono, 16-bit PCM WAV
- **Latency:** ~0.5s per transcription (after model load)
- **Cold start:** ~10-15s (model download + load)
- **RAM:** ~340 MB during transcription, ~128 MB idle (model loaded)

### Lazy Start Manager (`lazy_stt.rs`)
- STT server not started at boot
- `ensure_stt_running()` called on wake word or hotkey
- `mark_stt_request()` resets idle timer
- Server killed after 5 min idle (saves ~340 MB)
- `STT_KEEP_ALIVE=true` overrides kill (kept alive permanently in practice)

### Hallucination Filter (`stt.rs`)
faster-whisper tiny.en hallucinates on silent/noisy audio:
- "thank you for watching"
- "you", "bye", "okay"
- Text with < 2 alphabetic characters

The filter replaces these with empty string, triggering the frontend's
"didn't catch that" retry logic (up to 3 retries).

### Hotwords
- Built-in list in `stt.rs`: "nexus", "analyse", "architecture", "servx", etc.
- Dynamic file: `%APPDATA%/com.nexus.assistant/stt_hotwords.txt`
- Passed to faster-whisper as `hotwords` parameter for beam search biasing

### Bugs Fixed During This Era
1. **`lazy_stt.rs` path bug:** `stt_script_path()` was missing one `.parent()` level
2. **`ensure_stt_running()` not called on hotkey:** Added calls to `hotkey.rs` and `stt.rs`
3. **`is_stt_responsive()` used tokio runtime:** Fixed by using raw TCP connection
4. **STT idle timeout too aggressive:** 60s → 5 minutes
5. **STT server missing `__main__` block:** Added `if __name__ == "__main__":` guard

### Documentation
- See `02-stt-mishearing-fixes.md` for the post-processing corrections
- See `20-stt-fix-wakeword-reliability.md` for the `__main__` block fix

---

## Approach 2: Moonshine STT (In-Process Rust — Failed Experiment)

**Commits:**
- `4754c3e feat(stt): implement in-process Moonshine STT transcription`
- `a6973fa refactor(stt): remove external python STT server and lazy_stt process manager`
- `efb0b62 build(cargo): add transcribe-rs, kokoro-micro, and rodio dependencies`

**Date:** ~2026-08-29

### What It Was
[Moonshine](https://github.com/UsefulSensors/moonshine) is a 27M parameter
STT model designed for edge devices. The `transcribe-rs` Rust crate provides
in-process inference — no Python sidecar needed.

### Why We Tried It
| Goal | Rationale |
|------|-----------|
| Remove Python dependency | Python sidecar adds complexity, startup time, and ~20 MB overhead |
| In-process inference | No HTTP round-trip, lower latency |
| Smaller model | 27M params vs faster-whisper's 39M |
| Pure Rust | Better cross-compilation, no Python runtime needed |

### What Went Wrong

#### 1. Garbage Transcripts on Real Speech
Moonshine Tiny (39M params) produced unusable output on real microphone audio:
```
User says: "analyse PR 5 in servx"
Moonshine: "any eyes pe are five in serve"
faster-whisper: "analyse PR 5 in servx" ✅
```

The model was trained on clean studio audio and failed on:
- Background noise (fans, keyboard, room reverb)
- Non-American accents
- Technical vocabulary
- Conversational speech patterns

#### 2. Model Filename Mismatch
**Commit:** `6ba15e9 fix: Moonshine model filename mismatch (underscore vs dot)`
The model file was named `moonshine_tiny.onnx` but the crate expected
`moonshine.tiny.onnx`. This caused silent failures.

#### 3. Auto-Download Issues
**Commit:** `4f53574 fix: STT model auto-download + kill-before-build + stale STT cleanup`
The auto-download from HuggingFace was unreliable on Windows (SSL certificate
issues, proxy interference).

#### 4. No Hotword Support
Moonshine's Rust crate didn't support hotword biasing. faster-whisper's
`hotwords` parameter was critical for recognizing "nexus", "analyse", and
repo names.

### Why We Reverted
**Commit:** `e09f441 fix: restore faster-whisper STT + fix multipart upload + TTS fallback`

The transcript quality was simply unacceptable. A voice assistant that
can't understand speech is useless, regardless of how elegant the
architecture is.

### Cleanup
**Commits:**
- `cfb5e9b chore: remove stale Moonshine references`
- `2573a90 chore: fix one remaining Moonshine reference in QUICKSTART.md`
- `f316fa7 chore: remove dead sherpa-onnx and voice profile code`

All Moonshine-related code, model files, and documentation references
were removed. The `transcribe-rs` dependency was dropped from `Cargo.toml`.

---

## Approach 3: faster-whisper Restored (Current — 2026-08-31)

**Commit:** `e09f441 fix: restore faster-whisper STT + fix multipart upload + TTS fallback`

### What Was Restored
- `server/stt_server.py` — the Python sidecar
- `src-tauri/src/lazy_stt.rs` — the lazy start manager
- `src-tauri/src/stt.rs` — the HTTP proxy + hallucination filter
- Hotword support (built-in + dynamic file)

### What Was Fixed After Restoration
1. **Multipart upload fix:** The WAV upload format was broken during the
   Moonshine era. Fixed the multipart boundary and content-type headers.
2. **TTS fallback:** If STT fails entirely, the system gracefully says
   "I didn't catch that, sir" instead of hanging.
3. **STT idle monitor:** `start_idle_monitor()` wired in `lib.rs` but
   disabled via `STT_KEEP_ALIVE=true` (kept alive permanently).

### Current Architecture (2026-09-02)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│  cpal mic   │────▶│  stt.rs      │────▶│  Python sidecar     │
│  (16kHz     │     │  (HTTP proxy │     │  faster-whisper     │
│   mono 16b) │     │   + filter)  │     │  tiny.en            │
└─────────────┘     └──────────────┘     └─────────────────────┘
                           │                        │
                           ▼                        ▼
                    ┌──────────────┐     ┌─────────────────────┐
                    │ Hallucination│     │ Hotwords:           │
                    │ Filter       │     │ - nexus, analyse    │
                    │ (thank you,  │     │ - servx, ultron     │
                    │  <2 chars)   │     │ - dynamic file      │
                    └──────────────┘     └─────────────────────┘
```

### RAM Impact

| State | RAM |
|-------|-----|
| Idle (STT not started) | 0 MB |
| Idle (STT loaded, not transcribing) | ~128 MB |
| Active (transcribing) | ~340 MB |

### Why We Keep Python Despite the Complexity

| Factor | faster-whisper (Python) | Moonshine (Rust) |
|--------|--------------------------|-------------------|
| Accuracy on real speech | ✅ Good | ❌ Garbage |
| Hotword biasing | ✅ Built-in | ❌ Not supported |
| Model variety | ✅ tiny/base/small/medium | ❌ tiny/base only |
| Community support | ✅ Large | ❌ Small |
| Python dependency | ❌ Yes | ✅ No |
| RAM | ~340 MB | ~200 MB |
| Latency | ~500ms | ~300ms |

**Decision: Accuracy > elegance.** A 340 MB Python process that
actually understands speech is better than a 200 MB Rust process
that doesn't.

---

## Approach 4: Self-Learning STT Corrections (2026-09-02)

**Commit:** `c4e5049 feat: self-learning STT corrections — learns from user repetition`

### The Problem
faster-whisper tiny.en consistently mishears certain words:
- "architecture" → "octach at"
- "analyse" → "any eyes"
- "servx" → "serve"
- "PR" → "pe are"

The old approach (`02-stt-mishearing-fixes.md`) used a static correction
map in `stt.rs`. Every new mishearing required a manual code change and
rebuild. This doesn't scale.

### The Solution
A self-learning system that detects when the user repeats a command after
a failed parse, and learns the correction automatically.

### How It Works

```
1. User says "analyse PR 5 in servx"
2. STT produces "any eyes pe are 5 in serve"
3. Parser fails → log_failed_transcript("any eyes pe are 5 in serve")
4. Assistant says "Didn't catch that, sir"
5. User repeats: "analyse PR 5 in servx"
6. STT produces "analyse PR 5 in servx" (this time it got it right)
7. Parser succeeds → log_successful_transcript("analyse PR 5 in servx")
8. System diffs the two transcripts:
   - "any eyes" → "analyse" (position 0-1)
   - "pe are" → "PR" (position 2-3)
   - "serve" → "servx" (position 5)
9. Each diff is stored as a LearnedCorrection
10. After 3 consistent observations → auto_apply = true
11. Future transcripts are auto-corrected before parsing
```

### Implementation

#### Rust Side (`stt_learning.rs`)
```rust
pub struct LearnedCorrection {
    pub from: String,         // "any eyes"
    pub to: String,           // "analyse"
    pub context_before: String, // "" (start of sentence)
    pub count: u32,           // times observed
    pub auto_apply: bool,     // true after 3 observations
    pub first_seen: u64,
    pub last_seen: u64,
}
```

Storage: `%APPDATA%/com.nexus.assistant/learned_corrections.json`

Three Tauri commands:
- `log_failed_transcript(transcript)` — called when parser fails
- `log_successful_transcript(transcript)` — called when parser succeeds
- `get_learned_corrections()` — called at startup to load auto-apply rules

#### Frontend Side (`recorder.ts`)
```typescript
// After STT produces text:
transcript = correctSttTranscript(transcript);  // static corrections
transcript = applyLearnedCorrections(transcript); // self-learned

// Log for learning:
if (parseFailed) void logFailedTranscript(transcript);
if (parseSucceeded) void logSuccessfulTranscript(transcript);
```

### Learning Rules
- **Correction window:** 30 seconds (if user waits too long, they probably
  said something unrelated)
- **Max diff positions:** 2 (if too many words differ, it's not a correction)
- **Min word length:** 3 chars (skip 1-2 char noise)
- **Max Levenshtein distance:** 3 (skip completely different words)
- **Auto-apply threshold:** 3 consistent observations
- **Context-aware:** Corrections are keyed by the word before the corrected
  word, so "serve" → "servx" after "in" is different from "serve" → "serve"
  after "they"

### RAM Cost
~1-10 KB (in-memory HashMap of corrections). Negligible.

### Testing
- `cargo test --lib`: 104 tests pass (includes STT learning unit tests)
- Tests cover: word_diff, levenshtein, correction storage, auto-apply threshold

---

## Future Considerations

### Potential: faster-whisper base.en
- 2x accuracy improvement (MOS 4.0 → 4.5)
- 2x RAM (~680 MB during transcription)
- 2x latency (~1s per transcription)
- Trade-off: Better accuracy vs more RAM. Not worth it for a desktop assistant.

### Potential: whisper.cpp
- C++ port of Whisper, no Python needed
- Similar accuracy to faster-whisper
- Would eliminate the Python sidecar entirely
- But: Rust bindings (`whisper-rs`) are less mature than faster-whisper

### Potential: Distil-Whisper
- 6x faster than Whisper, 99% of accuracy
- Distilled from Whisper large-v3
- Available in faster-whisper
- Could reduce transcription latency from 500ms to ~80ms

### Potential: On-Device Fine-Tuning
- Fine-tune faster-whisper on the user's specific vocabulary
- Would eliminate the need for self-learning corrections
- But: requires GPU and training data collection

---

## Files Changed (All Eras)

| File | Change |
|------|--------|
| `server/stt_server.py` | faster-whisper sidecar (restored after Moonshine) |
| `src-tauri/src/stt.rs` | HTTP proxy, hallucination filter, hotwords |
| `src-tauri/src/lazy_stt.rs` | Lazy start manager, idle timeout |
| `src-tauri/src/stt_learning.rs` | NEW: self-learning corrections |
| `src-tauri/src/lib.rs` | Module declarations, command registration |
| `src-tauri/Cargo.toml` | Removed `transcribe-rs`, kept `reqwest` for HTTP |
| `frontend/src/audio/stt.ts` | Tauri invoke wrapper for `transcribe_audio` |
| `frontend/src/audio/recorder.ts` | Correction application, learning logging |
| `src-tauri/tauri.conf.json` | Bundle `resources/server/stt_server.py` |

## Lessons Learned

1. **Accuracy > architecture.** Moonshine was architecturally cleaner
   (pure Rust, no Python) but produced garbage. faster-whisper with Python
   is ugly but works.
2. **Don't trust model benchmarks.** Moonshine looked great on paper
   (27M params, 99% accuracy on LibriSpeech). Real microphone audio is
   nothing like LibriSpeech.
3. **Hotwords are essential.** Without biasing toward "nexus", "analyse",
   and repo names, the STT will never recognize developer commands.
4. **Static corrections don't scale.** Every user has different speech
   patterns, accents, and vocabulary. Self-learning is the only sustainable
   approach.
5. **Keep the Python sidecar.** It's worth the 340 MB RAM and Python
   dependency for the accuracy and hotword support. The alternative
   (in-process Rust STT) isn't ready yet.
6. **Test on real speech, not TTS samples.** TTS samples are too clean.
   Always test with actual microphone input including background noise.
