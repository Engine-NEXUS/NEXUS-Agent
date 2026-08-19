//! Local Speech-to-Text via a local faster-whisper HTTP server.
//!
//! Audio is captured by the AudioWorklet (16-bit mono PCM at 16 kHz) and sent
//! to a LOCAL STT endpoint (default: http://localhost:8000/transcribe).
//! The audio NEVER leaves the device — it goes to localhost, not the remote
//! NEXUS server. Only the resulting transcript text is sent to the remote
//! server.
//!
//! The local STT server is `server/stt_server.py` (faster-whisper + FastAPI).
//! It must be running on the device before NEXUS starts listening.
//!
//! Environment variables:
//!   - `NEXUS_LOCAL_STT_URL` — override the local STT endpoint (default:
//!     http://localhost:8000/transcribe)

use tauri::Runtime;

/// Default local STT endpoint. Audio goes here (127.0.0.1), not the remote server.
/// Use 127.0.0.1 instead of "localhost" — Rust's hyper/tokio tries IPv6 (::1)
/// first when resolving "localhost", and uvicorn binds to IPv4 only by default.
const DEFAULT_LOCAL_STT_URL: &str = "http://127.0.0.1:8000/transcribe";

fn local_stt_url() -> String {
    std::env::var("NEXUS_LOCAL_STT_URL").unwrap_or_else(|_| DEFAULT_LOCAL_STT_URL.to_string())
}

/// IPC: transcribe raw 16-bit mono PCM audio to text via the local STT server.
///
/// Args:
///   - samples: Vec<i16> — raw 16-bit LE mono PCM at 16 kHz
///
/// Returns: String — the transcribed text, or empty string on failure.
#[tauri::command]
pub async fn transcribe_audio<R: Runtime>(
    _app: tauri::AppHandle<R>,
    samples: Vec<i16>,
) -> Result<String, String> {
    if samples.is_empty() {
        return Ok(String::new());
    }

    // Convert i16 PCM → little-endian bytes for the HTTP multipart upload.
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in &samples {
        bytes.push(s as u8);
        bytes.push((s >> 8) as u8);
    }

    let url = local_stt_url();
    tracing::debug!("sending {} bytes to local STT at {}", bytes.len(), url);

    // POST the raw PCM to the local faster-whisper server.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("audio.bin")
        .mime_str("application/octet-stream")
        .map_err(|e| format!("mime: {e}"))?;

    let form = reqwest::multipart::Form::new().part("audio", part);

    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("local STT request failed: {e}. Is stt_server.py running on localhost:8000?"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("local STT returned {status}: {body}"));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("local STT JSON parse: {e}"))?;

    let text = data
        .get("text")
        .or_else(|| data.get("transcript"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    tracing::info!("local STT result: {:?}", text);
    Ok(text)
}

/// Check if the local STT server is reachable (for health/status checks).
#[tauri::command]
pub async fn stt_status<R: Runtime>(_app: tauri::AppHandle<R>) -> Result<bool, String> {
    let url = local_stt_url();
    // Replace /transcribe with /health if present, otherwise just check the base URL.
    let health_url = url.replace("/transcribe", "/health");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    match client.get(&health_url).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => {
            // Fall back to checking the transcribe endpoint itself.
            match client.get(&url).send().await {
                Ok(_) => Ok(true),
                Err(_) => Ok(false),
            }
        }
    }
}
