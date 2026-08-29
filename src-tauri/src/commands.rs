//! IPC commands for setup window management and configuration.

use std::path::{Path, PathBuf};
use tauri::{Manager, Runtime};
#[cfg(feature = "wakeword-sherpa")]
use crate::voice_profile;
use crate::app_registry;

/// IPC: open the setup window (called from tray menu "Settings…" or first launch).
#[tauri::command]
pub fn open_setup_window<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let win = app.get_webview_window("setup")
        .ok_or_else(|| "setup window not found".to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// IPC: close/hide the setup window and activate the main assistant orb.
#[tauri::command]
pub fn close_setup_window<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("setup") {
        let _ = win.hide();
    }
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = crate::window_manager::configure_non_activating_overlay(&main_win);
        let _ = main_win.set_ignore_cursor_events(false);
        let _ = main_win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
    }
    Ok(())
}

/// IPC: save the server URL config (marks setup as complete).
/// Writes a JSON file to the app data dir so the app knows setup is done.
#[tauri::command]
pub fn save_server_config<R: Runtime>(
    app: tauri::AppHandle<R>,
    server_url: String,
    user_id: String,
    device_id: String,
) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config_path = dir.join("nexus-config.json");
    let config = serde_json::json!({
        "serverUrl": server_url,
        "userId": user_id,
        "deviceId": device_id,
    });
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, config.to_string()).map_err(|e| e.to_string())?;
    tracing::info!("server config saved to {:?}", config_path);
    Ok(())
}

/// Serialized server config returned by `get_server_config`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ServerConfig {
    pub server_url: String,
    pub user_id: String,
    pub device_id: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            server_url: option_env!("NEXUS_SERVER_URL")
                .unwrap_or("https://nexus-worker.example.workers.dev")
                .to_string(),
            user_id: String::new(),
            device_id: String::new(),
        }
    }
}

/// IPC: Get the saved server config (or defaults if not yet configured).
/// The frontend calls this at startup to get the Worker URL, user ID,
/// and device ID — instead of relying on build-time env vars.
#[tauri::command]
pub fn get_server_config<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<ServerConfig, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config_path = dir.join("nexus-config.json");
    if !config_path.exists() {
        return Ok(ServerConfig::default());
    }
    let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(ServerConfig {
        server_url: json["serverUrl"].as_str()
            .unwrap_or(option_env!("NEXUS_SERVER_URL").unwrap_or("ws://127.0.0.1:41098/ws"))
            .to_string(),
        user_id: json["userId"].as_str().unwrap_or("").to_string(),
        device_id: json["deviceId"].as_str().unwrap_or("").to_string(),
    })
}

// ─── Voice profile commands — only available when wakeword-sherpa is enabled ─
// Speaker enrollment uses sherpa-onnx for embedding extraction. When using the
// default wakeword-oww engine, verification is not yet wired (see AGENTS.md),
// so these commands are compiled out to avoid pulling in sherpa-onnx C++ deps.
#[cfg(feature = "wakeword-sherpa")]
pub use voice_profile_commands::*;
#[cfg(feature = "wakeword-sherpa")]
mod voice_profile_commands {
    use super::*;

    /// IPC: Get the current voice profile status (enrolled or not, number of clips, threshold).
    #[tauri::command]
    pub fn get_voice_profile_status<R: Runtime>(
        app: tauri::AppHandle<R>,
    ) -> Result<voice_profile::VoiceProfileStatus, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let profile_path = voice_profile::resolve_profile_path(&dir);

        let sound_alikes: Vec<String> = voice_profile::SOUND_ALIKES
            .iter()
            .map(|s| s.to_string())
            .collect();

        if !profile_path.exists() {
            return Ok(voice_profile::VoiceProfileStatus {
                enrolled: false,
                num_clips: 0,
                threshold: voice_profile::DEFAULT_THRESHOLD,
                created_at: 0,
                updated_at: 0,
                wake_variants: vec!["nexus".to_string()],
                sound_alikes,
            });
        }

        let profile = voice_profile::VoiceProfile::load(&profile_path)
            .map_err(|e| e.to_string())?;
        Ok(voice_profile::VoiceProfileStatus {
            enrolled: true,
            num_clips: profile.num_clips,
            threshold: profile.threshold,
            created_at: profile.created_at,
            updated_at: profile.updated_at,
            wake_variants: profile.wake_variants,
            sound_alikes,
        })
    }

    /// Resolve the sherpa resource directory (handles dev + production paths).
    pub fn resolve_sherpa_dir(resource_dir: &Path) -> Option<PathBuf> {
        let sherpa = resource_dir.join("sherpa");
        if sherpa.exists() {
            return Some(sherpa);
        }
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let dev = PathBuf::from(manifest).join("resources").join("sherpa");
            if dev.exists() {
                return Some(dev);
            }
        }
        // Fallback: exe_dir/../resources/sherpa
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let p = parent.join("../resources/sherpa");
                if p.exists() {
                    return Some(p);
                }
            }
        }
        None
    }

    /// Run ASR on enrollment clips to capture wake-word variants.
    /// Returns the list of ASR transcripts (one per clip, may be empty/garbage).
    pub fn transcribe_enrollment_clips(
        sherpa_dir: &Path,
        clips: &[Vec<f32>],
    ) -> Result<Vec<String>, String> {
        use sherpa_onnx::{
            OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineTransducerModelConfig,
        };

        let kws_dir = sherpa_dir.join("kws");

        // Prefer int8 (quantized) models, fall back to fp32
        let encoder = kws_dir.join("encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
        let encoder = if encoder.exists() { encoder } else { kws_dir.join("encoder-epoch-12-avg-2-chunk-16-left-64.onnx") };
        let decoder = kws_dir.join("decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
        let decoder = if decoder.exists() { decoder } else { kws_dir.join("decoder-epoch-12-avg-2-chunk-16-left-64.onnx") };
        let joiner = kws_dir.join("joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
        let joiner = if joiner.exists() { joiner } else { kws_dir.join("joiner-epoch-12-avg-2-chunk-16-left-64.onnx") };
        let tokens = kws_dir.join("tokens.txt");

        for (name, path) in [
            ("encoder", &encoder),
            ("decoder", &decoder),
            ("joiner", &joiner),
            ("tokens", &tokens),
        ] {
            if !path.exists() {
                return Err(format!("ASR model file '{}' not found at: {}", name, path.display()));
            }
        }

        let config = OnlineRecognizerConfig {
            model_config: OnlineModelConfig {
                transducer: OnlineTransducerModelConfig {
                    encoder: Some(encoder.to_string_lossy().to_string()),
                    decoder: Some(decoder.to_string_lossy().to_string()),
                    joiner: Some(joiner.to_string_lossy().to_string()),
                },
                tokens: Some(tokens.to_string_lossy().to_string()),
                num_threads: 1,
                provider: Some("cpu".to_string()),
                ..Default::default()
            },
            decoding_method: Some("greedy_search".to_string()),
            enable_endpoint: false,
            ..Default::default()
        };

        let recognizer = OnlineRecognizer::create(&config)
            .ok_or_else(|| "Failed to create OnlineRecognizer for enrollment".to_string())?;

        let mut variants = Vec::with_capacity(clips.len());

        for (i, clip) in clips.iter().enumerate() {
            if clip.is_empty() {
                variants.push(String::new());
                continue;
            }

            let stream = recognizer.create_stream();

            // Feed the clip + 0.5s tail padding
            stream.accept_waveform(16000, clip);
            let tail = vec![0.0f32; 8000];
            stream.accept_waveform(16000, &tail);
            stream.input_finished();

            while recognizer.is_ready(&stream) {
                recognizer.decode(&stream);
            }

            let text = if let Some(result) = recognizer.get_result(&stream) {
                result.text.trim().to_lowercase()
            } else {
                String::new()
            };

            tracing::info!("Enrollment clip {} ASR transcript: \"{}\"", i + 1, text);
            variants.push(text);

            recognizer.reset(&stream);
        }

        Ok(variants)
    }

    /// IPC: Enroll a voice profile from multiple audio clips.
    /// Each clip is a Vec<f32> of 16kHz mono audio samples.
    /// Also runs ASR on each clip to capture wake-word variants.
    /// Re-enrollment APPENDS new variants to existing ones (does not wipe).
    #[tauri::command]
    pub fn enroll_voice<R: Runtime>(
        app: tauri::AppHandle<R>,
        clips: Vec<Vec<f32>>,
        threshold: Option<f32>,
    ) -> Result<Vec<String>, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let profile_path = voice_profile::resolve_profile_path(&dir);

        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let sherpa_dir = resolve_sherpa_dir(&resource_dir)
            .ok_or_else(|| "Sherpa resource directory not found".to_string())?;

        let speaker_model = sherpa_dir.join("speaker_model.onnx");

        let mut verifier = voice_profile::SpeakerVerifier::new(speaker_model, profile_path)
            .map_err(|e| e.to_string())?;

        // Run ASR on each clip to capture wake-word variants
        let asr_variants = transcribe_enrollment_clips(&sherpa_dir, &clips)
            .map_err(|e| {
                tracing::warn!("Enrollment ASR failed (continuing without variants): {e}");
                // Don't fail enrollment if ASR fails — just use empty variants
                vec![String::new(); clips.len()]
            })
            .unwrap_or_else(|_| vec![String::new(); clips.len()]);

        let threshold = threshold.unwrap_or(voice_profile::DEFAULT_THRESHOLD);
        verifier
            .enroll(&clips, threshold, asr_variants.clone())
            .map_err(|e| e.to_string())?;

        // Return the captured variants so the UI can show them
        let captured: Vec<String> = verifier
            .profile()
            .map(|p| p.wake_variants.clone())
            .unwrap_or_default();

        Ok(captured)
    }

    /// IPC: Delete the voice profile (disables speaker verification).
    #[tauri::command]
    pub fn delete_voice_profile<R: Runtime>(
        app: tauri::AppHandle<R>,
    ) -> Result<(), String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let profile_path = voice_profile::resolve_profile_path(&dir);

        if profile_path.exists() {
            std::fs::remove_file(&profile_path).map_err(|e| e.to_string())?;
            tracing::info!("Voice profile deleted");
        }
        Ok(())
    }
}

// ─── First-of-day greeting ─────────────────────────────────────────────────
//
// Instead of greeting on every boot or every sleep/wake, NEXUS greets only
// on the first user interaction (wake) of each calendar day. The last
// greeting date is persisted to `greeting-state.json` in the app data dir,
// so it survives restarts, shutdowns, and crashes.
//
// Flow:
//   1. User wakes NEXUS (hotkey or spoken "nexus")
//   2. Frontend calls `should_greet_today` → Rust compares today's date
//      with the stored `last_greeting_date`
//   3. If different (first time today) → frontend speaks the greeting,
//      then calls `mark_greeted_today` to persist today's date
//   4. If same (already greeted today) → frontend skips greeting, goes
//      straight to listening

/// Resolve the greeting state file path in the app data directory.
fn greeting_state_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("greeting-state.json"))
}

/// Read the last greeting date from disk. Returns None if the file
/// doesn't exist or is corrupted (safe default: greet).
fn read_last_greeting_date(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json["last_greeting_date"]
        .as_str()
        .map(|s| s.to_string())
}

/// Write today's date to the greeting state file.
fn write_last_greeting_date(path: &Path, date: &str) -> Result<(), String> {
    let json = serde_json::json!({ "last_greeting_date": date });
    std::fs::write(path, json.to_string())
        .map_err(|e| format!("failed to write greeting state: {e}"))
}

/// Get today's date as YYYY-MM-DD in the local timezone.
fn today_local() -> String {
    use chrono::Local;
    Local::now().format("%Y-%m-%d").to_string()
}

/// IPC: Check if NEXUS should greet the user on this wake.
///
/// Returns true if today's date differs from the stored `last_greeting_date`
/// (i.e., this is the first interaction of the day). Also checks meeting/pause
/// state — if a meeting is active or NEXUS is paused, the greeting is
/// suppressed but the date is NOT saved, so the next wake after the meeting
/// will still greet.
#[tauri::command]
pub fn should_greet_today<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    let path = greeting_state_path(&app)?;
    let last = read_last_greeting_date(&path);
    let today = today_local();

    let is_new_day = last.as_deref() != Some(&today);

    // Check meeting/pause state — suppress greeting but don't save date
    let (meeting, paused) = match app
        .try_state::<std::sync::Arc<crate::meeting_detect::MeetingState>>()
    {
        Some(state) => (state.is_meeting_active(), state.is_paused()),
        None => (false, false),
    };

    let should_greet = is_new_day && !meeting && !paused;
    tracing::info!(
        "greeting check: today={} last={:?} new_day={} meeting={} paused={} → greet={}",
        today, last, is_new_day, meeting, paused, should_greet
    );
    Ok(should_greet)
}

/// IPC: Mark that NEXUS has greeted the user today.
///
/// Called by the frontend AFTER the greeting TTS finishes (or starts —
/// either way, the date is saved so subsequent wakes don't re-greet).
#[tauri::command]
pub fn mark_greeted_today<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let path = greeting_state_path(&app)?;
    let today = today_local();
    write_last_greeting_date(&path, &today)?;
    tracing::info!("greeting: marked today ({}) as greeted", today);
    Ok(())
}

// ─── Meeting / privacy mode commands ─────────────────────────────────

/// IPC: Check whether TTS should be suppressed right now.
///
/// The frontend calls this before speaking to decide whether to
/// produce audible TTS or show a silent visual response instead.
///
/// Uses `should_suppress_tts()` (not `is_meeting_active()`) so that
/// disabling auto-detection in settings takes effect immediately.
/// `is_meeting_active()` only reports the raw detection flag, which the
/// polling loop clears up to 2s later — long enough for the user to
/// disable detection and still have their next response muted.
#[tauri::command]
pub fn meeting_active<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    let state = app
        .try_state::<std::sync::Arc<crate::meeting_detect::MeetingState>>()
        .ok_or_else(|| "meeting state not managed".to_string())?;
    Ok(state.should_suppress_tts())
}

/// IPC: Check if NEXUS is paused (manual pause via tray).
#[tauri::command]
pub fn is_nexus_paused<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    let state = app
        .try_state::<std::sync::Arc<crate::meeting_detect::MeetingState>>()
        .ok_or_else(|| "meeting state not managed".to_string())?;
    Ok(state.is_paused())
}

/// IPC: Get the full meeting/privacy mode status.
#[tauri::command]
pub fn meeting_status<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<MeetingStatus, String> {
    let state = app
        .try_state::<std::sync::Arc<crate::meeting_detect::MeetingState>>()
        .ok_or_else(|| "meeting state not managed".to_string())?;
    Ok(MeetingStatus {
        meeting_active: state.is_meeting_active(),
        paused: state.is_paused(),
        tts_playing: state.tts_playing.load(std::sync::atomic::Ordering::Relaxed),
        detection_enabled: state.detection_enabled.load(std::sync::atomic::Ordering::Relaxed),
    })
}

/// IPC: Enable or disable automatic meeting detection.
#[tauri::command]
pub fn set_meeting_detection<R: Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    let state = app
        .try_state::<std::sync::Arc<crate::meeting_detect::MeetingState>>()
        .ok_or_else(|| "meeting state not managed".to_string())?;
    state.detection_enabled.store(enabled, std::sync::atomic::Ordering::Relaxed);
    tracing::info!("meeting detection: {}", if enabled { "enabled" } else { "disabled" });
    Ok(())
}

/// Serialized meeting status returned by `meeting_status`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MeetingStatus {
    pub meeting_active: bool,
    pub paused: bool,
    pub tts_playing: bool,
    pub detection_enabled: bool,
}

// ─── Response Sidebar window ─────────────────────────────────────────

/// IPC: Show the response sidebar window (positioned at bottom-right).
/// Called when a server response is incoming (n8n/Ollama/Hermes).
#[tauri::command]
pub fn show_sidebar<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let win = app.get_webview_window("sidebar")
        .ok_or_else(|| "sidebar window not found".to_string())?;
    show_sidebar_inner(&app, &win)?;
    Ok(())
}

/// IPC: Show the sidebar AND set its content directly via JS evaluation.
/// Bypasses the Tauri event system entirely — directly manipulates the
/// sidebar window's DOM. This is the most reliable approach since it
/// doesn't depend on listen() working in the sidebar window's JS context.
#[tauri::command]
pub fn show_sidebar_with_content<R: Runtime>(
    app: tauri::AppHandle<R>,
    query: String,
    text: String,
) -> Result<(), String> {
    let win = app.get_webview_window("sidebar")
        .ok_or_else(|| "sidebar window not found".to_string())?;
    show_sidebar_inner(&app, &win)?;

    // Directly set the sidebar content via JS evaluation.
    // This bypasses the event system and React state — we set the DOM
    // directly and toggle the CSS class for visibility.
    //
    // TEXT ANIMATION: Words are split into <span class="word"> elements
    // with staggered animation-delay, creating a ChatGPT/Gemini-style
    // fade-in-from-top streaming effect. Newlines are preserved as <br>.
    let escaped_query = query.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', "\\n");
    let escaped_text = text.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', "\\n");

    let js = format!(
        r#"
        (function() {{
            var app = document.getElementById('sidebar-app');
            if (!app) return;
            app.className = 'sidebar--visible';

            // Set query text
            var q = app.querySelector('.sidebar-query');
            if (q) {{ q.textContent = '{q}'; }}
            else {{
                var card = app.querySelector('.sidebar-card');
                if (card) {{
                    var qd = document.createElement('div');
                    qd.className = 'sidebar-query';
                    qd.textContent = '{q}';
                    card.insertBefore(qd, card.firstChild);
                }}
            }}

            // Build word-by-word streaming text
            var r = app.querySelector('.sidebar-response-text');
            if (!r) return;
            r.innerHTML = '';

            var fullText = '{t}';
            // Split by newlines first, then words within each line
            var lines = fullText.split('\\n');
            var wordIndex = 0;
            // ~28ms per word — fast enough for long responses, slow enough
            // to see the streaming effect. Capped at 2000ms total.
            var delayPerWord = 28;
            var maxDelay = 2000;

            lines.forEach(function(line, lineIdx) {{
                if (lineIdx > 0) {{
                    r.appendChild(document.createElement('br'));
                }}
                // Filter out empty strings from double spaces
                var words = line.split(' ').filter(function(w) {{ return w.length > 0; }});
                words.forEach(function(word, wIdx) {{
                    var span = document.createElement('span');
                    span.className = 'word';
                    // Include the trailing space INSIDE the span so it
                    // animates with the word and doesn't get collapsed.
                    // Last word in the last line gets no trailing space.
                    var isLast = (lineIdx === lines.length - 1) && (wIdx === words.length - 1);
                    span.textContent = isLast ? word : word + ' ';
                    var delay = Math.min(wordIndex * delayPerWord, maxDelay);
                    span.style.animationDelay = delay + 'ms';
                    r.appendChild(span);
                    wordIndex++;
                }});
            }});

            // Auto-scroll: keep the view following the streaming text
            var scrollContainer = app.querySelector('.sidebar-response');
            if (scrollContainer) {{
                var scrollTimer = setInterval(function() {{
                    scrollContainer.scrollTop = scrollContainer.scrollHeight;
                }}, 50);
                // Stop auto-scrolling after all words have appeared
                setTimeout(function() {{
                    clearInterval(scrollTimer);
                }}, maxDelay + 500);
            }}
        }})();
        "#,
        q = escaped_query,
        t = escaped_text,
    );

    win.eval(&js).map_err(|e| e.to_string())?;
    tracing::info!("sidebar: shown with content via JS eval (query={} chars, text={} chars)", query.len(), text.len());
    Ok(())
}

/// Shared inner logic for showing the sidebar window.
fn show_sidebar_inner<R: Runtime>(
    _app: &tauri::AppHandle<R>,
    win: &tauri::WebviewWindow<R>,
) -> Result<(), String> {

    // Position at bottom-right of the screen, above the taskbar.
    use tauri::PhysicalPosition;
    if let Ok(Some(monitor)) = win.current_monitor() {
        let scale = monitor.scale_factor();
        let screen = monitor.size();
        let sidebar_w = 600i32;
        let sidebar_h = 1000i32;
        let phys_w = (sidebar_w as f64 * scale) as i32;
        let phys_h = (sidebar_h as f64 * scale) as i32;

        #[cfg(target_os = "macos")]
        let taskbar = (70.0 * scale) as i32;
        #[cfg(target_os = "windows")]
        let taskbar = (48.0 * scale) as i32;
        #[cfg(target_os = "linux")]
        let taskbar = (36.0 * scale) as i32;
        let gap = (12.0 * scale) as i32;

        let x = screen.width as i32 - phys_w - gap;
        // Clamp Y so the window doesn't go off-screen if taller than the monitor
        let y = (screen.height as i32 - phys_h - taskbar - gap).max(0);
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }

    // ─── Native OS blur (cross-platform) ───────────────────────────
    // Primary acrylic registration happens in lib.rs setup hook (correct
    // timing). This is a safety re-apply in case the effect was lost
    // (e.g. window was hidden/shown by the OS). Called AFTER win.show()
    // so the window has participated in at least one DWM composition pass.
    //
    // Windows: DWM acrylic = blurs what's behind the window (other apps,
    //          desktop wallpaper). Tint (0,0,0,0) = no color overlay —
    //          the glass look is provided entirely by the CSS card.
    // macOS:   Applied in setup hook (NSVisualEffectView persists).
    // Linux:   No native API — CSS backdrop-filter is the fallback.

    win.show().map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    {
        use tauri::PhysicalPosition;
        if let Ok(Some(monitor)) = win.current_monitor() {
            let scale = monitor.scale_factor();
            let screen = monitor.size();
            let sidebar_w = 600i32;
            let sidebar_h = 1000i32;
            let phys_w = (sidebar_w as f64 * scale) as i32;
            let phys_h = (sidebar_h as f64 * scale) as i32;
            let taskbar = (36.0 * scale) as i32;
            let gap = (12.0 * scale) as i32;
            let x = screen.width as i32 - phys_w - gap;
            let y = (screen.height as i32 - phys_h - taskbar - gap).max(0);
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }

    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::apply_blur;
        // Re-apply after show. White 35% alpha.
        if let Err(e) = apply_blur(&win, Some((255, 255, 255, 90))) {
            tracing::warn!("sidebar: re-apply blur failed: {e:?}");
        }
    }

    Ok(())
}

/// IPC: Hide the response sidebar window.
/// Called after the server response has been spoken.
#[tauri::command]
pub fn hide_sidebar<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let win = app.get_webview_window("sidebar")
        .ok_or_else(|| "sidebar window not found".to_string())?;
    win.hide().map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Settings window + persistence ───────────────────────────────────

/// IPC: Open the settings window.
#[tauri::command]
pub fn open_settings_window<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let win = app.get_webview_window("settings")
        .ok_or_else(|| "settings window not found".to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// IPC: Close/hide the settings window.
#[tauri::command]
pub fn close_settings_window<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let win = app.get_webview_window("settings")
        .ok_or_else(|| "settings window not found".to_string())?;
    win.hide().map_err(|e| e.to_string())?;
    Ok(())
}

/// Serialized settings returned by `get_settings` and accepted by `save_settings`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusSettings {
    pub autostart: bool,
    pub hotkey: String,
    pub auto_hide_delay: u32,
    pub wake_word_enabled: bool,
    pub wake_phrase: String,
    pub wake_sensitivity: String,
    pub speaker_verification: bool,
    pub meeting_mode_auto: bool,
    pub suppress_tts_in_meetings: bool,
    pub local_stt_only: bool,
    pub server_url: String,
    pub user_id: String,
    pub device_id: String,
    pub tts_voice: String,
    pub speech_rate: f64,
    #[serde(default = "default_tts_provider")]
    pub tts_provider: String,
    #[serde(default)]
    pub elevenlabs_api_key: String,
    #[serde(default)]
    pub fish_audio_api_key: String,
    #[serde(default)]
    pub gemini_api_key: String,
}

fn default_tts_provider() -> String {
    "neural".to_string()
}

impl Default for NexusSettings {
    fn default() -> Self {
        Self {
            autostart: true,
            hotkey: "Ctrl+Shift+Space".to_string(),
            auto_hide_delay: 8,
            wake_word_enabled: true,
            wake_phrase: "NEXUS".to_string(),
            wake_sensitivity: "medium".to_string(),
            speaker_verification: false,
            meeting_mode_auto: true,
            suppress_tts_in_meetings: true,
            local_stt_only: true,
            server_url: option_env!("NEXUS_SERVER_URL")
                .unwrap_or("https://nexus-worker.example.workers.dev")
                .to_string(),
            user_id: String::new(),
            device_id: String::new(),
            tts_voice: "jarvis".to_string(),
            speech_rate: 1.0,
            tts_provider: "neural".to_string(),
            elevenlabs_api_key: String::new(),
            fish_audio_api_key: String::new(),
            gemini_api_key: String::new(),
        }
    }
}

/// IPC: Get the current settings (merged with defaults for missing fields).
#[tauri::command]
pub fn get_settings<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<NexusSettings, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    if !path.exists() {
        return Ok(NexusSettings::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut settings: NexusSettings = serde_json::from_str(&content)
        .unwrap_or_default();
    // Merge server config if present
    let config_path = dir.join("nexus-config.json");
    if config_path.exists() {
        if let Ok(config) = std::fs::read_to_string(&config_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&config) {
                if let Some(url) = json.get("serverUrl").and_then(|v| v.as_str()) {
                    settings.server_url = url.to_string();
                }
                if let Some(uid) = json.get("userId").and_then(|v| v.as_str()) {
                    settings.user_id = uid.to_string();
                }
                if let Some(did) = json.get("deviceId").and_then(|v| v.as_str()) {
                    settings.device_id = did.to_string();
                }
            }
        }
    }
    if settings.fish_audio_api_key.is_empty() {
        if let Ok(key) = std::env::var("FISH_AUDIO_API_KEY").or_else(|_| std::env::var("NEXUS_FISH_AUDIO_API_KEY")) {
            settings.fish_audio_api_key = key;
        }
    }
    if settings.gemini_api_key.is_empty() {
        if let Ok(key) = std::env::var("GEMINI_API_KEY").or_else(|_| std::env::var("NEXUS_GEMINI_API_KEY")) {
            settings.gemini_api_key = key;
        }
    }
    Ok(settings)
}

/// IPC: Save settings to disk.
#[tauri::command]
pub fn save_settings<R: Runtime>(
    app: tauri::AppHandle<R>,
    settings: NexusSettings,
) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    // Also save server config separately (so existing code can read it)
    let config = serde_json::json!({
        "serverUrl": settings.server_url,
        "userId": settings.user_id,
        "deviceId": settings.device_id,
    });
    let config_path = dir.join("nexus-config.json");
    std::fs::write(&config_path, config.to_string()).map_err(|e| e.to_string())?;
    tracing::info!("settings saved to {:?}", path);
    Ok(())
}

/// IPC: Clear the conversation transcript (frontend store).
/// This is a no-op on the Rust side — the frontend handles it.
/// The command exists so the settings UI can call it via IPC.
#[tauri::command]
pub fn clear_transcript() -> Result<(), String> {
    tracing::info!("transcript cleared (frontend-side)");
    Ok(())
}

/// Force a manual app registry refresh (e.g. after installing a new app).
/// Scans the OS for installed apps and updates the cache immediately.
#[tauri::command]
pub fn refresh_app_registry() -> Result<String, String> {
    tracing::info!("manual app registry refresh requested");
    app_registry::force_refresh();
    Ok("App registry refreshed".to_string())
}
