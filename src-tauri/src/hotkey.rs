//! Global hotkey fallback (Ctrl/Cmd+Shift+Space) → emits `assistant:wake` to the frontend.
//!
//! Uses `tauri-plugin-global-shortcut`. The shortcut is also declared in `tauri.conf.json`
//! for capability wiring, but we register it here so we can attach a handler.
//!
//! NOTE: `on_shortcut` both registers AND attaches the handler in one call. Calling
//! `register()` separately first would double-register and fail. We use `on_shortcut` only.

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
                tracing::info!("global hotkey pressed → wake");
                // Bring window forward so the user sees the Listening state.
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_always_on_top(true);
                    let _ = win.set_ignore_cursor_events(false);
                }
                let _ = handle.emit("assistant:wake", ());
            }
        })
        .map_err(|e| format!("on_shortcut: {e}"))?;
    Ok(())
}
