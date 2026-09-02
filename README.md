# ⚡ NEXUS — Autonomous Codebase Architecture Mapper & Voice Assistant


---

## 💡 The Core Problem: *"If I change this, what breaks?"*

NEXUS transforms codebase exploration from a static directory view into an active **consequence engine**. It combines a **native desktop client** (Tauri v2 + Rust + React/TS) with a **serverless edge backend** (Cloudflare Workers + D1) and **local in-process AI** (Moonshine STT + Kokoro TTS) to give developers instant architectural visibility and change impact analysis.

* 📖 **Quick Start Guide:** [QUICKSTART.md](QUICKSTART.md) *(How to test in 60s)*

---

## 🌟 Key Capabilities

### 🗺️ 1. Autonomous Architecture Mapper
* **Instant Layering:** Analyzes any GitHub repo and clusters files into architectural layers (Frontend, Backend, DB, Infrastructure) in under 5 seconds.
* **Deep Dependency Graph:** Clones the repo, parses AST imports in parallel via Rayon, and builds a directed `petgraph` mapping cross-component connections.
* **Change Impact Analysis (Blast Radius):** Runs sub-10ms Reverse-BFS to show you exactly which files break if you modify a target file, reconstructing the shortest dependency paths.
* **Risk & Criticality Scoring:** Automatically detects circular dependencies (via Tarjan's SCC) and architectural hotspots (`in_degree` centrality).

### 🎙️ 2. Advanced On-Device Voice Pipeline
* **Local Wake Word:** `openWakeWord` (ONNX in Rust via `tract-onnx`) detects *"NEXUS"* locally with <0.5% CPU overhead.
* **In-Process Neural STT (Moonshine):** High-speed local speech recognition running directly in the Rust process space.
* **In-Process Neural TTS (Kokoro 82M):** Natural speech synthesis (<150ms TTFB) running in Rust and played through hardware via `rodio`.

### 🚀 3. Developer-First Integrations & General AI
* **Voice-Triggered PR Reviews:** *"Analyze PR 254 in Engine-NEXUS/NEXUS-Agent."* (or any other PR in a repo) Fetches diffs and returns a Senior-Engineer grade review.
* **App Automation:** *"Open [App Name]"* instantly executes native OS commands to open software.
* **General AI Assistant:** You can ask NEXUS literally any question, and it will respond intelligently via voice.
* **Intelligent Edge Matching:** Fuzzy Levenshtein matching on the edge catches STT mishearings.

---

## 🏗️ Architecture

```
[NEXUS Desktop (Rust + Tauri v2)] ──(HTTP POST)──► [Cloudflare Worker (Edge)]
                                                         │
                                                         ├──► D1 SQLite (OAuth & Registrations)
                                                         └──► Workers AI (Intent & Reasoning)
```

* **Live Edge Backend:** [`https://nexus-worker.chitkullakshya.workers.dev`](https://nexus-worker.chitkullakshya.workers.dev)
* **Health Check:** [`https://nexus-worker.chitkullakshya.workers.dev/health`](https://nexus-worker.chitkullakshya.workers.dev/health) (`{"ok":true,"serverless":true}`)

---

## 🚀 Quick Start (Dev)

### Prerequisites
* Node.js 20+ and npm
* Rust 1.77+ toolchain

```bash
# 1. Frontend
npm --prefix frontend install
npm --prefix frontend run dev

# 2. Rust + Tauri
cd src-tauri
cargo build --release --features custom-protocol
```

---

## 📦 Production Build

```powershell
pwsh ./scripts/build.ps1 -Bundles "nsis"
```
Signed Windows NSIS installer is output to: `src-tauri/target/release/bundle/nsis/*.exe`

---

## 📥 Releases & Installation

### Windows (NSIS Installer)

**[⬇ Download NEXUS_0.1.0_x64-setup.exe (60 MB)](https://github.com/Engine-NEXUS/NEXUS-Agent/releases/download/v0.1.0/NEXUS_0.1.0_x64-setup.exe)**

Or visit the [Releases](https://github.com/Engine-NEXUS/NEXUS-Agent/releases/tag/v0.1.0) page.

The installer:
- Installs `NEXUS.exe` to `%LOCALAPPDATA%\NEXUS\`
- Bundles Python STT/NLU servers in `resources/server/`
- Bundles Kokoro TTS model and espeak-ng data
- Registers the `nexus://` deep-link protocol for OAuth callbacks
- Creates a Windows Scheduled Task for auto-start at login
- Registers uninstaller in Add/Remove Programs

### macOS (DMG)

```bash
nexus build --bundles dmg
# Output: src-tauri/target/release/bundle/dmg/NEXUS_0.1.0_x64.dmg
```

### Linux (AppImage / Deb)

```bash
nexus build --bundles appimage,deb
# Output: src-tauri/target/release/bundle/appimage/NEXUS_0.1.0_amd64.AppImage
```

### First Launch

1. **Setup Wizard** — Auto-opens on first launch.
2. **Microphone Permission** — Grant mic access for wake word + STT.
3. **Voice Selection** — Pick from 4 voices (af_sky, af_bella, am_adam, bf_emma).
4. **Connect GitHub** — OAuth via browser. Token stored securely in Cloudflare D1.
5. **Hotkey** — `Ctrl+Space` to wake NEXUS and start speaking.

### What Gets Stored

| Data | Location | Purpose |
|------|----------|---------|
| `nexus-config.json` | `%APPDATA%/com.nexus.assistant/` | User ID, device ID, Worker URL |
| `settings.json` | `%APPDATA%/com.nexus.assistant/` | Voice, hotkey, autostart preferences |
| GitHub OAuth token | Cloudflare D1 (encrypted) | PR analysis, repo access |
| STT hotwords | `%APPDATA%/com.nexus.assistant/stt_hotwords.txt` | Custom vocabulary for transcription |

---

## 📄 License
© 2026 **Team V-Max (Team #5)**.
