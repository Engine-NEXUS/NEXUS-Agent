// AudioWorklet that downmixes to mono, downsamples to 16k, converts to Int16 PCM,
// and posts 60 ms blocks to the main thread. Runs off the main thread to keep UI smooth.
//
// IMPORTANT: this file is loaded RAW by the browser via
//   `audioContext.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url))`.
// It is NOT transpiled by Vite/esbuild when referenced this way, so it MUST be plain
// JavaScript — no TypeScript types, no `private`, no `export {}`.

class PcmPassthrough extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` (the device/native rate, e.g. 48k) is a global provided by
    // AudioWorkletGlobalScope. We resample linearly to 16000 Hz.
    this.resampleRatio = sampleRate / 16000;
    this.frac = 0;
    this.buffer = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    // accumulate input
    const combined = new Float32Array(this.buffer.length + input.length);
    combined.set(this.buffer, 0);
    combined.set(input, this.buffer.length);
    this.buffer = combined;

    const framesPerBlock = Math.floor((16000 * 60) / 1000); // 960 samples
    const out = [];

    let pos = this.frac;
    while (pos + this.resampleRatio < this.buffer.length) {
      const idx0 = Math.floor(pos);
      const idx1 = idx0 + 1 < this.buffer.length ? idx0 + 1 : idx0;
      const t = pos - idx0;
      const sample = this.buffer[idx0] * (1 - t) + this.buffer[idx1] * t;
      // float32 [-1,1] -> int16
      const s = Math.max(-1, Math.min(1, sample));
      out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      pos += this.resampleRatio;
      if (out.length >= framesPerBlock) {
        const pcm = new Int16Array(out.splice(0, framesPerBlock));
        // Transfer the underlying buffer (zero-copy) to the main thread.
        this.port.postMessage({ pcm }, [pcm.buffer]);
      }
    }
    // keep remainder
    const consumed = Math.floor(pos);
    this.buffer = this.buffer.slice(consumed);
    this.frac = pos - consumed;
    return true;
  }
}

registerProcessor("pcm-passthrough", PcmPassthrough);
