// Protocol v3 request contract (docs/protocol-v3.md, issue #21 P1): branch
// coverage for lib/chat/request-v3.ts plus the route behavior it feeds —
// reconciliation (409), client-id idempotency, ghost tolerance, and the
// "transport, not truth" hydration rule.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as chatRoute from "@/app/api/chat/route";
import { parseV3Request } from "@/lib/chat/request-v3";
import { ensureReady } from "@/lib/db";
import { messages, threads } from "@/lib/db/schema";
import { releaseGeneration } from "@/lib/provider/gate";
import { callRoute, sessionId, signUp, type TestUser } from "./support/app";
import { db, setFastModel } from "./support/db";
import { mockLemonade, modelsResponse, sseChatCompletion } from "./support/lemonade";
import { drainUi } from "./support/ui-stream";
import { v3Body } from "./support/v3";

const CHAT = "/v1/chat/completions";
let user: TestUser & { userId: string };

beforeAll(async () => {
  await ensureReady();
  const u = await signUp("chatv3");
  user = Object.assign(u, { userId: await sessionId(u.cookie) });
});

beforeEach(() => {
  db.delete(messages).run();
  db.delete(threads).run();
  releaseGeneration(user.userId);
  setFastModel("default:fast-model.test");
});

function mockOk() {
  const mock = mockLemonade();
  mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
  mock.route(CHAT, () => sseChatCompletion("yo"));
  return mock;
}

async function post(json: unknown, cookie = user.cookie) {
  return callRoute(chatRoute.POST, { method: "POST", path: "/api/chat", cookie, json });
}

function seedThread(id: string) {
  const now = new Date();
  db.insert(threads)
    .values({ id, userId: user.userId, model: "default:fast-model.test", createdAt: now, updatedAt: now })
    .run();
}
function seedMessage(id: string, threadId: string, role: "user" | "assistant", content: string) {
  db.insert(messages).values({ id, threadId, role, content, createdAt: new Date() }).run();
}

const turn = (text: string) => [{ type: "text", text }];

describe("parseV3Request (unit)", () => {
  const okMsg = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] };
  const body = (over: Record<string, unknown> = {}) => ({ id: "new", messages: [okMsg], ...over });

  it("accepts the stock body with defaults", () => {
    const r = parseV3Request(body());
    expect(r).toMatchObject({
      ok: true,
      threadId: "",
      newThread: true,
      clientMsgId: "u1",
      text: "hi",
      historyIds: [],
      interactive: true,
      model: undefined,
      attachments: undefined,
    });
  });

  it("resolves the thread id: absent/null/empty/new vs explicit", () => {
    expect(parseV3Request(body({ id: null }))).toMatchObject({ ok: true, threadId: "" });
    expect(parseV3Request(body({ id: "" }))).toMatchObject({ ok: true, newThread: true });
    expect(parseV3Request(body({ id: "new" }))).toMatchObject({ ok: true, newThread: true });
    expect(parseV3Request(body({ id: "t-1" }))).toMatchObject({ ok: true, threadId: "t-1", newThread: false });
    expect(parseV3Request(body({ id: "t".repeat(65) }))).toMatchObject({ error: "invalid_history" });
    expect(parseV3Request(body({ id: 42 }))).toMatchObject({ error: "invalid_history" });
  });

  it("rejects non-objects, arrays, and bad message lists", () => {
    expect(parseV3Request(null)).toMatchObject({ error: "invalid_history" });
    expect(parseV3Request("str")).toMatchObject({ error: "invalid_history" });
    expect(parseV3Request([{ id: "u1", role: "user", parts: [] }])).toMatchObject({ error: "invalid_history" });
    expect(parseV3Request(body({ messages: undefined }))).toMatchObject({ error: "invalid_history" });
    expect(parseV3Request(body({ messages: "nope" }))).toMatchObject({ error: "invalid_history" });
    expect(parseV3Request(body({ messages: [] }))).toMatchObject({ error: "invalid_history" });
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `a${i}`, role: "assistant", parts: [] }));
    expect(parseV3Request({ id: "t", messages: [...many, okMsg] })).toMatchObject({ error: "invalid_history" });
  });

  it("a new thread must not echo history", () => {
    const two = [
      { id: "a-old", role: "assistant", parts: [] },
      { id: "u-new", role: "user", parts: turn("x") },
    ];
    expect(parseV3Request({ id: "new", messages: two })).toMatchObject({ error: "invalid_history" });
    expect(parseV3Request({ id: "t", messages: two })).toMatchObject({ ok: true });
  });

  it("validates history entries (shape only) and collects user-role ids, deduped", () => {
    const mixed = [
      { id: "a1", role: "assistant", parts: [] },
      { id: "u1", role: "user", parts: [] },
      { id: "u1", role: "user", parts: [] }, // duplicate collapses
      { id: "u-new", role: "user", parts: turn("x") },
    ];
    expect(parseV3Request({ id: "t", messages: mixed })).toMatchObject({ ok: true, historyIds: ["u1"] });
    // Malformed entries of any kind are history errors:
    for (const bad of [
      null,
      { id: "x" }, // role missing
      { id: "x", role: "system" }, // role not allowed
      { role: "user" }, // id missing
      { id: "", role: "user" }, // id empty
      { id: "x".repeat(65), role: "user" }, // id oversized
      { id: 7, role: "assistant" }, // id not a string
    ]) {
      expect(parseV3Request({ id: "t", messages: [bad, okMsg] })).toMatchObject({ error: "invalid_history" });
    }
  });

  it("the trailing message must be a well-formed, fresh user turn", () => {
    // role not user
    expect(parseV3Request({ id: "t", messages: [{ id: "a", role: "assistant", parts: turn("x") }] })).toMatchObject({
      error: "invalid_history",
    });
    // trailing not an object
    expect(parseV3Request({ id: "t", messages: ["nope"] })).toMatchObject({ error: "invalid_history" });
    // trailing id malformed
    expect(parseV3Request({ id: "t", messages: [{ role: "user", parts: [] }] })).toMatchObject({ error: "invalid_history" });
    // trailing id already echoed in history
    expect(
      parseV3Request({ id: "t", messages: [{ id: "u9", role: "user", parts: [] }, { id: "u9", role: "user", parts: turn("x") }] })
    ).toMatchObject({ error: "invalid_history" });
    // parts missing / not an array
    expect(parseV3Request({ id: "t", messages: [{ id: "u9", role: "user" }] })).toMatchObject({ error: "invalid_history" });
    expect(parseV3Request({ id: "t", messages: [{ id: "u9", role: "user", parts: {} }] })).toMatchObject({
      error: "invalid_history",
    });
  });

  it("joins trailing text parts, ignoring everything else", () => {
    const r = parseV3Request({
      id: "new",
      messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "a" }, { type: "file" }, null, { type: "text", text: "b" }] }],
    });
    expect(r).toMatchObject({ ok: true, text: "ab" });
  });

  it("interactive defaults to true; only booleans pass", () => {
    expect(parseV3Request(body())).toMatchObject({ interactive: true });
    expect(parseV3Request(body({ interactive: true }))).toMatchObject({ ok: true, interactive: true });
    expect(parseV3Request(body({ interactive: false }))).toMatchObject({ ok: true, interactive: false });
    expect(parseV3Request(body({ interactive: "yes" }))).toEqual({ ok: false, error: "invalid_message", status: 400 });
  });

  it("model + attachments flow through untouched", () => {
    const r = parseV3Request(body({ model: { complex: true }, attachments: [1, 2] }));
    expect(r).toMatchObject({ ok: true, model: { complex: true }, attachments: [1, 2] });
  });
});

describe("POST /api/chat (protocol v3 behavior)", () => {
  it("persists the client-generated id on the user turn", async () => {
    mockOk();
    const res = await post(v3Body({ message: "mint", id: "cli-123" }));
    expect(res.status).toBe(200);
    await drainUi(res);
    expect(db.select().from(messages).where(eq(messages.id, "cli-123")).all()).toHaveLength(1);
  });

  it("409 invalid_history on an unknown user-role echo", async () => {
    seedThread("th-a");
    const res = await post({
      id: "th-a",
      messages: [
        { id: "ghost-user", role: "user", parts: [] },
        { id: "u-new", role: "user", parts: turn("continue") },
      ],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "invalid_history" });
  });

  it("tolerates assistant-role ghosts (a failed turn persists no row)", async () => {
    mockOk();
    seedThread("th-a");
    const res = await post({
      id: "th-a",
      messages: [
        { id: "ghost-assistant", role: "assistant", parts: [{ type: "text", text: "partial failure" }] },
        { id: "u-new", role: "user", parts: turn("continue") },
      ],
    });
    expect(res.status).toBe(200);
    await drainUi(res);
  });

  it("existing thread with NO echoed history — the Android minimal window (P4)", async () => {
    const mock = mockOk();
    seedThread("th-a");
    seedMessage("q1", "th-a", "user", "first question");
    seedMessage("a1", "th-a", "assistant", "answer");
    const res = await post({ id: "th-a", messages: [{ id: "u-min", role: "user", parts: turn("follow-up") }] });
    expect(res.status).toBe(200);
    await drainUi(res);
    // Model input is still rebuilt from the stored window (transport, not truth).
    const upstream = (JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: unknown[] }).messages;
    expect(JSON.stringify(upstream)).toContain("first question");
  });

  it("stored content wins over echoed content (transport, not truth)", async () => {
    const mock = mockOk();
    seedThread("th-a");
    seedMessage("canon", "th-a", "user", "CANONICAL QUESTION");
    const res = await post({
      id: "th-a",
      messages: [
        { id: "canon", role: "user", parts: turn("IGNORED JUNK") },
        { id: "u-new", role: "user", parts: turn("and now?") },
      ],
    });
    expect(res.status).toBe(200);
    await drainUi(res);
    const upstream = (JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: Array<{ content: unknown }> }).messages;
    const flat = JSON.stringify(upstream);
    expect(flat).toContain("CANONICAL QUESTION");
    expect(flat).not.toContain("IGNORED JUNK");
  });

  it("same trailing client id replaces the failed tail (idempotent retry)", async () => {
    mockOk();
    seedThread("th-a");
    seedMessage("cli-9", "th-a", "user", "first try");
    // The failed turn IS the trailing message on a double-submit retry:
    // same client id, no echo of it as history.
    const res = await post({ id: "th-a", messages: [{ id: "cli-9", role: "user", parts: turn("first try!") }] });
    expect(res.status).toBe(200);
    await drainUi(res);
    const rows = db.select().from(messages).where(eq(messages.threadId, "th-a")).all();
    expect(rows.filter((m) => m.role === "user")).toHaveLength(1);
    expect(rows.find((m) => m.id === "cli-9")?.content).toBe("first try!");
    expect(rows.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("409: trailing id living in ANOTHER thread", async () => {
    seedThread("th-a");
    seedThread("th-b");
    seedMessage("cross-1", "th-a", "user", "mine");
    const res = await post(v3Body({ threadId: "th-b", message: "hijack", id: "cross-1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "invalid_history" });
  });

  it("409: trailing id is the thread's assistant tail", async () => {
    seedThread("th-a");
    seedMessage("a-tail", "th-a", "assistant", "answer");
    const res = await post(v3Body({ threadId: "th-a", message: "x", id: "a-tail" }));
    expect(res.status).toBe(409);
  });

  it("409: trailing id exists mid-thread (not the tail)", async () => {
    seedThread("th-a");
    seedMessage("u-mid", "th-a", "user", "old question");
    seedMessage("a-tail", "th-a", "assistant", "old answer");
    const res = await post({
      id: "th-a",
      messages: [
        { id: "a-tail", role: "assistant", parts: [] },
        { id: "u-mid", role: "user", parts: turn("resurrect") },
      ],
    });
    expect(res.status).toBe(409);
  });

  it("v2 bodies (threadId/message keys) are rejected outright", async () => {
    const res = await post({ threadId: "", message: "legacy" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "invalid_history" });
  });

  it("interactive flag: booleans accepted end-to-end, junk is invalid_message", async () => {
    mockOk();
    const res = await post(v3Body({ message: "hi", interactive: false }));
    expect(res.status).toBe(200);
    await drainUi(res);
    const bad = await post(v3Body({ message: "hi", interactive: "yes" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_message" });
  });
});
