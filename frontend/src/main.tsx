import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Pre-load Silero VAD model at app startup so it's ready instantly
// when the first wake word is detected. This eliminates the ~1-2s
// initialization delay on the first wake.
import { preloadSileroVad } from "./audio/vad";
preloadSileroVad().catch(() => {
  // Non-fatal — RMS fallback will be used if Silero fails to load.
  console.warn("[NEXUS] Silero VAD pre-load failed at startup — will use RMS fallback");
});

/**
 * Wake-word / hotkey → mic capture → VAD → STT → intent → execute / backend.
 *
 * The wake function is called from Rust via `win.eval()`, bypassing the
 * Tauri event system (which has reliability issues with repeated events in v2).
 *
 * Flow:
 *   1. Wake fires → show overlay, set state to "listening"
 *   2. Acquire mic stream (16 kHz mono, echo cancellation, noise suppression)
 *   3. Open backend session (non-fatal if backend is unavailable — local-only mode)
 *   4. Start recording (AudioWorklet buffers PCM locally)
 *   5. Start VAD (Silero ONNX or RMS fallback) — detects speech/silence
 *   6. On silence → finishCapture() → local STT → transcript → intent/backend
 */

let micStream: MediaStream | null = null;

async function startListening() {
  const { useAssistant } = await import("./store/assistant");
  const { captureUntilSilence } = await import("./audio/recorder");
  const { startVad } = await import("./audio/vad");
  const { stopTts } = await import("./audio/ttsPlayer");

  const s = useAssistant.getState();
  console.log("[NEXUS] wake →", s.state);

  // Don't re-start if already listening.
  if (s.state === "listening") {
    console.log("[NEXUS] already listening, ignoring wake");
    return;
  }

  // If NEXUS is speaking or thinking, cancel the current turn before
  // starting a new one. This prevents the TTS 'interrupted' error and
  // ensures clean state transitions.
  if (s.state === "speaking" || s.state === "thinking") {
    console.log("[NEXUS] barge-in: cancelling current turn");
    stopTts();
    const { stopVad } = await import("./audio/vad");
    const { abortCapture } = await import("./audio/recorder");
    stopVad();
    await abortCapture().catch(() => {});
  }

  s.setVisible(true);
  s.setState("listening");

  // Acquire mic with echo cancellation + noise suppression.
  // NOTE: sampleRate constraint is intentionally omitted — most browsers
  // ignore it and some devices fail if they can't honor it. The AudioContext
  // at 16kHz handles resampling internally.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (err) {
    console.error("[NEXUS] mic permission denied or unavailable:", err);
    useAssistant.getState().reset();
    useAssistant.getState().setVisible(false);
    return;
  }

  // Start recording (and try to open backend session — non-fatal if it fails).
  // captureUntilSilence handles the backend failure internally and always starts recording.
  try {
    await captureUntilSilence(micStream);
  } catch (err) {
    console.error("[NEXUS] recording failed:", err);
    stopMicStream();
    useAssistant.getState().reset();
    useAssistant.getState().setVisible(false);
    return;
  }

  if (!micStream) {
    console.error("[NEXUS] mic stream lost, aborting listen");
    useAssistant.getState().reset();
    return;
  }

  // Start VAD — detects silence and calls finishCapture() automatically.
  try {
    await startVad(micStream);
  } catch (err) {
    console.error("[NEXUS] VAD failed to start:", err);
    // Clean up: stop recording, release mic, reset state.
    // Without VAD, nothing will call finishCapture(), so we must abort.
    const { stopVad } = await import("./audio/vad");
    const { abortCapture } = await import("./audio/recorder");
    stopVad();
    await abortCapture().catch(() => {});
    stopMicStream();
  }
}

function stopMicStream() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

/** Called from Rust on wake (hotkey or spoken "NEXUS"). */
(window as any).__NEXUS_WAKE__ = () => {
  void startListening();
};

/** Called from Rust to cancel the current session. */
(window as any).__NEXUS_CANCEL__ = async () => {
  const { useAssistant } = await import("./store/assistant");
  const { stopVad } = await import("./audio/vad");
  const { abortCapture } = await import("./audio/recorder");
  console.log("[NEXUS] cancel");
  // Stop VAD first so it doesn't trigger finishCapture during cleanup.
  stopVad();
  // Then abort recording and close the session.
  await abortCapture();
  // Finally release the mic and reset state.
  stopMicStream();
  useAssistant.getState().reset();
  useAssistant.getState().setVisible(false);
};

/** Called by finishCapture/abortCapture cleanup to release the mic stream. */
(window as any).__NEXUS_RELEASE_MIC__ = () => {
  stopMicStream();
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
