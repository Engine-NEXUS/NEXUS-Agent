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
//!
//! # Status: enrollment is wired, verification is NOT
//!
//! Enrollment works end-to-end (setup wizard → embedding → JSON on disk) and
//! `SpeakerVerifier` loads the profile at startup. However, the verification
//! half is not yet connected: `wakeword_oww::WakeEngine::process` accepts every
//! wake regardless of speaker (see the `TODO: implement audio ring buffer`
//! there). Wiring it up requires retaining the ~1.5s of audio preceding the
//! wake so an embedding can be extracted from the actual utterance — the KWS
//! path currently discards each 80ms chunk after inference.
//!
//! Consequence: enrolling a voice profile does not currently restrict who can
//! wake NEXUS. The verification API below is therefore unused, and marked
//! `#[allow(dead_code)]` rather than deleted so the feature can be completed
//! without rewriting it.

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
/// Referenced by the setup wizard copy; unused in Rust until verification lands.
#[allow(dead_code)]
pub const RECOMMENDED_ENROLLMENT_CLIPS: usize = 5;

/// Minimum enrollment clips required to create a profile.
pub const MIN_ENROLLMENT_CLIPS: usize = 3;

/// Speaker name used for the enrolled user.
/// Reserved for multi-speaker profiles; unused until verification lands.
#[allow(dead_code)]
pub const ENROLLED_SPEAKER_NAME: &str = "owner";

/// Maximum number of wake variants stored in a profile.
/// Re-enrollment appends new variants up to this cap.
pub const MAX_WAKE_VARIANTS: usize = 30;

/// Global list of words that sound like "NEXUS" — common ASR mishearings.
/// These are checked for ALL users, regardless of enrollment.
/// Compiled from observed ASR outputs during testing.
pub const SOUND_ALIKES: &[&str] = &[
    "nexus",
    "nixis",
    "mixis",
    "mexic",
    "nixes",
    "lexis",
    "necess",
    "nexis",
    "nixus",
    "naxus",
    "noxus",
    "nexcus",
    "dnexus",
];

/// A voice profile: an averaged embedding + metadata + wake variants.
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
    /// Personalized wake-word variants from this user's enrollment.
    /// ASR transcripts of the user saying "NEXUS" — accumulates on re-enrollment.
    /// Always includes "nexus" as a baseline.
    #[serde(default = "default_wake_variants")]
    pub wake_variants: Vec<String>,
}

/// Default wake variants — always includes "nexus" as a baseline.
fn default_wake_variants() -> Vec<String> {
    vec!["nexus".to_string()]
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
    ///
    /// Unused until wake-word speaker verification is wired — see the module
    /// docs. Covered by unit tests.
    #[allow(dead_code)]
    pub fn cosine_similarity(&self, query: &[f32]) -> f32 {
        if query.len() != self.embedding.len() {
            return 0.0;
        }
        let mut dot = 0.0f32;
        let mut norm_a = 0.0f32;
        let mut norm_b = 0.0f32;
        for (&a, &q) in self.embedding.iter().zip(query.iter()) {
            dot += a * q;
            norm_a += a * a;
            norm_b += q * q;
        }
        let denom = (norm_a.sqrt() * norm_b.sqrt()).max(1e-8);
        dot / denom
    }

    /// Verify if a query embedding matches this profile.
    ///
    /// Unused until wake-word speaker verification is wired — see module docs.
    #[allow(dead_code)]
    pub fn verify(&self, query: &[f32]) -> bool {
        let sim = self.cosine_similarity(query);
        sim >= self.threshold
    }

    /// Verify with explicit threshold override.
    #[allow(dead_code)]
    pub fn verify_with_threshold(&self, query: &[f32], threshold: f32) -> bool {
        let sim = self.cosine_similarity(query);
        sim >= threshold
    }

    /// Add new wake variants to this profile (append, deduplicate, cap at MAX_WAKE_VARIANTS).
    /// Does NOT wipe existing variants — used for re-enrollment accumulation.
    pub fn add_wake_variants(&mut self, new_variants: &[String]) {
        for v in new_variants {
            let v = v.trim().to_lowercase();
            if v.is_empty() || v.len() < 3 {
                continue;
            }
            if !self.wake_variants.contains(&v) {
                self.wake_variants.push(v);
            }
        }
        // Always ensure "nexus" is present
        if !self.wake_variants.contains(&"nexus".to_string()) {
            self.wake_variants.insert(0, "nexus".to_string());
        }
        // Cap at MAX_WAKE_VARIANTS — keep the most recently added
        if self.wake_variants.len() > MAX_WAKE_VARIANTS {
            let excess = self.wake_variants.len() - MAX_WAKE_VARIANTS;
            self.wake_variants.drain(0..excess);
        }
    }
}

/// Check if a normalized ASR transcript matches any wake word.
/// Checks both the user's personalized `wake_variants` and the global `SOUND_ALIKES` list.
/// Matching is exact substring (no fuzzy/Levenshtein).
///
/// Called from the legacy `wakeword.rs` path; unused under the default
/// `wakeword-oww` feature but kept for the non-oww fallback.
#[allow(dead_code)]
pub fn matches_wake_word(transcript: &str, wake_variants: &[String]) -> bool {
    let text = transcript.trim().to_lowercase();
    if text.is_empty() {
        return false;
    }

    // 1. Check personalized wake variants (from enrollment)
    for variant in wake_variants {
        let v = variant.trim().to_lowercase();
        if v.is_empty() {
            continue;
        }
        if text.contains(&v) {
            return true;
        }
    }

    // 2. Check global sound-alikes (common ASR mishearings)
    for &alike in SOUND_ALIKES {
        if text.contains(alike) {
            return true;
        }
    }

    false
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
    #[allow(dead_code)]
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
    ///
    /// `wake_variants` are the ASR transcripts of the user saying "NEXUS" during
    /// enrollment. They are appended to any existing variants (re-enrollment does
    /// NOT wipe old data). Always includes "nexus" as a baseline.
    pub fn enroll(
        &mut self,
        clips: &[Vec<f32>],
        threshold: f32,
        wake_variants: Vec<String>,
    ) -> anyhow::Result<()> {
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

        // If re-enrolling, load existing profile to preserve wake_variants.
        // New variants are APPENDED, not replaced.
        let mut existing_variants: Vec<String> = vec!["nexus".to_string()];
        let mut created_at = now;
        let mut total_clips = embeddings.len();

        if let Some(existing) = &self.profile {
            existing_variants = existing.wake_variants.clone();
            created_at = existing.created_at;
            total_clips = existing.num_clips + embeddings.len();
            tracing::info!(
                "Re-enrollment: preserving {} existing wake variants, appending new ones",
                existing_variants.len()
            );
        }

        let mut profile = VoiceProfile {
            embedding: avg,
            num_clips: total_clips,
            created_at,
            updated_at: now,
            threshold,
            wake_variants: existing_variants,
        };

        // Append new variants (dedup, cap at MAX_WAKE_VARIANTS)
        profile.add_wake_variants(&wake_variants);

        tracing::info!(
            "Wake variants after enrollment: {:?}",
            profile.wake_variants
        );

        profile.save(&self.profile_path)?;
        self.profile = Some(profile);

        tracing::info!(
            "Voice profile enrolled and saved to {} ({} total clips, threshold {}, {} variants)",
            self.profile_path.display(),
            total_clips,
            threshold,
            self.profile.as_ref().unwrap().wake_variants.len()
        );

        Ok(())
    }

    /// Add a single clip to an existing profile (incremental enrollment).
    #[allow(dead_code)]
    pub fn add_clip(&mut self, samples: &[f32]) -> anyhow::Result<()> {
        let new_emb = self.extract_embedding(samples)?;

        let profile = self
            .profile
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("No existing profile to add clip to"))?;

        // Weighted average: combine the existing average with the new embedding
        let n = profile.num_clips as f32;
        for (avg, &sample) in profile.embedding.iter_mut().zip(new_emb.iter()) {
            *avg = (*avg * n + sample) / (n + 1.0);
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
    ///
    /// Unused until wake-word speaker verification is wired — see module docs.
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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
    #[allow(dead_code)]
    pub fn status(&self) -> VoiceProfileStatus {
        let sound_alikes: Vec<String> = SOUND_ALIKES
            .iter()
            .map(|s| s.to_string())
            .collect();

        if let Some(profile) = &self.profile {
            VoiceProfileStatus {
                enrolled: true,
                num_clips: profile.num_clips,
                threshold: profile.threshold,
                created_at: profile.created_at,
                updated_at: profile.updated_at,
                wake_variants: profile.wake_variants.clone(),
                sound_alikes,
            }
        } else {
            VoiceProfileStatus {
                enrolled: false,
                num_clips: 0,
                threshold: DEFAULT_THRESHOLD,
                created_at: 0,
                updated_at: 0,
                wake_variants: vec!["nexus".to_string()],
                sound_alikes,
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
    /// The user's personalized wake variants (from enrollment).
    pub wake_variants: Vec<String>,
    /// The global sound-alikes list (same for all users).
    pub sound_alikes: Vec<String>,
}

/// Resolve the voice profile path. Stored in the app data directory.
pub fn resolve_profile_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("voice_profile.json")
}
