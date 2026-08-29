# NEXUS — Changelog

> All commits in reverse chronological order, organized by feature area.
> Each entry links to a detailed writeup of what changed and why.

---

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
