//! Global hotkey (Ctrl/Cmd+Shift+Space) → wakes the assistant.
//!
//! On press: shows the overlay window and calls `window.__NEXUS_WAKE__()` in the
//! WebView via `eval()`. This is more reliable than the Tauri event system for
//! repeated rapid events.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const HOTKEY: &str = "CommandOrControl+Shift+Space";

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let sc: Shortcut = HOTKEY
        .parse()
        .map_err(|e| format!("invalid hotkey: {e}"))?;

    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(sc, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                tracing::info!("hotkey → wake");

                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                    let _ = win.set_always_on_top(true);
                    let _ = win.set_ignore_cursor_events(false);

                    // Call the frontend wake handler directly.
                    let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
                }
            }
        })
        .map_err(|e| format!("on_shortcut: {e}"))?;
    Ok(())
}
