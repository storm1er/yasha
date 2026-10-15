// Pure silence detector for mic recording (AUDIO-REFACTO-PLAN §9). Fed by the
// RMS level callbacks (web: audio-capture worklet; Android mirror:
// core/audio/SilenceDetector.kt — constants must stay in sync).
//
// Contract (per plan):
//  - noise floor = p10 of the first `noiseFloorWindowMs` frames; speech starts
//    after `speechOnFrames` consecutive frames above `max(0.012, floor*3)`.
//  - silence after speech (>= hangoverMs) → auto-stop:
//      usable speech → onDone("silence");  < minSpeechMs → treated as noise
//      (detector returns to waiting, no auto-stop — the blip was not speech).
//  - total speech above maxRecordingMs → onDone("max")
//  - while NO speech has started: auto-stop never fires (region-drawing grace
//    in the assist hook; only manual stop ends it).
//  - stop() before usable speech → "too_short" (caller discards + warns).

export const VAD = {
  startThresholdRmsMin: 0.012,
  noiseFloorFactor: 3,
  noiseFloorWindowMs: 500,
  speechOnFrames: 4,
  hangoverMs: 1200,
  minSpeechMs: 300,
  maxRecordingMs: 60000,
} as const;

export type VadDoneReason = "silence" | "max";
export type VadStopOutcome = "silence" | "too_short" | "no-speech";

export type SilenceDetector = {
  /** Feed one RMS level (0..1) with its sample timestamp (ms). */
  feed: (rms: number, nowMs: number) => void;
  /** Manual stop (button / max guard). */
  stop: (nowMs: number) => VadStopOutcome;
  readonly speaking: boolean;
  readonly done: boolean;
};

export function createSilenceDetector(onDone: (reason: VadDoneReason) => void): SilenceDetector {
  let phase: "noise" | "waiting" | "speaking" | "done" = "noise";
  let startedAt = 0;
  let speechStartedAt = 0;
  let lastSpokeAt = 0;
  let aboveRun = 0;
  let threshold: number = VAD.startThresholdRmsMin;
  const noiseFrames: number[] = [];

  // Only called while phase === "speaking"; speechStartedAt ≤ lastSpokeAt
  // (both are set from fed timestamps), so the difference is always ≥ 0.
  const spokeMs = (): number => lastSpokeAt - speechStartedAt;

  const finish = (reason: VadDoneReason): void => {
    phase = "done";
    onDone(reason);
  };

  return {
    feed(rms, nowMs) {
      if (phase === "done") return;
      if (startedAt === 0) startedAt = nowMs;
      if (phase === "noise") {
        noiseFrames.push(rms);
        if (nowMs - startedAt >= VAD.noiseFloorWindowMs && noiseFrames.length >= 3) {
          const sorted = [...noiseFrames].sort((a, b) => a - b);
          const p10 = sorted[Math.floor((sorted.length - 1) * 0.1)];
          threshold = Math.max(VAD.startThresholdRmsMin, p10 * VAD.noiseFloorFactor);
          phase = "waiting";
        }
        return;
      }
      const above = rms >= threshold;
      if (phase === "waiting") {
        aboveRun = above ? aboveRun + 1 : 0;
        if (aboveRun >= VAD.speechOnFrames) {
          phase = "speaking";
          // Approximate the onset: the run started (aboveRun-1) frames ago.
          speechStartedAt = nowMs - (aboveRun - 1) * 32;
          lastSpokeAt = nowMs;
        }
        return;
      }
      // speaking
      if (above) lastSpokeAt = nowMs;
      if (nowMs - speechStartedAt >= VAD.maxRecordingMs) {
        finish("max");
        return;
      }
      if (nowMs - lastSpokeAt >= VAD.hangoverMs) {
        if (spokeMs() < VAD.minSpeechMs) {
          // Noise blip, not speech: re-arm (never auto-stops on silence alone).
          phase = "waiting";
          aboveRun = 0;
          return;
        }
        finish("silence");
      }
    },
    stop(nowMs) {
      if (phase === "done") return "no-speech";
      const wasSpeaking = phase === "speaking";
      const usable = wasSpeaking && spokeMs() >= VAD.minSpeechMs;
      phase = "done";
      return usable ? "silence" : wasSpeaking ? "too_short" : "no-speech";
    },
    get speaking() {
      return phase === "speaking";
    },
    get done() {
      return phase === "done";
    },
  };
}
