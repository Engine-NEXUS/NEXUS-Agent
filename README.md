# NEXUS — Voice-First AI Desktop Assistant & Architecture Mapper

A cross-platform, Siri-like floating overlay assistant designed specifically for software engineers. NEXUS combines a **native desktop client** (Tauri v2 + Rust + React/TS) with a **serverless edge backend** (Cloudflare Workers + D1) for blazing-fast, privacy-respecting AI interactions.

NEXUS was built to answer the ultimate developer question: *"If I change this, what breaks?"* — and was submitted for the **Autonomous Codebase Architecture Mapper** Hackathon.

> **Hackathon Jury:** Please read our official submission document at [docs/HACKATHON_SUBMISSION.md](docs/HACKATHON_SUBMISSION.md).

---

## ?? Key Features

### ??? Autonomous Architecture Mapper (Hackathon Highlight)
* **Instant Layering:** Analyzes any GitHub repo and clusters files into architectural layers (Frontend, Backend, DB, etc.) in under 10 seconds.
* **Deep Dependency Graph:** Clones the repo, parses AST imports in parallel via ayon, and builds a directed petgraph mapping out every file dependency.
* **Impact Analysis (Blast Radius):** Runs sub-10ms Reverse-BFS to show you exactly which files break if you modify a target file, reconstructing the shortest dependency paths.
* **Risk Scoring:** Automatically detects circular dependencies (via Tarjan's SCC) and architectural hotspots (in_degree centrality).

### ??? Advanced Voice Pipeline
* **Local Wake Word:** openWakeWord (ONNX in Rust) detects "NEXUS" locally with <0.5% CPU overhead. No audio is streamed until you wake it.
* **Smart VAD:** Silero Voice Activity Detection with a dynamic silence gate and Automatic Gain Control (AGC) ensures perfect cutoffs.
* **Multi-Voice TTS:** Gapless streaming playback via WebAudio, supporting Gemini 3.1 Flash TTS, ElevenLabs, and Fish Audio.
* **STT Fallbacks:** Defaults to local aster-whisper for maximum privacy, with optional Gemini 3.5 Transcribe integration.

### ?? Developer-First Integrations
* **Voice-Triggered PR Reviews:** *"NEXUS, analyze PR 5 in servx."* Fetches diffs, commits, and comments, returning a Senior-Engineer grade review right to your sidebar.
* **Fuzzy Repo Matching:** Intelligent Levenshtein matching on the edge catches STT mishearings (e.g., "service" instead of "servx").
* **Linux MPRIS:** Native D-Bus media controls integrated directly via zbus.

### ?? Stunning Native UI
* **Non-Activating Overlay:** Floats above your IDE without stealing keyboard focus.
* **Liquid Frosted Glass:** The response sidebar utilizes true native OS compositor blurs (Windows DWM acrylic) matching Apple Music's dark theme aesthetics.
* **Streaming Text Animations:** Cursor-style text rendering with sequential word fade-ins.

---

## ??? Architecture Overview

NEXUS is fully **Serverless**:
\\\
NEXUS laptop -> HTTP POST -> Cloudflare Worker -> APIs -> Text Response
                              |
                              -> D1 Database (OAuth tokens, Device registration)
                              -> Workers AI (Intent classification)
\\\
No sidecar, no n8n, no heavy local LLMs required. 

> **Read the full feature log:** [\docs/NEXUS_FEATURES_IMPLEMENTED.md\](docs/NEXUS_FEATURES_IMPLEMENTED.md)

---

## ?? Quick Start (Dev)

### Prerequisites
* Node.js 20+ and pnpm
* Rust toolchain
* Cloudflare Wrangler (for the edge worker)

### 1. Frontend
\\\ash
npm --prefix frontend install
npm --prefix frontend run dev
\\\

### 2. Rust + Tauri
\\\ash
cd src-tauri
# Must pass custom-protocol for the Vite dev server to connect properly
cargo build --release --features custom-protocol 
\\\

---

## ?? Production Build

\\\ash
pwsh ./scripts/build.ps1
\\\
Signed installers are generated for Windows (NSIS .exe), macOS (notarized .dmg, universal), and Linux (AppImage + .deb).

## ?? License
Proprietary — © 2026 NEXUS.
