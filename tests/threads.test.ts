import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { messages, threads } from "@/lib/db/schema";
import { DELETE as threadDelete, GET as threadGet, PATCH as threadPatch } from "@/app/api/threads/[id]/route";
import { GET as threadsList } from "@/app/api/threads/route";
import { callRoute, jsonOf, sessionId, signUp, type TestUser } from "./support/app";
import { db } from "./support/db";

let me: TestUser & { userId: string };
let other: TestUser & { userId: string };

async function seedThread(userId: string, id: string, title: string, at: Date) {
  await db
    .insert(threads)
    .values({ id, userId, model: "m", title, createdAt: at, updatedAt: at })
    .run();
  return id;
}

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  me = Object.assign(await signUp("thrme"), { userId: "" });
  me.userId = await sessionId(me.cookie);
  other = Object.assign(await signUp(" throther".trim()), { userId: "" });
  other.userId = await sessionId(other.cookie);
});

describe("GET /api/threads", () => {

  it("lists only own threads, newest first", async () => {
    await seedThread(me.userId, "old", "old", new Date(1000));
    await seedThread(me.userId, "new", "new", new Date(5000));
    await seedThread(other.userId, "foreign", "foreign", new Date(9000));

    const res = await callRoute(threadsList, { cookie: me.cookie });
    const body = await jsonOf<{ threads: { threadId: string; title: string; updatedAt: string }[] }>(res);
    expect(body.threads.map((t) => t.threadId)).toEqual(["new", "old"]);
    expect(body.threads[0].updatedAt).toBe(new Date(5000).toISOString());
  });

  it("rejects anonymous", async () => {
    expect((await callRoute(threadsList)).status).toBe(401);
    expect((await callRoute(threadGet, { path: "/api/threads/x" }, ctxFor("x"))).status).toBe(401);
  });
});

describe("/api/threads/[id]", () => {
  it("GET returns thread + messages with parsed meta", async () => {
    const threadId = await seedThread(me.userId, "th-get", "Meta", new Date(1000));
    await db
      .insert(messages)
      .values([
        { id: "m1", threadId, role: "user", content: "hi", metaJson: null, createdAt: new Date(1000) },
        { id: "m2", threadId, role: "assistant", content: "yo", metaJson: JSON.stringify({ model: "m", usage: { a: 1 } }), createdAt: new Date(2000) },
      ])
      .run();

    const res = await callRoute(threadGet, { path: `/api/threads/${threadId}`, cookie: me.cookie }, ctxFor(threadId));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await jsonOf<{ thread: { threadId: string; title: string; model: string; updatedAt: string }; messages: { id: string; meta: unknown }[] }>(res);
    expect(body.thread).toMatchObject({ threadId, title: "Meta", model: "m" });
    expect(body.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(body.messages[0].meta).toBeNull();
    expect(body.messages[1].meta).toEqual({ model: "m", usage: { a: 1 } });
  });

  it("404 on foreign or unknown thread for GET/DELETE/PATCH", async () => {
    const threadId = "th-404";
    await seedThread(me.userId, threadId, "owned", new Date());
    const intruderCookie = other.cookie;
    expect((await callRoute(threadGet, { path: `/api/threads/${threadId}`, cookie: intruderCookie }, ctxFor(threadId))).status).toBe(404);
    expect((await callRoute(threadDelete, { method: "DELETE", path: `/api/threads/${threadId}`, cookie: intruderCookie }, ctxFor(threadId))).status).toBe(404);
    expect((await callRoute(threadPatch, { method: "PATCH", path: `/api/threads/${threadId}`, cookie: intruderCookie, json: { title: "x" } }, ctxFor(threadId))).status).toBe(404);
    expect((await callRoute(threadGet, { path: "/api/threads/nope", cookie: intruderCookie }, ctxFor("nope"))).status).toBe(404);
  });

  it("PATCH renames; rejects invalid bodies; DELETE cascades messages", async () => {
    const threadId = "th-patch";
    await seedThread(me.userId, threadId, "Before", new Date());
    await db.insert(messages).values({ id: "mx", threadId, role: "user", content: "x", createdAt: new Date() }).run();
    const ctx = ctxFor(threadId);
    const patch = (body: unknown) =>
      callRoute(threadPatch, { method: "PATCH", path: "/x", cookie: me.cookie, json: body }, ctx);

    expect((await callRoute(threadPatch, { method: "PATCH", path: "/x", cookie: me.cookie, body: "{" }, ctx)).status).toBe(400);
    expect((await patch({ title: "  " })).status).toBe(400);
    expect((await patch({ title: "x".repeat(201) })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ title: 42 })).status).toBe(400);

    const ok = await patch({ title: "  After  " });
    expect(await jsonOf(ok)).toEqual({ ok: true, title: "After" });

    const del = await callRoute(threadDelete, { method: "DELETE", path: "/x", cookie: me.cookie }, ctx);
    expect(await jsonOf(del)).toEqual({ ok: true });
    expect(db.select().from(messages).where(and(eq(messages.threadId, threadId))).all()).toHaveLength(0);
  });
});
