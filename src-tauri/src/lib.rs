//! Ultron — Tauri v2 main process.
//!
//! Wires up: window manager (click-through), global hotkey, autostart, tray,
//! wake-word engine, and the WSS network bridge that proxies server events to the frontend.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod window_manager;
mod hotkey;
mod wakeword;
mod network;
mod tray;

use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;
use tracing_subscriber::EnvFilter;

/// Shared app state held across async tasks.
pub struct AppState {
    pub events: tauri::AppHandle,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,ultron=debug")))
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window if a second instance is attempted.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // macOS: hide from the Dock and Cmd+Tab switcher (accessory/background app).
            // LSUIElement in Info.plist handles this when launched via Finder, but
            // set_activation_policy is the reliable runtime approach and covers dev mode.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Autostart on by default.
            let autostart = app.autolaunch();
            let _ = autostart.enable();

            // Tray menu.
            tray::setup(app.handle())?;

            // Window overlay + click-through.
            window_manager::init(app.handle())?;

            // Global hotkey → wake event.
            hotkey::init(app.handle())?;

            // Wake-word engine (native Porcupine or mock).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = wakeword::run(handle).await {
                    tracing::error!("wake-word engine stopped: {e}");
                }
            });

            // Network bridge (WSS) listens for server events and forwards to frontend.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = network::run(handle).await {
                    tracing::error!("network bridge stopped: {e}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_manager::set_click_through,
            network::open_session,
            network::send_audio_chunk,
            network::end_audio,
            network::cancel_session,
            network::close_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ultron application");
}
