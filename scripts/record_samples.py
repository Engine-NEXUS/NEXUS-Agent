"""
NEXUS Wake Word Sample Recorder
Records real "nexus" utterances for training data augmentation.

Usage:
  python scripts/record_samples.py

Output:
  nexus_real_samples/nexus_001.wav ... nexus_050.wav

Then zip and upload to Kaggle as a dataset:
  zip -r nexus_real_samples.zip nexus_real_samples/
"""
import sounddevice as sd
import numpy as np
import scipy.io.wavfile as wav
import os
import time

OUT_DIR = "nexus_real_samples"
SAMPLE_RATE = 16000
DURATION = 2.0  # seconds per clip
N_CLIPS = 50

os.makedirs(OUT_DIR, exist_ok=True)

print("=" * 50)
print("NEXUS Wake Word Sample Recorder")
print("=" * 50)
print(f"Will record {N_CLIPS} clips, {DURATION}s each.")
print("Say 'NEXUS' clearly when prompted.")
print("Press Ctrl+C to stop early.\n")

existing = len([f for f in os.listdir(OUT_DIR) if f.endswith(".wav")])
start = existing + 1

for i in range(start, start + N_CLIPS):
    fname = f"{OUT_DIR}/nexus_{i:03d}.wav"
    input(f"  Clip {i}/{start + N_CLIPS - 1} — press ENTER when ready...")
    print("  Recording... ", end="", flush=True)
    audio = sd.rec(int(DURATION * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype=np.int16)
    sd.wait()
    rms = np.sqrt(np.mean((audio.astype(np.float32) / 32767) ** 2))
    if rms < 0.001:
        print("SKIP (too quiet)")
        continue
    wav.write(fname, SAMPLE_RATE, audio)
    print(f"saved (RMS={rms:.4f})")

print(f"\nDone. {len(os.listdir(OUT_DIR))} clips in {OUT_DIR}/")
print(f"Zip and upload to Kaggle:")
print(f"  zip -r nexus_real_samples.zip {OUT_DIR}/")
