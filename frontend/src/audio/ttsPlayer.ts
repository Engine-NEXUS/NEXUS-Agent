import { useAssistant } from "../store/assistant";

/**
 * TTS stream player.
 *
 * The server (via the sidecar) streams 16-bit 16 kHz mono PCM chunks as base64 over
 * the WebSocket. We feed them into a WebAudio `AudioBufferSourceNode` chain scheduled
 * back-to-back so playback is gapless. The avatar mouth animation is driven by the
 * chunk sequence number.
 *
 * Format: raw 16-bit LE mono PCM @ 16 kHz ONLY. The sidecar calls piper which returns
 * exactly this format; no Opus decode is needed. If a future server sends Opus, add a
 * decode step here (e.g. `opus-decoder`) and branch on a format header frame.
 */

let audioCtx: AudioContext | null = null;
let nextStartAt = 0; // scheduling cursor in seconds
let sources: AudioBufferSourceNode[] = []; // track for stopTts()

const TTS_SAMPLE_RATE = 16000;

export function ensureAudio(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE, latencyHint: "interactive" });
    nextStartAt = audioCtx.currentTime;
    sources = [];
  }
  return audioCtx;
}

export function resetTts(): void {
  nextStartAt = ensureAudio().currentTime;
}

/** Play a base64-encoded PCM frame (16-bit LE mono @ 16 kHz). */
export async function playTtsChunk(seq: number, b64: string): Promise<void> {
  const ctx = ensureAudio();
  const bytes = base64ToBytes(b64);
  // Guard against odd-length payloads (truncated frame).
  const sampleCount = Math.floor(bytes.length / 2);
  if (sampleCount === 0) return;
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
  const buf = ctx.createBuffer(1, i16.length, TTS_SAMPLE_RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < i16.length; i++) {
    ch[i] = i16[i] / 0x8000;
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;

  // Back-to-back scheduling (gapless).
  const start = Math.max(ctx.currentTime, nextStartAt);
  src.connect(ctx.destination);
  src.start(start);
  nextStartAt = start + buf.duration;
  sources.push(src);
  // Drop finished sources to avoid unbounded growth.
  src.onended = () => {
    sources = sources.filter((s) => s !== src);
  };

  useAssistant.getState().setSpeakSeq(seq);
}

/** Called on a `done` server event. Stops all scheduled sources and resets state. */
export function stopTts(): void {
  for (const s of sources) {
    try { s.stop(); } catch { /* already ended */ }
    try { s.disconnect(); } catch { /* already disconnected */ }
  }
  sources = [];
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
    nextStartAt = 0;
  }
  useAssistant.getState().setSpeakSeq(null);
  // NOTE: do NOT call store.reset() here — the `done` event handler in wsBridge.ts
  // owns the idle transition. Calling reset() here would race with that handler.
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
