# 09 — Multi-Voice TTS Engine

**Branch:** prem22k
**Status:** Implemented
**Date:** 2026-08-29

---

## Problem

NEXUS used the Web Speech API for TTS, which produces robotic-sounding
speech with limited voice options. The user wanted premium, natural-sounding
voices with multiple providers.

## Implementation (`frontend/src/audio/ttsPlayer.ts`)

### 6 Curated Voices

| Voice | Provider | Accent | Gender | Description |
|---|---|---|---|---|
| Gemini Flash | Google AI (`gemini-3.1-flash-tts-preview`) | US | Male | Ultra low-latency, natural expressive |
| Ethan | Fish Audio (`s2.1-pro`) | US | Male | Ultra-realistic conversational |
| Jarvis | ElevenLabs (Adam) | British UK | Male | Crisp, articulate, calm executive |
| Nova | ElevenLabs (Rachel) | American US | Female | Warm, natural, intelligent |
| Echo | ElevenLabs (Josh) | Australian AU | Male | Fast, energetic, high-clarity |
| Onyx | ElevenLabs (Arnold) | Deep Tech CA | Male | Deep, commanding, baritone |

### Multi-Tier Fallback

```
Speech Output (TTS)
        │
        ▼
┌──────────────────────┐   Fallback   ┌──────────────────────┐   Fallback   ┌──────────────────────┐
│  Gemini 3.1 Flash    │ ────────────>│  Fish Audio Ethan    │ ────────────>│ WebSpeech / WebAudio │
└──────────────────────┘              └──────────────────────┘              └──────────────────────┘
```

### VoiceOption interface

```typescript
export interface VoiceOption {
  id: string;
  name: string;
  provider: "neural" | "elevenlabs" | "fish_audio" | "gemini_tts" | "system";
  accent: string;
  description: string;
  elevenVoiceId?: string;
  fishModelId?: string;
  geminiModelId?: string;
  locale: string;
  gender: "male" | "female";
  sampleText: string;
}
```

### Settings (Rust side — `src-tauri/src/commands.rs`)

Added to `NexusSettings`:
- `tts_provider`: "neural" (default)
- `elevenlabs_api_key`: ElevenLabs API key
- `fish_audio_api_key`: Fish Audio API key
- `gemini_api_key`: Google Gemini API key

Environment variable fallback:
```rust
if settings.fish_audio_api_key.is_empty() {
    if let Ok(key) = std::env::var("FISH_AUDIO_API_KEY") {
        settings.fish_audio_api_key = key;
    }
}
```

## Privacy Note

Gemini STT (3.5 Transcribe) sends audio to Google. This is kept as an
**opt-in fallback** only — local faster-whisper remains the default to
preserve the "audio never leaves the device" privacy model.

## Files Changed

- `frontend/src/audio/ttsPlayer.ts` — 580 lines: voice definitions, playback engines, fallback chain
- `frontend/src/audio/stt.ts` — Gemini 3.5 Transcribe integration with fallback
- `frontend/src/settings/SettingsApp.tsx` — Voice selection UI
- `src-tauri/src/commands.rs` — NexusSettings with TTS provider fields
- `env.example` — Environment variable template
