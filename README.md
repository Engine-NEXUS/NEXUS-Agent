# NEXUS — Floating Desktop AI Assistant (Thin Client)

A cross-platform, Siri-like floating overlay assistant. The **client** (Tauri v2 + Rust + React/TS) is a thin audio/visual IO bridge; all LLM/TTS/NLP runs on a remote **Fat Server** (n8n supervisor + Ollama).

> **Read the full spec: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**

## Highlights
- Transparent, frameless, always-on-top overlay with **region-aware click-through** (clicks over transparent pixels fall through to the OS app beneath).
- **Low-power wake word** via native Porcupine C-FFI in Rust (~0.5% CPU, offline). Global hotkey fallback (`Ctrl/Cmd+Shift+Space`).
- **VAD** (Silero ONNX / RMS fallback) ends the utterance and streams Opus/PCM to the server.
- **Streaming TTS** played back gaplessly over WebAudio.
- Idle RAM < 90 MB, near-zero idle CPU, webview can be torn down between interactions.
- Signed installers for Windows (NSIS `.exe`), macOS (notarized `.dmg`, universal), Linux (AppImage + `.deb`).

## Repo layout
See the file manifest in `docs/ARCHITECTURE.md §11`.

## Quick start (dev)
```bash
# Frontend
pnpm --dir frontend install
pnpm --dir frontend dev

# Rust + Tauri (use mock-wake to skip the Porcupine native lib in dev/CI)
cd src-tauri
cargo run --no-default-features --features mock-wake
```

## Production build
```bash
pwsh ./scripts/build.ps1 -Release
```
Set signing env vars (see `scripts/build.ps1` and `.github/workflows/release.yml`).

## Configuration points
- **Backend WSS URL / device token:** `frontend/src/App.tsx` (`SERVER_URL`, `DEVICE_TOKEN`) — replace `REPLACE_FROM_KEYCHAIN` with a keychain read in production.
- **Porcupine assets:** drop `libpv_porcupine.*`, `porcupine_params.pv`, `NEXUS.ppn` into `src-tauri/resources/porcupine/` (bundled via `tauri.conf.json` resources). AccessKey goes in the OS keychain under `NEXUS`/`porcupine-access-key`.
- **n8n server:** import `server/n8n/master_supervisor.blueprint.json` and point it at your Ollama (`http://localhost:11434`) and piper (`http://localhost:5000`) instances.

## Platforms
| OS | Notes |
|---|---|
| Windows 10/11 | NSIS installer; WebView2 bootstrapper. |
| macOS (AS + Intel) | Universal `.dmg`, notarized; `LSUIElement=true` hides dock. |
| Linux (X11/Wayland) | AppImage + `.deb`; compositor required for true transparency. |

## License
Proprietary — © 2026 NEXUS.
