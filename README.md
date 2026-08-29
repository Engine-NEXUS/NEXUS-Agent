# ⚡ NEXUS — Autonomous Codebase Architecture Mapper & Voice Assistant

> **Citta RISE Hackathon (Idea2Agent Edition) · 29 Aug 2026**  
> **Problem Statement 05:** Architecture Mapper (*"Not a diagram. A consequence engine."*)  
> **Team Name:** V-Max (Team #5)  
> **Team Leader:** Prem Sai Kota ([@prem22k](https://github.com/prem22k))  
> **Team Members:** Lakshya Chitkul ([@chitkullakshya](https://github.com/chitkullakshya)), Ajith Kumar ([@ajithhhak](https://github.com/ajithhhak))

---

## 🚀 Our Vision: Beyond a Simple Solution

While the hackathon problem statement asked for a simple architecture mapper, we realized that modern developers don't just need static diagrams—they need an intelligent, omnipresent companion. 

Instead of building a conventional web tool, we set out to build **something with a future vision: a Jarvis-like autonomous assistant for software engineers.** We built NEXUS entirely in **Rust** to be incredibly fast, memory-efficient, and capable of running heavy neural models (Wake Word, STT, TTS) directly on your device. 

Currently, we are heavily iterating through the codebase, refining its serverless edge architecture, optimizing the on-device audio pipelines, and polishing the final consequence engine. NEXUS isn't just an architecture mapper—it's our bold vision for the future of hands-free, AI-assisted development.

---

## 💡 The Core Problem: *"If I change this, what breaks?"*

NEXUS transforms codebase exploration from a static directory view into an active **consequence engine**. It combines a **native desktop client** (Tauri v2 + Rust + React/TS) with a **serverless edge backend** (Cloudflare Workers + D1) and **local in-process AI** (Moonshine STT + Kokoro TTS) to give developers instant architectural visibility and change impact analysis.

* 📖 **Quick Start Guide:** [QUICKSTART.md](QUICKSTART.md) *(How to test in 60s)*
* 🏆 **Full Hackathon Submission:** [docs/HACKATHON_SUBMISSION.md](docs/HACKATHON_SUBMISSION.md) *(Evaluation Criteria & Technical Deep Dive)*

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

### 🛠️ 3. Developer-First Integrations
* **Voice-Triggered PR Reviews:** *"NEXUS, analyze PR 1 in NEXUS-Agent."* Fetches diffs, commits, and comments, returning a Senior-Engineer grade review right to your sidebar.
* **Fuzzy Repo Matching:** Intelligent Levenshtein matching on the edge catches STT mishearings.
* **Non-Activating Overlay:** Floats above your IDE without stealing keyboard focus (`WS_EX_NOACTIVATE`).

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

## 📄 License
© 2026 **Team V-Max (Team #5)**.
