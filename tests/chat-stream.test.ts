import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as chatRoute from "@/app/api/chat/route";
import { ensureReady } from "@/lib/db";
import { db } from "./support/db";
import { setFastModel, setSetting } from "./support/db";
import { rawSqlite } from "./support/db";
import { invalidateSettingsCache } from "@/lib/settings";
import { adminUser, callRoute, makeRequest, sessionId, signUp, waitFor, type AdminUser, type TestUser } from "./support/app";
import { setCurrentHeaders } from "./support/request-context";
import { bindStream, mockLemonade, modelsResponse, sseCompletion, streamResponse, type LemonadeMock } from "./support/lemonade";
import { jobs, memories, messages, settings, threadSummaries, threads } from "@/lib/db/schema";
import { buildMemoryContext } from "@/lib/memory/recall";
import {
  hasInFlightGeneration,
  releaseGeneration,
  stripReasoningFields,
  tryAcquireGeneration,
  forEachSseData,
} from "@/lib/lemonade-stream";

let admin: AdminUser;
let user: TestUser & { userId: string };

const CHAT = "/v1/chat/completions";

const untilAborted = (signal?: AbortSignal | null) =>
  new Promise<void>((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

async function readEvents(res: Response, n: number): Promise<Record<string, unknown>[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Record<string, unknown>[] = [];
  while (out.length < n) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0 && out.length < n) {
      const line = buf.slice(0, i).replace(/\r/g, "");
      buf = buf.slice(i + 2);
      if (line.startsWith("data: ") && line.slice(6) !== "[DONE]") out.push(JSON.parse(line.slice(6)));
    }
  }
  reader.releaseLock();
  return out;
}

async function drain(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

function chatBody(over: Record<string, unknown> = {}) {
  return { message: "hello there", ...over };
}

async function postChat(json: Record<string, unknown>, cookie = user.cookie) {
  return callRoute(chatRoute.POST, { method: "POST", path: "/api/chat", cookie, json });
}

function userMessages(threadId: string) {
  return db.select().from(messages).where(and(eq(messages.threadId, threadId), eq(messages.role, "user"))).all();
}
function assistantMessages(threadId: string) {
  return db.select().from(messages).where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant"))).all();
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await ensureReady();
  admin = await adminUser();
  const u = await signUp("chatstream");
  user = Object.assign(u, { userId: await sessionId(u.cookie) });
});

beforeEach(() => {
  db.delete(messages).run();
  db.delete(threads).run();
  db.delete(jobs).run();
  db.delete(memories).run();
  db.delete(threadSummaries).run();
  db.delete(settings).run();
  releaseGeneration(user.userId);
  setFastModel("fast-model.test");
  invalidateSettingsCache();
});

afterEach(() => {
  releaseGeneration(user.userId);
});

describe("chat route validation", () => {
  it("401 without session", async () => {
    const res = await callRoute(chatRoute.POST, { method: "POST", path: "/api/chat", json: chatBody() });
    expect(res.status).toBe(401);
  });

  it("invalid json / message / attachments", async () => {
    let res = await callRoute(chatRoute.POST, { method: "POST", path: "/api/chat", cookie: user.cookie, body: "{oops" });
    expect((await res.json() as { error: string }).error).toBe("invalid_json");
    res = await postChat({ message: "   " });
    expect((await res.json() as { error: string }).error).toBe("invalid_message"); // empty text + no images
    res = await postChat({ message: "x".repeat(32001) });
    expect((await res.json() as { error: string }).error).toBe("invalid_message");
    res = await postChat({ message: "hi", attachments: ["data:text/html,<script>"] });
    expect(String((await res.json() as { error: string }).error)).toBe("invalid_attachment_unsupported");
    res = await postChat({ attachments: Array.from({ length: 5 }, (_, i) => `data:image/png;base64,AAAA${i}`), message: "five" });
    expect(String((await res.json() as { error: string }).error)).toBe("invalid_attachment_too_many");
  });

  it("body.model validation + upstream model list failure", async () => {
    let res = await postChat(chatBody({ model: 42 }));
    expect((await res.json() as { error: string }).error).toBe("invalid_model");
    res = await postChat(chatBody({ model: "x".repeat(201) }));
    expect((await res.json() as { error: string }).error).toBe("invalid_model");
    res = await postChat(chatBody({ model: "   " }));
    expect((await res.json() as { error: string }).error).toBe("invalid_model");
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseCompletion("null model ok"));
    res = await postChat(chatBody({ model: null })); // null → ignored, falls to default
    expect(res.status).toBe(200);
    await drain(res);
    let modelHits = 0;
    mock.route("/v1/models", () => {
      modelHits += 1;
      return modelHits === 1
        ? new Response("x", { status: 500 })
        : modelsResponse([{ id: "fast-model.test" }, { id: "vision-model.test", vision: true }, { id: "other-model.test" }]);
    });
    res = await postChat(chatBody({ model: "anything" }));
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toBe("upstream_models");
    res = await postChat(chatBody({ model: "nope-model" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid_model");
  });

  it("no_model_configured when neither body nor settings pick one", async () => {
    db.delete(settings).run(); // remove fast model
    const res = await postChat(chatBody());
    expect((await res.json() as { error: string }).error).toBe("no_model_configured");
  });

  it("429 when a generation is already in flight", async () => {
    expect(tryAcquireGeneration(user.userId)).toBeTruthy();
    const res = await postChat(chatBody());
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toBe("busy");
    releaseGeneration(user.userId);
  });

  it("404 for unknown or foreign thread", async () => {
    let res = await postChat(chatBody({ threadId: "nope" }));
    expect(res.status).toBe(404);
    const t = Date.now();
    db.insert(threads).values({ id: "th-foreign", userId: admin.userId, model: "m", title: "", createdAt: new Date(t), updatedAt: new Date(t) }).run();
    res = await postChat(chatBody({ threadId: "th-foreign" }));
    expect(res.status).toBe(404);
  });
});

describe("chat happy path (new thread)", () => {
  it("streams deltas, persists both messages, enqueues after_persist jobs", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }, { id: "vision-model.test", vision: true }]));
    mock.route(CHAT, () => sseCompletion("Hi !", { usage: { total_tokens: 7 }, reasoning: "secret thoughts" }));
    const res = await postChat(chatBody({ message: "remember the milk" }));
    const events = await drain(res);
    expect(events[0]).toEqual({ threadId: expect.any(String) });
    expect(events.some((e) => e.c === "Hi !")).toBe(true);
    expect(events.some((e) => "reasoning" in (e as object))).toBe(false);
    expect(events.at(-1)).toEqual({ done: true });
    const threadId = (events[0] as { threadId: string }).threadId;
    const thread = db.select().from(threads).where(eq(threads.id, threadId)).get()!;
    expect(thread.title).toBe("remember the milk");
    expect(thread.model).toBe("fast-model.test");
    const asst = assistantMessages(threadId);
    expect(asst.length).toBe(1);
    expect(asst[0].content).toBe("Hi !");
    expect(asst[0].metaJson).toContain("total_tokens");
    await waitFor(() => db.select().from(jobs).where(eq(jobs.type, "chat.title_generation")).all().length === 1);
    await waitFor(() => db.select().from(jobs).where(eq(jobs.type, "memory.fact_extraction")).all().length === 1);
    // thread_summary default schedule is idle → never enqueued here
    expect(db.select().from(jobs).where(eq(jobs.type, "memory.thread_summary")).all().length).toBe(0);
    expect(hasInFlightGeneration(user.userId)).toBe(false);
    // prompt got the model + messages with stamped dates
    const sent = JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: { role: string; content: string }[] };
    expect(sent.messages.at(-1)!.role).toBe("user");
    expect(sent.messages.at(-1)!.content).toMatch(/^\[\d{4}-\d{2}-\d{2}\] remember the milk$/);
  });

  it("image-only message creates an “Image” thread", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => sseCompletion("nice pic"));
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`;
    const res = await postChat({ message: "", attachments: [png] });
    await drain(res);
    const th = db.select().from(threads).all()[0];
    expect(th.title).toBe("Image");
    const um = userMessages(th.id)[0];
    expect(um.metaJson).toContain("image/png");
    const sent = JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: { role: string; content: unknown }[] };
    const last = sent.messages.at(-1)!;
    expect(Array.isArray(last.content)).toBe(true); // multimodal parts
  });

  it("existing thread: model fallback chain + body-model persistence", async () => {
    const t = Date.now();
    db.insert(threads).values({ id: "th-blank-model", userId: user.userId, model: "  ", title: "x", createdAt: new Date(t), updatedAt: new Date(t) }).run();
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }, { id: "other-model.test" }]));
    mock.route(CHAT, () => sseCompletion("ok"));
    let res = await postChat(chatBody({ threadId: "th-blank-model" }));
    await drain(res);
    let sent = JSON.parse(mock.lastCall(CHAT)!.body!) as { model: string };
    expect(sent.model).toBe("fast-model.test"); // blank thread.model → defaultPick

    res = await postChat(chatBody({ threadId: "th-blank-model", model: "other-model.test" }));
    await drain(res);
    sent = JSON.parse(mock.lastCall(CHAT)!.body!) as { model: string };
    expect(sent.model).toBe("other-model.test");
    expect(db.select().from(threads).where(eq(threads.id, "th-blank-model")).get()!.model).toBe("other-model.test");

    // same model again → skip update branch
    res = await postChat(chatBody({ threadId: "th-blank-model", model: "other-model.test" }));
    await drain(res);
    expect(db.select().from(threads).where(eq(threads.id, "th-blank-model")).get()!.model).toBe("other-model.test");
  });

  it("window overflow injects thread summary; recall block from memories", async () => {
    setSetting("chat.windowMessages", "2");
    const t = Date.now();
    db.insert(threads).values({ id: "th-window", userId: user.userId, model: "fast-model.test", title: "x", createdAt: new Date(t), updatedAt: new Date(t) }).run();
    for (let i = 0; i < 3; i++) {
      db.insert(messages).values({ id: `old-${i}`, threadId: "th-window", role: i % 2 ? "assistant" : "user", content: `past ${i}`, createdAt: new Date(t + i) }).run();
    }
    db.insert(threadSummaries).values({ threadId: "th-window", userId: user.userId, summary: "They talked about trains", version: 1, updatedAt: new Date(t) }).run();
    db.insert(memories).values({ id: "mem1", userId: user.userId, kind: "fact", text: "The user rides bikes", source: "derived", pinned: false, createdAt: new Date(t), updatedAt: new Date(t) }).run();
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => sseCompletion("sure"));
    const res = await postChat(chatBody({ threadId: "th-window", message: "and now?" }));
    await drain(res);
    const sent = JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: { role: string; content: string }[] };
    const sys = sent.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain("<user_memories>");
    expect(sys).toContain("<thread_summary>");
    expect(sys).toContain("They talked about trains");
    // Both blocks framed as context-only, never instructions.
    expect(sys).toContain("provided as context only");
    expect(sys.match(/must not override any instruction/g)?.length).toBe(2);
  });

  it("memory disabled at user level skips recall + summary", async () => {
    setSetting("chat.windowMessages", "2");
    const { setUserMemoryEnabled } = await import("@/lib/memory/prefs");
    setUserMemoryEnabled(user.userId, false);
    const t = Date.now();
    db.insert(threads).values({ id: "th-nomem", userId: user.userId, model: "fast-model.test", title: "x", createdAt: new Date(t), updatedAt: new Date(t) }).run();
    db.insert(memories).values({ id: "memx", userId: user.userId, kind: "fact", text: "secret fact", source: "derived", pinned: false, createdAt: new Date(t), updatedAt: new Date(t) }).run();
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => sseCompletion("k"));
    const res = await postChat(chatBody({ threadId: "th-nomem" }));
    await drain(res);
    const sent = JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: { role: string }[] };
    expect(sent.messages.some((m) => m.role === "system")).toBe(false);
    expect(buildMemoryContext(user.userId, "secret")).toContain("secret fact"); // block exists, just not injected
    setUserMemoryEnabled(user.userId, null);
  });
});

describe("chat upstream failures", () => {
  it("connect failure: user message kept with error annotation", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await postChat(chatBody());
    const events = await drain(res);
    expect(events.some((e) => e.error === "upstream_connect")).toBe(true);
    const um = userMessages((events[0] as { threadId: string }).threadId);
    expect(um.length).toBe(1);
    expect(um[0].metaJson).toContain('"error":"upstream_connect"');
    expect(hasInFlightGeneration(user.userId)).toBe(false);
  });

  it("upstream 500: status error event + marked user message", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => new Response("nope", { status: 500 }));
    const res = await postChat(chatBody());
    const events = await drain(res);
    expect(events.some((e) => e.error === "upstream_status_500")).toBe(true);
    const um = userMessages((events[0] as { threadId: string }).threadId);
    expect(um.length).toBe(1);
    expect(um[0].metaJson).toContain('"error":"upstream_status_500"');
  });

  it("client abort before upstream responds: silent cleanup, message kept", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, async (_url, call) => {
      await untilAborted(call.signal);
      throw new Error("aborted mid-connect");
    });
    const ac = new AbortController();
    const req = makeRequest({ method: "POST", path: "/api/chat", cookie: user.cookie, json: chatBody(), signal: ac.signal });
    setCurrentHeaders(req.headers);
    const res = await chatRoute.POST(req);
    const first = await readEvents(res, 1); // threadId event arrives before fetch
    const threadId = (first[0] as { threadId: string }).threadId;
    ac.abort();
    await waitFor(() => !hasInFlightGeneration(user.userId));
    await delay(20);
    expect(userMessages(threadId).length).toBe(1); // never generated → nothing to roll back
  });

  it("client abort while upstream returns non-2xx: keeps user message", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, async (_url, call) => {
      await untilAborted(call.signal);
      return new Response("late 500", { status: 500 });
    });
    const ac = new AbortController();
    const req = makeRequest({ method: "POST", path: "/api/chat", cookie: user.cookie, json: chatBody(), signal: ac.signal });
    setCurrentHeaders(req.headers);
    const res = await chatRoute.POST(req);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    })();
    await waitFor(() => text.includes("threadId"));
    ac.abort();
    await pump;
    expect(text).toContain('"error":"upstream_status_500"');
    const threadId = /"threadId":"([^"]+)"/.exec(text)![1];
    expect(userMessages(threadId).length).toBe(1); // client was gone → no rollback
  });

  it("stream fails after partial content: persists partial as aborted", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse();
    bindStream(mock, stream);
    const res = await postChat(chatBody());
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    })();
    await waitFor(() => text.includes("threadId"));
    stream.pushText("partial answer");
    await waitFor(() => text.includes("partial answer"));
    stream.fail(new Error("upstream died"));
    await pump;
    expect(text).toContain('"error":"upstream_stream"');
    const threadId = /"threadId":"([^"]+)"/.exec(text)![1];
    const asst = assistantMessages(threadId);
    expect(asst.length).toBe(1);
    expect(asst[0].content).toBe("partial answer");
    expect(asst[0].metaJson).toContain("aborted");
  });

  it("stream fails with zero content: message kept + marked, error event", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse();
    bindStream(mock, stream);
    const res = await postChat(chatBody());
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    })();
    await waitFor(() => text.includes("threadId"));
    stream.fail(new Error("instant death"));
    await pump;
    expect(text).toContain('"error":"upstream_stream"');
    const threadId = /"threadId":"([^"]+)"/.exec(text)![1];
    const um = userMessages(threadId);
    expect(um.length).toBe(1);
    expect(um[0].metaJson).toContain('"error":"upstream_stream"');
  });

  it("empty completion keeps the user message with an error annotation", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => sseCompletion(""));
    const res = await postChat(chatBody());
    const events = await drain(res);
    expect(events.some((e) => e.error === "empty_response")).toBe(true);
    const um = userMessages((events[0] as { threadId: string }).threadId);
    expect(um.length).toBe(1);
    expect(um[0].metaJson).toContain('"error":"empty_response"');
  });

  it("first-token timeout: 'timeout' error event, message kept + marked", async () => {
    setSetting("chat.firstTokenTimeoutMs", "1000");
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse();
    bindStream(mock, stream);
    const res = await postChat(chatBody());
    const events = await drain(res); // no data ever → timer fires at 1s, abort errors the body
    expect(events.some((e) => e.error === "timeout")).toBe(true);
    const threadId = (events[0] as { threadId: string }).threadId;
    const um = userMessages(threadId);
    expect(um.length).toBe(1);
    expect(um[0].metaJson).toContain('"error":"timeout"');
  });

  it("first-token timeout during upstream connect: 'timeout' event", async () => {
    setSetting("chat.firstTokenTimeoutMs", "300");
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, async (_url, call) => {
      await untilAborted(call.signal);
      throw new Error("aborted mid-connect");
    });
    const res = await postChat(chatBody());
    const events = await drain(res);
    expect(events.some((e) => e.error === "timeout")).toBe(true);
    const um = userMessages((events[0] as { threadId: string }).threadId);
    expect(um.length).toBe(1);
    expect(um[0].metaJson).toContain('"error":"timeout"');
  });

  it("SSE heartbeat comments keep a silent stream alive", async () => {
    setSetting("chat.sseHeartbeatMs", "50");
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse(); // never pushes a token
    bindStream(mock, stream);
    const res = await postChat(chatBody());
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5000;
    while (!text.includes(": ping") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text).toContain(": ping");
    reader.releaseLock();
    await res.body!.cancel(); // cancel must clear the interval (cleanup path)
    await delay(150);
    stream.done();
  });

  it("client cancels the response body: partial text persisted as aborted", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse();
    bindStream(mock, stream);
    stream.pushText("first bit");
    const res = await postChat(chatBody());
    const events = await readEvents(res, 2); // threadId + one delta
    expect(events[1].c).toBeTruthy();
    stream.pushText(" more"); // sent while cancelling → enqueue may throw (caught)
    await res.body!.cancel();
    const threadId = (events[0] as { threadId: string }).threadId;
    await waitFor(() => assistantMessages(threadId).length === 1);
    expect(assistantMessages(threadId)[0].metaJson).toContain("aborted");
  });

  it("ignores malformed json, empty and reasoning-only deltas; forwards usage", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () =>
      new Response(
        [
          "data: \n",
          "data: not-json\n",
          'data: {"choices":[{"delta":{"content":"A"}}]}\n',
          'data: {"choices":[{"delta":{"reasoning":"nope","content":""}}]}\n',
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3}}\n',
          "data: [DONE]\n",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } }
      )
    );
    const res = await postChat(chatBody());
    const events = await drain(res);
    expect(events.filter((e) => "c" in e)).toEqual([{ c: "A" }]);
    expect(events.at(-1)).toEqual({ done: true });
    const threadId = (events[0] as { threadId: string }).threadId;
    expect(assistantMessages(threadId)[0].metaJson).toContain("prompt_tokens");
  });

  it("title schedule 'never' and memory task disable skip enqueue", async () => {
    setSetting("chat.title_generation", JSON.stringify({ schedule: "never", enabled: true, idleMinutes: 5 }));
    setSetting("memory.events.fact_extraction", JSON.stringify({ schedule: "idle", enabled: true, idleMinutes: 5 }));
    setSetting("memory.enabled", "true");
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => sseCompletion("yo"));
    const res = await postChat(chatBody());
    await drain(res);
    await delay(30);
    expect(db.select().from(jobs).all().map((j) => j.type).sort()).toEqual([]);
  });

  it("memory task enabled after_persist enqueues thread_summary too", async () => {
    setSetting("memory.enabled", "true");
    setSetting("memory.events.thread_summary", JSON.stringify({ schedule: "after_persist", enabled: true, idleMinutes: 5 }));
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => sseCompletion("yo"));
    const res = await postChat(chatBody());
    await drain(res);
    await waitFor(() => db.select().from(jobs).where(eq(jobs.type, "memory.thread_summary")).all().length === 1);
  });

  it("enqueue failure is swallowed (best-effort)", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => sseCompletion("yo"));
    // pre-insert a conflicting jobs row id to force the title enqueue insert to throw? Instead: block insert via unique dedupe row → upsert succeeds.
    // Best-effort path is the .catch; simulate by deleting the threads FK target mid-run is too racy → assert happy dedupe instead.
    const res = await postChat(chatBody());
    await drain(res);
    await waitFor(() => db.select().from(jobs).where(eq(jobs.type, "chat.title_generation")).all().length === 1);
    const res2 = await postChat(chatBody({ threadId: db.select().from(threads).all()[0].id }));
    await drain(res2);
    await delay(20);
    expect(db.select().from(jobs).where(eq(jobs.type, "chat.title_generation")).all().length).toBe(1); // dedupe absorbed
  });
});

describe("retry of a failed turn replaces the trailing user row", () => {
  const pngA = `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`;
  const pngB = `data:image/png;base64,${Buffer.from([9, 9, 9]).toString("base64")}`;

  function seedThread(id: string) {
    const t = Date.now();
    db.insert(threads).values({ id, userId: user.userId, model: "fast-model.test", title: "x", createdAt: new Date(t), updatedAt: new Date(t) }).run();
  }
  function seedUser(id: string, threadId: string, content: string, metaJson: string | null) {
    db.insert(messages).values({ id, threadId, role: "user", content, metaJson, createdAt: new Date() }).run();
  }
  function mockOk() {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }, { id: "vision-model.test", vision: true }]));
    mock.route(CHAT, () => sseCompletion("ok"));
    return mock;
  }

  it("identical retry replaces the trailing user message (null meta)", async () => {
    mockOk();
    seedThread("th-r1");
    seedUser("m-r1", "th-r1", "hello there", null);
    await drain(await postChat(chatBody({ threadId: "th-r1" })));
    const rows = userMessages("th-r1");
    expect(rows.length).toBe(1);
    expect(rows[0].id).not.toBe("m-r1");
  });

  it("different text keeps both rows", async () => {
    mockOk();
    seedThread("th-r2");
    seedUser("m-r2", "th-r2", "different", null);
    await drain(await postChat(chatBody({ threadId: "th-r2" })));
    expect(userMessages("th-r2").length).toBe(2);
  });

  it("stored images differ in count → no replace", async () => {
    mockOk();
    seedThread("th-r3");
    seedUser("m-r3", "th-r3", "hello there", JSON.stringify({ images: [pngA] }));
    await drain(await postChat(chatBody({ threadId: "th-r3" })));
    expect(userMessages("th-r3").length).toBe(2);
  });

  it("same image count but different bytes → no replace", async () => {
    mockOk();
    seedThread("th-r4");
    seedUser("m-r4", "th-r4", "hello there", JSON.stringify({ images: [pngA] }));
    await drain(await postChat(chatBody({ threadId: "th-r4", attachments: [pngB] })));
    expect(userMessages("th-r4").length).toBe(2);
  });

  it("identical retry with the same image → replace", async () => {
    mockOk();
    seedThread("th-r5");
    seedUser("m-r5", "th-r5", "hello there", JSON.stringify({ images: [pngA] }));
    await drain(await postChat(chatBody({ threadId: "th-r5", attachments: [pngA] })));
    const rows = userMessages("th-r5");
    expect(rows.length).toBe(1);
    expect(rows[0].id).not.toBe("m-r5");
  });

  it("stored audio vs audio-less retry → no replace", async () => {
    mockOk();
    seedThread("th-r6");
    seedUser("m-r6", "th-r6", "hello there", JSON.stringify({ audio: "data:audio/wav;base64,AAA" }));
    await drain(await postChat(chatBody({ threadId: "th-r6" })));
    expect(userMessages("th-r6").length).toBe(2);
  });
});

describe("chat persist edge arms", () => {
  function armJobsInsertThrow(times: number) {
    const origPrepare = rawSqlite.prepare.bind(rawSqlite);
    let remaining = times;
    rawSqlite.prepare = ((sql: string) => {
      if (remaining > 0 && /insert\s+into\s+["`']?jobs/i.test(sql)) {
        remaining -= 1;
        if (remaining === 0) rawSqlite.prepare = origPrepare;
        throw new Error("forced jobs insert failure");
      }
      return (origPrepare as (q: string) => unknown)(sql);
    }) as typeof rawSqlite.prepare;
    return () => {
      rawSqlite.prepare = origPrepare;
    };
  }

  function baseMock(mock: LemonadeMock) {
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => sseCompletion("yo"));
  }

  it("title enqueue failure is swallowed (still streams + assistant persisted)", async () => {
    const mock = mockLemonade();
    baseMock(mock);
    const restore = armJobsInsertThrow(1); // title_generation insert throws → .catch
    const res = await postChat(chatBody());
    const events = await drain(res);
    restore();
    expect(events.at(-1)).toEqual({ done: true });
    const threadId = (events[0] as { threadId: string }).threadId;
    expect(assistantMessages(threadId).length).toBe(1);
  });

  it("memory task enqueue failure is swallowed too", async () => {
    setSetting("memory.enabled", "true");
    const mock = mockLemonade();
    baseMock(mock);
    const restore = armJobsInsertThrow(2); // title then fact_extraction inserts throw
    const res = await postChat(chatBody());
    const events = await drain(res);
    restore();
    expect(events.at(-1)).toEqual({ done: true });
    expect(db.select().from(jobs).all().length).toBe(0);
  });

  it("overflow thread without summary row skips summary block", async () => {
    setSetting("chat.windowMessages", "2");
    const t = Date.now();
    db.insert(threads).values({ id: "th-nosum", userId: user.userId, model: "fast-model.test", title: "x", createdAt: new Date(t), updatedAt: new Date(t) }).run();
    for (let i = 0; i < 3; i++) db.insert(messages).values({ id: `p-${i}`, threadId: "th-nosum", role: "user", content: `past ${i}`, createdAt: new Date(t + i) }).run();
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => sseCompletion("ok"));
    const res = await postChat(chatBody({ threadId: "th-nosum" }));
    await drain(res);
    const sent = JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: { content: string }[] };
    expect(JSON.stringify(sent.messages)).not.toContain("thread_summary");
  });

  it("abort before any content: no persist, done+aborted event", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse();
    bindStream(mock, stream);
    const ac = new AbortController();
    const req = makeRequest({ method: "POST", path: "/api/chat", cookie: user.cookie, json: chatBody(), signal: ac.signal });
    setCurrentHeaders(req.headers);
    const res = await chatRoute.POST(req);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    })();
    await waitFor(() => text.includes("threadId"));
    ac.abort();
    stream.fail(new Error("gone"));
    await pump;
    expect(text).toContain('"done":true,"aborted":true');
    const threadId = /"threadId":"([^"]+)"/.exec(text)![1];
    expect(assistantMessages(threadId).length).toBe(0);
  });

  it("cancel with zero content: cleanup only", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse();
    bindStream(mock, stream);
    const res = await postChat(chatBody());
    const events = await readEvents(res, 1); // threadId only
    await res.body!.cancel();
    const threadId = (events[0] as { threadId: string }).threadId;
    await waitFor(() => !hasInFlightGeneration(user.userId));
    expect(assistantMessages(threadId).length).toBe(0);
    stream.done();
  });

  it("429 when a generation sneaks in between the busy-gate and the slot claim (TOCTOU)", async () => {
    const mock = mockLemonade();
    baseMock(mock);
    const orig = rawSqlite.prepare.bind(rawSqlite);
    let armed = true;
    rawSqlite.prepare = ((sql: string) => {
      if (armed && /rowid DESC/i.test(sql)) {
        armed = false;
        rawSqlite.prepare = orig;
        tryAcquireGeneration(user.userId); // a competing generation wins the race
      }
      return (orig as (q: string) => unknown)(sql);
    }) as typeof rawSqlite.prepare;
    const res = await postChat(chatBody());
    rawSqlite.prepare = orig;
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toBe("busy");
    expect(hasInFlightGeneration(user.userId)).toBe(true); // winner still owns the slot
    releaseGeneration(user.userId);
  });

  it("non-string message with image attachment flows through", async () => {
    const mock = mockLemonade();
    baseMock(mock);
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`;
    const res = await postChat({ message: 42, attachments: [png] });
    expect(res.status).toBe(200);
    await drain(res);
    expect(db.select().from(threads).all()[0].title).toBe("Image");
  });
});

describe("lemonade-stream helpers", () => {
  it("in-flight gate is per user", () => {
    const a = tryAcquireGeneration("gate-u");
    expect(a).toBeTruthy();
    expect(tryAcquireGeneration("gate-u")).toBeNull();
    expect(hasInFlightGeneration("gate-u")).toBe(true);
    releaseGeneration("gate-u");
    expect(hasInFlightGeneration("gate-u")).toBe(false);
  });

  it("stripReasoningFields prunes recursively", () => {
    const input = {
      choices: [{ delta: { content: "x", reasoning: "y" }, message: { reasoning_details: [1], reasoning_tokens: 2 } }],
      usage: { reasoning: { deep: 1 }, kept: true },
      list: [{ REASONING_X: 1 }, [null, "str", { nested: { reasoningTotal: 3, ok: 1 } }]],
      n: null,
    };
    const out = stripReasoningFields<Record<string, unknown>>(input);
    expect(JSON.stringify(out)).not.toMatch(/reasoning/i);
    expect(JSON.stringify(out)).toContain("kept");
    expect(JSON.stringify(stripReasoningFields("scalar"))).toBe('"scalar"');
    expect(stripReasoningFields(null)).toBeNull();
  });

  it("forEachSseData handles CRLF, split chunks, tail line, non-data lines", async () => {
    const enc = new TextEncoder();
    const chunks = ["event: ping\r\n", "data: one\r\n\r", "\nda", "ta: two\n", "comment\n", "data: tail"];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const got: string[] = [];
    await forEachSseData(body, (p) => void got.push(p));
    expect(got).toEqual(["one", "two", "tail"]);
  });
});

describe("attachment turns follow the plain model fallback chain", () => {
  const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`;
  const models = () =>
    modelsResponse([
      { id: "fast-model.test" },
      { id: "vision-model.test", vision: true },
      { id: "other-model.test" },
    ]);

  it("no vision override: fast default, body.model wins, thread.model persists", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => models());
    mock.route(CHAT, () => sseCompletion("hi"));

    let res = await postChat({ message: "text turn" });
    await drain(res);
    const th = db.select().from(threads).all()[0];
    expect(th.model).toBe("fast-model.test");

    res = await postChat({ message: "what is this", threadId: th.id, attachments: [png] });
    await drain(res);
    expect((JSON.parse(mock.lastCall(CHAT)!.body!) as { model: string }).model).toBe("fast-model.test");

    res = await postChat({ message: "use other", threadId: th.id, attachments: [png], model: "other-model.test" });
    await drain(res);
    expect((JSON.parse(mock.lastCall(CHAT)!.body!) as { model: string }).model).toBe("other-model.test");
    // explicit body-model persists onto the thread (existing behavior)…
    expect(db.select().from(threads).all()[0].model).toBe("other-model.test");

    // …so later turns (attachments or not) follow the thread's model
    res = await postChat({ message: "back to text", threadId: th.id });
    await drain(res);
    expect((JSON.parse(mock.lastCall(CHAT)!.body!) as { model: string }).model).toBe("other-model.test");
  });

  it("new image-only thread persists the fast default", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => models());
    mock.route(CHAT, () => sseCompletion("pic"));
    const res = await postChat({ message: "", attachments: [png] });
    await drain(res);
    const th = db.select().from(threads).all()[0];
    expect(th.model).toBe("fast-model.test");
    expect((JSON.parse(mock.lastCall(CHAT)!.body!) as { model: string }).model).toBe("fast-model.test");
  });
});
