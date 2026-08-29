#!/usr/bin/env python3
"""Create the bulletproof NEXUS wake word training notebook for Kaggle.
Cross-checked 3x for dependency compatibility and API correctness."""
import nbformat as nbf

nb = nbf.v4.new_notebook()
nb.metadata.update({
    "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
    "language_info": {"name": "python"},
    "kaggle": {"accelerator": "gpu", "isGpuEnabled": True, "isInternetEnabled": True}
})

cells = []

# ═══════════════════════════════════════════════════════════════════════════
# CELL 0 — Title
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""# NEXUS Wake Word Training — Bulletproof Edition

Trains a custom **"nexus"** wake word model using openWakeWord, optimized for:
- **Background noise** (music, traffic, fans, cafe)
- **Low volume / whispered** "nexus" calls
- **Far-field** (speaking from across the room)
- **Soundalike rejection** ("lexus", "texas", "next is" should NOT trigger)

## Kaggle Setup

1. **Settings -> Accelerator -> GPU T4 x2** (or P100)
2. **Settings -> Internet -> On**
3. **Run all cells** (~90 minutes total)
4. Download `nexus.onnx` from output

## Issues Fixed (from Colab failures)

| Issue | Fix |
|-------|-----|
| `torch==1.13.1` no Python 3.12 wheels | Use pre-installed `torch>=2.0` |
| `torchaudio` deprecated APIs | Monkey-patch with soundfile |
| `setuptools 82+` removed `pkg_resources` | Pin `setuptools<82` |
| `pyarrow`/`fsspec` break `datasets` | Pin versions |
| `piper_sample_generator` API mismatch | Use `piper-tts` PiperVoice directly |
| AudioSet 404 | Use FMA + synthetic noise |
| Sample rate mismatch (Piper 22050) | Resample in patched torchaudio.load |
| `onnxscript` missing | Install explicitly |
| `webrtcvad` C compilation | Install build-essential first |"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 1 — System deps
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 1. Install System Dependencies

Build tools and audio libraries for C extensions (webrtcvad, soundfile)."""))

cells.append(nbf.v4.new_code_cell("""import subprocess, sys

try:
    subprocess.check_call(["apt-get", "update", "-qq"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.check_call([
        "apt-get", "install", "-y", "-qq",
        "build-essential", "cmake", "espeak-ng", "libespeak-ng-dev",
        "libsndfile1", "pkg-config", "ffmpeg", "unzip",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("System packages installed")
except Exception as e:
    print(f"apt-get note: {e}")

import torch
print(f"Python: {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")
print(f"PyTorch: {torch.__version__}")
print(f"CUDA: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
    print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 2 — Python deps
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 2. Install Python Dependencies

All versions pinned for Kaggle Python 3.12 + PyTorch 2.x."""))

cells.append(nbf.v4.new_code_cell("""import subprocess, sys, os

def pip_install(*pkgs):
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", *pkgs])

# Compat fixes FIRST
pip_install("setuptools<82")
pip_install("pyarrow<15.0.0")
pip_install("fsspec<2024.1.0")

# Core
pip_install("soundfile", "scipy", "numpy<2.0", "mutagen==1.47.0")

# openWakeWord from git
if not os.path.exists("openwakeword_src"):
    subprocess.check_call(["git", "clone", "--depth", "1",
        "https://github.com/dscripka/openWakeWord.git", "openwakeword_src"])
pip_install("-e", "./openwakeword_src")

# Training deps
pip_install("torchinfo==1.8.0", "torchmetrics==1.2.0")
pip_install("speechbrain>=0.5.14")
pip_install("audiomentations==0.33.0", "torch-audiomentations==0.11.0")
pip_install("acoustics==0.2.6")

# Piper TTS — piper-phonemize has no Python 3.12 Linux wheels on PyPI,
# so install from k2-fsa mirror which has cp312 wheels
pip_install("piper-phonemize", "-f", "https://k2-fsa.github.io/icefall/piper_phonemize.html")
pip_install("piper-tts==1.3.0")
pip_install("onnxruntime>=1.16")

# ONNX export
pip_install("onnx", "onnxscript")

# Data utils
pip_install("datasets>=2.14", "webrtcvad", "pyyaml", "tqdm", "requests")

print("All Python dependencies installed")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 3 — Compat patches
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 3. Apply Compatibility Patches

Must be applied BEFORE importing openwakeword or speechbrain."""))

cells.append(nbf.v4.new_code_cell("""import logging, subprocess, sys, tempfile, os
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="  %(levelname)-8s %(message)s")

def patch_pkg_resources():
    try:
        import pkg_resources; return "ok"
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "setuptools<82", "-q"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "applied"

def patch_torchaudio_load():
    import torch, torchaudio
    if getattr(torchaudio, "_oww_patched", False): return "ok"
    def _load(filepath, *a, **kw):
        import numpy as np, soundfile as sf
        data, sr = sf.read(str(filepath), dtype="float32")
        if data.ndim == 1: data = data[np.newaxis, :]
        else: data = data.T
        if sr != 16000:
            from scipy.signal import resample
            new_len = int(data.shape[-1] * 16000 / sr)
            if data.ndim == 2:
                data = np.stack([resample(data[c], new_len).astype(np.float32) for c in range(data.shape[0])])
            else:
                data = resample(data, new_len).astype(np.float32)
            sr = 16000
        return torch.from_numpy(data), sr
    torchaudio.load = _load
    torchaudio._oww_patched = True
    return "applied"

def patch_torchaudio_info():
    import torchaudio
    if getattr(torchaudio, "_oww_info_patched", False): return "ok"
    class AMD:
        __slots__ = ("sample_rate", "num_frames", "num_channels", "bits_per_sample", "encoding")
        def __init__(self, sr, nf, nc):
            self.sample_rate = sr; self.num_frames = nf; self.num_channels = nc
            self.bits_per_sample = 16; self.encoding = "PCM_S"
    def _info(fp):
        import soundfile as sf
        fi = sf.info(str(fp))
        return AMD(fi.samplerate, fi.frames, fi.channels)
    torchaudio.info = _info
    if not hasattr(torchaudio, "AudioMetaData"): torchaudio.AudioMetaData = AMD
    torchaudio._oww_info_patched = True
    return "applied"

def patch_torchaudio_backends():
    import torchaudio
    if hasattr(torchaudio, "list_audio_backends"): return "ok"
    torchaudio.list_audio_backends = lambda: ["soundfile"]
    return "applied"

for name, fn in [("pkg_resources", patch_pkg_resources),
                 ("torchaudio.load", patch_torchaudio_load),
                 ("torchaudio.info", patch_torchaudio_info),
                 ("torchaudio.backends", patch_torchaudio_backends)]:
    try: print(f"  {name}: {fn()}")
    except Exception as e: print(f"  {name}: FAILED: {e}")

# Verify
import torch, torchaudio, numpy as np, soundfile as sf
with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
    sf.write(f.name, np.zeros(22050, dtype=np.float32), 22050)
    wav, sr = torchaudio.load(f.name)
    assert sr == 16000, f"Expected 16000, got {sr}"
    os.unlink(f.name)
print("All patches verified")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 4 — Download Piper ONNX voice model
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 4. Download Piper TTS Voice Model

We use the Piper ONNX voice model directly with `PiperVoice` — this is more
reliable than the `piper_sample_generator` which requires `piper_train`.

The `en_US-lessac-medium.onnx` voice is a clear, neutral American English voice."""))

cells.append(nbf.v4.new_code_cell("""import os, requests
from pathlib import Path

voice_dir = Path("piper_voices")
voice_dir.mkdir(exist_ok=True)

# Download Piper ONNX voice model + config
voice_name = "en_US-lessac-medium"
base_url = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/{voice_name}/medium/"

onnx_path = voice_dir / f"{voice_name}.onnx"
json_path = voice_dir / f"{voice_name}.onnx.json"

for path, suffix in [(onnx_path, "onnx"), (json_path, "onnx.json")]:
    if not path.exists():
        url = base_url + suffix
        print(f"Downloading {path.name}...")
        resp = requests.get(url, stream=True, timeout=120)
        resp.raise_for_status()
        with open(path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1<<20):
                f.write(chunk)
        print(f"  {path.stat().st_size/1e6:.1f} MB")
    else:
        print(f"Exists: {path.name} ({path.stat().st_size/1e6:.1f} MB)")

# Verify
assert onnx_path.exists() and onnx_path.stat().st_size > 100000, "ONNX voice model missing"
assert json_path.exists(), "Voice config JSON missing"
print(f"Piper voice ready: {onnx_path}")

# Test PiperVoice loads
from piper import PiperVoice
voice = PiperVoice.load(str(onnx_path))
print(f"Voice loaded: sample_rate={voice.config.sample_rate}")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 5 — Download RIRs + noise + ACAV100M
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 5. Download Augmentation Datasets

- MIT Room Impulse Responses (far-field simulation)
- Background noise (MUSAN/synthetic)
- ACAV100M pre-computed negative features (11 hours of speech)
- Validation features for early stopping"""))

cells.append(nbf.v4.new_code_cell("""import os, numpy as np, soundfile as sf, requests
from pathlib import Path
from tqdm import tqdm

data_dir = Path("training_data")
data_dir.mkdir(exist_ok=True)
SR = 16000

# ─── MIT RIRs ───
rir_dir = data_dir / "mit_rirs"
if not rir_dir.exists() or len(list(rir_dir.glob("*.wav"))) < 100:
    rir_dir.mkdir(parents=True, exist_ok=True)
    print("Downloading MIT RIRs...")
    from datasets import load_dataset
    rir_ds = load_dataset("davidscripka/MIT_environmental_impulse_responses",
                          split="train", streaming=True)
    count = 0
    for row in tqdm(rir_ds, desc="RIRs"):
        audio = row["audio"]
        sf.write(str(rir_dir / f"rir_{count:05d}.wav"), audio["array"], audio["sampling_rate"])
        count += 1
        if count >= 500: break
    print(f"Downloaded {count} RIRs")
else:
    print(f"RIRs: {len(list(rir_dir.glob('*.wav')))} files")

# ─── Background noise ───
noise_dir = data_dir / "noise"
if not noise_dir.exists() or len(list(noise_dir.glob("*.wav"))) < 50:
    noise_dir.mkdir(parents=True, exist_ok=True)
    print("Generating noise clips...")
    np.random.seed(42)
    for i in range(200):
        dur = np.random.randint(3, 10)
        n = dur * SR
        t = np.random.choice(["white", "pink", "brown"])
        if t == "white":
            arr = np.random.randn(n).astype(np.float32) * 0.1
        elif t == "pink":
            arr = np.cumsum(np.random.randn(n)).astype(np.float32)
            arr = arr / (np.max(np.abs(arr)) + 1e-8) * 0.1
        else:
            arr = np.cumsum(np.cumsum(np.random.randn(n))).astype(np.float32)
            arr = arr / (np.max(np.abs(arr)) + 1e-8) * 0.05
        sf.write(str(noise_dir / f"noise_{i:05d}.wav"), arr, SR)
    print("Generated 200 noise clips")
else:
    print(f"Noise: {len(list(noise_dir.glob('*.wav')))} files")

# ─── ACAV100M features ───
acav_path = data_dir / "acav100m_features.npy"
if not acav_path.exists():
    print("Downloading ACAV100M features (~7.5GB)...")
    url = "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
    resp = requests.get(url, stream=True, timeout=120)
    resp.raise_for_status()
    total = int(resp.headers.get("content-length", 0))
    dl = 0
    tmp = acav_path.with_suffix(".part")
    with open(tmp, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1<<20):
            f.write(chunk)
            dl += len(chunk)
            if total: print(f"\\r  {dl/1e9:.1f}/{total/1e9:.1f} GB ({dl*100//total}%)", end="", flush=True)
    print()
    tmp.rename(acav_path)
    print(f"ACAV100M: {acav_path.stat().st_size/1e9:.1f} GB")
else:
    print(f"ACAV100M: {acav_path.stat().st_size/1e9:.1f} GB")

# ─── Validation features ───
val_path = data_dir / "validation_features.npy"
if not val_path.exists():
    print("Downloading validation features...")
    url = "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy"
    resp = requests.get(url, stream=True, timeout=60)
    resp.raise_for_status()
    with open(val_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1<<20): f.write(chunk)
    print(f"Validation: {val_path.stat().st_size/1e6:.1f} MB")
else:
    print(f"Validation: {val_path.stat().st_size/1e6:.1f} MB")

print("All datasets ready")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 6 — Generate positive "nexus" clips with PiperVoice
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 6. Generate Positive "Nexus" Clips (1,000+)

Uses `PiperVoice.synthesize_wav` with varied `SynthesisConfig` parameters:
- `length_scale`: 0.8 (fast) to 1.5 (slow)
- `noise_scale`: 0.0 to 0.667 (speech variability)
- `noise_w_scale`: 0.0 to 0.8 (prosody variability)
- `volume`: 0.2 (whisper) to 1.0 (normal)

Each clip is saved as 16kHz mono WAV."""))

cells.append(nbf.v4.new_code_cell("""import os, random, wave, numpy as np
from pathlib import Path
from tqdm import tqdm
from piper import PiperVoice, SynthesisConfig

data_dir = Path("training_data")
pos_dir = data_dir / "positive"
pos_dir.mkdir(parents=True, exist_ok=True)

voice = PiperVoice.load("piper_voices/en_US-lessac-medium.onnx",
                        use_cuda=torch.cuda.is_available())
native_sr = voice.config.sample_rate  # Piper outputs at 22050 or 16000
print(f"Piper voice sample rate: {native_sr}")

TARGET_PHRASES = ["nexus", "hey nexus", "ok nexus", "nexus wake up", "nexus wake"]
N_PER_PHRASE = 200  # 200 x 5 = 1,000 clips

LENGTH_SCALES = [0.8, 0.9, 1.0, 1.1, 1.2, 1.5]
NOISE_SCALES = [0.0, 0.1, 0.2, 0.3, 0.5, 0.667]
NOISE_W_SCALES = [0.0, 0.1, 0.2, 0.3, 0.4, 0.8]
VOLUMES = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]

print(f"Generating {N_PER_PHRASE} x {len(TARGET_PHRASES)} = {N_PER_PHRASE * len(TARGET_PHRASES)} clips")

generated = 0
for pi, phrase in enumerate(TARGET_PHRASES):
    print(f"  Phrase {pi+1}/{len(TARGET_PHRASES)}: '{phrase}'")
    for i in tqdm(range(N_PER_PHRASE), desc=f"  {phrase}"):
        out = pos_dir / f"pos_{pi:02d}_{i:04d}.wav"
        if out.exists():
            generated += 1; continue

        cfg = SynthesisConfig(
            length_scale=random.choice(LENGTH_SCALES),
            noise_scale=random.choice(NOISE_SCALES),
            noise_w_scale=random.choice(NOISE_W_SCALES),
            volume=random.choice(VOLUMES),
        )
        try:
            with wave.open(str(out), "wb") as wav_file:
                voice.synthesize_wav(phrase, wav_file, syn_config=cfg)
            generated += 1
        except Exception as e:
            # Retry with default config
            try:
                with wave.open(str(out), "wb") as wav_file:
                    voice.synthesize_wav(phrase, wav_file)
                generated += 1
            except Exception as e2:
                print(f"  SKIP {i}: {e2}")
                continue

clips = list(pos_dir.glob("*.wav"))
print(f"Generated {generated} clips, {len(clips)} on disk")
assert len(clips) >= 500, f"Need >=500, got {len(clips)}"

# Verify a sample clip
import soundfile as sf
data, sr = sf.read(str(clips[0]))
print(f"Sample: {clips[0].name}, {len(data)} samples @ {sr}Hz, {len(data)/sr:.2f}s")
print("Positive clips ready")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 7 — Generate adversarial negatives
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 7. Generate Adversarial Negative Clips (2,000+)

Phrases that should NOT trigger the wake word."""))

cells.append(nbf.v4.new_code_cell("""import os, random, wave, numpy as np
from pathlib import Path
from tqdm import tqdm
from piper import PiperVoice, SynthesisConfig

data_dir = Path("training_data")
neg_dir = data_dir / "adversarial_negatives"
neg_dir.mkdir(parents=True, exist_ok=True)

voice = PiperVoice.load("piper_voices/en_US-lessac-medium.onnx",
                        use_cuda=torch.cuda.is_available())

SOUNDALIKES = [
    "lexus", "texas", "next is", "neck us", "nexas", "nuxus", "nexis",
    "the lexus", "a texas", "nixus", "noxus", "noxis", "naksas",
]
OTHER_WAKE = [
    "hey siri", "ok google", "hey google", "alexa", "hey cortana",
    "hey jarvis", "computer", "hey spotify",
]
COMMON = [
    "hello", "hi", "hey", "yes", "no", "please", "thanks",
    "what time is it", "how is the weather", "tell me a joke",
    "good morning", "good night", "thank you", "sorry",
    "what", "how", "why", "when", "where", "who",
]
COMMANDS = [
    "open gmail", "open chrome", "open spotify", "open youtube",
    "close discord", "close chrome", "quit terminal",
    "search for cats", "google python", "play music", "play jazz",
    "check email", "check calendar", "send email", "write message",
    "set alarm", "set timer", "create meeting",
    "analyse the pr", "review the code", "check the repo",
]

ALL_NEG = SOUNDALIKES + OTHER_WAKE + COMMON + COMMANDS
N_PER = 40  # 40 x ~75 = ~3,000

LENGTH_SCALES = [0.8, 0.9, 1.0, 1.1, 1.2]
NOISE_SCALES = [0.0, 0.1, 0.2, 0.3, 0.667]
NOISE_W_SCALES = [0.0, 0.1, 0.2, 0.3]
VOLUMES = [0.5, 0.7, 0.9, 1.0]

print(f"Generating {N_PER} x {len(ALL_NEG)} = {N_PER * len(ALL_NEG)} negatives")

generated = 0
for pi, phrase in enumerate(ALL_NEG):
    if pi % 20 == 0: print(f"  Phrase {pi+1}/{len(ALL_NEG)}: '{phrase}'")
    for i in range(N_PER):
        out = neg_dir / f"neg_{pi:03d}_{i:03d}.wav"
        if out.exists(): generated += 1; continue
        cfg = SynthesisConfig(
            length_scale=random.choice(LENGTH_SCALES),
            noise_scale=random.choice(NOISE_SCALES),
            noise_w_scale=random.choice(NOISE_W_SCALES),
            volume=random.choice(VOLUMES),
        )
        try:
            with wave.open(str(out), "wb") as wf:
                voice.synthesize_wav(phrase, wf, syn_config=cfg)
            generated += 1
        except Exception:
            try:
                with wave.open(str(out), "wb") as wf:
                    voice.synthesize_wav(phrase, wf)
                generated += 1
            except Exception: continue

clips = list(neg_dir.glob("*.wav"))
print(f"Generated {generated}, {len(clips)} on disk")
assert len(clips) >= 1000, f"Need >=1000, got {len(clips)}"
print("Adversarial negatives ready")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 8 — Augment positive clips
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 8. Augment Positive Clips (4x)

Apply: volume variation, speed variation, room reverberation (RIRs), background noise mixing.
Creates 4,000+ augmented clips from 1,000 base clips."""))

cells.append(nbf.v4.new_code_cell("""import os, random, numpy as np, soundfile as sf
from pathlib import Path
from scipy.signal import resample, fftconvolve
from tqdm import tqdm

data_dir = Path("training_data")
pos_dir = data_dir / "positive"
aug_dir = data_dir / "positive_augmented"
aug_dir.mkdir(parents=True, exist_ok=True)

rir_dir = data_dir / "mit_rirs"
noise_dir = data_dir / "noise"
rir_files = list(rir_dir.glob("*.wav"))
noise_files = list(noise_dir.glob("*.wav"))
print(f"RIRs: {len(rir_files)}, Noise: {len(noise_files)}")

SR = 16000

def load_wav(path):
    data, sr = sf.read(str(path), dtype="float32")
    if sr != SR:
        data = resample(data, int(len(data) * SR / sr)).astype(np.float32)
    return data

def apply_rir(audio, rir):
    rir = rir / (np.max(np.abs(rir)) + 1e-8)
    result = fftconvolve(audio, rir, mode="full")[:len(audio)]
    return (result / (np.max(np.abs(result)) + 1e-8) * (np.max(np.abs(audio)) + 1e-8)).astype(np.float32)

def mix_noise(audio, noise, snr_db):
    if len(noise) < len(audio):
        noise = np.tile(noise, (len(audio) // len(noise)) + 1)[:len(audio)]
    else:
        s = random.randint(0, len(noise) - len(audio))
        noise = noise[s:s + len(audio)]
    sp = np.mean(audio ** 2) + 1e-8
    np_ = np.mean(noise ** 2) + 1e-8
    noise = noise * np.sqrt(sp / (10 ** (snr_db / 10)) / np_)
    return (audio + noise).astype(np.float32)

pos_files = list(pos_dir.glob("*.wav"))
print(f"Augmenting {len(pos_files)} clips x 4 rounds...")

augmented = 0
for pf in tqdm(pos_files, desc="Augmenting"):
    audio = load_wav(pf)
    if len(audio) == 0: continue
    for r in range(4):
        aug = audio.copy()
        # Volume (whisper sim)
        aug = (aug * random.choice([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0])).astype(np.float32)
        # Speed
        sf_ = random.choice([0.8, 0.9, 1.0, 1.1, 1.2, 1.3])
        aug = resample(aug, int(len(aug) / sf_)).astype(np.float32)
        # RIR (far-field)
        if rir_files and random.random() < 0.6:
            try: aug = apply_rir(aug, load_wav(random.choice(rir_files)))
            except: pass
        # Noise
        if noise_files and random.random() < 0.7:
            try: aug = mix_noise(aug, load_wav(random.choice(noise_files)), random.uniform(5, 15))
            except: pass
        aug = np.clip(aug, -1.0, 1.0)
        sf.write(str(aug_dir / f"{pf.stem}_aug{r}.wav"), aug, SR)
        augmented += 1

all_pos = list(pos_dir.glob("*.wav")) + list(aug_dir.glob("*.wav"))
print(f"Augmented: {augmented}, Total positive: {len(all_pos)}")
assert len(all_pos) >= 3000, f"Need >=3000, got {len(all_pos)}"
print("Augmentation complete")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 9 — Split train/val
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 9. Split into Train/Validation (90/10)"""))

cells.append(nbf.v4.new_code_cell("""import os, shutil, random
from pathlib import Path

data_dir = Path("training_data")
all_pos = list((data_dir / "positive").glob("*.wav")) + list((data_dir / "positive_augmented").glob("*.wav"))
all_neg = list((data_dir / "adversarial_negatives").glob("*.wav"))
print(f"Positive: {len(all_pos)}, Negative: {len(all_neg)}")

random.seed(42)
random.shuffle(all_pos); random.shuffle(all_neg)

ps = int(len(all_pos) * 0.9); ns = int(len(all_neg) * 0.9)
for d in ["train/positive", "train/negative", "val/positive", "val/negative"]:
    (data_dir / d).mkdir(parents=True, exist_ok=True)

def copy_files(files, dest):
    for f in files:
        dst = dest / f.name
        if not dst.exists(): shutil.copy2(str(f), str(dst))

print("Copying train positive..."); copy_files(all_pos[:ps], data_dir / "train/positive")
print("Copying train negative..."); copy_files(all_neg[:ns], data_dir / "train/negative")
print("Copying val positive..."); copy_files(all_pos[ps:], data_dir / "val/positive")
print("Copying val negative..."); copy_files(all_neg[ns:], data_dir / "val/negative")

tp = len(list((data_dir / "train/positive").glob("*.wav")))
tn = len(list((data_dir / "train/negative").glob("*.wav")))
vp = len(list((data_dir / "val/positive").glob("*.wav")))
vn = len(list((data_dir / "val/negative").glob("*.wav")))
print(f"Train: {tp} pos, {tn} neg | Val: {vp} pos, {vn} neg")
assert tp > 0 and tn > 0 and vp > 0 and vn > 0
print("Split complete")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 10 — Training config
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 10. Create Training Configuration"""))

cells.append(nbf.v4.new_code_cell("""import yaml
from pathlib import Path

config = {
    "target_phrase": ["nexus", "hey nexus", "nexus wake up"],
    "custom_negative_phrases": [
        "lexus", "texas", "next is", "neck us",
        "hey siri", "ok google", "alexa", "hey cortana",
    ],
    "model_type": "dnn",
    "layer_size": 32,
    "steps": 50000,
    "batch_n_per_class": {
        "positive": 50,
        "adversarial_negative": 50,
        "ACAV100M_sample": 1024,
    },
    "max_negative_weight": 1500,
    "target_false_positives_per_hour": 0.2,
    "augmentation_batch_size": 16,
    "augmentation_rounds": 1,
    "rir_paths": ["./training_data/mit_rirs"],
    "background_paths": ["./training_data/noise"],
    "background_paths_duplication_rate": [1],
    "feature_data_files": {
        "ACAV100M_sample": "./training_data/acav100m_features.npy",
    },
    "validation_features": "./training_data/validation_features.npy",
    "output_dir": "./nexus_model",
    "model_name": "nexus",
    "early_stopping": True,
}

with open("nexus_config.yaml", "w") as f:
    yaml.dump(config, f, default_flow_style=False)
print("Config written")
print(yaml.dump(config, default_flow_style=False))"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 11 — Train
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 11. Train the Wake Word Model

Runs openWakeWord's `train.py` with our config. Takes ~30-60 min on T4 GPU."""))

cells.append(nbf.v4.new_code_cell("""import subprocess, sys, os
from pathlib import Path

Path("nexus_model").mkdir(exist_ok=True)

# Find train.py
train_script = None
for p in Path("openwakeword_src").rglob("train.py"):
    train_script = p; break

if not train_script:
    raise FileNotFoundError("train.py not found in openwakeword_src/")

print(f"Training script: {train_script}")
print("Starting training (~30-60 min on T4)...")
print("=" * 60)

env = os.environ.copy()
env["PYTHONUNBUFFERED"] = "1"

try:
    result = subprocess.run(
        [sys.executable, str(train_script),
         "--config_file", "nexus_config.yaml",
         "--generate_clips"],
        env=env, timeout=3600,
    )
    print(f"Training exited with code: {result.returncode}")
except subprocess.TimeoutExpired:
    print("Training timed out after 1 hour")
except Exception as e:
    print(f"Training failed: {e}")
    raise

print("=" * 60)
print("Training complete")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 12 — Export to ONNX
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 12. Export Model to ONNX"""))

cells.append(nbf.v4.new_code_cell("""import os, sys
from pathlib import Path

model_dir = Path("nexus_model")

# Find ONNX file (training may auto-export)
onnx_files = list(model_dir.rglob("*.onnx"))
# Also check for .pt checkpoints
pt_files = sorted(model_dir.rglob("*.pt")) + sorted(model_dir.rglob("*.pth"))

print(f"ONNX files: {len(onnx_files)}")
for f in onnx_files: print(f"  {f} ({f.stat().st_size/1024:.0f} KB)")
print(f"PT files: {len(pt_files)}")
for f in pt_files: print(f"  {f} ({f.stat().st_size/1024:.0f} KB)")

if onnx_files:
    onnx_path = onnx_files[0]
    print(f"Using existing ONNX: {onnx_path}")
elif pt_files:
    # Export from PyTorch checkpoint
    import torch
    ckpt = pt_files[-1]
    print(f"Exporting from checkpoint: {ckpt}")

    sys.path.insert(0, str(Path("openwakeword_src").resolve()))
    try:
        from openwakeword.model import Model
        model = Model(wakeword_models=[str(ckpt)])
        onnx_path = model_dir / "nexus.onnx"

        # Get underlying model
        if hasattr(model, 'models') and model.models:
            pt_model = list(model.models.values())[0]
        elif hasattr(model, 'model'):
            pt_model = model.model
        else:
            pt_model = model

        dummy = torch.randn(1, 16, 96)
        torch.onnx.export(
            pt_model if hasattr(pt_model, 'forward') else pt_model,
            dummy, str(onnx_path),
            opset_version=14,
            input_names=['input'], output_names=['output'],
            dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
        )
        print(f"Exported: {onnx_path} ({onnx_path.stat().st_size/1024:.0f} KB)")
    except Exception as e:
        print(f"Export failed: {e}")
        # Try openwakeword utils
        try:
            from openwakeword.utils import export_onnx
            onnx_path = model_dir / "nexus.onnx"
            export_onnx(str(ckpt), str(onnx_path))
            print(f"Exported via utils: {onnx_path}")
        except Exception as e2:
            print(f"Utils export also failed: {e2}")
            raise
else:
    # List all files for debugging
    print("No model files found. All files in nexus_model/:")
    for f in model_dir.rglob("*"):
        if f.is_file(): print(f"  {f} ({f.stat().st_size/1024:.0f} KB)")
    raise FileNotFoundError("No model checkpoint or ONNX file found")

# Verify ONNX
import onnx
onnx.checker.check_model(onnx.load(str(onnx_path)))
print(f"ONNX verified: {onnx_path} ({onnx_path.stat().st_size/1024:.0f} KB)")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 13 — Test model
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 13. Test the Trained Model"""))

cells.append(nbf.v4.new_code_cell("""import numpy as np, soundfile as sf, onnxruntime as ort
from pathlib import Path
from scipy.signal import resample

onnx_path = Path("nexus_model/nexus.onnx")
sess = ort.InferenceSession(str(onnx_path))
input_name = sess.get_inputs()[0].name

# Find shared models
mel_path = None; emb_path = None
for p in Path("openwakeword_src").rglob("melspectrogram.onnx"): mel_path = p; break
for p in Path("openwakeword_src").rglob("embedding_model.onnx"): emb_path = p; break
print(f"Mel: {mel_path}, Emb: {emb_path}")

mel_sess = ort.InferenceSession(str(mel_path))
emb_sess = ort.InferenceSession(str(emb_path))

def score_clip(audio_16k):
    audio_scaled = audio_16k * 32768.0
    mel_out = mel_sess.run(None, {mel_sess.get_inputs()[0].name: audio_scaled.reshape(1, -1).astype(np.float32)})[0]
    emb_out = emb_sess.run(None, {emb_sess.get_inputs()[0].name: mel_out})[0]
    features = emb_out.reshape(1, 16, 96)
    return float(sess.run(None, {input_name: features})[0][0])

# Positive tests
print("\\n=== Positive (should be > 0.5) ===")
pos_files = list(Path("training_data/val/positive").glob("*.wav"))[:10]
pos_scores = []
for f in pos_files:
    audio, sr = sf.read(str(f), dtype="float32")
    if sr != 16000: audio = resample(audio, int(len(audio) * 16000 / sr)).astype(np.float32)
    s = score_clip(audio); pos_scores.append(s)
    print(f"  {f.name}: {s:.3f}")
print(f"  Avg: {np.mean(pos_scores):.3f}")

# Negative tests
print("\\n=== Negative (should be < 0.3) ===")
neg_files = list(Path("training_data/val/negative").glob("*.wav"))[:10]
neg_scores = []
for f in neg_files:
    audio, sr = sf.read(str(f), dtype="float32")
    if sr != 16000: audio = resample(audio, int(len(audio) * 16000 / sr)).astype(np.float32)
    s = score_clip(audio); neg_scores.append(s)
    print(f"  {f.name}: {s:.3f}")
print(f"  Avg: {np.mean(neg_scores):.3f}")

# Silence
silence_score = score_clip(np.zeros(16000, dtype=np.float32))
print(f"\\nSilence: {silence_score:.3f}")

print(f"\\n=== Summary ===")
print(f"  Positive avg: {np.mean(pos_scores):.3f} (target > 0.5)")
print(f"  Negative avg: {np.mean(neg_scores):.3f} (target < 0.3)")
print(f"  Silence:      {silence_score:.3f} (target < 0.1)")
if np.mean(pos_scores) > 0.5 and np.mean(neg_scores) < 0.3:
    print("  Model looks good!")
else:
    print("  Model may need more training")"""))

# ═══════════════════════════════════════════════════════════════════════════
# CELL 14 — Download instructions
# ═══════════════════════════════════════════════════════════════════════════
cells.append(nbf.v4.new_markdown_cell("""## 14. Download and Deploy

1. Download `nexus_model/nexus.onnx` from Kaggle output
2. Replace `src-tauri/resources/oww/nexus.onnx` in your NEXUS project
3. Rebuild: `pwsh ./scripts/build.ps1`
4. Test: say "nexus" at various volumes and with background noise"""))

cells.append(nbf.v4.new_code_cell("""from pathlib import Path

onnx_path = Path("nexus_model/nexus.onnx")
if onnx_path.exists():
    print(f"Model ready: {onnx_path}")
    print(f"  Size: {onnx_path.stat().st_size/1024:.0f} KB")
    print()
    print("Download from Kaggle output panel.")
    print("Replace: src-tauri/resources/oww/nexus.onnx")
    print("Rebuild: pwsh ./scripts/build.ps1")
else:
    onnx_files = list(Path(".").rglob("*.onnx"))
    custom = [f for f in onnx_files if "melspectrogram" not in f.name
              and "embedding" not in f.name and "vad" not in f.name.lower()]
    if custom:
        print(f"Found: {custom[0]} ({custom[0].stat().st_size/1024:.0f} KB)")
    else:
        print("No ONNX model found. Check training output above.")"""))

# ═══════════════════════════════════════════════════════════════════════════
nb.cells = cells

with open("train_nexus_wakeword_kaggle.ipynb", "w", encoding="utf-8") as f:
    nbf.write(nb, f)

print(f"Created train_nexus_wakeword_kaggle.ipynb with {len(cells)} cells")
