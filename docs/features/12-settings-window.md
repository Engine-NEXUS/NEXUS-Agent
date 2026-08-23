# Feature 12 — Settings Window

> **Window label:** `settings`
> **Size:** 600x720
> **Entry point:** `frontend/settings.html` → `frontend/src/settings/main.tsx` → `SettingsApp.tsx`
> **Added in:** commit `5ee9275` (PR #16)

---

## Overview

A dedicated, white-themed, tabbed settings window that allows users to configure NEXUS without editing config files. Accessible from the system tray menu.

---

## Window Configuration

```json
{
  "label": "settings",
  "title": "NEXUS Settings",
  "width": 600,
  "height": 720,
  "resizable": false,
  "decorations": true,
  "transparent": false,
  "alwaysOnTop": false,
  "skipTaskbar": false,
  "shadow": true,
  "focus": true,
  "visible": false,
  "center": true,
  "url": "settings.html"
}
```

- **Decorations:** true — has a standard Windows title bar with close button
- **Visible:** false — hidden on startup, shown via `open_settings_window` IPC
- **Center:** true — appears in the center of the screen

---

## Tabs

### 1. General
| Setting | Type | Description |
|---------|------|-------------|
| Launch at startup | Toggle | Enable/disable Windows autostart (Scheduled Task) |
| Minimize to tray | Toggle | Keep NEXUS running in tray when closed |
| Show orb on wake | Toggle | Show the bottom-center animation on wake |
| Language | Dropdown | UI language (English only currently) |

### 2. Audio
| Setting | Type | Description |
|---------|------|-------------|
| Microphone input | Dropdown | Select input device |
| Speaker output | Dropdown | Select output device |
| Mic sensitivity | Slider | Adjust microphone gain threshold |
| Test microphone | Button | Record 2s and report RMS level |
| Test speaker | Button | Play a test tone |

### 3. Wake Word
| Setting | Type | Description |
|---------|------|-------------|
| Enable voice wake | Toggle | Enable/disable openWakeWord KWS |
| Wake word sensitivity | Slider | Adjust detection threshold (0.0-1.0) |
| Hotkey | Display | Shows current global hotkey (Ctrl+Shift+Space) |
| Speaker verification | Toggle | Enable/disable speaker ID check |
| Wake variants | Multi-select | "nexus", "next us", "nexus ai", etc. |

### 4. Privacy
| Setting | Type | Description |
|---------|------|-------------|
| Meeting detection | Toggle | Auto-detect active meetings (WASAPI + process scan) |
| Suppress TTS in meetings | Toggle | Mute TTS when a meeting is detected |
| Suppress wake in meetings | Toggle | Ignore wake word during meetings |
| Data retention | Dropdown | How long to keep conversation history |

### 5. Backend
| Setting | Type | Description |
|---------|------|-------------|
| Server URL | Text input | WebSocket URL of the NEXUS backend |
| User ID | Text input | User identifier |
| Device ID | Text input | Device identifier |
| Test connection | Button | Ping the backend and show status |
| Reconnect | Button | Force reconnect to backend |
| Re-run setup | Button | Open the setup wizard again |

---

## Rust IPC Commands

### `open_settings_window`
```rust
#[tauri::command]
pub fn open_settings_window<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let win = app.get_webview_window("settings")?;
    win.show()?;
    win.set_focus()?;
    Ok(())
}
```

### `close_settings_window`
```rust
#[tauri::command]
pub fn close_settings_window<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let win = app.get_webview_window("settings")?;
    win.hide()?;
    Ok(())
}
```

### `get_settings`
Reads settings from `settings.json` in the app data directory. Returns a JSON object with all settings.

### `save_settings`
Writes settings to `settings.json`. Called when the user changes any setting.

### `test_microphone`
Records 2 seconds of audio and returns the RMS level (0-100) to indicate microphone is working.

### `test_speaker`
Triggers the frontend to play a test tone via the Web Speech API.

---

## Settings Persistence

Settings are stored in `settings.json` in the Tauri app data directory:

- **Windows:** `%APPDATA%\com.nexus.app\settings.json`
- **macOS:** `~/Library/Application Support/com.nexus.app/settings.json`
- **Linux:** `~/.config/com.nexus.app/settings.json`

### File Format
```json
{
  "autostart": true,
  "minimizeToTray": true,
  "showOrbOnWake": true,
  "language": "en",
  "micInput": "default",
  "speakerOutput": "default",
  "micSensitivity": 0.5,
  "wakeWordEnabled": true,
  "wakeWordSensitivity": 0.7,
  "speakerVerification": true,
  "wakeVariants": ["nexus", "next us"],
  "meetingDetection": true,
  "suppressTtsInMeetings": true,
  "suppressWakeInMeetings": true,
  "dataRetention": "7d",
  "serverUrl": "ws://127.0.0.1:49152/ws",
  "userId": "local-user",
  "deviceId": "local-device"
}
```

---

## File Structure

```
frontend/
├── settings.html                    # HTML entry point
└── src/settings/
    ├── main.tsx                     # React entry (renders SettingsApp)
    ├── SettingsApp.tsx              # Main component (450 lines, 5 tabs)
    └── settings.css                 # White theme styles (405 lines)
```

---

## CSS Styling

The settings window uses the shared design tokens from `frontend/src/theme/tokens.css`:

- White background (`--nx-bg: #FFFFFF`)
- Blue→purple gradient accents (`--nx-accent-grad`)
- 12px border radius (`--nx-radius`)
- Subtle shadows (`--nx-shadow-sm`, `--nx-shadow-lg`)
- Segoe UI font family (`--nx-font`)
- Tab transitions with Framer Motion
- Toggle switches with gradient when active
- Sliders with gradient track

---

## Tray Integration

The system tray menu (`src-tauri/src/tray.rs`) has a "Settings…" item that calls `open_settings_window`:

```rust
TrayMenuItem::Settings => {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = commands::open_settings_window(app);
    });
}
```

Right-click the NEXUS tray icon → "Settings…" → the settings window appears.

---

## How to Access

1. **System tray:** Right-click the NEXUS tray icon → "Settings…"
2. **Setup fallback:** If setup is already complete, the tray "Settings…" item opens settings instead of setup
3. **Programmatic:** Call `invoke("open_settings_window")` from any frontend window
