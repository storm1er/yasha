// Shared attachment rules for /api/chat (server-side validation, persistence
// format, OpenAI content-part building). Pure: limit values are resolved from
// settings by the caller so this module stays client-importable.
//
// Two media kinds ride on a user message:
//  - images: data URLs (vision models)
//  - audio:  ONE data URL (audio-input models only, AUDIO-REFACTO-PLAN) — sent
//    as OpenAI `input_audio` part(s) on its own turn (audio longer than the
//    model's 30s window is split, lib/audio-split.ts), and replayed in older
//    history as the [voice message] marker (one-shot, bounded cost).

import { VOICE_MESSAGE_MARKER } from "@/lib/audio-input";
import { splitAudioDataUrl } from "@/lib/audio-split";

// Defaults live in lib/settings DEFAULTS (chat.maxImagesPerMessage /
// chat.maxWindowImages); the image byte-size cap stays fixed (post-rescale
// data URLs are far below it — see lib/image-attachment.ts).
export const MAX_IMAGE_DATAURL_CHARS = 6_000_000; // ~4.4 MB decoded per image

export type AttachmentError = "too_many" | "too_large" | "unsupported";

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const AUDIO_DATAURL_RE = /^data:audio\/(wav|mpeg|flac);base64,[A-Za-z0-9+/]+={0,2}$/;
// llama-server (miniaudio) format names for the accepted audio mimes.
const AUDIO_FORMATS: Record<string, string> = { wav: "wav", mpeg: "mp3", flac: "flac" };

/** Approximate decoded byte count of a base64 data URL (ignores padding). */
export function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export type NormalizedAttachments = { images: string[]; audio: string | null; error?: AttachmentError };

/**
 * Validates the client-provided `attachments`: a legacy data-URL string array
 * (images only) or an object `{ images?: string[], audio?: string }`.
 */
export function normalizeAttachments(
  raw: unknown,
  maxImagesPerMessage: number,
  maxAudioBytes: number
): NormalizedAttachments {
  if (raw === undefined || raw === null) return { images: [], audio: null };
  if (Array.isArray(raw)) {
    const r = normalizeImages(raw, maxImagesPerMessage);
    return r.error ? { images: [], audio: null, error: r.error } : { images: r.images, audio: null };
  }
  if (typeof raw === "object") {
    const obj = raw as { images?: unknown; audio?: unknown };
    const imagesRaw = obj.images === undefined || obj.images === null ? [] : obj.images;
    if (!Array.isArray(imagesRaw)) return { images: [], audio: null, error: "unsupported" };
    const imgs = normalizeImages(imagesRaw, maxImagesPerMessage);
    if (imgs.error) return { images: [], audio: null, error: imgs.error };
    if (obj.audio === undefined || obj.audio === null) return { images: imgs.images, audio: null };
    if (typeof obj.audio !== "string" || !AUDIO_DATAURL_RE.test(obj.audio)) {
      return { images: [], audio: null, error: "unsupported" };
    }
    if (dataUrlBytes(obj.audio) > maxAudioBytes) return { images: [], audio: null, error: "too_large" };
    return { images: imgs.images, audio: obj.audio };
  }
  return { images: [], audio: null, error: "unsupported" };
}

function normalizeImages(raw: unknown[], maxImagesPerMessage: number): { images: string[]; error?: AttachmentError } {
  if (raw.length === 0) return { images: [] };
  if (raw.length > maxImagesPerMessage) return { images: [], error: "too_many" };
  const images: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !DATA_URL_RE.test(item)) return { images: [], error: "unsupported" };
    if (item.length > MAX_IMAGE_DATAURL_CHARS) return { images: [], error: "too_large" };
    images.push(item);
  }
  return { images };
}

/** Reads persisted images back out of a user message's meta_json. */
export function parseStoredImages(metaJson: string | null, maxImagesPerMessage: number): string[] {
  if (!metaJson) return [];
  try {
    const meta = JSON.parse(metaJson) as { images?: unknown };
    if (!Array.isArray(meta.images)) return [];
    return meta.images.filter((s): s is string => typeof s === "string").slice(0, maxImagesPerMessage);
  } catch {
    return [];
  }
}

/** Reads the persisted audio data URL out of a user message's meta_json. */
export function parseStoredAudio(metaJson: string | null): string | null {
  if (!metaJson) return null;
  try {
    const meta = JSON.parse(metaJson) as { audio?: unknown };
    return typeof meta.audio === "string" && AUDIO_DATAURL_RE.test(meta.audio) ? meta.audio : null;
  } catch {
    return null;
  }
}

/** input_audio part payload from an `data:audio/<x>;base64,` URL. */
export function audioInputPart(dataUrl: string): { type: "input_audio"; input_audio: { data: string; format: string } } {
  // Callers validate against AUDIO_DATAURL_RE first (normalizeAttachments /
  // parseStoredAudio); the `?? "wav"` covers direct calls with unvalidated
  // input (defensive), the format map has no missing keys for the regex.
  const mime = AUDIO_DATAURL_RE.exec(dataUrl)?.[1] ?? "wav";
  return { type: "input_audio", input_audio: { data: dataUrl, format: AUDIO_FORMATS[mime]! } };
}

/** One input_audio part per ≤30s segment of the data URL (the E2B/E4B audio
 *  encoder silently drops audio past its first 30-second window — see
 *  lib/audio-split.ts). Short audio yields exactly one part. */
export function audioInputParts(dataUrl: string): { type: "input_audio"; input_audio: { data: string; format: string } }[] {
  return splitAudioDataUrl(dataUrl).map(audioInputPart);
}

export type WindowMessage = { role: string; content: string; images: string[]; audio?: string | null };
export type UpstreamContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };
export type UpstreamMessage = { role: string; content: string | UpstreamContentPart[] };

/**
 * Converts the stored message window into OpenAI chat content. Messages with
 * images become content-part arrays; when the window carries more than
 * `maxWindowImages` images, the oldest ones are dropped (text is preserved).
 * Audio is ONE-SHOT: only the window entry at `audioIndex` (usually the newest
 * user message) is sent as an `input_audio` part; any other stored audio is
 * replaced by the [voice message] text marker.
 */
export function buildUpstreamMessages(
  window: WindowMessage[],
  maxWindowImages: number,
  audioIndex = -1
): UpstreamMessage[] {
  const budget = new Map<string, string[]>();
  let remaining = maxWindowImages;
  for (let i = window.length - 1; i >= 0; i--) {
    const keep = window[i].images.slice(Math.max(0, window[i].images.length - remaining));
    remaining -= keep.length;
    budget.set(window[i].role + "\u0000" + i, keep);
  }
  return window.map((m, i) => {
    const images = budget.get(m.role + "\u0000" + i) ?? [];
    const audio = i === audioIndex ? m.audio ?? null : null;
    const marker = m.audio && i !== audioIndex ? (m.content ? m.content + "\n" + VOICE_MESSAGE_MARKER : VOICE_MESSAGE_MARKER) : m.content;
    if (images.length === 0 && !audio) return { role: m.role, content: marker };
    const parts: UpstreamContentPart[] = [];
    if (marker) parts.push({ type: "text", text: marker });
    for (const url of images) parts.push({ type: "image_url", image_url: { url } });
    if (audio) parts.push(...audioInputParts(audio));
    return { role: m.role, content: parts };
  });
}
