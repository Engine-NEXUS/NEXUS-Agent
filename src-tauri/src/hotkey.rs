//! Global hotkey (Ctrl/Cmd+Shift+Space) → wakes the assistant AND dismisses the sidebar.
//!
//! On press:
//!   1. Hides the response sidebar (if visible) by emitting "sidebar:hide".
//!   2. Shows the overlay window and calls `window.__NEXUS_WAKE__()` in the
//!      WebView via `eval()`. This is more reliable than the Tauri event system
//!      for repeated rapid events.

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const HOTKEYS: &[&str] = &[
    "CommandOrControl+Shift+Space",
    "CommandOrControl+Alt+Space",
    "Alt+Space",
];

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    for &hk in HOTKEYS {
        let sc: Shortcut = match hk.parse() {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("Failed to parse hotkey '{hk}': {e}");
                continue;
            }
        };

        let handle = app.clone();
        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                tracing::info!("hotkey ({}) → wake", hk);

                let _ = handle.emit("sidebar:hide", ());

                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = crate::window_manager::configure_non_activating_overlay(&win);
                    let _ = win.set_ignore_cursor_events(false);

                    let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
                }
            }
        }) {
            tracing::warn!("Failed to register handler for hotkey '{hk}': {e}");
        } else {
            tracing::info!("Registered global hotkey handler: {hk}");
        }
    }

    Ok(())
}
