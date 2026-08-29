use crate::meeting_detect::MeetingState;
use kokoro_micro::TtsEngine;
use rodio::{buffer::SamplesBuffer, OutputStream, Sink};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::State;

pub struct TtsState {
    pub engine: Arc<Mutex<Option<TtsEngine>>>,
}

/// Global generation counter: incremented by `stop_tts` to signal the playback thread
/// to stop the current audio immediately. Using a generation counter prevents race
/// conditions where a new speech request clears a boolean flag before the previous
/// playback thread has polled it.
static TTS_GENERATION: AtomicUsize = AtomicUsize::new(0);

/// IPC: Stop any currently-playing TTS audio.
///
/// Increments a global generation counter that the playback thread in `speak_text` polls.
/// The playback thread calls `sink.stop()` and exits as soon as it sees a newer generation.
/// This provides near-instant barge-in when the user presses Ctrl+Space while NEXUS is speaking.
#[tauri::command]
pub fn stop_tts() -> Result<(), String> {
    TTS_GENERATION.fetch_add(1, Ordering::SeqCst);
    tracing::info!("tts: stop requested (generation {})", TTS_GENERATION.load(Ordering::SeqCst));
    Ok(())
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

    // Capture the current TTS generation. If stop_tts is called after this,
    // the global generation will increment and we will abort playback.
    let my_generation = TTS_GENERATION.load(Ordering::SeqCst);

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

    // Check if stop was requested DURING synthesis — if so, skip playback
    if TTS_GENERATION.load(Ordering::SeqCst) > my_generation {
        tracing::info!("tts: stop requested during synthesis, skipping playback");
        meeting.set_tts_playing(false);
        return Ok(());
    }

    // 3. Play audio using spawn_blocking so the tokio runtime can still
    //    process other commands (like stop_tts) while audio plays.
    //    The old code used std::thread::spawn().join() which BLOCKED the
    //    tokio worker thread, preventing stop_tts from executing.
    let play_result = tokio::task::spawn_blocking(move || {
        match OutputStream::try_default() {
            Ok((_stream, handle)) => {
                match Sink::try_new(&handle) {
                    Ok(sink) => {
                        // Kokoro output is standard 24kHz mono PCM (f32)
                        let source = SamplesBuffer::new(1, 24000, audio);
                        sink.append(source);

                        // Poll for stop request instead of sink.sleep_until_end()
                        // so the user can barge-in with Ctrl+Space.
                        while !sink.empty() {
                            if TTS_GENERATION.load(Ordering::SeqCst) > my_generation {
                                sink.stop();
                                tracing::info!("tts: playback stopped by user (barge-in)");
                                return Ok(());
                            }
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
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
    })
    .await
    .unwrap_or_else(|_| {
        tracing::error!("tts: audio thread panicked");
        Err("Audio thread panicked".to_string())
    });

    // 4. Grace period for acoustic settling before resuming wake word detection
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    meeting.set_tts_playing(false);

    play_result
}
