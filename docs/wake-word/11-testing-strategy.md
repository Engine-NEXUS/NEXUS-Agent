# Testing Strategy — Wake Word Detection System

> **Document ID:** `11-testing-strategy.md`
> **Subsystem:** Wake Word Detection (OpenWakeWord + tract-onnx)
> **Status:** Active
> **Last Reviewed:** 2025

---

## Table of Contents

1. [Overview](#1-overview)
2. [Phased Testing Approach](#2-phased-testing-approach)
3. [Test Categories](#3-test-categories)
   - 3.1 [Compile Tests](#31-compile-tests)
   - 3.2 [Model Loading Tests](#32-model-loading-tests)
   - 3.3 [Profile Serialization Tests](#33-profile-serialization-tests)
   - 3.4 [KWS Detection Tests](#34-kws-detection-tests)
   - 3.5 [Speaker Verification Tests](#35-speaker-verification-tests)
   - 3.6 [Runtime Tests](#36-runtime-tests)
   - 3.7 [Integration Tests](#37-integration-tests)
4. [Test Matrix](#4-test-matrix)
5. [Test Commands](#5-test-commands)
6. [Success Criteria](#6-success-criteria)
7. [Failure Handling](#7-failure-handling)
8. [Appendix A — Test Environment Setup](#appendix-a--test-environment-setup)
9. [Appendix B — Log Signatures Reference](#appendix-b--log-signatures-reference)

---

## 1. Overview

The wake word detection system replaces the legacy VAD + ASR pipeline with a dedicated keyword spotting (KWS) engine based on **OpenWakeWord** models executed via **tract-onnx**. Because this is a multi-phase migration that touches audio capture, ONNX inference, profile serialization, speaker verification, and the Tauri frontend, testing is performed in **phases**.

Each phase is tested and cross-checked in isolation before the next phase begins. After **two consecutive phases** are individually verified, they are tested **together** as an integration pair before proceeding to the third phase. This staggered approach catches cross-phase regressions early — before they can be masked by later layers.

### Testing Principles

| Principle | Description |
|-----------|-------------|
| **Isolation first** | Each phase is validated on its own with stubs/mocks for dependencies that belong to later phases. |
| **Pairwise integration** | After two phases pass individually, they are tested as a combined unit. |
| **Cross-check before proceed** | No phase advances until the previous phase's tests are re-run and still green. |
| **Real audio where possible** | Detection and speaker verification tests use live microphone input, not synthetic buffers. |
| **No audio leaves the device** | Every test category includes a network-egress assertion confirming no audio payload is transmitted. |

---

## 2. Phased Testing Approach

The user's testing philosophy, stated verbatim:

> *"for each phases do the testing and cross check the changes once again before moving to next phase and test the 2 phases together then proceed to next so on"*

### Phase Progression Diagram

```
Phase 1 ──► [Test P1] ──► [Cross-check P1]
                                   │
                                   ▼
Phase 2 ──► [Test P2] ──► [Cross-check P2]
                                   │
                                   ▼
                         [Integration Test P1+P2]
                                   │
                                   ▼
Phase 3 ──► [Test P3] ──► [Cross-check P3]
                                   │
                                   ▼
                         [Integration Test P2+P3]
                                   │
                                   ▼
Phase 4 ──► [Test P4] ──► [Cross-check P4]
                                   │
                                   ▼
                         [Integration Test P3+P4]
                                   │
                                   ▼
Phase 5 ──► [Test P5] ──► [Cross-check P5]
                                   │
                                   ▼
                         [Integration Test P4+P5]
                                   │
                                   ▼
                         [Full System Integration Test]
```

### Phase Mapping

| Phase | Scope | Primary Test Categories |
|-------|-------|------------------------|
| **Phase 1** | ONNX model loading + resource resolution | §3.1, §3.2 |
| **Phase 2** | Profile serialization (wake variants, sound-alikes) | §3.3 |
| **Phase 3** | KWS detection engine (tract-onnx inference loop) | §3.4 |
| **Phase 4** | Speaker verification integration | §3.5 |
| **Phase 5** | Runtime wiring + frontend integration + hotkey | §3.6, §3.7 |

### Cross-Check Protocol

After completing the individual tests for a phase, **re-run all prior phase tests** before declaring the phase complete. This ensures that changes made during the current phase have not introduced a regression in an earlier layer.

```
For each phase N:
  1. Run Phase N individual tests  →  must all PASS
  2. Re-run Phases 1..N-1 tests    →  must all still PASS
  3. If N ≥ 2: Run Integration Test for Phases (N-1, N)  →  must PASS
  4. Only then proceed to Phase N+1
```

---

## 3. Test Categories

### 3.1 Compile Tests

**Objective:** Ensure the codebase compiles cleanly across all feature flag combinations and the frontend builds without TypeScript or bundler errors.

#### 3.1.1 Rust — Default Features

| Item | Value |
|------|-------|
| **Command** | `cargo check` |
| **Working directory** | `src-tauri/` |
| **Default features** | `wakeword-oww` |
| **Expected result** | Compiles with zero errors, zero warnings (warnings treated as review items) |

#### 3.1.2 Rust — Mock Wake Feature

| Item | Value |
|------|-------|
| **Command** | `cargo check --features mock-wake --no-default-features` |
| **Working directory** | `src-tauri/` |
| **Purpose** | Verify the mock wake word backend compiles for CI / headless testing without real ONNX models |
| **Expected result** | Compiles with zero errors |

#### 3.1.3 Frontend — Production Build

| Item | Value |
|------|-------|
| **Command** | `npm run build` |
| **Working directory** | `frontend/` |
| **Expected result** | Vite/TSC build completes; no type errors; `dist/` produced |

#### 3.1.4 Pass/Fail Criteria

All three commands **must** exit with code `0` and produce no error-level diagnostics. Warning-level diagnostics are logged for review but do not block phase progression unless they represent unused imports of new code paths (indicating dead code).

```bash
# Combined gate — all must pass
cd src-tauri && cargo check && \
cargo check --features mock-wake --no-default-features && \
cd ../frontend && npm run build && \
echo "✅ ALL COMPILE TESTS PASSED"
```

---

### 3.2 Model Loading Tests

**Objective:** Verify that all three ONNX models required by OpenWakeWord load successfully, that missing models produce actionable error messages, and that the resource directory resolution logic works across production, development, and fallback paths.

#### 3.2.1 Required Models

| Model File | Role | Input | Output |
|------------|------|-------|--------|
| `melspectrogram.onnx` | Audio feature extraction (mel-spectrogram) | Raw audio frames (16 kHz, mono) | Mel filter bank features |
| `embedding_model.onnx` | Audio embedding (teacher model) | Mel features | 192-dim embedding vector |
| `nexus.onnx` | Wake word classifier | Embedding vector | Probability score [0.0, 1.0] |

#### 3.2.2 Test Cases

| ID | Test | Steps | Expected Result |
|----|------|-------|-----------------|
| ML-01 | Load melspectrogram.onnx | Start app with all 3 models present | Log: `Loaded ONNX model: melspectrogram.onnx`; no panic |
| ML-02 | Load embedding_model.onnx | Start app with all 3 models present | Log: `Loaded ONNX model: embedding_model.onnx`; no panic |
| ML-03 | Load nexus.onnx | Start app with all 3 models present | Log: `Loaded ONNX model: nexus.onnx`; no panic |
| ML-04 | Missing nexus.onnx | Remove `nexus.onnx` from resource dir; start app | Descriptive error: `nexus.onnx not found at <resolved_path>. Wake word detection disabled.` App does **not** crash; degrades gracefully |
| ML-05 | Missing melspectrogram.onnx | Remove `melspectrogram.onnx`; start app | Error: `melspectrogram.onnx not found. Cannot run KWS pipeline.` Graceful degradation |
| ML-06 | Corrupt model file | Replace `nexus.onnx` with random bytes; start app | Error: `Failed to load ONNX model nexus.onnx: <tract error>. Invalid model format.` Graceful degradation |
| ML-07 | Production resource path | Run `cargo tauri dev` (or built binary) | Models load from `resources/models/` relative to binary |
| ML-08 | Dev resource path | Run via `cargo tauri dev` with dev resource override | Models load from `src-tauri/resources/models/` |
| ML-09 | Fallback resource path | Set `WAKEWORD_MODELS_DIR` env var to a custom path | Models load from env-var-specified directory |

#### 3.2.3 Resource Directory Resolution Order

The system resolves the model directory in the following priority:

1. **Environment variable** `WAKEWORD_MODELS_DIR` (if set and directory exists)
2. **Production path** — `<binary_dir>/resources/models/`
3. **Dev path** — `src-tauri/resources/models/` (relative to project root, detected via `CARGO_MANIFEST_DIR`)
4. **Fallback** — current working directory `./resources/models/`

If none of the above contain the required model files, the wake word engine enters **disabled mode** and logs an error. The application continues to function with hotkey-only wake.

---

### 3.3 Profile Serialization Tests

**Objective:** Verify that the user profile JSON schema correctly serializes and deserializes the new `wake_variants` and `sound_alikes` fields, maintains backward compatibility with old profiles, and enforces business rules (deduplication, 30-variant cap, baseline presence).

#### 3.3.1 Schema Fields Under Test

| Field | Type | Description |
|-------|------|-------------|
| `wake_variants` | `Vec<String>` | Accumulated wake word variants from re-enrollment sessions |
| `sound_alikes` | `Vec<String>` | Known sound-alike words to suppress (e.g., "next", "mexic", "focus") |
| `wake_word` | `String` | Primary wake word (always `"nexus"` for this system) |

#### 3.3.2 Test Cases

| ID | Test | Input | Expected Result |
|----|------|-------|-----------------|
| PS-01 | New profile with wake_variants and sound_alikes | JSON with both new fields populated | Deserializes successfully; fields accessible in memory |
| PS-02 | Old profile without new fields (backward compat) | JSON from pre-migration profile (no `wake_variants`, no `sound_alikes`) | Deserializes successfully; `wake_variants` defaults to `["nexus"]`; `sound_alikes` defaults to `[]` |
| PS-03 | Variant accumulation on re-enrollment | Profile with `wake_variants: ["nexus"]`; user re-enrolls → new variant `"nexus-2"` captured | After re-enrollment + save + reload: `wake_variants: ["nexus", "nexus-2"]` |
| PS-04 | Deduplication of variants | Profile with `wake_variants: ["nexus", "nexus"]`; save + reload | `wake_variants: ["nexus"]` (duplicates removed) |
| PS-05 | 30-variant cap enforcement | Profile with 30 variants; attempt to add 31st | 31st variant is **not** added; log: `Wake variant cap (30) reached, ignoring new variant.`; `wake_variants.len() == 30` |
| PS-06 | Baseline "nexus" always present | Profile with `wake_variants: []` or missing field | After load: `wake_variants` contains at least `"nexus"` as first element |
| PS-07 | Sound-alikes persistence | Profile with `sound_alikes: ["next", "focus"]`; save + reload | `sound_alikes` preserved exactly |
| PS-08 | Sound-alikes deduplication | Profile with `sound_alikes: ["next", "next", "focus"]`; save + reload | `sound_alikes: ["next", "focus"]` |
| PS-09 | Round-trip integrity | Deserialize → modify → serialize → deserialize | Second deserialize matches modified state exactly |
| PS-10 | Malformed JSON handling | Corrupt JSON file | Error logged: `Failed to parse profile JSON: <error>. Creating fresh profile.`; fresh profile created with defaults |

#### 3.3.3 Variant Cap Edge Cases

| Scenario | Current Count | Attempted Add | Result |
|----------|---------------|---------------|--------|
| Below cap | 28 | 1 variant | Accepted; count → 29 |
| At cap | 30 | 1 variant | Rejected; count stays 30 |
| At cap | 30 | 0 variants (no-op) | No change; count stays 30 |
| Over cap (corrupt input) | 35 (manually edited) | N/A | On load: truncated to first 30; log: `Wake variants count (35) exceeds cap, truncating to 30.` |

---

### 3.4 KWS Detection Tests

**Objective:** Validate that the keyword spotting engine reliably detects the wake word "NEXUS" while rejecting similar-sounding words, unrelated speech, background noise, and silence.

#### 3.4.1 Test Setup

| Parameter | Value |
|-----------|-------|
| Microphone | Primary system microphone (16 kHz, mono) |
| Environment | Quiet room, ~40 dB ambient |
| Speaker | Primary enrolled user (unless noted) |
| Threshold | 0.5 (default) |
| Model | `nexus.onnx` (OpenWakeWord custom model) |
| Detection window | 16 audio frames per inference pass |

#### 3.4.2 Test Cases

| ID | Test | Input | Target | Expected Result |
|----|------|-------|--------|-----------------|
| KW-01 | Say "NEXUS" ×10 | Speak "NEXUS" clearly, 10 times with ~2s gaps | >9/10 detections | Log: `OWW wake detected! (probability: X.XXX)` for ≥9 utterances; `wake-word: NEXUS detected → triggering wake` |
| KW-02 | Sound-alike: "next" | Say "next" ×10 | 0/10 detections | No wake event; log may show `probability: 0.0XX` (below threshold) |
| KW-03 | Sound-alike: "mexic" | Say "mexic" ×10 | 0/10 detections | No wake event |
| KW-04 | Sound-alike: "focus" | Say "focus" ×10 | 0/10 detections | No wake event |
| KW-05 | Unrelated speech | Speak 30 seconds of normal conversation (no "nexus") | 0 detections | No wake event; KWS probability stays below threshold |
| KW-06 | Background noise only | Play office/cafeteria noise for 60 seconds | 0 detections | No wake event; false alarm rate <0.5/hr |
| KW-07 | Silence | 60 seconds of silence (mic muted) | 0 detections | No wake event; no CPU spike |
| KW-08 | Varying volume | Say "NEXUS" at low, medium, high volume (×3 each) | >8/9 detections | KWS should be volume-tolerant within reasonable range |
| KW-09 | Varying distance | Say "NEXUS" at 0.5m, 1m, 2m from mic (×3 each) | >7/9 detections | KWS should be distance-tolerant within reasonable range |
| KW-10 | Rapid repetition | Say "NEXUS NEXUS NEXUS" rapidly | ≥2/3 detections | At least 2 of 3 rapid utterances detected |

#### 3.4.3 Detection Probability Logging

Each inference pass should log the probability score when it exceeds a debug threshold (e.g., 0.3), even if it doesn't reach the wake threshold (0.5). This allows threshold tuning:

```
[DEBUG] oww: probability=0.42 (below threshold 0.50) — not triggering
[INFO]  OWW wake detected! (probability: 0.87)
[INFO]  wake-word: NEXUS detected → triggering wake
```

#### 3.4.4 False Alarm Measurement

| Metric | Measurement Method | Target |
|--------|-------------------|--------|
| False alarms per hour | Count wake events during 1 hour of non-"nexus" speech + noise | <0.5 |
| False alarms in silence | Count wake events during 1 hour of silence | 0 |
| False alarms in noise | Count wake events during 1 hour of background noise | <0.5 |

---

### 3.5 Speaker Verification Tests

**Objective:** Ensure that when a speaker profile is enrolled, only the enrolled user can trigger the wake event. In open mode (no profile), any speaker may trigger.

#### 3.5.1 Test Cases

| ID | Test | Setup | Input | Expected Result |
|----|------|-------|-------|-----------------|
| SV-01 | Enrolled user triggers | Enroll primary user's voice profile | Primary user says "NEXUS" ×10 | ≥9/10 trigger wake event |
| SV-02 | Different person rejected | Enroll primary user; secondary user present | Secondary user says "NEXUS" ×10 | 0/10 trigger; log: `Speaker verification failed (score: X.XX < threshold 0.5). Ignoring wake.` |
| SV-03 | Open mode — anyone triggers | No profile enrolled (fresh install / profile deleted) | Any person says "NEXUS" ×5 | ≥4/5 trigger wake event; log: `No speaker profile enrolled — open mode, accepting wake.` |
| SV-04 | Threshold boundary | Enroll primary user | Primary user says "NEXUS" at varying distances/volumes | Score logged for each; verify scores cluster above 0.5 for enrolled user |
| SV-05 | Re-enrollment updates profile | Existing profile; user re-enrolls | Re-enroll with 3 new utterances | Profile updated; verification still works; variant count increases |
| SV-06 | Profile deletion → open mode | Delete profile at runtime | Any person says "NEXUS" | System transitions to open mode; wake triggers |

#### 3.5.2 Threshold Calibration

| Parameter | Default | Tuning Range | Notes |
|-----------|---------|--------------|-------|
| Speaker verification threshold | 0.5 | 0.3 – 0.7 | Lower = more permissive (higher false accept); Higher = more strict (higher false reject) |
| KWS detection threshold | 0.5 | 0.3 – 0.7 | Lower = more sensitive; Higher = fewer false alarms |

**Calibration procedure:**

1. Enroll primary user with 5 utterances.
2. Primary user says "NEXUS" ×20 → record verification scores.
3. Secondary user says "NEXUS" ×20 → record verification scores.
4. Plot score distributions. The threshold should sit in the valley between the two distributions.
5. If distributions overlap significantly, re-enroll with more utterances (up to 10).

> **Note:** The default threshold of 0.5 is a starting point. Real-world deployment may require tuning based on microphone quality, ambient noise, and user voice characteristics.

---

### 3.6 Runtime Tests

**Objective:** Validate the full runtime behavior of the NEXUS application with the new KWS engine, including model path resolution, open-mode fallback, memory/CPU footprint, and ordinary-speech rejection.

#### 3.6.1 Test Cases

| ID | Test | Steps | Expected Result |
|----|------|-------|-----------------|
| RT-01 | Model path resolution on startup | `cargo tauri dev` → check startup logs | Logs show resolved paths for all 3 models: `Model path: <path>/melspectrogram.onnx`, etc. |
| RT-02 | No-profile open mode | Delete/clear profile → start app → say "NEXUS" | Log: `No speaker profile enrolled — operating in open mode.`; wake triggers for any speaker |
| RT-03 | Known sound-alike suppression (old engine) | If using legacy VAD+ASR engine: say "next" | Transcript captured; sound-alike check rejects; log: `Sound-alike "next" detected, suppressing wake.` |
| RT-04 | Ordinary speech does not trigger | Speak 60 seconds of normal conversation | No wake events; KWS probability stays below 0.5 |
| RT-05 | Memory usage — KWS engine | Start app; wait 30s for stabilization; check `Task Manager` or `ps` | KWS engine RSS <60 MB (target: ~30–50 MB) |
| RT-06 | CPU usage — idle | Start app; let sit idle (no audio activity) for 60s; check CPU | <5% CPU at idle |
| RT-07 | CPU usage — active detection | Speak continuously for 60s; check CPU | <10% CPU during active detection |
| RT-08 | Graceful degradation — missing models | Remove all model files → start app | App starts; log: `Wake word models not found. Wake detection disabled. Hotkey still active.`; hotkey works |
| RT-09 | Hot reload after model restoration | Restore model files while app running (if supported) or restart | KWS engine initializes; detection resumes |
| RT-10 | Long-running stability | Let app run for 1 hour with periodic "NEXUS" utterances (every ~5 min) | No memory leaks; detection rate stable; no crashes |

#### 3.6.2 Memory Measurement Commands

```bash
# Windows (PowerShell)
Get-Process -Name "ultron" | Select-Object Name, WorkingSet64, CPU

# Linux/Mac
ps -o rss,vsz,pcpu,pid -p $(pgrep -f ultron)
# or
top -pid $(pgrep -f ultron) -l 2 -s 5 | tail -1
```

#### 3.6.3 Memory Budget Breakdown

| Component | Budget | Notes |
|-----------|--------|-------|
| KWS engine (tract-onnx + models) | ~30–50 MB | Three small ONNX models in memory |
| Audio capture buffer | ~1–2 MB | Ring buffer of 16 kHz mono frames |
| Speaker verification (if active) | ~5–10 MB | Embedding comparison vectors |
| Tauri + frontend overhead | ~80–100 MB | WebView + Rust runtime (not counted in KWS budget) |
| **Total KWS-specific** | **<60 MB** | Excluding Tauri/WebView baseline |

---

### 3.7 Integration Tests

**Objective:** Verify that the wake word system integrates correctly with the existing Tauri application — hotkey, overlay window, frontend event handling, WebSocket connection, and audio privacy.

#### 3.7.1 Test Cases

| ID | Test | Steps | Expected Result |
|----|------|-------|-----------------|
| IT-01 | Hotkey still works | Press `Ctrl+Shift+Space` | Wake event triggered; overlay appears; log: `Hotkey wake triggered` |
| IT-02 | Voice wake and hotkey converge | (a) Say "NEXUS" → (b) Press hotkey | Both trigger the **same** frontend handler; identical overlay behavior; log: `wake-word: NEXUS detected → triggering wake` and `Hotkey wake triggered` both call `onWake()` |
| IT-03 | Overlay window shows on wake | Say "NEXUS" | Overlay window appears within 200ms of wake event; positioned correctly on active monitor |
| IT-04 | Overlay dismiss | Click dismiss / press Escape | Overlay closes; system returns to listening mode |
| IT-05 | Audio stays local | Start app → say "NEXUS" → monitor network traffic with Wireshark or `netstat` | No audio data packets sent to any server; only WebSocket control messages (text/JSON) if any |
| IT-06 | WebSocket unaffected | Start app → verify WS connection → trigger wake → verify WS still connected | WebSocket connection state unchanged by wake event; no reconnect needed |
| IT-07 | Rapid wake events | Say "NEXUS" → immediately press hotkey → say "NEXUS" again | All three trigger; no race condition; no duplicate overlay; debounce works |
| IT-08 | Wake during active listening | Trigger wake → start speaking command → trigger wake again | Second wake is either ignored (cooldown) or resets listening; no crash |
| IT-09 | App minimize + wake | Minimize app → say "NEXUS" | Wake still detected; overlay appears; app restores if needed |
| IT-10 | Full session cycle | Start app → enroll → say "NEXUS" → speak command → dismiss → say "NEXUS" again → dismiss → close app | No errors throughout; clean shutdown; profile saved |

#### 3.7.2 Audio Privacy Verification

| Check | Method | Expected |
|-------|--------|----------|
| No audio over WebSocket | Inspect WS frames in browser devtools or Tauri inspector | Only JSON/text control messages; no binary audio frames |
| No audio over HTTP | Monitor outbound HTTP requests | No POST/PUT with audio content-type |
| No audio over raw TCP | `Wireshark` capture on loopback + external interfaces | No audio-encoded packets to non-local destinations |
| Audio buffer stays in-process | Code review + runtime assertion | Audio ring buffer is never serialized or sent across IPC as raw audio |

---

## 4. Test Matrix

The following matrix compares expected behavior between the **old engine** (VAD + ASR pipeline) and the **new engine** (KWS via OpenWakeWord + tract-onnx).

| Test Scenario | Old (VAD + ASR) | New (KWS) | Expected Result / Improvement |
|---------------|-----------------|-----------|-------------------------------|
| Say "NEXUS" ×10 | ~3/10 detected | >9/10 detected | **3× improvement** in recall |
| Say "next" | May false trigger (ASR transcribes "next" → fuzzy match "nexus") | No trigger (KWS trained specifically on "nexus", not "next") | **Eliminated false positive** |
| Say "mexic" | May false trigger | No trigger | **Eliminated false positive** |
| Say "focus" | May false trigger | No trigger | **Eliminated false positive** |
| Background noise | VAD may false trigger (noise crosses energy threshold) | No trigger (KWS trained on noisy data) | **Eliminated false positive** |
| Silence | No trigger | No trigger | Both correct — **unchanged** |
| Different speaker (profile enrolled) | Rejected by speaker verification | TODO: ring buffer integration needed | KWS needs speaker verification integration (Phase 4) |
| Hotkey (`Ctrl+Shift+Space`) | Works | Works | **Unchanged** — both paths converge on same handler |
| RAM usage | ~143 MB (VAD + ASR + Whisper model) | ~30–50 MB (three small ONNX models) | **3× reduction** |
| Latency (end of word → wake event) | 500–1000 ms (ASR processing + transcription) | ~80 ms (direct KWS inference) | **6–12× faster** |
| CPU at idle | ~8–12% (VAD constantly analyzing) | <5% (KWS inference is lightweight) | **2× reduction** |
| CPU during detection | ~15–25% (ASR inference) | <10% (ONNX inference is optimized) | **2× reduction** |
| Model size on disk | ~75 MB (Whisper tiny) | ~10 MB (3 ONNX models combined) | **7× reduction** |

---

## 5. Test Commands

### 5.1 Compile Tests

```bash
# ─── Rust: default features (wakeword-oww) ───
cd src-tauri && cargo check

# ─── Rust: mock-wake feature (headless / CI) ───
cd src-turi && cargo check --features mock-wake --no-default-features

# ─── Frontend: production build ───
cd frontend && npm run build
```

### 5.2 Runtime Test

```bash
# ─── Start the app in dev mode ───
cd .. && cargo tauri dev

# ─── Then say "NEXUS" repeatedly and check logs for: ───
# "OWW wake detected! (probability: X.XXX)"
# "wake-word: NEXUS detected → triggering wake"
```

### 5.3 Model Loading Verification

```bash
# ─── Check that models exist in expected locations ───
ls -la src-tauri/resources/models/
# Expected: melspectrogram.onnx, embedding_model.onnx, nexus.onnx

# ─── Run with explicit model directory (fallback test) ───
WAKEWORD_MODELS_DIR=/custom/path/to/models cargo tauri dev
```

### 5.4 Profile Serialization Test

```bash
# ─── Inspect current profile JSON ───
cat ~/.ultron/profile.json | jq '.wake_variants, .sound_alikes'

# ─── Test backward compat: strip new fields from an old profile ───
jq 'del(.wake_variants, .sound_alikes)' ~/.ultron/profile.json > /tmp/old_profile.json
# Replace profile, restart app, verify it loads with defaults
```

### 5.5 Memory & CPU Profiling

```bash
# ─── Windows (PowerShell) ───
Get-Process -Name "ultron" | Select-Object Name, @{N='RSS_MB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, CPU

# ─── Linux ───
ps -o rss,pcpu,pid -p $(pgrep -f ultron)
# RSS in KB, divide by 1024 for MB

# ─── Extended monitoring (60s sample) ───
# Linux/Mac
top -pid $(pgrep -f ultron) -l 12 -s 5 | grep ultron
```

### 5.6 Network Egress Check (Audio Privacy)

```bash
# ─── Monitor outbound connections during wake detection ───
# Windows
netstat -ano | findstr ESTABLISHED

# Linux
sudo tcpdump -i any -nn 'not port 22 and not port 53' -c 100

# ─── Wireshark filter for audio-like payloads ───
# Filter: tcp.payload length > 1000 and ip.dst != 127.0.0.1
```

### 5.7 Full Regression Suite (All Phases)

```bash
#!/bin/bash
# ─── Full regression: run after every phase completion ───
set -e

echo "=== Phase 1: Compile Tests ==="
cd src-tauri && cargo check
cargo check --features mock-wake --no-default-features
cd ../frontend && npm run build

echo "=== Phase 2: Model Loading ==="
# (Manual: start app, verify model load logs)
echo "→ Start 'cargo tauri dev' and verify model load logs"

echo "=== Phase 3: Profile Serialization ==="
# (Manual: test profile JSON round-trip)
echo "→ Test profile load/save with old and new formats"

echo "=== Phase 4: KWS Detection ==="
# (Manual: say NEXUS 10x, check detection count)
echo "→ Say NEXUS 10 times, verify >9 detections in logs"

echo "=== Phase 5: Integration ==="
# (Manual: hotkey + voice + overlay + WS)
echo "→ Test hotkey, voice wake, overlay, WebSocket"

echo "=== ALL REGRESSION TESTS COMPLETE ==="
```

---

## 6. Success Criteria

The wake word detection system is considered **production-ready** when all of the following criteria are met:

### 6.1 Detection Performance

| Criterion | Target | Measurement Method |
|-----------|--------|--------------------|
| **Recall** (true positive rate) | >95% (miss fewer than 1 in 20 utterances) | Say "NEXUS" ×20; count detections; `detections / 20 > 0.95` |
| **False alarm rate** | <0.5 per hour | 1 hour of non-"nexus" speech + noise; count false wake events |
| **Latency** | <100 ms from end of word to wake event | Timestamp comparison: audio frame timestamp vs. wake event timestamp |

### 6.2 Resource Usage

| Criterion | Target | Measurement Method |
|-----------|--------|--------------------|
| **RAM (KWS engine)** | <60 MB | Process RSS after 30s stabilization |
| **CPU at idle** | <5% | CPU% during 60s of silence |
| **CPU during active detection** | <10% | CPU% during 60s of continuous speech |

### 6.3 Privacy & Security

| Criterion | Target | Measurement Method |
|-----------|--------|--------------------|
| **Audio egress** | No audio leaves the device | Network capture during wake detection; no audio payloads |
| **Profile data** | Stored locally only | File system audit; no profile data in network traffic |

### 6.4 Compatibility

| Criterion | Target | Measurement Method |
|-----------|--------|--------------------|
| **Hotkey** | Still works | `Ctrl+Shift+Space` triggers wake |
| **Speaker verification** | Works when profile enrolled | Enrolled user accepted; non-enrolled user rejected |
| **Open mode** | Works when no profile | Any speaker can trigger |
| **Backward compatibility** | Old profiles load without error | Pre-migration profile JSON loads with default values for new fields |

### 6.5 Stability

| Criterion | Target | Measurement Method |
|-----------|--------|--------------------|
| **Long-running** | No crashes in 1 hour | App runs 1 hour with periodic wake events; no panic, no OOM |
| **Memory leak** | <5 MB growth in 1 hour | RSS at t=0 vs. t=60min; delta <5 MB |

---

## 7. Failure Handling

### 7.1 Tuning the Detection Threshold

The KWS detection threshold (`0.5` by default) is the primary tuning knob. Adjust based on observed performance:

#### 7.1.1 Low Recall (Missed Detections)

| Symptom | Action | New Threshold | Re-test |
|---------|--------|---------------|---------|
| Recall <90% | Lower threshold | 0.5 → **0.4** | Re-run KW-01 (say "NEXUS" ×10) |
| Recall still <90% at 0.4 | Lower further | 0.4 → **0.3** | Re-run KW-01 + KW-02..04 (check false positives) |
| Recall still <90% at 0.3 | **Stop tuning** — investigate model quality | — | Re-export model from training data; check audio preprocessing |

> **Warning:** Lowering the threshold below 0.3 dramatically increases false alarms. If recall is still poor at 0.3, the problem is likely in the model or audio pipeline, not the threshold.

#### 7.1.2 High False Alarm Rate

| Symptom | Action | New Threshold | Re-test |
|---------|--------|---------------|---------|
| False alarms >1/hour | Raise threshold | 0.5 → **0.6** | Re-run KW-05..07 (noise/silence tests) |
| False alarms still >1/hour at 0.6 | Raise further | 0.6 → **0.7** | Re-run KW-01 (verify recall still >9/10) |
| False alarms still >1/hour at 0.7 | **Stop tuning** — investigate model or audio quality | — | Check for audio feedback loop; retrain model with more negative examples |

#### 7.1.3 Threshold Decision Matrix

| Observed Recall | Observed False Alarms | Recommended Threshold | Action |
|-----------------|----------------------|----------------------|--------|
| >95% | <0.5/hr | 0.5 (keep default) | ✅ Done |
| 90–95% | <0.5/hr | 0.4 | Lower to improve recall |
| <90% | <0.5/hr | 0.3 | Lower significantly; monitor false alarms |
| >95% | 0.5–1/hr | 0.6 | Raise slightly to reduce false alarms |
| >95% | >1/hr | 0.7 | Raise significantly; monitor recall |
| 90–95% | 0.5–1/hr | 0.5 (keep) | Borderline; improve model instead |
| <90% | >1/hr | — | **Model problem** — retrain, do not tune threshold |

### 7.2 Model Loading Failures

| Symptom | Diagnostic Steps | Resolution |
|---------|-----------------|------------|
| Model doesn't load | 1. Check resolved path in logs 2. Verify file exists at that path 3. Check file permissions 4. Check file size (not zero) | Place model at correct path; fix permissions |
| `tract-onnx` crashes on load | 1. Check ONNX opset version compatibility 2. Verify model was exported correctly 3. Try loading with Python `onnxruntime` to isolate | Re-export model from training; ensure opset ≤17 (tract compatibility) |
| `tract-onnx` crashes during inference | 1. Check input tensor shapes match model expectations 2. Check audio preprocessing (mel-spectrogram params) 3. Check frame size (16 kHz, mono, correct window) | Fix preprocessing pipeline; re-export model with correct input spec |
| Model loads but detection never triggers | 1. Check threshold (may be too high) 2. Check probability logs (is probability ever >0?) 3. Verify audio is reaching the model (not silent buffer) | Fix audio pipeline; lower threshold; re-export model |

### 7.3 Speaker Verification Failures

| Symptom | Diagnostic Steps | Resolution |
|---------|-----------------|------------|
| Enrolled user rejected | 1. Check verification score in logs 2. Re-enroll with more utterances (5–10) 3. Check microphone consistency (same mic for enroll and verify) | Re-enroll; lower SV threshold (0.5 → 0.4) |
| Non-enrolled user accepted | 1. Check verification score 2. Raise SV threshold (0.5 → 0.6) 3. Re-enroll with more diverse utterances | Raise threshold; re-enroll |
| SV crashes or returns NaN | 1. Check embedding model loaded 2. Check embedding vector dimensions 3. Check for empty/null profile embeddings | Re-enroll; verify embedding model integrity |

### 7.4 Runtime Crashes

| Symptom | Diagnostic Steps | Resolution |
|---------|-----------------|------------|
| App crashes on startup | 1. Check `cargo tauri dev` console output 2. Check for missing model files 3. Check for missing profile directory | Create required directories; restore models |
| App crashes on wake | 1. Check logs for panic backtrace 2. Check for null pointer in audio buffer 3. Check for thread contention on ring buffer | Fix concurrency bug; add null checks |
| App crashes after long running | 1. Check for memory growth (leak) 2. Check for unbounded log growth 3. Check for thread accumulation | Fix memory leak; cap log rotation; fix thread spawning |

---

## Appendix A — Test Environment Setup

### A.1 Hardware Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Microphone | Any 16 kHz capable mic | USB condenser mic, noise-cancelling |
| CPU | Dual-core 2.0 GHz | Quad-core 2.5 GHz+ |
| RAM | 4 GB total | 8 GB+ total |
| Storage | 100 MB free (for models + app) | 1 GB free (for logs + profiles) |

### A.2 Software Requirements

| Component | Version |
|-----------|---------|
| Rust | ≥1.75 |
| Node.js | ≥18 |
| Tauri CLI | ≥2.0 |
| tract-onnx | ≥0.21 |
| OS | Windows 10/11, macOS 12+, or Ubuntu 22.04+ |

### A.3 Test Data

| Data | Source | Purpose |
|------|--------|---------|
| `nexus.onnx` | OpenWakeWord custom training | Wake word classifier |
| `melspectrogram.onnx` | OpenWakeWord pre-trained | Audio feature extraction |
| `embedding_model.onnx` | OpenWakeWord pre-trained | Audio embedding |
| Test audio clips (optional) | Pre-recorded "NEXUS" utterances | Reproducible detection tests |
| Old profile JSON | Pre-migration backup | Backward compatibility test |

### A.4 Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `WAKEWORD_MODELS_DIR` | Override model directory | `/data/ultron/models` |
| `RUST_LOG` | Log level | `debug` or `ultron::wakeword=trace` |
| `ULTRON_PROFILE_DIR` | Override profile directory | `/data/ultron/profiles` |

---

## Appendix B — Log Signatures Reference

The following log lines should appear during normal operation. These are the signatures to grep for during testing.

### B.1 Startup Logs

```
[INFO]  wakeword: Initializing OpenWakeWord KWS engine
[INFO]  wakeword: Model path: /path/to/resources/models/melspectrogram.onnx
[INFO]  wakeword: Model path: /path/to/resources/models/embedding_model.onnx
[INFO]  wakeword: Model path: /path/to/resources/models/nexus.onnx
[INFO]  wakeword: Loaded ONNX model: melspectrogram.onnx
[INFO]  wakeword: Loaded ONNX model: embedding_model.onnx
[INFO]  wakeword: Loaded ONNX model: nexus.onnx
[INFO]  wakeword: KWS engine ready (threshold: 0.50)
```

### B.2 Detection Logs

```
[DEBUG] oww: probability=0.42 (below threshold 0.50) — not triggering
[INFO]  OWW wake detected! (probability: 0.87)
[INFO]  wake-word: NEXUS detected → triggering wake
```

### B.3 Speaker Verification Logs

```
[INFO]  wakeword: No speaker profile enrolled — operating in open mode.
[INFO]  wakeword: No speaker profile enrolled — open mode, accepting wake.
[DEBUG] wakeword: Speaker verification score: 0.82 (threshold: 0.50) — accepted
[WARN]  wakeword: Speaker verification failed (score: 0.31 < threshold 0.5). Ignoring wake.
```

### B.4 Error Logs

```
[ERROR] wakeword: nexus.onnx not found at /path/to/resources/models/nexus.onnx. Wake word detection disabled.
[ERROR] wakeword: Failed to load ONNX model nexus.onnx: invalid model format. Invalid model format.
[ERROR] wakeword: melspectrogram.onnx not found. Cannot run KWS pipeline.
[WARN]  wakeword: Wake variants count (35) exceeds cap, truncating to 30.
[WARN]  wakeword: Wake variant cap (30) reached, ignoring new variant.
[ERROR] wakeword: Failed to parse profile JSON: <error>. Creating fresh profile.
```

### B.5 Integration Logs

```
[INFO]  wakeword: Hotkey wake triggered
[INFO]  wakeword: Wake event dispatched to frontend handler: onWake()
[INFO]  wakeword: Sound-alike "next" detected, suppressing wake.
```

---

## Appendix C — Phase Completion Checklist

Use this checklist before declaring a phase complete and proceeding to the next.

### Phase N Completion Checklist

- [ ] All individual test cases for Phase N pass
- [ ] All individual test cases for Phases 1..N-1 re-run and still pass (cross-check)
- [ ] Integration test for Phases (N-1, N) passes (if N ≥ 2)
- [ ] No new compiler warnings introduced
- [ ] No new memory leaks detected
- [ ] Log signatures match expected format (Appendix B)
- [ ] No audio egress observed (privacy check)
- [ ] Changes documented in commit message / PR description
- [ ] Code reviewed and approved

> **Gate:** All boxes must be checked before starting Phase N+1. No exceptions.

---

*End of document.*
