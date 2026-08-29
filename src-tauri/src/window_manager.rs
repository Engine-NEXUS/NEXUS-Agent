//! Window management: transparent frameless always-on-top overlay with click-through control.
//!
//! The overlay starts hidden and click-through. On wake, Rust shows the window and
//! disables click-through. When the assistant goes idle, the frontend re-enables
//! click-through and eventually hides the window.

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

const WIN: &str = "main";

/// Position the orb at bottom-center, just above the taskbar/dock/panel.
pub fn position_orb<R: Runtime>(win: &WebviewWindow<R>) -> Result<(), String> {
    use tauri::PhysicalPosition;
    if let Ok(Some(monitor)) = win.current_monitor() {
        let scale = monitor.scale_factor();
        let screen = monitor.size();
        let orb = 200i32; // matches tauri.conf.json
        let phys_orb = (orb as f64 * scale) as i32;

        let x = (screen.width as i32 - phys_orb) / 2;
        #[cfg(target_os = "macos")]
        let dock_offset = (70.0 * scale) as i32;
        #[cfg(target_os = "windows")]
        let dock_offset = (48.0 * scale) as i32;
        #[cfg(target_os = "linux")]
        let dock_offset = (36.0 * scale) as i32;

        let gap = (12.0 * scale) as i32;
        let y = screen.height as i32 - phys_orb - dock_offset - gap;

        let _ = win.set_position(PhysicalPosition::new(x, y));
        tracing::debug!("orb positioned at ({x}, {y}) [scale={scale}]");
    }
    Ok(())
}

/// Configure window as a non-activating floating overlay (does not steal keyboard focus from active apps)
pub fn configure_non_activating_overlay<R: Runtime>(win: &WebviewWindow<R>) -> Result<(), String> {
    let _ = position_orb(win);
    win.set_always_on_top(true).map_err(|e| e.to_string())?;
    let _ = win.set_focusable(false);
    Ok(())
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let win = app
        .get_webview_window(WIN)
        .ok_or_else(|| "main window not found".to_string())?;

    configure_non_activating_overlay(&win)?;
    // Start with click-through OFF so the user can interact with the window.
    win.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
    Ok(())
}

/// IPC: `invoke('set_click_through', { ignore: bool })`.
#[tauri::command]
pub fn set_click_through<R: Runtime>(
    app: AppHandle<R>,
    ignore: bool,
) -> Result<(), String> {
    let win = app
        .get_webview_window(WIN)
        .ok_or_else(|| "main window not found".to_string())?;
    win.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())?;
    if !ignore {
        let _ = win.set_always_on_top(true);
    }
    Ok(())
}

/// Convenience: re-apply overlay state (called after show).
#[allow(dead_code)]
pub fn refresh_overlay<R: Runtime>(win: &WebviewWindow<R>) -> Result<(), String> {
    let _ = position_orb(win);
    win.set_always_on_top(true).map_err(|e| e.to_string())?;
    win.set_ignore_cursor_events(true).map_err(|e| e.to_string())
}

/// IPC: `invoke('show_overlay')`.
/// Shows the native overlay window. Used by the frontend when `visible` becomes true.
/// CSS opacity/transform alone can't reliably hide WebView2 transparent windows after
/// content has been rendered (GPU compositing caches the last frame), so we use
/// native show/hide for reliable visibility control.
#[tauri::command]
pub fn show_overlay<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let win = app
        .get_webview_window(WIN)
        .ok_or_else(|| "main window not found".to_string())?;
    win.show().map_err(|e| e.to_string())?;
    configure_non_activating_overlay(&win)?;
    win.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
    Ok(())
}

/// IPC: `invoke('hide_overlay')`.
/// Hides the native overlay window. Used by the frontend when `visible` becomes false.
#[tauri::command]
pub fn hide_overlay<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let win = app
        .get_webview_window(WIN)
        .ok_or_else(|| "main window not found".to_string())?;
    win.hide().map_err(|e| e.to_string())?;
    Ok(())
}
