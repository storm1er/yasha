import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ensureReady } from "@/lib/db";
import { db, setFastModel, setSetting } from "./support/db";
import { adminUser, type AdminUser } from "./support/app";
import { mockLemonade, sseCompletion, type LemonadeMock } from "./support/lemonade";
import { messages, threads } from "@/lib/db/schema";
import type { EventConfig } from "@/lib/settings";
import { invalidateSettingsCache } from "@/lib/settings";
import {
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIBE_PROMPT,
  handleAudioTranscription,
} from "@/lib/jobs/audio-transcribe";
import { encodeWavPcm16 } from "@/lib/browser/wav";

const CHAT = "/v1/chat/completions";
const AUDIO = "data:audio/wav;base64,UklGRg==";
const GEMMA = "user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL";

/** PCM16 WAV data URL of `seconds` of silence (splittable by lib/audio-split). */
function longWav(seconds: number): string {
  return "data:audio/wav;base64," + Buffer.from(encodeWavPcm16(new Float32Array(seconds * 16000), 16000)).toString("base64");
}

let admin: AdminUser;
let mock: LemonadeMock;

function cfg(model: string | null): EventConfig {
  return {
    schedule: "after_persist",
    idleMinutes: 1,
    cronExpr: "",
    model,
    timeoutMs: 60_000,
    maxAttempts: 2,
    backoffMs: 1000,
    enabled: true,
  };
}

type Ctx = Parameters<typeof handleAudioTranscription>[0];

function makeCtx(payload: Record<string, unknown>, model: string | null = GEMMA) {
  const ac = new AbortController();
  return {
    job: { id: "job-1", dedupeKey: "k", type: "chat.audio_transcription", threadId: null, userId: admin.userId, status: "running", attempts: 0, payloadJson: null },
    payload,
    cfg: cfg(model),
    signal: ac.signal,
    heartbeat: () => {},
    setCheckpoint: () => {},
    addCommit: () => {},
  } as unknown as Ctx;
}

function seedMessage(metaJson: string | null): string {
  const t = crypto.randomUUID();
  const m = crypto.randomUUID();
  db.insert(threads).values({ id: t, userId: admin.userId, model: "m", title: "t", createdAt: new Date(), updatedAt: new Date() }).run();
  db.insert(messages).values({ id: m, threadId: t, role: "user", content: "", metaJson, createdAt: new Date() }).run();
  return m;
}

function metaOf(id: string): Record<string, unknown> {
  const row = db.select({ metaJson: messages.metaJson }).from(messages).where(eq(messages.id, id)).get();
  return row?.metaJson ? JSON.parse(row.metaJson) : {};
}

beforeAll(async () => {
  await ensureReady();
  admin = await adminUser();
});

beforeEach(() => {
  mock = mockLemonade();
  db.delete(messages).run();
  db.delete(threads).run();
  setFastModel(GEMMA);
  invalidateSettingsCache();
});

afterEach(() => {
  setSetting("smart_model", "");
  invalidateSettingsCache();
});

describe("handleAudioTranscription — guards", () => {
  it("skips when messageId is absent", async () => {
    expect(await handleAudioTranscription(makeCtx({}))).toEqual({ transcribed: false, skipped: "no_message_id" });
  });

  it("skips when the message row is gone", async () => {
    expect(await handleAudioTranscription(makeCtx({ messageId: "missing" }))).toEqual({
      transcribed: false,
      skipped: "message_gone",
    });
  });

  it("skips when meta carries no audio (broken / array meta too)", async () => {
    for (const meta of [null, "{oops", JSON.stringify({ images: [] }), JSON.stringify({ audio: 7 })]) {
      const id = seedMessage(meta);
      expect(await handleAudioTranscription(makeCtx({ messageId: id }))).toEqual({
        transcribed: false,
        skipped: "no_audio",
      });
    }
    // Object-shaped but array meta exercises the non-array guard of readMeta.
    const id = seedMessage("[1,2,3]");
    expect(await handleAudioTranscription(makeCtx({ messageId: id }))).toEqual({
      transcribed: false,
      skipped: "no_audio",
    });
  });

  it("skips when a transcript already exists, unless force", async () => {
    const id = seedMessage(JSON.stringify({ audio: AUDIO, audioTranscript: "done" }));
    expect(await handleAudioTranscription(makeCtx({ messageId: id }))).toEqual({
      transcribed: false,
      skipped: "already_done",
    });
    // force re-runs and overwrites.
    mock.route(CHAT, () => sseCompletion("hello world"));
    const res = await handleAudioTranscription(makeCtx({ messageId: id, force: true }));
    expect(res).toEqual({ transcribed: true, chars: "hello world".length });
    expect(metaOf(id).audioTranscript).toBe("hello world");
  });

  it("empty existing transcript does NOT count as done", async () => {
    mock.route(CHAT, () => sseCompletion("hello world"));
    const id = seedMessage(JSON.stringify({ audio: AUDIO, audioTranscript: "" }));
    expect(await handleAudioTranscription(makeCtx({ messageId: id }))).toEqual({
      transcribed: true,
      chars: "hello world".length,
    });
  });

  it("refuses missing / incompatible / smart-model captions", async () => {
    const id = seedMessage(JSON.stringify({ audio: AUDIO }));
    for (const model of [null, "Qwen3-8B-it-GGUF"]) {
      expect(await handleAudioTranscription(makeCtx({ messageId: id }, model))).toEqual({
        transcribed: false,
        skipped: "model_not_compatible",
      });
    }
    // Compatible id, but it IS the configured smart model → never caption.
    setSetting("smart_model", GEMMA);
    invalidateSettingsCache();
    expect(await handleAudioTranscription(makeCtx({ messageId: id }, GEMMA))).toEqual({
      transcribed: false,
      skipped: "model_not_compatible",
    });
  });
});

describe("handleAudioTranscription — runs", () => {
  it("persists the transcript and flags on the message meta", async () => {
    mock.route(CHAT, () => sseCompletion("hello world"));
    const id = seedMessage(JSON.stringify({ audio: AUDIO }));
    const res = await handleAudioTranscription(makeCtx({ messageId: id }));
    expect(res).toEqual({ transcribed: true, chars: "hello world".length });
    const meta = metaOf(id);
    expect(meta.audioTranscript).toBe("hello world");
    expect(meta.audioTranscriptFailed).toBe(false);
    expect(meta.audioTranscriptError).toBeNull();
    expect(meta.audioTranscriptModel).toBe(GEMMA);
    expect(typeof meta.audioTranscriptAt).toBe("string");
    // Upstream request shape: audio part + prompt + thinking disabled + temp 0.
    const body = JSON.parse(mock.lastCall(CHAT)!.body as string) as Record<string, unknown>;
    const msgs = body.messages as { role: string; content: unknown[] }[];
    expect(msgs[0]!.content[0]).toEqual({ type: "text", text: TRANSCRIBE_PROMPT });
    expect((msgs[0]!.content[1] as Record<string, Record<string, string>>).input_audio.data).toBe(AUDIO);
    expect(body).not.toHaveProperty("chat_template_kwargs"); // thinking stays on (see handler note)
    expect(body.temperature).toBe(0);
  });

  it("truncates very long transcripts", async () => {
    mock.route(CHAT, () => sseCompletion("x".repeat(TRANSCRIPT_MAX_CHARS + 500)));
    const id = seedMessage(JSON.stringify({ audio: AUDIO }));
    const res = await handleAudioTranscription(makeCtx({ messageId: id }));
    expect(res).toEqual({ transcribed: true, chars: TRANSCRIPT_MAX_CHARS });
  });

  it("transcribes >30s audio segment by segment and joins the parts", async () => {
    const replies = ["first part", "second part", "third part"];
    let n = 0;
    mock.route(CHAT, () => sseCompletion(replies[n++] ?? "extra"));
    const id = seedMessage(JSON.stringify({ audio: longWav(61) }));
    const res = await handleAudioTranscription(makeCtx({ messageId: id }));
    expect(res).toEqual({ transcribed: true, chars: "first part second part third part".length });
    expect(metaOf(id).audioTranscript).toBe("first part second part third part");
    expect(mock.calls.filter((c) => c.url.includes(CHAT)).length).toBe(3);
  });

  it("stops segmenting once the transcript hits the char cap", async () => {
    mock.route(CHAT, () => sseCompletion("x".repeat(TRANSCRIPT_MAX_CHARS)));
    const id = seedMessage(JSON.stringify({ audio: longWav(91) }));
    const res = await handleAudioTranscription(makeCtx({ messageId: id }));
    expect(res).toEqual({ transcribed: true, chars: TRANSCRIPT_MAX_CHARS });
    // first reply alone reached the cap → no second call
    expect(mock.calls.filter((c) => c.url.includes(CHAT)).length).toBe(1);
  });

  it("marks failure when a later segment fails", async () => {
    let n = 0;
    mock.route(CHAT, () => (n++ === 0 ? sseCompletion("first part") : new Response("nope", { status: 500 })));
    const id = seedMessage(JSON.stringify({ audio: longWav(45) }));
    const res = await handleAudioTranscription(makeCtx({ messageId: id }));
    expect(res).toMatchObject({ transcribed: false });
    expect(String((res as { error: string }).error)).toContain("upstream_status_500");
    expect(metaOf(id).audioTranscriptFailed).toBe(true);
  });

  it("marks failure when upstream errors and stores the message", async () => {
    mock.route(CHAT, () => new Response("nope", { status: 500 }));
    const id = seedMessage(JSON.stringify({ audio: AUDIO }));
    const res = await handleAudioTranscription(makeCtx({ messageId: id }));
    expect(res).toMatchObject({ transcribed: false });
    expect(String((res as { error: string }).error)).toContain("upstream_status_500");
    const meta = metaOf(id);
    expect(meta.audioTranscript).toBeNull();
    expect(meta.audioTranscriptFailed).toBe(true);
  });

  it("marks failure on a non-Error throw", async () => {
    mock.route(CHAT, () => {
      throw "kaput";
    });
    const id = seedMessage(JSON.stringify({ audio: AUDIO }));
    const res = await handleAudioTranscription(makeCtx({ messageId: id }));
    expect(res).toEqual({ transcribed: false, error: "kaput" });
    expect(metaOf(id).audioTranscriptError).toBe("kaput");
  });

  it("survives a message deleted while transcribing (no meta write)", async () => {
    const id = seedMessage(JSON.stringify({ audio: AUDIO }));
    mock.route(CHAT, () => {
      db.delete(messages).where(eq(messages.id, id)).run();
      return sseCompletion("late answer");
    });
    const res = await handleAudioTranscription(makeCtx({ messageId: id }));
    expect(res).toEqual({ transcribed: true, chars: "late answer".length });
    expect(db.select().from(messages).where(eq(messages.id, id)).get()).toBeUndefined();
  });
});
