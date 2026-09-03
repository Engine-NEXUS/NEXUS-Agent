# NEXUS Architectural Timeline — Master Evolution Document

**Date:** 2026-09-03
**Purpose:** Future reference for architectural decisions and their rationale

---

## Overview

This document traces the evolution of NEXUS from a hackathon prototype to
a production cross-platform voice-first developer assistant. Each major
architectural shift is documented with:
- What changed
- Why it changed
- What the previous approach was
- What the new approach is
- What we learned

---

## Phase 1: Hackathon Prototype (Pre-2026-08-29)

### Architecture
- Cloud-only TTS (ElevenLabs, Fish Audio)
- Cloud-only STT (Google Cloud Speech-to-Text)
- Monolithic Cloudflare Worker
- Single Tauri window (orb only)
- No wake word — push-to-talk only
- No offline capability

### Why It Evolved
- Cloud dependencies made it unusable without internet
- API costs were unsustainable for 5-10 users
- Latency was 800ms-2s per interaction (network RTT)
- No privacy — all voice data went to third parties

---

## Phase 2: Voice Pipeline Migration (2026-08-29 to 2026-08-30)

### TTS: Cloud APIs → In-Process Kokoro
- **From:** ElevenLabs/Fish Audio API calls (200-800ms, $20-50/mo)
- **To:** Kokoro TTS in-process via `kokoro-rs` (1.7s cold, 250ms warm, $0)
- **Why:** Offline capability, zero cost, zero latency after load
- **See:** `36-tts-engine-evolution.md`

### STT: Cloud APIs → faster-whisper Python Sidecar
- **From:** Google Cloud Speech-to-Text API (800ms, $4/million chars)
- **To:** faster-whisper `tiny.en` via Python sidecar (500ms, $0, offline)
- **Why:** Offline capability, zero cost, hotword biasing support
- **See:** `37-stt-engine-evolution.md`

### Wake Word: None → openWakeWord + tract-onnx
- **From:** Push-to-talk only (Ctrl+Space)
- **To:** "Nexus" wake word via openWakeWord ONNX model + tract-onnx inference
- **Why:** True voice-first experience, hands-free operation
- **Model:** Custom-trained `nexus.onnx` (see `26-wake-word-training-guide.md`)

---

## Phase 3: RAM Crisis (2026-08-30)

### The Problem
After Phase 2, idle RAM was **1,644 MB** — more than Chrome with 20 tabs.
Users complained the app was a resource hog.

### The Fixes (in order of impact)
1. **Lazy window creation** — 5 windows → 1 window (−696 MB)
2. **Lazy STT server** — not started at boot (−339 MB)
3. **Lazy Kokoro TTS** — not loaded at boot (−350 MB)
4. **WebView2 low-memory mode** — orb uses `MemoryUsageTargetLevel::Low` (−138 MB)
5. **Lazy NLU server** — not pre-warmed (−50-100 MB)

**Result:** 1,644 MB → 104 MB (94% reduction)
**See:** `42-ram-optimization-journey.md`

---

## Phase 4: Moonshine Experiment (2026-08-29, Failed)

### What We Tried
Replace the faster-whisper Python sidecar with Moonshine STT (in-process Rust):
- **Goal:** Eliminate Python dependency, reduce RAM, simplify architecture
- **Result:** Garbage transcripts on real microphone audio
- **Lesson:** Accuracy > architecture. A clean architecture that doesn't work is worthless.

### What We Reverted To
faster-whisper Python sidecar (the original architecture).
**See:** `37-stt-engine-evolution.md`

---

## Phase 5: Voice UX Refinement (2026-09-01 to 2026-09-02)

### Loading Indicator Evolution
- **From:** Separate Tauri window with Lottie animation (~40 MB, Wayland bugs)
- **To:** In-orb rendering driven by React state (0 MB, no bugs)
- **Why:** Wayland click-through broken, extra WebView2 process, sync complexity
- **See:** `38-loading-indicator-evolution.md`

### Voice Acknowledgement Pipeline
- **From:** Always say "On it sir" (even for garbage), 250ms+ latency
- **To:** Validate first, cached TTS for instant "On it sir" (5ms), "Didn't catch that" for invalid
- **Why:** User requested validate-first flow, instant acknowledgement
- **See:** `39-voice-ack-pipeline-evolution.md`

### Self-Learning STT Corrections
- **From:** Static correction map (manual maintenance, doesn't scale)
- **To:** Self-learning from user repetition (automatic, user-specific)
- **Why:** Every user has different speech patterns; manual corrections don't scale
- **See:** `40-self-learning-stt.md`

---

## Phase 6: TTS Migration (2026-09-02)

### Kokoro → Piper
- **From:** Kokoro TTS (350 MB RAM, 1.7s load, 4 voices, 300 MB model)
- **To:** Piper TTS (80 MB RAM, 85ms load, 20+ voices, 63 MB model)
- **Why:** 270 MB RAM savings, 20x faster load, more voices
- **See:** `36-tts-engine-evolution.md`

---

## Phase 7: Cross-Platform CI (2026-09-02 to 2026-09-03)

### CI/CD Pipeline
- **From:** No CI, manual builds, no macOS testing
- **To:** Full CI pipeline with Windows .exe/.msi + macOS .app builds
- **Why:** "Whatever changes we make should be tested in the installer"
- **See:** `41-ci-cd-evolution.md`

### macOS Testing Without a Mac
- **Solution:** GitHub Actions macOS runners (real Apple hardware, free for public repos)
- **Limitation:** Can't test microphone, speaker, or visual rendering
- **See:** `41-ci-cd-evolution.md` → "What CI Proves vs. What Requires Physical Hardware"

---

## Phase 8: Remote Integration (2026-09-03)

### The Challenge
The remote `main` branch had diverged with architectural changes:
- Loading indicator moved inside the orb (separate window removed)
- Linux/Wayland compatibility changes
- Dead sherpa-onnx and voice-profile code removed
- Wakeword and app_registry restructured

Our local branch had:
- Piper TTS (replaced Kokoro)
- Self-learning STT corrections
- Fuzzy repo matching
- Cached acknowledgement TTS
- Installer CI changes

### The Integration Process
1. Saved local commits as patches
2. Reset to remote `main`
3. Re-applied local features against the new architecture
4. Resolved conflicts manually (didn't blindly overwrite remote changes)
5. Fixed broken comment+code-on-same-line issues from remote refactor
6. Removed references to deleted loading window infrastructure
7. Tested: Rust (104 tests), frontend (805 modules), installers (.exe + .msi)
8. CI: macOS ✅, Windows ✅, Linux ❌ (pre-existing)

### What Was Preserved from Remote
- In-orb loading indicator (not the old separate window)
- Wayland compatibility changes
- Removed sherpa-onnx and voice-profile code
- Restructured wakeword module
- App registry changes

### What Was Re-applied from Local
- Piper TTS (compatible with remote's lazy loading pattern)
- Self-learning STT corrections (new module, no conflicts)
- Fuzzy repo matching (additive to intent_parser.rs)
- Cached acknowledgement TTS (compatible with in-orb loading)
- CI installer jobs (additive to existing CI)
- `.gitattributes` (new file, no conflicts)

---

## Current Architecture (2026-09-03)

```
┌─────────────────────────────────────────────────────────────┐
│                    NEXUS Desktop App                        │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Orb      │  │ Sidebar  │  │ Settings │  │ Architect│   │
│  │ (always) │  │ (on dem) │  │ (on dem) │  │ (on dem) │   │
│  │ 35.8 MB  │  │ 174 MB   │  │ 174 MB   │  │ 174 MB   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│       │              │                                      │
│       ▼              ▼                                      │
│  ┌──────────────────────────────────────────────────┐      │
│  │              Rust Backend (nexus.exe)             │      │
│  │  47.8 MB                                          │      │
│  │                                                   │      │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │      │
│  │  │Wake Word│  │ Intent  │  │  TTS    │          │      │
│  │  │ (OWW +  │  │ Parser  │  │ (Piper) │          │      │
│  │  │tract)   │  │ + NLU   │  │ 80 MB   │          │      │
│  │  └─────────┘  └─────────┘  └─────────┘          │      │
│  │                                                   │      │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │      │
│  │  │  STT    │  │ STT     │  │  NLU    │          │      │
│  │  │ Proxy   │  │ Learning│  │ Client  │          │      │
│  │  │         │  │         │  │         │          │      │
│  │  └────┬────┘  └─────────┘  └────┬────┘          │      │
│  │       │                          │                │      │
│  └───────┼──────────────────────────┼────────────────┘      │
│          │                          │                        │
│          ▼                          ▼                        │
│  ┌──────────────┐          ┌──────────────┐                 │
│  │ Python STT   │          │ Python NLU   │                 │
│  │ faster-      │          │ BERT-Mini    │                 │
│  │ whisper      │          │ ONNX         │                 │
│  │ 128.6 MB     │          │ 50 MB (lazy) │                 │
│  │ port 39217   │          │ port 39218   │                 │
│  └──────────────┘          └──────────────┘                 │
│                                                             │
│  Total Idle: 104 MB (cold) / 232 MB (after STT) / 293 MB    │
│  (after TTS)                                                │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Worker (Cloud)                       │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Quota    │  │ Cache    │  │ Models   │  │ Research │   │
│  │ (D1)     │  │ (KV/D1)  │  │ (cascade)│  │ (Wiki)   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│                                                             │
│  LLM Cascade: Gemini Flash → Groq Qwen → CF llama-3.2      │
│  Research: Wikipedia REST + Wikidata (ad-free, no API key)  │
│  Storage: D1 (usage_log, cache_entries) + KV (CACHE)        │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Architectural Decisions

### 1. Python Sidecar for STT (Not In-Process Rust)
**Decision:** Use faster-whisper Python sidecar despite Python dependency.
**Rationale:** Accuracy > elegance. Moonshine (Rust) produced garbage.
**Trade-off:** +20 MB Python runtime, +complexity. Worth it for accuracy.
**See:** `37-stt-engine-evolution.md`

### 2. Piper for TTS (Not Kokoro)
**Decision:** Use Piper instead of Kokoro.
**Rationale:** 270 MB RAM savings, 20x faster load, marginal quality difference.
**Trade-off:** Slightly lower MOS (4.0 vs 4.3). Imperceptible to most users.
**See:** `36-tts-engine-evolution.md`

### 3. In-Orb Loading (Not Separate Window)
**Decision:** Render loading animation inside the orb, not a separate window.
**Rationale:** Wayland compatibility, 40 MB RAM savings, simpler sync.
**Trade-off:** Less visual flexibility (constrained to orb area).
**See:** `38-loading-indicator-evolution.md`

### 4. Self-Learning STT (Not Static Corrections)
**Decision:** Learn corrections from user repetition, not maintain a static map.
**Rationale:** Every user has different speech; manual corrections don't scale.
**Trade-off:** 3-observation cold start before auto-apply. Acceptable.
**See:** `40-self-learning-stt.md`

### 5. Validate Before Acknowledging
**Decision:** Validate command before saying "On it sir".
**Rationale:** Acknowledging garbage is worse than saying "Didn't catch that".
**Trade-off:** Slightly slower acknowledgement (regex validation ~1ms). Negligible.
**See:** `39-voice-ack-pipeline-evolution.md`

### 6. Cached TTS for Acknowledgement
**Decision:** Pre-synthesize "On it sir" and cache as raw PCM in RAM.
**Rationale:** 5ms playback vs 250ms synthesis. User wanted "milliseconds".
**Trade-off:** ~500 KB RAM for cached PCM. Negligible.
**See:** `39-voice-ack-pipeline-evolution.md`

### 7. GitHub Actions for macOS Testing
**Decision:** Use GitHub Actions macOS runners instead of buying a Mac.
**Rationale:** Free for public repos, real Apple hardware, no maintenance.
**Trade-off:** Can't test microphone/speaker/visual rendering. Acceptable for CI.
**See:** `41-ci-cd-evolution.md`

### 8. Unsigned macOS .app (Not .dmg)
**Decision:** Build unsigned .app in CI, not signed .dmg.
**Rationale:** No Apple Developer certificate ($99/year). .app works with
right-click → Open.
**Trade-off:** Users need to bypass Gatekeeper. Acceptable for now.
**See:** `41-ci-cd-evolution.md`

### 9. Single Cloudflare Worker (Not Multiple)
**Decision:** One Worker with internal modules, not multiple Workers.
**Rationale:** No cross-Worker latency, simpler deployment, lower cost.
**Trade-off:** Less isolation between modules. Acceptable for 5-10 users.
**See:** AGENTS.md → "Multi-Worker Optimization"

### 10. Non-Activating Sidebar (No window-vibrancy)
**Decision:** Don't use window-vibrancy on the sidebar window.
**Rationale:** DWM material APIs render solid color on non-activating windows.
**Trade-off:** Sharp (not blurred) transparency. Acceptable — looks clean.
**See:** AGENTS.md → "Sidebar — Do NOT use window-vibrancy"

---

## Technology Stack Summary

### Desktop App
| Component | Technology | Version |
|-----------|-----------|---------|
| Framework | Tauri | 2 |
| Backend | Rust | 2021 edition, 1.77+ |
| Frontend | React + TypeScript | Vite 5.4 |
| Audio Playback | rodio | 0.19 |
| Wake Word | openWakeWord + tract-onnx | 0.23 |
| TTS | Piper (piper-rs) | 0.2 |
| STT | faster-whisper (Python sidecar) | tiny.en |
| NLU | BERT-Mini ONNX (Python sidecar) | lazy |
| Window Management | Tauri dynamic windows | custom |

### Cloud
| Component | Technology |
|-----------|-----------|
| Worker | Cloudflare Workers |
| LLM Cascade | Gemini Flash → Groq Qwen → CF llama-3.2 |
| Research | Wikipedia REST + Wikidata |
| Storage | D1 (usage, cache) + KV (edge cache) |
| Auth | GitHub OAuth + Google OAuth |

### CI/CD
| Component | Technology |
|-----------|-----------|
| CI | GitHub Actions |
| Windows Installer | NSIS + MSI (Tauri bundler) |
| macOS Installer | .app (unsigned, Tauri bundler) |
| Linux | AppImage (planned, blocked by build script issue) |

---

## Document Index

| # | Document | Topic |
|---|----------|-------|
| 36 | `36-tts-engine-evolution.md` | Kokoro → Piper TTS migration |
| 37 | `37-stt-engine-evolution.md` | Moonshine → faster-whisper STT journey |
| 38 | `38-loading-indicator-evolution.md` | Separate window → in-orb loading |
| 39 | `39-voice-ack-pipeline-evolution.md` | Validate-first + cached TTS acknowledgement |
| 40 | `40-self-learning-stt.md` | Self-learning STT correction system |
| 41 | `41-ci-cd-evolution.md` | Cross-platform installer CI pipeline |
| 42 | `42-ram-optimization-journey.md` | 1,644 MB → 104 MB RAM reduction |
| 43 | `43-architectural-timeline.md` | This document (master overview) |

---

## Future Roadmap

### Short Term (Next Sprint)
1. **Fix Linux CI** — investigate build script failure
2. **Signed macOS .dmg** — when Apple Developer certificate is obtained
3. **Installer smoke test** — actually install and launch in CI
4. **GitHub Releases** — auto-create releases on tag push

### Medium Term (Next Quarter)
1. **whisper.cpp** — eliminate Python STT sidecar
2. **Streaming TTS** — chunked synthesis for long responses
3. **Correction cloud sync** — sync learned corrections across devices
4. **Correction UI** — settings panel for viewing/managing corrections
5. **Voice cloning** — custom Piper model from user's voice

### Long Term (Next Year)
1. **Pure-ONNX Piper** — eliminate C++ piper-rs dependency
2. **Sidebar as DOM overlay** — eliminate sidebar WebView2 window
3. **On-device fine-tuning** — fine-tune STT on user's vocabulary
4. **Multi-user cloud sync** — settings, corrections, contacts
5. **Plugin system** — third-party voice commands

---

## Lessons Learned (Meta)

1. **Accuracy > elegance.** Moonshine was architecturally cleaner but
   produced garbage. faster-whisper with Python is ugly but works.

2. **Measure before optimizing.** We measured 1,644 MB before deciding
   what to optimize. Without measurement, we would have guessed wrong.

3. **Lazy loading is the biggest RAM win.** Going from eager to lazy
   loading saved 1,440 MB — more than every other optimization combined.

4. **Fewer windows = fewer problems.** Every Tauri window is a full
   WebView2 process tree (~174 MB). Minimize window count ruthlessly.

5. **Test on all platforms early.** The loading window worked on Windows
   but broke on Wayland. The codesigning worked locally but failed in CI.
   Early cross-platform testing catches these issues.

6. **CI is not a substitute for physical testing.** CI proves compilation
   and unit tests. It does not prove microphone, speaker, or visual
   rendering work. Be honest about what CI proves.

7. **Learn from the user.** Self-learning STT corrections are more
   sustainable than static corrections. Every user has different speech.

8. **Cache the hot path.** "On it sir" is said 50+ times per session.
   Caching it as raw PCM in RAM eliminated all synthesis overhead.

9. **Don't over-engineer.** Piper's MOS 4.0 vs Kokoro's 4.3 is
   indistinguishable. The 270 MB RAM savings far outweigh the quality
   difference.

10. **Document everything.** These docs exist because we documented
    decisions as we made them. Future contributors (including future
    you) will thank you for explaining WHY, not just WHAT.
