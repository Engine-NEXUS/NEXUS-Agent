# Tier 3: Direct Audio-to-Command Classification

> Skip ASR entirely for known commands. When the user says "open youtube",
> a compact classifier detects it directly from audio and executes the action
> in ~200ms — no Whisper, no transcript, no 27-second delay.

## Problem

Current pipeline for "open youtube":

```
Audio → Whisper base (CPU) → "open youtube" → Intent Parser → Execute
         27 seconds              0.1ms            0.3ms
```

- Whisper `base` on CPU takes ~27 seconds for a short command
- Prone to hallucination ("open youtube open youtube youtube youtube...")
- 469 MB peak RAM, 1.5 GB private memory
- No GPU available (Intel Iris Xe integrated graphics only)

## Solution: openWakeWord Command Classifiers

NEXUS already has the full openWakeWord (OWW) pipeline running for wake-word
detection (`wakeword_oww.rs`). The same pipeline can detect spoken commands
directly from audio — no ASR needed.

### Architecture

```
                    Audio (16kHz mono, 80ms chunks)
                                   │
                    ┌──────────────▼──────────────────┐
                    │   melspectrogram.onnx (shared)   │
                    │   → 80-dim mel features          │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │   embedding_model.onnx (shared)  │
                    │   → 96-dim embeddings            │
                    └──────────────┬──────────────────┘
                                   │
               ┌───────────────────┼───────────────────┐
               │                   │                   │
    ┌──────────▼─────────┐ ┌──────▼───────┐ ┌─────────▼──────────┐
    │ nexus.onnx         │ │ open_yt.onnx │ │ open_gmail.onnx    │
    │ (wake word)        │ │ (command)    │ │ (command)          │
    │ → P("nexus")       │ │ → P("open yt")│ │ → P("open gmail") │
    └────────────────────┘ └──────────────┘ └────────────────────┘
               │                   │                   │
               │           If P > 0.5 → execute directly
               │           (NO ASR — skip STT entirely)
               │
    If P > 0.5 → wake → listen via STT (fallback for unknown commands)
```

### Resource Comparison

| Metric | Current (Whisper base) | Tier 3 (OWW classifiers) |
|--------|------------------------|--------------------------|
| Latency | 27 seconds | ~200ms |
| RAM | 469 MB peak | ~5 MB per model |
| Model size | 75 MB | ~800 KB per model |
| CPU | High (full Whisper) | Low (tiny DNN) |
| Accuracy | Prone to hallucination | Binary classifier |
| GPU needed | No | No |

### How It Works

1. **Audio enters the OWW pipeline** (already running for wake-word detection)
2. **Melspectrogram + embedding models** extract features (shared with wake word)
3. **Each command classifier** scores the features in parallel
4. **If any command scores > 0.5**: emit a `command-detected` Tauri event
5. **Frontend receives the event**: skips STT, goes directly to `execute_command`
6. **If no command matches**: fall back to the existing STT → intent → execute path

### What Commands Are Supported

The initial set (trained via `train_nexus_commands.ipynb`):

| Command | Model | Intent |
|---------|-------|--------|
| "open youtube" | `open_youtube.onnx` | `{action: "open_app", target: "youtube"}` |
| "open gmail" | `open_gmail.onnx` | `{action: "open_app", target: "gmail"}` |
| "open chrome" | `open_chrome.onnx` | `{action: "open_app", target: "chrome"}` |
| "open notepad" | `open_notepad.onnx` | `{action: "open_app", target: "notepad"}` |
| "open calculator" | `open_calculator.onnx` | `{action: "open_app", target: "calculator"}` |
| "open spotify" | `open_spotify.onnx` | `{action: "open_app", target: "spotify"}` |
| "open discord" | `open_discord.onnx` | `{action: "open_app", target: "discord"}` |
| "open github" | `open_github.onnx` | `{action: "open_app", target: "github"}` |
| "open vscode" | `open_vscode.onnx` | `{action: "open_app", target: "vscode"}` |
| "open figma" | `open_figma.onnx` | `{action: "open_app", target: "figma"}` |

Each model is ~800 KB. Adding more commands is just training more models.

## Training

### Google Colab Notebook

**File**: `train_nexus_commands.ipynb`

This notebook trains all 10 command classifiers in a single Colab session.

**How it works**:
1. Setup (install + downloads): ~30 min — done ONCE
2. For each command (~15-25 min each):
   - Generate Piper TTS clips of the command phrase
   - Generate adversarial negative clips (soundalikes)
   - Augment with noise + reverb
   - Extract features (melspectrogram → embedding)
   - Train DNN classifier (3-stage curriculum)
   - Ensemble best checkpoints
   - Export ONNX with sigmoid baked in
   - Auto-download the `.onnx` file

**Colab requirements**:
- T4 GPU (free tier) or L4 GPU (Colab Pro)
- ~4-6 hours for 10 commands
- ~25 GB disk (FMA + ACAV100M + clips)

**Key optimization**: The expensive downloads (FMA 8GB, ACAV100M 17GB, MIT RIRs)
are done ONCE at the start. Each command only needs ~2000 TTS clips + training,
which takes ~15-25 min.

### Cross-command negative training

Each command model is trained with:
- Its own adversarial negatives (soundalikes from the `negatives` list)
- ACAV100M continuous speech (general negative corpus)
- **All other command phrases as negatives** — so "open youtube" doesn't
  trigger the "open gmail" model

This is critical: without cross-command negatives, all "open X" models would
fire simultaneously whenever the user says any "open X" command.

### After Training

Place all `.onnx` files and `command_intents.json` at:

```
src-tauri/resources/oww/commands/
  ├── open_youtube.onnx
  ├── open_gmail.onnx
  ├── ...
  └── command_intents.json
```

## Integration (Rust + Frontend)

### Rust: `wakeword_oww.rs`

The `WakeEngine` is extended to load multiple classifier models:

```rust
pub struct WakeEngine {
    pub classifier: ModelType,           // nexus.onnx (wake word)
    pub command_classifiers: Vec<(String, ModelType)>,  // command models
    pub command_intents: HashMap<String, Intent>,       // model_name → intent
    pub audio_features: AudioFeatures,   // shared melspectrogram + embedding
    // ... existing fields ...
}
```

On each 80ms chunk:
1. Extract features (shared, once per chunk)
2. Run wake-word classifier → if > 0.5, trigger wake
3. Run each command classifier → if any > 0.5, emit `command-detected` event

### Frontend: `main.tsx`

Listen for `command-detected` Tauri event:

```typescript
listen("command-detected", (event) => {
  const intent = event.payload.intent;
  // Skip STT entirely — execute directly
  invoke("execute_command", { intent });
});
```

### Fallback to STT

If no command classifier fires, the existing flow continues:
1. VAD detects speech end
2. Audio sent to local STT server
3. Transcript parsed by intent parser
4. Intent executed

This means:
- **Known commands**: ~200ms (OWW direct)
- **Unknown commands**: ~2-3s (STT with `tiny` model + `beam_size=1`)
- **Complex queries**: ~2-3s (STT → backend)

## Safety

- **Confidence threshold**: 0.5 (configurable)
- **Refractory period**: 2 seconds between detections
- **Cross-command negatives**: prevents false triggers from similar commands
- **STT fallback**: always available for anything the classifiers don't cover
- **Feature flag**: `wakeword-commands` cargo feature gates the entire system
- **No breaking changes**: existing wake-word + STT + intent + execute path unchanged

## Testing

| Test | What it verifies |
|------|-----------------|
| Say "open youtube" | Command model fires, YouTube focuses/launches in <500ms |
| Say "open gmail" | Correct model fires, Gmail opens |
| Say "what's the weather" | No command model fires, falls back to STT |
| Say "open youtube" while YouTube is open | Focuses existing window (Tier 1) |
| Say "open youtube" while YouTube is not open | Launches new instance (Tier 2) |
| Say "open xyz" (unknown app) | Falls back to STT → URL fallback (Tier 3) |
| Say nothing | No false positives |
| Say "open" alone | No false positives (too short) |
| RAM before/after | <30 MB added for 10 command models |
| Latency before/after | 27s → 200ms for known commands |

## Cross-References

- [05-oww-3-stage-pipeline.md](./05-oww-3-stage-pipeline.md) — OWW pipeline architecture
- [06-model-training.md](./06-model-training.md) — Wake-word training overview
- [13-colab-training-notebook.md](./13-colab-training-notebook.md) — Wake-word Colab notebook
- [14-model-validation-results.md](./14-model-validation-results.md) — Wake-word validation
- `train_nexus_commands.ipynb` — Command classifier training notebook
- `src-tauri/src/wakeword_oww.rs` — OWW Rust integration
- `frontend/src/intent/parser.ts` — Intent parser (used for STT fallback)
