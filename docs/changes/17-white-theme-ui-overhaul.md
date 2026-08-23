# 17 — White Theme UI Overhaul

> **Commit:** `5ee9275` — `feat: white theme UI overhaul — orb card, settings window, setup wizard`
> **Date:** 2026-08-20
> **PR:** #16 (merged as `ed1c4b8`)
> **Status:** Partially reverted in `4e1086c` (orb changes rolled back, settings + setup kept)

---

## What Changed

This was the first major UI overhaul attempt. It redesigned all three NEXUS windows with a white theme, design tokens, and Framer Motion animations. The orb window changes were later reverted after user feedback, but the settings window and setup wizard redesigns were kept.

### Files Created
- `frontend/src/theme/tokens.css` — CSS custom properties (colors, shadows, spacing, radii, typography)
- `frontend/src/settings/SettingsApp.tsx` — tabbed settings window (General, Audio, Wake Word, Privacy, Backend)
- `frontend/src/settings/settings.css` — white theme styles for settings
- `frontend/src/settings/main.tsx` — React entry point for settings window
- `frontend/settings.html` — HTML entry point for settings window
- `frontend/src/components/StatusBar.tsx` — status text bar (deleted in revert)
- `frontend/src/components/TranscriptPanel.tsx` — conversation transcript (deleted in revert)

### Files Modified
- `frontend/package.json` — added `framer-motion` ^12.43.0
- `frontend/src/App.tsx` — expanded to 320x440 with white card (later reverted to 200x200)
- `frontend/src/avatar/Avatar.tsx` — resized to 120px, added connecting/error states (later reverted to 180px, 4 states)
- `frontend/src/store/assistant.ts` — added `connecting` and `error` states (later reverted to 4 states)
- `frontend/src/styles.css` — white theme orb styling (later reverted)
- `frontend/src/setup/SetupApp.tsx` — rewritten as 4-step wizard
- `frontend/src/setup/setup.css` — white theme setup styles
- `src-tauri/tauri.conf.json` — expanded main window, added settings window
- `src-tauri/src/commands.rs` — added settings IPC commands
- `src-tauri/src/lib.rs` — registered settings commands, updated orb positioning
- `src-tauri/src/tray.rs` — tray menu opens settings window

---

## Design System

### CSS Design Tokens (`tokens.css`)

```css
--nx-bg: #FFFFFF;
--nx-bg-secondary: #F9FAFB;
--nx-text-primary: #111827;
--nx-text-secondary: #6B7280;
--nx-border: #E5E7EB;
--nx-accent-blue: #6AA8FF;
--nx-accent-purple: #A855F7;
--nx-accent-grad: linear-gradient(135deg, #6AA8FF, #A855F7);
--nx-radius: 12px;
--nx-radius-lg: 16px;
--nx-shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
--nx-shadow-lg: 0 10px 30px rgba(0,0,0,0.12);
--nx-font: -apple-system, "Segoe UI", Roboto, sans-serif;
```

### Color Palette
| Token | Value | Usage |
|-------|-------|-------|
| `--nx-bg` | `#FFFFFF` | Primary background |
| `--nx-bg-secondary` | `#F9FAFB` | Secondary surfaces |
| `--nx-text-primary` | `#111827` | Body text |
| `--nx-text-secondary` | `#6B7280` | Captions, hints |
| `--nx-accent-blue` | `#6AA8FF` | Primary accent |
| `--nx-accent-purple` | `#A855F7` | Secondary accent |
| `--nx-success` | `#10B981` | Connected status |
| `--nx-warning` | `#F59E0B` | Not configured |
| `--nx-error` | `#EF4444` | Error states |

### Accessibility
- WCAG AA compliant (4.5:1+ contrast ratio for all text)
- Reduced motion support via `@media (prefers-reduced-motion: reduce)`
- Focus-visible outlines for keyboard navigation

---

## Settings Window (KEPT)

### Window Configuration
- **Label:** `settings`
- **Size:** 600x720
- **Decorations:** true (has title bar)
- **Transparent:** false
- **Centered:** true
- **URL:** `settings.html`

### Tabs
1. **General** — autostart toggle, launch at boot, minimize to tray
2. **Audio** — microphone input selector, speaker output selector, test mic, test speaker
3. **Wake Word** — wake word sensitivity slider, enable/disable voice wake, hotkey display
4. **Privacy** — meeting detection toggle, TTS mute in meetings, data retention
5. **Backend** — server URL, user ID, device ID, connection test, reconnect

### Rust IPC Commands Added
- `open_settings_window` — show and focus the settings window
- `close_settings_window` — hide the settings window
- `get_settings` — read settings from `settings.json` in app data dir
- `save_settings` — write settings to `settings.json`
- `test_microphone` — record 2s and report RMS level
- `test_speaker` — play a test tone via Web Speech API

### Settings Persistence
Settings are stored in `nexus-config.json` in the Tauri app data directory:
- Windows: `%APPDATA%\com.nexus.app\nexus-config.json`
- macOS: `~/Library/Application Support/com.nexus.app/nexus-config.json`
- Linux: `~/.config/com.nexus.app/nexus-config.json`

---

## What Was Reverted

The orb window changes were reverted in commit `4e1086c` after user feedback:

> "why did u create that bring the orginal self back i said for the installer interface when a user instal exe for steup create the ineterface bring my orl aniamtion bac i dont want any chnage to be made in that"

### Reverted Changes
- Main window: 320x440 → back to 200x200
- Avatar: 120px → back to 180px
- Assistant states: 6 (idle/listening/thinking/speaking/connecting/error) → back to 4 (idle/listening/thinking/speaking)
- White card container → removed
- StatusBar component → deleted
- TranscriptPanel component → deleted
- Orb positioning: 320px → back to 200px

### What Was Kept
- Settings window (600x720, tabbed, white theme)
- Setup wizard (4-step, white theme)
- CSS design tokens (`tokens.css`)
- Framer Motion dependency
- Settings IPC commands in Rust

---

## Test Results

| Test | Result |
|------|--------|
| TypeScript compilation | Pass (0 errors) |
| `cargo check` | Pass (0 errors, 9 pre-existing warnings) |
| Release build | Pass (4m 07s) |
| NEXUS launches | Pass (PID 22264) |
| Sidecar healthy | Pass (ok, text-only) |
| No terminal windows | Pass |
| RAM usage | ~50 MB (nexus.exe) + ~65 MB (pythonw.exe) |

---

## Dependencies Added
- `framer-motion` ^12.43.0 — animation library for React

---

## Lessons Learned
1. **User's orb is sacred** — the 200x200 Lottie animation with smile/loading segments must not be modified
2. **Separate concerns** — installer UI, setup wizard, and settings window are separate from the orb
3. **Always clarify** — "interface" can mean installer, setup wizard, or orb. Always ask which one.
