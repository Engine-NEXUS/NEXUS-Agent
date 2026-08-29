import { useAssistant } from "../store/assistant";
import { openSession, closeSession, sendTranscript } from "../net/wsBridge";
import { transcribeAudio } from "./stt";
import { speak } from "./ttsPlayer";
import { parseIntent } from "../intent/parser";

/**
 * Audio recorder using ScriptProcessorNode (proven reliable in WebView2/Electron).
 *
 * AUDIO STAYS LOCAL: Float32 samples are buffered in memory on the device.
 * They are NOT sent to the server. When VAD detects silence, the buffered
 * audio is downsampled to 16kHz, converted to Int16 PCM, and sent to the
 * LOCAL STT server (127.0.0.1:39217) for transcription.
 * Only the resulting TEXT is sent to the remote NEXUS server.
 *
 * VAD (`vad.ts`) controls start/stop of the recorder.
 * The MediaStream is acquired in `main.tsx` on wake and shared between
 * the recorder and VAD to avoid opening two mic streams.
 */

let audioCtx: AudioContext | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let mediaStreamSource: MediaStreamAudioSourceNode | null = null;

/** Expose the current recording AudioContext so VAD can reuse it
 *  instead of creating a second AudioContext for the same stream. */
export function getRecordingContext(): AudioContext | null {
  return audioCtx;
}

/** Buffer of Float32 samples at native sample rate (e.g. 48kHz). */
let floatBuffer: Float32Array[] = [];

/** The native sample rate of the AudioContext (e.g. 48000). */
let nativeSampleRate = 48000;

/** Guard: true while finishCapture is in progress. Prevents abortCapture
 *  from clearing floatBuffer mid-transcription (race condition fix). */
let captureInProgress = false;

/**
 * Start recording from an EXISTING MediaStream (acquired by the caller).
 * Uses ScriptProcessorNode — the proven approach for WebView2/Electron.
 *
 * Key design decisions (based on research of VS Code, Runanywhere SDK, Sokuji):
 *   - Native AudioContext sample rate (NOT forced to 16kHz) — avoids edge cases
 *   - Connect source → node → destination DIRECTLY (no gain node — Chrome
 *     optimizes away silent paths, which was the root cause of the AudioWorklet bug)
 *   - Accumulate Float32 samples, downsample to 16kHz after recording
 */
export async function startRecording(stream: MediaStream): Promise<void> {
  if (audioCtx) return; // already recording

  floatBuffer = []; // reset buffer for new turn

  // Use native sample rate — don't force 16kHz. This avoids resampling issues
  // in WebView2's audio pipeline. We downsample to 16kHz after recording.
  audioCtx = new AudioContext();
  nativeSampleRate = audioCtx.sampleRate;

  // Chrome/WebView2 autoplay policy: AudioContext starts "suspended".
  // Must resume() before the graph will process audio.
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  mediaStreamSource = audioCtx.createMediaStreamSource(stream);

  // ScriptProcessorNode: deprecated but proven reliable in WebView2/Electron.
  // Buffer size 4096 gives ~85ms at 48kHz — low latency, good throughput.
  scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);

  let frameCount = 0;
  scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
    const input = e.inputBuffer.getChannelData(0);
    // Copy the Float32Array — the underlying buffer is reused by the browser.
    floatBuffer.push(new Float32Array(input));
    frameCount++;
    if (frameCount === 1) {
      console.log(`[NEXUS] first audio frame received (${input.length} samples @ ${nativeSampleRate}Hz)`);
    }
  };

  // CRITICAL: Connect source → node → destination DIRECTLY.
  // No gain node in between — Chrome optimizes away silent paths (gain=0),
  // which was the root cause of the AudioWorklet bug. The ScriptProcessorNode
  // doesn't write to its output buffer, so the output is silence by default.
  // But Chrome still processes the graph because the connection is direct.
  mediaStreamSource.connect(scriptNode);
  scriptNode.connect(audioCtx.destination);

  useAssistant.getState().setState("listening");
}

export async function stopRecording(): Promise<void> {
  if (scriptNode) {
    scriptNode.disconnect();
    scriptNode.onaudioprocess = null;
    scriptNode = null;
  }
  if (mediaStreamSource) {
    mediaStreamSource.disconnect();
    mediaStreamSource = null;
  }
  if (audioCtx) {
    await audioCtx.close();
    audioCtx = null;
  }
}

/**
 * Downsample Float32 audio from native rate to 16kHz using block averaging.
 * Then convert to Int16 PCM — the format the local STT server expects.
 */
function downsampleAndConvert(float32: Float32Array, inRate: number, outRate: number): Int16Array {
  if (outRate >= inRate) {
    // No downsampling needed — just convert float32 → int16
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
  }

  const ratio = inRate / outRate;
  const outLen = Math.floor(float32.length / ratio);
  const pcm = new Int16Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(float32.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += float32[j];
      n++;
    }
    const avg = n ? sum / n : 0;
    const s = Math.max(-1, Math.min(1, avg));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return pcm;
}

/**
 * Open the backend session (non-fatal) and start recording.
 *
 * CRITICAL: Recording starts FIRST, then the backend session is opened in
 * the background. This eliminates the ~1 second delay where the orb was
 * visible but the mic wasn't recording yet (TCP connection timeout to the
 * unavailable backend was blocking startRecording).
 *
 * The user can speak the instant the orb appears — no words are lost.
 */
export async function captureUntilSilence(
  stream: MediaStream,
  serverUrl?: string,
  token?: string,
): Promise<void> {
  // Start recording IMMEDIATELY — don't wait for the backend session.
  // The mic must be capturing audio the moment the orb appears so the
  // user's first words aren't lost.
  await startRecording(stream);

  // Try to open the backend session in the background (fire and forget).
  // If the backend is unavailable, local-only mode still works.
  // This runs AFTER startRecording so it never blocks audio capture.
  openSession(serverUrl, token).catch((err) => {
    console.warn("[NEXUS] backend session unavailable (local-only mode):", err);
  });
}

/** Release the mic stream (stops all tracks, frees the hardware). */
function releaseMicStream(): void {
  const release = (window as any).__NEXUS_RELEASE_MIC__;
  if (typeof release === "function") release();
}

/**
 * Wait until the Web Speech API is no longer speaking.
 * Polls every 100ms (speechSynthesis.speaking is the only reliable API).
 * Times out after 5s as a safety net.
 */
function waitForTtsIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === "undefined" || !speechSynthesis.speaking) {
      resolve();
      return;
    }
    const start = Date.now();
    const check = () => {
      if (!speechSynthesis.speaking || Date.now() - start > 5000) {
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    setTimeout(check, 100);
  });
}

/**
 * Called by VAD on silence: stop the recorder, run local STT on the
 * buffered audio, send the transcript text to the server, and speak
 * the acknowledgement locally.
 *
 * This is the key function — audio is processed locally, only text
 * crosses the network.
 */
export async function finishCapture(): Promise<void> {
  // Guard: prevent re-entrant finishCapture (e.g. VAD safety cap + speech end).
  if (captureInProgress) return;
  captureInProgress = true;

  await stopRecording();

  // SYNCHRONOUSLY copy the buffer before any await — abortCapture might
  // clear floatBuffer while we're waiting for STT (race condition fix).
  const totalFloat = floatBuffer.reduce((sum, arr) => sum + arr.length, 0);
  const allFloat = new Float32Array(totalFloat);
  let offset = 0;
  for (const chunk of floatBuffer) {
    allFloat.set(chunk, offset);
    offset += chunk.length;
  }
  floatBuffer = []; // free the buffer

  if (totalFloat === 0) {
    console.warn("no audio captured");
    releaseMicStream();
    // Hide FIRST, then reset after slide-down completes (prevents animation glitch).
    useAssistant.getState().setVisible(false);
    setTimeout(() => useAssistant.getState().reset(), 550);
    captureInProgress = false;
    return;
  }

  // Downsample from native rate (e.g. 48kHz) to 16kHz and convert to Int16 PCM.
  console.log(`[NEXUS] captured ${totalFloat} samples @ ${nativeSampleRate}Hz, downsampling to 16kHz`);
  const allPcm = downsampleAndConvert(allFloat, nativeSampleRate, 16000);
  console.log(`[NEXUS] downsampled to ${allPcm.length} Int16 samples @ 16kHz`);

  // 1. Local STT — audio goes to 127.0.0.1:39217, never to the remote server.
  useAssistant.getState().setState("thinking");
  const transcript = await transcribeAudio(allPcm);

  // Mic stream is no longer needed — release it now to free the hardware.
  releaseMicStream();

  if (!transcript) {
    console.warn("STT returned empty transcript");
    useAssistant.getState().setState("speaking");
    useAssistant.getState().addAssistantMessage("Didn't catch that, sir.");
    await speak("Didn't catch that sir");
    useAssistant.getState().setVisible(false);
    setTimeout(() => useAssistant.getState().reset(), 550);
    captureInProgress = false;
    return;
  }

  // 2. Add the transcript to the UI.
  useAssistant.getState().addUserMessage(transcript);

  // 3. LOCAL-FIRST: Parse the intent locally. If it's a known local command
  //    (open app, open URL, search), execute it locally — no need to send
  //    to the remote backend. Only send to the backend if the intent is
  //    "unknown" (i.e. it's a conversational query needing n8n/Ollama).
  const intent = parseIntent(transcript);

  if (intent.action !== "unknown") {
    // Known local command — execute it directly.
    useAssistant.getState().setState("speaking");
    useAssistant.getState().addAssistantMessage("Ok sir.");
    void speak("Ok sir.");

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ success: boolean; message: string }>("execute_command", { intent });
      console.log("[NEXUS] local command result:", result);
      if (result.message && result.message !== "Ok sir.") {
        useAssistant.getState().addAssistantMessage(result.message);
        void speak(result.message.replace(/,/g, ""));
      }
    } catch (err) {
      console.error("[NEXUS] command execution failed:", err);
    }

    await waitForTtsIdle();
    await new Promise((resolve) => setTimeout(resolve, 800));
    useAssistant.getState().setVisible(false);
    setTimeout(() => useAssistant.getState().reset(), 550);
    captureInProgress = false;
    return;
  }

  // 4. Unknown intent — try the remote backend (n8n/Ollama/Hermes).
  //    If the backend is available, send the transcript and let the server
  //    handle it. The server sends back ack/result/done events.
  try {
    await sendTranscript(transcript);
    captureInProgress = false;
    // Backend is handling it — wsBridge will speak ack + result + reset.
    return;
  } catch (err) {
    // Backend unavailable — can't handle this query.
    console.warn("[NEXUS] backend unavailable for unknown query:", err);
  }

  // 5. Neither local intent nor backend available.
  useAssistant.getState().setState("speaking");
  useAssistant.getState().addAssistantMessage("Didn't catch that, sir.");
  await speak("Didn't catch that sir");
  useAssistant.getState().setVisible(false);
  setTimeout(() => useAssistant.getState().reset(), 550);
  captureInProgress = false;
}

/** Called on error / cancel: stop everything and close the session.
 *  If finishCapture is in progress, don't clear the buffer — let it finish. */
export async function abortCapture(): Promise<void> {
  // If finishCapture is mid-flight, don't interfere — it has already copied
  // the buffer synchronously and is processing it. Just stop the recording.
  if (captureInProgress) {
    await stopRecording();
    return;
  }
  await stopRecording();
  floatBuffer = [];
  try { await closeSession(); } catch { /* backend may already be closed */ }
  releaseMicStream();
  useAssistant.getState().reset();
}

/**
 * Called by Silero VAD's onSpeechEnd callback.
 *
 * Silero gives us the audio directly as Float32Array at 16kHz — no
 * downsampling needed. We convert to Int16 PCM and run the same
 * STT → intent → execute flow as finishCapture().
 *
 * This bypasses the ScriptProcessorNode recorder entirely since Silero
 * (via MicVAD) manages its own audio capture with an AudioWorklet.
 */
export async function finishCaptureFromVad(
  audio: Float32Array,
  speculative?: Promise<string> | null,
): Promise<void> {
  if (captureInProgress) return;
  captureInProgress = true;

  // Stop the recorder if it's running (it may be if we fell back to RMS).
  await stopRecording();

  if (!audio || audio.length === 0) {
    console.warn("no audio from VAD");
    releaseMicStream();
    useAssistant.getState().setVisible(false);
    setTimeout(() => useAssistant.getState().reset(), 550);
    captureInProgress = false;
    return;
  }

  // Convert Float32 (-1 to 1) to Int16 PCM — Silero already gives us 16kHz.
  console.log(`[NEXUS] VAD audio: ${audio.length} samples @ 16kHz, converting to Int16 PCM`);
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  console.log(`[NEXUS] converted to ${pcm.length} Int16 samples @ 16kHz`);

  // Release the mic stream — Silero's MicVAD has already captured the audio.
  releaseMicStream();

  // 1. Local STT — audio goes to 127.0.0.1:39217, never to the remote server.
  //
  // If the VAD fired a speculative transcription when speech first dropped to
  // silence, that request has been running during the redemption window and is
  // usually already finished — so this resolves immediately instead of costing
  // another ~500ms. Any empty/failed result falls through to a normal
  // transcription of the final segment, so this can only be faster, never worse.
  useAssistant.getState().setState("thinking");
  let transcript = "";
  if (speculative) {
    const t0 = performance.now();
    try {
      transcript = await speculative;
    } catch {
      transcript = "";
    }
    if (transcript) {
      console.log(
        `[NEXUS] used speculative transcript after ${Math.round(performance.now() - t0)}ms wait`,
      );
    }
  }
  if (!transcript) {
    transcript = await transcribeAudio(pcm);
  }

  if (!transcript) {
    console.warn("STT returned empty transcript");
    useAssistant.getState().setState("speaking");
    useAssistant.getState().addAssistantMessage("Didn't catch that, sir.");
    await speak("Didn't catch that sir");
    useAssistant.getState().setVisible(false);
    setTimeout(() => useAssistant.getState().reset(), 550);
    captureInProgress = false;
    return;
  }

  // 2. Add the transcript to the UI.
  useAssistant.getState().addUserMessage(transcript);

  // 3. LOCAL-FIRST: Parse the intent locally. If it's a known local command
  //    (open app, open URL, search), execute it locally — no need to send
  //    to the remote backend. Only send to the backend if the intent is
  //    "unknown" (i.e. it's a conversational query needing n8n/Ollama).
  const intent = parseIntent(transcript);

  if (intent.action !== "unknown") {
    // Known local command — execute it directly.
    useAssistant.getState().setState("speaking");
    useAssistant.getState().addAssistantMessage("Ok sir.");
    void speak("Ok sir.");

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ success: boolean; message: string }>("execute_command", { intent });
      console.log("[NEXUS] local command result:", result);
      if (result.message && result.message !== "Ok sir.") {
        useAssistant.getState().addAssistantMessage(result.message);
        void speak(result.message.replace(/,/g, ""));
      }
    } catch (err) {
      console.error("[NEXUS] command execution failed:", err);
    }

    await waitForTtsIdle();
    await new Promise((resolve) => setTimeout(resolve, 800));
    useAssistant.getState().setVisible(false);
    setTimeout(() => useAssistant.getState().reset(), 550);
    captureInProgress = false;
    return;
  }

  // 4. Unknown intent — try the remote backend (n8n/Ollama/Hermes).
  try {
    await sendTranscript(transcript);
    captureInProgress = false;
    return;
  } catch (err) {
    console.warn("[NEXUS] backend unavailable for unknown query:", err);
  }

  // 5. Neither local intent nor backend available.
  useAssistant.getState().setState("speaking");
  useAssistant.getState().addAssistantMessage("Didn't catch that, sir.");
  await speak("Didn't catch that sir");
  useAssistant.getState().setVisible(false);
  setTimeout(() => useAssistant.getState().reset(), 550);
  captureInProgress = false;
}
