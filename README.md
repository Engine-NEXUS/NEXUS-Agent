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

## Running Locally (Development)

To run the app locally with hot-reloading (frontend served by Vite):

1. **Start the frontend dev server:**
   ```powershell
   npm --prefix frontend install
   npm --prefix frontend run dev
   ```

2. **Run the Rust backend (Tauri):**
   In a new terminal, set the `NEXUS_SERVER_URL` environment variable to your Cloudflare Worker URL, then run Tauri:
   ```powershell
   cd src-tauri
   $env:NEXUS_SERVER_URL = "https://nexus-worker.your-subdomain.workers.dev"
   cargo run
   ```

## Local Release Build (No Installer)

For a plain local build (faster iteration, no installer), you **must** pass the `custom-protocol` feature so Tauri embeds the frontend assets rather than looking for a dev server:

```powershell
npm --prefix frontend install
npm --prefix frontend run build

cd src-tauri
$env:NEXUS_SERVER_URL = "https://nexus-worker.your-subdomain.workers.dev"
cargo build --release --features custom-protocol
# Run the built binary: .\target\release\nexus.exe
```

## Production Build (Installer)

Always build the desktop app installer with the Tauri CLI via the build script:

```powershell
$env:NEXUS_SERVER_URL = "https://nexus-worker.your-subdomain.workers.dev"
pwsh ./scripts/build.ps1 -Release
```
Set signing env vars (see `scripts/build.ps1` and `.github/workflows/release.yml`).

## Configuration Points
- **Worker URL:** Baked into the binary at compile time via the `NEXUS_SERVER_URL` environment variable.
- **Wake Word (openWakeWord):** The wake word engine uses openWakeWord (`wakeword-oww` feature by default) and its assets are bundled in `src-tauri/resources/oww/`.
- **Serverless Backend:** NEXUS is fully serverless. The backend logic runs on Cloudflare Workers (intent classification, summarization via Workers AI, and D1 for storage). No local sidecar or n8n is needed.

## Platforms
| OS | Notes |
|---|---|
| Windows 10/11 | NSIS installer; WebView2 bootstrapper. |
| macOS (AS + Intel) | Universal `.dmg`, notarized; `LSUIElement=true` hides dock. |
| Linux (X11/Wayland) | AppImage + `.deb`; compositor required for true transparency. |

## License
Proprietary — © 2026 NEXUS.
