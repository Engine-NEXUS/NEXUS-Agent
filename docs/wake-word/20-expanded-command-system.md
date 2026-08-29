# Expanded Command System — Type 1 + Type 2 Commands

## Overview

NEXUS supports two types of voice commands detected by acoustic classifiers:

| Type | Example | STT needed? | Response time |
|------|---------|-------------|---------------|
| **Type 1 (Fixed)** | "open youtube", "mute volume" | No | ~200ms |
| **Type 2 (Parameterized)** | "play despacito in spotify" | Yes (parameter only) | ~2-4s |
| **Type 3 (Open-ended)** | "what's the weather?" | Yes (full transcript) | ~4-6s |

Type 1 and Type 2 are handled by acoustic classifiers (Tier 3).
Type 3 falls through to the wake → STT → backend flow.

## Type 1: Fixed Commands

Fixed commands have no variable parameter. The acoustic classifier detects the
entire phrase and fires the intent directly.

**Flow:**
```
User speaks "open youtube"
  → Acoustic classifier fires (~200ms)
  → Rust emits command-detected event
  → Frontend invokes execute_command
  → Rust opens YouTube
  → Frontend speaks "Ok sir"
  → Total: ~200ms
```

**Intent JSON:**
```json
{
  "action": "open_app",
  "target": "youtube",
  "needs_param": false
}
```

## Type 2: Parameterized Commands

Parameterized commands have a variable parameter (song name, search query).
The acoustic classifier detects the command PATTERN, then the frontend records
3 seconds of audio and runs STT to get the parameter.

**Flow:**
```
User speaks "play despacito in spotify"
  → Acoustic classifier detects "play ... in spotify" pattern (~200ms)
  → Rust emits command-detected event with needs_param=true
  → Frontend speaks "On it sir"
  → Frontend records 3 seconds of audio
  → Frontend runs STT on the 3s recording → "despacito"
  → Frontend invokes execute_command with {action: "spotify_play", query: "despacito"}
  → Rust opens Spotify with search query
  → Total: ~2-4s (STT runs while user is still speaking)
```

**Intent JSON:**
```json
{
  "action": "spotify_play",
  "target": "",
  "needs_param": true
}
```

**Why ~2 seconds?**

The acoustic classifier fires ~200ms into the phrase (as soon as it hears the
pattern). STT starts on the buffered audio WHILE the user is still speaking.
By the time the user finishes saying "despacito", STT is already done or nearly
done. The total perceived time from end of speech to action is ~400ms.

## Command List (39 total)

### Category A: Fixed Commands (30)

| Phrase | Intent Action | Target |
|--------|--------------|--------|
| open youtube | open_app | youtube |
| open gmail | open_app | gmail |
| open chrome | open_app | chrome |
| open notepad | open_app | notepad |
| open calculator | open_app | calculator |
| open spotify | open_app | spotify |
| open discord | open_app | discord |
| open github | open_app | github |
| open vs code | open_app | vscode |
| open figma | open_app | figma |
| open slack | open_app | slack |
| open notion | open_app | notion |
| open terminal | open_app | terminal |
| open explorer | open_app | explorer |
| open settings | open_app | settings |
| open twitter | open_app | twitter |
| open reddit | open_app | reddit |
| open whatsapp | open_app | whatsapp |
| open netflix | open_app | netflix |
| open claude | open_app | claude |
| open chatgpt | open_app | chatgpt |
| open steam | open_app | steam |
| open outlook | open_app | outlook |
| mute volume | volume_mute | — |
| take screenshot | screenshot | — |
| lock screen | lock | — |
| new tab | browser_new_tab | — |
| close tab | browser_close_tab | — |
| next tab | browser_next_tab | — |
| go back | browser_back | — |

### Category B: Parameterized Commands (9)

| Acoustic trigger | Parameter | Intent Action | Example |
|-----------------|-----------|--------------|---------|
| play song in spotify | song name | spotify_play | "play despacito in spotify" |
| search on youtube | search query | youtube_search | "search cat videos on youtube" |
| search on google | search query | google_search | "search best laptops on google" |
| search on github | search query | github_search | "search react hooks on github" |
| play on youtube | video name | youtube_play | "play lofi music on youtube" |
| send message to | contact name | send_message | "send message to mom" |
| set timer for | duration | set_timer | "set timer for ten minutes" |
| set alarm for | time | set_alarm | "set alarm for 7 am" |
| create event | event name | create_event | "create event meeting tomorrow" |

## RAM Analysis

### Per-model memory (tract-onnx inference)

| Component | On Disk | In Memory | Shared? |
|-----------|---------|-----------|---------|
| melspectrogram.onnx | 1.1 MB | ~3 MB | Yes (all classifiers) |
| embedding_model.onnx | 1.3 MB | ~4 MB | Yes (all classifiers) |
| nexus.onnx (wake) | 0.8 MB | ~2 MB | No |
| Each command classifier | 0.8 MB | ~2 MB | No |

### Total RAM by command count

| Config | Models | On Disk | In Memory | CPU per 80ms chunk |
|--------|--------|---------|-----------|-------------------|
| 10 commands | 12 total | 11.2 MB | ~31 MB | 3.5 ms (4%) |
| 39 commands | 41 total | 34.2 MB | ~89 MB | 5.0 ms (6%) |
| 100 commands | 102 total | 83.2 MB | ~211 MB | 8.0 ms (10%) |

The 80ms real-time budget is never exceeded, even with 100 classifiers.

### Training vs Inference RAM

| Resource | Colab (Training) | Local (Inference) |
|----------|-----------------|-------------------|
| ACAV100M negatives | 17 GB | 0 MB |
| FMA noise dataset | 8 GB | 0 MB |
| MIT RIRs | 0.5 GB | 0 MB |
| Piper TTS clips | 2 GB | 0 MB |
| PyTorch + gradients | 6 GB | 0 MB |
| ONNX models | — | 0.8 MB × N |
| tract-onnx engine | — | ~5 MB |
| **Total** | **~33 GB** | **~30-90 MB** |

Training data never touches the local machine. Only the final 800KB `.onnx`
files are downloaded.

## Colab Training

### Key fix: config keys

openWakeWord's `train.py` accesses config keys unconditionally (no `.get()` with
defaults). The previous notebook omitted `background_paths` and
`background_paths_duplication_rate` when FMA was unavailable, causing a
KeyError. The fix: always include ALL required keys, using empty lists when
data is unavailable. `augment_clips()` handles empty lists gracefully.

### Required config keys (always present)

```yaml
target_phrase: ["open youtube"]
model_name: open_youtube
custom_negative_phrases: [...]
n_samples: 2000
n_samples_val: 1000
tts_batch_size: 50
piper_sample_generator_path: /content/piper-sample-generator
augmentation_rounds: 1
augmentation_batch_size: 16
background_paths: []           # empty when FMA unavailable
background_paths_duplication_rate: []  # empty when FMA unavailable
rir_paths: []                  # empty when RIRs unavailable
output_dir: /content/open_youtube_output
onnx_export: true
tflite_export: false
feature_data_files: {}         # empty when ACAV unavailable
false_positive_validation_data_path: ""  # empty when ACAV unavailable
```

### Resume capability

The notebook saves each model to Google Drive as it completes. If the session
disconnects, re-running the notebook:
1. Re-mounts Google Drive
2. Detects already-trained models (in Drive)
3. Skips them and resumes from where it left off
4. `command_intents.json` is always generated from the full COMMANDS list

### Error handling

- Each command is wrapped in try/except
- If one command fails, the notebook continues to the next
- Failed commands are listed at the end
- Full train.py output is captured (not just `tail -5`) for debugging
- Feature files are size-checked before proceeding

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Audio Pipeline (80ms chunks)              │
│                                                              │
│  Mic → cpal → resample 16kHz → melspectrogram → embedding   │
│                                              │               │
│                    ┌────────────────────────┘               │
│                    │                                        │
│         ┌──────────┼──────────┐                             │
│         ▼          ▼          ▼                             │
│    Wake Word    Command    Command    ... (N classifiers)   │
│    Classifier   Class A    Class B                          │
│    (nexus.onnx) (fixed)    (param)                          │
│         │          │          │                             │
│         ▼          ▼          ▼                             │
│    wake event   execute   trigger param capture             │
│                  directly   + STT for parameter             │
└─────────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `train_nexus_commands.ipynb` | Colab training notebook |
| `src-tauri/src/wakeword_oww.rs` | Acoustic classifier engine + CommandIntent |
| `src-tauri/src/command_executor.rs` | Intent execution (all actions) |
| `frontend/src/main.tsx` | command-detected event listener |
| `frontend/src/audio/paramCapture.ts` | Parameter recording for Type 2 |
| `frontend/src/audio/stt.ts` | Local STT (faster-whisper) |
| `src-tauri/resources/oww/commands/` | Trained .onnx models + command_intents.json |
