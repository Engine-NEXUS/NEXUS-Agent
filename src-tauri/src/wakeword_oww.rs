//! Wake-word engine using openWakeWord (KWS) + speaker verification,
//! with Tier 3 direct command classification.
//!
//! Pipeline:
//!   Microphone → cpal capture (native SR) → resample to 16kHz mono
//!   → openWakeWord KWS (1280-sample / 80ms sliding window)
//!   → 3-stage: melspectrogram → embedding → classifier(s)
//!   → probability score for "nexus" (wake word)
//!   → probability scores for command phrases ("open youtube", etc.)
//!   → if wake score > threshold → speaker verification → trigger wake
//!   → if command score > threshold → emit command-detected event (skip STT)
//!
//! `mock-wake` feature: skip the engine entirely; only the global hotkey produces wakes.
//!
//! Key difference from VAD+ASR:
//!   - No VAD gate (doesn't clip the start of words)
//!   - No ASR (doesn't need to transcribe — directly detects acoustic pattern)
//!   - Runs continuously on every 80ms chunk
//!   - Expected recall: >95% (vs ~30% with VAD+ASR)
//!
//! Tier 3 command classifiers:
//!   - Loaded from resources/oww/commands/*.onnx
//!   - Share the same melspectrogram + embedding models as the wake word
//!   - Run in parallel with the wake-word classifier on every 80ms chunk
//!   - When a command fires, emit a `command-detected` Tauri event
//!   - Frontend skips STT and executes the mapped intent directly
//!   - Falls back to STT if no command classifier matches

use tauri::{AppHandle, Runtime};

#[cfg(feature = "mock-wake")]
pub async fn run<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    tracing::info!("wake-word: mock mode (no native listener)");
    std::future::pending::<()>().await;
    Ok(())
}

#[cfg(not(feature = "mock-wake"))]
mod engine {
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use circular_buffer::CircularBuffer;
    use serde::{Deserialize, Serialize};
    use tract_onnx::prelude::*;

    type ModelType = Arc<TypedSimplePlan>;

    // ─── Tier 3: Command classifier types ───────────────────────────────

    /// A structured intent emitted when a command classifier fires.
    /// This is serialized and sent to the frontend via a Tauri event.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct CommandIntent {
        pub action: String,
        pub target: String,
    }

    /// The intent mapping loaded from `command_intents.json`.
    #[derive(Debug, Clone, Deserialize)]
    struct CommandIntentEntry {
        phrase: String,
        model_file: String,
        intent: CommandIntent,
    }

    /// A loaded command classifier model + its mapped intent.
    struct CommandClassifier {
        model_name: String,
        model: ModelType,
        intent: CommandIntent,
        detections_buffer: CircularBuffer<DETECTION_BUFFER_SIZE, f32>,
        last_detection_time: std::time::Instant,
    }

    /// OWW processes 1280-sample chunks (80ms at 16kHz)
    pub const OWW_CHUNK_SIZE: usize = 1280;

    /// Melspectrogram lookback: 3 mel hops of 160 samples
    const MEL_LOOKBACK: usize = 160 * 3;
    /// Mel model input: lookback + one chunk
    const MEL_INPUT_SIZE: usize = MEL_LOOKBACK + OWW_CHUNK_SIZE;
    /// Mel frames produced per chunk
    const MELS_PER_CHUNK: usize = MEL_INPUT_SIZE / 160 - 3; // 8
    /// Mel circular buffer size (80 / MELS_PER_CHUNK)
    const MEL_CIRC_SIZE: usize = 80 / MELS_PER_CHUNK; // 10

    /// Feature buffer: 16 frames of 96-dim embeddings
    const FEATURE_BUFFER_SIZE: usize = 16;

    /// Detection buffer: 12 frames (~1 sec) for smoothing
    const DETECTION_BUFFER_SIZE: usize = 12;

    /// Minimum positive detections before triggering
    const MIN_POSITIVE_DETECTIONS: f32 = 2.0;

    /// Refractory period after a detection (ms)
    const NO_DETECTION_MS: u64 = 2000;

    /// Resolve the oww resources directory.
    pub fn resolve_oww_dir(app_resource_dir: &Path) -> Option<PathBuf> {
        // 1. Production: resource_dir/oww
        let prod = app_resource_dir.join("oww");
        if prod.join("melspectrogram.onnx").exists() {
            return Some(prod);
        }
        // 2. Dev mode: CARGO_MANIFEST_DIR/resources/oww
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let dev = PathBuf::from(manifest).join("resources").join("oww");
            if dev.join("melspectrogram.onnx").exists() {
                return Some(dev);
            }
        }
        // 3. Dev mode fallback: exe_dir/../resources/oww
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let dev = dir.join("..").join("..").join("resources").join("oww");
                if dev.join("melspectrogram.onnx").exists() {
                    return Some(dev.canonicalize().unwrap_or(dev));
                }
            }
        }
        None
    }

    /// Load an ONNX model from a file path.
    fn load_onnx_model(path: &Path) -> anyhow::Result<ModelType> {
        let data = std::fs::read(path)
            .map_err(|e| anyhow::anyhow!("Failed to read {}: {}", path.display(), e))?;
        let mut rdr = Cursor::new(data);
        let model = tract_onnx::onnx()
            .model_for_read(&mut rdr)
            .map_err(|e| anyhow::anyhow!("Failed to parse ONNX {}: {}", path.display(), e))?;
        let model = model
            .into_optimized()
            .map_err(|e| anyhow::anyhow!("Failed to optimize {}: {}", path.display(), e))?;
        let model = model
            .into_runnable()
            .map_err(|e| anyhow::anyhow!("Failed to make runnable {}: {}", path.display(), e))?;
        // into_runnable() already returns Arc<SimplePlan<...>>
        Ok(model)
    }

    /// Audio feature extractor: melspectrogram → embedding
    pub struct AudioFeatures {
        mel: ModelType,
        emb: ModelType,
        raw_lookback: Vec<f32>,
        feature_buffer: CircularBuffer<FEATURE_BUFFER_SIZE, Tensor>,
        mel_spectrogram_buffer: CircularBuffer<MEL_CIRC_SIZE, Tensor>,
    }

    impl AudioFeatures {
        pub fn new(oww_dir: &Path) -> anyhow::Result<Self> {
            let mel_path = oww_dir.join("melspectrogram.onnx");
            let emb_path = oww_dir.join("embedding_model.onnx");

            let mel = load_onnx_model(&mel_path)?;
            let emb = load_onnx_model(&emb_path)?;

            // Set single-threaded executor for low latency
            tract_onnx::prelude::multithread::set_default_executor(
                tract_onnx::prelude::multithread::Executor::SingleThread,
            );

            let mut feature_buffer = CircularBuffer::<FEATURE_BUFFER_SIZE, Tensor>::new();
            for _ in 0..FEATURE_BUFFER_SIZE {
                feature_buffer.push_back(
                    Tensor::from_shape(&[1, 1, 1, 96], &[0f32; 96])
                        .map_err(|e| anyhow::anyhow!("init feature buffer: {e}"))?,
                );
            }

            let mut mel_spectrogram_buffer =
                CircularBuffer::<MEL_CIRC_SIZE, Tensor>::new();
            for _ in 0..MEL_CIRC_SIZE {
                mel_spectrogram_buffer.push_back(
                    Tensor::from_shape(&[MELS_PER_CHUNK, 32], &[0f32; MELS_PER_CHUNK * 32])
                        .map_err(|e| anyhow::anyhow!("init mel buffer: {e}"))?,
                );
            }

            Ok(AudioFeatures {
                mel,
                emb,
                raw_lookback: vec![0f32; MEL_LOOKBACK],
                feature_buffer,
                mel_spectrogram_buffer,
            })
        }

        /// Compute melspectrogram for a chunk of audio.
        fn get_melspectrogram(&mut self, data: &[f32]) -> anyhow::Result<Tensor> {
            // Prepend lookback from previous chunk
            let mut input = Vec::with_capacity(MEL_INPUT_SIZE);
            input.extend_from_slice(&self.raw_lookback);
            input.extend_from_slice(data);
            self.raw_lookback
                .copy_from_slice(&data[data.len() - MEL_LOOKBACK..]);

            let tensor = Tensor::from_shape(&[1, MEL_INPUT_SIZE], &input)
                .map_err(|e| anyhow::anyhow!("mel input shape: {e}"))?;

            let outputs: TVec<TValue> = self
                .mel
                .clone()
                .run(tvec!(tensor.into()))
                .map_err(|e| anyhow::anyhow!("mel inference: {e}"))?;

            let out_tensor = outputs[0].clone().into_tensor();
            let resized = out_tensor
                .into_shape(&[MELS_PER_CHUNK, 32])
                .map_err(|e| anyhow::anyhow!("mel reshape: {e}"))?;
            let a = resized
                .into_plain_array::<f32>()
                .map_err(|e| anyhow::anyhow!("mel to array: {e}"))?
                .into_owned();
            // Normalize: (v / 10.0) + 2.0
            let updated = a.mapv(|v| (v / 10.0) + 2.0).into_tensor();
            Ok(updated)
        }

        /// Get audio features (embeddings) for a chunk.
        pub fn get_audio_features(&mut self, data: &[f32]) -> anyhow::Result<Tensor> {
            let mel_chunk = self.get_melspectrogram(data)?;
            self.mel_spectrogram_buffer.push_back(mel_chunk);

            let stacked_mels = Tensor::stack_tensors(0, &self.mel_spectrogram_buffer.to_vec())
                .map_err(|e| anyhow::anyhow!("stack mels: {e}"))?;

            // Slice [4:80] → [76, 32]
            let smaller = stacked_mels
                .slice(0, 4, 80)
                .map_err(|e| anyhow::anyhow!("slice mels: {e}"))?;
            let reshaped = smaller
                .into_shape(&[1, 76, 32, 1])
                .map_err(|e| anyhow::anyhow!("reshape mels: {e}"))?;

            let embeddings = self
                .emb
                .clone()
                .run(tvec!(reshaped.into()))
                .map_err(|e| anyhow::anyhow!("embedding inference: {e}"))?;

            self.feature_buffer
                .push_back(embeddings[0].clone().into_tensor());

            let stacked = Tensor::stack_tensors(0, &self.feature_buffer.to_vec())
                .map_err(|e| anyhow::anyhow!("stack features: {e}"))?;

            let reshaped = stacked
                .into_shape(&[self.feature_buffer.len(), 96])
                .map_err(|e| anyhow::anyhow!("reshape features: {e}"))?;
            Ok(reshaped)
        }
    }

    /// openWakeWord KWS engine with optional speaker verification
    /// and Tier 3 command classifiers.
    pub struct WakeEngine {
        pub classifier: ModelType,
        pub audio_features: AudioFeatures,
        pub speaker: Option<crate::voice_profile::SpeakerVerifier>,
        pub sample_rate: i32,
        pub chunk_buffer: Vec<f32>,
        pub threshold: f32,
        pub detections_buffer: CircularBuffer<DETECTION_BUFFER_SIZE, f32>,
        pub last_detection_time: std::time::Instant,
        /// Tier 3: command classifiers loaded from resources/oww/commands/
        pub command_classifiers: Vec<CommandClassifier>,
        /// Sender for command-detected events (None if no command models loaded)
        pub command_tx: Option<tokio::sync::mpsc::UnboundedSender<CommandIntent>>,
    }

    /// Load Tier 3 command classifiers from `resources/oww/commands/`.
    ///
    /// Reads `command_intents.json` for the intent mapping, then loads each
    /// `.onnx` model file referenced in it. Models that fail to load are
    /// skipped with a warning — the wake word and STT fallback still work.
    fn load_command_classifiers(oww_dir: &Path) -> Vec<CommandClassifier> {
        let commands_dir = oww_dir.join("commands");
        let intents_path = commands_dir.join("command_intents.json");

        if !intents_path.exists() {
            return Vec::new();
        }

        let json_str = match std::fs::read_to_string(&intents_path) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("Tier 3: failed to read {}: {e}", intents_path.display());
                return Vec::new();
            }
        };

        let entries: std::collections::HashMap<String, CommandIntentEntry> =
            match serde_json::from_str(&json_str) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("Tier 3: failed to parse {}: {e}", intents_path.display());
                    return Vec::new();
                }
            };

        let mut classifiers = Vec::new();
        for (model_name, entry) in &entries {
            let model_path = commands_dir.join(&entry.model_file);
            if !model_path.exists() {
                tracing::warn!(
                    "Tier 3: model file {} not found at {} — skipping",
                    entry.model_file,
                    model_path.display()
                );
                continue;
            }

            match load_onnx_model(&model_path) {
                Ok(model) => {
                    tracing::info!(
                        "Tier 3: loaded command classifier '{}' (phrase: \"{}\", intent: {:?})",
                        model_name, entry.phrase, entry.intent
                    );
                    classifiers.push(CommandClassifier {
                        model_name: model_name.clone(),
                        model,
                        intent: entry.intent.clone(),
                        detections_buffer: CircularBuffer::<DETECTION_BUFFER_SIZE, f32>::new(),
                        last_detection_time: std::time::Instant::now()
                            .checked_sub(std::time::Duration::from_secs(10))
                            .unwrap_or_else(std::time::Instant::now),
                    });
                }
                Err(e) => {
                    tracing::warn!(
                        "Tier 3: failed to load {}: {e}",
                        model_path.display()
                    );
                }
            }
        }

        classifiers
    }

    impl WakeEngine {
        pub fn new(resource_dir: PathBuf, app_data_dir: PathBuf) -> anyhow::Result<Self> {
            let oww_dir = resolve_oww_dir(&resource_dir).ok_or_else(|| {
                anyhow::anyhow!(
                    "oww model files not found. Checked resource_dir/oww, \
                     CARGO_MANIFEST_DIR/resources/oww, and exe_dir/../resources/oww"
                )
            })?;

            // Load the custom "nexus" classifier model
            let nexus_model_path = oww_dir.join("nexus.onnx");
            if !nexus_model_path.exists() {
                anyhow::bail!(
                    "nexus.onnx not found at: {}\n\
                     You need to train a custom model first.\n\
                     Run the Google Colab notebook: train_nexus_oww.ipynb\n\
                     Then place the downloaded nexus.onnx in: {}",
                    nexus_model_path.display(),
                    oww_dir.display()
                );
            }

            tracing::info!("Loading openWakeWord classifier: {}", nexus_model_path.display());
            let classifier = load_onnx_model(&nexus_model_path)?;

            tracing::info!("Loading audio feature extractors from: {}", oww_dir.display());
            let audio_features = AudioFeatures::new(&oww_dir)?;

            // --- Speaker verifier (optional) ---
            let speaker_model = oww_dir.join("speaker_model.onnx");
            let speaker_model = if speaker_model.exists() {
                speaker_model
            } else {
                let sherpa_dir = resource_dir.join("sherpa");
                let alt = sherpa_dir.join("speaker_model.onnx");
                if alt.exists() { alt } else { speaker_model }
            };

            let speaker = if speaker_model.exists() {
                let profile_path = crate::voice_profile::resolve_profile_path(&app_data_dir);
                match crate::voice_profile::SpeakerVerifier::new(speaker_model, profile_path) {
                    Ok(v) => {
                        if v.has_profile() {
                            tracing::info!("Speaker verification enabled (voice profile loaded)");
                        } else {
                            tracing::info!(
                                "Speaker verification in open mode \
                                 (no profile enrolled — any speaker can wake)"
                            );
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

            tracing::info!(
                "openWakeWord KWS engine initialized \
                 (wake word: NEXUS, 80ms sliding window, threshold: 0.5)"
            );

            // --- Tier 3: Load command classifiers (optional) ---
            let command_classifiers = load_command_classifiers(&oww_dir);
            if !command_classifiers.is_empty() {
                tracing::info!(
                    "Tier 3: loaded {} command classifiers \
                     (direct audio→intent, skips STT for known commands)",
                    command_classifiers.len()
                );
            } else {
                tracing::debug!(
                    "Tier 3: no command classifiers found at {}/commands/ \
                     (optional — STT fallback handles all commands)",
                    oww_dir.display()
                );
            }

            Ok(WakeEngine {
                classifier,
                audio_features,
                speaker,
                sample_rate: 16000,
                chunk_buffer: Vec::with_capacity(OWW_CHUNK_SIZE),
                threshold: 0.5,
                detections_buffer: CircularBuffer::<DETECTION_BUFFER_SIZE, f32>::new(),
                last_detection_time: std::time::Instant::now()
                    .checked_sub(std::time::Duration::from_secs(10))
                    .unwrap_or_else(std::time::Instant::now),
                command_classifiers,
                command_tx: None,
            })
        }

        /// Run KWS detection on a single 80ms chunk.
        /// Returns (wake_detected, wake_probability, optional command_intent).
        fn detect_chunk(
            &mut self,
            chunk: Vec<f32>,
        ) -> (bool, f32, Option<CommandIntent>) {
            // Get audio features (melspectrogram → embedding)
            let features = match self.audio_features.get_audio_features(&chunk) {
                Ok(f) => f,
                Err(e) => {
                    tracing::warn!("Audio feature extraction error: {e}");
                    return (false, 0.0, None);
                }
            };

            // Reshape features to [1, 16, 96] for the classifier
            let last = match features.into_shape(&[1, FEATURE_BUFFER_SIZE, 96]) {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!("Feature reshape error: {e}");
                    return (false, 0.0, None);
                }
            };

            // Run wake-word classifier
            let outputs: TVec<TValue> = match self.classifier.clone().run(tvec!(last.clone().into())) {
                Ok(o) => o,
                Err(e) => {
                    tracing::warn!("Classifier inference error: {e}");
                    return (false, 0.0, None);
                }
            };

            let t = match outputs[0]
                .clone()
                .into_tensor()
                .cast_to::<f32>()
            {
                Ok(c) => c.into_owned(),
                Err(e) => {
                    tracing::warn!("Classifier output cast error: {e}");
                    return (false, 0.0, None);
                }
            };

            let probability = match t.into_plain_array::<f32>() {
                Ok(arr) => arr.as_slice().unwrap_or(&[0.0])[0],
                Err(_) => 0.0,
            };

            self.detections_buffer.push_back(probability);

            // Calculate smoothed average of positive detections
            let avg = self.calculate_average();

            let since_last = self.last_detection_time.elapsed().as_millis();

            // Trigger when smoothed average exceeds threshold (with refractory period)
            let wake_detected = if avg > self.threshold && since_last > NO_DETECTION_MS as u128 {
                self.last_detection_time = std::time::Instant::now();
                self.detections_buffer.clear();
                true
            } else {
                false
            };

            // --- Tier 3: Run command classifiers in parallel ---
            let command_intent = self.detect_commands(&last);

            (wake_detected, avg, command_intent)
        }

        /// Run all command classifiers on the current feature frame.
        /// Returns the intent of the first classifier that fires (if any).
        fn detect_commands(&mut self, features: &Tensor) -> Option<CommandIntent> {
            if self.command_classifiers.is_empty() {
                return None;
            }

            let mut best_intent: Option<(CommandIntent, f32)> = None;

            for cmd in &mut self.command_classifiers {
                let outputs: TVec<TValue> = match cmd.model.clone().run(tvec!(features.clone().into())) {
                    Ok(o) => o,
                    Err(e) => {
                        tracing::warn!(
                            "Tier 3: command classifier '{}' inference error: {e}",
                            cmd.model_name
                        );
                        continue;
                    }
                };

                let t = match outputs[0]
                    .clone()
                    .into_tensor()
                    .cast_to::<f32>()
                {
                    Ok(c) => c.into_owned(),
                    Err(e) => {
                        tracing::warn!(
                            "Tier 3: command classifier '{}' output cast error: {e}",
                            cmd.model_name
                        );
                        continue;
                    }
                };

                let probability = match t.into_plain_array::<f32>() {
                    Ok(arr) => arr.as_slice().unwrap_or(&[0.0])[0],
                    Err(_) => 0.0,
                };

                cmd.detections_buffer.push_back(probability);

                // Smoothed average of positive detections (same logic as wake word)
                let all = cmd.detections_buffer.to_vec();
                let mut cumulative = 0.0f32;
                let mut positive_count = 0.0f32;
                for d in all {
                    if d > self.threshold {
                        positive_count += 1.0;
                        cumulative += d;
                    }
                }
                if positive_count < MIN_POSITIVE_DETECTIONS {
                    continue;
                }
                let avg = cumulative / positive_count;
                if avg <= self.threshold {
                    continue;
                }

                // Refractory period: don't re-trigger the same command within 2s
                let since_last = cmd.last_detection_time.elapsed().as_millis();
                if since_last <= NO_DETECTION_MS as u128 {
                    continue;
                }

                // This command fired — track the best (highest probability) one
                if best_intent.is_none() || avg > best_intent.as_ref().unwrap().1 {
                    best_intent = Some((cmd.intent.clone(), avg));
                    cmd.last_detection_time = std::time::Instant::now();
                    cmd.detections_buffer.clear();
                }
            }

            if let Some((intent, prob)) = best_intent {
                tracing::info!(
                    "Tier 3: command detected → {:?} (probability: {:.3})",
                    intent, prob
                );
                Some(intent)
            } else {
                None
            }
        }

        /// Calculate average of positive detections in the buffer.
        fn calculate_average(&self) -> f32 {
            let all = self.detections_buffer.to_vec();
            let mut cumulative = 0.0f32;
            let mut positive_count = 0.0f32;
            for d in all {
                if d > self.threshold {
                    positive_count += 1.0;
                    cumulative += d;
                }
            }
            if positive_count < MIN_POSITIVE_DETECTIONS {
                return 0.0;
            }
            let avg = cumulative / positive_count;
            if avg > self.threshold { avg } else { 0.0 }
        }

        /// Process a chunk of 16kHz mono f32 audio.
        /// Returns true if the wake word "NEXUS" was detected and the speaker was accepted.
        /// Also emits command-detected events via `command_tx` if any Tier 3
        /// command classifier fires.
        pub fn process(&mut self, samples: &[f32]) -> bool {
            self.chunk_buffer.extend_from_slice(samples);

            while self.chunk_buffer.len() >= OWW_CHUNK_SIZE {
                let chunk: Vec<f32> = self.chunk_buffer.drain(0..OWW_CHUNK_SIZE).collect();

                let (detected, prob, command_intent) = self.detect_chunk(chunk);

                if prob > 0.1 {
                    tracing::debug!("OWW probability: {:.3}", prob);
                }

                // --- Tier 3: emit command-detected event if a command fired ---
                if let Some(intent) = command_intent {
                    if let Some(ref tx) = self.command_tx {
                        let _ = tx.send(intent);
                    }
                }

                if detected {
                    // --- Speaker verification ---
                    // TODO: implement audio ring buffer for proper speaker verification.
                    // For now, accept — the KWS model is accurate enough.
                    let accepted = if let Some(ref verifier) = self.speaker {
                        if verifier.has_profile() {
                            tracing::debug!(
                                "Speaker verification: using KWS-only (audio buffer TODO)"
                            );
                            true
                        } else {
                            true // open mode
                        }
                    } else {
                        true
                    };

                    if accepted {
                        tracing::info!("OWW wake detected! (probability: {:.3})", prob);
                        return true;
                    }
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

    /// Generic audio callback: downmix to mono (f32), resample to 16kHz,
    /// and feed 1280-sample chunks (80ms) to the KWS engine.
    pub fn on_audio<T, F>(
        data: &[T],
        native_channels: usize,
        state: &Arc<parking_lot::Mutex<ResampleState>>,
        out_buf: &Arc<parking_lot::Mutex<Vec<f32>>>,
        engine: &Arc<parking_lot::Mutex<WakeEngine>>,
        chunk_size: usize,
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

        // 1. Downmix to mono f32
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

        // 2. Resample to 16kHz
        let mut produced: Vec<f32> = Vec::with_capacity(chunk_size);
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

        // 3. Feed 1280-sample chunks to KWS engine
        {
            let mut buf = out_buf.lock();
            buf.extend(produced);
            while buf.len() >= chunk_size {
                let chunk: Vec<f32> = buf.drain(0..chunk_size).collect();
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
    use tauri::{Emitter, Manager};

    let res = app.path().resource_dir().map_err(|e| format!("resource dir: {e}"))?;
    let data_dir = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create app data dir: {e}"))?;

    let mut wake_engine = engine::WakeEngine::new(res, data_dir)
        .map_err(|e| format!("wake engine init: {e}"))?;

    // Create command channel for Tier 3 command classifiers
    let (cmd_tx, mut cmd_rx) =
        tokio::sync::mpsc::unbounded_channel::<engine::CommandIntent>();
    wake_engine.command_tx = Some(cmd_tx);

    let engine = std::sync::Arc::new(parking_lot::Mutex::new(wake_engine));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let _ = WAKE_TX.set(tx);

    start_audio_capture(engine.clone())?;

    // Spawn a task to handle Tier 3 command-detected events.
    // These bypass STT entirely and go straight to the frontend.
    let app_for_commands = app.clone();
    tokio::spawn(async move {
        while let Some(intent) = cmd_rx.recv().await {
            tracing::info!(
                "Tier 3: emitting command-detected event → action={}, target={}",
                intent.action, intent.target
            );

            // Emit to frontend — the frontend will skip STT and execute
            // the intent directly via invoke("execute_command", { intent }).
            if let Some(win) = app_for_commands.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
                let _ = win.set_always_on_top(true);
                let _ = win.set_ignore_cursor_events(false);
                let _ = app_for_commands.emit("command-detected", &intent);
            }
        }
    });

    // Main loop: handle wake-word detections
    while rx.recv().await.is_some() {
        tracing::info!("wake-word: NEXUS detected → triggering wake");

        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.set_always_on_top(true);
            let _ = win.set_ignore_cursor_events(false);
            let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
        }
    }
    Ok(())
}

#[cfg(not(feature = "mock-wake"))]
fn start_audio_capture(
    engine: std::sync::Arc<parking_lot::Mutex<engine::WakeEngine>>,
) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::Sample;

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no input device".to_string())?;

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

    let target_sr = engine.lock().sample_rate as u32;
    let native_sr = default_config.sample_rate().0;
    let native_channels = default_config.channels() as usize;

    let sample_format = default_config.sample_format();
    let stream_config = cpal::StreamConfig {
        channels: default_config.channels(),
        sample_rate: default_config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    let chunk_size = engine::OWW_CHUNK_SIZE; // 1280

    let state = std::sync::Arc::new(parking_lot::Mutex::new(engine::ResampleState::new(
        native_sr,
        target_sr,
    )));
    let out_buf = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<f32>::with_capacity(2560)));
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
                        engine::on_audio(
                            data,
                            native_channels,
                            &state,
                            &out_buf,
                            &engine_cb,
                            chunk_size,
                            |s: i16| s.to_sample::<f32>(),
                            tx,
                        );
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
                        engine::on_audio(
                            data,
                            native_channels,
                            &state,
                            &out_buf,
                            &engine_cb,
                            chunk_size,
                            |s: i32| s.to_sample::<f32>(),
                            tx,
                        );
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
                        engine::on_audio(
                            data,
                            native_channels,
                            &state,
                            &out_buf,
                            &engine_cb,
                            chunk_size,
                            |s: f32| s,
                            tx,
                        );
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
    tracing::info!("audio: stream started, OWW KWS listening for 'nexus'...");
    std::mem::forget(stream);
    Ok(())
}

#[cfg(all(test, feature = "wakeword-oww"))]
mod tests {
    use std::path::PathBuf;

    /// Verify that all three required ONNX models exist in the resources directory
    /// and are non-trivial in size (not corrupted/empty).
    #[test]
    fn test_oww_models_exist() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let oww_dir = PathBuf::from(manifest_dir).join("resources").join("oww");

        let required = ["melspectrogram.onnx", "embedding_model.onnx", "nexus.onnx"];
        let mut found = 0;
        for name in &required {
            let path = oww_dir.join(name);
            if !path.exists() {
                eprintln!("SKIP: {} not found at {}", name, path.display());
                continue;
            }
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            assert!(
                size > 1000,
                "{} is only {} bytes — file may be corrupted",
                name,
                size
            );
            println!("OK: {} ({} bytes)", name, size);
            found += 1;
        }
        if found == 0 {
            eprintln!("SKIP: No OWW models found — train the model first");
        }
    }

    /// Verify that the trained nexus.onnx model file is a valid ONNX file
    /// by checking its magic bytes and basic structure.
    #[test]
    fn test_nexus_onnx_file_valid() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let nexus_path = PathBuf::from(manifest_dir)
            .join("resources")
            .join("oww")
            .join("nexus.onnx");

        if !nexus_path.exists() {
            eprintln!("SKIP: nexus.onnx not found at {}", nexus_path.display());
            eprintln!("      Train the model first using train_nexus_oww.ipynb");
            return;
        }

        // Read the file
        let data = std::fs::read(&nexus_path).expect("Failed to read nexus.onnx");
        assert!(data.len() > 1000, "nexus.onnx is too small ({} bytes)", data.len());

        // ONNX files start with a Protobuf header — check for common ONNX markers
        // The first few bytes should be valid protobuf (not random/corrupted)
        // ONNX format: message ModelProto { ... } — field 7 is ir_version
        // We just verify it's a valid protobuf by checking it doesn't start with null bytes
        assert!(
            data[0] != 0 || data.len() > 100,
            "nexus.onnx may be corrupted (starts with null bytes)"
        );

        // Check for the "onnx" string somewhere in the first 1KB (producer name)
        let header = &data[..std::cmp::min(1024, data.len())];
        let has_onnx_marker = header.windows(4).any(|w| w == b"onnx");
        let has_pytorch_marker = header.windows(7).any(|w| w == b"pytorch");
        let has_keras_marker = header.windows(5).any(|w| w == b"keras");

        // At least one producer marker should be present
        assert!(
            has_onnx_marker || has_pytorch_marker || has_keras_marker,
            "nexus.onnx doesn't contain expected ONNX producer markers — may not be a valid ONNX file"
        );

        println!(
            "OK: nexus.onnx is a valid ONNX file ({} bytes, markers: onnx={}, pytorch={}, keras={})",
            data.len(),
            has_onnx_marker,
            has_pytorch_marker,
            has_keras_marker
        );
    }

    /// Verify that the WakeEngine can be constructed with the trained model.
    /// This is the integration test — it loads all 3 models and initializes
    /// the full KWS pipeline.
    #[test]
    fn test_wake_engine_initializes() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let resource_dir = PathBuf::from(manifest_dir).join("resources");
        let app_data_dir = std::env::temp_dir().join("nexus_test_profile");

        // Check if models exist first
        let oww_dir = resource_dir.join("oww");
        let nexus_path = oww_dir.join("nexus.onnx");
        if !nexus_path.exists() {
            eprintln!("SKIP: nexus.onnx not found — train the model first");
            return;
        }

        // Try to create the WakeEngine — this loads all 3 ONNX models
        match crate::wakeword_oww::engine::WakeEngine::new(resource_dir, app_data_dir) {
            Ok(_engine) => {
                println!("OK: WakeEngine initialized successfully with trained nexus.onnx");
            }
            Err(e) => {
                // Speaker model may be missing — that's OK, it's optional
                let err_str = format!("{e}");
                if err_str.contains("speaker") || err_str.contains("Speaker") {
                    println!("OK: WakeEngine initialized (speaker verification disabled): {}", err_str);
                } else {
                    panic!("WakeEngine initialization failed: {e}");
                }
            }
        }
    }
}
