# Tier 3 Training Approach: Options & Decision

> How we chose to train the Tier 3 command classifiers.
> Compares 4 training approaches and explains why we chose the
> openWakeWord multi-model approach with Google Colab.

---

## 1. The Training Challenge

We need to train ~10 small classifier models, one per command phrase:
- "open youtube" → `open_youtube.onnx`
- "open gmail" → `open_gmail.onnx`
- "open chrome" → `open_chrome.onnx`
- etc.

Each model must:
- Detect its phrase from continuous audio (not just isolated clips)
- Reject similar-sounding phrases (false positive control)
- Reject other command phrases (cross-command discrimination)
- Run in ~80ms on CPU with <5 MB RAM
- Export to ONNX for tract-onnx inference in Rust

---

## 2. Training Options Considered

### Option A: Single Multi-class Classifier

**Description:**
Train one model that classifies audio into N+1 classes:
- Class 0: "open youtube"
- Class 1: "open gmail"
- Class 2: "open chrome"
- ...
- Class N: "none of the above" (negative)

**Pros:**
- Single model to load and run
- Cross-command discrimination is automatic (softmax)
- Less RAM (one classifier head)

**Cons:**
- Adding a new command requires **retraining the entire model**
- Single point of failure (if model is bad, all commands fail)
- Larger model (N output classes instead of 1)
- Can't selectively enable/disable individual commands
- Training is harder (class imbalance, more data needed per class)

**Verdict:** ❌ **Rejected** — inflexible, adding commands requires full retrain

---

### Option B: Per-Command Binary Classifiers (OWW-style)

**Description:**
Train one binary classifier per command phrase. Each model outputs
a single probability: "is this phrase being spoken right now?"

This is exactly what openWakeWord does for wake words — we just train
multiple models, one per command.

**Pros:**
- **Adding a command = training one new model** (no retrain of others)
- Can enable/disable individual commands by loading/unloading models
- Each model is tiny (~800 KB, 1M params)
- Same training pipeline as the wake word (proven, documented)
- Same runtime (tract-onnx, already integrated)
- Models run in parallel on shared features (melspectrogram + embedding)
- Failure of one model doesn't affect others

**Cons:**
- Need to train N separate models (but each is fast, ~15-25 min)
- Cross-command negatives must be explicitly added to training data
- Slightly more RAM than a single multi-class model (N classifier heads)

**Verdict:** ✅ **CHOSEN** — flexible, reuses existing pipeline, proven approach

---

### Option C: Fine-tune a Pre-trained ASR Model

**Description:**
Take a pre-trained ASR model (Whisper tiny, Zipformer) and fine-tune it
on command phrases, then use its output for intent classification.

**Pros:**
- Leverages existing ASR knowledge
- Could handle variations in pronunciation

**Cons:**
- Still produces text → still needs intent parsing
- Fine-tuning Whisper is complex and resource-intensive
- Doesn't solve the fundamental ASR → text → intent indirection
- Still has hallucination risk
- Much larger model (37+ MB vs 800 KB)
- Higher latency (full ASR inference vs binary classification)

**Verdict:** ❌ **Rejected** — doesn't solve the core problem, still has ASR issues

---

### Option D: Use a Pre-trained Command Dataset Model

**Description:**
Use a model pre-trained on the Fluent Speech Commands (FSC) dataset,
which classifies speech into action/object/location intents.

**Pros:**
- Pre-trained models exist (SpeechBrain, c-jg/slu)
- 95-99% accuracy on FSC test set
- No training needed (just download and use)

**Cons:**
- FSC is smart-home commands ("turn on lights"), not app-launching
- No pre-trained model for "open youtube", "open gmail", etc.
- Would need to train a new model on custom data anyway
- Different model architecture (not OWW-compatible)
- Would need a different runtime (not tract-onnx)
- FSC intents (action/object/location) don't map cleanly to NEXUS intents

**Verdict:** ❌ **Rejected** — no relevant pre-trained model exists

---

## 3. Comparison Matrix

| Criteria | A: Multi-class | B: Per-command (OWW) | C: Fine-tune ASR | D: Pre-trained FSC |
|----------|---------------|---------------------|------------------|-------------------|
| **Model size** | ~2 MB (one model) | **~0.8 MB each** | 37+ MB | 7 MB |
| **Latency** | ~80ms | **~80ms (parallel)** | 2-4s | ~50ms |
| **Add new command** | Full retrain | **Train one model** | Full retrain | N/A |
| **Cross-command discrimination** | Automatic (softmax) | **Explicit negatives** | Via text matching | N/A |
| **Reuses existing pipeline** | Partial | **Yes (OWW)** | No | No |
| **Runtime** | tract-onnx | **tract-onnx (existing)** | CTranslate2 | PyTorch/ONNX |
| **Training time** | ~2-3 hrs (all at once) | **~15-25 min each** | ~4-8 hrs | N/A |
| **RAM** | ~5 MB | **~2.5 MB each** | ~200 MB | ~15 MB |
| **Hallucination risk** | None | **None** | High | None |
| **Handles queries** | No | **No (STT fallback)** | Yes | No |
| **Implementation effort** | High | **Low (extend existing)** | High | High |

---

## 4. The Decision: Option B (Per-command OWW classifiers)

### Why per-command binary classifiers

1. **Reuses the existing OWW pipeline 100%**:
   - Same melspectrogram model
   - Same embedding model
   - Same tract-onnx runtime
   - Same audio capture + resampling
   - Same 80ms chunk processing
   - Same detection buffer + threshold logic

2. **Incremental deployment**:
   - Start with 10 commands
   - Add more later by training new models
   - No need to retrain existing models
   - Can A/B test individual commands

3. **Proven training process**:
   - The wake-word notebook (`train_nexus_oww.ipynb`) already works
   - The new notebook (`train_nexus_commands.ipynb`) extends it
   - Same Piper TTS + FMA + ACAV100M + MIT RIR pipeline
   - Same 3-stage training curriculum
   - Same ensemble + ONNX export

4. **Failure isolation**:
   - If one command model is bad, only that command is affected
   - Other commands and the wake word continue working
   - STT fallback covers any command whose model fails

### Cross-command negative training

The critical innovation in the training notebook: each command model is
trained with **all other command phrases as negative examples**.

For example, when training `open_youtube.onnx`:
- **Positive clips**: Piper TTS saying "open youtube" (2000 clips)
- **Adversarial negatives**: "open you tube", "open utube" (soundalikes)
- **Cross-command negatives**: "open gmail", "open chrome", "open notepad", ...
- **General negatives**: ACAV100M continuous speech (2000 hours)

This ensures that saying "open gmail" does NOT trigger the `open_youtube`
model, even though both start with "open".

---

## 5. Training Infrastructure

### Google Colab

| Resource | Free Tier | Colab Pro |
|----------|-----------|-----------|
| GPU | T4 (16 GB VRAM) | L4 (24 GB VRAM) or A100 |
| System RAM | 12-13 GB | 32-52 GB (High RAM) |
| Disk | ~70 GB | ~100 GB |
| Session limit | 12 hours | 24 hours |
| Idle timeout | ~90 minutes | ~90 minutes |
| GPU hours/week | 15-30 (dynamic) | 100+ (Pro), 200+ (Pro+) |

### Why Colab works for this

1. **T4 GPU is sufficient**: The OWW DNN is tiny (1M params). Training 20K
   steps takes ~30-40 min on T4, ~15-20 min on L4.

2. **Disk is sufficient**: FMA (8 GB) + ACAV100M (17 GB) + clips (~2 GB) =
   ~27 GB, well within Colab's disk.

3. **Session length is sufficient**: 10 commands × ~20 min = ~3.5 hrs training
   + 30 min setup = ~4 hrs total. Well within the 12-hour free tier limit.

4. **Free tier is sufficient**: No need for Colab Pro. The T4 GPU is fast
   enough for these tiny models.

### What the notebook does

```
Phase 1: Setup (ONCE, ~30 min)
  ├── Install deps (piper-tts, openwakeword, torch, etc.)
  ├── Clone repos (piper-sample-generator, openwakeword)
  ├── Apply 6 runtime patches (torchaudio 2.x compat)
  ├── Download shared models (melspectrogram.onnx, embedding_model.onnx)
  ├── Download MIT RIRs (~270 room impulse responses)
  ├── Download FMA small dataset (8 GB background music)
  ├── Download ACAV100M features (17 GB negative speech corpus)
  └── Convert FMA MP3s to 16kHz WAVs

Phase 2: Per-command training (REPEATED, ~15-25 min each)
  For each command:
    ├── Generate Piper TTS clips (2000 positive + 2000 negative)
    ├── Resample 22050 → 16000 Hz
    ├── Augment (reverb + noise + volume/speed variation)
    ├── Extract features (melspectrogram → embedding → 16×96)
    ├── Train DNN (3-stage: 20K + 2K + 2K steps)
    ├── Ensemble best checkpoints (90/90/10 percentile filter)
    ├── Export ONNX with sigmoid baked in
    ├── Sanity check with onnxruntime
    └── Auto-download .onnx file

Phase 3: Export intent mapping
  └── Generate command_intents.json
```

---

## 6. Command Selection Rationale

### Initial 10 commands

| Command | Why chosen | URL fallback available? |
|---------|-----------|------------------------|
| "open youtube" | Most common video site | ✅ youtube.com |
| "open gmail" | Most common email | ✅ mail.google.com |
| "open chrome" | Most common browser | ❌ (native app) |
| "open notepad" | Common Windows app | ❌ (native app) |
| "open calculator" | Common Windows app | ❌ (native app) |
| "open spotify" | Common music app | ✅ open.spotify.com |
| "open discord" | Common chat app | ✅ discord.com/app |
| "open github" | Developer essential | ✅ github.com |
| "open vscode" | Developer essential | ❌ (native app) |
| "open figma" | Designer essential | ✅ figma.com |

### Selection criteria

1. **High frequency**: Commands the user says often (daily use)
2. **Clear phrase**: Unambiguous pronunciation (not easily confused with other commands)
3. **Mix of native + web**: Tests both focus/launch and URL fallback paths
4. **Short phrase**: 2-3 words max (longer phrases are harder to train)

### Future commands to consider

| Command | Priority | Notes |
|---------|----------|-------|
| "open slack" | Medium | Business chat |
| "open notion" | Medium | Notes |
| "open claude" | Medium | AI assistant |
| "open chatgpt" | Medium | AI assistant |
| "open reddit" | Low | Social media |
| "open amazon" | Low | Shopping |
| "open netflix" | Low | Streaming |
| "close window" | Medium | Window management |
| "search for" | High | Triggers search mode |
| "new tab" | Low | Browser control |

---

## 7. Alternative Training Approaches (for reference)

### Local training (rejected)

The `nibor1896/custom-wakeword-trainer` repo provides a local OWW trainer
for Windows + Python 3.13. This was considered but rejected because:

- Requires ~20 GB free disk for datasets
- Requires Python 3.13 + pip environment setup
- NVIDIA GPU recommended (we don't have one)
- Slower than Colab T4
- More setup friction

### livekit-wakeword (considered)

livekit-wakeword offers a Conv-Attention classifier head that's
backward-compatible with OWW models. It claims better accuracy and
fewer false positives than OWW's flat DNN head.

This was considered but not chosen because:
- Different training pipeline (would need new notebook)
- Not yet proven with NEXUS's existing tract-onnx runtime
- OWW's DNN head is already working for the wake word
- Can switch to Conv-Attention later if false positives are a problem

### Custom synthetic data (future)

Currently using Piper TTS for synthetic positive clips. Future improvements:
- Record real human voice samples (more natural variation)
- Use multiple TTS voices for speaker diversity
- Add accent/dialect variations
- Use VoxCPM for multilingual support (livekit-wakeword)

---

## 8. Cross-References

- [13-colab-training-notebook.md](./13-colab-training-notebook.md) — Wake-word Colab notebook docs
- [06-model-training.md](./06-model-training.md) — Wake-word training overview
- [15-tier3-command-classifiers.md](./15-tier3-command-classifiers.md) — Tier 3 architecture
- [16-tier3-decision-comparison.md](./16-tier3-decision-comparison.md) — Overall Tier 3 decision
- `train_nexus_commands.ipynb` — The actual training notebook
- `train_nexus_oww.ipynb` — The original wake-word training notebook
