# 04 — On-It-Sir → Here-Is-The-Analysis Flow

**Branch:** prem224k
**Status:** Implemented and tested
**Date:** 2026-08-29

---

## Problem

PR analysis takes 10-20 seconds (GLM model inference). The user wanted:
1. Immediate "On it sir" acknowledgement when the command is recognised
2. Orb disappears (no awkward waiting state)
3. When the result arrives: orb reappears briefly, says "Here is the analysis sir"
4. Sidebar shows the full PR review with streaming animation
5. Orb auto-closes after the short confirmation

## Implementation

### Detection (`frontend/src/audio/recorder.ts`)

```typescript
function isLongRunningQuery(transcript: string): boolean {
  const t = transcript.toLowerCase();
  const hasAnalyse = /\b(analy[sz]e|review|deep\s*dive|critique|evaluate|...)\b/.test(t);
  const hasPR = /\b(pr|pull\s*request)\b/.test(t);
  const hasRepo = /\b(repo|repository)\b/.test(t);
  const hasPRNumber = /\bpr\s*#?\s*\d+\b/.test(t);
  return (hasAnalyse && (hasPR || hasRepo)) || hasPRNumber;
}
```

### Acknowledgement (`frontend/src/audio/recorder.ts`)

```typescript
async function ackLongRunningQuery(): Promise<void> {
  store.setState("speaking");
  store.addAssistantMessage("On it sir.");
  await speak("On it sir");
  store.setVisible(false);  // Hide orb
  store.setState("thinking");
}
```

### Result handler (`frontend/src/net/wsBridge.ts`)

When the Worker response arrives:
1. `store.setVisible(true)` — show orb briefly
2. Invoke `show_sidebar_with_content` — sidebar appears with animated text
3. Speak "Here is the analysis, sir"
4. After TTS completes: `store.setVisible(false)` — auto-close orb
5. Sidebar stays visible until dismissed via hotkey

### Critical fix: `captureInProgress` blocking

**Root cause:** `captureInProgress` was set to `false` only AFTER
`sendTranscript` returned (which blocks 10-20s). During this time, all new
voice commands were silently skipped.

**Fix:** Set `captureInProgress = false` BEFORE calling `sendTranscript`:

```typescript
// Release captureInProgress BEFORE sendTranscript so subsequent voice
// commands can be processed while the Worker is generating the response.
captureInProgress = false;
await sendTranscript(transcript);
```

## Flow Diagram

```
User: "analyse PR 5 in servx"
  │
  ├─ STT transcribes → correctSttTranscript() fixes mishearings
  ├─ isLongRunningQuery() → true
  ├─ ackLongRunningQuery():
  │   ├─ Speak "On it sir"
  │   └─ Orb hides
  ├─ captureInProgress = false (released early)
  ├─ sendTranscript() → Worker processes (10-20s)
  │
  ... 15-20 seconds later ...
  │
  ├─ Worker returns 10,000+ char analysis
  ├─ wsBridge result handler:
  │   ├─ Orb reappears briefly
  │   ├─ Sidebar shows with animated text
  │   ├─ Speak "Here is the analysis, sir"
  │   └─ Orb auto-closes
  └─ Sidebar stays until hotkey dismisses it
```

## Testing Results

| Step | Result |
|---|---|
| "On it sir" spoken immediately | Yes |
| Orb disappears after ack | Yes |
| Subsequent commands work during wait | Yes (captureInProgress fix) |
| "Here is the analysis sir" spoken | Yes |
| Sidebar appears with PR review | Yes |
| Orb auto-closes after confirmation | Yes |
| Sidebar stays until hotkey | Yes |

## Files Changed

- `frontend/src/audio/recorder.ts` — isLongRunningQuery(), ackLongRunningQuery(), captureInProgress fix
- `frontend/src/net/wsBridge.ts` — Result handler with orb visibility management
