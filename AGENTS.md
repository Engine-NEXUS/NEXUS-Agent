# NEXUS — Project Notes

## Building

**Always build the desktop app with the Tauri CLI:**

```powershell
pwsh ./scripts/build.ps1          # frontend + tauri release build + bundles
```

If you need a plain cargo build (faster iteration, no installer), you **must**
pass the `custom-protocol` feature:

```powershell
npm --prefix frontend run build
cargo build --release --features custom-protocol   # run inside src-tauri/
```

### Why `custom-protocol` is mandatory

Tauri decides whether to load the bundled frontend or the Vite dev server
purely from this feature flag:

```rust
// tauri-macros/src/context.rs
dev: cfg!(not(feature = "custom-protocol")),
```

- Feature **on**  → windows load `http://tauri.localhost/...` (embedded assets)
- Feature **off** → windows load `devUrl` = `http://localhost:5173`

`cargo tauri build` adds the feature automatically; a bare `cargo build
--release` does **not**. A release binary built without it shows
`localhost refused to connect` / `ERR_CONNECTION_REFUSED` in every window,
because no Vite server is running. Clearing the WebView2 profile does not
help — the dev URL is baked into the binary at compile time.

The feature is deliberately **not** in `[features] default`, because
`tauri dev` needs it off for hot reload.

### Verifying which URL the app actually loads

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process .\src-tauri\target\release\nexus.exe
Start-Sleep 15
Invoke-RestMethod http://127.0.0.1:9222/json/list | Select-Object title, url
```

Expected: every window on `http://tauri.localhost/...`.
Bad: `http://localhost:5173/...` → rebuild with `--features custom-protocol`.

## Frontend windows

Every window declared in `src-tauri/tauri.conf.json` must have a matching
rollup input in `frontend/vite.config.ts`, otherwise its HTML file is absent
from `dist/` and the window fails to load in release builds (dev mode hides
this — the Vite server serves any HTML file on demand).

| tauri.conf.json window | HTML            | vite input |
| ---------------------- | --------------- | ---------- |
| `main`                 | `index.html`    | `main`     |
| `setup`                | `setup.html`    | `setup`    |
| `settings`             | `settings.html` | `settings` |
| `sidebar`              | `sidebar.html`  | `sidebar`  |

## Local ports

| Service           | Port    | Notes                                        |
| ----------------- | ------- | -------------------------------------------- |
| STT (faster-whisper) | `18765` | Deliberately uncommon to avoid clashing with dev servers on 8000. Override: `NEXUS_STT_PORT` |
| Vite dev server   | `5173`  | Dev only                                     |

## Architecture (serverless — 2026-08-27)

NEXUS is now **fully serverless**. No sidecar, no n8n, no Ollama, no server.

```
NEXUS laptop → HTTP POST → Cloudflare Worker → APIs → text response
                              ↑
                        D1 database (OAuth tokens)
                        Workers AI (intent + summarization)
```

- **Worker** (`server/worker/`): Cloudflare Worker on the edge. Handles
  intent classification, API calls (GitHub/Google), summarization, OAuth
  exchange, token storage, and user registration. <5ms cold start.
- **D1**: Cloudflare's free SQLite. Stores OAuth tokens, API keys, and
  device registrations. 5GB free.
- **Workers AI**: Free tier (10K neurons/day) for intent classification
  (Qwen 0.5B) and summarization (Qwen 14B).
- **Client** (`src-tauri/src/network.rs`): HTTP POST to the Worker. No
  WebSocket. Emits state/ack/result/done events to the frontend.
- **NEXUS_SERVER_URL**: Baked into the installer at build time. Points to
  the Worker URL (e.g. `https://nexus-worker.xxx.workers.dev`).

The old sidecar (`server/sidecar/`) is kept in the repo for reference but
no longer spawned at startup. `sidecar_manager.rs` has been removed.

### Building the installer with the Worker URL

```powershell
$env:NEXUS_SERVER_URL = "https://nexus-worker.your-subdomain.workers.dev"
pwsh ./scripts/build.ps1
```

## Runtime paths (Windows)

- App data (config, logs): `%APPDATA%\com.nexus.assistant\`
- WebView2 profile: `%LOCALAPPDATA%\com.nexus.assistant\EBWebView`
  (note: **Local**, not Roaming — `app_data_dir()` returns Roaming and is the
  wrong path for WebView2)

## Wake word (openWakeWord)

- Default feature: `wakeword-oww` (tract-onnx inference in Rust)
- Models: `src-tauri/resources/oww/{melspectrogram.onnx, embedding_model.onnx, nexus.onnx}`
- Threshold: 0.45, chunk size: 1280 samples (80ms at 16kHz)
- **Silence gate + AGC (2026-08-28):** `detect_chunk` computes RMS of each
  80ms chunk and skips the classifier entirely if RMS < 0.0005 (~-66dBFS).
  The `nexus.onnx` model emits 0.6-0.9 probabilities on pure digital silence
  (out-of-distribution input), which caused spontaneous false wakes. The
  gate prevents the model from ever seeing silence. Min positive detections
  = 2. Regression test: `test_silence_never_triggers_wake`.
  - **AGC (Automatic Gain Control):** If RMS passes the gate but is below
    TARGET_RMS (0.03), the chunk is amplified up to 50x before feeding the
    classifier. This makes quiet/whispered "NEXUS" produce the same model
    input as loud "NEXUS", so the model (trained on normal-volume TTS)
    recognizes low-volume speech without retraining.
  - Gate: 0.0005, threshold: 0.45. Pure silence (RMS=0) is blocked.
  - Model: trained on Kaggle (v22), accuracy 78.6%, recall 58.2%, FP/hr 1.33.
- **Mic device enumeration (2026-08-27):** `start_audio_capture` enumerates
  ALL input devices, probes each for 5 seconds, and picks the first one
  that produces non-silent audio (RMS > 0.0001). If all devices are silent
  (Intel SST bug), falls back to the best device anyway. This fixes the
  "wake word doesn't work, only hotkey" issue caused by cpal getting
  silence from the Intel Smart Sound Technology driver.
- **FIXED (2026-08-24):** The wake word now works — probability 0.991 for real
  "NEXUS" speech. The root cause was a 32768x input scaling mismatch: cpal
  produces f32 audio in [-1.0, 1.0] but the openWakeWord melspectrogram model
  expects int16-scale float32 values in [-32768, 32767]. Fix: multiply audio
  by 32768.0 in `wakeword_oww.rs` before feeding to the melspectrogram model.
- **Mic conflict (FIXED):** The frontend's `warmMic()` (getUserMedia via WebView2)
  conflicts with the Rust cpal wake-word stream on Intel Smart Sound Technology
  drivers. `warmMic()` is disabled at startup; the mic is acquired on first
  wake instead. This is why cpal was getting silence (RMS=0.0000).
- The global hotkey still works independently of the wake-word model.
- **Command models (2026-08-25):** Training 4 category-level acoustic models
  (`command_open`, `command_close`, `command_search`, `command_play`) via
  `train_nexus_commands.ipynb` on Google Colab. Models detect command TYPE,
  then STT extracts the parameter (which app, what query). See
  `src-tauri/resources/oww/commands/command_intents.json`.

## Known limitations (2026-08-26 audit)

- **Speaker verification is NOT wired.** Enrollment works (setup wizard ->
  embedding -> JSON on disk), but `wakeword_oww::WakeEngine::process`
  accepts every wake regardless of speaker. The verification API in
  `voice_profile.rs` is `#[allow(dead_code)]` until an audio ring buffer
  is added to retain the wake utterance for embedding extraction.
- **All windows skip the taskbar.** `main`, `setup`, `settings`, and
  `sidebar` all have `skipTaskbar: true` in `tauri.conf.json`. NEXUS is
  accessible only via the floating orb, the system tray, the global
  hotkey, and the wake word.
- **STT server auto-launcher writes `server/start_stt.cmd`** with an
  absolute path to the local Python interpreter. This file is gitignored
  (machine-specific, leaks username).
