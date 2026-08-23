# NEXUS — Changelog

> All commits in reverse chronological order, organized by feature area.
> Each entry links to a detailed writeup of what changed and why.

---

## Voice Pipeline Performance + Native App Resolution (2026-08-23)

| Commit | Date | Summary | Details |
|--------|------|---------|---------|
| `92040f8` | 2026-08-23 | feat: hot mic + pre-init VAD + parallel init (A+B+C) — eliminates 2s wake-to-listen delay | [28-hot-mic-preinit-vad.md](./28-hot-mic-preinit-vad.md) |
| `02d162c` | 2026-08-23 | feat: native app priority + resolution cache + daily scan — opens PWAs/Store apps instead of browser tabs | [27-native-app-priority-resolution-cache.md](./27-native-app-priority-resolution-cache.md) |
| `80aabed` | 2026-08-23 | perf: switch STT to tiny.en + greedy decoding — 54x faster, 22% less RAM | [26-stt-performance-optimization.md](./26-stt-performance-optimization.md) |
| `58af31e` | 2026-08-23 | fix: auto-start STT server — root cause of all command failures | [25-stt-server-auto-start.md](./25-stt-server-auto-start.md) |
| `e0d0c80` | 2026-08-23 | fix: local commands hijacked by sidecar — local-first intent routing | [24-local-first-intent-routing.md](./24-local-first-intent-routing.md) |
| `d1e9d20` | 2026-08-23 | fix: meeting detection self-trigger — NEXUS detects own WebView2 as meeting | [23-meeting-detection-self-trigger-fix.md](./23-meeting-detection-self-trigger-fix.md) |

## UI Overhaul + Installer + Response Sidebar (PR #16)

| Commit | Date | Summary | Details |
|--------|------|---------|---------|
| `03a34ad` | 2026-08-22 | feat: right-side response sidebar — shows only for server responses | [21-response-sidebar.md](./21-response-sidebar.md), [22-installer-desktop-shortcut-removal.md](./22-installer-desktop-shortcut-removal.md) |
| `6663e57` | 2026-08-20 | feat: white-themed NSIS installer + setup wizard (orb untouched) | [19-nsis-installer.md](./19-nsis-installer.md), [20-setup-wizard-redesign.md](./20-setup-wizard-redesign.md) |
| `4e1086c` | 2026-08-20 | revert: restore original orb window — keep settings window + setup wizard | [18-orb-revert.md](./18-orb-revert.md) |
| `5ee9275` | 2026-08-20 | feat: white theme UI overhaul — orb card, settings window, setup wizard | [17-white-theme-ui-overhaul.md](./17-white-theme-ui-overhaul.md) |

## Boot Reliability + Greeting (PR #15)

| Commit | Date | Summary | Details |
|--------|------|---------|---------|
| `4d3c032` | 2026-08-19 | fix: suppress all terminal windows on Windows (CREATE_NO_WINDOW) | — |
| `89ed188` | 2026-08-19 | fix: autostart via Windows Scheduled Task — zero-delay launch on restart | — |
| `96e4962` | 2026-08-19 | feat: first-of-day greeting — "Welcome sir" on first wake, persisted across restarts | [03-boot-greeting.md](./03-boot-greeting.md) |
| `431ec11` | 2026-08-19 | fix: wake engine blocks tokio runtime for 5 min on cold boot (3 root causes) | — |

## Recent Changes (Boot Reliability + Greeting)

| Commit | Date | Summary | Details |
|--------|------|---------|---------|
| `f4e6ac6` | 2026-08-19 | feat: boot/wake greeting + non-blocking sidecar + no browser on boot | [01-browser-suppression.md](./01-browser-suppression.md), [02-non-blocking-sidecar.md](./02-non-blocking-sidecar.md), [03-boot-greeting.md](./03-boot-greeting.md), [04-sleep-wake-detection.md](./04-sleep-wake-detection.md) |
| `3cfa5ef` | 2026-08-19 | fix: mic prompt every restart + terminal window on every boot | [05-mic-permission-handler.md](./05-mic-permission-handler.md), [07-silent-sidecar.md](./07-silent-sidecar.md) |
| `41474b9` | 2026-08-19 | fix: eliminate "connection not found" on restart — 3 root causes fixed | [08-connection-restart-fix.md](./08-connection-restart-fix.md) |
| `fc46cc7` | 2026-08-19 | fix: frontend not embedded in .exe (root cause of ERR_CONNECTION_REFUSED) | [09-frontend-embedding.md](./09-frontend-embedding.md) |
| `4c987d5` | 2026-08-19 | fix: silent sidecar (no terminal) + port 49152 (dev-friendly) | [06-sidecar-port-change.md](./06-sidecar-port-change.md), [07-silent-sidecar.md](./07-silent-sidecar.md) |
| `61c9c53` | 2026-08-19 | fix: auto-spawn sidecar + build production app (no more localhost:5173 error) | [10-auto-spawn-sidecar.md](./10-auto-spawn-sidecar.md) |

## Command System

| Commit | Date | Summary | Details |
|--------|------|---------|---------|
| `b0d0cd5` | 2026-08-19 | fix: copy melspectrogram.onnx to OWW resources dir + add command_intents.json | [13-colab-training.md](./13-colab-training.md) |
| `b81261e` | 2026-08-19 | feat: expanded command system — 30 fixed + 9 parameterized commands | [12-expanded-commands.md](./12-expanded-commands.md) |
| `f3ff4bd` | 2026-08-19 | feat: Tier 3 direct command classification (skip ASR for known commands) | [11-tier3-commands.md](./11-tier3-commands.md) |
| `76c82d4` | 2026-08-19 | feat: Silero VAD + pre-indexed app registry for instant launch | [11-tier3-commands.md](./11-tier3-commands.md) |

## Meeting / Privacy Mode

| Commit | Date | Summary | Details |
|--------|------|---------|---------|
| `b793ebe` | 2026-08-19 | feat: meeting/privacy mode — auto-detect mic usage, suppress wake & TTS | [14-meeting-privacy-mode.md](./14-meeting-privacy-mode.md) |

## Wake Word Engine

| Commit | Date | Summary | Details |
|--------|------|---------|---------|
| `395369b` | 2026-08-19 | feat: replace VAD+ASR with openWakeWord KWS for wake word detection | [15-oww-kws.md](./15-oww-kws.md) |
| `89d9296` | 2026-08-19 | feat: wake-word variants + sound-alikes for pronunciation tolerance | [15-oww-kns.md](./15-oww-kns.md) |
| `656ec72` | 2026-08-19 | feat: voice wake word "NEXUS" via VAD + ASR + speaker verification | [15-oww-kns.md](./15-oww-kns.md) |

## Colab Training

| Commit | Date | Summary | Details |
|--------|------|---------|---------|
| `8fb1832` | 2026-08-19 | fix: Colab compliance — disk cleanup, Drive checkpointing, idle timeout prevention | [13-colab-training.md](./13-colab-training.md) |
| `7ab3859` | 2026-08-19 | fix: Colab notebook ACAV/FMA download failures with retries and fallback | [13-colab-training.md](./13-colab-training.md) |

## TTS

| Commit | Date | Summary | Details |
|--------|------|---------|---------|
| `fb4c88c` | 2026-08-19 | fix: remove comma pause in "Didn't catch that sir" TTS | [16-tts-fixes.md](./16-tss-fixes.md) |

## Earlier Merges

| Commit | Date | Summary |
|--------|------|---------|
| `a668346` | 2026-08-19 | Merge PR #14: fix/tauri-config-and-stt-server |
| `0a5b82b` | 2026-08-19 | fix: tauri config plugin sections + STT server BytesIO wrapper |
| `860280a` | 2026-08-19 | Merge PR #13: feat/e2e-integration-cleanup |

---

## Feature Area Summary

### Voice Pipeline Performance (3 commits)
Eliminated the 2-second wake-to-listen delay with hot mic + pre-init VAD + parallel init. STT latency reduced from 15s to 276ms with tiny.en + greedy decoding. STT server now auto-starts with NEXUS.

### Native App Resolution (1 commit)
NEXUS now opens installed native apps, Store apps, and browser PWAs instead of browser tabs. Added resolution cache for instant repeat commands, daily scan for app changes, and cross-platform PWA discovery.

### Local-First Intent Routing (1 commit)
Local commands (open, search, play) now execute locally before contacting the remote backend. Eliminates dependency on n8n for basic commands.

### Meeting Detection Fix (1 commit)
Fixed NEXUS detecting its own WebView2 process as a meeting, causing wake/TTS suppression deadlock.

### Boot Reliability (6 commits)
Fixed the entire cold-boot experience: no browser reopening, no terminal window, no mic prompt, fast startup, greeting on boot.

### Command System (4 commits)
Added 39 acoustic command classifiers (30 fixed + 9 parameterized) that skip STT for ~200ms latency. Fixed Colab training notebook.

### Meeting / Privacy Mode (1 commit)
Auto-detect mic usage by other apps, suppress wake + TTS during calls.

### Wake Word Engine (3 commits)
Migrated from VAD+ASR (~30% recall) to openWakeWord KWS (~100% recall). Added pronunciation tolerance.

### Colab Training (2 commits)
Fixed download failures and Colab compliance (disk cleanup, Drive checkpointing).

### TTS (1 commit)
Fixed comma-induced pause in error messages.
