import { useAssistant } from "../store/assistant";
import { openSession, closeSession, sendTranscript } from "../net/wsBridge";
import { transcribeAudio } from "./stt";

/**
 * Audio recorder using an AudioWorklet that emits raw PCM frames.
 *
 * AUDIO STAYS LOCAL: PCM frames are buffered in memory on the device.
 * They are NOT sent to the server. When VAD detects silence, the buffered
 * audio is sent to the LOCAL STT server (localhost:8000) for transcription.
 * Only the resulting TEXT is sent to the remote NEXUS server.
 *
 * VAD (`vad.ts`) controls start/stop of the recorder.
 * The MediaStream is acquired ONCE in App.tsx and shared between the
 * recorder and VAD to avoid opening two mic streams.
 */

let audioCtx: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let workletReady = false;

/** Local buffer of all PCM frames captured during this turn. */
let pcmBuffer: Int16Array[] = [];

/**
 * Start recording from an EXISTING MediaStream (acquired by the caller).
 * Opens the session, loads the worklet, and buffers PCM frames locally.
 */
export async function startRecording(stream: MediaStream): Promise<void> {
  if (audioCtx) return; // already recording

  pcmBuffer = []; // reset buffer for new turn

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

  // The worklet posts 16-bit PCM buffers — we buffer them LOCALLY.
  // They are NOT sent to the server. They will be sent to the local
  // STT server when VAD detects silence.
  workletNode.port.onmessage = (ev: MessageEvent) => {
    const pcm: Int16Array = ev.data.pcm;
    // Copy the frame because the worklet transfers ownership of the buffer.
    pcmBuffer.push(new Int16Array(pcm));
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
 * Open the session and record from the given stream until VAD silence.
 * The session is opened immediately so the server is ready to receive
 * the transcript text.
 */
export async function captureUntilSilence(
  stream: MediaStream,
  serverUrl?: string,
  token?: string,
): Promise<void> {
  await openSession(serverUrl, token);
  await startRecording(stream);
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
  await stopRecording();

  // Concatenate all buffered PCM frames into a single Int16Array.
  const totalSamples = pcmBuffer.reduce((sum, arr) => sum + arr.length, 0);
  const allPcm = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of pcmBuffer) {
    allPcm.set(chunk, offset);
    offset += chunk.length;
  }
  pcmBuffer = []; // free the buffer

  if (totalSamples === 0) {
    console.warn("no audio captured");
    useAssistant.getState().reset();
    return;
  }

  // 1. Local STT — audio goes to localhost:8000, never to the remote server.
  useAssistant.getState().setState("thinking");
  const transcript = await transcribeAudio(allPcm);

  if (!transcript) {
    console.warn("STT returned empty transcript");
    useAssistant.getState().reset();
    return;
  }

  // 2. Add the transcript to the UI.
  useAssistant.getState().addUserMessage(transcript);

  // 3. Send ONLY the transcript text to the remote server.
  await sendTranscript(transcript);

  // The server will respond with:
  //   {type:"ack", data:"On it, sir."}  → spoken locally by wsBridge
  //   {type:"result", data:"..."}       → spoken locally by wsBridge
  //   {type:"done"}                     → reset to idle
}

/** Called on error / cancel: stop everything and close the session. */
export async function abortCapture(): Promise<void> {
  await stopRecording();
  pcmBuffer = [];
  await closeSession();
  useAssistant.getState().reset();
}
