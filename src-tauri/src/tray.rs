//! System tray: show/hide, settings, quit. Keeps the app alive after window hide.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime, WebviewWindow,
};

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), tauri::Error> {
    let show = MenuItem::with_id(app, "show", "Show Assistant", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Ultron", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    let handle = app.clone();
    TrayIconBuilder::with_id("ultron-tray")
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
