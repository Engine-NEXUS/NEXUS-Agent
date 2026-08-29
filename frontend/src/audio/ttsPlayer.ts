import { useAssistant } from "../store/assistant";

export interface VoiceOption {
  id: string;
  name: string;
  provider: "neural" | "elevenlabs" | "fish_audio" | "system";
  accent: string;
  description: string;
  elevenVoiceId?: string;
  fishModelId?: string;
  gender: "male" | "female";
  sampleText: string;
}

export const CURATED_VOICES: VoiceOption[] = [
  {
    id: "jarvis",
    name: "Jarvis",
    provider: "neural",
    accent: "British (UK)",
    description: "Crisp, articulate, calm executive assistant.",
    elevenVoiceId: "pNInz6obpgDQGcFmaJgB", // Adam
    gender: "male",
    sampleText: "At your service sir. All systems are operational.",
  },
  {
    id: "nova",
    name: "Nova",
    provider: "neural",
    accent: "American (US)",
    description: "Warm, natural, intelligent conversationalist.",
    elevenVoiceId: "21m00Tcm4TlvDq8ikWAM", // Rachel
    gender: "female",
    sampleText: "Hello! I'm ready to help you with your workflow today.",
  },
  {
    id: "echo",
    name: "Echo",
    provider: "neural",
    accent: "American (US)",
    description: "Fast, energetic, high-clarity tech companion.",
    elevenVoiceId: "TxGEqnHWrfWFTfGW9XjX", // Josh
    gender: "male",
    sampleText: "Ready to build. What repository are we analyzing?",
  },
  {
    id: "onyx",
    name: "Onyx",
    provider: "neural",
    accent: "Deep Tech",
    description: "Deep, commanding, grounded baritone.",
    elevenVoiceId: "VR6AewLTigWG4xSOukaG", // Arnold
    gender: "male",
    sampleText: "NEXUS online. Awaiting your commands.",
  },
];

let voicesLoaded = false;
let activeAudio: HTMLAudioElement | null = null;

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

async function isMeetingActive(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("meeting_active");
  } catch {
    return false;
  }
}

async function emitTtsEvent(event: string): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event);
  } catch {
    // Ignore
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

/**
 * Play synthesized speech audio from ElevenLabs REST streaming API.
 */
async function playElevenLabs(
  text: string,
  voiceId: string,
  apiKey: string,
  onEnd?: () => void,
): Promise<void> {
  stopTts();
  void emitTtsEvent("tts-started");

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`ElevenLabs error: ${response.status} ${response.statusText}`);
    }

    const blob = await response.blob();
    const audioUrl = URL.createObjectURL(blob);
    const audio = new Audio(audioUrl);
    activeAudio = audio;

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      activeAudio = null;
      void emitTtsEvent("tts-ended");
      onEnd?.();
    };

    audio.onerror = (e) => {
      console.warn("ElevenLabs audio playback error:", e);
      URL.revokeObjectURL(audioUrl);
      activeAudio = null;
      void emitTtsEvent("tts-ended");
      onEnd?.();
    };

    await audio.play();
  } catch (err) {
    console.warn("ElevenLabs TTS failed, falling back to Web Speech:", err);
    void emitTtsEvent("tts-ended");
    return playWebSpeech(text, "jarvis", onEnd);
  }
}

/**
 * Play synthesized speech using Web Speech API with the best neural voice match.
 */
async function playWebSpeech(
  text: string,
  voiceId: string,
  onEnd?: () => void,
  rate = 1.0,
): Promise<void> {
  if (typeof speechSynthesis === "undefined") {
    onEnd?.();
    return;
  }

  await ensureVoices();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();

  // Find best matching voice according to selected persona
  let selectedVoice: SpeechSynthesisVoice | undefined;

  if (voiceId === "jarvis") {
    selectedVoice =
      voices.find((v) => v.lang === "en-GB" && (v.name.includes("Natural") || v.name.includes("Ryan") || v.name.includes("George"))) ||
      voices.find((v) => v.lang.startsWith("en-GB")) ||
      voices.find((v) => v.lang.startsWith("en"));
    utterance.pitch = 0.95;
    utterance.rate = 1.0 * rate;
  } else if (voiceId === "nova") {
    selectedVoice =
      voices.find((v) => v.lang.startsWith("en") && (v.name.includes("Jenny") || v.name.includes("Samantha") || v.name.includes("Natural"))) ||
      voices.find((v) => v.lang.startsWith("en-US")) ||
      voices.find((v) => v.lang.startsWith("en"));
    utterance.pitch = 1.05;
    utterance.rate = 1.02 * rate;
  } else if (voiceId === "echo") {
    selectedVoice =
      voices.find((v) => v.lang.startsWith("en") && (v.name.includes("Guy") || v.name.includes("Josh"))) ||
      voices.find((v) => v.lang.startsWith("en-US")) ||
      voices.find((v) => v.lang.startsWith("en"));
    utterance.pitch = 1.0;
    utterance.rate = 1.1 * rate;
  } else if (voiceId === "onyx") {
    selectedVoice =
      voices.find((v) => v.lang.startsWith("en") && (v.name.includes("Christopher") || v.name.includes("Daniel") || v.name.includes("David"))) ||
      voices.find((v) => v.lang.startsWith("en"));
    utterance.pitch = 0.85;
    utterance.rate = 0.95 * rate;
  } else {
    selectedVoice = voices.find((v) => v.name === voiceId) || voices.find((v) => v.lang.startsWith("en"));
    utterance.pitch = 1.0;
    utterance.rate = rate;
  }

  if (selectedVoice) {
    utterance.voice = selectedVoice;
  }

  utterance.volume = 1.0;

  void emitTtsEvent("tts-started");

  utterance.onend = () => {
    void emitTtsEvent("tts-ended");
    onEnd?.();
  };

  utterance.onerror = (e) => {
    console.warn("Web Speech TTS error:", e);
    void emitTtsEvent("tts-ended");
    onEnd?.();
  };

  speechSynthesis.speak(utterance);
}

/**
 * Preview / test a voice sample instantly (e.g. from the Setup Wizard or Settings).
 */
export async function previewVoice(
  voice: VoiceOption,
  customApiKey?: string,
  onEnd?: () => void,
): Promise<void> {
  stopTts();

  if (voice.provider === "elevenlabs" && (customApiKey || voice.elevenVoiceId)) {
    const key = customApiKey;
    if (key && voice.elevenVoiceId) {
      return playElevenLabs(voice.sampleText, voice.elevenVoiceId, key, onEnd);
    }
  }

  return playWebSpeech(voice.sampleText, voice.id, onEnd);
}

/**
 * Speak text aloud using user's configured voice preferences.
 */
export async function speak(text: string, onEnd?: () => void): Promise<void> {
  const meeting = await isMeetingActive();
  if (meeting) {
    console.log("[TTS] Suppressed — meeting mode active");
    onEnd?.();
    return;
  }

  const settings = await getSavedSettings();
  const voiceId = settings?.ttsVoice || "jarvis";
  const rate = settings?.speechRate || 1.0;
  const elevenKey = settings?.elevenlabsApiKey;

  const curated = CURATED_VOICES.find((v) => v.id === voiceId);

  if (elevenKey && curated?.elevenVoiceId) {
    return playElevenLabs(text, curated.elevenVoiceId, elevenKey, onEnd);
  }

  return playWebSpeech(text, voiceId, onEnd, rate);
}

/**
 * Stop any in-progress speech immediately (barge-in).
 */
export function stopTts(): void {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.cancel();
  }
  void emitTtsEvent("tts-ended");
  useAssistant.getState().setSpeakSeq(null);
}

export function ttsAvailable(): boolean {
  return typeof speechSynthesis !== "undefined";
}
