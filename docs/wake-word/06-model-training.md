# Model Training: nexus.onnx

> How the custom NEXUS wake word classifier model was trained using openWakeWord's
> training framework, adapted for modern Google Colab (Python 3.12, 2026).

---

## 1. Overview

The `nexus.onnx` model is a custom wake word classifier trained using a modified
openWakeWord training pipeline. It is trained on synthetic TTS audio so that no
real user audio is required.

| Item | Value |
|------|-------|
| **Training notebook** | `C:\PROJECTS\ULTRON\train_nexus_oww.ipynb` |
| **Output model** | `C:\PROJECTS\ULTRON\src-tauri\resources\oww\nexus.onnx` |
| **Model size** | 790,682 bytes (~772 KB) |
| **Training date** | 2026-08-19 |
| **Training platform** | Google Colab (T4 GPU, Python 3.12) |
| **Training duration** | ~75-90 minutes |
| **Base framework** | [openWakeWord](https://github.com/dscripka/openWakeWord) |
| **Adapted from** | [alfiedennen/openwakeword-colab-2026](https://github.com/alfiedennen/openwakeword-colab-2026) |

---

## 2. Why Synthetic Data?

| Approach | Pros | Cons |
|----------|------|------|
| Real user recordings | Most accurate for that user | Privacy concerns, limited speakers, hard to collect |
| Synthetic TTS data | No privacy issues, unlimited speakers, varied accents | May not perfectly match real speech |

openWakeWord uses synthetic TTS data (Piper) because:

1. **No privacy concerns** — no real user audio is collected
2. **Unlimited speakers** — TTS can generate audio with many different voices
3. **Varied accents and speeds** — TTS parameters can be adjusted
4. **Reproducible** — same training data can be regenerated
5. **Proven approach** — openWakeWord's pre-trained models are trained this way

---

## 3. Training Pipeline (Actual)

```
1. Install dependencies (Python 3.12-compatible)
   - piper-phonemize-cross (Py3.12 fork)
   - piper-tts (--no-deps to prevent clobbering)
   - openWakeWord, torch, audiomentations, speechbrain, etc.
    │
    ▼
2. Clone repos + download Piper model
   - piper-sample-generator pinned to commit 1a8c49bd^
   - en_US-libritts_r-medium.pt (~200 MB)
   - openWakeWord (master branch)
    │
    ▼
3. Apply 6 runtime patches
   - Patch A: torchaudio.set_audio_backend → no-op
   - Patch B: Copy generate_samples.py into openwakeword package
   - Patch C: HF Hub timeouts 10s → 120s
   - Patch D: torchaudio.info() shim via soundfile
   - Patch E: generate_samples model arg default
   - Patch F: train.py val dtype cast
    │
    ▼
4. Pre-flight gate
   - Verify all imports + all external files exist
   - Hard-fail if anything is broken before slow downloads
    │
    ▼
5. Download openWakeWord shared models
   - melspectrogram.onnx (1.1 MB)
   - embedding_model.onnx (1.3 MB)
    │
    ▼
6. Download MIT impulse responses → 16-kHz WAVs
   - HuggingFace: davidscripka/MIT_environmental_impulse_responses
   - ~270 room impulse responses
    │
    ▼
7. Download FMA + ACAV features (~25 GB)
   - FMA small: ~8 GB zip of MP3s (background music)
   - ACAV100M features: ~17 GB .npy (pre-computed negative features)
   - Both with resume support for session restarts
    │
    ▼
8. Convert FMA MP3s → 16-kHz mono WAVs
   - 1500 files via ffmpeg
    │
    ▼
9. Subsample ACAV — 1.7 GB train + 170 MB val
   - Full 17 GB would OOM training
   - Train: 1/10th of full dataset
   - Val: 1/100th, flattened to 2-D for sliding window
    │
    ▼
10. Build training config
    - target_phrase: ["nexus"]
    - custom_negative_phrases: 18 soundalikes
    - All fields set explicitly (no example-yaml dependency)
    │
    ▼
11. Generate Piper TTS clips (~10-15 min)
    - openWakeWord's --generate_clips runner
    - 2000 positive + 2000 negative training clips
    - 1000 positive + 1000 negative validation clips
    │
    ▼
12. Resample TTS clips 22050 → 16000 Hz
    - Piper outputs at libritts native 22050 Hz
    - Augment + feature pipelines expect 16 kHz
    │
    ▼
13. Augment + featurise (~10 min)
    - openWakeWord's --augment_clips runner
    - Room reverb from MIT RIRs
    - Background noise from FMA WAVs
    - Outputs (N, 16, 96) feature .npy files
    │
    ▼
14. Hand-rolled trainer (~30-40 min on T4)
    - 3-stage learning rate: 1e-4 → 1e-5 → 1e-6
    - Negative weight ramp: 1 → 1500
    - Hard-negative mining
    - FP-per-hour validation against ACAV100M
    - Checkpoint ensemble averaging
    │
    ▼
15. Ensemble + ONNX export + download
    - 90/90/10 percentile filter on checkpoints
    - Average state_dicts
    - Export ONNX with sigmoid baked in
    - Sanity-check with onnxruntime
    - Browser download
```

---

## 4. Training Environment

### 4.1 Why Google Colab?

- **Piper TTS requires Linux** — it doesn't run natively on Windows
- **GPU acceleration** — Colab provides free T4 GPU
- **No local setup** — all dependencies installed in the notebook
- **Reproducible** — same environment every time
- **25 GB of data** — Colab provides ~100 GB temporary disk

### 4.2 Colab Settings Used

| Setting | Value |
|---------|-------|
| Runtime type | Python 3 (3.12) |
| Hardware accelerator | T4 GPU (free tier) |
| RAM | ~12 GB (free tier) |
| Disk | ~100 GB (temporary) |
| Training time | ~75-90 minutes |

### 4.3 Why Not Colab CLI?

The `google-colab-cli` package (v0.6.0) was installed locally but **does not work
on Windows** because it imports the Unix-only `termios` module:

```
ModuleNotFoundError: No module named 'termios'
```

Browser-based Colab is the only practical route on Windows. WSL could potentially
work but was not tested.

---

## 5. Training Data Details

### 5.1 Positive Samples (Wake Word)

| Source | Description |
|--------|-------------|
| Piper TTS | Multiple voices saying "nexus" via LibriTTS medium model |
| Variations | Different speaking rates (slow, normal, fast) |
| Voices | LibriTTS speaker pool (~1000+ speakers) |
| Training clips | 2000 (n_samples) |
| Validation clips | 1000 (n_samples_val) |

### 5.2 Negative Samples (Non-Wake-Word)

| Source | Description |
|--------|-------------|
| Custom negative phrases | 18 soundalikes: "next", "nixis", "mexic", "necess", "lexis", "nixes", "nixus", "noxus", "naxus", "text", "taxes", "focus", "bonus", "census", "versus", "hocus", "locus", "next us" |
| Adversarial negatives | Auto-generated by openWakeWord's `generate_adversarial_texts()` |
| ACAV100M features | Pre-computed features from 2000 hours of diverse speech |
| FMA background music | 1500 music clips for noise augmentation |
| Training negative clips | 2000 |
| Validation negative clips | 1000 |

### 5.3 Data Augmentation

| Augmentation | Source | Purpose |
|-------------|--------|---------|
| Room reverb | MIT environmental impulse responses (~270 RIRs) | Simulate room acoustics |
| Background noise | FMA music clips (1500 WAVs at 16 kHz) | Simulate real-world noise |
| Volume variation | audiomentations | Simulate different distances |
| Speed perturbation | audiomentations | Simulate different speaking rates |

### 5.4 Pre-computed Features

| Feature file | Size | Role |
|-------------|------|------|
| `openwakeword_features_ACAV100M_2000_hrs_16bit.npy` | ~17 GB | Pre-computed negative features from 2000 hrs of speech |
| Subsampled train | ~1.7 GB (1/10th) | Negative training corpus |
| Subsampled val | ~170 MB (1/100th) | FP-per-hour validation |

---

## 6. Model Architecture

### 6.1 Classifier Network (Actual)

The `nexus.onnx` classifier is a small DNN, mirroring openWakeWord's architecture:

| Layer | Type | Output Shape |
|-------|------|-------------|
| Input | — | `[batch, 16, 96]` |
| Flatten | — | `[batch, 1536]` |
| Linear + LayerNorm + ReLU | FC | `[batch, 128]` |
| Linear | FC | `[batch, 1]` |
| Sigmoid (baked into ONNX) | — | `[batch, 1]` |

- **Total parameters:** ~197K (1536×128 + 128 + 128×1 + 1)
- **Model size:** 790,682 bytes (~772 KB)
- **Input:** 16 frames of 96-dim embeddings (1.28s of audio context)
- **Output:** Single probability (0.0 to 1.0, sigmoid baked in)
- **Runtime threshold:** 0.5

### 6.2 ONNX I/O Shapes

```
Input:  onnx::Flatten_0  [batch, 16, 96]   (dynamic batch)
Output: output           [batch, 1]        (dynamic batch)
```

### 6.3 Why Not Fine-Tune the Embedding Model?

| Approach | Pros | Cons |
|----------|------|------|
| Train classifier only | Fast, small model, leverages pre-trained features | Limited by embedding quality |
| Fine-tune embedding + classifier | Better features for "nexus" | Slower, larger model, risk of overfitting |

openWakeWord trains only the classifier because:

1. The embedding model is already trained on diverse speech data
2. Fine-tuning risks overfitting to synthetic TTS voices
3. The classifier-only approach is proven to work (openWakeWord's pre-trained models)

---

## 7. Training Hyperparameters (Actual)

### 7.1 Config

| Parameter | Value | Notes |
|-----------|-------|-------|
| `target_phrase` | `["nexus"]` | Single wake word |
| `model_name` | `"nexus"` | Output filename |
| `n_samples` | 2000 | Positive training clips |
| `n_samples_val` | 1000 | Positive validation clips |
| `tts_batch_size` | 50 | Piper TTS batch size |
| `augmentation_rounds` | 1 | One round of augmentation |
| `augmentation_batch_size` | 16 | Clips per augmentation batch |
| `steps` | 20000 | Total training steps (stage 1) |
| `max_negative_weight` | 1500 | Max negative class weight |
| `target_accuracy` | 0.7 | Stop if accuracy exceeds this |
| `target_recall` | 0.5 | Stop if recall exceeds this |
| `target_false_positives_per_hour` | 0.5 | FP/hr target |
| `batch_size` | 128 | Training batch size |
| `learning_rate` | 1e-4 | Initial learning rate |
| `model_type` | `"dnn"` | Dense neural network |
| `layer_dim` | 128 | Hidden layer size |
| `layer_size` | 128 | Alias for layer_dim (upstream compat) |
| `model_input_shape` | `[16, 96]` | 16 frames × 96-dim embeddings |
| `n_classes` | 1 | Binary classifier |
| `onnx_export` | True | Export ONNX |
| `tflite_export` | False | TFLite not needed (Rust uses ONNX) |

### 7.2 Custom Negative Phrases

```python
[
    "next", "next us", "nixis", "mexic", "necess",
    "lexis", "nixes", "nixus", "noxus", "naxus",
    "text", "taxes", "focus", "bonus",
    "census", "versus", "hocus", "locus",
]
```

These are soundalikes that the model must learn to **reject**. They were chosen
based on:

- Common mispronunciations of "nexus" (nixus, nixis, noxus, naxus)
- Phonetically similar words (next, text, focus, bonus)
- Words with similar vowel patterns (census, versus, locus)

### 7.3 Training Curriculum (Hand-Rolled Trainer)

The training uses a 3-stage curriculum mirroring openWakeWord's `auto_train`:

| Stage | Steps | Learning Rate | Max Neg Weight | Validation Window |
|-------|-------|---------------|----------------|-------------------|
| 1 | 20000 | 1e-4 | 1500 | Last 25% |
| 2 | 2000 | 1e-5 | 1500 (or 3000) | Full |
| 3 | 2000 | 1e-6 | 1500 (or 3000) | Full |

**Adaptive neg weight**: If stage 1 best FP/hr > target, max_neg_w is doubled
for stage 2. Same for stage 2 → stage 3.

### 7.4 Learning Rate Schedule

Within each stage:

```
Warmup (first 20%):    lr * (step + 1) / warmup_steps
Hold (next 33%):       lr
Cosine decay (rest):   lr * 0.5 * (1 + cos(π * decay_t))
```

### 7.5 Hard-Negative Mining

Each training step:

1. Generate batch (32 positive + 32 adversarial negative + 64 ACAV negative)
2. Run forward pass
3. Keep only samples where:
   - Negative and prediction >= 0.001 (model is getting it wrong)
   - Positive and prediction < 0.999 (model is getting it wrong)
4. Accumulate until 128 samples, then backprop

### 7.6 Checkpoint Selection

- Validate every N steps (20 validations per stage)
- Save checkpoint if:
  - `n_fp <= percentile(val_n_fp, 50)` (FP count in bottom half)
  - `recall >= percentile(val_recall, 5)` (recall in top 95%)

### 7.7 Ensemble Averaging

Final model is created by:

1. Filter checkpoints: accuracy >= p90, recall >= p90, fp/hr <= p10
2. Average all qualified state_dicts
3. If none qualify, use single best checkpoint (lowest FP/hr, highest recall)

---

## 8. Evaluation

### 8.1 Validation During Training

| Metric | Target | How Measured |
|--------|--------|-------------|
| Recall | >= 0.5 | Held-out positive test clips |
| Accuracy | >= 0.7 | Held-out positive + negative test clips |
| FP/hour | <= 0.5 | ACAV100M validation slice (~11 hours) |

### 8.2 Runtime Validation (2026-08-19)

See [14-model-validation-results.md](./14-model-validation-results.md) for full
details.

| Metric | Result |
|--------|--------|
| Model loads in Rust | PASS |
| ONNX file valid | PASS (790,682 bytes, onnx + pytorch markers) |
| WakeEngine initializes | PASS (all 3 ONNX models loaded) |
| Runtime detection | 7 wakes in ~3 min (probabilities 0.809-0.992) |
| False positives during silence | 0 |

### 8.3 Known Limitations

- **Synthetic data bias:** Model may perform worse on real speech than synthetic test data
- **Speaker variation:** Model trained on TTS voices may not generalize to all human speakers
- **Accent coverage:** Depends on Piper LibriTTS voice coverage
- **Background noise:** Augmentation helps but real noise is more varied

---

## 9. Retraining

If the model doesn't perform well enough:

1. **Lower threshold** (0.5 → 0.4 → 0.3) — easier to trigger
2. **Add more positive samples** — increase `n_samples` (2000 → 5000)
3. **Add more adversarial negatives** — add words that cause false alarms to `custom_negative_phrases`
4. **Increase training steps** — `steps` (20000 → 30000)
5. **Increase max_negative_weight** — (1500 → 3000) for lower FP rate
6. **Retrain** — run the Colab notebook again with updated config
7. **Test** — repeat the runtime validation

---

## 10. Files

| File | Role |
|------|------|
| `train_nexus_oww.ipynb` | Training notebook (run in Colab) |
| `src-tauri/resources/oww/nexus.onnx` | Trained model (output, 790 KB) |
| `src-tauri/resources/oww/melspectrogram.onnx` | Pre-trained mel model (input, not trained, 1.1 MB) |
| `src-tauri/resources/oww/embedding_model.onnx` | Pre-trained embedding model (input, not trained, 1.3 MB) |

---

## 11. Dependencies (Python 3.12-Compatible)

### 11.1 Native (apt-get)

```
cmake espeak-ng espeak-ng-data libespeak-ng-dev libsndfile1 pkg-config build-essential ffmpeg unzip
```

### 11.2 Python (pip)

| Package | Purpose |
|---------|---------|
| `piper-phonemize-cross` | Py3.12-compatible fork of piper-phonemize |
| `piper-tts` (--no-deps) | Text-to-speech for synthetic clip generation |
| `webrtcvad` | Voice activity detection |
| `mutagen==1.47.0` | Audio metadata |
| `torchinfo` | Model summary |
| `torchmetrics` | Training metrics |
| `pyyaml` | Config file parsing |
| `tqdm` | Progress bars |
| `datasets` | HuggingFace dataset loading |
| `soundfile` | WAV I/O |
| `audiomentations` | Audio augmentation |
| `torch_audiomentations` | GPU audio augmentation |
| `pronouncing` | Pronunciation dictionary |
| `onnxruntime` | ONNX inference (sanity check) |
| `onnx` | ONNX model manipulation |
| `speechbrain` | Speaker embedding (for speaker verification) |
| `acoustics` | Acoustic analysis |
| `scipy` | Signal processing (resampling) |
| `requests` | Dataset downloads |
| `huggingface_hub` | Dataset downloads |

### 11.3 Pinned Versions

| Component | Version / Commit | Why |
|-----------|-----------------|-----|
| piper-sample-generator | commit `1a8c49bd^` | Last commit with flat-layout `generate_samples.py` |
| Piper TTS model | `en_US-libritts_r-medium.pt` v2.0.0 | Multi-speaker LibriTTS model |
| openWakeWord | master (2026-08-19) | Latest fixes |

---

## 12. Runtime Patches Applied

Six patches are applied to make openWakeWord work on modern Colab:

| Patch | Target | Problem | Fix |
|-------|--------|---------|-----|
| A | `torch_audiomentations/utils/io.py` | `torchaudio.set_audio_backend()` removed in 2.x | sed-replace with `pass` |
| B | `openwakeword/generate_samples.py` | File missing from package dir | Copy from piper-sample-generator |
| C | `huggingface_hub.constants` | 10s timeout too short for large downloads | Bump to 120s |
| D | `torchaudio/__init__.py` | `torchaudio.info()` removed in 2.x | Add shim using soundfile |
| E | `generate_samples.py` | `model` arg required but not passed by train.py | Add default value via sed |
| F | `openwakeword/train.py` | dtype mismatch on validation | Cast to float32 |

---

## 13. Cross-References

- [05-oww-3-stage-pipeline.md](./05-oww-3-stage-pipeline.md) — How the 3 ONNX models work together at runtime
- [13-colab-training-notebook.md](./13-colab-training-notebook.md) — Cell-by-cell breakdown of the training notebook
- [14-model-validation-results.md](./14-model-validation-results.md) — Runtime validation results from 2026-08-19
- [10-rust-integration.md](./10-rust-integration.md) — How the trained model is loaded in Rust
- [11-testing-strategy.md](./11-testing-strategy.md) — Full testing strategy
