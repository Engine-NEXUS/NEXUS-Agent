# ⚡ NEXUS — Quick Start Guide

## 🎯 The Core Problem Solved
> *"If I change this piece of code, what else could be affected — and why?"*

Enterprise codebases span thousands of files where architecture evolves faster than documentation. Traditional tools only list static file imports. **NEXUS is a consequence engine**: it calculates the exact **blast radius** using sub-10ms reverse-BFS graph traversal, reconstructs the shortest dependency paths, mathematically detects circular dependencies (Tarjan's SCC), and uses an AI agent with voice to explain engineering risks in plain English.

---

## 🚀 1. Installation (Windows)

1. Run **`NEXUS_0.1.0_x64-setup.exe`** (or download from [GitHub Releases](https://github.com/Engine-NEXUS/NEXUS-Agent/releases)).
2. The installer runs **per-user** (`%LOCALAPPDATA%\NEXUS`) with **no Admin / UAC prompts** needed.
3. Once installation completes, the **NEXUS Setup Wizard** opens automatically.
4. Click through the voice selection (**Sky**, **Adam**, or **Emma** powered by local Kokoro TTS) and click **🚀 Launch Assistant**.

---

## 🎙️ 2. Instant Interaction Triggers

* **Global Hotkey:** Press **`Ctrl + Shift + Space`** anywhere in Windows.
* **Wake Word:** Say clearly: **`"NEXUS"`** or **`"Hey NEXUS"`** into your microphone.
* The floating liquid-glass orb will illuminate and start listening.

---

## 🧪 3. Key Test Scenarios

### Scenario A: Autonomous Codebase Architecture Mapper *(Core Feature)*
1. Trigger NEXUS (`Ctrl+Space`) and say:
   > *"Open architecture mapper"*
2. **Result:** It will automatically detect the repository URL (e.g. your currently active project) and render an interactive dependency diagram. 
   *(Note: Due to strict OS/laptop security policies, automatic URL detection might be incompatible on some machines. If it doesn't work, you can manually paste the repository URL into the mapper window).*

### Scenario B: Change Impact Analysis & Blast Radius
1. In the Architecture Map or via voice, ask:
   > *"What breaks if I change vite.config.ts?"*
2. **Result:** The backend executes reverse Breadth-First Search (BFS) on the dependency graph in `<10ms`, calculates graph centrality and circular dependencies (Tarjan's SCC), dims unaffected files, and pulses the blast radius in red while explaining the risk in plain English.

### Scenario C: Voice-Driven GitHub PR Code Review
1. Trigger NEXUS and say:
   > *"NEXUS, analyze PR 254 in Engine-NEXUS/NEXUS-Agent"* (or any other PR in a repo)
2. **Result:** NEXUS fetches the PR diff from GitHub, generates a senior-engineer-grade summary of changes, potential bugs, and architectural risks, and renders it in the liquid glass sidebar.

### Scenario D: General AI Assistant
1. Trigger NEXUS and ask literally any question:
   > *"Explain the difference between WebSockets and HTTP/2 in two sentences."*
2. **Result:** Processed by the Cloudflare edge worker and spoken aloud with high-fidelity Kokoro 82M neural voice (<150ms TTFB).

### Scenario E: App & System Automation
1. Trigger NEXUS and say:
   > *"Open [App Name]"* (e.g. *"Open Chrome"*)
2. **Result:** Instantly executes native OS commands to open the requested software.

---

## 🌐 4. Live Cloud & Edge Infrastructure

* **Live Deployed Edge Worker:** [`https://nexus-worker.chitkullakshya.workers.dev`](https://nexus-worker.chitkullakshya.workers.dev)
* **Health Check:** [`https://nexus-worker.chitkullakshya.workers.dev/health`](https://nexus-worker.chitkullakshya.workers.dev/health) (Returns `{"ok":true,"serverless":true}`)
* **Local In-Process AI:**
  * Wake Word: `openWakeWord` (Tract-ONNX in Rust)
  * STT: `Moonshine Tiny/Base` (In-process Rust ONNX)
  * TTS: `Kokoro 82M` (In-process Rust ONNX + Rodio native playback)

---

## 🛠️ 5. Troubleshooting for Evaluators

| Issue | Solution |
| :--- | :--- |
| **Microphone is silent or blocked** | Press **`Ctrl+Space`** to trigger listening directly. Ensure Windows *Settings → Privacy → Microphone* allows desktop apps. |
| **Want to change voice settings** | Right-click the **NEXUS tray icon** (near Windows clock) → **Settings** → **Audio & Voice**. |
| **Need diagnostics report** | Right-click the tray icon → **Diagnostics** (checks STT, TTS, Worker, and OAuth connections). |
