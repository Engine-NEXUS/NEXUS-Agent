import { finishCapture } from "./recorder";
import { useAssistant } from "../store/assistant";

/**
 * Voice Activity Detection.
 *
 * Primary: `@ricky0123/vad-web` (Silero ONNX model, runs in a Web Worker → near-zero main-thread cost).
 * Fallback: a lightweight RMS AudioWorklet energy gate (used if the ONNX model fails to load).
 *
 * On speech-end → `finishCapture()` → server processes the stream → state moves to `thinking`.
 */

// ---- Configuration ----
const VAD_FALLBACK_RMS = 0.012;     // noise floor (tune per environment)
const SILENCE_MS = 700;            // how long of silence ends an utterance
const MAX_UTTERANCE_MS = 12000;    // safety cap

let active = false;
let startedAt = 0;
let silenceSince = 0;
let sileroVadRef: { destroy: () => void } | null = null;
let rmsCtx: AudioContext | null = null;
let capTimer: number | null = null;

export async function startVad(stream: MediaStream): Promise<void> {
  if (active) return;
  active = true;
  startedAt = performance.now();
  silenceSince = 0;

  // Global safety cap: no matter which VAD backend is used, force-finish after
  // MAX_UTTERANCE_MS so a runaway session never hangs.
  capTimer = window.setTimeout(() => {
    if (!active) return;
    console.warn("VAD safety cap triggered — forcing end of utterance");
    teardown();
    void finishCapture();
  }, MAX_UTTERANCE_MS);

  // Try the ONNX VAD; on failure use RMS fallback.
  try {
    await startSileroVad(stream);
  } catch (err) {
    console.warn("silero VAD unavailable, using RMS fallback", err);
    startRmsVad(stream);
  }
}

export function stopVad(): void {
  teardown();
}

function teardown(): void {
  active = false;
  if (capTimer !== null) {
    clearTimeout(capTimer);
    capTimer = null;
  }
  if (sileroVadRef) {
    try { sileroVadRef.destroy(); } catch { /* already destroyed */ }
    sileroVadRef = null;
  }
  if (rmsCtx) {
    rmsCtx.close().catch(() => {});
    rmsCtx = null;
  }
}

// ---- RMS fallback (simple energy gate over the analyser node) ----
function startRmsVad(stream: MediaStream) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  rmsCtx = ctx;
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const tick = () => {
    if (!active) { return; }
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();

    if (rms > VAD_FALLBACK_RMS) {
      silenceSince = 0;
    } else if (silenceSince === 0) {
      silenceSince = now;
    }

    if ((silenceSince && now - silenceSince > SILENCE_MS) || now - startedAt > MAX_UTTERANCE_MS) {
      teardown();
      void finishCapture();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- Silero ONNX VAD (preferred) ----
async function startSileroVad(stream: MediaStream) {
  // Lazy import so the model only loads when needed (keeps idle RAM low).
  const { MicVAD } = await import("@ricky0123/vad-web");
  const vad = await MicVAD.new({
    preSpeechPadMs: 250,
    redemptionMs: 700,
    minSpeechMs: 250,
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    getStream: async () => stream,
    onSpeechStart: () => {
      silenceSince = 0;
    },
    onVADMisfire: () => {
      // speech too short, keep listening
    },
    onSpeechEnd: () => {
      if (!active) return;
      teardown();
      void finishCapture();
    },
  });
  sileroVadRef = vad;
  await vad.start();
}

// re-export so App can react to state changes without circular import
export const state = useAssistant.getState;
