//! IPC commands for setup window management and configuration.

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

/// IPC: Get the current voice profile status (enrolled or not, number of clips, threshold).
#[tauri::command]
pub fn get_voice_profile_status<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<voice_profile::VoiceProfileStatus, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let profile_path = voice_profile::resolve_profile_path(&dir);

    if !profile_path.exists() {
        return Ok(voice_profile::VoiceProfileStatus {
            enrolled: false,
            num_clips: 0,
            threshold: voice_profile::DEFAULT_THRESHOLD,
            created_at: 0,
            updated_at: 0,
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
    })
}

/// IPC: Enroll a voice profile from multiple audio clips.
/// Each clip is a Vec<f32> of 16kHz mono audio samples.
#[tauri::command]
pub fn enroll_voice<R: Runtime>(
    app: tauri::AppHandle<R>,
    clips: Vec<Vec<f32>>,
    threshold: Option<f32>,
) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let profile_path = voice_profile::resolve_profile_path(&dir);
    let model_path = app.path().resource_dir()
        .map_err(|e| e.to_string())?
        .join("sherpa")
        .join("speaker_model.onnx");

    // In dev mode, fall back to the source resources dir
    let model_path = if model_path.exists() {
        model_path
    } else if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        std::path::PathBuf::from(manifest).join("resources").join("sherpa").join("speaker_model.onnx")
    } else {
        model_path
    };

    let mut verifier = voice_profile::SpeakerVerifier::new(model_path, profile_path)
        .map_err(|e| e.to_string())?;

    let threshold = threshold.unwrap_or(voice_profile::DEFAULT_THRESHOLD);
    verifier.enroll(&clips, threshold).map_err(|e| e.to_string())?;
    Ok(())
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
