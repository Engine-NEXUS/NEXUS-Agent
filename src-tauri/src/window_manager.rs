//! Window management: transparent frameless always-on-top overlay with region-aware click-through.
//!
//! `set_ignore_cursor_events(true)` makes the *whole* window pass-through. We toggle it
//! from the frontend based on whether the pointer is currently over an opaque (avatar) region.

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const WIN: &str = "main";

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let win = app
        .get_webview_window(WIN)
        .ok_or_else(|| "main window not found".to_string())?;

    // Highest z-index, always on top of every app.
    win.set_always_on_top(true).map_err(|e| e.to_string())?;
    // Do not grab focus from the currently active application.
    win.set_focus().ok();
    // Start ignoring cursor events globally; the frontend flips this per pointer move.
    win.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    Ok(())
}

/// IPC: `invoke('set_click_through', { ignore: bool })`.
/// The frontend calls this on `pointermove` when crossing the avatar boundary.
#[tauri::command]
pub fn set_click_through<R: Runtime>(
    app: AppHandle<R>,
    ignore: bool,
) -> Result<(), String> {
    let win = app
        .get_webview_window(WIN)
        .ok_or_else(|| "main window not found".to_string())?;
    win.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())?;
    // When click-through is OFF (interacting with avatar) ensure we stay on top + focusable.
    if !ignore {
        let _ = win.set_always_on_top(true);
    }
    Ok(())
}

/// Convenience: re-apply overlay state (called after show).
#[allow(dead_code)]
pub fn refresh_overlay<R: Runtime>(win: &WebviewWindow<R>) -> Result<(), String> {
    win.set_always_on_top(true).map_err(|e| e.to_string())?;
    win.set_ignore_cursor_events(true).map_err(|e| e.to_string())
}
