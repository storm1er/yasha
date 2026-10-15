// Audio-input capability rules (AUDIO-REFACTO-PLAN §3). Lemonade does not tag
// audio-capable chat models, so Yasha owns a hardcoded compatibility list:
// models whose GGUF ships an audio encoder in the mmproj (Gemma 4 conformer,
// projector gemma4a/gemma4ua in strix-llama.cpp). Audio input rides the fast
// model ONLY — the smart model is never used for audio.
//
// Pure module: settings are read by the caller (client-safe).

// Token match against lowercased model ids: covers registry ids
// (Gemma-4-E4B-it-GGUF, Gemma-4-12B-it-MTP-GGUF), user variants
// (user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL) and quants. 26B-A4B/31B are
// text+image only (Unsloth docs) and must NOT match.
export const AUDIO_INPUT_COMPAT = ["gemma-4-e2b", "gemma-4-e4b", "gemma-4-12b"] as const;
export const AUDIO_COMPAT_LABELS = ["Gemma-4 E2B", "Gemma-4 E4B", "Gemma-4 12B"] as const;

/** Marker that replaces stored audio when replaying history to the model. */
export const VOICE_MESSAGE_MARKER = "[voice message]";

/**
 * Body used upstream when a voice message carries NO typed text. Sending an
 * empty text part alongside `input_audio` confuses the Gemma audio template
 * (verified live: the model answers "I cannot process this image" — and the
 * transcript stamp would otherwise say "(image)"). The instruction tells the
 * model the audio IS the user input.
 */
export const AUDIO_TURN_INSTRUCTION =
  "The user sent a voice message: the audio attached to this turn is their actual input. " +
  "Listen to it and respond to its content, including any instructions it contains.";

export function isAudioInputModel(id: string | null | undefined): boolean {
  if (!id) return false;
  const lc = id.toLowerCase();
  return AUDIO_INPUT_COMPAT.some((token) => lc.includes(token));
}

export type AudioInputConfig = {
  /** True when the FAST model accepts audio input (sole enable gate). */
  enabled: boolean;
  /** Current fast model id (null while unconfigured). */
  model: string | null;
  /** Current smart model id — clients hide the mic while it is selected. */
  smartModel: string | null;
  /** Human labels of the compatible models, for settings notices. */
  compatibleModels: string[];
  /** Smart model would match too — notice explains it is ignored on purpose. */
  smartAudioCapable: boolean;
  /** Max audio data-URL byte cap for chat uploads. */
  maxAudioBytes: number;
};

/** Build the client-facing audio-input config from resolved model ids. */
export function audioInputConfig(opts: {
  fastModel: string | null;
  smartModel: string | null;
  maxAudioBytes: number;
}): AudioInputConfig {
  return {
    enabled: isAudioInputModel(opts.fastModel),
    model: opts.fastModel,
    smartModel: opts.smartModel,
    compatibleModels: [...AUDIO_COMPAT_LABELS],
    smartAudioCapable: isAudioInputModel(opts.smartModel),
    maxAudioBytes: opts.maxAudioBytes,
  };
}
