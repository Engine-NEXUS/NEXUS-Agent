//! IPC commands for setup window management and configuration.

use std::path::{Path, PathBuf};
use tauri::{Manager, Runtime};
use crate::voice_profile;

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

/// IPC: close/hide the setup window.
#[tauri::command]
pub fn close_setup_window<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let win = app.get_webview_window("setup")
        .ok_or_else(|| "setup window not found".to_string())?;
    win.hide().map_err(|e| e.to_string())?;
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
            server_url: "ws://127.0.0.1:49152/ws".to_string(),
            user_id: "local-user".to_string(),
            device_id: "local-device".to_string(),
        }
    }
}

/// IPC: Get the saved server config (or defaults if not yet configured).
/// The frontend calls this at startup to get the WebSocket URL, user ID,
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
        server_url: json["serverUrl"].as_str().unwrap_or("ws://127.0.0.1:49152/ws").to_string(),
        user_id: json["userId"].as_str().unwrap_or("local-user").to_string(),
        device_id: json["deviceId"].as_str().unwrap_or("local-device").to_string(),
    })
}

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
fn resolve_sherpa_dir(resource_dir: &Path) -> Option<PathBuf> {
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
fn transcribe_enrollment_clips(
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

// ─── Meeting / privacy mode commands ─────────────────────────────────

/// IPC: Check if a meeting is active (TTS should be suppressed).
///
/// The frontend calls this before speaking to decide whether to
/// produce audible TTS or show a silent visual response instead.
#[tauri::command]
pub fn meeting_active<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    let state = app
        .try_state::<std::sync::Arc<crate::meeting_detect::MeetingState>>()
        .ok_or_else(|| "meeting state not managed".to_string())?;
    Ok(state.is_meeting_active())
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
