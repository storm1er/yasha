"use client";

// getUserMedia → AudioWorklet (public/audio/pcm16-capture.js) → mono Float32
// samples at 16 kHz (SPEECH-PLAN P2). Browser-only; excluded from the node
// coverage scope like other DOM-bound client libs.

export const TARGET_SAMPLE_RATE = 16000;

export type MicCapture = {
  /** Subscribe to mic level (0..1 RMS). Returns an unsubscribe fn. */
  onLevel(cb: (rms: number) => void): () => void;
  /** Stop the mic and return everything captured (mono, 16 kHz). */
  stop(): Float32Array;
  /** Stop and discard. */
  cancel(): void;
};

export async function startMicCapture(onPcm?: (chunk: Int16Array) => void): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/audio/pcm16-capture.js");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm16-capture", {
    processorOptions: { targetRate: TARGET_SAMPLE_RATE },
  });
  // Silent sink keeps the graph pulling in browsers that optimize idle nodes.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);

  const chunks: Int16Array[] = [];
  const levelSubs = new Set<(rms: number) => void>();
  node.port.onmessage = (e: MessageEvent<{ type: string; buffer?: ArrayBuffer; rms?: number }>) => {
    if (e.data.type === "pcm" && e.data.buffer) {
      const chunk = new Int16Array(e.data.buffer);
      chunks.push(chunk);
      onPcm?.(chunk);
    }
    else if (e.data.type === "level" && typeof e.data.rms === "number") {
      for (const cb of levelSubs) cb(e.data.rms);
    }
  };

  let stopped = false;
  const teardown = () => {
    if (stopped) return;
    stopped = true;
    // Best-effort: a failing browser API here must not lose captured audio.
    try {
      node.port.postMessage("flush");
      node.disconnect();
      sink.disconnect();
      void ctx.close();
      for (const track of stream.getTracks()) track.stop();
    } catch {
      /* surface the error via the transcription result instead */
    }
  };

  return {
    onLevel(cb) {
      levelSubs.add(cb);
      return () => levelSubs.delete(cb);
    },
    stop() {
      teardown();
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Float32Array(total);
      let at = 0;
      for (const c of chunks) {
        for (let i = 0; i < c.length; i += 1) out[at++] = c[i]! / 32768;
      }
      return out;
    },
    cancel() {
      teardown();
      chunks.length = 0;
    },
  };
}
