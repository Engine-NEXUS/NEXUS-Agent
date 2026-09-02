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

/// Lazily initialize the Kokoro TTS engine on first use.
/// Called from `speak_text` when the engine is `None`.
/// Saves ~350 MB RAM at idle by not loading Kokoro at boot.
/// First TTS call takes ~1.7s extra (one-time model load); subsequent calls are instant.
async fn ensure_engine_loaded(engine_arc: &Arc<Mutex<Option<TtsEngine>>>) -> Result<(), String> {
    // Fast path: already loaded
    if engine_arc.lock().await.is_some() {
        return Ok(());
    }

    tracing::info!("tts: lazy-loading Kokoro engine on first speak...");
    let start_time = std::time::Instant::now();

    // Set espeak-ng data path for kokoro-micro's espeak-rs dependency.
    let mut custom_model_path: Option<(std::path::PathBuf, std::path::PathBuf)> = None;
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let espeak_parent = exe_dir.join("resources");
            if espeak_parent.join("espeak-ng-data").exists() {
                std::env::set_var("PIPER_ESPEAKNG_DATA_DIRECTORY", &espeak_parent);
                tracing::info!("tts: espeak-ng data path set to {}", espeak_parent.display());
            }

            let res_model = exe_dir.join("resources").join("kokoro").join("0.onnx");
            let res_voices = exe_dir.join("resources").join("kokoro").join("0.bin");
            if res_model.exists() && res_voices.exists() {
                custom_model_path = Some((res_model, res_voices));
            }
        }
    }

    let engine_result = match custom_model_path {
        Some((m, v)) => {
            tracing::info!("tts: loading Kokoro models from resources: {}", m.display());
            kokoro_micro::TtsEngine::with_paths(
                m.to_str().unwrap_or("0.onnx"),
                v.to_str().unwrap_or("0.bin"),
            )
            .await
        }
        None => kokoro_micro::TtsEngine::new().await,
    };

    match engine_result {
        Ok(engine) => {
            *engine_arc.lock().await = Some(engine);
            tracing::info!(
                "tts: Kokoro engine lazy-loaded in {:.2}s",
                start_time.elapsed().as_secs_f32()
            );
            Ok(())
        }
        Err(e) => {
            tracing::error!("tts: failed to lazy-init Kokoro: {}", e);
            Err(format!("TTS engine init failed: {}", e))
        }
    }
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

    // 2. Lazy-load Kokoro engine on first speak (saves ~350 MB at idle).
    //    First call: ~1.7s model load. Subsequent calls: instant (fast path).
    let engine_arc = state.engine.clone();
    ensure_engine_loaded(&engine_arc).await?;
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
