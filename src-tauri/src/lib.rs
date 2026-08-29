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
mod stt_server_manager;
mod voice_profile;
mod meeting_detect;
mod mic_permissions;

use tauri::{Emitter, Listener, Manager};
#[cfg(not(target_os = "windows"))]
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tracing_subscriber::EnvFilter;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Shared app state held across async tasks.
pub struct AppState {
    pub events: tauri::AppHandle,
}

// ─── WebView2 stale profile cleanup (Windows) ─────────────────────────────
//
// See the comment in run() for why this is a separate function called
// BEFORE tauri::Builder::default().
#[cfg(target_os = "windows")]
fn cleanup_webview2_profile() {
    // The WebView2 data directory is at %LOCALAPPDATA%\<identifier>\EBWebView.
    // The identifier is "com.nexus.assistant" (from tauri.conf.json).
    let local_appdata = match std::env::var("LOCALAPPDATA") {
        Ok(v) => v,
        Err(_) => return,
    };
    let webview_dir = std::path::PathBuf::from(&local_appdata)
        .join("com.nexus.assistant")
        .join("EBWebView");

    if !webview_dir.exists() {
        return; // Nothing to clean — fresh install or already cleaned.
    }

    // Step 1: Kill orphaned msedgewebview2.exe processes from a PREVIOUS
    // NEXUS instance. These processes reference our EBWebView directory
    // (--user-data-dir=...com.nexus.assistant\EBWebView) and hold file
    // locks that prevent deletion. The CURRENT instance hasn't created
    // any WebView2 processes yet (we're before the Tauri builder), so
    // any such process MUST be an orphan from a previous run.
    //
    // We use `taskkill /F /FI` with a window-title filter won't work, so
    // we use PowerShell to find processes by command-line match and kill
    // them. This is the most reliable approach on Windows.
    let ps_script = r#"
        $target = 'com.nexus.assistant\EBWebView'
        $procs = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
            Where-Object { $_.CommandLine -like "*$target*" }
        if ($procs) {
            $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 500
            Write-Output "KILLED:$($procs.Count)"
        } else {
            Write-Output "NONE"
        }
        "#;

    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();

    // Step 2: Attempt to delete the EBWebView directory. Retry up to 3
    // times with 200ms between attempts — the killed processes may take
    // a moment to release their file handles.
    for attempt in 1..=3u8 {
        match std::fs::remove_dir_all(&webview_dir) {
            Ok(()) => {
                tracing::info!("cleared WebView2 profile (attempt {}): {}", attempt, webview_dir.display());
                return;
            }
            Err(e) if e.raw_os_error() == Some(32) => {
                // os error 32 = sharing violation (files still locked)
                tracing::debug!("WebView2 cleanup attempt {} failed (locked): {}", attempt, e);
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) if e.raw_os_error() == Some(2) => {
                // os error 2 = not found (another thread already deleted it)
                return;
            }
            Err(e) => {
                tracing::warn!("WebView2 cleanup error (attempt {}): {}", attempt, e);
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }

    // Step 3: If deletion still fails (stubborn locks), rename the
    // directory instead. WebView2 will create a fresh one, and the
    // stale rename target can be cleaned up by the OS or a future run.
    let stale_dir = webview_dir.with_extension("stale");
    // Remove any previous stale dir first
    let _ = std::fs::remove_dir_all(&stale_dir);
    match std::fs::rename(&webview_dir, &stale_dir) {
        Ok(()) => {
            tracing::info!(
                "WebView2 profile locked — renamed to stale: {} → {}",
                webview_dir.display(),
                stale_dir.display()
            );
        }
        Err(e) => {
            tracing::error!(
                "WebView2 profile cleanup FAILED — could not delete or rename {}: {e}",
                webview_dir.display()
            );
            tracing::error!(
                "This will likely cause 'localhost refused to connect' on this launch."
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,nexus=debug")))
        .with_target(false)
        .init();

    // ─── WebView2 stale profile cleanup ───────────────────────────────
    //
    // This MUST happen BEFORE tauri::Builder::default() because Tauri
    // creates WebView2 windows (and their child msedgewebview2.exe
    // processes) during builder initialization — BEFORE .setup() runs.
    // If we try to delete EBWebView in .setup(), the current instance's
    // own WebView2 is already holding the directory locked (os error 32).
    //
    // Root cause of "localhost refused to connect":
    //   WebView2 persists session state (Preferences, Sessions, etc.) in
    //   %LOCALAPPDATA%/<identifier>/EBWebView. If a dev build
    //   (localhost:5173) was ever run, the stale dev URL survives in
    //   Preferences and is restored on every subsequent launch — even
    //   release builds — causing ERR_CONNECTION_REFUSED.
    //
    // Fix: delete the entire EBWebView directory before Tauri starts so
    // WebView2 creates a fresh profile with the bundled frontend.
    // Also kill any orphaned msedgewebview2.exe processes from a previous
    // NEXUS instance that may still hold the directory locked.
    #[cfg(target_os = "windows")]
    cleanup_webview2_profile();

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

            // WebView2 profile cleanup is done BEFORE tauri::Builder::default()
            // in run() — see cleanup_webview2_profile() above. Doing it here
            // in .setup() is too late: Tauri has already created WebView2
            // windows and their child processes hold the EBWebView directory
            // locked (os error 32).

            // Register the nexus:// deep-link scheme (Windows + Linux runtime registration).
            // macOS uses Info.plist CFBundleURLTypes (already configured).
            #[cfg(desktop)]
            {
                let _ = app.deep_link().register("nexus");
            }

            // ─── Autostart: Windows Scheduled Task (zero-delay) ───────────
            //
            // On Windows, we use a Scheduled Task with "At log on" trigger
            // instead of the HKCU\...\Run registry key. This launches NEXUS
            // IMMEDIATELY when the user logs on — no 10-30s desktop-settle
            // delay. This is the same technique Discord, Steam, and other
            // startup-optimized apps use.
            //
            // We use PowerShell's Register-ScheduledTask cmdlet instead of
            // schtasks.exe because schtasks.exe requires admin privileges
            // for /rl highest, while Register-ScheduledTask works for the
            // current user without elevation.
            //
            // On macOS/Linux, we keep tauri-plugin-autostart (LaunchAgent /
            // systemd user units are already zero-delay on those platforms).
            #[cfg(target_os = "windows")]
            {
                let exe_path = std::env::current_exe()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();

                if !exe_path.is_empty() {
                    // Remove old HKCU\Run entry (from the previous autostart plugin)
                    // to avoid double-launching.
                    let _ = std::process::Command::new("reg")
                        .args(["delete", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                               "/v", "NEXUS", "/f"])
                        .creation_flags(0x08000000) // CREATE_NO_WINDOW
                        .status();

                    // Create/update the scheduled task via PowerShell.
                    // Register-ScheduledTask is idempotent with -Force and
                    // doesn't require admin privileges when -User is specified.
                    // We pass the current user's identity to both the trigger
                    // and the registration to avoid "Access is denied" errors.
                    let ps_script = format!(
                        r#"$exe = '{}';
                        $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name;
                        $action = New-ScheduledTaskAction -Execute $exe;
                        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user;
                        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0);
                        $result = Register-ScheduledTask -TaskName 'NEXUS' -Action $action -Trigger $trigger -Settings $settings -User $user -Force;
                        if ($result) {{ Write-Output 'NEXUS_TASK_OK' }} else {{ Write-Output 'NEXUS_TASK_FAIL' }}"#,
                        exe_path
                    );

                    let result = std::process::Command::new("powershell")
                        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                        .creation_flags(0x08000000) // CREATE_NO_WINDOW
                        .output();

                    match result {
                        Ok(out) if out.status.success()
                            && String::from_utf8_lossy(&out.stdout).contains("NEXUS_TASK_OK") =>
                        {
                            tracing::info!(
                                "autostart: scheduled task 'NEXUS' created (AtLogOn, zero-delay)"
                            );
                        }
                        Ok(out) => {
                            tracing::warn!(
                                "autostart: Register-ScheduledTask failed: stdout={} stderr={}",
                                String::from_utf8_lossy(&out.stdout).trim(),
                                String::from_utf8_lossy(&out.stderr).trim()
                            );
                        }
                        Err(e) => {
                            tracing::warn!("autostart: failed to run PowerShell: {e}");
                        }
                    }
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                // macOS/Linux: use tauri-plugin-autostart (LaunchAgent / systemd)
                let autostart = app.autolaunch();
                let _ = autostart.enable();
            }

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

            // Sleep/wake detection via time-jump monitoring.
            // thread::sleep uses the monotonic clock (stops while the system is
            // asleep); SystemTime is the wall clock (jumps forward across sleep).
            // A gap much larger than the sleep interval means the machine just
            // resumed from sleep/hibernate.
            //
            // Note: This no longer triggers a greeting. Greeting is now
            // "first interaction of the day" — handled when the user wakes
            // NEXUS via `should_greet_today` / `mark_greeted_today` IPC.
            // The sleep-wake watcher remains for future use (e.g. re-init
            // audio device after sleep, refresh app registry, etc.).
            {
                let _state = meeting_state.clone();
                std::thread::Builder::new()
                    .name("sleep-wake-watch".into())
                    .spawn(move || loop {
                        let before = std::time::SystemTime::now();
                        std::thread::sleep(std::time::Duration::from_secs(10));
                        let gap = std::time::SystemTime::now()
                            .duration_since(before)
                            .unwrap_or_default();
                        if gap > std::time::Duration::from_secs(60) {
                            tracing::info!("system resumed from sleep (gap {gap:?})");
                        }
                    })
                    .ok();
            }

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

            // ─── Sidebar vibrancy — applied at STARTUP in setup hook ──────
            //
            // CRITICAL: window-vibrancy MUST be applied here (setup hook),
            // NOT inside the show_sidebar IPC command. The DWM acrylic/Mica
            // effect is registered against the window's HWND at creation time.
            // If applied later (to a hidden then re-shown window), DWM may
            // silently discard the attribute change because the window hasn't
            // participated in a composition pass yet.
            //
            // The sidebar window is created at startup with visible:false —
            // the HWND exists immediately, so we can register the effect now.
            // It will be active the first time the window is shown.
            #[cfg(target_os = "windows")]
            if let Some(sidebar) = app.get_webview_window("sidebar") {
                use window_vibrancy::apply_blur;
                // Use white color with 35% alpha (90/255) to tell DWM to composition
                // the blur correctly, avoiding the solid pitch black background bug
                // that occurs with 0 alpha.
                if let Err(e) = apply_blur(&sidebar, Some((255, 255, 255, 90))) {
                    tracing::warn!("sidebar: apply_blur failed: {e:?}");
                } else {
                    tracing::info!("sidebar: DWM blur registered on HWND at startup");
                }
            }
            #[cfg(target_os = "macos")]
            if let Some(sidebar) = app.get_webview_window("sidebar") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                let _ = apply_vibrancy(
                    &sidebar,
                    NSVisualEffectMaterial::HudWindow,
                    None,
                    Some(20.0),
                );
            }

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

            // Wake-word engine — runs on a DEDICATED OS THREAD, not tokio.
            // tract-onnx model optimization is CPU-heavy blocking work that
            // can take 30-120s on a cold boot. Running it on tokio's async
            // runtime (which is single-threaded in NEXUS) would block ALL
            // other async tasks (meeting detection, network bridge, sidecar
            // health check) for the entire duration.
            //
            // The hotkey still works immediately (registered above) — the
            // user can press Ctrl+Shift+Space while the wake engine loads.
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("wake-engine".into())
                .spawn(move || {
                    if let Err(e) = wakeword::run(handle) {
                        tracing::error!("wake-word engine stopped: {e}");
                    }
                })
                .ok();

            // Network bridge (HTTP) sends transcripts to the Cloudflare Worker.
            // No sidecar, no server, no WebSocket — fully serverless.
            // The Worker URL is baked into the installer via NEXUS_SERVER_URL.

            // STT server (faster-whisper on port 39217) transcribes audio locally.
            // Without it, no commands can be executed — every transcript is empty.
            // Auto-spawn it in a BACKGROUND THREAD — model loading takes 10-20s on CPU
            // and must not block app startup. The first transcription will wait for it.
            std::thread::spawn(stt_server_manager::init);

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

            // Check if this is first launch (no config file yet).
            // Auto-generate a unique user ID and device ID (UUID v4) and use
            // the server URL baked into the installer. The user never has to
            // manually enter these — they're system-generated.
            //
            // The server URL is determined at build time:
            //   - Default: ws://127.0.0.1:41098/ws (local dev / same-machine sidecar)
            //   - Installer override: set NEXUS_SERVER_URL env var before building
            //     the installer to bake in the user's remote server URL.
            let store_path = app.path().app_data_dir().ok();
            if let Some(dir) = store_path {
                let config_path = dir.join("nexus-config.json");
                if !config_path.exists() {
                    let user_id = format!("user_{}", uuid::Uuid::new_v4().simple());
                    let device_id = format!("device_{}", uuid::Uuid::new_v4().simple());
                    let server_url = option_env!("NEXUS_SERVER_URL")
                        .unwrap_or("https://nexus-worker.example.workers.dev");
                    let default_config = serde_json::json!({
                        "serverUrl": server_url,
                        "userId": user_id,
                        "deviceId": device_id,
                    });
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(&config_path, default_config.to_string());
                    tracing::info!(
                        "auto-created config at {:?} — user={}, device={}, server={}",
                        config_path, user_id, device_id, server_url
                    );
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
            commands::should_greet_today,
            commands::mark_greeted_today,
            commands::open_settings_window,
            commands::close_settings_window,
            commands::get_settings,
            commands::save_settings,
            commands::clear_transcript,
            commands::refresh_app_registry,
            commands::show_sidebar,
            commands::hide_sidebar,
            stt::transcribe_audio,
            stt::stt_status,
            command_executor::execute_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NEXUS application");
}
