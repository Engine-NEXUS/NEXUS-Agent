# Feature: Local Audio Pipeline (VAD → STT → TTS)

> The complete local audio chain: capture, voice activity detection, speech-to-text, and text-to-speech. All audio stays on the device. Mic stream and VAD are kept warm between commands for ~10ms wake-to-listen.

**Source files:**
- `frontend/src/main.tsx` — wake handler, hot mic, parallel init
- `frontend/src/audio/recorder.ts` — mic capture (ScriptProcessorNode)
- `frontend/src/audio/vad.ts` — Silero VAD (ONNX Runtime Web) + pre-init
- `frontend/src/audio/stt.ts` — local STT IPC wrapper
- `frontend/src/audio/ttsPlayer.ts` — Web Speech API TTS
- `frontend/src/audio/paramCapture.ts` — 3-second parameter capture for Tier 3
- `src-tauri/src/stt.rs` — Rust HTTP client to local faster-whisper server
- `src-tauri/src/stt_server_manager.rs` — auto-start STT server

---

## Hot Mic + Pre-Init VAD

NEXUS keeps the mic stream and Silero VAD instance warm between commands to eliminate wake-to-listen delay:

```
APP STARTUP:
  1. getUserMedia() → micStream (acquired ONCE, kept warm)
  2. preloadSileroVad() → fetch ONNX WASM + model from CDN
  3. preloadMicVad(micStream) → create MicVAD instance (paused)
  Total startup: ~2-3s (background, user doesn't notice)

ON WAKE ("NEXUS"):
  1. Re-enable mic tracks (~0ms)
  2. Promise.all([captureUntilSilence(), startVad()]) — parallel (~5ms)
  Total wake-to-listen: ~10-50ms (down from ~200-500ms)

AFTER COMMAND:
  1. micVad.pause() — VAD paused, not destroyed
  2. micStream tracks disabled, not stopped
  → Both ready for instant resume on next wake
```

| Metric | Before (cold) | After (hot) |
|--------|--------------|-------------|
| getUserMedia() | 50-200ms per wake | 0ms (stream warm) |
| MicVAD.new() | 60-250ms per wake | ~1ms (resume from pause) |
| Recording + VAD | Sequential (~255ms) | Parallel (~5ms) |
| **Total wake-to-listen** | **~200-500ms** | **~10-50ms** |

---

## The Pipeline

```
                    ┌─────────────────────────────────────────────────────┐
                    │  FRONTEND (WebView)                                  │
                    │                                                     │
  Mic ────────────▶│  getUserMedia() — ONCE at startup, kept warm       │
                    │  │                                                  │
                    │  ▼                                                  │
                    │  ScriptProcessorNode (4096 buffer, native SR)      │
                    │  │                                                  │
                    │  ├──▶ Float32 buffer (in memory)                    │
                    │  │                                                  │
                    │  └──▶ Silero VAD (ONNX Runtime Web, WASM)          │
                    │       (pre-initialized at startup, paused/resumed)  │
                    │       │                                             │
                    │       ▼                                             │
                    │    speech detected? ─── no ──▶ keep listening      │
                    │       │ yes                                         │
                    │       ▼                                             │
                    │    silence detected? ─── no ──▶ keep listening     │
                    │       │ yes                                         │
                    │       ▼                                             │
                    │  finishCapture():                                   │
                    │    downsample 48k → 16k                             │
                    │    Float32 → Int16 PCM                              │
                    │    │                                                │
                    └────│────────────────────────────────────────────────┘
                         │
                         │  HTTP POST multipart (raw PCM bytes)
                         │  to 127.0.0.1:8000 ONLY (never to remote server)
                         ▼
                    ┌─────────────────────────────────────────────────────┐
                    │  LOCAL STT SERVER (faster-whisper)                  │
                    │  127.0.0.1:8000 (auto-started by stt_server_manager)│
                    │                                                     │
                    │  CTranslate2 inference                               │
                    │  Returns transcript text                             │
                    └─────────────────────────────────────────────────────┘
                         │
                         │  transcript text (string)
                         ▼
                    ┌─────────────────────────────────────────────────────┐
                    │  FRONTEND (back in WebView)                         │
                    │                                                     │
                    │  parseIntent(transcript)                            │
                    │  │                                                  │
                    │  ├─ local intent? ──▶ invoke("execute_command")     │
                    │  │                                                  │
                    │  └─ unknown? ──────▶ sendTranscript() ──▶ WSS ──▶  sidecar
                    │                                                     │
                    │  ... later, result text comes back via WSS ...      │
                    │                                                     │
                    │  speak(text) via Web Speech API:                    │
                    │    SpeechSynthesisUtterance                         │
                    │    voices loaded async (voiceschanged event)        │
                    │    English voice selected                           │
                    │    rate=1.0, pitch=1.0, volume=1.0                  │
                    │    emit "tts-started" → Rust suppresses wake        │
                    │    onend → emit "tts-ended" → Rust resumes wake     │
                    └─────────────────────────────────────────────────────┘
```

## VAD: Silero ONNX

Silero VAD is a neural network that detects speech patterns — not just volume. It can distinguish speech from background noise even when the speech volume is very low (RMS 0.003-0.007), which RMS energy detection cannot do.

**Configuration (tuned for short voice commands):**
- `POSITIVE_SPEECH_THRESHOLD = 0.5` — above this = speech
- `NEGATIVE_SPEECH_THRESHOLD = 0.35` — below this = silence
- `REDEMPTION_MS = 1500` — grace period before declaring speech end
- `PRE_SPEECH_PAD_MS = 500` — audio to prepend before speech start
- `MIN_SPEECH_MS = 500` — discard segments shorter than this

**Fallback:** If Silero fails to load (ONNX WASM issue), RMS energy VAD is used as a fallback.

**ONNX WASM loading:** ONNX Runtime Web's internal dynamic import is incompatible with Vite's dev server pre-bundling. The workaround loads WASM binaries from CDN (`cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/`), bypassing Vite entirely.

## STT: faster-whisper (Local)

- Runs on `127.0.0.1:8000` (separate Python process, not the sidecar).
- Uses CTranslate2 for 10x speedup over openai-whisper.
- Receives raw PCM via HTTP multipart (`application/octet-stream`).
- Returns transcript text.
- **Audio never leaves the device.** The POST goes to localhost, not the remote server.

**Rust-side client** (`stt.rs`):
```rust
const DEFAULT_LOCAL_STT_URL: &str = "http://127.0.0.1:8000/transcribe";
```

Uses `127.0.0.1` instead of `localhost` because Rust's hyper/tokio tries IPv6 (`::1`) first when resolving `localhost`, and uvicorn binds to IPv4 only by default.

## TTS: Web Speech API

- Built into the browser (`speechSynthesis`).
- Zero dependency.
- Voices load asynchronously (`voiceschanged` event).
- English voice auto-selected.
- Meeting-aware: checks `meeting_active` before speaking.
- Emits `tts-started` / `tts-ended` events so Rust can suppress wake detection during speech.

**Barge-in:** `stopTts()` calls `speechSynthesis.cancel()` immediately. Must be called before starting a new utterance to avoid the `interrupted` error.

## Why ScriptProcessorNode, Not AudioWorklet?

`AudioWorkletNode` is the modern API, but Chrome/WebView2 optimizes away silent audio paths — if the worklet's output isn't connected to the destination, the audio graph is pruned and no data flows. This was the root cause of a previous bug.

`ScriptProcessorNode` is deprecated but proven reliable in WebView2/Electron. Connecting `source → node → destination` directly (no gain node) ensures the graph stays alive.
