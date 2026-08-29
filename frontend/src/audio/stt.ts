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
 * Transcribe speech using Google Gemini 3.5 Transcribe API.
 */
export async function transcribeGeminiAudio(
  samples: Int16Array,
  apiKey: string,
): Promise<string> {
  try {
    const base64Wav = pcmToWavBase64(samples, 16000);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent?key=${apiKey.trim()}`,
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
                  text: "Transcribe the spoken audio accurately into text. Return ONLY the raw transcript text without markdown or conversational commentary.",
                },
              ],
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Gemini 3.5 Transcribe API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return text.trim();
  } catch (err) {
    console.warn("[STT] Gemini 3.5 Transcribe failed, falling back to local Whisper:", err);
    return "";
  }
}

/**
 * Transcribe raw 16-bit mono PCM audio to text via Gemini 3.5 Transcribe or local STT.
 *
 * @param samples - Raw 16-bit LE mono PCM at 16 kHz
 * @returns Transcribed text, or empty string on failure
 */
export async function transcribeAudio(samples: Int16Array): Promise<string> {
  if (!isTauri()) return "";

  // Check if Gemini API key is configured
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const settings = await invoke<any>("get_settings").catch(() => null);
    if (settings?.geminiApiKey) {
      const geminiText = await transcribeGeminiAudio(samples, settings.geminiApiKey);
      if (geminiText) return geminiText;
    }
  } catch {}

  // Local STT fallback
  const payload = Array.from(samples);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await Promise.race([
      invoke<string>("transcribe_audio", { samples: payload }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("STT timeout")), STT_TIMEOUT_MS),
      ),
    ]);
    return text;
  } catch (err) {
    console.error("local STT failed:", err);
    return "";
  }
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
