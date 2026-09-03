# TTS Engine Evolution — Kokoro → Piper Migration

**Date:** 2026-09-02
**Commit:** `8844527 feat: replace Kokoro TTS with Piper TTS — 270 MB RAM reduction`
**Status:** Production (integrated, tested, shipping in installer)

---

## Problem Statement

NEXUS needed an in-process neural TTS engine that:
- Runs entirely offline (no API calls, no network dependency)
- Loads fast enough for instant voice acknowledgement ("On it sir")
- Uses minimal RAM at idle (target: < 100 MB)
- Produces natural-sounding speech (MOS > 4.0)
- Is open-source with permissive license (Apache 2.0 or MIT)
- Works cross-platform (Windows, macOS, Linux)

---

## Approach 1: Cloud TTS APIs (Rejected Early)

### Providers Evaluated
- **ElevenLabs** — Best quality (MOS 4.5+), but expensive ($5/mo for 30k chars)
- **Fish Audio** — Free tier (s2.1-pro-free), ~100ms TTFA, voice cloning
- **Google Cloud TTS** — $4/million chars, good quality
- **Amazon Polly** — $4/million chars, 60 voices
- **Azure TTS** — $4/million chars, 400+ voices

### Why Rejected
| Issue | Detail |
|-------|--------|
| Network dependency | No internet = no TTS. NEXUS must work offline. |
| Latency | 200-800ms network RTT added to every response |
| Cost | 5-10 users × daily usage = $20-50/mo minimum |
| Privacy | Voice data sent to third-party servers |
| Rate limits | Free tiers too small for active development |

### Documentation
- See `23-tts-voice-research-elevenlabs-vs-fish.md` for the full API comparison
- See `24-tts-deep-research-all-providers.md` for the 10-provider deep dive

---

## Approach 2: Kokoro TTS (In-Process, Rust)

**Commit:** `ad1402c feat(tts): integrate in-process Kokoro TTS engine and rodio playback`
**Date:** ~2026-08-29

### What It Was
[Kokoro](https://github.com/casper-hansen/kokoro-rs) is a Rust port of the
Kokoro TTS model (82M params, Apache 2.0). It runs entirely in-process —
no Python sidecar, no network calls.

### Configuration
```rust
// Cargo.toml
kokoro-rs = "0.2"
rodio = "0.19"

// tts.rs — voices
const VOICES: &[&str] = &[
    "af_sky",    // female, warm
    "am_adam",   // male, deep
    "bf_emma",   // British female
    "bm_george", // British male
];
```

### Initial Implementation (Eager Load)
- Loaded at boot in `lib.rs`
- Used ~350 MB RAM constantly
- First speak was instant (model already loaded)
- Voice selection via setup wizard

### Lazy Load Optimization (2026-09-01)
**Commit:** Part of the RAM optimization wave
- Moved to `ensure_engine_loaded()` pattern
- First speak: ~1.7s load time
- After first speak: stays loaded (~350 MB)
- Idle (before first speak): 0 MB

### Why We Moved Away From Kokoro

| Issue | Impact |
|-------|--------|
| **350 MB RAM when loaded** | Dominated the RAM budget. After first TTS, total idle was ~582 MB. |
| **1.7s cold load** | Too slow for instant "On it sir" acknowledgement. User hears a 1.7s gap. |
| **Limited voices** | Only 4 English voices (af_sky, am_adam, bf_emma, bm_george) |
| **Model size** | ~300 MB model file bundled in installer |
| **Rust port maturity** | kokoro-rs was relatively new, occasional panics on edge cases |
| **No streaming** | Entire utterance generated before playback starts |

### RAM Impact Table (Kokoro Era)

| State | nexus.exe | WebView2 | STT Python | Kokoro | **Total** |
|-------|-----------|----------|------------|--------|-----------|
| Idle (cold) | 47.8 MB | 35.8 MB | 20.6 MB | 0 MB | **104.2 MB** |
| Idle (after STT) | 47.8 MB | 35.8 MB | 128.6 MB | 0 MB | **232.2 MB** |
| Active (after TTS) | 47.8 MB | 35.8 MB | 128.6 MB | 350 MB | **582.2 MB** |

---

## Approach 3: Piper TTS (Current — In-Process, Rust)

**Commit:** `8844527 feat: replace Kokoro TTS with Piper TTS — 270 MB RAM reduction`
**Date:** 2026-09-02

### What It Is
[Piper](https://github.com/rhasspy/piper) is a fast, local neural TTS system
originally built for Rhasspy (open-source voice assistant). The Rust binding
[`piper-rs`](https://crates.io/crates/piper-rs) runs entirely in-process.

### Why Piper Won

| Criterion | Kokoro | Piper | Winner |
|-----------|--------|-------|--------|
| RAM when loaded | 350 MB | 80 MB | **Piper** (4.4x less) |
| Cold load time | 1.7s | 85ms | **Piper** (20x faster) |
| Model size | ~300 MB | ~63 MB | **Piper** (4.8x smaller) |
| MOS (quality) | 4.2-4.4 | 4.0-4.3 | Kokoro (marginal) |
| Voices | 4 English | 20+ English | **Piper** |
| License | Apache 2.0 | MIT | Both OK |
| Streaming | No | Yes | **Piper** |
| Cross-platform | Yes | Yes | Tie |
| Rust binding maturity | New | Stable | **Piper** |

### Configuration
```rust
// Cargo.toml
piper-rs = "0.2"
rodio = "0.19"

// tts.rs — default voice
const DEFAULT_VOICE: &str = "en_US-amy-medium";
// Model: ~63 MB, 22050 Hz, MOS 4.0-4.3
// Auto-downloads from HuggingFace on first speak (one-time)
```

### Implementation Details

#### Lazy Loading (Same Pattern as Kokoro)
```rust
// tts.rs
pub fn speak_text(text: &str) -> Result<(), String> {
    ensure_engine_loaded()?;  // First call: 85ms, subsequent: 0ms
    // ... synthesize and play via rodio
}

fn ensure_engine_loaded() -> Result<(), String> {
    if ENGINE_LOADED.load(Ordering::Relaxed) {
        return Ok(());
    }
    // Download model if not present (one-time, ~63 MB)
    // Load model into memory (~80 MB)
    ENGINE_LOADED.store(true, Ordering::Relaxed);
    Ok(())
}
```

#### Cached Acknowledgement (`speak_cached`)
For instant "On it sir" without even the 85ms load time:
```rust
// Pre-cached at startup in RAM
static ACK_CACHE: OnceCell<Vec<f32>> = OnceCell::new();

#[tauri::command]
pub fn speak_cached(phrase: &str) -> Result<(), String> {
    if let Some(samples) = ACK_CACHE.get() {
        // Play directly from RAM — 0ms load, ~5ms to start playback
        play_samples(samples);
        return Ok(());
    }
    // Fallback: generate and cache
    let samples = synthesize(phrase)?;
    ACK_CACHE.set(samples.clone()).ok();
    play_samples(&samples);
    Ok(())
}
```

### RAM Impact Table (Piper Era)

| State | nexus.exe | WebView2 | STT Python | Piper | **Total** |
|-------|-----------|----------|------------|-------|-----------|
| Idle (cold) | 47.8 MB | 35.8 MB | 20.6 MB | 0 MB | **104.2 MB** |
| Idle (after STT) | 47.8 MB | 35.8 MB | 128.6 MB | 0 MB | **232.2 MB** |
| Active (after TTS) | 47.8 MB | 35.8 MB | 128.6 MB | 80 MB | **293.2 MB** |

**Savings vs Kokoro: 289 MB (582 → 293 MB)**

### Frontend Changes

#### `ttsPlayer.ts` — Voice IDs Updated
```typescript
// Before (Kokoro)
const voiceId = settings?.ttsVoice || "af_sky";

// After (Piper)
const voiceId = settings?.ttsVoice || "en_US-amy-medium";
```

#### `ttsPlayer.ts` — `speakCached()` Added
```typescript
export async function speakCached(phrase: string, onEnd?: () => void): Promise<void> {
  // ... meeting mode check ...
  try {
    await invoke("speak_cached", { phrase });
    onEnd?.();
  } catch (e) {
    // Fallback to regular speak if cached phrase not available
    return speak(phrase, onEnd);
  }
}
```

### Installer Impact
- Model auto-downloads from HuggingFace on first speak (not bundled)
- Installer size unchanged (~57 MB .exe, ~81 MB .msi)
- `espeak-ng-data` still bundled (Piper dependency for phonemization)
- Resource config: `resources/espeak-ng-data/**/*`

### Testing
- `cargo test --lib`: 104 tests pass (includes TTS synthesis tests)
- Manual: "On it sir" plays in < 10ms from cache
- Manual: First TTS phrase loads in ~85ms (imperceptible)
- CI: macOS and Windows builds pass with Piper

---

## Future Considerations

### Potential: Piper ONNX Direct
Currently `piper-rs` wraps the C++ Piper library. A pure-ONNX approach
(like we use for wake word with `tract-onnx`) would:
- Remove the C++ dependency
- Simplify cross-compilation
- Reduce binary size
- But: no Rust crate exists yet for this

### Potential: Voice Cloning
Piper supports custom voice models. A future feature could:
- Record 5 minutes of the user's voice
- Train a custom Piper model
- Ship as a personalized voice assistant

### Potential: Streaming TTS
Piper supports chunked synthesis. Currently we synthesize the full
utterance before playback. Streaming would:
- Reduce time-to-first-audio for long responses
- Allow barge-in mid-sentence more gracefully
- But: requires rodio streaming sink (not currently implemented)

---

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | `kokoro-rs` → `piper-rs` |
| `src-tauri/src/tts.rs` | Full rewrite: Piper synthesis, lazy load, `speak_cached` |
| `frontend/src/audio/ttsPlayer.ts` | Voice IDs, `speakCached()` export |
| `frontend/src/audio/recorder.ts` | `speak("On it sir")` → `speakCached("On it sir")` |
| `src-tauri/src/lib.rs` | Register `speak_cached` Tauri command |
| `AGENTS.md` | Updated RAM table, TTS section |

## Lessons Learned

1. **RAM is the enemy of desktop apps.** 350 MB for TTS alone was unsustainable.
   Users with 8 GB RAM machines would see NEXUS as a hog.
2. **Cold load time matters for UX.** 1.7s is perceptible; 85ms is not.
3. **Cache the hot path.** "On it sir" is said 50+ times per session. Caching
   it in RAM as raw PCM samples eliminates all synthesis overhead.
4. **Auto-download > bundle.** A 63 MB model in the installer bloats it.
   Auto-downloading on first use keeps the installer small and lets users
   skip TTS entirely if they don't need it.
5. **Don't over-engineer voice quality.** MOS 4.0 vs 4.3 is indistinguishable
   to most users. The 270 MB RAM savings far outweigh the marginal quality
   difference.
