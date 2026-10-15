// AudioWorklet processor: downmix to mono, decimate to a target rate,
// convert to Int16, and post ~100 ms chunks to the main thread. Also posts a
// level (RMS of the source block) at ≤30 Hz for the UI meter.
class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.targetRate = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate;
    if (!(this.ratio >= 1)) this.ratio = 1;
    this.phase = 0;
    this.chunk = new Int16Array(4096);
    this.chunkLen = 0;
    this.levelAt = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") this.flush();
    };
  }

  flush() {
    if (this.chunkLen > 0) {
      const out = this.chunk.slice(0, this.chunkLen);
      this.port.postMessage({ type: "pcm", buffer: out.buffer }, [out.buffer]);
      this.chunkLen = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    let sumSq = 0;
    for (let i = 0; i < ch0.length; i += 1) {
      let mono = 0;
      for (let c = 0; c < input.length; c += 1) mono += input[c][i];
      mono /= input.length;
      sumSq += mono * mono;
      if (this.phase >= 1) {
        const clamped = Math.max(-1, Math.min(1, mono));
        this.chunk[this.chunkLen] = Math.round(clamped * 32767);
        this.chunkLen += 1;
        this.phase -= 1;
        if (this.chunkLen === this.chunk.length) this.flush();
      }
      this.phase += 1 / this.ratio;
    }
    const now = currentTime;
    if (now - this.levelAt > 0.033) {
      this.levelAt = now;
      this.port.postMessage({ type: "level", rms: Math.sqrt(sumSq / ch0.length) });
    }
    return true;
  }
}

registerProcessor("pcm16-capture", Pcm16CaptureProcessor);
