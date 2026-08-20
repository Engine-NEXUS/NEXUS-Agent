# Change: Tier 3 Direct Command Classification

**Commit:** `f3ff4bd` ("feat: Tier 3 direct command classification (skip ASR for known commands)")
**Date:** 2026-08-19

---

## Problem

Every command went through: speech → VAD → local STT (faster-whisper, 5-27 seconds) → transcript → intent parse → execute. The 5-27 second STT delay made NEXUS feel broken for simple commands like "open youtube".

## Solution

Add **per-command acoustic classifiers** that run in parallel with the wake word classifier on the same 80 ms audio chunks. When a command classifier fires, NEXUS executes the action directly — no STT, no transcript, no 27-second delay.

## Architecture

```
Microphone → 16 kHz mono → 80 ms chunks
  │
  ├──▶ melspectrogram → embedding → nexus.onnx (wake word)
  │
  ├──▶ melspectrogram → embedding → open_youtube.onnx → score
  ├──▶ melspectrogram → embedding → open_gmail.onnx → score
  ├──▶ melspectrogram → embedding → mute_volume.onnx → score
  │   ... (one per command)
  │
  └──▶ if any command score > threshold:
          emit "command-detected" Tauri event with structured intent
          frontend executes directly (NO STT)
```

The classifiers **share** the melspectrogram and embedding models with the wake word — only the final classifier layer is per-command (~800 KB each).

## Two Command Types

### Type 1: Fixed (no parameter)
- Examples: `open_youtube`, `mute_volume`, `lock_screen`.
- Flow: classifier fires → frontend executes directly → "Ok sir."

### Type 2: Parameterized (need a spoken parameter)
- Examples: `play_spotify`, `search_youtube`, `set_timer`.
- Flow: classifier fires → frontend speaks "On it sir" → records 3s → STT → extract parameter → execute.

## Implementation

### Rust (`wakeword_oww.rs`)

- Added `CommandIntent` struct: `{ action, target, needs_param }`.
- Added `CommandClassifier` struct: model + intent + detection buffer.
- Loads all classifiers from `command_intents.json` + `resources/oww/commands/*.onnx`.
- Runs all classifiers in parallel with the wake word on every 80 ms chunk.
- Emits `command-detected` Tauri event when a classifier fires.

### Frontend (`main.tsx`)

- Added `setupCommandDetectionListener()` — listens for `command-detected` events.
- Fixed commands: speak "Ok sir." + `invoke("execute_command")`.
- Parameterized commands: speak "On it sir" → `captureParameter(3000)` → STT → `invoke("execute_command", { action, query: param })`.

### Rust (`command_executor.rs`)

- Added `Intent` enum with all command variants.
- Added `execute_command` IPC command.
- Implemented all command actions: open app, open URL, search, Spotify, YouTube, GitHub, volume, screenshot, lock, browser keys.

## Latency

| Path | Latency |
|------|---------|
| Tier 3 fixed command | ~200 ms |
| Tier 3 parameterized command | ~3-5 s (3s parameter capture + STT) |
| Full STT path (fallback) | 5-30 s (faster-whisper + Ollama) |

## Fallback

If no command classifier matches, the normal flow continues: wake → mic → VAD → STT → intent parser → backend. Tier 3 is a **fast path**, not a replacement for STT.

## Files Changed

- `src-tauri/src/wakeword_oww.rs` — added command classifier loading + inference + event emission.
- `src-tauri/src/command_executor.rs` — new file (command execution).
- `src-tauri/src/lib.rs` — registered `execute_command` in invoke handler.
- `frontend/src/main.tsx` — added `command-detected` event listener.
- `command_intents.json` — new file (command definitions).
