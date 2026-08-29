# 07 — State-Dependent Hotkey (Sidebar-Aware)

**Branch:** prem224k
**Status:** Implemented and tested
**Date:** 2026-08-29

---

## Problem

The original hotkey always did both actions simultaneously:
1. Dismiss the sidebar (if visible)
2. Wake NEXUS

This meant pressing the hotkey to close the sidebar also woke NEXUS, which
was unintuitive. The user wanted:
- If sidebar is visible → close sidebar only (don't wake)
- If sidebar is hidden → wake NEXUS (don't touch sidebar)

## Implementation (`src-tauri/src/hotkey.rs`)

```rust
app.global_shortcut()
    .on_shortcut(sc, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            // Check if the sidebar is currently visible
            let sidebar_visible = handle
                .get_webview_window("sidebar")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);

            if sidebar_visible {
                // Sidebar is visible → close it only, do NOT wake NEXUS
                tracing::info!("hotkey → sidebar visible, closing sidebar only");
                let _ = handle.emit("sidebar:hide", ());
            } else {
                // Sidebar is hidden → wake NEXUS, do NOT touch sidebar
                tracing::info!("hotkey → sidebar hidden, waking NEXUS");

                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                    let _ = win.set_always_on_top(true);
                    let _ = win.set_ignore_cursor_events(false);
                    let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
                }
            }
        }
    })
```

## User Experience

| State | Hotkey press | Action |
|---|---|---|
| Sidebar visible, NEXUS idle | Press 1 | Close sidebar |
| Sidebar closed, NEXUS idle | Press 2 | Wake NEXUS |
| Sidebar hidden, NEXUS idle | Press 1 | Wake NEXUS |
| NEXUS listening | Press | (handled by frontend barge-in) |

## Merge with prem22k's multi-hotkey

prem22k adds multiple hotkeys for Linux GNOME Wayland compatibility:
- `Ctrl+Shift+Space`
- `Ctrl+Alt+Space`
- `Alt+Space`

The merge combines both features: all three hotkeys are registered, and
each has the state-dependent behavior.

## Files Changed

- `src-tauri/src/hotkey.rs` — State-dependent logic
