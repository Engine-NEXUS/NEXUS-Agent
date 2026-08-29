use transcribe_rs::onnx::moonshine::{MoonshineModel, MoonshineVariant};
use transcribe_rs::onnx::Quantization;
use transcribe_rs::{SpeechModel, TranscribeOptions};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;

pub struct SttState {
    pub transcriber: Arc<Mutex<Option<MoonshineModel>>>,
}

/// The HuggingFace repo for the Moonshine Tiny ONNX model.
const MOONSHINE_HF_REPO: &str = "onnx-community/moonshine-tiny-ONNX";

/// Files needed for Int8 quantization (smallest, ~32 MB total).
/// tokenizer.json is in the repo root, ONNX files are in the onnx/ subdir.
/// NOTE: transcribe-rs expects {name}.{suffix}.onnx (dot separator), but
/// HuggingFace uses {name}_{suffix}.onnx (underscore). We download from HF
/// and save with the dot naming that transcribe-rs's resolve_model_path() expects.
const MOONSHINE_FILES: &[(&str, &str)] = &[
    ("tokenizer.json", "tokenizer.json"),
    ("onnx/encoder_model_int8.onnx", "encoder_model.int8.onnx"),
    ("onnx/decoder_model_merged_int8.onnx", "decoder_model_merged.int8.onnx"),
];

/// Resolve the Moonshine model directory.
/// Looks in (1) NEXUS_STT_MODEL_DIR env var, (2) app data dir /models/moonshine,
/// (3) dev path <repo>/src-tauri/models/moonshine.
fn resolve_model_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("NEXUS_STT_MODEL_DIR") {
        let p = PathBuf::from(dir);
        if p.exists() {
            return Ok(p);
        }
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        let p = PathBuf::from(&appdata)
            .join("com.nexus.assistant")
            .join("models")
            .join("moonshine");
        if p.exists() {
            return Ok(p);
        }
    }

    // Dev path relative to the executable
    let dev_path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .and_then(|p| p.parent()) // target/release -> target
        .and_then(|p| p.parent()) // target -> src-tauri
        .map(|p| p.join("models").join("moonshine"));
    if let Some(p) = dev_path {
        if p.exists() {
            return Ok(p);
        }
    }

    Err("Moonshine model directory not found. Run 'nexus install' to download the model, or set NEXUS_STT_MODEL_DIR.".to_string())
}

/// Check if the model directory has all required files.
fn model_dir_is_complete(dir: &PathBuf) -> bool {
    for (_, local_name) in MOONSHINE_FILES {
        if !dir.join(local_name).exists() {
            return false;
        }
    }
    true
}

/// Download the Moonshine Tiny ONNX model files from HuggingFace.
/// Downloads to the app data dir: %APPDATA%/com.nexus.assistant/models/moonshine/
async fn download_moonshine_model() -> Result<PathBuf, String> {
    let model_dir = if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(&appdata)
            .join("com.nexus.assistant")
            .join("models")
            .join("moonshine")
    } else {
        return Err("Cannot determine APPDATA for model storage".to_string());
    };

    // Create the directory if it doesn't exist
    std::fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to create model dir: {}", e))?;

    // Check if already downloaded
    if model_dir_is_complete(&model_dir) {
        tracing::info!("stt: Moonshine model already present at {:?}", model_dir);
        return Ok(model_dir);
    }

    tracing::info!("stt: downloading Moonshine Tiny Int8 model from HuggingFace (~32 MB)...");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    for (remote_path, local_name) in MOONSHINE_FILES {
        let local_path = model_dir.join(local_name);
        if local_path.exists() {
            continue; // Skip already-downloaded files
        }

        let url = format!("https://huggingface.co/{}/resolve/main/{}", MOONSHINE_HF_REPO, remote_path);
        tracing::info!("stt: downloading {} -> {}", url, local_path.display());

        let resp = client.get(&url)
            .header("User-Agent", "NEXUS/1.0")
            .send()
            .await
            .map_err(|e| format!("Download failed for {}: {}", remote_path, e))?;

        if !resp.status().is_success() {
            return Err(format!("Download failed for {}: HTTP {}", remote_path, resp.status()));
        }

        let bytes = resp.bytes()
            .await
            .map_err(|e| format!("Download read failed for {}: {}", remote_path, e))?;

        std::fs::write(&local_path, &bytes)
            .map_err(|e| format!("Failed to write {}: {}", local_path.display(), e))?;

        let size_mb = bytes.len() as f64 / 1024.0 / 1024.0;
        tracing::info!("stt: downloaded {} ({:.1} MB)", local_name, size_mb);
    }

    tracing::info!("stt: Moonshine model download complete.");
    Ok(model_dir)
}

#[tauri::command]
pub async fn transcribe_audio(
    samples: Vec<i16>,
    state: State<'_, SttState>,
) -> Result<String, String> {
    tracing::info!("stt: received {} samples for local Moonshine transcription", samples.len());

    let transcriber_arc = state.transcriber.clone();
    let mut lock = transcriber_arc.lock().await;

    if lock.is_none() {
        tracing::info!("stt: initializing Moonshine Tiny model (Int8)...");

        // Try to resolve the model directory; if not found, auto-download
        let model_dir = match resolve_model_dir() {
            Ok(dir) if model_dir_is_complete(&dir) => dir,
            Ok(dir) => {
                tracing::info!("stt: model dir exists but incomplete, re-downloading...");
                download_moonshine_model().await?
            }
            Err(_) => {
                tracing::info!("stt: model dir not found, auto-downloading from HuggingFace...");
                download_moonshine_model().await?
            }
        };

        tracing::info!("stt: using model dir: {:?}", model_dir);
        let model = MoonshineModel::load(
            &model_dir,
            MoonshineVariant::Tiny,
            &Quantization::Int8,
        )
            .map_err(|e| format!("Failed to init Moonshine: {}", e))?;
        *lock = Some(model);
        tracing::info!("stt: Moonshine Tiny Int8 initialized.");
    }

    let model = lock.as_mut().unwrap();

    // Convert i16 to f32 for transcribe-rs
    let f32_samples: Vec<f32> = samples.iter().map(|&s| s as f32 / 32768.0).collect();

    let result = model.transcribe(&f32_samples, &TranscribeOptions::default())
        .map_err(|e| format!("Transcription error: {}", e))?;

    let text = result.text.trim().to_string();

    // Apply hallucination filter (same as before)
    let filtered = apply_hallucination_filter(&text);

    if filtered != text {
        tracing::info!("stt: filtered hallucination '{}' -> '{}'", text, filtered);
    } else {
        tracing::info!("stt: transcript: '{}'", text);
    }

    Ok(filtered)
}

fn apply_hallucination_filter(text: &str) -> String {
    let lower = text.to_lowercase();
    let hallucinations = [
        "thank you for watching", "thanks for watching", "thank you.", "you.", "bye.",
        "please subscribe", "subscribe to my channel",
    ];

    for h in hallucinations.iter() {
        if lower.contains(h) {
            return "".to_string();
        }
    }

    let alpha_count = text.chars().filter(|c| c.is_alphabetic()).count();
    if alpha_count < 2 {
        return "".to_string();
    }

    text.to_string()
}

#[tauri::command]
pub async fn stt_status() -> Result<bool, String> {
    // We are running in-process, so if this is called, we are up.
    Ok(true)
}
