// Resume-stream reattach end-to-end (issue #33): generation is decoupled from
// the POST connection (lib/chat/replay hub). Covers the new surface —
// GET /api/chat/[threadId]/stream (reattach, 204 semantics, implicit
// ownership), POST /api/chat/stop (explicit kill: partial row aborted:true,
// gate release), the thread-detail `generating` flag, and the inverted
// disconnect semantics (a gone view no longer kills the turn).

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as chatRoute from "@/app/api/chat/route";
import * as reattachRoute from "@/app/api/chat/[threadId]/stream/route";
import * as stopRoute from "@/app/api/chat/stop/route";
import * as threadRoute from "@/app/api/threads/[id]/route";
import { ensureReady } from "@/lib/db";
import { messages, threads } from "@/lib/db/schema";
import { hasInFlightGeneration } from "@/lib/provider/gate";
import { adminUser, callRoute, sessionId, signUp, waitFor, type TestUser } from "./support/app";
import { db, setFastModel } from "./support/db";
import { bindStream, mockLemonade, modelsResponse, streamResponse } from "./support/lemonade";

let user: TestUser & { userId: string };
let other: TestUser;

beforeAll(async () => {
  await ensureReady();
  await adminUser();
  const u = await signUp("reattachuser");
  user = Object.assign(u, { userId: await sessionId(u.cookie) });
  other = await signUp("reattachother");
});

beforeEach(() => {
  db.delete(messages).run();
  db.delete(threads).run();
  setFastModel("default:fast-model.test");
});

const chatBody = () => ({
  id: "new",
  messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hub turn" }] }],
});

/** Controllable upstream so a turn can be held mid-generation. */
function mockStreamModel() {
  const mock = mockLemonade();
  mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
  const stream = streamResponse();
  bindStream(mock, stream);
  return stream;
}

async function postChat(json: unknown) {
  return callRoute(chatRoute.POST, { method: "POST", path: "/api/chat", cookie: user.cookie, json });
}

/** Collects a response's raw SSE text in the background (single reader). */
function attachCollector(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const doneP = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
  })();
  return {
    text: () => text,
    threadId: () => /"threadId":"([^"]+)"/.exec(text)![1],
    cancel: () => reader.cancel(),
    doneP,
  };
}

function assistantRows(threadId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant")))
    .all();
}

const threadGet = (cookie: string, threadId: string) =>
  callRoute(threadRoute.GET, { path: `/api/threads/${threadId}`, cookie }, { params: Promise.resolve({ id: threadId }) });
const streamGet = (cookie: string | undefined, threadId: string) =>
  callRoute(reattachRoute.GET, { path: `/api/chat/${threadId}/stream`, ...(cookie ? { cookie } : {}) }, {
    params: Promise.resolve({ threadId }),
  });
const stopPost = (json: unknown, cookie: string | null = user.cookie) =>
  callRoute(stopRoute.POST, { method: "POST", path: "/api/chat/stop", cookie, json });

describe("reattach GET /api/chat/[threadId]/stream", () => {
  it("401 without a session", async () => {
    expect((await streamGet(undefined, "th-whatever")).status).toBe(401);
  });

  it("204 when nothing is generating (the SDK's clean no-resume signal)", async () => {
    expect((await streamGet(user.cookie, "th-idle")).status).toBe(204);
  });

  it("reattaches mid-turn with a full replay from frame zero", async () => {
    const stream = mockStreamModel();
    const post = await postChat(chatBody());
    const view = attachCollector(post);
    await waitFor(() => view.text().includes("data-thread"));
    const threadId = view.threadId();

    const reattached = await streamGet(user.cookie, threadId);
    expect(reattached.status).toBe(200);
    expect(reattached.headers.get("content-type")).toContain("text/event-stream");
    const replay = reattached.text(); // resolves when the generation ends

    stream.pushText("hello ");
    stream.pushText("world");
    stream.pushFinish();
    stream.done();

    const body = await replay;
    expect(body).toContain("data-thread"); // replayed from zero
    expect(body).toContain("hello "); // text deltas, in order, from frame zero
    expect(body.indexOf("hello ")).toBeLessThan(body.indexOf("world"));
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);

    // The turn completed even though the original POST never drained to the end.
    const [row] = assistantRows(threadId);
    expect(row.content).toContain("hello world");
    expect(row.metaJson).not.toContain("aborted");
  });

  it("another user's thread id matches no hub → 204 (no leak, no 404 oracle)", async () => {
    const stream = mockStreamModel();
    const post = await postChat(chatBody());
    const view = attachCollector(post);
    await waitFor(() => view.text().includes("data-thread"));

    expect((await streamGet(other.cookie, view.threadId())).status).toBe(204);
    stream.pushFinish();
    stream.done();
  });
});

describe("stop POST /api/chat/stop", () => {
  it("401 / 400 invalid_json / 400 missing-or-junk id / 404 when idle", async () => {
    expect((await stopPost({}, null)).status).toBe(401);
    const badJson = await callRoute(stopRoute.POST, {
      method: "POST",
      path: "/api/chat/stop",
      cookie: user.cookie,
      body: "{definitely not json",
    });
    expect(badJson.status).toBe(400);
    expect((await stopPost({})).status).toBe(400);
    expect((await stopPost({ id: "" })).status).toBe(400);
    expect((await stopPost({ id: 42 })).status).toBe(400);
    expect((await stopPost({ id: "th-nope" })).status).toBe(404);
  });

  it("kills the in-flight turn: partial row persisted as aborted, gate released", async () => {
    const stream = mockStreamModel();
    const post = await postChat(chatBody());
    const view = attachCollector(post);
    await waitFor(() => view.text().includes("data-thread"));
    const threadId = view.threadId();

    stream.pushText("partial answer");
    await waitFor(() => view.text().includes("partial answer"));

    expect((await stopPost({ id: threadId })).status).toBe(200);
    await waitFor(() => !hasInFlightGeneration(user.userId));
    await view.doneP; // the killed view terminates (its hub closed)

    const [row] = assistantRows(threadId);
    expect(row).toBeDefined();
    expect(row.metaJson).toContain("aborted");
    // Hub gone: reattach now answers 204.
    expect((await streamGet(user.cookie, threadId)).status).toBe(204);
  });
});

describe("thread GET generating flag + detach semantics", () => {
  it("flag false on an idle thread", async () => {
    const t = Date.now();
    db.insert(threads)
      .values({ id: "th-flag", userId: user.userId, model: "m", createdAt: new Date(t), updatedAt: new Date(t) })
      .run();
    const body = (await (await threadGet(user.cookie, "th-flag")).json()) as { thread: { generating?: boolean } };
    expect(body.thread.generating).toBe(false);
  });

  it("flag true while a detached turn runs; view cancel does NOT kill it", async () => {
    const stream = mockStreamModel();
    const post = await postChat(chatBody());
    const view = attachCollector(post);
    await waitFor(() => view.text().includes("data-thread"));
    const threadId = view.threadId();

    const mid = (await (await threadGet(user.cookie, threadId)).json()) as { thread: { generating?: boolean } };
    expect(mid.thread.generating).toBe(true);

    // The client goes away for good (reload without reattach): the turn must
    // still finish and persist COMPLETE (issue #33's inverted semantics).
    await view.cancel();
    // The busy gate stays claimed while it runs — a second send is refused.
    expect((await postChat(chatBody())).status).toBe(429);

    stream.pushText("finished server-side");
    stream.pushFinish();
    stream.done();
    await waitFor(() => assistantRows(threadId).length === 1);
    const [row] = assistantRows(threadId);
    expect(row.content).toContain("finished server-side");
    expect(row.metaJson).not.toContain("aborted");

    const after = (await (await threadGet(user.cookie, threadId)).json()) as { thread: { generating?: boolean } };
    expect(after.thread.generating).toBe(false);
  });
});
