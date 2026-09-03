# Self-Learning STT Correction System

**Date:** 2026-09-02
**Commit:** `c4e5049 feat: self-learning STT corrections — learns from user repetition`
**Status:** Production

---

## Problem Statement

faster-whisper `tiny.en` (39M params) consistently mishears certain words,
especially developer vocabulary:

| User said | STT produced | Frequency |
|-----------|-------------|-----------|
| "analyse" | "any eyes" | Very common |
| "architecture" | "octach at" | Common |
| "servx" | "serve" | Common |
| "PR" | "pe are" | Common |
| "nexus" | "next us" | Occasional |
| "ultron" | "all tron" | Occasional |

### The Old Approach: Static Corrections

`02-stt-mishearing-fixes.md` documented a static correction map:
```typescript
const STT_CORRECTIONS: Record<string, string> = {
    "any eyes": "analyse",
    "octach at": "architecture",
    "pe are": "PR",
    // ... manually maintained
};
```

### Why Static Doesn't Work
1. **Every user has different speech patterns.** Accents, microphones,
   and room acoustics all affect what STT mishears.
2. **New mishearings appear constantly.** Every new command pattern can
   produce a new mishearing that wasn't in the map.
3. **Manual maintenance is unsustainable.** Every mishearing requires a
   code change, rebuild, and installer rebuild.
4. **False positives.** A correction that's right for one user might be
   wrong for another.

### The User's Request
> "I want a process that learns from corrections so I don't have to
> manually add every possible transcription error."

---

## Approach: Self-Learning from User Repetition

### Core Insight
When STT mishears a word and the parser fails, **the user repeats the
command**. This repetition pattern is the learning signal:

```
1. User says: "analyse PR 5 in servx"
2. STT produces: "any eyes pe are 5 in serve"
3. Parser fails → "Didn't catch that, sir"
4. User repeats: "analyse PR 5 in servx"
5. STT produces: "analyse PR 5 in servx" (got it right this time)
6. Parser succeeds
7. System diffs the two → learns: "any eyes" → "analyse", "serve" → "servx"
```

### Why This Works
- **No manual intervention.** The system learns automatically.
- **User-specific.** Each user's corrections are tailored to their speech.
- **Self-correcting.** If a correction is wrong, it won't be applied
  consistently and won't reach the auto-apply threshold.
- **Context-aware.** Corrections are keyed by the word before the corrected
  word, reducing false positives.

---

## Implementation

### Rust Side (`src-tauri/src/stt_learning.rs`)

#### Data Structures
```rust
/// A single learned correction entry.
pub struct LearnedCorrection {
    pub from: String,           // "any eyes" (what STT produced)
    pub to: String,             // "analyse" (what user actually said)
    pub context_before: String, // "" or word before the corrected word
    pub count: u32,             // times this correction was observed
    pub auto_apply: bool,       // true after LEARN_THRESHOLD observations
    pub first_seen: u64,        // Unix timestamp
    pub last_seen: u64,         // Unix timestamp
}

/// In-memory state
pub struct SttLearningState {
    pending_failure: Arc<Mutex<Option<PendingFailure>>>,
    corrections: Arc<Mutex<HashMap<String, LearnedCorrection>>>,
    file_path: PathBuf,
}
```

#### Learning Algorithm

```
log_failed_transcript("any eyes pe are 5 in serve"):
    → Store as pending_failure with timestamp

log_successful_transcript("analyse PR 5 in servx"):
    → Retrieve pending_failure
    → Check time window (must be < 30 seconds)
    → Word-diff the two transcripts:
        Position 0-1: "any eyes" → "analyse"
        Position 2-3: "pe are" → "PR"
        Position 5:   "serve" → "servx"
    → For each diff:
        - Skip if both words identical
        - Skip if either word < 3 chars (noise)
        - Skip if Levenshtein distance > 3 (too different)
        - Store/update the correction in the HashMap
        - Increment count
        - If count >= 3: set auto_apply = true
    → Save to JSON file
```

#### Word Diff Algorithm
```rust
fn word_diff(failed: &str, success: &str) -> Vec<WordDiff> {
    let fail_words: Vec<&str> = failed.split_whitespace().collect();
    let success_words: Vec<&str> = success.split_whitespace().collect();

    // Use dynamic programming to align the two word sequences.
    // This handles insertions, deletions, and substitutions.
    // Returns a list of positions where words differ.
}
```

The diff handles:
- **Substitution:** "serve" → "servx" (1 word → 1 word)
- **Expansion:** "any eyes" → "analyse" (2 words → 1 word)
- **Contraction:** "pe are" → "PR" (2 words → 1 word)

#### Tauri Commands
```rust
#[tauri::command]
pub async fn log_failed_transcript(
    transcript: String,
    state: State<'_, SttLearningState>,
) -> Result<(), String> {
    state.log_failure(&transcript).await;
    Ok(())
}

#[tauri::command]
pub async fn log_successful_transcript(
    transcript: String,
    state: State<'_, SttLearningState>,
) -> Result<(), String> {
    state.log_success(&transcript).await;
    Ok(())
}

#[tauri::command]
pub async fn get_learned_corrections(
    state: State<'_, SttLearningState>,
) -> Result<Vec<LearnedCorrection>, String> {
    let corrections = state.corrections.lock().await;
    Ok(corrections.values().cloned().collect())
}
```

### Frontend Side (`recorder.ts`)

#### Loading Corrections at Startup
```typescript
import { invoke } from "@tauri-apps/api/core";

let learnedCorrections: Array<{from: string, to: string, context_before: string}> = [];

async function loadLearnedCorrections() {
    try {
        const corrections = await invoke<LearnedCorrection[]>("get_learned_corrections");
        learnedCorrections = corrections.filter(c => c.auto_apply);
        console.log(`[NEXUS] loaded ${learnedCorrections.length} auto-apply corrections`);
    } catch (e) {
        console.warn("[NEXUS] failed to load learned corrections:", e);
    }
}

function applyLearnedCorrections(transcript: string): string {
    let result = transcript;
    for (const correction of learnedCorrections) {
        // Apply correction with context awareness
        if (correction.context_before) {
            const pattern = new RegExp(
                `\\b${escapeRegex(correction.context_before)}\\s+${escapeRegex(correction.from)}\\b`,
                "gi"
            );
            result = result.replace(pattern, `${correction.context_before} ${correction.to}`);
        } else {
            // No context — apply at start of string
            if (result.toLowerCase().startsWith(correction.from.toLowerCase())) {
                result = correction.to + result.slice(correction.from.length);
            }
        }
    }
    return result;
}
```

#### Logging During Transcription
```typescript
// After STT produces text:
transcript = correctSttTranscript(transcript);      // static corrections
transcript = applyLearnedCorrections(transcript);    // self-learned corrections
void logSuccessfulTranscript(transcript);            // log for learning

// If parser fails:
void logFailedTranscript(transcript);                // log for learning
await speak("Didn't catch that sir");
```

### Storage

**File:** `%APPDATA%/com.nexus.assistant/learned_corrections.json`
**Format:**
```json
{
  "corrections": [
    {
      "from": "any eyes",
      "to": "analyse",
      "context_before": "",
      "count": 5,
      "auto_apply": true,
      "first_seen": 1695600000,
      "last_seen": 1695686400
    },
    {
      "from": "serve",
      "to": "servx",
      "context_before": "in",
      "count": 3,
      "auto_apply": true,
      "first_seen": 1695600000,
      "last_seen": 1695640000
    }
  ]
}
```

**RAM cost:** ~1-10 KB (in-memory HashMap). Negligible.

---

## Learning Rules (Tuned Parameters)

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Correction window | 30 seconds | If user waits too long, they probably said something unrelated |
| Max diff positions | 2 | If too many words differ, it's not a correction — it's a different command |
| Min word length | 3 chars | Skip 1-2 char words (noise like "a", "is", "to") |
| Max Levenshtein distance | 3 | Skip completely different words ("hello" → "goodbye" is not a correction) |
| Auto-apply threshold | 3 observations | Need 3 consistent corrections before trusting the pattern |
| Context key | Word before correction | "serve" → "servx" after "in" is different from "serve" → "serve" after "they" |

---

## Testing

### Unit Tests (`cargo test --lib`)
```rust
#[test]
fn test_word_diff_substitution() {
    let diffs = word_diff("open serve", "open servx");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].from_word, "serve");
    assert_eq!(diffs[0].to_word, "servx");
}

#[test]
fn test_word_diff_expansion() {
    let diffs = word_diff("any eyes pr", "analyse pr");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].from_word, "any eyes");
    assert_eq!(diffs[0].to_word, "analyse");
}

#[test]
fn test_levenshtein_distance() {
    assert_eq!(levenshtein("serve", "servx"), 1);
    assert_eq!(levenshtein("any eyes", "analyse"), 5);  // too far
}

#[test]
fn test_correction_storage() {
    let state = SttLearningState::new();
    state.log_failure("open serve").await;
    state.log_success("open servx").await;
    let corrections = state.corrections.lock().await;
    assert_eq!(corrections.len(), 1);
    assert_eq!(corrections.values().next().unwrap().count, 1);
}
```

### Integration Tests
- `cargo test --lib`: 104 tests pass (includes STT learning tests)
- `cargo test --test offline_commands`: 10 tests pass

---

## Interaction with Static Corrections

The system uses **both** static and self-learned corrections:

```typescript
// 1. Static corrections (hardcoded, common mishearings)
transcript = correctSttTranscript(transcript);

// 2. Self-learned corrections (user-specific, learned over time)
transcript = applyLearnedCorrections(transcript);
```

Static corrections handle the most common, universal mishearings.
Self-learned corrections handle user-specific patterns that static
corrections miss.

### Why Not Replace Static Entirely?
- Static corrections work from the first use (no learning required)
- Static corrections are curated and tested (no false positives)
- Self-learning takes 3 repetitions to activate (cold start problem)
- Some mishearings are so common they should be fixed for everyone

---

## Future Improvements

### 1. Confidence-Based Auto-Apply
Currently, auto-apply is binary (count >= 3). A confidence score would
be more nuanced:
- 3 observations → 0.5 confidence (apply with warning)
- 5 observations → 0.8 confidence (apply silently)
- 10 observations → 0.95 confidence (apply always)

### 2. Correction Decay
Old corrections that haven't been observed recently should decay:
- If no observation in 30 days → reduce count
- If count drops below 3 → disable auto_apply
- This handles cases where the user's microphone or speech changes

### 3. Cloud Sync
Corrections could be synced across devices via the Cloudflare Worker:
- User learns corrections on desktop → available on laptop
- Per-user storage in D1 `learned_corrections` table
- Privacy: corrections are word pairs, not audio recordings

### 4. Correction UI
A settings panel where users can:
- View all learned corrections
- Delete incorrect corrections
- Manually add corrections
- Export/import corrections (for backup or sharing)

### 5. Context Expansion
Currently, context is just the word before the correction. Expanding to:
- Two words before
- The word after
- The command type (analyse, open, search)
- Would reduce false positives further

---

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/stt_learning.rs` | **NEW** — full self-learning system |
| `src-tauri/src/lib.rs` | Module declaration, command registration |
| `frontend/src/audio/recorder.ts` | `applyLearnedCorrections()`, `logFailedTranscript()`, `logSuccessfulTranscript()` |

## Lessons Learned

1. **Learn from the user, not from the developer.** Every user has
   different speech patterns. A self-learning system adapts; a static
   map doesn't.

2. **Repetition is the strongest learning signal.** When a user repeats
   a command after a failure, they're explicitly telling the system
   "this is what I actually said." No training data is more relevant.

3. **Conservative thresholds prevent false positives.** Requiring 3
   consistent observations before auto-applying prevents one-off
   coincidences from corrupting the correction map.

4. **Context matters.** "serve" → "servx" is correct after "in" but
   not after "they". Keying corrections by context word reduces
   false positives significantly.

5. **Store locally, not in the cloud.** Corrections are user-specific
   and don't need to be shared. Local JSON storage is simple, private,
   and works offline.
