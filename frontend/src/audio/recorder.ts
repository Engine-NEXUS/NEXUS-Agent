import { invoke } from "@tauri-apps/api/core";
import { useAssistant } from "../store/assistant";
import { openSession, endAudio, closeSession } from "../net/wsBridge";

/**
 * Audio recorder using an AudioWorklet that emits raw PCM frames.
 * Frames are forwarded to the Rust network bridge via `send_audio_chunk` (base64).
 * VAD (`vad.ts`) controls start/stop of the recorder.
 *
 * The MediaStream is acquired ONCE in App.tsx and shared between the recorder and VAD
 * to avoid opening two mic streams (which causes echo-cancellation conflicts).
 */

let audioCtx: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let workletReady = false;

/**
 * Start recording from an EXISTING MediaStream (acquired by the caller).
 * Opens the session, loads the worklet, and pumps PCM frames to Rust.
 */
export async function startRecording(stream: MediaStream): Promise<void> {
  if (audioCtx) return; // already recording

  audioCtx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });

  // Load the worklet module. We use a plain-JS worklet (no TS) so the browser can
  // load it directly without a transpile step. The `?url` suffix tells Vite to emit
  // the file as a static asset and give us its resolved URL at build time.
  if (!workletReady) {
    const workletUrl = (await import("./pcm-worklet.js?url")).default;
    await audioCtx.audioWorklet.addModule(workletUrl);
    workletReady = true;
  }

  const src = audioCtx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-passthrough", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
  });

  // The worklet posts 16-bit PCM buffers; we base64-encode and ship to Rust.
  workletNode.port.onmessage = async (ev: MessageEvent) => {
    const pcm: Int16Array = ev.data.pcm;
    const b64 = int16ToBase64(pcm);
    try {
      await invoke("send_audio_chunk", { payload: b64 });
    } catch {
      // session may not be open yet; ignore
    }
  };

  src.connect(workletNode);
  // We don't connect to destination — we don't want to monitor the mic.
  workletNode.connect(audioCtx.createGain()); // dummy sink to keep graph alive

  useAssistant.getState().setState("listening");
}

export async function stopRecording(): Promise<void> {
  workletNode?.disconnect();
  workletNode = null;
  if (audioCtx) {
    await audioCtx.close();
    audioCtx = null;
  }
}

/**
 * Open the session, record from the given stream until VAD silence, then signal
 * end-of-audio so the sidecar flushes to STT + n8n.
 */
export async function captureUntilSilence(
  stream: MediaStream,
  serverUrl?: string,
  token?: string,
): Promise<void> {
  await openSession(serverUrl, token);
  await startRecording(stream);
}

/** Called by VAD on silence: stop the recorder, signal end_audio, move to thinking. */
export async function finishCapture(): Promise<void> {
  await stopRecording();
  await endAudio();
  useAssistant.getState().setState("thinking");
}

/** Called on error / cancel: stop everything and close the session. */
export async function abortCapture(): Promise<void> {
  await stopRecording();
  await closeSession();
  useAssistant.getState().reset();
}

// --- helpers ---
function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
