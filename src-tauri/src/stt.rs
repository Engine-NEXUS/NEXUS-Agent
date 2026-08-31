use std::time::Duration;
use transcribe_rs::transcriber::Transcriber;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;

pub struct SttState {
    pub transcriber: Arc<Mutex<Option<Transcriber>>>,
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
        tracing::info!("stt: initializing Moonshine model...");
        // Using Moonshine tiny/base
        let t = Transcriber::new(transcribe_rs::ModelUrl::MoonshineTinyEn)
            .map_err(|e| format!("Failed to init Transcriber: {}", e))?;
        *lock = Some(t);
        tracing::info!("stt: Moonshine initialized.");
    }

    let transcriber = lock.as_mut().unwrap();

    // Convert i16 to f32 for transcribe-rs
    let f32_samples: Vec<f32> = samples.iter().map(|&s| s as f32 / 32768.0).collect();

    let result = transcriber.transcribe(&f32_samples, None)
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
