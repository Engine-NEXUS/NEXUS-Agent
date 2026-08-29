# Feature: Tier 3 Direct Command Classification

> Spoken commands like "open youtube" or "mute volume" are detected **acoustically** — no Whisper, no transcript, no 27-second delay. ~200 ms from speech to action.

**Source files:**
- `src-tauri/src/wakeword_oww.rs` — classifier loading + inference (parallel with wake word)
- `src-tauri/src/command_executor.rs` — local command execution
- `frontend/src/main.tsx` — `command-detected` event listener
- `command_intents.json` — 39 command definitions (phrase → model → intent)
- `train_nexus_commands.ipynb` — training notebook (Colab, checkpoints to Google Drive)

**Detailed docs:** [../wake-word/15-tier3-command-classifiers.md](../wake-word/15-tier3-command-classifiers.md) through [20-expanded-command-system.md](../wake-word/20-expanded-command-system.md)

---

## The Latency Problem

Without Tier 3, every command goes through:
```
speech → VAD → silence → local STT (faster-whisper, 5-27s) → transcript → intent parse → execute
```

The 5-27 second STT delay makes NEXUS feel broken for simple commands like "open youtube".

## The Tier 3 Solution

Tier 3 adds **per-command acoustic classifiers** that run in parallel with the wake word classifier on the same 80 ms audio chunks:

```
Microphone → 16 kHz mono → 80 ms chunks
  │
  ├──▶ melspectrogram → embedding → nexus.onnx (wake word)
  │
  ├──▶ melspectrogram → embedding → open_youtube.onnx → score
  ├──▶ melspectrogram → embedding → open_gmail.onnx → score
  ├──▶ melspectrogram → embedding → mute_volume.onnx → score
  ├──▶ melspectrogram → embedding → play_spotify.onnx → score
  │   ... (one per command, ~39 total)
  │
  └──▶ if any command score > threshold:
          emit "command-detected" event with structured intent
          frontend executes directly (NO STT)
```

The classifiers **share** the melspectrogram and embedding models with the wake word — only the final classifier layer is per-command (~800 KB each).

## Two Command Types

### Type 1: Fixed Commands (no parameter)

The acoustic pattern uniquely identifies the command. No parameter is needed.

Examples: `open_youtube`, `open_gmail`, `mute_volume`, `take_screenshot`, `lock_screen`, `browser_new_tab`.

Flow:
```
classifier fires → emit {action:"open_app", target:"youtube"}
  → frontend: speak "Ok sir." + invoke("execute_command")
  → Rust: app_registry::lookup("youtube") → open URL/app
  → done
```

### Type 2: Parameterized Commands (need a spoken parameter)

The acoustic pattern identifies the command **pattern**, but a parameter (song name, search query) is still needed.

Examples: `play_spotify`, `search_youtube`, `search_google`, `search_github`, `play_youtube`, `send_message`, `set_timer`, `set_alarm`, `create_event`.

Flow:
```
classifier fires → emit {action:"spotify_play", needs_param:true}
  → frontend: speak "On it sir"
  → frontend: record 3 seconds of audio
  → frontend: local STT → "bohemian rhapsody"
  → frontend: invoke("execute_command", {action:"spotify_play", query:"bohemian rhapsody"})
  → Rust: open spotify:search:bohemian%20rhapsody
  → frontend: speak "Playing bohemian rhapsody on Spotify, sir."
  → done
```

## The 39 Commands

Defined in `command_intents.json`:

**Fixed (30):** `open_youtube`, `open_gmail`, `open_chrome`, `open_notepad`, `open_calculator`, `open_spotify`, `open_discord`, `open_github`, `open_vscode`, `open_figma`, `open_slack`, `open_terminal`, `open_file_explorer`, `open_settings`, `open_brave`, `open_edge`, `open_firefox`, `open_outlook`, `open_word`, `open_excel`, `open_powerpoint`, `mute_volume`, `take_screenshot`, `lock_screen`, `browser_new_tab`, `browser_close_tab`, `browser_next_tab`, `browser_back`, `play_pause`, `stop_media`.

**Parameterized (9):** `play_spotify`, `search_youtube`, `search_google`, `search_github`, `play_youtube`, `send_message`, `set_timer`, `set_alarm`, `create_event`.

## Fallback to STT

If no command classifier matches (the user said something not in the 39 commands), the normal flow continues:
```
wake → mic → VAD → local STT → intent parser → backend
```

Tier 3 is a **fast path**, not a replacement for STT. It accelerates known commands; unknown requests still go through the full pipeline.

## Training

Each command classifier is trained via `train_nexus_commands.ipynb` in Google Colab:
- Synthetic data: Piper TTS generates thousands of utterances of the command phrase.
- Negative data: noise, other commands, random speech.
- Output: `.onnx` file (~800 KB per command).
- Checkpoints: saved to Google Drive so training can resume after Colab disconnects.

See [../wake-word/18-tier3-training-approach.md](../wake-word/18-tier3-training-approach.md) for the full training methodology.
