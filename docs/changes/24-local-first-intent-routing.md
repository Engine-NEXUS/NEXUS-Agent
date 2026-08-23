# 24 — Local-First Intent Routing

> **Commit:** `e0d0c80` — `fix: local commands hijacked by sidecar — local-first intent routing`
> **Date:** 2026-08-23
> **Status:** Complete

---

## Problem

When the Python sidecar was running on port `49152`, `sendTranscript()` succeeded and returned **before** local intent parsing ran. This meant:

- "open notepad" → sent to n8n backend instead of being executed locally
- "open gmail" → sent to n8n instead of opening the browser/app
- "search for cats" → sent to n8n instead of opening a local search
- All local commands failed whenever n8n was unavailable

The sidecar was consuming every transcript before the local parser could act on it.

---

## Root Cause

In `frontend/src/audio/recorder.ts`, the `finishCapture()` function had this flow:

```
transcript
  → sendTranscript(transcript)     ← sidecar consumes it first
  → parseIntent(transcript)        ← never reached if sidecar succeeds
  → execute locally                ← never reached
```

The `sendTranscript()` call to the sidecar would succeed (HTTP 200), and the function would return early, never reaching the local intent parser.

---

## Fix

### Reversed the Pipeline

Changed the flow to **local-first**:

```
transcript
  → parseIntent(transcript)        ← parse FIRST
  → known local command? → execute locally (open app, search, etc.)
  → unknown query? → sendTranscript to remote backend
  → backend unavailable? → "Didn't catch that, sir."
```

### Commands That Now Execute Locally

| Command | Action | Before | After |
|---------|--------|--------|-------|
| "open notepad" | Open Notepad | Sent to n8n (failed) | **Local execution** |
| "open gmail" | Open Gmail | Sent to n8n (failed) | **Local execution** |
| "search for cats" | Open search | Sent to n8n (failed) | **Local execution** |
| "play bohemian rhapsody" | Play on Spotify | Sent to n8n (failed) | **Local execution** |
| "what is the weather" | Conversational | Sent to n8n | Still sent to n8n |

### Implementation

In `finishCapture()` and `finishCaptureFromVad()`:

```typescript
const intent = parseIntent(transcript);

if (intent.action !== "unknown") {
  // Known local command — execute it directly
  await invoke("execute_command", { intent });
  return;
}

// Unknown intent — try the remote backend
await sendTranscript(transcript);
```

---

## Files Modified

| File | Change |
|------|--------|
| `frontend/src/audio/recorder.ts` | `finishCapture()` and `finishCaptureFromVad()` now parse intent locally before sending to sidecar |

---

## Impact

- Local commands work even when n8n/backend is down
- Response time for local commands dropped from ~2-5s (network round-trip) to ~50ms (local execution)
- The sidecar is only contacted for conversational queries that need n8n/Ollama
- Privacy improved: local commands never leave the device
