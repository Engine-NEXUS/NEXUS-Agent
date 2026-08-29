# 02 — STT Mishearing Fixes

**Branch:** prem224k
**Status:** Implemented and tested
**Date:** 2026-08-29

---

## Problem

The local STT server uses `tiny.en` (39M params, fastest model) which
struggles with brand names and technical terms:

| User said | STT heard |
|---|---|
| "analyse" | "unless", "analyze", "and let's" |
| "PR 5" | "pf5", "p r 5", "pe5" |
| "servx" | "cervix", "service", "weeks", "serve x" |

## Implementation

### 1. STT Server — `initial_prompt` (`server/stt_server.py`)

Added an `initial_prompt` parameter to every transcription call. This biases
the Whisper decoder toward expected vocabulary:

```python
initial_prompt = (
    "The user is giving voice commands to a desktop assistant. "
    "Common commands include: analyse PR 5 in servx, review PR 3 in servx, "
    "open gmail, search youtube, close notepad. "
    "Recognised names: servx, NEXUS, ULTRON, github, gmail."
)
segments, _info = model.transcribe(
    audio_file,
    language="en",
    hotwords=hotwords,
    initial_prompt=initial_prompt,
    ...
)
```

### 2. Dynamic Hotwords File (`server/stt_server.py`)

- Hotwords file path:
  - Windows: `%APPDATA%\com.nexus.assistant\stt_hotwords.txt`
  - Linux/Mac: `~/.config/nexus/stt_hotwords.txt`
- Hot-reloaded on every transcription request (no restart needed)
- NEXUS writes the user's GitHub repo names here so Whisper recognises them
- Built-in hotwords include: servx, NEXUS, ULTRON, gmail, github, etc.

```python
def _load_hotwords() -> str:
    """Load hotwords from the built-in list + the dynamic hotwords file."""
    words = list(_DEFAULT_HOTWORDS)
    try:
        if os.path.exists(HOTWORDS_FILE):
            with open(HOTWORDS_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    w = line.strip()
                    if w and w not in words:
                        words.append(w)
    except Exception:
        pass
    return " ".join(words)
```

### 3. Frontend Post-Processing (`frontend/src/audio/recorder.ts`)

`correctSttTranscript()` function applies regex corrections after STT
returns the transcript, before intent parsing:

```typescript
function correctSttTranscript(transcript: string): string {
  let t = transcript;

  // Fix "analyse" mishearings
  if (/^unless\b/i.test(t)) {
    t = t.replace(/^unless\b/i, "analyse");
  }
  if (/^analyze\b/i.test(t)) {
    t = t.replace(/^analyze\b/i, "analyse");
  }

  // Fix "PR" mishearings
  t = t.replace(/\bpf\s*(\d+)\b/gi, "PR $1");
  t = t.replace(/\bp\s*r\s*(\d+)\b/gi, "PR $1");
  t = t.replace(/\bpr(\d+)\b/gi, "PR $1");

  // Fix "servx" mishearings (when preceded by in/of/from)
  t = t.replace(/\bin\s+(?:cervix|service|weeks|serve\s*x|ser\s*fixes)\b/gi, " in servx");

  return t;
}
```

Applied in both `finishCapture()` and `finishCaptureFromVad()` right after
STT returns the transcript.

## Testing Results

| STT heard | Corrected to | Result |
|---|---|---|
| "unless PR 5 in servx" | "analyse PR 5 in servx" | Full analysis |
| "analyze PR 5 in servx." | "analyse PR 5 in servx." | Full analysis |
| "Analyze PR 5 in servx like this" | "analyse PR 5 in servx like this" | Full analysis |
| "unless pf5 in cervix" | "analyse PR 5 in servx" | Full analysis |

## Files Changed

- `server/stt_server.py` — Dynamic hotwords, initial_prompt
- `frontend/src/audio/recorder.ts` — correctSttTranscript() function
