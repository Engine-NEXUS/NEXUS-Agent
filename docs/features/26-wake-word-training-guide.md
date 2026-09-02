# NEXUS Wake Word — Fixing, Training & Improvement Guide

**Status:** Planning doc. Wake word training is deferred — implement after the
multi-worker optimization plan is complete.
**Scripts ready:** `scripts/train_wakeword.ipynb`, `scripts/record_samples.py`

---

## Current state

- Model: `src-tauri/resources/oww/nexus.onnx` (custom openWakeWord, 2-syllable "nexus")
- Runtime: `tract-onnx` in-process, ~20–60 MB RAM
- Tested perfect on TTS samples (0.994 prob, 0% false positives)
- **Fails on real speech** with background noise, low volume, or distance
- Root cause: trained on clean TTS only, no real-world augmentation

## Why commercial systems are better

| Factor | Alexa/Siri | NEXUS |
|---|---|---|
| Training data | Millions of real utterances | TTS-generated only |
| Microphone | Far-field mic array + beamforming | Single laptop mic |
| Noise suppression | Hardware DSP + software | None |
| Hardware | Dedicated low-power chip | CPU |

## Improvement plan (3 phases)

### Phase 1: Audio preprocessing (software, no training needed)

Add before the wake word model in `wakeword_oww.rs`:

1. **RNNoise** — real-time noise suppression (~2ms/frame, minimal CPU)
2. **AGC** — automatic gain control, normalizes quiet speech
3. **VAD gate** — skip model entirely when no voice detected

Files to modify:
- `src-tauri/src/wakeword_oww.rs` — insert preprocessing before `WakeEngine::process`
- `src-tauri/Cargo.toml` — add `rnnoise` crate

Expected: significant improvement in moderate noise, no training required.

### Phase 2: Retrain model with real + augmented data

**Step 1 — Record 50 real clips (10 min):**
```
python scripts/record_samples.py
```
- 20× "nexus" normal volume
- 10× "hey nexus"
- 10× "nexus" quiet
- 10× "nexus" from 3m distance

**Step 2 — Upload to Kaggle:**
- Zip: `zip -r nexus_real_samples.zip nexus_real_samples/`
- Upload as Kaggle dataset

**Step 3 — Run training notebook:**
- Open `scripts/train_wakeword.ipynb` in Kaggle (GPU enabled)
- Attach your `nexus_real_samples` dataset
- Run all cells (~30–40 min)
- openWakeWord generates 20K TTS samples + augments with real clips + noise

**Step 4 — Download and replace:**
- Download `nexus.onnx` from Kaggle output
- Replace `src-tauri/resources/oww/nexus.onnx`
- Rebuild: `cargo build --release --features custom-protocol`

**Step 5 — Test:**
- Test in quiet room, with music, with TV, at 1m and 3m distance
- Compare false positive rate over 1 hour of normal speech

### Phase 3: Advanced (optional, later)

- Collect more data over time (100+ clips from different people)
- Train speaker-verification model (only responds to your voice)
- Consider Sherpa-ONNX KWS as alternative (`wakeword-sherpa` feature exists)
- External USB mic support for far-field use

## What the training notebook does

`scripts/train_wakeword.ipynb`:
1. Installs openWakeWord + Piper TTS + dependencies
2. Downloads MIT room impulse responses + AudioSet noise data
3. Generates 20K synthetic "nexus" + "hey nexus" clips via Piper TTS
4. Mixes real recordings (if uploaded) into training set
5. Augments all clips with noise, reverb, volume variation
6. Trains DNN model (30K steps, ~20 min on T4 GPU)
7. Exports `nexus.onnx` ready for drop-in replacement

## Realistic expectations

| Condition | Now | After Phase 1+2 |
|---|---|---|
| Quiet room, 1m | Works | Works |
| Background music | Fails | Works |
| TV playing | Fails | Works (moderate volume) |
| Quiet/whisper speech | Fails | Partial |
| 3m distance | Fails | Works (with louder speech) |
| Loud party/kitchen | Fails | Still hard (hardware limit) |

## Files

| File | Purpose |
|---|---|
| `scripts/train_wakeword.ipynb` | Kaggle training notebook |
| `scripts/record_samples.py` | Real sample recorder (50 clips, 10 min) |
| `src-tauri/resources/oww/nexus.onnx` | Current model (replace after training) |
| `src-tauri/src/wakeword_oww.rs` | Wake word engine (add preprocessing in Phase 1) |
