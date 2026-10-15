"use client";

// Browser-side audio input for chat (AUDIO-REFACTO-PLAN §7): feature config
// from /api/audio/config + tap-to-record with on-device VAD auto-stop. The
// finished WAV becomes a data URL handed to the caller (which sends it with
// the chat message — there is no server-side transcription hop).

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWavPcm16 } from "@/lib/browser/wav";
import { startMicCapture, TARGET_SAMPLE_RATE, type MicCapture } from "@/lib/browser/audio-capture";
import { createSilenceDetector, type SilenceDetector } from "@/lib/browser/vad";
import { dataUrlBytes } from "@/lib/chat-attachments";
import type { AudioInputConfig } from "@/lib/audio-input";

export type AudioConfig = AudioInputConfig;

const DEFAULT_CONFIG: AudioConfig = {
  enabled: false,
  model: null,
  smartModel: null,
  compatibleModels: [],
  smartAudioCapable: false,
  maxAudioBytes: 8388608,
};

export function useAudioConfig(): AudioConfig {
  const [config, setConfig] = useState<AudioConfig>(DEFAULT_CONFIG);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/audio/config", { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = (await res.json()) as Partial<AudioConfig>;
        setConfig({
          enabled: data.enabled === true,
          model: typeof data.model === "string" ? data.model : null,
          smartModel: typeof data.smartModel === "string" ? data.smartModel : null,
          compatibleModels: Array.isArray(data.compatibleModels)
            ? data.compatibleModels.filter((s): s is string => typeof s === "string")
            : [],
          smartAudioCapable: data.smartAudioCapable === true,
          maxAudioBytes:
            typeof data.maxAudioBytes === "number" && data.maxAudioBytes > 0
              ? data.maxAudioBytes
              : DEFAULT_CONFIG.maxAudioBytes,
        });
      } catch {
        /* feature stays hidden */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return config;
}

export type AudioInputStatus = "idle" | "recording";
export type AudioInputError = "mic" | "too_short" | "too_large" | null;

/** Chat-composer auto-stop grace before any speech started (ms). The floaty
 *  on Android uses a longer grace (region selection); the web composer only
 *  needs a start-timeout guard, after which listening continues (no
 *  auto-stop before first utterance, per plan §9). */
function toDataUrl(samples: Float32Array): string {
  const wav = encodeWavPcm16(samples, TARGET_SAMPLE_RATE);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < wav.length; i += chunk) {
    bin += String.fromCharCode(...wav.subarray(i, i + chunk));
  }
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export function useAudioInput(opts: {
  enabled: boolean;
  maxAudioBytes: number;
  /** Called with the finished WAV data URL when recording ends usable. */
  onAudio: (dataUrl: string) => void;
}) {
  const [status, setStatus] = useState<AudioInputStatus>("idle");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<AudioInputError>(null);
  const captureRef = useRef<MicCapture | null>(null);
  const detectorRef = useRef<SilenceDetector | null>(null);
  const timerRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const clearTimer = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => clearTimer, []);
  useEffect(
    () => () => {
      if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current);
      captureRef.current?.cancel();
      captureRef.current = null;
      unsubRef.current?.();
    },
    []
  );

  const flashError = (kind: Exclude<AudioInputError, null>) => {
    setError(kind);
    if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => setError(null), 3000);
  };

  const finish = useCallback(() => {
    clearTimer();
    unsubRef.current?.();
    unsubRef.current = null;
    const capture = captureRef.current;
    captureRef.current = null;
    detectorRef.current = null;
    setStatus("idle");
    setLevel(0);
    if (!capture) return;
    const samples = capture.stop();
    if (samples.length < TARGET_SAMPLE_RATE / 4) {
      flashError("too_short");
      return;
    }
    const dataUrl = toDataUrl(samples);
    if (dataUrlBytes(dataUrl) > optsRef.current.maxAudioBytes) {
      flashError("too_large");
      return;
    }
    optsRef.current.onAudio(dataUrl);
  }, []);

  const start = useCallback(async () => {
    if (captureRef.current || status !== "idle" || !optsRef.current.enabled) return;
    setError(null);
    let capture: MicCapture;
    try {
      capture = await startMicCapture();
    } catch {
      flashError("mic");
      return;
    }
    captureRef.current = capture;
    detectorRef.current = createSilenceDetector(() => finish());
    unsubRef.current = capture.onLevel((rms) => {
      setLevel(rms);
      detectorRef.current?.feed(rms, Date.now());
    });
    setStatus("recording");
    setSeconds(0);
    const startedAt = Date.now();
    clearTimer();
    timerRef.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500);
  }, [status, finish]);

  const stop = useCallback(() => {
    if (!captureRef.current) return;
    const outcome = detectorRef.current?.stop(Date.now()) ?? "no-speech";
    if (outcome === "too_short") {
      captureRef.current.cancel();
      clearTimer();
      unsubRef.current?.();
      unsubRef.current = null;
      captureRef.current = null;
      detectorRef.current = null;
      setStatus("idle");
      setLevel(0);
      flashError("too_short");
      return;
    }
    finish();
  }, [finish]);

  const cancel = useCallback(() => {
    captureRef.current?.cancel();
    captureRef.current = null;
    detectorRef.current = null;
    clearTimer();
    unsubRef.current?.();
    unsubRef.current = null;
    setStatus("idle");
    setLevel(0);
  }, []);

  return { status, seconds, level, error, recording: status === "recording", start, stop, cancel };
}
