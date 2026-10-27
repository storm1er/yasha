// Background caption job for voice messages (AUDIO-REFACTO-PLAN §6): transcribe
// a stored audio data URL with the audio-compatible FAST model (never whisper,
// never the smart model) and persist the caption in the message's meta_json.
// Best-effort by design: upstream failures mark the caption failed (re-triable
// via POST /api/chat/messages/[id]/transcribe) instead of burning queue retries.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages } from "@/lib/db/schema";
import { smartModel } from "@/lib/settings";
import { ensureCatalog, isAudioInputModel } from "@/lib/provider/catalog";
import { audioInputPart } from "@/lib/chat-attachments";
import { splitAudioDataUrl } from "@/lib/audio-split";
import { completeOnce, errMessage, type JobHandler } from "./worker";

export const TRANSCRIBE_PROMPT =
  "Transcribe this audio verbatim in the language spoken. Output only the transcription — no commentary, no translation. If there is no speech, reply exactly [no speech].";

export const TRANSCRIPT_MAX_CHARS = 2000;

type Meta = Record<string, unknown>;

function readMeta(metaJson: string | null): Meta {
  if (!metaJson) return {};
  try {
    const parsed: unknown = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Meta) : {};
  } catch {
    return {};
  }
}

function writeMeta(messageId: string, patch: Meta): void {
  const row = db.select({ metaJson: messages.metaJson }).from(messages).where(eq(messages.id, messageId)).get();
  if (!row) return;
  const meta = readMeta(row.metaJson);
  db.update(messages).set({ metaJson: JSON.stringify({ ...meta, ...patch }) }).where(eq(messages.id, messageId)).run();
}

export const handleAudioTranscription: JobHandler = async ({ payload, cfg, signal }) => {
  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  if (!messageId) return { transcribed: false, skipped: "no_message_id" };
  const row = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!row) return { transcribed: false, skipped: "message_gone" };
  const meta = readMeta(row.metaJson);
  const audio = typeof meta.audio === "string" ? meta.audio : null;
  if (!audio) return { transcribed: false, skipped: "no_audio" };
  const force = payload.force === true;
  if (!force && typeof meta.audioTranscript === "string" && meta.audioTranscript.length > 0) {
    return { transcribed: false, skipped: "already_done" };
  }
  // Defense in depth: the enqueue sites already gate on this. Audio captions
  // run on the audio-compatible fast model only — never the smart model.
  await ensureCatalog(); // capability flags come from the synced catalog rows
  const model = cfg.model;
  if (!model || !isAudioInputModel(model) || model === smartModel()) {
    return { transcribed: false, skipped: "model_not_compatible" };
  }
  try {
    // NOTE: do NOT send chat_template_kwargs.enable_thinking:false — on the
    // Gemma 4 llama.cpp build it yields empty completions (verified live).
    // completeOnce's 2048/8192-token budgets absorb the reasoning spend, and
    // reasoning deltas are dropped (only delta.content is kept).
    // The E2B/E4B audio encoder only hears the first 30s of a clip, so
    // anything longer is transcribed segment by segment and joined (verified
    // live: sequential ≤30s segments reassemble the full utterance).
    const parts: string[] = [];
    for (const segment of splitAudioDataUrl(audio)) {
      const raw = await completeOnce({
        model,
        messages: [
          {
            role: "user",
            // llama-server accepts the full data:audio/…;base64 URL as `data`.
            content: [{ type: "text", text: TRANSCRIBE_PROMPT }, audioInputPart(segment)],
          },
        ],
        signal,
        temperature: 0,
      });
      // completeOnce never resolves to an empty string (it throws
      // "empty_completion" instead) — the catch below records that failure.
      parts.push(raw.trim());
      if (parts.join(" ").length >= TRANSCRIPT_MAX_CHARS) break;
    }
    const transcript = parts.join(" ").trim().slice(0, TRANSCRIPT_MAX_CHARS);
    writeMeta(messageId, {
      audioTranscript: transcript,
      audioTranscriptFailed: false,
      audioTranscriptError: null,
      audioTranscriptModel: model,
      audioTranscriptAt: new Date().toISOString(),
    });
    return { transcribed: true, chars: transcript.length };
  } catch (err) {
    const message = errMessage(err);
    writeMeta(messageId, { audioTranscript: null, audioTranscriptFailed: true, audioTranscriptError: message });
    return { transcribed: false, error: message };
  }
};
