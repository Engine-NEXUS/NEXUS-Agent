import { useAssistant } from "../store/assistant";
import { invoke } from "@tauri-apps/api/core";

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
    description: "Clear, expressive female voice. Runs 100% locally with ultra-low latency.",
    locale: "en-US",
    gender: "female",
    sampleText: "Hello, I am Sky. All systems are operational.",
  },
  {
    id: "am_adam",
    name: "Adam (Kokoro)",
    provider: "kokoro",
    accent: "American",
    description: "Deep, natural male voice. Runs 100% locally with ultra-low latency.",
    locale: "en-US",
    gender: "male",
    sampleText: "At your service sir. Systems are online.",
  },
  {
    id: "bf_emma",
    name: "Emma (Kokoro)",
    provider: "kokoro",
    accent: "British",
    description: "Professional British female voice. Runs 100% locally.",
    locale: "en-GB",
    gender: "female",
    sampleText: "Hello. I am Emma, ready to assist you.",
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

export async function playKokoro(text: string, voiceId: string, speed?: number, onEnd?: () => void): Promise<void> {
  void emitTtsEvent("tts-started");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // speak_text handles its own thread for rodio playback
    await invoke("speak_text", { text, voice: voiceId, speed: speed ?? 1.15 });
  } catch (err) {
    console.error("[TTS] Kokoro failed, falling back to Web Speech:", err);
    // Fallback to Web Speech API if Kokoro/rodio fails
    await speakWebSpeech(text, speed ?? 1.15);
  } finally {
    void emitTtsEvent("tts-ended");
    onEnd?.();
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
    return playKokoro(voice.sampleText, voice.id, speed ?? 1.15, onEnd);
  }
}

export async function speak(text: string, onEnd?: () => void): Promise<void> {
  // Cancel any currently playing TTS (barge-in / prevent overlay)
  stopTts();

  const meeting = await isMeetingActive();
  if (meeting) {
    console.log("[TTS] Suppressed — meeting mode active");
    onEnd?.();
    return;
  }

  const settings = await getSavedSettings();
  const voiceId = settings?.ttsVoice || "af_sky";
  const speed = settings?.speechRate ?? 1.15;
  
  return playKokoro(text, voiceId, speed, onEnd);
}

export function stopTts(): void {
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
