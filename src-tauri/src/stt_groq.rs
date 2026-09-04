//! Groq Cloud STT — Whisper Large v3 Turbo via Groq API.
//!
//! Free tier: 2,000 requests/day, 28,800 audio seconds/day per user.
//! No credit card required. Sign up at console.groq.com.
//!
//! Latency: ~247ms (batch, LPU-accelerated)
//! RAM: 0 MB (cloud, no local model)
//! Cost: $0 on free tier, $0.04/hr on paid tier

use reqwest::Client;

const GROQ_STT_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL: &str = "whisper-large-v3-turbo";

/// Transcribe audio using Groq's Whisper Large v3 Turbo model.
///
/// Sends WAV audio (16kHz, mono, 16-bit) to Groq's OpenAI-compatible API.
/// Returns the transcript text on success, or an error string on failure.
///
/// # Arguments
/// * `samples` - Raw i16 PCM samples at 16kHz mono
/// * `api_key` - User's Groq API key (starts with "gsk_")
/// * `client` - Reused reqwest client (avoids per-call Client::build)
pub async fn transcribe_with_groq(
    samples: &[i16],
    api_key: &str,
    client: &Client,
) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("No Groq API key provided".to_string());
    }

    let wav_bytes = pcm_to_wav(samples, 16000);
    tracing::info!(
        "stt-groq: sending {} bytes ({}ms audio) to Groq",
        wav_bytes.len(),
        samples.len() / 16
    );

    let part = reqwest::multipart::Part::bytes(wav_bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("MIME error: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .text("model", GROQ_MODEL.to_string())
        .text("language", "en".to_string())
        .text("response_format", "json".to_string())
        .part("file", part);

    let start = std::time::Instant::now();

    let resp = client
        .post(GROQ_STT_URL)
        .bearer_auth(api_key)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Groq STT request failed: {}", e))?;

    let elapsed = start.elapsed();

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        // Check for rate limit (429) or auth error (401) for better error messages
        if status.as_u16() == 429 {
            return Err("Groq rate limit hit (2,000 req/day free tier)".to_string());
        }
        if status.as_u16() == 401 {
            return Err("Groq API key invalid — check Settings".to_string());
        }
        return Err(format!("Groq STT error {}: {}", status, body));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Groq response parse error: {}", e))?;

    let text = json
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    tracing::info!("stt-groq: transcript '{}' in {}ms", text, elapsed.as_millis());

    Ok(text)
}

/// Convert raw i16 PCM samples to a WAV file (16-bit, mono, given sample rate).
fn pcm_to_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let num_samples = samples.len();
    let data_size = num_samples * 2;
    let mut wav = Vec::with_capacity(44 + data_size);

    // RIFF header
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");

    // fmt chunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

    // data chunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_size as u32).to_le_bytes());

    for &s in samples {
        wav.extend_from_slice(&s.to_le_bytes());
    }

    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pcm_to_wav_header() {
        let samples = vec![0i16; 160]; // 10ms of audio at 16kHz
        let wav = pcm_to_wav(&samples, 16000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(wav.len(), 44 + 320); // 44 header + 160 samples * 2 bytes
    }

    #[test]
    fn test_empty_samples() {
        let samples: Vec<i16> = vec![];
        let wav = pcm_to_wav(&samples, 16000);
        assert_eq!(wav.len(), 44); // just the header
    }

    #[test]
    fn test_groq_url_constant() {
        assert!(GROQ_STT_URL.starts_with("https://api.groq.com"));
        assert!(GROQ_STT_URL.contains("/audio/transcriptions"));
    }

    #[test]
    fn test_groq_model_constant() {
        assert_eq!(GROQ_MODEL, "whisper-large-v3-turbo");
    }
}
