# NEXUS Assistant — Feature Implementation Index

This folder contains detailed documentation for every feature implemented,
bug fixed, and architecture decision made across the `prem224k` and `prem22k`
branches, forming the basis of PR #7 (merge of both branches into `main`).

**Date:** 2026-08-29
**Branches merged:** `prem224k` + `prem22k` → `main`
**PR:** #7

---

## Feature Index

### Voice & PR Analysis (prem224k — this session)

| # | Feature | File | Description |
|---|---|---|---|
| 01 | GitHub PR Analysis via Voice | [01-github-pr-analysis.md](01-github-pr-analysis.md) | Say "analyse PR 5 in servx" → GLM-4.7-Flash code review in sidebar |
| 02 | STT Mishearing Fixes | [02-stt-mishearing-fixes.md](02-stt-mishearing-fixes.md) | Post-processing corrections + dynamic hotwords for tiny.en |
| 03 | Sidebar Streaming Text Animation | [03-sidebar-streaming-animation.md](03-sidebar-streaming-animation.md) | ChatGPT/Gemini-style word fade-in, left-to-right, top-to-bottom |
| 04 | On-It-Sir Flow | [04-on-it-sir-flow.md](04-on-it-sir-flow.md) | Immediate ack for long queries → orb hides → "Here is the analysis" |
| 05 | Worker Fuzzy Repo Matching | [05-worker-fuzzy-repo-matching.md](05-worker-fuzzy-repo-matching.md) | Levenshtein distance matching for misheard repo names |

### Wake-Word & Hotkey (prem224k)

| # | Feature | File | Description |
|---|---|---|---|
| 06 | Wake-Word Reliability | [06-wake-word-reliability.md](06-wake-word-reliability.md) | Single-frame high-confidence trigger (0.5+ bypass) |
| 07 | State-Dependent Hotkey | [07-state-dependent-hotkey.md](07-state-dependent-hotkey.md) | Sidebar-aware: close sidebar OR wake, not both |
| 08 | CSP for Silero VAD | [08-csp-silero-vad.md](08-csp-silero-vad.md) | CDN script-src + worker-src blob for VAD WASM |

### Voice Engines & Cross-Platform (prem22k)

| # | Feature | File | Description |
|---|---|---|---|
| 09 | Multi-Voice TTS Engine | [09-multi-voice-tts.md](09-multi-voice-tts.md) | Gemini Flash, Fish Audio Ethan, ElevenLabs Jarvis/Nova/Echo/Onyx |
| 10 | Non-Activating Overlay | [10-non-activating-overlay.md](10-non-activating-overlay.md) | Orb doesn't steal keyboard focus from IDEs/terminals |
| 11 | Linux D-Bus MPRIS | [11-linux-mpris.md](11-linux-mpris.md) | Native media control via zbus (PlayPause, Next, Previous) |
| 12 | VAD Post-TTS Mute Gate | [12-vad-post-tts-mute.md](12-vad-post-tts-mute.md) | 300ms mic mute after TTS to prevent echo self-triggering |

### CI/CD & Setup (prem22k)

| # | Feature | File | Description |
|---|---|---|---|
| 13 | GitHub Actions CI/CD | [13-github-actions-cicd.md](13-github-actions-cicd.md) | Auto-build Windows NSIS .exe installer on push |
| 14 | Setup Wizard Redesign | [14-setup-wizard-redesign.md](14-setup-wizard-redesign.md) | Voice persona selection, API keys, preferences |

### Architecture & Merge

| # | Feature | File | Description |
|---|---|---|---|
| 15 | Architecture Decisions | [15-architecture-decisions.md](15-architecture-decisions.md) | Serverless model, sidebar delivery, done event timing |
| 16 | Conflict Resolution | [16-conflict-resolution.md](16-conflict-resolution.md) | How 3 overlapping files were merged from both branches |

### AK Repo Port (2026-08-29 — this session)

| # | Feature | File | Description |
|---|---|---|---|
| 17 | Mic Baton Pass | [17-ak-port-mic-baton-pass.md](17-ak-port-mic-baton-pass.md) | Pause/resume cpal stream around getUserMedia to fix Intel SST mic lock |
| 18 | Cancel Hotkey + Double Wake Fix | [18-ak-port-cancel-hotkey-double-wake-fix.md](18-ak-port-cancel-hotkey-double-wake-fix.md) | Ctrl+Space cancel hotkey + fix triple event emission causing "on it sir" twice |
| 19 | Audio Volume + Multi-Turn VAD | [19-ak-port-audio-volume-multi-turn-vad.md](19-ak-port-audio-volume-multi-turn-vad.md) | RMS volume tracking for avatar reactivity + "didn't catch that" retry (max 3) |
| 20 | STT Fix + Wake Reliability | [20-stt-fix-wakeword-reliability.md](20-stt-fix-wakeword-reliability.md) | STT server missing __main__ block + wake word model assessment |

---

## Quick Summary

### prem224k (2 commits + this session's work)
- GitHub PR analysis via voice commands
- STT post-processing for misheard words
- Sidebar streaming text animation
- "On it sir" → "Here is the analysis" flow
- Fuzzy repo name matching (Levenshtein)
- Wake-word single-frame high-confidence trigger
- State-dependent hotkey
- CSP for Silero VAD CDN

### prem22k (20 commits)
- Multi-voice TTS engine (6 voices, 3 providers)
- Non-activating floating overlay window
- Linux D-Bus MPRIS media control
- Dual-phase VAD post-TTS mute gate
- GitHub Actions CI/CD pipeline
- Setup wizard redesign
- Pop!_OS/WebKitGTK fixes
- Multi-hotkey binding for Linux
- Single-instance daemon lock
- NSIS installer auto-launch setup

### Merge conflicts (3 files, all resolved)
- `hotkey.rs` — Combined multi-hotkey + state-dependent logic
- `wakeword_oww.rs` — Took prem224k's precise high-confidence approach
- `tauri.conf.json` — Combined visible:true + CSP changes

### AK repo port (4 features, all implemented and tested)
- Mic baton pass (pause/resume cpal stream for Intel SST compatibility)
- Cancel hotkey (Ctrl+Space) + double "on it sir" fix (triple event emission)
- Audio volume RMS tracking + multi-turn VAD resume + "didn't catch that" retry
- STT server missing `__main__` block fix + wake word reliability assessment
