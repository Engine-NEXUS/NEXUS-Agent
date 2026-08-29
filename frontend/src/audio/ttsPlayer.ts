import { useAssistant } from "../store/assistant";

/**
 * Local Text-to-Speech via the Web Speech API (SpeechSynthesis).
 *
 * The browser's built-in speech synthesizer is used to speak text aloud
 * on the device. No audio is sent from the server — only text. The server
 * returns result text, and this module speaks it locally.
 *
 * Two moments of audio output:
 *   1. Acknowledgement: "On it, sir." — spoken immediately when transcript
 *      is sent to the server.
 *   2. Result: the actual answer — spoken when the server returns the
 *      result text.
 *
 * Barge-in: stopTts() cancels any in-progress speech immediately.
 *
 * Meeting mode: When a meeting is detected (another app using the mic),
 * TTS is suppressed to avoid interrupting calls. The frontend emits
 * `tts-started` / `tts-ended` events so Rust can suppress wake detection
 * while NEXUS is speaking (prevents self-triggering).
 */

let voicesLoaded = false;

// Web Speech API voices load asynchronously. Wait for them.
function ensureVoices(): Promise<void> {
  return new Promise((resolve) => {
    if (voicesLoaded || typeof speechSynthesis === "undefined") {
      voicesLoaded = true;
      resolve();
      return;
    }
    const voices = speechSynthesis.getVoices();
    if (voices.length > 0) {
      voicesLoaded = true;
      resolve();
      return;
    }
    // Voices not loaded yet — wait for the voiceschanged event.
    speechSynthesis.addEventListener(
      "voiceschanged",
      () => {
        voicesLoaded = true;
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Check if TTS should be suppressed because a meeting is active.
 * Queries the Rust meeting detection state.
 */
async function isMeetingActive(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("meeting_active");
  } catch {
    // If the command isn't available (e.g. in dev without Rust changes),
    // default to not suppressing TTS.
    return false;
  }
}

/**
 * Emit a Tauri event to notify Rust that TTS is starting/ending.
 * Rust uses this to suppress wake detection while NEXUS is speaking
 * (prevents self-triggering from speaker echo).
 */
async function emitTtsEvent(event: string): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event);
  } catch {
    // Ignore — event emission is best-effort
  }
}

/**
 * Speak text aloud using the local Web Speech API.
 *
 * In meeting mode, TTS is suppressed — the text is not spoken aloud
 * to avoid interrupting calls. The caller can check `meetingActive()`
 * to provide a silent visual response instead.
 *
 * @param text The text to speak.
 * @param onEnd Optional callback fired when speech completes naturally.
 */
export async function speak(text: string, onEnd?: () => void): Promise<void> {
  if (typeof speechSynthesis === "undefined") {
    console.warn("Web Speech API not available — TTS disabled");
    onEnd?.();
    return;
  }

  // Check meeting mode — suppress TTS if a meeting is active
  const meeting = await isMeetingActive();
  if (meeting) {
    console.log("[TTS] Suppressed — meeting mode active");
    onEnd?.();
    return;
  }

  // NOTE: Do NOT call speechSynthesis.cancel() here.
  // cancel() fires an 'interrupted' error on any in-progress utterance,
  // which causes the previous speak()'s onerror handler to fire and
  // resolve its promise early. The caller is responsible for calling
  // stopTts() before starting a new utterance if barge-in is desired.

  await ensureVoices();

  const utterance = new SpeechSynthesisUtterance(text);

  // Pick a good English voice if available.
  const voices = speechSynthesis.getVoices();
  const englishVoice = voices.find(
    (v) => v.lang.startsWith("en") && v.default,
  ) || voices.find((v) => v.lang.startsWith("en"));
  if (englishVoice) {
    utterance.voice = englishVoice;
  }

  // Moderate rate for clarity — not too fast, not too slow.
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  // Notify Rust that TTS is starting (suppresses wake detection)
  void emitTtsEvent("tts-started");

  utterance.onend = () => {
    // Notify Rust that TTS has ended (resumes wake detection after 500ms grace)
    void emitTtsEvent("tts-ended");
    onEnd?.();
  };

  utterance.onerror = (e) => {
    console.warn("TTS error:", e);
    void emitTtsEvent("tts-ended");
    onEnd?.();
  };

  speechSynthesis.speak(utterance);
}

/**
 * Stop any in-progress speech immediately (barge-in).
 * Called when the user wakes NEXUS while it's speaking, or on cancel.
 */
export function stopTts(): void {
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.cancel();
  }
  // Notify Rust that TTS has ended
  void emitTtsEvent("tts-ended");
  useAssistant.getState().setSpeakSeq(null);
}

/**
 * Check if the Web Speech API is available on this platform.
 */
export function ttsAvailable(): boolean {
  return typeof speechSynthesis !== "undefined";
}
