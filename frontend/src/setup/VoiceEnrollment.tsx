import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Voice Enrollment component for the NEXUS setup page.
 *
 * Records 5 audio clips of the user saying "NEXUS", extracts speaker
 * embeddings locally via the Rust backend, and saves a voice profile.
 *
 * The voice profile is stored locally and never leaves the device.
 * When enabled, only the enrolled user's voice can wake NEXUS.
 */

interface VoiceProfileStatus {
  enrolled: boolean;
  num_clips: number;
  threshold: number;
  created_at: number;
  updated_at: number;
}

const NUM_CLIPS = 5;
const CLIP_DURATION_MS = 3000; // 3 seconds per clip

export function VoiceEnrollment() {
  const [status, setStatus] = useState<VoiceProfileStatus | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [currentClip, setCurrentClip] = useState(0);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<ScriptProcessorNode | null>(null);
  const clipBufferRef = useRef<Float32Array[]>([]);

  // Load status on mount
  const refreshStatus = useCallback(async () => {
    try {
      const s = await invoke<VoiceProfileStatus>("get_voice_profile_status");
      setStatus(s);
    } catch (err) {
      console.error("Failed to get voice profile status:", err);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Get microphone stream at 16kHz mono
  const getStream = useCallback(async (): Promise<MediaStream> => {
    if (mediaStreamRef.current) return mediaStreamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    mediaStreamRef.current = stream;
    return stream;
  }, []);

  // Record a single clip
  const recordClip = useCallback(async (): Promise<Float32Array> => {
    const stream = await getStream();
    const audioCtx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(stream);

    // Use ScriptProcessor for simplicity (works everywhere)
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    recorderRef.current = processor;

    const chunks: Float32Array[] = [];
    clipBufferRef.current = chunks;

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      // Copy the data (the buffer is reused)
      chunks.push(new Float32Array(input));
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);

    // Record for CLIP_DURATION_MS
    await new Promise((resolve) => setTimeout(resolve, CLIP_DURATION_MS));

    // Cleanup
    processor.disconnect();
    source.disconnect();
    await audioCtx.close();

    // Concatenate all chunks
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }, [getStream]);

  // Start enrollment
  const handleEnroll = useCallback(async () => {
    setEnrolling(true);
    setError(null);
    setSuccess(null);
    setCurrentClip(0);

    try {
      const collectedClips: Float32Array[] = [];

      for (let i = 0; i < NUM_CLIPS; i++) {
        setCurrentClip(i + 1);

        // Countdown 3-2-1
        for (let c = 3; c > 0; c--) {
          setCountdown(c);
          await new Promise((r) => setTimeout(r, 1000));
        }
        setCountdown(0);
        setRecording(true);

        // Record
        const clip = await recordClip();
        collectedClips.push(clip);
        setRecording(false);

        // Small pause between clips
        await new Promise((r) => setTimeout(r, 500));
      }

      // Send to backend for enrollment
      // Convert Float32Array to regular number[] for serde
      const clipsData = collectedClips.map((c) => Array.from(c));

      await invoke("enroll_voice", {
        clips: clipsData,
        threshold: 0.5,
      });

      setSuccess("Voice profile enrolled successfully!");
      await refreshStatus();
    } catch (err) {
      setError(`Enrollment failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setEnrolling(false);
      setRecording(false);
      setCountdown(0);
      // Stop the mic stream
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
    }
  }, [recordClip, refreshStatus]);

  // Delete profile
  const handleDelete = useCallback(async () => {
    try {
      await invoke("delete_voice_profile");
      setSuccess("Voice profile deleted.");
      await refreshStatus();
    } catch (err) {
      setError(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [refreshStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  return (
    <section className="setup-section">
      <h2>Voice Lock</h2>
      <p className="setup-hint">
        Enroll your voice so only <strong>you</strong> can wake NEXUS by saying "NEXUS".
        Your voice profile is stored locally and never leaves this device.
      </p>

      {error && <div className="setup-error">{error}</div>}
      {success && <div className="setup-saved">{success}</div>}

      {/* Status display */}
      {status && (
        <div className="voice-status">
          {status.enrolled ? (
            <div className="voice-status-enrolled">
              <span className="setup-badge setup-badge--ok">
                Voice Lock Active ({status.num_clips} clips)
              </span>
              <button
                className="setup-btn setup-btn--small setup-btn--danger"
                onClick={handleDelete}
                disabled={enrolling}
              >
                Delete Profile
              </button>
            </div>
          ) : (
            <span className="setup-badge setup-badge--warn">
              No voice profile — any speaker can wake NEXUS
            </span>
          )}
        </div>
      )}

      {/* Enrollment UI */}
      {enrolling && (
        <div className="voice-enroll-progress">
          <div className="voice-enroll-clip">
            Clip {currentClip} of {NUM_CLIPS}
          </div>
          {countdown > 0 ? (
            <div className="voice-enroll-countdown">
              Get ready... {countdown}
            </div>
          ) : recording ? (
            <div className="voice-enroll-recording">
              🎙️ Say "NEXUS" now!
            </div>
          ) : (
            <div className="voice-enroll-wait">Processing...</div>
          )}
          {/* Progress bar */}
          <div className="voice-enroll-bar">
            <div
              className="voice-enroll-bar-fill"
              style={{ width: `${(currentClip / NUM_CLIPS) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Enroll button */}
      {!enrolling && (
        <button
          className="setup-btn"
          onClick={handleEnroll}
          disabled={enrolling}
        >
          {status?.enrolled ? "Re-enroll Voice" : "Enroll Voice"}
        </button>
      )}
    </section>
  );
}
