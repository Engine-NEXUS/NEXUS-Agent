//! Global hotkey (Ctrl/Cmd+Space) → state-dependent action.
//!
//! On press:
//!   - If the sidebar is visible → close the sidebar only (do NOT wake).
//!   - If the sidebar is hidden → wake the assistant (do NOT touch sidebar).
//!   - If the assistant is speaking → barge-in: the frontend wake handler
//!     stops TTS and starts listening (handled in main.tsx startListening).
//!
//! This means:
//!   - Pressing the hotkey twice (with sidebar visible) first closes the
//!     sidebar, then wakes NEXUS on the second press.
//!   - Wake-word activation does NOT close the sidebar (handled separately
//!     in `wakeword_oww.rs`, which never emits `sidebar:hide`).
//!   - The hotkey never does both at once — it's one or the other based on
//!     the current sidebar visibility state.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const HOTKEYS: &[&str] = &[
    "CommandOrControl+Space",
    "CommandOrControl+Alt+Space",
    // NOTE: "Alt+Space" was removed — it conflicts with the Windows system
    // menu shortcut (Restore/Move/Size/Minimize/Maximize/Close). Registering
    // it as a global hotkey intercepts ALL Alt+Space events system-wide,
    // which caused WhatsApp (and other apps) to glitch — windows would
    // flash open/close because the system menu event was being swallowed.
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
                    // Destroy the sidebar window to free ~250 MB of WebView2 processes.
                    let _ = crate::dyn_windows::destroy_window(&handle, "sidebar");
                } else {
                    // Sidebar is hidden → wake NEXUS, do NOT touch sidebar.
                    tracing::info!("hotkey ({}) → sidebar hidden, waking NEXUS", hk);

                    // Ensure the STT server is running — but DON'T block the hotkey
                    // handler on this. The STT server only needs to be ready by the
                    // time the user finishes speaking (several seconds from now).
                    // Spawning in a background thread saves 2-4s of hotkey latency
                    // (is_stt_responsive() has a 2s TCP timeout when STT isn't running).
                    std::thread::spawn(|| {
                        crate::lazy_stt::ensure_stt_running();
                    });

                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = crate::window_manager::configure_non_activating_overlay(&win);
                        let _ = win.set_ignore_cursor_events(false);

                        // Call the frontend wake handler directly.
                        let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
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
