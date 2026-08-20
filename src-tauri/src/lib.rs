//! NEXUS — Tauri v2 main process.
//!
//! Wires up: window manager (click-through), global hotkey, autostart, tray,
//! wake-word engine, the WSS network bridge, deep-link (OAuth redirects),
//! and window positioning (bottom-center sidebar).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod window_manager;
mod hotkey;
#[cfg(feature = "wakeword-oww")]
mod wakeword_oww;
#[cfg(feature = "wakeword-oww")]
mod wakeword {
    pub use crate::wakeword_oww::*;
}
#[cfg(not(feature = "wakeword-oww"))]
mod wakeword;
mod network;
mod tray;
mod commands;
mod command_executor;
mod app_registry;
mod stt;
mod voice_profile;
mod meeting_detect;
mod sidecar_manager;
mod mic_permissions;

use tauri::{Emitter, Listener, Manager};
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

            // Clear WebView2 HTTP cache on startup to prevent stale JS files
            // from being served after code changes (dev mode).
            // The cache is at: %LOCALAPPDATA%/<identifier>/EBWebView/Default/Cache
            #[cfg(target_os = "windows")]
            {
                if let Ok(data_dir) = app.path().app_data_dir() {
                    let cache_dir = data_dir.join("EBWebView").join("Default").join("Cache");
                    if cache_dir.exists() {
                        let _ = std::fs::remove_dir_all(&cache_dir);
                        tracing::debug!("cleared WebView2 cache: {}", cache_dir.display());
                    }
                    let code_cache = data_dir.join("EBWebView").join("Default").join("Code Cache");
                    if code_cache.exists() {
                        let _ = std::fs::remove_dir_all(&code_cache);
                    }
                }
            }

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

            // ─── Meeting / privacy mode state ──────────────────────────
            // Shared atomic state — read by the audio callback on every chunk,
            // written by the meeting detection loop, tray menu, and frontend events.
            let meeting_state = std::sync::Arc::new(meeting_detect::MeetingState::new());
            app.manage(meeting_state.clone());

            // Wire the meeting state into the wake engine so the audio callback
            // can check `should_suppress_wake()` on every chunk.
            #[cfg(feature = "wakeword-oww")]
            wakeword_oww::set_meeting_state(meeting_state.clone());

            // Spawn the meeting detection polling loop (WASAPI on Windows,
            // process-name detection on macOS/Linux).
            let state_for_loop = meeting_state.clone();
            tauri::async_runtime::spawn(async move {
                meeting_detect::run_detection_loop(state_for_loop).await;
            });

            // Listen for TTS events from the frontend.
            // When NEXUS starts speaking, suppress wake detection to prevent
            // self-triggering (NEXUS hears its own TTS voice).
            // When TTS ends, resume after a short grace period.
            {
                let state_for_tts = meeting_state.clone();
                let app_for_tts = app.handle().clone();
                app.handle().listen("tts-started", move |_event| {
                    state_for_tts.set_tts_playing(true);
                    tracing::debug!("meeting: TTS started — suppressing wake detection");
                });

                let state_for_tts_end = meeting_state.clone();
                app.handle().listen("tts-ended", move |_event| {
                    // Don't immediately resume — wait 500ms for audio to settle
                    let state = state_for_tts_end.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        state.set_tts_playing(false);
                        tracing::debug!("meeting: TTS ended — resuming wake detection");
                    });
                    let _ = app_for_tts;
                });
            }

            // Window overlay + click-through.
            window_manager::init(app.handle())?;

            // WebView2 permission handler — auto-approves mic/camera for our
            // own app origins so the permission dialog never re-appears.
            mic_permissions::init(app);

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

            // Pre-index installed apps for instant launch (background thread).
            app_registry::init();

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
            // The sidecar (Python FastAPI on port 49152) must be running for this to work.
            // Auto-spawn it if not already running.
            sidecar_manager::init();

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

            // Check if this is first launch (no server URL configured).
            // Instead of showing the setup window (which confuses users into
            // thinking there's a connection error), auto-create the config
            // with sensible defaults. The setup window can be opened later
            // via the tray menu "Settings…" if the user wants to change anything.
            let store_path = app.path().app_data_dir().ok();
            if let Some(dir) = store_path {
                let config_path = dir.join("nexus-config.json");
                if !config_path.exists() {
                    let default_config = serde_json::json!({
                        "serverUrl": "ws://127.0.0.1:49152/ws",
                        "userId": "local-user",
                        "deviceId": "local-device",
                    });
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(&config_path, default_config.to_string());
                    tracing::info!("auto-created default config at {:?}", config_path);
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
            commands::get_server_config,
            commands::get_voice_profile_status,
            commands::enroll_voice,
            commands::delete_voice_profile,
            commands::meeting_active,
            commands::is_nexus_paused,
            commands::meeting_status,
            commands::set_meeting_detection,
            stt::transcribe_audio,
            stt::stt_status,
            command_executor::execute_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NEXUS application");
}
