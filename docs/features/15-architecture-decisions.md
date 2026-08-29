# 15 — Architecture Decisions

**Branch:** prem224k + prem22k
**Status:** Finalized
**Date:** 2026-08-29

---

## 1. Serverless Architecture Preserved

```
NEXUS laptop → HTTP POST → Cloudflare Worker → D1 + APIs → text response
```

**Decision:** No sidecar, no n8n, no Ollama in the client path.
- Audio stays local (faster-whisper on 127.0.0.1:39217)
- Only transcript text crosses the network
- Worker handles: intent classification, API calls, summarization, OAuth

**Rationale:** The old sidecar architecture required a local Python server,
n8n instance, and Ollama GPU server. The serverless architecture eliminates
all of these — the Worker runs on Cloudflare's edge with <5ms cold start.

---

## 2. Sidebar Content Delivery

**Original design:** Tauri events between separate WebView contexts
(main window emits event → sidebar window listens).

**Problem:** Cross-window Tauri events were unreliable. The sidebar
WebView sometimes didn't receive events, resulting in a black/empty sidebar.

**Final design:** Rust directly evaluates JavaScript in the sidebar WebView
DOM via `eval()`:
1. Frontend invokes `show_sidebar_with_content` IPC command
2. Rust positions/shows the sidebar window
3. Rust evaluates JavaScript directly in the sidebar WebView
4. Sets query text, response HTML, visibility class, scrolling
5. Creates animated word spans

**Rationale:** Direct DOM manipulation is more reliable than cross-window
event delivery in Tauri/WebView2.

---

## 3. `done` Event Timing

**Original:** Rust emitted `done` immediately after `result` → frontend
reset state and cancelled TTS.

**Problem:** The `done` event fired before TTS finished speaking, causing
the response to be cut off.

**Final:** `done` is only emitted on error/cancel paths. Normal flow:
- Frontend completes reset/hide after TTS callback
- Orb hides only after speech completes

---

## 4. Intent Classifier Enhancement

**Problem:** STT mishears "analyse" as "unless". The intent classifier
didn't recognize "unless PR 5 in servx" as a PR analysis request.

**Solution:** Added a pattern that catches `PR <number>` + `in/of/from`
even without the "analyse" keyword:

```typescript
if (/\bpr\s*#?\s*\d+\b/.test(t) && /\b(in|of|from)\b/.test(t)) {
  return "github_analyse";
}
```

---

## 5. `captureInProgress` Early Release

**Problem:** `captureInProgress` was set to `false` only after
`sendTranscript` returned (10-20s for PR analysis). During this time,
all new voice commands were silently skipped.

**Solution:** Set `captureInProgress = false` BEFORE calling
`sendTranscript`. The result handler in wsBridge handles the sidebar + TTS
when the response arrives, so we don't need to block.

---

## 6. Privacy Model

**Decision:** Audio never leaves the device.
- Local STT: faster-whisper on 127.0.0.1:39217
- Local VAD: Silero VAD in WebView2
- Local wake word: openWakeWord in Rust
- Only transcript text is sent to the Worker

**Exception:** prem22k's Gemini 3.5 Transcribe sends audio to Google.
This is kept as an **opt-in fallback** only — the default remains local
faster-whisper to preserve the privacy model.

---

## 7. Wake-Word Approach

**Decision:** prem224k's `SINGLE_FRAME_HIGH_CONFIDENCE = 0.5` approach
over prem22k's `MIN_POSITIVE_DETECTIONS = 1.0`.

**Rationale:**
- prem22k's approach: ANY single frame above 0.45 triggers (more false wakes)
- prem224k's approach: Only 0.5+ single frames trigger instantly; 0.45-0.5
  still needs 2 frames (more precise, lower false-positive rate)
