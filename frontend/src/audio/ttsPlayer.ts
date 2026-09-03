import { useAssistant } from "../store/assistant";
import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend TTS generation counter — mirrors the Rust TTS_GENERATION counter.
 *
 * Every `stopTts()` increments this. Every `speak()` captures the current
 * value and checks it before starting playback and before firing onEnd.
 * This prevents stale Worker responses from speaking after a barge-in.
 */
let ttsGeneration = 0;

export interface VoiceOption {
  id: string;
  name: string;
  provider: "kokoro" | "system";
  accent: string;
  description: string;
  locale: string;
  gender: "male" | "female";
  sampleText: string;
}

export const CURATED_VOICES: VoiceOption[] = [
  {
    id: "af_sky",
    name: "Sky (Kokoro)",
    provider: "kokoro",
    accent: "American",
    description: "Warm, natural female voice. Runs 100% locally with low latency (~1.7s load, ~350MB RAM).",
    locale: "en-US",
    gender: "female",
    sampleText: "Hello, I am Sky. All systems are operational.",
  },
  {
    id: "am_adam",
    name: "Adam (Kokoro)",
    provider: "kokoro",
    accent: "American",
    description: "Deep, clear male voice. Runs 100% locally.",
    locale: "en-US",
    gender: "male",
    sampleText: "Hello, I am Adam. All systems are operational.",
  },
];

async function emitTtsEvent(event: string): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event);
  } catch {
    // Ignore outside Tauri
  }
}

async function isMeetingActive(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("meeting_active");
  } catch {
    return false;
  }
}

async function getSavedSettings(): Promise<any> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("get_settings");
  } catch {
    return null;
  }
}

export async function playKokoro(
  text: string,
  voiceId: string,
  speed: number,
  myGen: number,
  onEnd?: () => void,
): Promise<void> {
  // Check if barge-in happened before we even start
  if (ttsGeneration !== myGen) {
    console.log("[TTS] skipped — barge-in before playback");
    return;
  }

  void emitTtsEvent("tts-started");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // speak_text handles its own thread for rodio playback
    await invoke("speak_text", { text, voice: voiceId, speed });
  } catch (err) {
    // Only fall back to Web Speech if we haven't been barged in
    if (ttsGeneration === myGen) {
      console.error("[TTS] Kokoro failed, falling back to Web Speech:", err);
      await speakWebSpeech(text, speed);
    }
  } finally {
    void emitTtsEvent("tts-ended");
    // Only fire onEnd if not barged in — prevents stale callbacks
    if (ttsGeneration === myGen) {
      onEnd?.();
    }
  }
}

/** Web Speech API fallback — uses the browser's built-in speech synthesis. */
async function speakWebSpeech(text: string, speed: number = 1.15): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) {
      console.warn("[TTS] Web Speech API not available");
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = speed;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    // Try to use a male voice for "sir" persona
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes("David") || v.name.includes("Mark") || v.name.includes("George"))
      || voices.find(v => v.lang.startsWith("en"));
    if (preferred) utterance.voice = preferred;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

export async function previewVoice(
  voice: VoiceOption,
  _customApiKey?: string,
  onEnd?: () => void,
  speed?: number,
): Promise<void> {
  stopTts();
  if (voice.provider === "kokoro") {
    // After stopTts, capture the new generation (stopTts incremented it)
    return playKokoro(voice.sampleText, voice.id, speed ?? 1.15, ttsGeneration, onEnd);
  }
}

export async function speak(text: string, onEnd?: () => void): Promise<void> {
  const meeting = await isMeetingActive();
  if (meeting) {
    console.log("[TTS] Suppressed — meeting mode active");
    onEnd?.();
    return;
  }

  // Stop any currently-playing TTS before starting new playback.
  // This prevents overlapping audio when the server ack and result
  // arrive in quick succession (especially during first-load when
  // the Kokoro engine takes ~7s to initialize).
  stopTts();

  // Capture generation after stopTts — any in-flight speak() calls
  // from a previous turn will see the mismatch and skip playback.
  const myGen = ttsGeneration;

  const settings = await getSavedSettings();
  // Check if barge-in happened during the async getSavedSettings call
  if (ttsGeneration !== myGen) {
    console.log("[TTS] skipped — barge-in during setup");
    return;
  }

  const voiceId = settings?.ttsVoice || "af_sky";
  const speed = settings?.speechRate ?? 1.15;

  return playKokoro(text, voiceId, speed, myGen, onEnd);
}

/**
 * Speak a pre-cached TTS phrase instantly from memory.
 * Falls back to `speak` if the phrase is not cached.
 * Emits `tts:audio-started` event before playback starts.
 */
export async function speakCached(phrase: string, onEnd?: () => void): Promise<void> {
  const meeting = await isMeetingActive();
  if (meeting) {
    console.log("[TTS] Suppressed — meeting mode active");
    onEnd?.();
    return;
  }

  // Stop any currently-playing TTS before starting new playback.
  stopTts();

  const myGen = ttsGeneration;
  try {
    await invoke("speak_cached", { phrase });
    if (ttsGeneration !== myGen) return;
    onEnd?.();
  } catch (e) {
    // Fallback to regular speak if cached phrase not available
    console.warn("[TTS] speak_cached failed, falling back to speak:", e);
    return speak(phrase, onEnd);
  }
}

export function stopTts(): void {
  // Increment frontend generation — any in-flight speak() calls will
  // see the mismatch and skip playback / onEnd.
  ttsGeneration++;
  // Tell Rust to stop the rodio playback immediately (barge-in).
  // Uses static import for instant invocation — no dynamic import delay.
  void invoke("stop_tts").catch((e: unknown) => console.warn("[TTS] stop_tts failed:", e));
  // Also cancel Web Speech API if it's being used as fallback
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  void emitTtsEvent("tts-ended");
  useAssistant.getState().setSpeakSeq(null);
}

export function ttsAvailable(): boolean {
  return true;
}
