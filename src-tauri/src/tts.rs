use crate::meeting_detect::MeetingState;
use kokoro_micro::TtsEngine;
use rodio::{buffer::SamplesBuffer, OutputStream, Sink};
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;

pub struct TtsState {
    pub engine: Arc<Mutex<Option<TtsEngine>>>,
}

#[tauri::command]
pub async fn speak_text(
    text: String,
    voice: Option<String>,
    speed: Option<f32>,
    state: State<'_, TtsState>,
    meeting: State<'_, Arc<MeetingState>>,
) -> Result<(), String> {
    tracing::info!("tts: speaking '{}'", text);
    
    // 1. Mark TTS as playing to suppress wake word self-trigger
    meeting.set_tts_playing(true);

    // 2. Synthesize audio on a blocking thread to avoid starving the tokio runtime.
    // Note: kokoro-micro internally multiplies speed by 0.65 (SPEED_SCALE = 0.65), which
    // causes normal speech (1.0 or 1.15) to sound drastically slowed down (0.65x - 0.75x speed).
    // We compensate here by dividing the target speed by 0.65 so that the Kokoro
    // neural network receives the true target speed (1.0 = normal, 1.15 = assistant).
    let engine_arc = state.engine.clone();
    let voice_id = match voice.as_deref() {
        Some("default") | None => "af_sky".to_string(),
        Some(v) => v.to_string(),
    };
    let spd = speed.unwrap_or(1.15);
    const KOKORO_INTERNAL_SPEED_SCALE: f32 = 0.65;
    let engine_spd = (spd / KOKORO_INTERNAL_SPEED_SCALE).clamp(0.5, 3.0);

    let audio = tokio::task::spawn_blocking(move || {
        let mut lock = engine_arc.blocking_lock();
        if let Some(engine) = lock.as_mut() {
            engine
                .synthesize_with_options(&text, Some(&voice_id), engine_spd, 1.0, Some("en"))
                .map_err(|e| format!("TTS synthesis error: {}", e))
        } else {
            Err("TTS Engine not initialized".to_string())
        }
    })
    .await
    .map_err(|e| format!("TTS task panicked: {}", e))??;

    // 3. Play audio on a blocking thread (rodio needs the OutputStream to stay alive)
    let play_result = std::thread::spawn(move || {
        match OutputStream::try_default() {
            Ok((_stream, handle)) => {
                match Sink::try_new(&handle) {
                    Ok(sink) => {
                        // Kokoro output is standard 24kHz mono PCM (f32)
                        let source = SamplesBuffer::new(1, 24000, audio);
                        sink.append(source);
                        sink.sleep_until_end();
                        tracing::info!("tts: audio playback completed");
                        Ok(())
                    }
                    Err(e) => {
                        tracing::error!("tts: failed to create audio sink: {}", e);
                        Err(format!("Failed to create audio sink: {}", e))
                    }
                }
            }
            Err(e) => {
                tracing::error!("tts: failed to open default audio output: {}", e);
                Err(format!("Failed to get audio output stream: {}", e))
            }
        }
    }).join().unwrap_or_else(|_| {
        tracing::error!("tts: audio thread panicked");
        Err("Audio thread panicked".to_string())
    });

    // 4. Grace period for acoustic settling before resuming wake word detection
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    meeting.set_tts_playing(false);

    play_result
}
