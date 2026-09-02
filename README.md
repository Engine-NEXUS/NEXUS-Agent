# ⚡ NEXUS — Your Autonomous AI Operating System Companion

NEXUS is an omnipresent, voice-first AI software engineer that lives natively on your machine. It isn't just a chatbot or a terminal tool—it is a deeply integrated, always-listening Jarvis for your workflow. 

NEXUS combines a **native desktop client** (Tauri v2 + Rust) with an invisible, liquid-glass floating UI, **hyper-optimized local AI** (in-process STT/TTS), and a **serverless edge backend** (Cloudflare Workers) to act as a seamless extension of your brain.

* 📖 **Quick Start Guide:** [QUICKSTART.md](QUICKSTART.md) *(How to test in 60s)*

---

## 🌟 The Vision: A True "Jarvis" for Developers

Modern developers juggle dozens of tools. NEXUS aims to unify them through a single voice-driven intelligence. Whether you are mapping out a legacy codebase, reviewing a pull request, querying your database, or just asking it to "Open VS Code", NEXUS executes it instantly without breaking your flow.

### 🎙️ 1. Omnipresent Voice-First Interaction
* **Zero-Click Wake Word:** `openWakeWord` (ONNX in Rust) detects *"NEXUS"* locally with <0.5% CPU overhead. Just speak to your computer.
* **Global Hotkeys:** Press `Ctrl+Shift+Space` anywhere in the OS to instantly summon the floating orb.
* **Liquid Glass UI:** Built with custom DWM backdrop effects (Windows/macOS), the UI floats above your work, click-through and completely unobtrusive.

### 🧠 2. Hyper-Optimized Local AI Pipeline
* **In-Process Neural STT (Moonshine):** Lightning-fast local speech recognition running directly in the Rust process space. No cloud latency for understanding your voice.
* **In-Process Neural TTS (Kokoro 82M):** Natural, high-fidelity speech synthesis (<150ms TTFB) generated entirely on-device and played through hardware via `rodio`.
* **Privacy First:** Your voice never leaves your machine unless converted to a text intent. Meeting Privacy Mode ensures the mic shuts down during Zoom/Teams calls.

### 💻 3. Deep System & OS Automation
* **App Automation:** Native Rust integraton to discover and launch apps via the Windows Registry or Linux Desktop files. *"Open Firefox."*
* **Media & OS Controls:** Tie directly into Windows Media and Linux MPRIS to pause music or adjust volume when you speak.
* **Offline Execution:** Core Tier 3 commands run perfectly even without an internet connection.

### 🗺️ 4. Autonomous Codebase Architecture Mapper
* **Instant Layering:** Analyzes any GitHub repo and clusters files into architectural layers in under 5 seconds.
* **Change Impact Analysis (Blast Radius):** Runs sub-10ms Reverse-BFS on AST dependency graphs to show you exactly which files break if you modify a target file.
* **PR Code Reviews:** *"Analyze PR 254 in our repo."* NEXUS fetches diffs and returns a Senior-Engineer grade review.

### ⚡ 5. Serverless Edge Brain (Mistral 24B)
* **Cloudflare Workers AI:** The reasoning engine lives on the edge. Lightning fast, auto-scaling, and utilizing D1 caching for instant fuzzy repo matching and intent classification.

---

## 🏗️ Architecture Stack

```
[NEXUS Desktop (Rust + Tauri v2)] ──(HTTP POST)──► [Cloudflare Worker (Edge)]
          │                                              │
          ├──► Local Wake Word (Tract-ONNX)              ├──► D1 SQLite (OAuth & Quotas)
          ├──► Local STT (faster-whisper)                └──► Workers AI (Mistral 24B Intent/Reasoning)
          └──► Local TTS (Kokoro 82M)
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

## 📥 Releases & Installation

### Windows (NSIS Installer)

**[⬇ Download NEXUS_0.1.0_x64-setup.exe (60 MB)](https://github.com/Engine-NEXUS/NEXUS-Agent/releases/download/v0.1.0/NEXUS_0.1.0_x64-setup.exe)**

The installer runs without Admin/UAC, bundles all Python sidecars and local ONNX models, and registers a Windows Scheduled Task for auto-start at login.

### macOS & Linux Build Targets
```bash
nexus build --bundles dmg          # macOS
nexus build --bundles appimage,deb # Linux
```

### First Launch
1. **Setup Wizard** — Auto-opens on first launch.
2. **Microphone Permission** — Grant mic access for wake word + STT.
3. **Voice Selection** — Pick from 4 Kokoro voices (af_sky, af_bella, am_adam, bf_emma).
4. **Connect GitHub** — OAuth via browser. Token stored securely in Cloudflare D1.

---

## 📄 License
© 2026 Engine-NEXUS Team.
