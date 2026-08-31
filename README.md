# ⚡ NEXUS — Voice-First AI Desktop Assistant & Architecture Mapper

A cross-platform, Siri-like floating overlay assistant designed specifically for software engineers. NEXUS combines a **native desktop client** (Tauri v2 + Rust + React/TS) with a **serverless edge backend** (Cloudflare Workers + D1) for blazing-fast, privacy-respecting AI interactions.

NEXUS was built to answer the ultimate developer question: *"If I change this, what breaks?"* — and is submitted for the **Autonomous Codebase Architecture Mapper** Hackathon.

> 🏆 **Hackathon Jury:** Please read our **[Quick Start Guide (QUICKSTART.md)](QUICKSTART.md)** and the detailed submission document at **[docs/HACKATHON_SUBMISSION.md](docs/HACKATHON_SUBMISSION.md)**.

---

## 🌟 Key Features

### 🗺️ Autonomous Architecture Mapper *(Hackathon Highlight)*
* **Instant Layering:** Analyzes any GitHub repo and clusters files into architectural layers (Frontend, Backend, DB, etc.) in under 10 seconds.
* **Deep Dependency Graph:** Clones the repo, parses AST imports in parallel via Rayon, and builds a directed `petgraph` mapping out every file dependency.
* **Impact Analysis (Blast Radius):** Runs sub-10ms Reverse-BFS to show you exactly which files break if you modify a target file, reconstructing the shortest dependency paths.
* **Risk Scoring:** Automatically detects circular dependencies (via Tarjan's SCC) and architectural hotspots (`in_degree` centrality).

### 🎙️ Advanced On-Device Voice Pipeline
* **Local Wake Word:** `openWakeWord` (ONNX in Rust via `tract-onnx`) detects *"NEXUS"* locally with <0.5% CPU overhead. Zero audio leaves your device until woken.
* **Smart VAD & AGC:** Silero Voice Activity Detection with a dynamic silence gate and Automatic Gain Control ensures clean cutoffs and low-volume whisper recognition.
* **In-Process Neural TTS (Kokoro 82M):** Ultra-low latency (<150ms TTFB) speech synthesis running directly in Rust and played through hardware via `rodio`.
* **In-Process Neural STT (Moonshine):** Fast, local speech recognition running directly in the Rust process space with 0 cloud dependencies.

### 🛠️ Developer-First Integrations
* **Voice-Triggered PR Reviews:** *"NEXUS, analyze PR 1 in NEXUS-Agent."* Fetches diffs, commits, and comments, returning a Senior-Engineer grade review right to your sidebar.
* **Fuzzy Repo Matching:** Intelligent Levenshtein matching on the edge catches STT mishearings (e.g., "service" instead of "servx").
* **Linux MPRIS:** Native D-Bus media controls integrated directly via `zbus`.

### 🪟 Stunning Native UI
* **Non-Activating Overlay:** Floats above your IDE without stealing keyboard focus (`WS_EX_NOACTIVATE`).
* **Liquid Frosted Glass:** The response sidebar utilizes true native OS compositor blurs (Windows DWM acrylic) matching Apple Music's dark theme aesthetics.
* **Streaming Text Animations:** Cursor-style text rendering with sequential word fade-ins.

---

## 🏗️ Architecture Overview

NEXUS is **100% Serverless**:

```
[NEXUS Desktop (Rust + Tauri)] ──(HTTP POST)──► [Cloudflare Worker (Edge)]
                                                      │
                                                      ├──► D1 SQLite (OAuth & Registrations)
                                                      └──► Workers AI (Intent & Reasoning)
```

* **Edge Worker URL:** `https://nexus-worker.chitkullakshya.workers.dev`
* **Local Models:** openWakeWord (Wake word), Moonshine (STT), Kokoro (TTS).

---

## 🚀 Quick Start (Dev)

### Prerequisites
* Node.js 20+ and npm
* Rust 1.77+ toolchain

### 1. Frontend
```bash
npm --prefix frontend install
npm --prefix frontend run dev
```

### 2. Rust + Tauri
```bash
cd src-tauri
cargo build --release --features custom-protocol
```

---

## 📦 Production Build

```powershell
pwsh ./scripts/build.ps1 -Bundles "nsis"
```
Signed installers are generated for Windows (NSIS `.exe`), macOS (notarized `.dmg`), and Linux (AppImage + `.deb`).

---

## 📄 License
© 2026 NEXUS.
