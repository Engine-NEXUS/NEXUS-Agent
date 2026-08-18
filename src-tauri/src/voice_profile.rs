//! Local speaker verification using sherpa-onnx speaker embeddings.
//!
//! Voice profiles are stored locally as JSON files. No voice biometrics leave the device.
//!
//! Enrollment:
//!   1. Capture ~5 audio clips of the user saying "NEXUS" (or any phrase).
//!   2. Extract a speaker embedding for each clip.
//!   3. Average the embeddings into a single voice profile.
//!   4. Save to disk as JSON.
//!
//! Verification:
//!   1. Extract embedding from the wake-word audio segment.
//!   2. Compute cosine similarity against the stored profile.
//!   3. If similarity >= threshold, accept; otherwise reject.
//!
//! Privacy:
//!   - Voice profiles are personalization data, not a security boundary.
//!   - They never leave the device.
//!   - They can be deleted at any time.

use sherpa_onnx::{
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};
use std::path::{Path, PathBuf};

/// Default cosine similarity threshold for accepting a speaker.
/// 0.5 is a balanced value based on testing — same-speaker similarities
/// range from 0.5-0.98 depending on audio quality and phrase consistency.
/// A lower threshold reduces false rejections; raise it for stricter filtering.
pub const DEFAULT_THRESHOLD: f32 = 0.5;

/// Number of enrollment clips recommended for a stable profile.
pub const RECOMMENDED_ENROLLMENT_CLIPS: usize = 5;

/// Minimum enrollment clips required to create a profile.
pub const MIN_ENROLLMENT_CLIPS: usize = 3;

/// Speaker name used for the enrolled user.
pub const ENROLLED_SPEAKER_NAME: &str = "owner";

/// A voice profile: an averaged embedding + metadata.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct VoiceProfile {
    /// The averaged embedding vector.
    pub embedding: Vec<f32>,
    /// Number of clips used to create this profile.
    pub num_clips: usize,
    /// When the profile was created (Unix timestamp).
    pub created_at: i64,
    /// When the profile was last updated (Unix timestamp).
    pub updated_at: i64,
    /// The similarity threshold for verification.
    pub threshold: f32,
}

impl VoiceProfile {
    /// Load a voice profile from a JSON file.
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let data = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("Failed to read voice profile: {e}"))?;
        let profile: VoiceProfile = serde_json::from_str(&data)
            .map_err(|e| anyhow::anyhow!("Failed to parse voice profile: {e}"))?;
        Ok(profile)
    }

    /// Save the voice profile to a JSON file.
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        let data = serde_json::to_string_pretty(self)
            .map_err(|e| anyhow::anyhow!("Failed to serialize voice profile: {e}"))?;
        std::fs::write(path, data)
            .map_err(|e| anyhow::anyhow!("Failed to write voice profile: {e}"))?;
        Ok(())
    }

    /// Compute cosine similarity between this profile and a query embedding.
    pub fn cosine_similarity(&self, query: &[f32]) -> f32 {
        if query.len() != self.embedding.len() {
            return 0.0;
        }
        let mut dot = 0.0f32;
        let mut norm_a = 0.0f32;
        let mut norm_b = 0.0f32;
        for i in 0..query.len() {
            dot += self.embedding[i] * query[i];
            norm_a += self.embedding[i] * self.embedding[i];
            norm_b += query[i] * query[i];
        }
        let denom = (norm_a.sqrt() * norm_b.sqrt()).max(1e-8);
        dot / denom
    }

    /// Verify if a query embedding matches this profile.
    pub fn verify(&self, query: &[f32]) -> bool {
        let sim = self.cosine_similarity(query);
        sim >= self.threshold
    }

    /// Verify with explicit threshold override.
    pub fn verify_with_threshold(&self, query: &[f32], threshold: f32) -> bool {
        let sim = self.cosine_similarity(query);
        sim >= threshold
    }
}

/// Average multiple embeddings into a single profile embedding.
pub fn average_embeddings(embeddings: &[Vec<f32>]) -> anyhow::Result<Vec<f32>> {
    if embeddings.is_empty() {
        anyhow::bail!("No embeddings to average");
    }
    let dim = embeddings[0].len();
    if dim == 0 {
        anyhow::bail!("Empty embedding vectors");
    }
    for e in embeddings {
        if e.len() != dim {
            anyhow::bail!("Inconsistent embedding dimensions: {} vs {}", e.len(), dim);
        }
    }
    let mut sum = vec![0.0f32; dim];
    for e in embeddings {
        for i in 0..dim {
            sum[i] += e[i];
        }
    }
    let n = embeddings.len() as f32;
    for v in &mut sum {
        *v /= n;
    }
    Ok(sum)
}

/// The speaker verification engine.
/// Wraps a sherpa-onnx SpeakerEmbeddingExtractor and manages voice profiles.
pub struct SpeakerVerifier {
    extractor: SpeakerEmbeddingExtractor,
    profile_path: PathBuf,
    profile: Option<VoiceProfile>,
}

impl SpeakerVerifier {
    /// Create a new SpeakerVerifier.
    /// `model_path` is the path to speaker_model.onnx.
    /// `profile_path` is where the voice profile JSON will be stored.
    pub fn new(model_path: PathBuf, profile_path: PathBuf) -> anyhow::Result<Self> {
        if !model_path.exists() {
            anyhow::bail!("Speaker model not found at: {}", model_path.display());
        }

        let config = SpeakerEmbeddingExtractorConfig {
            model: Some(model_path.to_string_lossy().to_string()),
            num_threads: 1,
            debug: false,
            provider: Some("cpu".to_string()),
        };

        let extractor = SpeakerEmbeddingExtractor::create(&config)
            .ok_or_else(|| anyhow::anyhow!("Failed to create speaker embedding extractor"))?;

        // Load existing profile if it exists
        let profile = if profile_path.exists() {
            match VoiceProfile::load(&profile_path) {
                Ok(p) => {
                    tracing::info!(
                        "Voice profile loaded ({} clips, threshold {})",
                        p.num_clips,
                        p.threshold
                    );
                    Some(p)
                }
                Err(e) => {
                    tracing::warn!("Failed to load voice profile: {e}");
                    None
                }
            }
        } else {
            tracing::info!("No voice profile found — speaker verification disabled (any speaker can wake)");
            None
        };

        tracing::info!(
            "Speaker verifier initialized (embedding dim: {})",
            extractor.dim()
        );

        Ok(SpeakerVerifier {
            extractor,
            profile_path,
            profile,
        })
    }

    /// Return the embedding dimension.
    pub fn dim(&self) -> i32 {
        self.extractor.dim()
    }

    /// Return true if a voice profile is enrolled.
    pub fn has_profile(&self) -> bool {
        self.profile.is_some()
    }

    /// Get the current voice profile, if any.
    pub fn profile(&self) -> Option<&VoiceProfile> {
        self.profile.as_ref()
    }

    /// Extract an embedding from audio samples (16kHz mono f32).
    pub fn extract_embedding(&self, samples: &[f32]) -> anyhow::Result<Vec<f32>> {
        let stream = self
            .extractor
            .create_stream()
            .ok_or_else(|| anyhow::anyhow!("Failed to create embedding stream"))?;

        stream.accept_waveform(16000, samples);

        // Add tail padding to help the model finalize
        let tail = vec![0.0f32; 8000]; // 0.5s at 16kHz
        stream.accept_waveform(16000, &tail);
        stream.input_finished();

        if !self.extractor.is_ready(&stream) {
            anyhow::bail!("Not enough audio to compute embedding (need at least a few seconds of speech)");
        }

        let embedding = self
            .extractor
            .compute(&stream)
            .ok_or_else(|| anyhow::anyhow!("Failed to compute embedding"))?;

        Ok(embedding)
    }

    /// Enroll a voice profile from multiple audio clips.
    /// Each clip should be 1-5 seconds of speech from the same speaker.
    pub fn enroll(&mut self, clips: &[Vec<f32>], threshold: f32) -> anyhow::Result<()> {
        if clips.len() < MIN_ENROLLMENT_CLIPS {
            anyhow::bail!(
                "Need at least {} enrollment clips, got {}",
                MIN_ENROLLMENT_CLIPS,
                clips.len()
            );
        }

        tracing::info!("Enrolling voice profile from {} clips...", clips.len());

        let mut embeddings = Vec::with_capacity(clips.len());
        for (i, clip) in clips.iter().enumerate() {
            tracing::info!("Extracting embedding from clip {}/{}", i + 1, clips.len());
            match self.extract_embedding(clip) {
                Ok(emb) => {
                    tracing::debug!(
                        "Clip {} embedding: dim={}, first 5: {:?}",
                        i + 1,
                        emb.len(),
                        &emb[..5.min(emb.len())]
                    );
                    embeddings.push(emb);
                }
                Err(e) => {
                    tracing::warn!("Failed to extract embedding from clip {}: {e}", i + 1);
                }
            }
        }

        if embeddings.len() < MIN_ENROLLMENT_CLIPS {
            anyhow::bail!(
                "Only {} valid embeddings extracted (need at least {})",
                embeddings.len(),
                MIN_ENROLLMENT_CLIPS
            );
        }

        let avg = average_embeddings(&embeddings)?;

        let now = chrono::Utc::now().timestamp();
        let profile = VoiceProfile {
            embedding: avg,
            num_clips: embeddings.len(),
            created_at: now,
            updated_at: now,
            threshold,
        };

        profile.save(&self.profile_path)?;
        self.profile = Some(profile);

        tracing::info!(
            "Voice profile enrolled and saved to {} ({} clips, threshold {})",
            self.profile_path.display(),
            embeddings.len(),
            threshold
        );

        Ok(())
    }

    /// Add a single clip to an existing profile (incremental enrollment).
    pub fn add_clip(&mut self, samples: &[f32]) -> anyhow::Result<()> {
        let new_emb = self.extract_embedding(samples)?;

        let profile = self
            .profile
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("No existing profile to add clip to"))?;

        // Weighted average: combine the existing average with the new embedding
        let n = profile.num_clips as f32;
        let dim = profile.embedding.len();
        for i in 0..dim {
            profile.embedding[i] = (profile.embedding[i] * n + new_emb[i]) / (n + 1.0);
        }
        profile.num_clips += 1;
        profile.updated_at = chrono::Utc::now().timestamp();

        profile.save(&self.profile_path)?;

        tracing::info!(
            "Added clip to voice profile (now {} clips)",
            profile.num_clips
        );

        Ok(())
    }

    /// Verify if audio samples match the enrolled profile.
    /// Returns (matched, similarity_score).
    /// If no profile is enrolled, returns (true, 0.0) — open mode.
    pub fn verify(&self, samples: &[f32]) -> anyhow::Result<(bool, f32)> {
        if let Some(profile) = &self.profile {
            let emb = self.extract_embedding(samples)?;
            let sim = profile.cosine_similarity(&emb);
            let matched = sim >= profile.threshold;
            tracing::info!(
                "Speaker verification: similarity={:.3}, threshold={:.3}, matched={}",
                sim,
                profile.threshold,
                matched
            );
            Ok((matched, sim))
        } else {
            // No profile enrolled — accept any speaker
            tracing::debug!("No voice profile — accepting any speaker");
            Ok((true, 0.0))
        }
    }

    /// Verify using a pre-extracted embedding.
    pub fn verify_embedding(&self, embedding: &[f32]) -> anyhow::Result<(bool, f32)> {
        if let Some(profile) = &self.profile {
            let sim = profile.cosine_similarity(embedding);
            let matched = sim >= profile.threshold;
            tracing::info!(
                "Speaker verification: similarity={:.3}, threshold={:.3}, matched={}",
                sim,
                profile.threshold,
                matched
            );
            Ok((matched, sim))
        } else {
            Ok((true, 0.0))
        }
    }

    /// Delete the voice profile.
    pub fn delete_profile(&mut self) -> anyhow::Result<()> {
        if self.profile_path.exists() {
            std::fs::remove_file(&self.profile_path)
                .map_err(|e| anyhow::anyhow!("Failed to delete voice profile: {e}"))?;
        }
        self.profile = None;
        tracing::info!("Voice profile deleted");
        Ok(())
    }

    /// Get the profile status for UI display.
    pub fn status(&self) -> VoiceProfileStatus {
        if let Some(profile) = &self.profile {
            VoiceProfileStatus {
                enrolled: true,
                num_clips: profile.num_clips,
                threshold: profile.threshold,
                created_at: profile.created_at,
                updated_at: profile.updated_at,
            }
        } else {
            VoiceProfileStatus {
                enrolled: false,
                num_clips: 0,
                threshold: DEFAULT_THRESHOLD,
                created_at: 0,
                updated_at: 0,
            }
        }
    }
}

/// Status of the voice profile, returned to the frontend.
#[derive(serde::Serialize, Clone, Debug)]
pub struct VoiceProfileStatus {
    pub enrolled: bool,
    pub num_clips: usize,
    pub threshold: f32,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Resolve the voice profile path. Stored in the app data directory.
pub fn resolve_profile_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("voice_profile.json")
}
