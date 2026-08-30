import { useAssistant } from "../store/assistant";

export interface VoiceOption {
  id: string;
  name: string;
  provider: "google_cloud" | "neural" | "elevenlabs" | "fish_audio" | "gemini_tts" | "system";
  accent: string;
  description: string;
  elevenVoiceId?: string;
  fishModelId?: string;
  geminiModelId?: string;
  googleVoiceId?: string;
  locale: string;
  gender: "male" | "female";
  sampleText: string;
}

export const CURATED_VOICES: VoiceOption[] = [
  // ── Fish Audio s2.1-pro-free (FREE — no credit card, no billing) ──
  {
    id: "jarvis",
    name: "Jarvis (Fish Audio)",
    provider: "fish_audio",
    accent: "British (UK)",
    description: "Sophisticated British butler voice. Refined, calm, authoritative. Powered by Fish Audio S2.1 Pro Free. No credit card required.",
    fishModelId: "17e9990aa92c4da8b09ad3f0f2231e48",
    locale: "en-GB",
    gender: "male",
    sampleText: "At your service, sir. All systems are operational and ready for your commands.",
  },
  {
    id: "ethan",
    name: "Ethan (Fish Audio)",
    provider: "fish_audio",
    accent: "Conversational (US)",
    description: "Ultra-realistic male voice. Conversational, warm, natural. Powered by Fish Audio S2.1 Pro Free. No credit card required.",
    fishModelId: "536d3a5e000945adb7038665781a4aca",
    locale: "en-US",
    gender: "male",
    sampleText: "Hello sir. I'm Ethan, running on Fish Audio S2.1 Pro Free.",
  },
  {
    id: "nova",
    name: "Nova (Fish Audio)",
    provider: "fish_audio",
    accent: "American (US)",
    description: "Warm, natural, intelligent female voice. Powered by Fish Audio S2.1 Pro Free. No credit card required.",
    fishModelId: "00a1b221-6137-4b73-ad62-b0cbce134167",
    locale: "en-US",
    gender: "female",
    sampleText: "Hello! I'm ready to help you with your workflow today.",
  },
  // ── Web Speech API fallbacks (offline, always available) ──
  {
    id: "jarvis_offline",
    name: "Jarvis (Offline Fallback)",
    provider: "neural",
    accent: "British (UK)",
    description: "Crisp, articulate, calm executive assistant. Offline Web Speech fallback when no API key is set.",
    elevenVoiceId: "pNInz6obpgDQGcFmaJgB",
    locale: "en-GB",
    gender: "male",
    sampleText: "At your service sir. All systems are operational.",
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
 * Synthesize speech via Google Cloud Text-to-Speech API.
 * Supports Chirp3-HD, WaveNet, Neural2, and Standard voices.
 * Returns MP3 audio via the v1 text:synthesize endpoint.
 */
export async function playGoogleCloudTTS(
  text: string,
  voiceId: string,
  apiKey: string,
  onEnd?: () => void,
): Promise<void> {
  stopTts();
  void emitTtsEvent("tts-started");

  try {
    // Extract language code from voice ID (e.g., "en-GB" from "en-GB-Chirp3-HD-Algenib")
    const langCode = voiceId.split("-").slice(0, 2).join("-");

    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey.trim()}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: { text },
          voice: {
            languageCode: langCode,
            name: voiceId,
          },
          audioConfig: {
            audioEncoding: "MP3",
            speakingRate: 1.0,
            pitch: 0.0,
            volumeGainDb: 0.0,
          },
        }),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Google Cloud TTS error: ${response.status} ${errBody}`);
    }

    const data = await response.json();
    const audioContent = data.audioContent;
    if (!audioContent) {
      throw new Error("Google Cloud TTS returned no audio content");
    }

    // The API returns base64-encoded MP3
    const audioUrl = `data:audio/mp3;base64,${audioContent}`;
    return playAudioUrl(audioUrl, onEnd);
  } catch (err) {
    console.warn("[TTS] Google Cloud TTS failed, falling back to WebSpeech:", err);
    const fallbackVoice = CURATED_VOICES.find((v) => v.googleVoiceId === voiceId) || CURATED_VOICES[0];
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
        model: "s2.1-pro-free",
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

  // Fish Audio — primary provider (free, no credit card)
  if (voice.provider === "fish_audio" && voice.fishModelId) {
    const apiKey = customApiKey || settings?.fishAudioApiKey;
    if (apiKey) {
      return playFishAudio(voice.sampleText, voice.fishModelId, apiKey, onEnd);
    }
    console.warn("[TTS] No Fish Audio API key set, falling back to WebSpeech for preview");
  }

  // Google Cloud TTS (if key is set)
  if (voice.provider === "google_cloud" && voice.googleVoiceId) {
    const apiKey = customApiKey || settings?.googleCloudApiKey;
    if (apiKey) {
      return playGoogleCloudTTS(voice.sampleText, voice.googleVoiceId, apiKey, onEnd);
    }
  }

  // Legacy Gemini TTS
  if (voice.provider === "gemini_tts") {
    const apiKey = customApiKey || settings?.geminiApiKey;
    if (apiKey) {
      return playGeminiTts(voice.sampleText, apiKey, onEnd);
    }
  }

  if (customApiKey && voice.elevenVoiceId) {
    return playElevenLabs(voice.sampleText, voice.elevenVoiceId, customApiKey, onEnd);
  }

  // Fallback: WebSpeech API with Web Audio fallback
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
  const voiceId = settings?.ttsVoice || "jarvis";
  const fishKey = settings?.fishAudioApiKey;

  const curated = CURATED_VOICES.find((v) => v.id === voiceId) || CURATED_VOICES[0];

  // 1st: Fish Audio s2.1-pro-free (primary — free, no credit card)
  if (curated?.fishModelId && fishKey) {
    return playFishAudio(text, curated.fishModelId, fishKey, onEnd);
  }

  // 2nd: Google Cloud TTS (if key is set)
  if (curated?.provider === "google_cloud" && curated.googleVoiceId && settings?.googleCloudApiKey) {
    return playGoogleCloudTTS(text, curated.googleVoiceId, settings.googleCloudApiKey, onEnd);
  }

  // 3rd: Legacy Gemini TTS (if key is set)
  if (curated?.provider === "gemini_tts" && settings?.geminiApiKey) {
    return playGeminiTts(text, settings.geminiApiKey, onEnd);
  }

  // 4th: Legacy ElevenLabs (if key is set)
  if (settings?.elevenlabsApiKey && curated?.elevenVoiceId) {
    return playElevenLabs(text, curated.elevenVoiceId, settings.elevenlabsApiKey, onEnd);
  }

  // Last resort: Web Speech API (always available, offline)
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
