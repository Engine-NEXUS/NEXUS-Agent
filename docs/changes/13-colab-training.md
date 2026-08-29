# Change: Colab Training Notebook Fixes

**Commits:**
- `b0d0cd5` ("fix: copy melspectrogram.onnx to OWW resources dir + add command_intents.json")
- `8fb1832` ("fix: Colab compliance — disk cleanup, Drive checkpointing, idle timeout prevention")
- `7ab3859` ("fix: Colab notebook ACAV/FMA download failures with retries and fallback")

**Date:** 2026-08-19

---

## Problem 1: Missing melspectrogram.onnx

### Error
```
NoSuchFile:
Load model from
/content/openwakeword/openwakeword/resources/models/melspectrogram.onnx failed:
File doesn't exist
```

### Cause
The notebook downloaded shared models (`melspectrogram.onnx`, `embedding_model.onnx`) into `/content/oww_models/`, but openWakeWord's `train.py` looked in `/content/openwakeword/openwakeword/resources/models/`.

### Fix
Updated notebook cell 9 to:
1. Create the resources directory: `mkdir -p /content/openwakeword/openwakeword/resources/models/`
2. Copy both models:
   ```python
   shutil.copy("/content/oww_models/melspectrogram.onnx",
               "/content/openwakeword/openwakeword/resources/models/melspectrogram.onnx")
   shutil.copy("/content/oww_models/embedding_model.onnx",
               "/content/openwakeword/openwakeword/resources/models/embedding_model.onnx")
   ```
3. Add verification assertions:
   ```python
   assert os.path.exists("/content/openwakeword/openwakeword/resources/models/melspectrogram.onnx")
   assert os.path.exists("/content/openwakeword/openwakeword/resources/models/embedding_model.onnx")
   ```

---

## Problem 2: Colab Disk Space

### Cause
Training 39 command classifiers generates a lot of intermediate data (synthetic audio, mel spectrograms, ONNX checkpoints). Colab's free tier has limited disk (~100 GB).

### Fix
Added disk cleanup between training runs:
- Delete intermediate `.wav` files after each command is trained.
- Delete temporary numpy arrays.
- Keep only the final `.onnx` model files.
- Log disk usage before and after each command.

---

## Problem 3: Colab Idle Timeout

### Cause
Colab free tier disconnects after ~90 minutes of inactivity. Training 39 commands takes ~6 hours.

### Fix
- Added periodic output (print statements every 30 seconds during training) to keep the cell "active".
- Added Google Drive checkpointing: after each command is trained, the `.onnx` file is saved to Drive.
- On resume, the notebook checks Drive for completed models and skips them.

---

## Problem 4: ACAV/FMA Download Failures

### Cause
The training notebook downloads negative samples from the ACAV (Audio Command And Vocoder) and FMA (Free Music Archive) datasets. These external downloads sometimes fail due to:
- Network issues in Colab.
- Rate limiting.
- Temporary unavailability.

### Fix
- Added retry logic (3 attempts with exponential backoff).
- Added fallback datasets (if ACAV/FMA fail, use synthetic noise).
- Log download progress and failures.

---

## Google Drive Checkpointing

The notebook saves completed `.onnx` models to Google Drive:
```
/drive/MyDrive/nexus_models/commands/
  ├── open_youtube.onnx
  ├── open_gmail.onnx
  ├── ...
  └── play_spotify.onnx
```

On resume:
1. Mount Google Drive.
2. Check which models already exist.
3. Skip training for completed models.
4. Train only the missing ones.

**Note:** The user reported that the expected `.onnx` folder was not visible in Drive. The checkpoint location and actual Drive output should be verified before resuming training.

## Files Changed

- `train_nexus_commands.ipynb` — multiple cells updated (model path fix, disk cleanup, Drive checkpointing, download retries).
- `command_intents.json` — added to the repo (was missing).
