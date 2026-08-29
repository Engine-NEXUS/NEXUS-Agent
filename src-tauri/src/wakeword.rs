//! Wake-word engine using VAD + ASR + keyword matching.
//!
//! Pipeline:
//!   Microphone → cpal capture (native SR) → resample to 16kHz mono
//!   → Silero VAD detects speech segments
//!   → ASR (streaming Zipformer) transcribes each segment
//!   → Check if transcript contains "NEXUS"
//!   → If yes, trigger wake
//!
//! `mock-wake` feature: skip the engine entirely; only the global hotkey produces wakes.
//!
//! The wake word is "NEXUS", matched as a case-insensitive substring in the ASR transcript.
//! To change the wake word, just change the WAKE_WORD constant below — no model retraining.

use tauri::{AppHandle, Runtime};

/// The wake word to match in the ASR transcript.
const WAKE_WORD: &str = "nexus";

#[cfg(feature = "mock-wake")]
pub async fn run<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    tracing::info!("wake-word: mock mode (no native listener)");
    std::future::pending::<()>().await;
    Ok(())
}

#[cfg(not(feature = "mock-wake"))]
mod engine {
    use sherpa_onnx::{
        OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
        OnlineTransducerModelConfig, VoiceActivityDetector, VadModelConfig, SileroVadModelConfig,
    };
    use std::path::PathBuf;
    use std::sync::Arc;

    /// Resolve the sherpa resources directory. In production (bundled app),
    /// resources are in `resource_dir/sherpa/`. In dev mode, they're in
    /// `src-tauri/resources/sherpa/`.
    pub fn resolve_sherpa_dir(app_resource_dir: PathBuf) -> Option<PathBuf> {
        // 1. Production: resource_dir/sherpa
        let prod = app_resource_dir.join("sherpa");
        if prod.join("kws").join("tokens.txt").exists() {
            return Some(prod);
        }

        // 2. Dev mode: CARGO_MANIFEST_DIR/resources/sherpa
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let dev = PathBuf::from(manifest).join("resources").join("sherpa");
            if dev.join("kws").join("tokens.txt").exists() {
                return Some(dev);
            }
        }

        // 3. Dev mode fallback: exe_dir/../resources/sherpa
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let dev = dir.join("..").join("..").join("resources").join("sherpa");
                if dev.join("kws").join("tokens.txt").exists() {
                    return Some(dev.canonicalize().unwrap_or(dev));
                }
            }
        }

        None
    }

    /// VAD + ASR wake-word engine with optional speaker verification.
    ///
    /// VAD runs continuously on the audio stream. When it detects a speech segment,
    /// the segment is fed to ASR for transcription. If the transcript contains the
    /// wake word, the segment is also checked against the enrolled voice profile
    /// (if any). A wake event is emitted only if the speaker matches (or if no
    /// profile is enrolled — open mode).
    pub struct WakeEngine {
        pub vad: VoiceActivityDetector,
        pub asr: OnlineRecognizer,
        pub asr_stream: OnlineStream,
        pub speaker: Option<crate::voice_profile::SpeakerVerifier>,
        pub sample_rate: i32,
    }

    impl WakeEngine {
        pub fn new(resource_dir: PathBuf, app_data_dir: PathBuf) -> anyhow::Result<Self> {
            let sherpa_dir = resolve_sherpa_dir(resource_dir)
                .ok_or_else(|| anyhow::anyhow!(
                    "sherpa model files not found. Checked resource_dir/sherpa, CARGO_MANIFEST_DIR/resources/sherpa, and exe_dir/../resources/sherpa"
                ))?;

            let kws_dir = sherpa_dir.join("kws");
            let vad_model = sherpa_dir.join("silero_vad.onnx");
            let speaker_model = sherpa_dir.join("speaker_model.onnx");

            // Verify model files exist.
            // Prefer int8 (quantized) models for smaller size and faster inference.
            // Fall back to fp32 models if int8 is not available.
            let encoder = kws_dir.join("encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
            let encoder = if encoder.exists() { encoder } else { kws_dir.join("encoder-epoch-12-avg-2-chunk-16-left-64.onnx") };
            let decoder = kws_dir.join("decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
            let decoder = if decoder.exists() { decoder } else { kws_dir.join("decoder-epoch-12-avg-2-chunk-16-left-64.onnx") };
            let joiner = kws_dir.join("joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
            let joiner = if joiner.exists() { joiner } else { kws_dir.join("joiner-epoch-12-avg-2-chunk-16-left-64.onnx") };
            let tokens = kws_dir.join("tokens.txt");

            for (name, path) in [
                ("encoder", &encoder),
                ("decoder", &decoder),
                ("joiner", &joiner),
                ("tokens", &tokens),
                ("vad_model", &vad_model),
            ] {
                if !path.exists() {
                    anyhow::bail!("Model file '{}' not found at: {}", name, path.display());
                }
            }

            // --- VAD config ---
            // Silero VAD: window_size=512 for 16kHz (32ms windows).
            // threshold=0.5 (balanced), min_silence_duration=0.5s, max_speech_duration=10s.
            let vad_config = VadModelConfig {
                silero_vad: SileroVadModelConfig {
                    model: Some(vad_model.to_string_lossy().to_string()),
                    threshold: 0.5,
                    min_silence_duration: 0.5,
                    min_speech_duration: 0.25,
                    window_size: 512,
                    max_speech_duration: 10.0,
                },
                sample_rate: 16000,
                num_threads: 1,
                provider: Some("cpu".to_string()),
                ..Default::default()
            };

            let vad = VoiceActivityDetector::create(&vad_config, 60.0)
                .ok_or_else(|| anyhow::anyhow!("Failed to create Silero VAD"))?;

            // --- ASR config ---
            // Reuse the same Zipformer model (encoder/decoder/joiner/tokens) that
            // was originally downloaded for KWS. The ASR mode works correctly for
            // transcribing "NEXUS" — verified via Python testing.
            let asr_config = OnlineRecognizerConfig {
                model_config: OnlineModelConfig {
                    transducer: OnlineTransducerModelConfig {
                        encoder: Some(encoder.to_string_lossy().to_string()),
                        decoder: Some(decoder.to_string_lossy().to_string()),
                        joiner: Some(joiner.to_string_lossy().to_string()),
                    },
                    tokens: Some(tokens.to_string_lossy().to_string()),
                    num_threads: 1,
                    provider: Some("cpu".to_string()),
                    ..Default::default()
                },
                decoding_method: Some("greedy_search".to_string()),
                enable_endpoint: false,
                ..Default::default()
            };

            let asr = OnlineRecognizer::create(&asr_config)
                .ok_or_else(|| anyhow::anyhow!("Failed to create OnlineRecognizer"))?;

            let asr_stream = asr.create_stream();

            // --- Speaker verifier (optional) ---
            // If speaker_model.onnx exists, create a SpeakerVerifier.
            // If no voice profile is enrolled, the verifier accepts any speaker (open mode).
            // If a profile is enrolled, only the enrolled speaker can wake NEXUS.
            let speaker = if speaker_model.exists() {
                let profile_path = crate::voice_profile::resolve_profile_path(&app_data_dir);
                match crate::voice_profile::SpeakerVerifier::new(speaker_model, profile_path) {
                    Ok(v) => {
                        if v.has_profile() {
                            tracing::info!("Speaker verification enabled (voice profile loaded)");
                        } else {
                            tracing::info!("Speaker verification in open mode (no profile enrolled — any speaker can wake)");
                        }
                        Some(v)
                    }
                    Err(e) => {
                        tracing::warn!("Failed to init speaker verifier: {e}");
                        None
                    }
                }
            } else {
                tracing::warn!("Speaker model not found — speaker verification disabled");
                None
            };

            tracing::info!("VAD + ASR wake engine initialized (wake word: NEXUS)");

            Ok(WakeEngine {
                vad,
                asr,
                asr_stream,
                speaker,
                sample_rate: 16000,
            })
        }

        /// Process a chunk of 16kHz mono f32 audio.
        /// Returns true if the wake word "NEXUS" was detected and the speaker was accepted.
        pub fn process(&mut self, samples: &[f32]) -> bool {
            // Feed audio to VAD
            self.vad.accept_waveform(samples);

            // Check if VAD has detected a complete speech segment
            while !self.vad.is_empty() {
                if let Some(segment) = self.vad.front() {
                    let seg_samples = segment.samples();
                    let dur = seg_samples.len() as f32 / self.sample_rate as f32;
                    tracing::debug!(
                        "VAD: speech segment {} samples ({:.1}s)",
                        seg_samples.len(),
                        dur
                    );

                    // Skip very short segments (< 0.3s) — likely noise
                    if dur < 0.3 {
                        self.vad.pop();
                        continue;
                    }

                    // Feed the speech segment to ASR for transcription.
                    // Add 0.5s tail padding (silence) to help the ASR finalize.
                    let tail_padding = vec![0.0f32; (self.sample_rate as f32 * 0.5) as usize];
                    self.asr_stream.accept_waveform(self.sample_rate, seg_samples);
                    self.asr_stream.accept_waveform(self.sample_rate, &tail_padding);
                    self.asr_stream.input_finished();

                    // Decode all available frames
                    while self.asr.is_ready(&self.asr_stream) {
                        self.asr.decode(&self.asr_stream);
                    }

                    // Get the final transcript
                    if let Some(result) = self.asr.get_result(&self.asr_stream) {
                        let text = result.text.trim().to_lowercase();
                        if !text.is_empty() {
                            tracing::info!("ASR transcript: \"{}\"", text);

                            // Check against personalized wake variants + global sound-alikes.
                            // If a profile is enrolled, use its variants.
                            // If no profile (open mode), use default ["nexus"] + sound_alikes.
                            let wake_variants: Vec<String> = if let Some(ref verifier) = self.speaker {
                                verifier.profile()
                                    .map(|p| p.wake_variants.clone())
                                    .unwrap_or_else(|| vec!["nexus".to_string()])
                            } else {
                                vec!["nexus".to_string()]
                            };

                            if crate::voice_profile::matches_wake_word(&text, &wake_variants) {
                                tracing::info!(
                                    "Wake word match found in transcript: \"{}\"",
                                    text
                                );

                                // --- Speaker verification ---
                                // If a voice profile is enrolled, verify the speaker.
                                // If no profile is enrolled (open mode), accept any speaker.
                                // If speaker verification is disabled (no model), accept.
                                let accepted = if let Some(ref verifier) = self.speaker {
                                    match verifier.verify(seg_samples) {
                                        Ok((matched, score)) => {
                                            if matched {
                                                tracing::info!(
                                                    "Speaker accepted (score: {:.3})",
                                                    score
                                                );
                                                true
                                            } else {
                                                tracing::info!(
                                                    "Speaker REJECTED (score: {:.3} below threshold)",
                                                    score
                                                );
                                                false
                                            }
                                        }
                                        Err(e) => {
                                            tracing::warn!(
                                                "Speaker verification failed, accepting: {e}"
                                            );
                                            true // fail-open: don't block wake on verifier errors
                                        }
                                    }
                                } else {
                                    true
                                };

                                // Reset stream for next segment
                                self.asr.reset(&self.asr_stream);
                                self.vad.pop();
                                return accepted;
                            }
                        }
                    }

                    // Reset stream for next segment
                    self.asr.reset(&self.asr_stream);
                    self.vad.pop();
                } else {
                    break;
                }
            }

            false
        }
    }

    /// Resampler state: fractional read cursor + carry buffer of native mono samples.
    pub struct ResampleState {
        pub ratio: f64,
        pub frac: f64,
        pub carry: Vec<f32>,
    }

    impl ResampleState {
        pub fn new(native_sr: u32, target_sr: u32) -> Self {
            Self {
                ratio: native_sr as f64 / target_sr as f64,
                frac: 0.0,
                carry: Vec::with_capacity(4096),
            }
        }
    }

    /// Generic audio callback: downmix to mono (f32), append to resampler carry, linearly
    /// resample to 16 kHz, and feed 512-sample chunks (32ms at 16kHz) to the VAD.
    ///
    /// Silero VAD requires exactly 512 samples per call at 16kHz.
    pub fn on_audio<T, F>(
        data: &[T],
        native_channels: usize,
        state: &Arc<parking_lot::Mutex<ResampleState>>,
        out_buf: &Arc<parking_lot::Mutex<Vec<f32>>>,
        engine: &Arc<parking_lot::Mutex<WakeEngine>>,
        vad_window: usize,
        to_f32: F,
        wake_tx: &tokio::sync::mpsc::UnboundedSender<()>,
    )
    where
        F: Fn(T) -> f32,
        T: Copy,
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        static CALLBACK_COUNT: AtomicU64 = AtomicU64::new(0);
        static SAMPLE_COUNT: AtomicU64 = AtomicU64::new(0);

        let n = CALLBACK_COUNT.fetch_add(1, Ordering::Relaxed);
        let samples_in = data.len() / native_channels.max(1);
        SAMPLE_COUNT.fetch_add(samples_in as u64, Ordering::Relaxed);

        if n % 200 == 0 && n > 0 {
            let total = SAMPLE_COUNT.load(Ordering::Relaxed);
            tracing::debug!(
                "audio: {} callbacks, ~{:.1}s of audio processed",
                n, total as f64 / 16000.0
            );
        }

        // 1. Downmix to mono f32 and append to the resampler carry buffer.
        {
            let mut st = state.lock();
            let ch = native_channels.max(1);
            let frames = data.len() / ch;
            for i in 0..frames {
                let mut sum = 0.0f32;
                for c in 0..ch {
                    sum += to_f32(data[i * ch + c]);
                }
                st.carry.push(sum / ch as f32);
            }
        }

        // 2. Resample from native_sr -> 16 kHz via linear interpolation.
        let mut produced: Vec<f32> = Vec::with_capacity(vad_window);
        {
            let mut st = state.lock();
            let ratio = st.ratio;
            let mut pos = st.frac;
            while pos + ratio < st.carry.len() as f64 {
                let idx0 = pos.floor() as usize;
                let idx1 = (idx0 + 1).min(st.carry.len() - 1);
                let t = pos - idx0 as f64;
                let s = st.carry[idx0] as f64 * (1.0 - t) + st.carry[idx1] as f64 * t;
                produced.push(s as f32);
                pos += ratio;
            }
            let consumed = pos.floor() as usize;
            st.carry.drain(0..consumed);
            st.frac = pos - consumed as f64;
        }

        // 3. Accumulate resampled f32 samples and feed 512-sample chunks to the engine.
        // Silero VAD at 16kHz requires exactly 512 samples per accept_waveform call.
        {
            let mut buf = out_buf.lock();
            buf.extend(produced);
            while buf.len() >= vad_window {
                let chunk: Vec<f32> = buf.drain(0..vad_window).collect();
                let mut eng = engine.lock();
                if eng.process(&chunk) {
                    let _ = wake_tx.send(());
                }
            }
        }
    }
}

#[cfg(not(feature = "mock-wake"))]
use once_cell::sync::OnceCell;
#[cfg(not(feature = "mock-wake"))]
static WAKE_TX: OnceCell<tokio::sync::mpsc::UnboundedSender<()>> = OnceCell::new();

#[cfg(not(feature = "mock-wake"))]
pub async fn run<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri::Manager;

    let res = app.path().resource_dir().map_err(|e| format!("resource dir: {e}"))?;
    let data_dir = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create app data dir: {e}"))?;

    let engine = std::sync::Arc::new(parking_lot::Mutex::new(
        engine::WakeEngine::new(res, data_dir)
            .map_err(|e| format!("wake engine init: {e}"))?,
    ));

    // Set the wake channel BEFORE starting audio capture.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let _ = WAKE_TX.set(tx);

    // Start audio capture.
    start_audio_capture(engine)?;

    while rx.recv().await.is_some() {
        // Debounce: ignore detections within 2 seconds of the last wake.
        static LAST_WAKE: once_cell::sync::Lazy<std::sync::Mutex<std::time::Instant>> =
            once_cell::sync::Lazy::new(|| {
                std::sync::Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(10))
            });
        {
            let mut last = LAST_WAKE.lock().unwrap();
            let elapsed = last.elapsed();
            if elapsed < std::time::Duration::from_secs(2) {
                tracing::debug!("wake debounced ({}ms since last)", elapsed.as_millis());
                continue;
            }
            *last = std::time::Instant::now();
        }

        tracing::info!("wake-word: NEXUS detected → triggering wake");

        // Show the overlay window and call the frontend wake handler.
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = crate::window_manager::position_orb(&win);
            let _ = win.set_focus();
            let _ = win.set_always_on_top(true);
            let _ = win.set_ignore_cursor_events(false);
            let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
        }
    }
    Ok(())
}

/// Start audio capture with cpal. Captures at the device's native sample rate
/// and resamples to 16kHz mono for the VAD + ASR pipeline.
#[cfg(not(feature = "mock-wake"))]
fn start_audio_capture(engine: std::sync::Arc<parking_lot::Mutex<engine::WakeEngine>>) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::Sample;

    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| "no input device".to_string())?;

    tracing::info!(
        "audio: input device = '{}', host = '{}'",
        device.name().unwrap_or_else(|_| "unknown".into()),
        host.id().name()
    );

    let default_config = device
        .default_input_config()
        .map_err(|e| format!("default_input_config: {e}"))?;

    tracing::info!(
        "audio: native sample_rate = {} Hz, channels = {}, format = {:?}",
        default_config.sample_rate().0,
        default_config.channels(),
        default_config.sample_format()
    );

    let target_sr = engine.lock().sample_rate as u32; // 16000
    let native_sr = default_config.sample_rate().0;
    let native_channels = default_config.channels() as usize;

    let sample_format = default_config.sample_format();
    let stream_config = cpal::StreamConfig {
        channels: default_config.channels(),
        sample_rate: default_config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    // Silero VAD at 16kHz requires 512 samples per call (32ms windows).
    let vad_window = 512;

    let state = std::sync::Arc::new(parking_lot::Mutex::new(engine::ResampleState::new(native_sr, target_sr)));
    let out_buf = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<f32>::with_capacity(1024)));
    let engine_cb = engine;
    let wake_tx = WAKE_TX.get().cloned();

    let err_cb = |err| tracing::error!("audio stream error: {err}");

    let build_result = match sample_format {
        cpal::SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
            &stream_config,
            {
                let state = state.clone();
                let out_buf = out_buf.clone();
                let wake_tx = wake_tx.clone();
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if let Some(tx) = &wake_tx {
                        engine::on_audio(data, native_channels, &state, &out_buf, &engine_cb, vad_window, |s: i16| s.to_sample::<f32>(), tx);
                    }
                }
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream::<i32, _, _>(
            &stream_config,
            {
                let state = state.clone();
                let out_buf = out_buf.clone();
                let wake_tx = wake_tx.clone();
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    if let Some(tx) = &wake_tx {
                        engine::on_audio(data, native_channels, &state, &out_buf, &engine_cb, vad_window, |s: i32| s.to_sample::<f32>(), tx);
                    }
                }
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
            &stream_config,
            {
                let state = state.clone();
                let out_buf = out_buf.clone();
                let wake_tx = wake_tx.clone();
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if let Some(tx) = &wake_tx {
                        engine::on_audio(data, native_channels, &state, &out_buf, &engine_cb, vad_window, |s: f32| s, tx);
                    }
                }
            },
            err_cb,
            None,
        ),
        other => return Err(format!("unsupported sample format: {other:?}")),
    };

    let stream = build_result.map_err(|e| format!("build stream: {e}"))?;
    stream.play().map_err(|e| format!("play stream: {e}"))?;
    tracing::info!("audio: stream started, VAD listening for speech...");
    std::mem::forget(stream);
    Ok(())
}
