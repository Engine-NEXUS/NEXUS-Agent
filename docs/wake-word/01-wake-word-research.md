# Wake Word Detection Research (2024-2026)

> Research into how production voice assistants and open-source projects handle wake word detection.
> All data is from 2024-2026 sources. No legacy data.

---

## 1. Introduction

### 1.1 The Problem

During testing of NEXUS's original VAD+ASR wake word detection, we observed:

> "when I called nexus 10 times, it only tracked audio 3 times, and only once tracked nexus"

This is a **~30% recall rate** — unacceptable for a voice assistant. Users expect Alexa-like reliability (>95%). This prompted research into how production systems solve wake word detection.

### 1.2 Research Scope

- How Amazon Alexa Echo Dot works (2024-2025)
- How Google Assistant and Apple Siri work
- Why VAD+ASR fails for wake word detection
- Modern open-source KWS (Keyword Spotting) options
- Key academic papers (2024-2025)
- Production system architecture comparison

---

## 2. How Amazon Alexa Echo Dot Works (2024-2025)

### 2.1 Architecture

Amazon Echo devices use **on-device keyword spotting** — a dedicated KWS model that runs continuously on the raw audio stream.

**Key architectural points:**

| Aspect | Implementation |
|--------|---------------|
| Chip | Custom AZ3 / AZ3 Pro (2025 Echo Dot Max) |
| Architecture | Two-stage DNN |
| Stage 1 | Fast DNN acoustic model scans every audio frame |
| Stage 2 | Monophone-based background model verifies candidate |
| VAD | **None** — KWS runs directly on raw audio |
| Sliding window | Processes audio continuously every ~30ms |
| Audio storage | **None** — short RAM buffer constantly overwritten |
| Cloud streaming | Only after wake word detected |
| Encryption | TLS 1.2 for cloud communication |

### 2.2 Two-Stage Detection

From Amazon Science papers:

> "We introduce a two-stage wake word system based on Deep Neural Network (DNN) acoustic modeling, propose a new way to model the non-keyword background events using monophone-based units..."

- **Stage 1**: Fast DNN scans every audio frame for the wake word pattern
- **Stage 2**: Monophone-based background model verifies the candidate
- Result: **16% reduction in False Reject Rate** at fixed false alarm level
- Result: **37% reduction in False Alarm Rate** at fixed miss rate
- Stage 2 alone reduces false alarm rate by **67%** on top of Stage 1

### 2.3 2025 Echo Dot Max

From the 2025 Amazon event:

> "The Echo Dot Max was given the AZ3, which Amazon says powers the microphone array, supports free-flowing conversations with Alexa Plus, and filters out background noise and improves Alexa's ability to detect wake-words by over 50%."

### 2.4 Privacy Architecture

From Amazon's privacy white paper:

> "Echo devices use on-device keyword spotting designed to detect when a customer says the wake word. This technology inspects acoustic patterns in the room to detect when the wake word has been spoken using a short, on-device buffer that is continuously overwritten."

> "The device does not stream audio to the cloud until the wake word is detected or the action button on the device is pressed."

### 2.5 Performance Targets

| Metric | Target |
|--------|--------|
| False Reject Rate (FRR) | <5% |
| False Alarm Rate (FAR) | <0.5 per hour |
| Detection latency | <100ms |
| Power consumption | Ultra-low (dedicated chip) |

---

## 3. How Google Assistant / Apple Siri Work

### 3.1 Same Fundamental Architecture

Google Assistant ("Hey Google") and Apple Siri ("Hey Siri") use the same fundamental architecture as Alexa:

| Aspect | Google | Apple Siri |
|--------|--------|------------|
| Wake word | "Hey Google" | "Hey Siri" |
| KWS model | Dedicated small model | Dedicated small model |
| VAD | **None** | **None** |
| Sliding window | Continuous, every 10-30ms | Continuous, every 10-30ms |
| Model size | ~100KB-2MB | ~100KB-2MB |
| Execution core | Low-power always-on core | Low-power always-on core (Neural Engine) |
| Cloud streaming | Only after wake detected | Only after wake detected |

### 3.2 Key Difference from VAD+ASR

```
PRODUCTION SYSTEMS (Alexa, Google, Siri):
  Audio → KWS sliding window → [score every 30ms] → threshold check → wake
  No VAD. No segmentation. Continuous scoring.

VAD+ASR (our old approach):
  Audio → VAD gate → [wait for speech segment] → ASR → match keyword
  Problem: VAD clips start, ASR gets incomplete audio
```

---

## 4. Why VAD+ASR Fails for Wake Word Detection

### 4.1 Problem 1: VAD Clips the Start of Words

**The issue:**
- VAD (Voice Activity Detection) needs 0.2-0.3 seconds of continuous speech before triggering
- "NEXUS" is only ~0.6-0.8 seconds long
- By the time VAD says "speech started," the first 200-300ms of the word is already gone
- ASR gets an incomplete audio segment → misrecognizes

**Evidence:**

| Source | Finding |
|--------|---------|
| pipecat #984 (2024) | "Short utterances like 'OK', 'Yes', 'No' aren't heard by the bot. The root cause is that the VAD is not triggered. The default start_secs is 0.2 seconds." |
| omi #5265 (2024) | "VAD gate clips the beginning of phrases — first words not transcribed. When a user starts speaking, the first few words are clipped and never reach the transcription service." |
| silero-vad #738 (2024) | "I am building a wake word detection pipeline where Silero VAD acts as a 'gate'. When VAD detects speech, I only have the current 520-sample chunk available. If I pass just this chunk to the Wake Word model, it fails/misses predictions because the input is too short." |

**Our observation:**
ASR transcribed "NEXUS" as "next", "n", "mexic" — it was getting the tail end of the word, not the full word.

### 4.2 Problem 2: VAD Segments Can Split Words

**The issue:**
- VAD uses silence thresholds to segment speech
- If user says "NEXUS" with a slight pause between syllables ("NE" ... "XUS")
- VAD splits it into two segments: "NE" and "XUS"
- Neither segment is recognizable by ASR

**Our observation:**
ASR produced single-syllable outputs like "next", "us", "n" — consistent with VAD splitting the word.

### 4.3 Problem 3: ASR Is Not Optimized for Keyword Detection

**The issue:**
- ASR is designed for general transcription across ALL words
- It optimizes for overall accuracy, not for reliably catching one specific word
- ASR may produce phonetically similar but wrong transcriptions

**Evidence:**

| Source | Finding |
|--------|---------|
| sherpa-onnx #2678 (2024) | "The gigaspeech model had an extremely low wake-up success rate (less than 10%) for English keyword spotting." |
| sherpa-onnx docs | "An open vocabulary keyword spotting system is just like a tiny ASR system, but it can only decode words/phrases in the given keywords." |

**Our observation:**
ASR produced 11 different transcriptions for the same spoken word "NEXUS":
- nexus (correct — rare)
- dnexus, next us, nixis, mexic, necess, nexis, next, us, mixis, lexis

---

## 5. Modern Open-Source KWS Options (2024-2025)

### 5.1 openWakeWord

| Aspect | Details |
|--------|---------|
| License | Apache 2.0 (open source) |
| Version | v0.6.0 (Feb 2024) |
| Training | Synthetic TTS data (Piper) — no real audio needed |
| Target FRR | <5% |
| Target FAR | <0.5/hour |
| Rust port | oww-rs 0.3.3 (Oct 2025, 78K downloads) |
| Runtime | tract-onnx (pure Rust) or ONNX Runtime |
| Architecture | melspectrogram → embedding → classifier |
| Chunk size | 1280 samples (80ms at 16kHz) |
| Speaker verification | Custom verifier models (second-stage filter) |
| Custom wake words | Train via Colab notebook (~1 hour) |

**How training works:**
1. Generate synthetic "nexus" audio with Piper TTS (multi-speaker, varied accents)
2. Generate adversarial negatives (similar-sounding words)
3. Download background noise data for augmentation
4. Train small DNN classifier (32-layer, ~80KB) on frozen embedding model
5. Export to `.onnx`

**Rust integration (oww-rs):**
- Uses `tract-onnx` runtime (no native ONNX Runtime dependency)
- Works with `cpal` for mic capture
- Ships with `alexa` and `hey_mycroft` models built-in
- Can load custom `.onnx` models from file

### 5.2 Porcupine (Picovoice)

| Aspect | Details |
|--------|---------|
| License | Commercial (free tier available) |
| Training | Type-to-train (type "nexus" in console, get model in seconds) |
| Accuracy | 11x more accurate than PocketSphinx, 6.5x faster |
| Platforms | Windows, macOS, Linux, Android, iOS, web |
| API key | **Required** (online activation needed) |
| Open source | **No** (commercial product) |
| Model format | Platform-specific .ppn files |

**Cons:**
- Requires API key and online activation (devices must contact Picovoice server)
- Free tier has limited device count
- Models are platform-specific (Linux model won't run on Windows)
- Not fully open source

### 5.3 micro-wake-word (ESPHome/Home Assistant)

| Aspect | Details |
|--------|---------|
| License | Open source |
| Target | Microcontrollers (ESP32) |
| Architecture | Spectrogram → MixConv streaming model |
| Feature extraction | 40 spectrogram features every 10ms |
| Use case | Home Assistant Voice |

**Not ideal for NEXUS** because it's optimized for microcontrollers, not desktop.

### 5.4 sherpa-onnx KWS

| Aspect | Details |
|--------|---------|
| License | Apache 2.0 |
| English model | sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 |
| Chinese model | sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01 |
| English recall | **<10%** (known issue) |
| Chinese recall | **>90%** |
| Open vocabulary | Yes (boosting scores + trigger thresholds) |

**Not viable for English** — the GigaSpeech model has a known <10% recognition rate.

---

## 6. Key Academic Papers (2024-2025)

### 6.1 DS-KWS (Oct 2025)
- **Paper**: "Dual Data Scaling for Robust Two-Stage User-Defined Keyword Spotting"
- **Result**: 99.13% recall at 1 false alarm/hour on Hey-Snips dataset
- **Architecture**: CTC-based + QbyT-based phoneme matcher
- **Key insight**: Two-stage approach (detect + verify) significantly outperforms single-stage

### 6.2 RepCNN (Interspeech 2024)
- **Paper**: "RepCNN: Micro-sized, Mighty Models for Wakeword Detection"
- **Focus**: Efficient models for always-on mobile applications
- **Key insight**: Re-parameterizable fully convolutional encoder achieves high accuracy with simple inference graph

### 6.3 CDC-KWS (ICASSP 2025)
- **Paper**: "Streaming Keyword Spotting Boosted by Cross-layer Discrimination Consistency"
- **Result**: 6.8% absolute recall improvement, 46.3% relative miss rate reduction
- **Key insight**: Cross-layer discrimination consistency improves false alarm filtering

### 6.4 MFA-KWS (May 2025)
- **Paper**: "MFA-KWS: Effective Keyword Spotting with Multi-head Frame-asynchronous Decoding"
- **Result**: State-of-the-art on Snips, MobvoiHotwords, LibriKWS-20
- **Key insight**: 47%-63% speed-up over frame-synchronous baselines

### 6.5 Personal VAD (ICASSP 2024)
- **Paper**: "Efficient Personal Voice Activity Detection with Wake Word Reference Speech"
- **Focus**: Using wake word speech as reference for personal VAD
- **Key insight**: Ultra-high recall rate vital for speech assistant applications

### 6.6 Self-Learning KWS (Aug 2024)
- **Paper**: "Self-Learning for Personalized Keyword Spotting on Ultra-Low-Power Audio Sensors"
- **Result**: Up to +19.2% accuracy improvement with personalization
- **Key insight**: Pseudo-labeling from few user recordings improves model after deployment

---

## 7. Production System Architecture Comparison

| System | Architecture | VAD? | ASR? | KWS Model | Sliding Window | Custom Wake Word |
|--------|-------------|------|------|-----------|---------------|-----------------|
| Amazon Alexa | Two-stage DNN + monophone | No | No | Yes (custom chip) | Yes (~30ms) | Limited (Alexa, Echo, Computer) |
| Google Assistant | Dedicated KWS model | No | No | Yes (low-power core) | Yes (10-30ms) | No ("Hey Google") |
| Apple Siri | Dedicated KWS model | No | No | Yes (Neural Engine) | Yes (10-30ms) | No ("Hey Siri") |
| openWakeWord | 3-stage ONNX pipeline | No | No | Yes (trainable) | Yes (80ms) | **Yes** (train any word) |
| Porcupine | Dedicated KWS model | No | No | Yes (type-to-train) | Yes | **Yes** (type-to-train) |
| NEXUS (old) | VAD + ASR + text match | **Yes** | **Yes** | No | No (segment-based) | Text matching only |
| NEXUS (new) | openWakeWord KWS | No | No | Yes (nexus.onnx) | Yes (80ms) | **Yes** (trained model) |

---

## 8. Key Insight

> **Production systems do NOT use VAD+ASR for wake word detection.**
> They use dedicated KWS (Keyword Spotting) models that run continuously on sliding windows.
> KWS models learn the acoustic pattern of the wake word directly — not how to transcribe all English.
> This makes them robust to background noise, pronunciation variation, and word boundaries.

The fundamental difference:

| VAD+ASR | KWS |
|---------|-----|
| Wait for speech, then transcribe, then match text | Score every audio frame for the target word |
| Clips start of words (VAD delay) | Never misses start (no VAD) |
| Can split words (VAD segmentation) | Words stay intact (no segmentation) |
| Misrecognizes words (ASR errors) | Direct pattern detection (no transcription) |
| ~30% recall | >95% recall |

---

## 9. References

1. Amazon Science — "Monophone-based Background Modeling for Two-stage On-device Wake Word Detection"
2. Amazon Echo Dot Max (2025) — AZ3 chip announcement
3. Amazon Privacy White Paper — on-device keyword spotting
4. openWakeWord v0.6.0 (Feb 2024) — GitHub: dscripka/openWakeWord
5. oww-rs 0.3.3 (Oct 2025) — GitHub: skoky/oww_rs, crates.io
6. horchd (2025) — Native Rust multi-wakeword daemon, Codeberg
7. DS-KWS (arxiv 2510.10740, Oct 2025) — Two-stage KWS, 99.13% recall
8. RepCNN (Interspeech 2024) — Micro-sized KWS models
9. CDC-KWS (ICASSP 2025) — Streaming KWS with cross-layer discrimination
10. MFA-KWS (arxiv 2505.19577, May 2025) — Multi-head frame-asynchronous decoding
11. Personal VAD (ICASSP 2024) — Efficient personal VAD with wake word reference
12. Self-Learning KWS (arxiv 2408.12481, Aug 2024) — Personalized KWS on ultra-low-power sensors
13. sherpa-onnx #2678 (2024) — GigaSpeech KWS <10% recognition rate for English
14. pipecat #984 (2024) — VAD misses short utterances
15. omi #5265 (2024) — VAD gate clips beginning of phrases
16. silero-vad #738 (2024) — VAD as gate for wake word detection, input too short
17. Porcupine (Picovoice, 2025) — Type-to-train custom wake words
18. micro-wake-word (ESPHome) — Open-source KWS for microcontrollers
19. End-to-End Efficiency in KWS (arxiv 2509.07051, 2025) — System-level approach for MCUs
20. Dynamic convolution KWS (Nature, 2025) — Cross-frontend mutual learning strategy
