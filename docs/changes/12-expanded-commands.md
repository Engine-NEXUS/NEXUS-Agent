# Change: Expanded Command System (30 Fixed + 9 Parameterized)

**Commit:** `b81261e` ("feat: expanded command system — 30 fixed + 9 parameterized commands")
**Date:** 2026-08-19

---

## Problem

The initial Tier 3 system had a small number of commands. The user wanted a comprehensive set covering common daily actions.

## Solution

Expanded to **39 commands** (30 fixed + 9 parameterized), defined in `command_intents.json`.

## The 30 Fixed Commands

| Command | Action | What It Does |
|---------|--------|--------------|
| `open_youtube` | open_app | Opens YouTube (URL fallback) |
| `open_gmail` | open_app | Opens Gmail (URL fallback) |
| `open_chrome` | open_app | Opens Chrome (focus/launch) |
| `open_notepad` | open_app | Opens Notepad |
| `open_calculator` | open_app | Opens Calculator |
| `open_spotify` | open_app | Opens Spotify |
| `open_discord` | open_app | Opens Discord |
| `open_github` | open_app | Opens GitHub (URL fallback) |
| `open_vscode` | open_app | Opens VS Code |
| `open_figma` | open_app | Opens Figma (URL fallback) |
| `open_slack` | open_app | Opens Slack (URL fallback) |
| `open_terminal` | open_app | Opens Terminal |
| `open_file_explorer` | open_app | Opens File Explorer |
| `open_settings` | open_app | Opens OS Settings |
| `open_brave` | open_app | Opens Brave |
| `open_edge` | open_app | Opens Edge |
| `open_firefox` | open_app | Opens Firefox |
| `open_outlook` | open_app | Opens Outlook |
| `open_word` | open_app | Opens Word |
| `open_excel` | open_app | Opens Excel |
| `open_powerpoint` | open_app | Opens PowerPoint |
| `mute_volume` | volume_mute | Mutes system volume |
| `take_screenshot` | screenshot | Takes a screenshot (Snipping Tool) |
| `lock_screen` | lock | Locks the screen |
| `browser_new_tab` | browser_key | Ctrl+T |
| `browser_close_tab` | browser_key | Ctrl+W |
| `browser_next_tab` | browser_key | Ctrl+Tab |
| `browser_back` | browser_key | Alt+Left |
| `play_pause` | media_key | Play/Pause media key |
| `stop_media` | media_key | Stop media key |

## The 9 Parameterized Commands

| Command | Action | Parameter | What It Does |
|---------|--------|-----------|--------------|
| `play_spotify` | spotify_play | song name | Opens Spotify search for the song |
| `search_youtube` | youtube_search | search query | Opens YouTube search results |
| `search_google` | google_search | search query | Opens Google search results |
| `search_github` | github_search | search query | Opens GitHub search results |
| `play_youtube` | youtube_play | video name | Opens YouTube search for the video |
| `send_message` | send_message | contact name | Opens WhatsApp Web |
| `set_timer` | set_timer | duration | Sets a timer (placeholder) |
| `set_alarm` | set_alarm | time | Sets an alarm (placeholder) |
| `create_event` | create_event | event details | Opens Google Calendar event editor |

## Command Intents JSON Format

```json
{
  "open_youtube": {
    "phrase": "open youtube",
    "model_file": "open_youtube.onnx",
    "intent": {
      "action": "open_app",
      "target": "youtube"
    }
  },
  "play_spotify": {
    "phrase": "play ... in spotify",
    "model_file": "play_spotify.onnx",
    "intent": {
      "action": "spotify_play",
      "needs_param": true
    }
  }
}
```

- `phrase` — the spoken phrase the classifier is trained on.
- `model_file` — the ONNX classifier model file.
- `intent.action` — the action to execute.
- `intent.target` — the target app (for `open_app`).
- `intent.needs_param` — true for parameterized commands.

## App Resolution (3-Tier)

For `open_app` commands, Rust resolves the app in order:
1. **Focus existing** — if the app is already running, focus its window.
2. **Launch new** — if the app is installed, launch it.
3. **URL fallback** — if the app isn't installed, open its URL in the browser.
4. **Not found** — "Didn't find that, sir."

## Files Changed

- `command_intents.json` — new file (39 command definitions).
- `src-tauri/src/command_executor.rs` — added all command implementations.
- `src-tauri/src/app_registry.rs` — new file (pre-indexed app launcher).
- `frontend/src/main.tsx` — updated Tier 3 listener to handle both fixed and parameterized commands.
