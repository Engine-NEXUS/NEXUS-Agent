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

/**
 * Tier 3: Direct command detection listener.
 *
 * When a command classifier fires in the OWW pipeline (e.g. "open youtube"),
 * Rust emits a `command-detected` Tauri event with the structured intent.
 * The frontend skips STT entirely and executes the intent directly —
 * no Whisper, no transcript, no 27-second delay.
 *
 * This is the fast path: ~200ms from speech to action.
 * The STT path remains as fallback for commands not covered by classifiers.
 */
async function setupCommandDetectionListener() {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ action: string; target: string; needs_param?: boolean }>("command-detected", async (event) => {
      const intent = event.payload;
      console.log(`[NEXUS] Tier 3 command detected: ${intent.action} (needs_param=${intent.needs_param ?? false})`);

      const { useAssistant } = await import("./store/assistant");
      const { speak } = await import("./audio/ttsPlayer");

      // Show the overlay and set state to speaking
      const s = useAssistant.getState();
      s.setVisible(true);
      s.setState("speaking");

      // ─── Type 2: Parameterized command ─────────────────────────────
      // The acoustic classifier detected the command PATTERN (e.g. "play ... in spotify").
      // Now we need to capture the PARAMETER (e.g. song name) via STT.
      // Flow: speak "On it sir" → record 3s → STT → execute with parameter
      if (intent.needs_param) {
        s.addUserMessage(`${intent.action.replace(/_/g, " ")}...`);
        s.addAssistantMessage("On it sir");
        void speak("On it sir");

        // Wait for TTS to finish before recording (so we don't capture TTS audio)
        await new Promise<void>((resolve) => {
          if (typeof speechSynthesis === "undefined" || !speechSynthesis.speaking) {
            resolve();
            return;
          }
          const check = () => {
            if (!speechSynthesis.speaking) {
              resolve();
              return;
            }
            setTimeout(check, 100);
          };
          setTimeout(check, 100);
        });

        // Record 3 seconds of audio for the parameter
        s.setState("listening");
        try {
          const { captureParameter } = await import("./audio/paramCapture");
          const pcm = await captureParameter(3000);
          if (pcm && pcm.length > 0) {
            s.setState("thinking");
            const { transcribeAudio } = await import("./audio/stt");
            const param = await transcribeAudio(pcm);
            if (param && param.trim().length > 0) {
              console.log(`[NEXUS] Tier 3 parameter: "${param}"`);
              s.addUserMessage(param);
              // Execute with the parameter as the query
              const { invoke } = await import("@tauri-apps/api/core");
              const result = await invoke<{ success: boolean; message: string }>(
                "execute_command",
                { intent: { action: intent.action, query: param } }
              );
              console.log(`[NEXUS] Tier 3 execute result:`, result);
              if (result.message) {
                s.addAssistantMessage(result.message);
                void speak(result.message.replace(/,/g, ""));
              }
            } else {
              console.warn("[NEXUS] Tier 3 parameter STT returned empty");
              s.addAssistantMessage("Didn't catch that sir");
              void speak("Didn't catch that sir");
            }
          }
        } catch (err) {
          console.error("[NEXUS] Tier 3 parameter capture failed:", err);
          s.addAssistantMessage("Didn't catch that sir");
          void speak("Didn't catch that sir");
        }

        setTimeout(() => {
          useAssistant.getState().setVisible(false);
          setTimeout(() => useAssistant.getState().reset(), 550);
        }, 800);
        return;
      }

      // ─── Type 1: Fixed command (no parameter) ──────────────────────
      // Execute directly — no STT needed.
      s.addUserMessage(`${intent.action.replace(/_/g, " ")} ${intent.target}`);
      s.addAssistantMessage("Ok sir.");
      void speak("Ok sir.");

      // Execute the command directly — no STT needed
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ success: boolean; message: string }>(
          "execute_command",
          { intent }
        );
        console.log(`[NEXUS] Tier 3 execute result:`, result);
      } catch (err) {
        console.error("[NEXUS] Tier 3 command execution failed:", err);
      }

      // Hide after a short delay
      setTimeout(() => {
        useAssistant.getState().setVisible(false);
        setTimeout(() => useAssistant.getState().reset(), 550);
      }, 800);
    });
    console.log("[NEXUS] Tier 3 command detection listener registered");
  } catch (err) {
    // Non-fatal — STT fallback handles all commands if this listener fails
    console.warn("[NEXUS] Failed to register Tier 3 command listener:", err);
  }
}

// Register the listener at startup (non-blocking, non-fatal)
void setupCommandDetectionListener();

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

/** Called by paramCapture to get the existing mic stream (or null if not active). */
(window as any).__NEXUS_GET_MIC_STREAM__ = async (): Promise<MediaStream> => {
  if (micStream) return micStream;
  // If no existing stream, get a new one
  return await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
};

/**
 * Boot / wake greeting.
 *
 * Two triggers, both decided by Rust:
 *   1. Boot: this file invokes `frontend_ready` once the webview has loaded.
 *      Rust returns true only on a fresh boot (system uptime < 15 min) with
 *      no meeting active and no manual pause.
 *   2. Sleep/wake: Rust's time-jump detector emits `app:greeting` when the
 *      machine resumes from sleep.
 *
 * The greeting shows the orb, speaks, then hides again. It's skipped silently
 * if NEXUS is mid-conversation (state != idle). The speak() call itself
 * additionally suppresses audio during meetings as a second layer.
 */
async function greet() {
  const { useAssistant } = await import("./store/assistant");
  const { speak } = await import("./audio/ttsPlayer");
  const s = useAssistant.getState();
  if (s.state !== "idle") {
    console.log("[NEXUS] greeting skipped — not idle:", s.state);
    return;
  }
  console.log("[NEXUS] greeting");
  s.setVisible(true);
  s.setState("speaking");
  await speak("Hello sir, how can I assist you today?");
  s.setVisible(false);
  // Delay reset until the 0.5s slide-down transition completes.
  setTimeout(() => useAssistant.getState().reset(), 550);
}

const isTauriRuntime = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
if (isTauriRuntime) {
  // Boot path: ask Rust whether to greet.
  import("@tauri-apps/api/core").then(async ({ invoke }) => {
    try {
      const shouldGreet = await invoke<boolean>("frontend_ready");
      if (shouldGreet) void greet();
    } catch (e) {
      console.warn("[NEXUS] frontend_ready failed:", e);
    }
  });
  // Sleep/wake path: Rust emits app:greeting on resume.
  import("@tauri-apps/api/event").then(({ listen }) => {
    void listen("app:greeting", () => void greet());
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
