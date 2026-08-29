//! STT proxy — sends audio to the local faster-whisper Python server.
//!
//! The faster-whisper server (server/stt_server.py) runs on port 39217
//! and is started lazily by lazy_stt.rs when the wake word fires.
//! This module sends Int16 PCM audio via HTTP POST and returns the transcript.

use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;

pub struct SttState {
    /// Reserved for future use (e.g. connection pooling). Currently unused.
    pub _placeholder: Arc<Mutex<()>>,
}

const STT_URL: &str = "http://127.0.0.1:39217/transcribe";

/// Transcribe audio by sending it to the local faster-whisper STT server.
///
/// The frontend sends Int16 PCM samples at 16kHz. We convert them to a WAV
/// blob and POST it to the Python server which runs faster-whisper tiny.en.
#[tauri::command]
pub async fn transcribe_audio(
    samples: Vec<i16>,
    _state: State<'_, SttState>,
) -> Result<String, String> {
    tracing::info!("stt: received {} samples for faster-whisper transcription", samples.len());

    // Ensure the STT server is running (lazy start)
    crate::lazy_stt::ensure_stt_running();
    crate::lazy_stt::mark_stt_request();

    // Wait for the STT server to be ready (it takes ~10-15s to load Whisper on first call)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut ready = false;
    for attempt in 0..40 {
        // Check health
        let health = client
            .get("http://127.0.0.1:39217/health")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await;

        if let Ok(resp) = health {
            if resp.status().is_success() {
                ready = true;
                break;
            }
        }

        if attempt == 0 {
            tracing::info!("stt: waiting for STT server to be ready...");
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    if !ready {
        return Err("STT server did not become ready in 20s".to_string());
    }

    // Convert i16 samples to WAV bytes (16kHz, mono, 16-bit)
    let wav_bytes = pcm_to_wav(&samples, 16000);
    tracing::info!("stt: sending {} bytes WAV to {}", wav_bytes.len(), STT_URL);

    // POST the WAV to the local STT server as multipart form data
    // (FastAPI's UploadFile = File(...) expects multipart, not raw body)
    let part = reqwest::multipart::Part::bytes(wav_bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("MIME error: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .part("audio", part);

    let resp = client
        .post(STT_URL)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("STT server request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        tracing::error!("stt: server returned {} : {}", status, body);
        return Err(format!("STT server error {}: {}", status, body));
    }

    // Parse JSON response: {"text": "..."}
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("STT response parse error: {}", e))?;

    let text = json
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    // Apply hallucination filter
    let filtered = apply_hallucination_filter(&text);

    if filtered != text {
        tracing::info!("stt: filtered hallucination '{}' -> '{}'", text, filtered);
    } else {
        tracing::info!("stt: transcript: '{}'", text);
    }

    Ok(filtered)
}

/// Check if the STT server is reachable.
#[tauri::command]
pub async fn stt_status() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("http://127.0.0.1:39217/health")
        .send()
        .await;

    Ok(resp.map(|r| r.status().is_success()).unwrap_or(false))
}

/// Convert raw i16 PCM samples to a WAV file (16-bit, mono, given sample rate).
fn pcm_to_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let num_samples = samples.len();
    let data_size = num_samples * 2; // 16-bit = 2 bytes per sample
    let mut wav = Vec::with_capacity(44 + data_size);

    // RIFF header
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");

    // fmt chunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
    wav.extend_from_slice(&1u16.to_le_bytes());  // audio format = PCM
    wav.extend_from_slice(&1u16.to_le_bytes());  // num channels = mono
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes());  // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

    // data chunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_size as u32).to_le_bytes());

    // PCM samples (little-endian i16)
    for &s in samples {
        wav.extend_from_slice(&s.to_le_bytes());
    }

    wav
}

/// Filter common Whisper hallucinations on noisy/silent audio.
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
