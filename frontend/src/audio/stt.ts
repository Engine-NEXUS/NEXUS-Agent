import { invoke } from "@tauri-apps/api/core";

/**
 * Local Speech-to-Text interface.
 *
 * Calls the Rust `transcribe_audio` command, which sends raw 16-bit PCM
 * to a LOCAL faster-whisper server (localhost:8000). Audio never leaves
 * the device — only the resulting transcript text is sent to the remote
 * NEXUS server.
 */

/**
 * Transcribe raw 16-bit mono PCM audio to text via the local STT server.
 *
 * @param samples - Raw 16-bit LE mono PCM at 16 kHz
 * @returns Transcribed text, or empty string on failure
 */
export async function transcribeAudio(samples: Int16Array): Promise<string> {
  // Convert Int16Array to a plain array for Tauri IPC serialization.
  const payload = Array.from(samples);
  try {
    const text = await invoke<string>("transcribe_audio", { samples: payload });
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
  try {
    return await invoke<boolean>("stt_status");
  } catch {
    return false;
  }
}
