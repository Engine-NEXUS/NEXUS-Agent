//! System tray: show/hide, pause/resume, settings, quit.
//! Keeps the app alive after window hide.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, MenuItemKind},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime, WebviewWindow,
};

use crate::meeting_detect::MeetingState;

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), tauri::Error> {
    let show = MenuItem::with_id(app, "show", "Show Assistant", true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let pause = MenuItem::with_id(app, "pause", "Pause NEXUS", true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NEXUS", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[
        &show,
        &separator1,
        &pause,
        &separator2,
        &settings,
        &quit,
    ])?;

    let handle = app.clone();
    TrayIconBuilder::with_id("NEXUS-tray")
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, id| match id.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_ignore_cursor_events(false);
                    let _ = app.emit("assistant:wake", ());
                }
            }
            "pause" => {
                // Toggle manual pause via meeting state
                if let Some(state) = app.try_state::<std::sync::Arc<MeetingState>>() {
                    let now_paused = state.toggle_pause();
                    // Update menu item label
                    let new_label = if now_paused {
                        "Resume NEXUS"
                    } else {
                        "Pause NEXUS"
                    };
                    if let Some(item) = app.menu().and_then(|m| m.get("pause")) {
                        if let MenuItemKind::MenuItem(mi) = item {
                            let _ = mi.set_text(new_label);
                        }
                    }
                    if now_paused {
                        tracing::info!("tray: NEXUS paused (manual)");
                        let _ = app.emit("meeting:paused", ());
                    } else {
                        tracing::info!("tray: NEXUS resumed (manual)");
                        let _ = app.emit("meeting:resumed", ());
                    }
                }
            }
            "settings" => {
                if let Some(w) = app.get_webview_window("setup") {
                    let _ = w.show();
                    let _ = w.set_focus();
                } else {
                    let _ = app.emit("assistant:settings", ());
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = app.emit("assistant:wake", ());
                }
            }
        })
        .build(app)?;

    // Keep a reference so the compiler knows `handle` is used for future extension.
    let _ = handle;
    Ok(())
}

// re-export Emitter for menu closures
use tauri::Emitter;

#[allow(dead_code)]
fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("main")
}
