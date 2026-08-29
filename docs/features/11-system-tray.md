# Feature: System Tray & Manual Controls

> The system tray icon keeps NEXUS alive after the window hides, and provides manual controls: show, pause/resume, settings, quit.

**Source files:**
- `src-tauri/src/tray.rs` — tray menu + event handlers
- `src-tauri/src/lib.rs` — `tray::setup(app.handle())` call

---

## Tray Menu

```
┌─────────────────────┐
│ Show Assistant      │
├─────────────────────┤
│ Pause NEXUS         │  ← toggles to "Resume NEXUS"
├─────────────────────┤
│ Settings…           │
│ Quit NEXUS          │
└─────────────────────┘
```

## Menu Actions

### Show Assistant
- Shows the main window.
- Sets `ignore_cursor_events(false)` — orb becomes interactive.
- Emits `assistant:wake` event → frontend starts listening.

### Pause NEXUS / Resume NEXUS
- Toggles `MeetingState.manual_pause`.
- Updates the menu item label ("Pause NEXUS" ↔ "Resume NEXUS").
- Emits `meeting:paused` or `meeting:resumed` event.
- When paused:
  - Wake word detection is suppressed.
  - Tier 3 commands are suppressed.
  - TTS is **NOT** suppressed (user might want to hear responses).
  - Hotkey still works (explicit user action).

### Settings…
- Shows the setup window (`setup` label).
- The setup window contains: server URL, OAuth connections, API keys, voice enrollment.

### Quit NEXUS
- `app.exit(0)` — clean shutdown.
- The sidecar is **not killed** (left running for instant restart).

## Tray Icon Click (Left)

Left-clicking the tray icon:
- Shows the main window.
- Emits `assistant:wake` event → frontend starts listening.

This is a shortcut for "Show Assistant" without opening the menu.

## Why a Tray?

Without a tray icon, closing the window would exit the app. NEXUS needs to:
- Stay alive in the background (wake word always listening).
- Hide the window when idle (transparent overlay shouldn't block clicks).
- Provide a way to access settings and quit.

The tray icon solves all three: the window can hide/show freely, and the tray provides persistent controls.

## Autostart

NEXUS registers itself for autostart on first launch:
- **Windows:** registry entry (`HKCU\...\Run`).
- **macOS:** LaunchAgent plist.
- **Linux:** `.desktop` file in `~/.config/autostart/`.

This is handled by `tauri-plugin-autostart`. The user can disable it via OS settings if desired.

## Single Instance

`tauri-plugin-single-instance` prevents duplicate launches:
- If a second `nexus.exe` starts, it's detected.
- The existing window is focused.
- Deep-link args (OAuth redirects on Windows/Linux) are forwarded to the existing instance.
- The second instance exits.
