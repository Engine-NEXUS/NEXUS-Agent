import { useAssistant } from "../store/assistant";

export interface VoiceOption {
  id: string;
  name: string;
  provider: "neural" | "elevenlabs" | "fish_audio" | "gemini_tts" | "system";
  accent: string;
  description: string;
  elevenVoiceId?: string;
  fishModelId?: string;
  geminiModelId?: string;
  locale: string;
  gender: "male" | "female";
  sampleText: string;
}

export const CURATED_VOICES: VoiceOption[] = [
  {
    id: "gemini_flash",
    name: "Gemini Flash (Google AI)",
    provider: "gemini_tts",
    accent: "Natural Expressive (US)",
    description: "Ultra low-latency speech powered by Gemini 3.1 Flash TTS Preview.",
    geminiModelId: "gemini-3.1-flash-tts-preview",
    locale: "en-US",
    gender: "male",
    sampleText: "Hello! I'm Gemini Flash TTS, ready for instant speech synthesis.",
  },
  {
    id: "ethan",
    name: "Ethan (Fish Audio)",
    provider: "fish_audio",
    accent: "Conversational (US)",
    description: "Ultra-realistic male voice powered by Fish Audio s2.1-pro model.",
    fishModelId: "536d3a5e000945adb7038665781a4aca",
    locale: "en-US",
    gender: "male",
    sampleText: "Hello sir. I'm Ethan, running on Fish Audio s2.1-pro.",
  },
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
let audioCtx: AudioContext | null = null;

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
      console.warn("[TTS] Audio playback error on url:", url, e);
      cleanup();
    };

    audio.play().catch((err) => {
      console.warn("[TTS] Audio play() rejected:", err);
      cleanup();
    });
  });
}

/**
 * Web Audio API synth voice sound generator as an instant offline fallback.
 * Produces persona-tuned melodic speech chords when network/speech-synth is unavailable.
 */
function playSynthVoiceSignature(voiceId: string, onEnd?: () => void): Promise<void> {
  return new Promise((resolve) => {
    stopTts();
    void emitTtsEvent("tts-started");

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        onEnd?.();
        resolve();
        return;
      }

      audioCtx = new AudioContextClass();
      const ctx = audioCtx;

      let freqs: number[] = [440, 660, 880];
      if (voiceId === "jarvis") freqs = [330, 440, 550, 660]; // Butler Executive
      else if (voiceId === "nova") freqs = [523.25, 659.25, 783.99]; // Warm Major
      else if (voiceId === "echo") freqs = [880, 1108.73, 1318.51]; // Bright Tech
      else if (voiceId === "onyx") freqs = [110, 164.81, 220]; // Deep Baritone

      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.15, ctx.currentTime);
      masterGain.connect(ctx.destination);

      freqs.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const noteGain = ctx.createGain();

        osc.type = voiceId === "onyx" ? "sawtooth" : voiceId === "jarvis" ? "triangle" : "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.1);

        noteGain.gain.setValueAtTime(0.01, ctx.currentTime);
        noteGain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + idx * 0.1 + 0.05);
        noteGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.1 + 0.4);

        osc.connect(noteGain);
        noteGain.connect(masterGain);

        osc.start(ctx.currentTime + idx * 0.1);
        osc.stop(ctx.currentTime + idx * 0.1 + 0.45);
      });

      setTimeout(() => {
        try {
          ctx.close();
        } catch {}
        audioCtx = null;
        void emitTtsEvent("tts-ended");
        onEnd?.();
        resolve();
      }, freqs.length * 100 + 450);
    } catch (err) {
      console.warn("[TTS] Synth fallback error:", err);
      void emitTtsEvent("tts-ended");
      onEnd?.();
      resolve();
    }
  });
}

/**
 * Web Speech API speech synthesizer with WebKitGTK safety timeouts.
 */
function playWebSpeech(text: string, voice: VoiceOption, onEnd?: () => void): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === "undefined") {
      void playSynthVoiceSignature(voice.id, onEnd).then(resolve);
      return;
    }

    stopTts();
    void emitTtsEvent("tts-started");

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice.locale || "en-US";

    if (voice.id === "jarvis") {
      utterance.pitch = 0.9;
      utterance.rate = 0.95;
    } else if (voice.id === "nova") {
      utterance.pitch = 1.1;
      utterance.rate = 1.0;
    } else if (voice.id === "echo") {
      utterance.pitch = 1.05;
      utterance.rate = 1.1;
    } else if (voice.id === "onyx") {
      utterance.pitch = 0.75;
      utterance.rate = 0.9;
    }

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(safetyTimer);
      void emitTtsEvent("tts-ended");
      onEnd?.();
      resolve();
    };

    // 6-second safety watchdog in case WebKitGTK/WebView2 drops speech synthesis events
    const safetyTimer = setTimeout(() => {
      if (!finished) {
        console.warn("[TTS] WebSpeech watchdog triggered — falling back to synth voice");
        try {
          speechSynthesis.cancel();
        } catch {}
        // Try synth voice fallback before giving up
        void playSynthVoiceSignature(voice.id, onEnd).then(resolve);
        cleanup();
      }
    }, 6000);

    utterance.onend = cleanup;
    utterance.onerror = (e) => {
      console.warn("[TTS] WebSpeech error:", e);
      // Don't immediately give up — try synth voice fallback
      if (!finished) {
        clearTimeout(safetyTimer);
        finished = true;
        void playSynthVoiceSignature(voice.id, onEnd).then(resolve);
      }
    };

    try {
      // Pick matching voice if available in system
      const systemVoices = speechSynthesis.getVoices();
      const match = systemVoices.find(
        (v) => v.lang.startsWith(voice.locale.slice(0, 2)) || v.lang.includes(voice.locale)
      );
      if (match) utterance.voice = match;

      // WebView2 bug: calling speak() immediately after cancel() can cause
      // SpeechSynthesisErrorEvent. Add a 50ms delay to let the cancel settle.
      setTimeout(() => {
        if (finished) return;
        try {
          speechSynthesis.speak(utterance);
        } catch (err) {
          console.warn("[TTS] speechSynthesis.speak failed:", err);
          cleanup();
        }
      }, 50);
    } catch (err) {
      console.warn("[TTS] speechSynthesis setup failed:", err);
      cleanup();
    }
  });
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
    console.warn("[TTS] ElevenLabs failed, falling back to WebSpeech:", err);
    const fallbackVoice = CURATED_VOICES.find((v) => v.elevenVoiceId === voiceId) || CURATED_VOICES[0];
    return playWebSpeech(text, fallbackVoice, onEnd);
  }
}

/**
 * Stream speech from Fish Audio API (s2.1-pro model).
 */
export async function playFishAudio(
  text: string,
  referenceId: string,
  apiKey: string,
  onEnd?: () => void,
): Promise<void> {
  stopTts();
  void emitTtsEvent("tts-started");

  try {
    const response = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        text,
        reference_id: referenceId,
        format: "mp3",
        latency: "normal",
        model: "s2.1-pro",
      }),
    });

    if (!response.ok) {
      throw new Error(`Fish Audio API error: ${response.status} ${response.statusText}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    return playAudioUrl(blobUrl, () => {
      URL.revokeObjectURL(blobUrl);
      onEnd?.();
    });
  } catch (err) {
    console.warn("[TTS] Fish Audio API failed, falling back to WebSpeech:", err);
    const fallbackVoice = CURATED_VOICES.find((v) => v.fishModelId === referenceId) || CURATED_VOICES[0];
    return playWebSpeech(text, fallbackVoice, onEnd);
  }
}

/**
 * Stream speech from Gemini 3.1 Flash TTS Preview model.
 */
export async function playGeminiTts(
  text: string,
  apiKey: string,
  onEnd?: () => void,
): Promise<void> {
  stopTts();
  void emitTtsEvent("tts-started");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey.trim()}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Read the following text aloud with natural tone: ${text}`,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Kore" // Good default voice
                }
              }
            }
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Gemini Flash TTS API error: ${response.status}`);
    }

    const data = await response.json();
    const base64Pcm = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Pcm) {
      throw new Error("No audio data returned");
    }

    // Decode base64 PCM to binary string
    const binary = atob(base64Pcm);
    const pcmData = new Int16Array(binary.length / 2);
    for (let i = 0; i < binary.length; i += 2) {
      // Little-endian
      pcmData[i / 2] = binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8);
    }

    // Create WAV header for 24kHz Mono 16-bit
    const sampleRate = 24000;
    const wavBuffer = new ArrayBuffer(44 + pcmData.length * 2);
    const view = new DataView(wavBuffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + pcmData.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // Byte rate
    view.setUint16(32, 2, true); // Block align
    view.setUint16(34, 16, true); // Bits per sample
    writeStr(36, "data");
    view.setUint32(40, pcmData.length * 2, true);

    let offset = 44;
    for (let i = 0; i < pcmData.length; i++, offset += 2) {
      view.setInt16(offset, pcmData[i], true);
    }

    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const blobUrl = URL.createObjectURL(blob);
    return playAudioUrl(blobUrl, () => {
      URL.revokeObjectURL(blobUrl);
      onEnd?.();
    });
  } catch (err) {
    console.warn("[TTS] Gemini Flash TTS failed, falling back to WebSpeech:", err);
    return playWebSpeech(text, CURATED_VOICES[0], onEnd);
  }
}

/**
 * Preview / test a voice sample instantly (from Setup Wizard or Settings).
 */
export async function previewVoice(
  voice: VoiceOption,
  customApiKey?: string,
  onEnd?: () => void,
): Promise<void> {
  stopTts();

  const settings = await getSavedSettings();

  const DEFAULT_GEMINI_KEY = "AQ.Ab8RN6IQHjANZWrQJn2AgOee37Sqln_aYlEOJUraqW1L54Lkug";

  if (voice.provider === "gemini_tts") {
    const apiKey = customApiKey || settings?.geminiApiKey || DEFAULT_GEMINI_KEY;
    if (apiKey) {
      return playGeminiTts(voice.sampleText, apiKey, onEnd);
    }
  }

  if (voice.provider === "fish_audio" && voice.fishModelId) {
    const apiKey = customApiKey || settings?.fishAudioApiKey;
    if (apiKey) {
      return playFishAudio(voice.sampleText, voice.fishModelId, apiKey, onEnd);
    }
  }

  if (customApiKey && voice.elevenVoiceId) {
    return playElevenLabs(voice.sampleText, voice.elevenVoiceId, customApiKey, onEnd);
  }

  // Primary preview: WebSpeech API with Web Audio fallback
  return playWebSpeech(voice.sampleText, voice, onEnd);
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
  const voiceId = settings?.ttsVoice || "gemini_flash";
  const elevenKey = settings?.elevenlabsApiKey;
  const fishKey = settings?.fishAudioApiKey;
  
  const DEFAULT_GEMINI_KEY = "AQ.Ab8RN6IQHjANZWrQJn2AgOee37Sqln_aYlEOJUraqW1L54Lkug";
  const geminiKey = settings?.geminiApiKey || DEFAULT_GEMINI_KEY;

  const curated = CURATED_VOICES.find((v) => v.id === voiceId) || CURATED_VOICES[0];

  if (curated?.provider === "gemini_tts" && geminiKey) {
    return playGeminiTts(text, geminiKey, onEnd);
  }

  if (curated?.fishModelId && fishKey) {
    return playFishAudio(text, curated.fishModelId, fishKey, onEnd);
  }

  if (elevenKey && curated?.elevenVoiceId) {
    return playElevenLabs(text, curated.elevenVoiceId, elevenKey, onEnd);
  }

  return playWebSpeech(text, curated, onEnd);
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
  if (audioCtx) {
    try {
      audioCtx.close();
    } catch {}
    audioCtx = null;
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
