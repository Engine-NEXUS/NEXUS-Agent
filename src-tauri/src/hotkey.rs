//! Global hotkey (Ctrl/Cmd+Shift+Space) → wakes the assistant AND dismisses the sidebar.
//!
//! On press:
//!   1. Hides the response sidebar (if visible) by emitting "sidebar:hide".
//!   2. Shows the overlay window and calls `window.__NEXUS_WAKE__()` in the
//!      WebView via `eval()`. This is more reliable than the Tauri event system
//!      for repeated rapid events.

use tauri::{AppHandle, Emitter, Manager, Runtime};
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
                tracing::info!("hotkey → wake (sidebar dismissed if visible)");

                // Dismiss the response sidebar — the user is starting a new
                // interaction, so the previous response is no longer needed.
                // The sidebar window listens for this event and slides out.
                let _ = handle.emit("sidebar:hide", ());

                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = crate::window_manager::configure_non_activating_overlay(&win);
                    let _ = win.set_ignore_cursor_events(false);

                    // Call the frontend wake handler directly.
                    let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
                }
            }
        })
        .map_err(|e| format!("on_shortcut: {e}"))?;

    if let Err(e) = app.global_shortcut().register(sc) {
        tracing::warn!("Failed to register global hotkey '{}': {e}", HOTKEY);
    } else {
        tracing::info!("Registered global hotkey: {}", HOTKEY);
    }

    Ok(())
}
