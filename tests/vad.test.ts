import { describe, expect, it, vi } from "vitest";
import { VAD, createSilenceDetector, type VadDoneReason } from "@/lib/browser/vad";

const FRAME_MS = 32;

/** Feed `count` frames at `rms` starting at `from` (exclusive of start), stepping 32ms. */
function feedFrames(d: ReturnType<typeof createSilenceDetector>, from: number, count: number, rms: number): number {
  let t = from;
  for (let i = 0; i < count; i++) {
    t += FRAME_MS;
    d.feed(rms, t);
  }
  return t;
}

describe("createSilenceDetector", () => {
  it("computes a noise floor after the window and waits for speech", () => {
    const onDone = vi.fn<(reason: VadDoneReason) => void>();
    const d = createSilenceDetector(onDone);
    // Noise window: frames at 0.001 stay below the 0.012 min threshold.
    let t = feedFrames(d, 0, 20, 0.001);
    expect(onDone).not.toHaveBeenCalled();
    // Loud run: speechOnFrames needed before speaking flips; keep speaking
    // past minSpeechMs so a later silence auto-stop counts as real speech.
    t += FRAME_MS;
    d.feed(0.5, t);
    expect(d.speaking).toBe(false);
    t = feedFrames(d, t, VAD.speechOnFrames - 1 + Math.ceil(VAD.minSpeechMs / FRAME_MS), 0.5);
    expect(d.speaking).toBe(true);
    // A single soft frame does not end speech before the hangover.
    t = feedFrames(d, t, 3, 0);
    expect(d.speaking).toBe(true);
    // Silence beyond the hangover with enough speech -> auto-stop "silence".
    t = feedFrames(d, t, Math.ceil(VAD.hangoverMs / FRAME_MS) + 2, 0);
    expect(onDone).toHaveBeenCalledWith("silence");
    expect(d.done).toBe(true);
    // Feeding after done is a no-op.
    const calls = onDone.mock.calls.length;
    d.feed(0.5, t + FRAME_MS);
    expect(onDone.mock.calls.length).toBe(calls);
  });

  it("noise blips (< minSpeechMs) re-arm instead of auto-stopping", () => {
    const onDone = vi.fn<(reason: VadDoneReason) => void>();
    const d = createSilenceDetector(onDone);
    let t = feedFrames(d, 0, 20, 0.001); // noise floor window
    t = feedFrames(d, t, VAD.speechOnFrames + 1, 0.5); // brief blip (~128ms)
    expect(d.speaking).toBe(true);
    // Long silence after the blip: below minSpeechMs -> back to waiting.
    t = feedFrames(d, t, Math.ceil(VAD.hangoverMs / FRAME_MS) + 2, 0);
    expect(onDone).not.toHaveBeenCalled();
    expect(d.speaking).toBe(false);
    expect(d.done).toBe(false);
    // Manual stop in the waiting phase reports no-speech.
    expect(d.stop(t)).toBe("no-speech");
  });

  it("caps total speech at maxRecordingMs with reason max", () => {
    const onDone = vi.fn<(reason: VadDoneReason) => void>();
    const d = createSilenceDetector(onDone);
    let t = feedFrames(d, 0, 20, 0.001);
    // Continuous loud frames until past the cap (threshold stays at the 0.012 min).
    const count = Math.ceil(VAD.maxRecordingMs / FRAME_MS) + VAD.speechOnFrames + 4;
    for (let i = 0; i < count && !d.done; i++) {
      t += FRAME_MS;
      d.feed(0.5, t);
    }
    expect(onDone).toHaveBeenCalledWith("max");
  });

  it("stop() before speech never auto-fired: manual stop reports no-speech / too_short", () => {
    const onDone = vi.fn<(reason: VadDoneReason) => void>();
    const d = createSilenceDetector(onDone);
    const t = feedFrames(d, 0, 20, 0.001);
    // Manual stop while waiting -> no-speech (caller discards).
    expect(d.stop(t)).toBe("no-speech");
    // done is final; further stops report no-speech.
    expect(d.stop(t + 100)).toBe("no-speech");
    expect(onDone).not.toHaveBeenCalled();
    expect(d.done).toBe(true);
  });

  it("manual stop during short speech -> too_short", () => {
    const onDone = vi.fn<(reason: VadDoneReason) => void>();
    const d = createSilenceDetector(onDone);
    let t = feedFrames(d, 0, 20, 0.001);
    t = feedFrames(d, t, VAD.speechOnFrames, 0.5); // speaking, but < minSpeechMs
    expect(d.speaking).toBe(true);
    expect(d.stop(t + FRAME_MS)).toBe("too_short");
  });

  it("manual stop during usable speech -> silence", () => {
    const onDone = vi.fn<(reason: VadDoneReason) => void>();
    const d = createSilenceDetector(onDone);
    let t = feedFrames(d, 0, 20, 0.001);
    t = feedFrames(d, t, VAD.speechOnFrames + Math.ceil(VAD.minSpeechMs / FRAME_MS), 0.5);
    expect(d.speaking).toBe(true);
    expect(d.stop(t + FRAME_MS)).toBe("silence");
    expect(onDone).not.toHaveBeenCalled(); // manual stop does not fire onDone
  });

  it("noise floor adapts: loud ambient noise raises the threshold", () => {
    const onDone = vi.fn<(reason: VadDoneReason) => void>();
    const d = createSilenceDetector(onDone);
    // Ambient at 0.05 -> floor*3 = 0.15 threshold; 0.05 after the window is NOT speech.
    let t = feedFrames(d, 0, 20, 0.05);
    t = feedFrames(d, t, 20, 0.05);
    expect(d.speaking).toBe(false);
    feedFrames(d, t, VAD.speechOnFrames + 1, 0.4);
    expect(d.speaking).toBe(true);
  });
});
