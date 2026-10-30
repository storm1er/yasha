import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as chatRoute from "@/app/api/chat/route";
import * as audioConfigRoute from "@/app/api/audio/config/route";
import * as transcribeRoute from "@/app/api/chat/messages/[id]/transcribe/route";
import { ensureReady } from "@/lib/db";
import { db, setFastModel, setSetting, rawSqlite } from "./support/db";
import { clearModels, seedModel } from "./support/catalog";
import { invalidateSettingsCache } from "@/lib/settings";
import { callRoute, signUp, waitFor, type TestUser } from "./support/app";
import { mockLemonade, sseChatCompletion, type LemonadeMock } from "./support/lemonade";
import { jobs, messages, threads } from "@/lib/db/schema";
import { VOICE_MESSAGE_MARKER } from "@/lib/audio-input";

const CHAT = "/v1/chat/completions";
const AUDIO = "data:audio/wav;base64,UklGRg==";
const GEMMA = "default:user.gemma-4-E4B-it-GGUF-UD-Q4_K_XL"; // canonical (Q6)
const GEMMA_SMART = "default:Gemma-4-12B-it-GGUF";

let user: TestUser & { userId: string };
let mock: LemonadeMock;

function eventCfg(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schedule: "after_persist",
    enabled: true,
    ...over,
  });
}

async function postChat(json: Record<string, unknown>) {
  return callRoute(chatRoute.POST, { method: "POST", path: "/api/chat", cookie: user.cookie, json });
}

function captionJobs() {
  return db.select().from(jobs).where(eq(jobs.type, "chat.audio_transcription")).all();
}

beforeAll(async () => {
  await ensureReady();
  user = Object.assign(await signUp("audio"), { userId: "" });
  user.userId = (rawSqlite.prepare("select id from user where email = ?").get(user.email) as { id: string }).id;
});

beforeEach(() => {
  mock = mockLemonade();
  mock.route(CHAT, () => sseChatCompletion("sure"));
  db.delete(messages).run();
  db.delete(threads).run();
  db.delete(jobs).run();
  // Audio capability is a synced catalog flag (M2b): seed both Gemma rows as
  // audio-capable (fresh, so ensureCatalog serves them without re-syncing).
  clearModels();
  seedModel({ id: GEMMA, audioInput: true });
  seedModel({ id: GEMMA_SMART, audioInput: true });
  setFastModel(GEMMA);
  invalidateSettingsCache();
});

afterEach(() => {
  setSetting("fast_model", "");
  setSetting("smart_model", "");
  setSetting("chat.audio_transcription", "");
  invalidateSettingsCache();
});

describe("POST /api/chat — audio gates", () => {
  it("400 audio_not_supported on an incompatible model, nothing persisted", async () => {
    setFastModel("default:Qwen3-8B-it-GGUF");
    const res = await postChat({ message: "voiced", attachments: { audio: AUDIO } });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("audio_not_supported");
    expect(db.select().from(threads).all()).toHaveLength(0);
    expect(db.select().from(messages).all()).toHaveLength(0);
  });

  it("400 smart_audio_forbidden when the resolved model is the smart model", async () => {
    setSetting("fast_model", "");
    setSetting("smart_model", GEMMA_SMART); // defaultPick = smart (audio-capable id)
    invalidateSettingsCache();
    const res = await postChat({ message: "voiced", attachments: { audio: AUDIO } });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("smart_audio_forbidden");
    expect(db.select().from(threads).all()).toHaveLength(0);
  });

  it("audio-only message streams, persists meta, seeds thread title, queues caption", async () => {
    const res = await postChat({ message: "", attachments: { audio: AUDIO } });
    expect(res.status).toBe(200);
    await res.text();
    const [thread] = db.select().from(threads).all();
    expect(thread.title).toBe("Voice message");
    const [msg] = db.select().from(messages).where(eq(messages.role, "user")).all();
    expect(JSON.parse(msg.metaJson!).audio).toBe(AUDIO);
    await waitFor(() => captionJobs().length === 1);
    const job = captionJobs()[0]!;
    expect(job.dedupeKey).toContain(msg.id);
    expect(JSON.parse(job.payloadJson!)).toEqual({ messageId: msg.id });
    // Upstream got the real input_audio part on this (newest) turn.
    const body = JSON.parse(mock.lastCall(CHAT)!.body as string) as {
      messages: { role: string; content: unknown }[];
    };
    const parts = body.messages.at(-1)!.content as { type: string; text?: string }[];
    expect(parts.some((p) => p.type === "input_audio")).toBe(true);
    // Voice-only turn: an explicit instruction (not the "(image)" stamp) rides
    // in the text part next to the audio.
    const textPart = parts.find((p) => p.type === "text");
    expect(textPart?.text).toContain("voice message");
    expect(textPart?.text).toContain("instructions it contains");
    expect(textPart?.text).not.toContain("(image)");
  });

  it("older voice messages replay as the [voice message] marker", async () => {
    const res1 = await postChat({ message: "first", attachments: { audio: AUDIO } });
    await res1.text();
    const threadId = db.select().from(threads).all()[0]!.id;
    const res2 = await postChat({ threadId, message: "second" });
    await res2.text();
    const body = JSON.parse(mock.lastCall(CHAT)!.body as string) as {
      messages: { role: string; content: string | { type: string }[] }[];
    };
    const voiced = body.messages.find((m) => typeof m.content === "string" && m.content.includes(VOICE_MESSAGE_MARKER));
    expect(voiced).toBeDefined();
    const secondTurn = JSON.stringify(mock.bodies(CHAT).at(-1));
    expect(secondTurn).not.toContain(AUDIO); // audio is one-shot, never re-sent
    expect(secondTurn).toContain(VOICE_MESSAGE_MARKER);
  });

  it("no caption job when the task is disabled / never / misconfigured", async () => {
    const cases = [
      eventCfg({ enabled: "false" }), // string form per resolveEventConfig
      eventCfg({ schedule: "never" }),
      eventCfg({ model: "Qwen3-8B-it-GGUF" }),
      eventCfg({ model: GEMMA_SMART }), // equals smart model below
    ];
    for (const cfg of cases) {
      db.delete(jobs).run();
      db.delete(messages).run();
      db.delete(threads).run();
      setSetting("smart_model", cfg === cases[3] ? GEMMA_SMART : "");
      setSetting("chat.audio_transcription", cfg);
      invalidateSettingsCache();
      const res = await postChat({ message: "voiced", attachments: { audio: AUDIO } });
      expect(res.status).toBe(200);
      await res.text();
      expect(captionJobs()).toHaveLength(0);
    }
    // Caption model unresolved (no fast model, client picked the model).
    db.delete(jobs).run();
    db.delete(messages).run();
    db.delete(threads).run();
    setSetting("chat.audio_transcription", "");
    setSetting("fast_model", "");
    invalidateSettingsCache();
    const res = await postChat({ message: "voiced", model: GEMMA, attachments: { audio: AUDIO } });
    expect(res.status).toBe(200);
    await res.text();
    expect(captionJobs()).toHaveLength(0);
  });
});

describe("GET /api/audio/config", () => {
  it("401 without a session", async () => {
    const res = await callRoute(audioConfigRoute.GET, { method: "GET", path: "/api/audio/config" });
    expect(res.status).toBe(401);
  });

  it("exposes the resolved capability for clients", async () => {
    setSetting("smart_model", GEMMA_SMART);
    invalidateSettingsCache();
    const res = await callRoute(audioConfigRoute.GET, { method: "GET", path: "/api/audio/config", cookie: user.cookie });
    expect(res.status).toBe(200);
    // compatibleModels are the audio-capable catalog ids (providerId, remoteId order)
    expect(await res.json()).toEqual({
      enabled: true,
      model: GEMMA,
      smartModel: GEMMA_SMART,
      compatibleModels: [GEMMA_SMART, GEMMA],
      smartAudioCapable: true,
      maxAudioBytes: 8388608,
    });
  });

  it("disabled when no fast model is configured", async () => {
    setSetting("fast_model", "");
    invalidateSettingsCache();
    const res = await callRoute(audioConfigRoute.GET, { method: "GET", path: "/api/audio/config", cookie: user.cookie });
    const json = (await res.json()) as { enabled: boolean; model: string | null };
    expect(json.enabled).toBe(false);
    expect(json.model).toBeNull();
  });
});

describe("POST /api/chat/messages/[id]/transcribe", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  function seedVoiceMessage(threadId?: string): string {
    const t = threadId ?? crypto.randomUUID();
    if (!threadId) {
      db.insert(threads).values({ id: t, userId: user.userId, model: GEMMA, title: "t", createdAt: new Date(), updatedAt: new Date() }).run();
    }
    const m = crypto.randomUUID();
    db.insert(messages).values({ id: m, threadId: t, role: "user", content: "", metaJson: JSON.stringify({ audio: AUDIO }), createdAt: new Date() }).run();
    return m;
  }

  function post(id: string, cookie = user.cookie) {
    return callRoute(transcribeRoute.POST, { method: "POST", path: `/api/chat/messages/${id}/transcribe`, cookie }, ctx(id));
  }

  it("401 without session, 404 for unknown/foreign messages", async () => {
    const res = await callRoute(
      transcribeRoute.POST,
      { method: "POST", path: "/api/chat/messages/whatever/transcribe" },
      ctx("whatever")
    );
    expect(res.status).toBe(401);
    const res2 = await post("missing-id");
    expect(res2.status).toBe(404);
  });

  it("400 no_audio for messages without stored audio", async () => {
    const t = crypto.randomUUID();
    db.insert(threads).values({ id: t, userId: user.userId, model: GEMMA, title: "t", createdAt: new Date(), updatedAt: new Date() }).run();
    const m = crypto.randomUUID();
    db.insert(messages).values({ id: m, threadId: t, role: "user", content: "plain", metaJson: null, createdAt: new Date() }).run();
    const res = await post(m);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("no_audio");
  });

  it("400 audio_not_supported when the caption model is unusable", async () => {
    const id = seedVoiceMessage();
    setSetting("chat.audio_transcription", eventCfg({ model: "Qwen3-8B-it-GGUF" }));
    invalidateSettingsCache();
    const res = await post(id);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("audio_not_supported");
    // schedule never is rejected too
    setSetting("chat.audio_transcription", eventCfg({ schedule: "never" }));
    invalidateSettingsCache();
    expect((await post(id)).status).toBe(400);
  });

  it("queues with force and returns queued:false when a run is in flight", async () => {
    const id = seedVoiceMessage();
    const res = await post(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true });
    const [job] = captionJobs().filter((j) => j.dedupeKey.endsWith(`:${id}`));
    expect(JSON.parse(job!.payloadJson!)).toEqual({ messageId: id, force: true });
    expect(job.dedupeKey.endsWith(`:${id}`)).toBe(true);

    // Same message, already running → dedupe leaves it alone → queued:false.
    db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id)).run();
    expect(await post(id).then((r) => r.json())).toEqual({ queued: false });
  });

  it("does not leak messages of other users", async () => {
    const t = crypto.randomUUID();
    const other = await signUp("audioother");
    const otherId = (rawSqlite.prepare("select id from user where email = ?").get(other.email) as { id: string }).id;
    db.insert(threads).values({ id: t, userId: otherId, model: GEMMA, title: "t", createdAt: new Date(), updatedAt: new Date() }).run();
    const m = crypto.randomUUID();
    db.insert(messages).values({ id: m, threadId: t, role: "user", content: "", metaJson: JSON.stringify({ audio: AUDIO }), createdAt: new Date() }).run();
    expect((await post(m)).status).toBe(404);
  });
});

describe("enqueue best-effort", () => {
  it("swallows caption-job enqueue failures (chat route and re-transcribe)", async () => {
    // Real rejection seam: the jobs table is briefly absent, so enqueueJob
    // rejects and the routes' best-effort catches must absorb it.
    rawSqlite.exec("alter table jobs rename to jobs_hidden");
    try {
      const res = await postChat({ message: "voiced", attachments: { audio: AUDIO } });
      expect(res.status).toBe(200);
      await res.text();

      const [thread] = db.select().from(threads).all();
      const msg = db.select().from(messages).where(eq(messages.threadId, thread.id)).all()[0]!;
      const res2 = await callRoute(
        transcribeRoute.POST,
        { method: "POST", path: `/api/chat/messages/${msg.id}/transcribe`, cookie: user.cookie },
        { params: Promise.resolve({ id: msg.id }) }
      );
      expect(res2.status).toBe(200);
      expect(await res2.json()).toEqual({ queued: false });
    } finally {
      rawSqlite.exec("alter table jobs_hidden rename to jobs");
    }
    expect(captionJobs()).toHaveLength(0); // swallowed, nothing queued
  });
});
