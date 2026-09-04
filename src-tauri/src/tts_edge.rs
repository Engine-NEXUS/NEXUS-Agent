//! edge-tts — Microsoft Edge Read Aloud TTS (cloud, free, no API key).
//!
//! Uses the edge-tts-rust crate which connects to Microsoft's WebSocket endpoint
//! and returns MP3 audio bytes. 400+ neural voices across 140+ locales.
//!
//! Latency: ~200ms (network + synthesis)
//! RAM: 0 MB (cloud, no local model)
//! Cost: $0 (free, no account, no API key)
//! Quality: Excellent (broadcast-quality neural voices)

use edge_tts_rust::{EdgeTtsClient, SpeakOptions, Boundary};

/// Synthesize text to MP3 bytes using edge-tts.
///
/// Returns raw MP3 audio bytes on success. The caller is responsible for
/// decoding MP3 to PCM samples for rodio playback.
///
/// # Arguments
/// * `text` - Text to synthesize (max ~4 KB per call)
/// * `voice` - Microsoft voice short-name (e.g. "en-US-AvaNeural")
pub async fn synthesize_to_mp3(
    text: &str,
    voice: &str,
) -> Result<Vec<u8>, String> {
    if text.is_empty() {
        return Err("Empty text".to_string());
    }

    let client = EdgeTtsClient::new()
        .map_err(|e| format!("edge-tts client init failed: {}", e))?;

    let result = client
        .synthesize(
            text,
            SpeakOptions {
                voice: voice.to_string(),
                boundary: Boundary::Sentence,
                ..SpeakOptions::default()
            },
        )
        .await
        .map_err(|e| format!("edge-tts synthesis failed: {}", e))?;

    tracing::info!(
        "tts-edge: synthesized '{}' ({} bytes MP3, voice={})",
        &text[..text.len().min(50)],
        result.audio.len(),
        voice
    );

    Ok(result.audio)
}

/// Synthesize text and decode MP3 to f32 PCM samples at the native sample rate.
///
/// Returns (samples, sample_rate) for direct rodio playback.
/// Uses rodio's Decoder for MP3 decoding.
pub async fn synthesize_to_pcm(
    text: &str,
    voice: &str,
) -> Result<(Vec<f32>, u32), String> {
    let mp3_bytes = synthesize_to_mp3(text, voice).await?;

    // Decode MP3 to f32 samples using rodio's decoder
    let cursor = std::io::Cursor::new(mp3_bytes);
    let source = rodio::Decoder::new(cursor)
        .map_err(|e| format!("MP3 decode failed: {}", e))?;

    // rodio Decoder is an Iterator of i16 samples; convert to f32
    let sample_rate = 24000; // edge-tts outputs 24kHz; rodio handles resampling
    let samples: Vec<f32> = source
        .map(|s: i16| s as f32 / i16::MAX as f32)
        .collect();

    tracing::info!(
        "tts-edge: decoded {} PCM samples ({}ms audio)",
        samples.len(),
        samples.len() as u64 * 1000 / sample_rate as u64
    );

    Ok((samples, sample_rate))
}

/// Check if edge-tts is reachable (network test).
pub async fn is_available() -> bool {
    // Quick connectivity test — try connecting to Microsoft's speech endpoint.
    // Uses reqwest to check if we can reach the internet at all.
    use std::time::Duration;

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    // Try to fetch the voice list from edge-tts endpoint
    // If this succeeds, edge-tts is available
    match client
        .get("https://speech.platform.bing.com/consumer/speech/synthesize/read-aloud/voices/list")
        .send()
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_edge_tts_module_loads() {
        // Just verify the module compiles and links
        let _ = std::hint::black_box(());
    }
}
