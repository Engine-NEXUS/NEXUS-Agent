import { useAssistant } from "../store/assistant";

export interface VoiceOption {
  id: string;
  name: string;
  provider: "neural" | "elevenlabs" | "fish_audio" | "system";
  accent: string;
  description: string;
  elevenVoiceId?: string;
  fishModelId?: string;
  locale: string;
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
    locale: "en-GB",
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
    locale: "en-US",
    gender: "female",
    sampleText: "Hello! I'm ready to help you with your workflow today.",
  },
  {
    id: "echo",
    name: "Echo",
    provider: "neural",
    accent: "Australian (AU)",
    description: "Fast, energetic, high-clarity tech companion.",
    elevenVoiceId: "TxGEqnHWrfWFTfGW9XjX", // Josh
    locale: "en-AU",
    gender: "male",
    sampleText: "Ready to build. What repository are we analyzing?",
  },
  {
    id: "onyx",
    name: "Onyx",
    provider: "neural",
    accent: "Deep Tech (CA)",
    description: "Deep, commanding, grounded baritone.",
    elevenVoiceId: "VR6AewLTigWG4xSOukaG", // Arnold
    locale: "en-CA",
    gender: "male",
    sampleText: "NEXUS online. Awaiting your commands.",
  },
];

let activeAudio: HTMLAudioElement | null = null;

async function emitTtsEvent(event: string): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event);
  } catch {
    // Ignore
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

/**
 * Play audio stream using HTML5 Audio element.
 */
function playAudioUrl(url: string, onEnd?: () => void): Promise<void> {
  return new Promise((resolve) => {
    stopTts();
    void emitTtsEvent("tts-started");

    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.src = url;
    activeAudio = audio;

    const cleanup = () => {
      if (activeAudio === audio) {
        activeAudio = null;
      }
      void emitTtsEvent("tts-ended");
      onEnd?.();
      resolve();
    };

    audio.onended = cleanup;
    audio.onerror = (e) => {
      console.warn("Audio playback error on url:", url, e);
      cleanup();
    };

    audio.play().catch((err) => {
      console.warn("Audio play() rejected:", err);
      cleanup();
    });
  });
}

/**
 * Stream speech audio from Google TTS endpoint with locale.
 */
function playStreamTts(text: string, locale: string, onEnd?: () => void): Promise<void> {
  const encoded = encodeURIComponent(text);
  const streamUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${locale}&client=tw-ob&q=${encoded}`;
  return playAudioUrl(streamUrl, onEnd);
}

/**
 * Stream speech from ElevenLabs API.
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
      throw new Error(`ElevenLabs error: ${response.status}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    return playAudioUrl(blobUrl, () => {
      URL.revokeObjectURL(blobUrl);
      onEnd?.();
    });
  } catch (err) {
    console.warn("ElevenLabs failed, falling back to neural stream:", err);
    return playStreamTts(text, "en-GB", onEnd);
  }
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

  if (customApiKey && voice.elevenVoiceId) {
    return playElevenLabs(voice.sampleText, voice.elevenVoiceId, customApiKey, onEnd);
  }

  return playStreamTts(voice.sampleText, voice.locale || "en-US", onEnd);
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
  const elevenKey = settings?.elevenlabsApiKey;

  const curated = CURATED_VOICES.find((v) => v.id === voiceId) || CURATED_VOICES[0];

  if (elevenKey && curated?.elevenVoiceId) {
    return playElevenLabs(text, curated.elevenVoiceId, elevenKey, onEnd);
  }

  return playStreamTts(text, curated?.locale || "en-US", onEnd);
}

/**
 * Stop any in-progress speech immediately (barge-in).
 */
export function stopTts(): void {
  if (activeAudio) {
    try {
      activeAudio.pause();
      activeAudio.currentTime = 0;
    } catch {}
    activeAudio = null;
  }
  if (typeof speechSynthesis !== "undefined") {
    try {
      speechSynthesis.cancel();
    } catch {}
  }
  void emitTtsEvent("tts-ended");
  useAssistant.getState().setSpeakSeq(null);
}

export function ttsAvailable(): boolean {
  return true;
}
