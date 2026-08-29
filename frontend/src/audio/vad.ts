import { finishCapture, finishCaptureFromVad, getRecordingContext } from "./recorder";
import { useAssistant } from "../store/assistant";

/**
 * Voice Activity Detection using Silero ONNX VAD via @ricky0123/vad-web.
 *
 * Silero VAD is a neural network that detects speech patterns — not just
 * volume. This is the same approach used by Alexa, Siri, and Google
 * Assistant. It can distinguish speech from background noise even when
 * the speech volume is very low (RMS 0.003-0.007), which RMS energy
 * detection cannot do.
 *
 * Architecture:
 *   - MicVAD manages the audio stream and AudioWorklet
 *   - Silero ONNX model runs on each audio frame (~16ms)
 *   - onSpeechStart → UI state to "listening"
 *   - onSpeechEnd(audio) → audio is Float32Array at 16kHz → finishCaptureFromVad()
 *   - Fallback to RMS VAD if Silero fails to load
 *
 * ONNX WASM loading strategy:
 *   onnxruntime-web internally does a dynamic `import('./ort-wasm-simd-threaded.mjs')`
 *   which is incompatible with Vite's dev server pre-bundling (the .mjs file
 *   resolves to .vite/deps/ where it doesn't exist → 404).
 *   This is a known issue: microsoft/onnxruntime#20978, #22615.
 *
 *   Solution: Load ONNX WASM binaries from CDN via onnxWASMBasePath.
 *   The CDN import bypasses Vite entirely — the browser fetches .mjs and
 *   .wasm files directly from jsdelivr with proper CORS headers.
 *   Model + worklet files are served locally via viteStaticCopy.
 *
 * Audio stays local — Silero runs in the browser via ONNX Runtime Web (WASM).
 * No audio leaves the device.
 */

// Pin to the exact installed version to avoid CDN/local version mismatch.
const ORT_VERSION = "1.27.0";
const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// ---- Silero VAD configuration ----
// These thresholds are tuned for voice commands (short utterances).
// Silero returns a speech probability 0.0-1.0 per frame.
const POSITIVE_SPEECH_THRESHOLD = 0.5;  // Above this = speech detected
const NEGATIVE_SPEECH_THRESHOLD = 0.35; // Below this = silence detected
const REDEMPTION_MS = 1500;             // Grace period before declaring speech end
const PRE_SPEECH_PAD_MS = 500;          // Audio to prepend before speech start
const MIN_SPEECH_MS = 500;              // Discard segments shorter than this

// ---- State ----
let micVad: any = null;           // MicVAD instance (Silero)
let active = false;

// ---- RMS fallback state (used only if Silero fails to load) ----
const VAD_FALLBACK_RMS = 0.015;
const SILENCE_MS = 1500;
const MAX_UTTERANCE_MS = 12000;
const MIN_LISTEN_MS = 2000;
let rmsCtx: AudioContext | null = null;
let capTimer: number | null = null;
let startedAt = 0;
let silenceSince = 0;

/**
 * Pre-load the Silero VAD ONNX model + WASM runtime at app startup so
 * they're warm in the browser cache when the first wake word fires.
 * This eliminates the ~1-2s cold-start on the first wake.
 */
let sileroPreloaded = false;
let sileroPreloadPromise: Promise<void> | null = null;

export async function preloadSileroVad(): Promise<void> {
  if (sileroPreloaded || sileroPreloadPromise) return sileroPreloadPromise ?? undefined;
  sileroPreloadPromise = _preloadSilero();
  return sileroPreloadPromise;
}

async function _preloadSilero(): Promise<void> {
  try {
    console.log("[NEXUS] VAD: pre-loading Silero ONNX runtime + model...");

    // Dynamically import the VAD module (triggers Vite pre-bundling of JS).
    await import("@ricky0123/vad-web");

    // Pre-fetch the ONNX WASM .mjs and .wasm from CDN to warm the browser cache.
    // These are the files that onnxruntime-web dynamically imports at runtime.
    const cdnFetches = [
      fetch(ORT_CDN_BASE + "ort-wasm-simd-threaded.mjs"),
      fetch(ORT_CDN_BASE + "ort-wasm-simd-threaded.wasm"),
    ];

    // Also fetch the Silero model from the local server.
    const modelFetch = fetch("./silero_vad_v5.onnx");

    const [mjsResp, wasmResp, modelResp] = await Promise.all([...cdnFetches, modelFetch]);

    if (!mjsResp.ok) console.warn("[NEXUS] VAD: CDN mjs pre-fetch failed:", mjsResp.status);
    if (!wasmResp.ok) console.warn("[NEXUS] VAD: CDN wasm pre-fetch failed:", wasmResp.status);
    if (!modelResp.ok) throw new Error(`model fetch failed: ${modelResp.status}`);

    // Read bodies to ensure full download into browser cache.
    await Promise.all([mjsResp.arrayBuffer(), wasmResp.arrayBuffer(), modelResp.arrayBuffer()]);

    sileroPreloaded = true;
    console.log("[NEXUS] VAD: Silero pre-loaded (module + CDN WASM + model cached)");
  } catch (err) {
    console.warn("[NEXUS] VAD: Silero pre-load failed, will use RMS fallback:", err);
    sileroPreloaded = false;
    throw err;
  }
}

/**
 * Start VAD on an existing MediaStream.
 * Tries Silero VAD first, falls back to RMS if Silero is unavailable.
 */
export async function startVad(stream: MediaStream): Promise<void> {
  if (active) return;
  active = true;
  startedAt = performance.now();

  // Try Silero VAD first.
  try {
    await startSileroVad(stream);
    return;
  } catch (err) {
    console.warn("[NEXUS] VAD: Silero VAD failed, falling back to RMS:", err);
    active = false; // reset for RMS fallback
  }

  // Fallback to RMS energy detection.
  active = true;
  startedAt = performance.now();
  startRmsVad(stream);
}

/**
 * Stop VAD (either Silero or RMS).
 */
export function stopVad(): void {
  active = false;
  if (micVad) {
    try { micVad.pause(); } catch {}
    micVad = null;
  }
  teardownRms();
}

// ─── Silero VAD ────────────────────────────────────────────────────────────

async function startSileroVad(stream: MediaStream): Promise<void> {
  const { MicVAD } = await import("@ricky0123/vad-web");

  console.log("[NEXUS] VAD: starting Silero ONNX VAD (WASM from CDN)");

  micVad = await MicVAD.new({
    // Local files for the model and worklet (served by viteStaticCopy).
    baseAssetPath: "./",
    // CDN for ONNX WASM binaries — this is the fix for the Vite dynamic
    // import incompatibility (microsoft/onnxruntime#20978).
    // The CDN import bypasses Vite's module system entirely.
    onnxWASMBasePath: ORT_CDN_BASE,
    model: "v5",
    startOnLoad: false,
    positiveSpeechThreshold: POSITIVE_SPEECH_THRESHOLD,
    negativeSpeechThreshold: NEGATIVE_SPEECH_THRESHOLD,
    redemptionMs: REDEMPTION_MS,
    preSpeechPadMs: PRE_SPEECH_PAD_MS,
    minSpeechMs: MIN_SPEECH_MS,
    submitUserSpeechOnPause: true,
    // Also explicitly configure ort to use CDN and single-threaded mode.
    // Single-threaded avoids SharedArrayBuffer requirements (which need
    // COOP/COEP headers that may break Tauri WebView IPC).
    ortConfig: (ort: any) => {
      ort.env.wasm.wasmPaths = ORT_CDN_BASE;
      ort.env.wasm.numThreads = 1;
    },
    // Use our existing stream — MicVAD will manage the AudioWorklet
    // but we provide the stream so we don't open a second mic.
    getStream: async () => stream,
    pauseStream: async (s: MediaStream) => {
      s.getTracks().forEach((t) => (t.enabled = false));
    },
    resumeStream: async (s: MediaStream) => {
      s.getTracks().forEach((t) => (t.enabled = true));
      return s;
    },
    // Callbacks
    onSpeechStart: () => {
      console.log("[NEXUS] VAD: Silero speech start detected");
    },
    onSpeechRealStart: () => {
      console.log("[NEXUS] VAD: Silero speech real start (min frames met)");
    },
    onVADMisfire: () => {
      console.log("[NEXUS] VAD: Silero misfire (segment too short)");
    },
    onSpeechEnd: (audio: Float32Array) => {
      // audio is Float32Array at 16kHz, samples between -1 and 1.
      // This is EXACTLY what STT needs — convert to Int16 and process.
      console.log(`[NEXUS] VAD: Silero speech end (${audio.length} samples @ 16kHz)`);
      active = false;
      void finishCaptureFromVad(audio);
    },
    onFrameProcessed: (probs: { isSpeech: number; notSpeech: number }) => {
      // Optional: debug logging every 500ms
      if (Math.random() < 0.01) { // ~1% of frames to avoid spam
        console.log(`[NEXUS] VAD: Silero probs speech=${probs.isSpeech.toFixed(3)} silence=${probs.notSpeech.toFixed(3)}`);
      }
    },
  });

  await micVad.start();
  console.log("[NEXUS] VAD: Silero VAD started successfully");
}

// ─── RMS fallback (only used if Silero fails to load) ──────────────────────

function teardownRms(): void {
  if (capTimer !== null) {
    clearTimeout(capTimer);
    capTimer = null;
  }
  if (rmsCtx) {
    rmsCtx.close().catch(() => {});
    rmsCtx = null;
  }
}

function startRmsVad(stream: MediaStream) {
  const sharedCtx = getRecordingContext();
  const ctx = sharedCtx || new AudioContext({ sampleRate: 16000 });
  if (!sharedCtx) rmsCtx = ctx;
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  let speechOccurred = false;
  let lastDebugLog = 0;

  capTimer = window.setTimeout(() => {
    if (!active) return;
    console.warn("VAD safety cap triggered — forcing end of utterance");
    teardownRms();
    void finishCapture();
  }, MAX_UTTERANCE_MS);

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

    if (now - lastDebugLog > 500) {
      console.log(`[NEXUS] VAD rms=${rms.toFixed(4)} threshold=${VAD_FALLBACK_RMS} speech=${speechOccurred}`);
      lastDebugLog = now;
    }

    if (rms > VAD_FALLBACK_RMS) {
      silenceSince = 0;
      if (!speechOccurred) {
        console.log(`[NEXUS] VAD: speech detected (rms=${rms.toFixed(4)})`);
      }
      speechOccurred = true;
    } else if (silenceSince === 0) {
      silenceSince = now;
    }

    const elapsed = now - startedAt;
    if (elapsed < MIN_LISTEN_MS) {
      requestAnimationFrame(tick);
      return;
    }
    if ((speechOccurred && silenceSince && now - silenceSince > SILENCE_MS) || elapsed > MAX_UTTERANCE_MS) {
      teardownRms();
      void finishCapture();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// re-export so App can react to state changes without circular import
export const state = useAssistant.getState;
