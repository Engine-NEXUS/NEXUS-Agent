# Colab Training Notebook: Cell-by-Cell Breakdown

> Detailed walkthrough of `train_nexus_oww.ipynb` — what each cell does, why it
> exists, and what it produces. This is the reference for anyone who needs to
> debug, modify, or re-run the training.

**Notebook file:** `C:\PROJECTS\ULTRON\train_nexus_oww.ipynb`
**Total cells:** 32 (16 markdown + 16 code)
**Adapted from:** [alfiedennen/openwakeword-colab-2026](https://github.com/alfiedennen/openwakeword-colab-2026)

---

## Why a Custom Notebook?

The official openWakeWord training notebook
([automatic_model_training.ipynb](https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb))
breaks on modern Google Colab (Python 3.12) due to 8+ known compatibility issues:

| # | Issue | Cause |
|---|-------|-------|
| 1 | `piper-phonemize` has no Py3.12 wheels | Package not updated for Python 3.12 |
| 2 | `torchaudio.set_audio_backend()` removed | torchaudio 2.x removed this API |
| 3 | `torchaudio.info()` removed | torchaudio 2.x removed this API |
| 4 | `generate_samples.py` moved | piper-sample-generator changed package layout |
| 5 | `generate_samples()` requires `model` arg | train.py doesn't pass it |
| 6 | `train.py` TFLite conversion crashes | No TensorFlow on modern Colab |
| 7 | `mmap_batch_generator` shape bugs | Upstream code not updated for current numpy |
| 8 | HF Hub 10s timeouts | Large dataset downloads fail |

The custom notebook fixes all 8 issues and replaces the upstream `train.py`
training loop with a hand-rolled PyTorch trainer that mirrors openWakeWord's
`auto_train` curriculum exactly.

---

## Cell-by-Cell Breakdown

### Cell 0 (Markdown): Title & Overview

Documents the notebook's purpose, runtime, output, and instructions.

**Key points:**
- Runtime: ~75-90 min on Colab Pro (L4 GPU), ~2x slower on free T4
- Output: `nexus.onnx` (~800 KB)
- 9-step pipeline summary

---

### Cell 1 (Markdown): Install Header

Explains the install strategy:
- `piper-phonemize-cross` FIRST (Py3.12-compatible fork)
- All openWakeWord deps SECOND
- `piper-tts` LAST via `--no-deps` (so nothing can clobber it)

---

### Cell 2 (Code): Comprehensive Install

**What it does:**
1. Installs native deps via `apt-get`: cmake, espeak-ng, libsndfile1, ffmpeg, etc.
2. Installs Python deps in the exact order described above
3. Verifies every import that openWakeWord's `train.py`, `data.py`, and `utils.py` touch

**Why:**
- If anything is missing, this cell surfaces it immediately — before any 75-min run
- `piper-tts` via `--no-deps` prevents pip from downgrading/clobbering it
- `piper-phonemize-cross` is a drop-in replacement (same module name `piper_phonemize`)

**Output:**
```
Python: 3.12.x
  torch: 2.x.x  cuda: True
  All openwakeword deps (incl. piper-tts) import cleanly.
```

---

### Cell 3 (Markdown): Clone Repos Header

Explains that piper-sample-generator is pinned to commit `1a8c49bd^` — the last
revision with flat-layout `generate_samples.py` at the root.

---

### Cell 4 (Code): Clone Repos + Download Model

**What it does:**
1. Clone piper-sample-generator, checkout pinned commit
2. Download Piper LibriTTS model (~200 MB) if missing
3. Clone openWakeWord if missing, install with `pip install -e`
4. Ensure `openwakeword` package resolves correctly (not as namespace package)

**Self-healing:**
- Each piece is checked individually and re-created if missing
- If `generate_samples.py` is missing, re-clones
- If Piper model is < 100 MB, re-downloads
- Wipes stale `sys.modules` entries for `openwakeword*`

**Key assertion:**
```python
assert openwakeword.__file__ is not None  # Not a namespace package
```

---

### Cell 5 (Markdown): Runtime Patches Header

Lists the 6 patches and notes they are idempotent.

---

### Cell 6 (Code): Apply 6 Runtime Patches

**What it does:**

| Patch | Target File | Problem | Fix |
|-------|------------|---------|-----|
| A | `torch_audiomentations/utils/io.py` | `torchaudio.set_audio_backend("soundfile")` crashes | sed-replace with `pass` |
| B | `openwakeword/generate_samples.py` | Missing from package dir | Copy from piper-sample-generator |
| C | `huggingface_hub.constants` | 10s timeout | Set to 120s |
| D | `torchaudio/__init__.py` | `info()` removed in 2.x | Append shim using soundfile |
| E | `generate_samples.py` | `model` arg required but not passed | sed-add default value |
| F | `openwakeword/train.py` | dtype mismatch on validation | sed-add `.float()` cast |

**Idempotent:** Each patch checks if it's already been applied before applying.

---

### Cell 7 (Markdown): Pre-Flight Gate Header

Explains the pre-flight gate — hard-fails if anything is broken before slow downloads.

---

### Cell 8 (Code): Pre-Flight Gate

**What it does:**
1. Checks all 6 expected files exist (generate_samples.py, train.py, data.py, utils.py, etc.)
2. Tries importing all 22 required Python modules
3. Dry-imports `openwakeword.data` and `openwakeword.utils` to catch internal import bugs
4. Checks CUDA availability

**Why:**
- Catches new failure modes future Colab updates introduce
- Prevents wasting 75 min on a run that will fail at cell 14

**Output (success):**
```
  OK piper-sample-generator/generate_samples.py: ...
  OK openwakeword/train.py: ...
  CUDA: True, GPU: Tesla T4

  Pre-flight PASSED. Safe to proceed with downloads + training.
```

---

### Cell 9 (Markdown): Download Shared Models Header

---

### Cell 10 (Code): Download openWakeWord Shared Models

**What it does:**
- Downloads `melspectrogram.onnx`, `embedding_model.onnx` (+ TFLite variants)
- From GitHub releases: `dscripka/openWakeWord v0.5.1`
- Idempotent — skips files already cached

**Files produced:**
| File | Size |
|------|------|
| `melspectrogram.onnx` | ~1.1 MB |
| `embedding_model.onnx` | ~1.3 MB |

---

### Cell 11 (Markdown): MIT RIRs Header

---

### Cell 12 (Code): Download MIT Impulse Responses

**What it does:**
1. Pre-caches HuggingFace dataset via `snapshot_download` (more reliable than `load_dataset`)
2. Retries up to 6 times with exponential backoff
3. Loads dataset and converts each IR to 16-kHz WAV
4. Idempotent — skips if >= 250 WAVs already exist

**Dataset:** `davidscripka/MIT_environmental_impulse_responses`
**Output:** ~270 room impulse response WAVs in `/content/mit_rirs/`

---

### Cell 13 (Markdown): FMA + ACAV Header

---

### Cell 14 (Code): Download FMA + ACAV Features

**What it does:**
1. Downloads ACAV100M features (~17 GB) with resume support
2. Downloads FMA small dataset (~8 GB zip) with resume support
3. Extracts FMA zip

**Resume support:**
- Checks existing file size
- Sends `Range: bytes=N-` header to resume from where it left off
- Uses `tqdm` for progress

**Files produced:**
| File | Size |
|------|------|
| `openwakeword_features_ACAV100M_2000_hrs_16bit.npy` | ~17 GB |
| `/content/fma/` (extracted MP3s) | ~8 GB |

**Time:** ~10-15 minutes (network-bound)

---

### Cell 15 (Markdown): FMA WAV Conversion Header

---

### Cell 16 (Code): Convert FMA MP3s to WAVs

**What it does:**
- Converts 1500 MP3s to 16-kHz mono WAVs using ffmpeg
- Idempotent — skips already-converted files

**Why:**
- `audiomentations` needs WAV format
- 1500 clips = plenty of background-noise variety

**Time:** ~5 minutes

---

### Cell 17 (Markdown): ACAV Subsample Header

---

### Cell 18 (Code): Subsample ACAV

**What it does:**
1. Loads 17 GB ACAV features with `mmap_mode='r'` (doesn't load into RAM)
2. Slices first 1/10th → train subset (~1.7 GB)
3. Slices next 1/100th → val subset (~170 MB, flattened to 2-D)
4. Deletes 17 GB original to save disk

**Why:**
- Full 17 GB would OOM during training
- Val slice stays as raw `(M, 96)` — the trainer slides a 16-frame window over it

---

### Cell 19 (Markdown): Build Config Header

Notes that the config is already set for NEXUS — no editing needed.

---

### Cell 20 (Code): Build Training Config

**What it does:**
- Creates a self-contained YAML config with every field set explicitly
- Doesn't depend on upstream's `examples/` directory (which has been renamed/removed across versions)
- Writes to `/content/my_model.yaml`

**Key config values:**
```python
TARGET_PHRASE = ['nexus']
MODEL_NAME    = 'nexus'
n_samples = 2000
n_samples_val = 1000
steps = 20000
max_negative_weight = 1500
target_accuracy = 0.7
target_recall = 0.5
target_false_positives_per_hour = 0.5
custom_negative_phrases = [
    'next', 'next us', 'nixis', 'mexic', 'necess',
    'lexis', 'nixes', 'nixus', 'noxus', 'naxus',
    'text', 'taxes', 'focus', 'bonus',
    'census', 'versus', 'hocus', 'locus',
]
```

---

### Cell 21 (Markdown): Generate Clips Header

---

### Cell 22 (Code): Generate Piper TTS Clips

**What it does:**
1. Checks all 4 clip dirs (positive_train, positive_test, negative_train, negative_test)
2. If all are fully populated, skips
3. Otherwise, runs `openwakeword/train.py --training_config my_model.yaml --generate_clips`
4. Asserts all 4 dirs have expected clip counts

**Time:** ~10-15 minutes

**Output:**
- ~2000 positive training clips (Piper TTS saying "nexus")
- ~2000 negative training clips (Piper TTS saying adversarial words)
- ~1000 positive validation clips
- ~1000 negative validation clips

---

### Cell 23 (Markdown): Resample Header

---

### Cell 24 (Code): Resample TTS Clips 22050 → 16000 Hz

**What it does:**
1. Finds all WAV dirs under the output directory
2. Checks sample rate of first 20 files in each dir
3. If all are 16 kHz, skips
4. Otherwise, resamples using `scipy.signal.resample_poly`
5. Clears stale `.npy` feature files

**Why:**
- Piper TTS outputs at LibriTTS native 22050 Hz
- The augment + feature pipelines expect 16 kHz

---

### Cell 25 (Markdown): Augment Header

---

### Cell 26 (Code): Augment + Featurise

**What it does:**
1. Checks if all 4 feature `.npy` files exist
2. If yes, skips
3. Otherwise, runs `openwakeword/train.py --training_config my_model.yaml --augment_clips`
4. Asserts all 4 feature files are present

**What augmentation does:**
- Mixes clips with FMA background music at various SNRs
- Applies MIT room impulse responses for reverb
- Varies volume and speed

**Output:**
| File | Content |
|------|---------|
| `positive_features_train.npy` | `(N, 16, 96)` features for positive training clips |
| `negative_features_train.npy` | `(N, 16, 96)` features for negative training clips |
| `positive_features_test.npy` | `(N, 16, 96)` features for positive validation clips |
| `negative_features_test.npy` | `(N, 16, 96)` features for negative validation clips |

**Time:** ~10 minutes

---

### Cell 27 (Markdown): Trainer Header

Documents the hand-rolled training curriculum:
- 3-stage LR schedule (1e-4 → 1e-5 → 1e-6)
- Negative weight ramp (1 → 1500)
- Hard-negative mining
- FP/hour validation against ACAV100M
- 90/90/10 percentile checkpoint ensemble

---

### Cell 28 (Code): Hand-Rolled Trainer

**What it does:**

1. **Load features** onto GPU:
   - `pos_train`, `neg_train`, `pos_test`, `neg_test` — from augmented feature files
   - `acav_train_np` — mmap'd ACAV train subset (negative corpus)
   - `acav_val_np` — ACAV val subset (for FP/hour validation)

2. **Create sliding windows** over ACAV val:
   ```python
   acav_val_windows = np.lib.stride_tricks.sliding_window_view(acav_val_np, (16, 96))
   ```
   - Creates ~M-16 windows of shape `(16, 96)`
   - Total listening time: `M * 0.08 / 3600` hours

3. **Define model:**
   ```python
   class WakewordModel(nn.Module):
       # Flatten → Linear(1536, 128) → LayerNorm → ReLU → Linear(128, 1)
   ```

4. **Batch generation:**
   - 32 positive samples (random from `pos_train`)
   - 32 adversarial negative samples (random from `neg_train`)
   - 64 ACAV negative samples (random windows from `acav_train_np`)

5. **Training loop (per stage):**
   - Learning rate schedule: warmup → hold → cosine decay
   - Hard-negative mining: only train on high-loss samples
   - Negative weight ramp: `np.linspace(1.0, max_neg_w, n_steps)`
   - Accumulate until 128 samples, then backprop
   - Validate every N steps (20 validations per stage)

6. **Validation:**
   - Recall: fraction of positive test clips with score >= 0.5
   - Accuracy: (true positives + true negatives) / total
   - FP/hour: false positives in ACAV val / listening hours
   - Save checkpoint if FP count <= p50 AND recall >= p5

7. **3 stages:**
   - Stage 1: 20000 steps, lr=1e-4, max_neg_w=1500, val in last 25%
   - Stage 2: 2000 steps, lr=1e-5, max_neg_w=1500 (or 3000), full val
   - Stage 3: 2000 steps, lr=1e-6, max_neg_w=1500 (or 3000), full val

8. **Adaptive neg weight:**
   - After stage 1: if best FP/hr > target, double max_neg_w
   - After stage 2: same check

**Time:** ~30-40 minutes on T4 GPU

---

### Cell 29 (Markdown): Ensemble + Export Header

---

### Cell 30 (Code): Ensemble + ONNX Export + Download

**What it does:**

1. **Filter checkpoints:**
   - accuracy >= p90, recall >= p90, fp/hr <= p10
   - If none qualify, use single best (lowest FP/hr, highest recall)

2. **Ensemble average:**
   ```python
   final_state = {k: torch.stack([sd[k].float() for sd, _ in qualified]).mean(dim=0)
                  for k in keys}
   ```

3. **Export ONNX with sigmoid baked in:**
   ```python
   class WakewordExportable(torch.nn.Module):
       def forward(self, x): return torch.sigmoid(self.base(x))

   torch.onnx.export(export_model, dummy, out_path,
                     input_names=['onnx::Flatten_0'], output_names=['output'],
                     dynamic_axes={...}, opset_version=14)
   ```

4. **Sanity check with onnxruntime:**
   - Load the exported ONNX
   - Print input/output shapes
   - Run positive test set through it
   - Print recall@0.5

5. **Copy to `/content/nexus.onnx`** for easy download

6. **Browser download** via `google.colab.files.download()`

**Output:**
```
  OK wrote /content/nexus_output/nexus/nexus.onnx (790 KB)
  input:  onnx::Flatten_0 [0, 16, 96]
  output: output [0, 1]
  positive test set: mean=0.9xx, recall@0.5=0.9xx
  ACAV val FP/hour at 0.5: 0.xx

DONE. Wake word "nexus" trained.
```

---

### Cell 31 (Markdown): After Download

Instructions to place the downloaded `nexus.onnx` at:
```
C:\PROJECTS\ULTRON\src-tauri\resources\oww\nexus.onnx
```

---

## Timing Breakdown

| Cell | Step | Time | Bottleneck |
|------|------|------|------------|
| 2 | Install deps | ~3 min | pip/apt |
| 4 | Clone repos + download Piper model | ~2 min | Network |
| 6 | Apply patches | ~10 sec | — |
| 8 | Pre-flight gate | ~5 sec | — |
| 10 | Download shared models | ~1 min | Network |
| 12 | Download MIT RIRs | ~1 min | Network |
| 14 | Download FMA + ACAV | ~10-15 min | Network (25 GB) |
| 16 | Convert FMA to WAVs | ~5 min | CPU (ffmpeg) |
| 18 | Subsample ACAV | ~2 min | Disk I/O |
| 22 | Generate Piper clips | ~10-15 min | CPU (TTS) |
| 24 | Resample clips | ~2 min | CPU |
| 26 | Augment + featurise | ~10 min | CPU |
| 28 | Train DNN | ~30-40 min | GPU |
| 30 | Ensemble + export | ~1 min | — |
| **Total** | | **~75-90 min** | |

---

## Debugging Guide

### If Cell 2 (Install) Fails

- Restart runtime: Runtime → Restart session
- Re-run from Cell 2
- If `piper-tts` import fails, try `!pip install --no-deps piper-tts` again

### If Cell 4 (Clone) Fails

- Check internet connection
- Try `!git clone` manually
- If piper-sample-generator checkout fails, the pinned commit may have been
  force-pushed. Check the repo for the current commit hash.

### If Cell 8 (Pre-Flight) Fails

- The error message tells you exactly what's missing
- Re-run cells 2-6 to fix
- If still failing, screenshot the error and investigate

### If Cell 14 (Downloads) Fails

- Network timeout → re-run (resume support will pick up where it left off)
- Disk full → Runtime → Disconnect and delete runtime, then re-run
- ACAV download is 17 GB — make sure Colab has enough disk

### If Cell 22 (Generate Clips) Fails

- `ModuleNotFoundError: No module named 'piper'` → Cell 2 install failed
- `TypeError: generate_samples() missing 1 required positional argument: 'model'`
  → Patch E didn't apply, re-run Cell 6
- If Piper TTS crashes → restart runtime, re-run from Cell 2

### If Cell 28 (Training) Fails

- CUDA OOM → reduce `B_ACAV` from 64 to 32 in the trainer code
- NaN loss → reduce learning rate or max_negative_weight
- No checkpoints saved → model isn't learning, check feature shapes

### If Cell 30 (Export) Fails

- `onnxruntime` not installed → `!pip install onnxruntime`
- ONNX export error → try `opset_version=13` or `dynamo=False`

---

## Cross-References

- [06-model-training.md](./06-model-training.md) — High-level training overview
- [14-model-validation-results.md](./14-model-validation-results.md) — Runtime validation results
- [05-oww-3-stage-pipeline.md](./05-oww-3-stage-pipeline.md) — How the 3 ONNX models work together
- [10-rust-integration.md](./10-rust-integration.md) — How the trained model is loaded in Rust
