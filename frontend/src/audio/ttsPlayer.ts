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
 * Speak text aloud using the local Web Speech API.
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

  // Cancel any in-progress speech (shouldn't happen if stopTts is called
  // first, but this is a safety net).
  speechSynthesis.cancel();

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

  utterance.onend = () => {
    onEnd?.();
  };

  utterance.onerror = (e) => {
    console.warn("TTS error:", e);
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
  useAssistant.getState().setSpeakSeq(null);
}

/**
 * Check if the Web Speech API is available on this platform.
 */
export function ttsAvailable(): boolean {
  return typeof speechSynthesis !== "undefined";
}
