# 14 — Setup Wizard Redesign

**Branch:** prem22k
**Status:** Implemented
**Date:** 2026-08-29

---

## Problem

The original setup wizard was a basic 3-step flow (Welcome → Voice → Accounts)
with limited customization. The user wanted voice persona selection, API key
entry, and preference configuration.

## Implementation (`frontend/src/setup/SetupApp.tsx`)

### New 3-step wizard

| Step | Title | Content |
|---|---|---|
| 0 | Persona & Voice | Voice persona selection with preview playback |
| 1 | Preferences | Hotkey customization, wake word toggle, autostart toggle |
| 2 | Accounts | OAuth (Google/GitHub) + API keys (ElevenLabs, Fish Audio, Gemini) |

### Voice persona selection

- Displays all 6 curated voices (Jarvis, Nova, Echo, Onyx, Gemini Flash, Ethan)
- Each voice has a "Preview" button that plays a sample
- Selected voice saved to settings

### API key entry

- ElevenLabs API key
- Fish Audio API key
- Gemini API key
- Keys stored in `settings.json` with env var fallback

### Preferences

- Hotkey customization (default: Ctrl+Shift+Space)
- Wake word enable/disable toggle
- Autostart on boot toggle

### Removed `framer-motion`

The original setup wizard used `framer-motion` for animations. This was
removed and replaced with CSS transitions — `framer-motion` was identified
as an optimization candidate in the audit (bundle size reduction).

## Files Changed

- `frontend/src/setup/SetupApp.tsx` — Complete redesign (384 lines changed)
- `frontend/src/setup/setup.css` — New styles (80 lines)
- `frontend/src/settings/SettingsApp.tsx` — Voice selection in settings
