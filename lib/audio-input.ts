// Audio-input feature rules. Capability is a per-model flag in the synced
// catalog (docs/provider-plan.md Q14): the Lemonade adapter auto-seeds it from
// its compatibility heuristic, admins override it per model — no hardcoded
// list here anymore. Audio input rides the fast model ONLY — the smart model
// is never used for audio.

// Marker that replaces stored audio when replaying history to the model.
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

export type AudioInputConfig = {
  /** True when the FAST model accepts audio input (sole enable gate). */
  enabled: boolean;
  /** Current fast model id (null while unconfigured). */
  model: string | null;
  /** Current smart model id — clients hide the mic while it is selected. */
  smartModel: string | null;
  /** Catalog ids of audio-capable models, for settings notices. */
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
  /** Catalog ids with audioInput enabled (from lib/provider/catalog). */
  audioCapableModels: string[];
}): AudioInputConfig {
  const capable = new Set(opts.audioCapableModels);
  return {
    enabled: opts.fastModel !== null && capable.has(opts.fastModel),
    model: opts.fastModel,
    smartModel: opts.smartModel,
    compatibleModels: [...opts.audioCapableModels],
    smartAudioCapable: opts.smartModel !== null && capable.has(opts.smartModel),
    maxAudioBytes: opts.maxAudioBytes,
  };
}
