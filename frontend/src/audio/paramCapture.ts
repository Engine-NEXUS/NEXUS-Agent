/**
 * Parameter capture for Type 2 (parameterized) commands.
 *
 * When a Type 2 acoustic classifier fires (e.g. "play song in spotify"),
 * we need to capture the PARAMETER (e.g. the song name) via STT.
 * This module records a fixed duration of audio and returns the PCM.
 *
 * Flow:
 *   1. Get the microphone stream (via the same mechanism as the recorder)
 *   2. Record for `durationMs` (default 3000ms)
 *   3. Stop recording, downsample to 16kHz, convert to Int16 PCM
 *   4. Return the PCM samples for STT
 *
 * This is intentionally simple — no VAD, no silence detection.
 * The user has ~3 seconds to say the parameter (song name, search query).
 */

let audioCtx: AudioContext | null = null;
let mediaStreamSource: MediaStreamAudioSourceNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let floatBuffer: Float32Array[] = [];
let nativeSampleRate = 48000;

/**
 * Capture `durationMs` of microphone audio and return 16-bit PCM at 16kHz.
 *
 * @param durationMs - How long to record (default 3000ms = 3 seconds)
 * @returns Int16Array of mono PCM at 16kHz, or null on failure
 */
export async function captureParameter(durationMs = 3000): Promise<Int16Array | null> {
  try {
    // Get the mic stream — reuse the same mechanism as the main recorder
    let stream: MediaStream;
    const getMic = (window as any).__NEXUS_GET_MIC_STREAM__;
    if (typeof getMic === "function") {
      stream = await getMic();
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }

    // Set up recording (same pattern as recorder.ts startRecording)
    floatBuffer = [];
    audioCtx = new AudioContext();
    nativeSampleRate = audioCtx.sampleRate;

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    mediaStreamSource = audioCtx.createMediaStreamSource(stream);
    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);

    scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0);
      // Copy the Float32Array — the underlying buffer is reused by the browser
      floatBuffer.push(new Float32Array(input));
    };

    // CRITICAL: direct connection (same as recorder.ts)
    mediaStreamSource.connect(scriptNode);
    scriptNode.connect(audioCtx.destination);

    console.log(`[NEXUS] param capture: recording ${durationMs}ms @ ${nativeSampleRate}Hz`);

    // Wait for the specified duration
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    // Stop recording
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

    // Stop all tracks on the stream (unless it's a shared stream)
    const release = (window as any).__NEXUS_RELEASE_MIC__;
    if (typeof release === "function") {
      release();
    } else {
      stream.getTracks().forEach((t) => t.stop());
    }

    // Concatenate all Float32 chunks
    const totalSamples = floatBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalSamples === 0) {
      console.warn("[NEXUS] param capture: no audio captured");
      return null;
    }

    const allFloat = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of floatBuffer) {
      allFloat.set(chunk, offset);
      offset += chunk.length;
    }
    floatBuffer = [];

    console.log(`[NEXUS] param capture: ${totalSamples} samples @ ${nativeSampleRate}Hz`);

    // Downsample to 16kHz and convert to Int16
    const pcm = downsampleAndConvert(allFloat, nativeSampleRate, 16000);
    console.log(`[NEXUS] param capture: ${pcm.length} Int16 samples @ 16kHz`);
    return pcm;
  } catch (err) {
    console.error("[NEXUS] param capture failed:", err);
    // Clean up on error
    if (scriptNode) {
      scriptNode.disconnect();
      scriptNode = null;
    }
    if (mediaStreamSource) {
      mediaStreamSource.disconnect();
      mediaStreamSource = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    return null;
  }
}

/**
 * Downsample from nativeSampleRate to 16000Hz and convert Float32 → Int16.
 * Same logic as recorder.ts downsampleAndConvert.
 */
function downsampleAndConvert(
  float32: Float32Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  if (fromRate === toRate) {
    // No resampling needed — just convert float → int16
    const result = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return result;
  }

  // Linear interpolation resampling
  const ratio = fromRate / toRate;
  const newLength = Math.round(float32.length / ratio);
  const result = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, float32.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    const sample =
      float32[srcIndexFloor] * (1 - fraction) + float32[srcIndexCeil] * fraction;
    const clamped = Math.max(-1, Math.min(1, sample));
    result[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  return result;
}
