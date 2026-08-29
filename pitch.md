---
marp: true
theme: default
class:
  - lead
  - invert
style: |
  section {
    justify-content: center;
    font-family: 'Inter', sans-serif;
  }
  h1 {
    color: #4facfe;
    font-size: 3.5em;
  }
  h2 {
    color: #00f2fe;
  }
  li {
    text-align: left;
    margin-bottom: 0.5em;
  }
---

# NEXUS
## The Floating Desktop AI Assistant
A cross-platform, Siri-like floating overlay assistant that lives on your desktop.

---

## The Problem
- Modern AI assistants are either **trapped in a browser tab** or require **heavy local resources**.
- They lack seamless, non-intrusive integration with the user's desktop workflow.
- **Privacy concerns:** Cloud-based audio processing sends your voice to third-party servers.

---

## The Solution: NEXUS
- **Thin Client:** Tauri v2 + Rust + React/TS. (Idle RAM < 90 MB).
- **Fat Server:** n8n supervisor + Ollama for intelligent intent routing and LLM processing.
- **Privacy First:** Wake-word and Speech-to-Text run **locally**. Only text crosses the network.

---

## Key Highlights
- **Transparent & Frameless:** Always-on-top overlay with *region-aware click-through* (clicks fall through transparent pixels).
- **Low-Power Wake Word:** openWakeWord in pure Rust (~0.5% CPU, fully offline).
- **Streaming TTS:** Gapless WebAudio playback for instant responses.
- **Zero Idle CPU:** No background JS loops; entirely event-driven.

---

## Architecture Topology
- **Thin Client (Rust + React):** 
  - openWakeWord KWS ➔ Wake Event
  - Local STT (faster-whisper) ➔ WSS Bridge
- **Fat Server (GPU Host):**
  - Webhook ➔ n8n Master Supervisor
  - Intent Router ➔ Ollama (LLM) ➔ TTS (Piper) ➔ WSS

---

## Intelligent Intent Router (n8n)
- **Sub-canvas Workflows:**
  - `email.summarize`: Summarizes your recent emails (IMAP/Graph API).
  - `github.pr_check`: Reviews PR status & risk (GitHub REST).
  - `calendar.peek`: Narrates your next 3 events.
  - `general.chat`: Fast, free-form conversational replies.

---

## Built For Every Platform
- **Windows 10/11:** NSIS installer; WebView2 bootstrapper.
- **macOS (Silicon & Intel):** Universal `.dmg`, notarized; `LSUIElement` hides dock.
- **Linux (X11 & Wayland):** AppImage & `.deb`; requires compositor for true transparency.

---

## Why NEXUS Wins
- **Performance:** Native Rust backend ensures a minimal resource footprint.
- **Privacy:** Your voice never leaves your machine. Text-only network protocol.
- **Extensibility:** n8n blueprints allow infinite server-side capabilities without client updates.
- **UX:** Region-aware click-through makes it feel like magic.

---

# Thank You
## NEXUS — The Future of Desktop AI
