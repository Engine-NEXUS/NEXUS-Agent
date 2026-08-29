/**
 * Local & Cloud Speech-to-Text interface.
 *
 * Supports Gemini 3.5 Transcribe API (ultra low latency, 85+ languages)
 * with automatic fallback to local faster-whisper server (127.0.0.1:39217).
 */

function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}

/** STT timeout — first call loads the whisper model (~10s on CPU), so allow 30s. */
const STT_TIMEOUT_MS = 30000;

/**
 * Convert 16kHz mono PCM16 samples to WAV Base64 string for Gemini 3.5 Transcribe.
 */
function pcmToWavBase64(samples: Int16Array, sampleRate = 16000): string {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  /* RIFF header */
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); // 16-bit
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Transcribe speech using Google Gemini Transcribe (gemini-2.0-flash with gemini-1.5-flash fallback).
 */
export async function transcribeGeminiAudio(
  samples: Int16Array,
  apiKey: string,
): Promise<string> {
  const models = ["gemini-2.0-flash", "gemini-1.5-flash"];
  const base64Wav = pcmToWavBase64(samples, 16000);

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`,
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
                    inline_data: {
                      mime_type: "audio/wav",
                      data: base64Wav,
                    },
                  },
                  {
                    text: "Transcribe the spoken audio accurately into text. Return ONLY the raw transcript text without markdown, quotes, or conversational commentary.",
                  },
                ],
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (text.trim()) {
        return text.trim();
      }
    } catch {
      // Try next model
    }
  }

  return "";
}

/**
 * Transcribe speech via Cloudflare Worker serverless endpoint (@cf/openai/whisper).
 */
export async function transcribeWorkerAudio(
  samples: Int16Array,
  serverUrl: string,
): Promise<string> {
  if (!serverUrl || serverUrl.includes("example.workers.dev")) return "";
  try {
    const base64Wav = pcmToWavBase64(samples, 16000);
    const endpoint = `${serverUrl.replace(/\/+$/, "")}/api/transcribe`;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_base64: base64Wav }),
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      if (data.text) return data.text.trim();
    }
  } catch (err) {
    console.warn("[STT] Worker transcribe failed:", err);
  }
  return "";
}

/**
 * Transcribe raw 16-bit mono PCM audio to text with multi-tier fallbacks:
 * 1. Gemini Transcribe (gemini-2.0-flash)
 * 2. Local Faster-Whisper (127.0.0.1:39217)
 * 3. Cloudflare Worker (@cf/openai/whisper)
 *
 * @param samples - Raw 16-bit LE mono PCM at 16 kHz
 * @returns Transcribed text, or empty string on failure
 */
export async function transcribeAudio(samples: Int16Array): Promise<string> {
  if (!isTauri()) return "";

  let settings: any = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    settings = await invoke<any>("get_settings").catch(() => null);
  } catch {}

  // Tier 1: Gemini 2.0 / 1.5 Flash Transcribe
  if (settings?.geminiApiKey && settings.geminiApiKey.startsWith("AIza")) {
    const geminiText = await transcribeGeminiAudio(samples, settings.geminiApiKey);
    if (geminiText) return geminiText;
  }

  // Tier 2: Local Faster-Whisper STT (127.0.0.1:39217)
  const payload = Array.from(samples);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await Promise.race([
      invoke<string>("transcribe_audio", { samples: payload }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("STT timeout")), STT_TIMEOUT_MS),
      ),
    ]);
    if (text && text.trim()) return text.trim();
  } catch {
    // Local STT not running, fall through to Tier 3
  }

  // Tier 3: Cloudflare Worker Whisper
  if (settings?.serverUrl) {
    const workerText = await transcribeWorkerAudio(samples, settings.serverUrl);
    if (workerText) return workerText;
  }

  return "";
}

/**
 * Check if the local STT server is reachable.
 * @returns true if the local STT server is running and healthy
 */
export async function sttStatus(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("stt_status");
  } catch {
    return false;
  }
}
