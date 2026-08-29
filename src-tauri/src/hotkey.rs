//! Global hotkey (Ctrl/Cmd+Shift+Space) → state-dependent action.
//!
//! On press:
//!   - If the sidebar is visible → close the sidebar only (do NOT wake).
//!   - If the sidebar is hidden → wake the assistant (do NOT touch sidebar).
//!
//! This means:
//!   - Pressing the hotkey twice (with sidebar visible) first closes the
//!     sidebar, then wakes NEXUS on the second press.
//!   - Wake-word activation does NOT close the sidebar (handled separately
//!     in `wakeword_oww.rs`, which never emits `sidebar:hide`).
//!   - The hotkey never does both at once — it's one or the other based on
//!     the current sidebar visibility state.

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
                // Check if the sidebar is currently visible.
                let sidebar_visible = handle
                    .get_webview_window("sidebar")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);

                if sidebar_visible {
                    // Sidebar is visible → close it only, do NOT wake NEXUS.
                    tracing::info!("hotkey ({}) → sidebar visible, closing sidebar only", hk);
                    // Directly hide the native window + reset the CSS class
                    // via JS eval (bypasses the event system which may not
                    // be received by the sidebar window's listen() calls).
                    if let Some(sidebar) = handle.get_webview_window("sidebar") {
                        let _ = sidebar.eval(
                            r#"(function(){var a=document.getElementById('sidebar-app');if(a)a.className='sidebar--hidden';})();"#,
                        );
                        let _ = sidebar.hide();
                    }
                } else {
                    // Sidebar is hidden → wake NEXUS, do NOT touch sidebar.
                    tracing::info!("hotkey ({}) → sidebar hidden, waking NEXUS", hk);

                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = crate::window_manager::configure_non_activating_overlay(&win);
                        let _ = win.set_ignore_cursor_events(false);

                        // Call the frontend toggle handler directly.
                        let _ = win.eval("window.__NEXUS_TOGGLE__ && window.__NEXUS_TOGGLE__()");
                    }
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
