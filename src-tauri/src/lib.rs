//! NEXUS — Tauri v2 main process.
//!
//! Wires up: window manager (click-through), global hotkey, autostart, tray,
//! wake-word engine, the WSS network bridge, deep-link (OAuth redirects),
//! and window positioning (bottom-center sidebar).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod window_manager;
mod hotkey;
mod wakeword;
mod network;
mod tray;
mod commands;
mod stt;
mod voice_profile;

use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tracing_subscriber::EnvFilter;

/// Shared app state held across async tasks.
pub struct AppState {
    pub events: tauri::AppHandle,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,nexus=debug")))
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Focus the existing window if a second instance is attempted.
            // Also handle deep-link redirects on Windows/Linux (passed as CLI arg).
            if let Some(url) = args.iter().find(|a| a.starts_with("nexus://")) {
                let _ = app.emit("deep-link://oauth-callback", url.clone());
            }
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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_positioner::init())
        .setup(|app| {
            // macOS: hide from the Dock and Cmd+Tab switcher (accessory/background app).
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Register the nexus:// deep-link scheme (Windows + Linux runtime registration).
            // macOS uses Info.plist CFBundleURLTypes (already configured).
            #[cfg(desktop)]
            {
                let _ = app.deep_link().register("nexus");
            }

            // Autostart on by default.
            let autostart = app.autolaunch();
            let _ = autostart.enable();

            // Tray menu.
            tray::setup(app.handle())?;

            // Window overlay + click-through.
            window_manager::init(app.handle())?;

            // Position the orb at bottom-center, just above the taskbar/dock.
            if let Some(win) = app.get_webview_window("main") {
                use tauri::PhysicalPosition;
                if let Ok(Some(monitor)) = win.current_monitor() {
                    let scale = monitor.scale_factor();
                    let screen = monitor.size();
                    let orb = 200i32; // matches tauri.conf.json
                    let phys_orb = (orb as f64 * scale) as i32;

                    let x = (screen.width as i32 - phys_orb) / 2;
                    // Position relative to the work area (excludes taskbar/dock).
                    // Use the monitor's work area if available, otherwise estimate.
                    // Windows taskbar ~48px, macOS dock ~70px.
                    #[cfg(target_os = "macos")]
                    let taskbar = (70.0 * scale) as i32;
                    #[cfg(not(target_os = "macos"))]
                    let taskbar = (48.0 * scale) as i32;
                    // Small gap above the taskbar/dock
                    let gap = (12.0 * scale) as i32;
                    let y = screen.height as i32 - phys_orb - taskbar - gap;

                    let _ = win.set_position(PhysicalPosition::new(x, y));
                    tracing::info!("orb positioned at ({x}, {y})");
                }
            }

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

            // Listen for deep-link events (macOS emits these; Windows/Linux use single-instance).
            let handle = app.handle().clone();
            let _ = app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let url_str = url.as_str();
                    if url_str.starts_with("nexus://oauth/") {
                        let _ = handle.emit("deep-link://oauth-callback", url_str);
                    }
                }
            });

            // Check if this is first launch (no server URL configured) → show setup.
            let store_path = app.path().app_data_dir().ok();
            let needs_setup = if let Some(dir) = store_path {
                !dir.join("nexus-config.json").exists()
            } else {
                true
            };
            if needs_setup {
                if let Some(setup_win) = app.get_webview_window("setup") {
                    let _ = setup_win.show();
                    let _ = setup_win.set_focus();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_manager::set_click_through,
            window_manager::show_overlay,
            window_manager::hide_overlay,
            network::open_session,
            network::send_transcript,
            network::cancel_session,
            network::close_session,
            commands::open_setup_window,
            commands::close_setup_window,
            commands::save_server_config,
            commands::get_voice_profile_status,
            commands::enroll_voice,
            commands::delete_voice_profile,
            stt::transcribe_audio,
            stt::stt_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NEXUS application");
}
