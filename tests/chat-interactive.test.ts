// Protocol v3 interactive round trip (docs/protocol-v3.md, issue #21 P2+P3):
// unit coverage for the pending-action gate + meta patcher, and end-to-end
// route behavior — asks stream as STANDARD tool chunks, pending rows are born
// with the asking assistant row, and answers resume generation only after
// passing the (user + thread + unexpired) gate.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as chatRoute from "@/app/api/chat/route";
import { ensureReady } from "@/lib/db";
import { messages, pendingActions, threads } from "@/lib/db/schema";
import { releaseGeneration } from "@/lib/provider/gate";
import { EXPIRED_ANSWER, INTERACTIVE_SERVER, INTERACTIVE_TOOL_DEFS, INTERACTIVE_TOOLS, NO_ANSWER, consumePendingAction, createPendingActions, isInteractiveToolName, overlayToolResults, patchToolResults } from "@/lib/chat/interactive";
import { adminUser, callRoute, makeRequest, sessionId, signUp, type TestUser } from "./support/app";
import { db, setFastModel, setSetting } from "./support/db";
import { bindStream, mockLemonade, modelsResponse, sseChatCompletion, streamResponse, type LemonadeMock } from "./support/lemonade";
import { drainUi, uiData, uiText, uiThread } from "./support/ui-stream";

const CHAT = "/v1/chat/completions";
let user: TestUser & { userId: string };

beforeAll(async () => {
  await ensureReady();
  await adminUser();
  const u = await signUp("chatinter");
  user = Object.assign(u, { userId: await sessionId(u.cookie) });
});

beforeEach(() => {
  db.delete(pendingActions).run();
  db.delete(messages).run();
  db.delete(threads).run();
  releaseGeneration(user.userId);
  setFastModel("default:fast-model.test");
  // Purely-interactive suite: MCP stays off so the tool surface is exactly
  // the two ask tools (the seed DB may carry real server config).
  setSetting("mcp.enabled", "false");
});

// ── mocks / fixtures ─────────────────────────────────────────────────────────

const env = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
const sseLine = (p: Record<string, unknown>) => `data: ${JSON.stringify({ ...env, ...p })}\n\n`;
const sseRes = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

/** ask_choice call streamed in `fragments` argument chunks (+ optional lead
 *  text) — exercises the tool-input-delta forwarding and raw-args capture. */
function sseAsk(toolCallId: string, args: string, fragments = 2, text?: string): Response {
  let body = "";
  if (text) body += sseLine({ choices: [{ index: 0, delta: { role: "assistant", content: text } }] });
  const size = Math.ceil(args.length / fragments);
  for (let i = 0; i < args.length; i += size) {
    const frag = args.slice(i, i + size);
    const call =
      i === 0
        ? { index: 0, id: toolCallId, type: "function", function: { name: "ask_choice", arguments: frag } }
        : { index: 0, function: { arguments: frag } };
    body += sseLine({ choices: [{ index: 0, delta: { tool_calls: [call] } }] });
  }
  body += sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
  return sseRes(body);
}

function mockRoute(handler: () => Response): LemonadeMock {
  const mock = mockLemonade();
  mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
  mock.route(CHAT, handler);
  return mock;
}

async function post(json: unknown) {
  return callRoute(chatRoute.POST, { method: "POST", path: "/api/chat", cookie: user.cookie, json });
}

const ASK_ARGS = JSON.stringify({ question: "Which day?", options: ["Saturday", "Sunday"] });

/** Thread whose last exchange is an unanswered ask: user row + assistant row
 *  carrying the client tool record + its pending row. */
function seedAskTurn(opts: {
  threadId?: string;
  askMsgId?: string;
  toolCallId?: string;
  /** Seed the pending row on ANOTHER thread (foreign lookup must miss). */
  pendingThreadId?: string;
  expiresAt?: Date;
  consumedAt?: Date;
  userMeta?: Record<string, unknown>;
  askResult?: string;
  answered?: boolean;
}): { threadId: string; askMsgId: string; toolCallId: string } {
  const threadId = opts.threadId ?? "th-ask";
  const askMsgId = opts.askMsgId ?? "ask-row";
  const toolCallId = opts.toolCallId ?? "call-ask-1";
  const t = Date.now() - 60_000;
  if (opts.pendingThreadId) {
    db.insert(threads)
      .values({ id: opts.pendingThreadId, userId: user.userId, model: "default:fast-model.test", createdAt: new Date(t), updatedAt: new Date(t) })
      .run();
  }
  db.insert(threads)
    .values({ id: threadId, userId: user.userId, model: "default:fast-model.test", createdAt: new Date(t), updatedAt: new Date(t) })
    .run();
  db.insert(messages)
    .values({ id: "u-ask", threadId, role: "user", content: "book me a slot", metaJson: opts.userMeta ? JSON.stringify(opts.userMeta) : null, createdAt: new Date(t + 1) })
    .run();
  db.insert(messages)
    .values({
      id: askMsgId,
      threadId,
      role: "assistant",
      content: "",
      metaJson: JSON.stringify({
        model: "default:fast-model.test",
        tools: [
          {
            server: INTERACTIVE_SERVER,
            name: "ask_choice",
            ms: 0,
            ok: true,
            args: ASK_ARGS,
            result: opts.askResult ?? NO_ANSWER,
            client: true,
            callId: toolCallId,
            answered: opts.answered ?? false,
          },
        ],
      }),
      createdAt: new Date(t + 2),
    })
    .run();
  db.insert(pendingActions)
    .values({
      id: toolCallId,
      threadId: opts.pendingThreadId ?? threadId,
      userId: user.userId,
      messageId: askMsgId,
      kind: "tool",
      tool: "ask_choice",
      argsJson: ASK_ARGS,
      createdAt: new Date(t),
      expiresAt: opts.expiresAt ?? new Date(t + 10_000_000),
      consumedAt: opts.consumedAt ?? null,
    })
    .run();
  return { threadId, askMsgId, toolCallId };
}

function resumeBody(threadId: string, parts: unknown[]) {
  return { id: threadId, messages: [{ id: "client-echo", role: "assistant", parts }] };
}
const answerPart = (toolCallId: string, output: unknown) => ({
  type: "tool-ask_choice",
  toolCallId,
  state: "output-available",
  output,
});

function readAskRow(askMsgId: string): { result: string; answered: boolean } {
  const row = db.select().from(messages).where(eq(messages.id, askMsgId)).get()!;
  const meta = JSON.parse(row.metaJson!) as { tools: { result: string; answered: boolean }[] };
  return meta.tools[0];
}

// ── pending gate (unit) ──────────────────────────────────────────────────────

describe("interactive gate (unit)", () => {
  it("recognizes only the two interactive tools", () => {
    expect(isInteractiveToolName("ask_choice")).toBe(true);
    expect(isInteractiveToolName("confirm_action")).toBe(true);
    expect(isInteractiveToolName("mcp__ketch__search")).toBe(false);
    expect(isInteractiveToolName(7)).toBe(false);
  });

  it("definitions carry no execute (the loop must pause)", () => {
    expect(Object.keys(INTERACTIVE_TOOL_DEFS)).toEqual([...INTERACTIVE_TOOLS]);
    for (const def of Object.values(INTERACTIVE_TOOL_DEFS)) expect(def.execute).toBeUndefined();
  });

  it("create inserts rows with a TTL and sweeps expired ones", () => {
    const { threadId, askMsgId } = seedAskTurn({ expiresAt: new Date(Date.now() - 1000) });
    const now = new Date();
    // The seed's pending row is expired at `now` ⇒ swept by the create.
    createPendingActions(
      { threadId, userId: user.userId, messageId: askMsgId },
      [
        { toolCallId: "a1", tool: "ask_choice", args: "{}" },
        { toolCallId: "a2", tool: "confirm_action", args: '{"question":"Ship?"}' },
      ],
      now,
    );
    const rows = db.select().from(pendingActions).all();
    expect(rows.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
    expect(rows[0]!.expiresAt.getTime() - now.getTime()).toBe(30 * 60 * 1000);
  });

  it("consume: valid closes the row; replay is invalid", () => {
    const { threadId, askMsgId, toolCallId } = seedAskTurn({});
    const now = new Date("2026-01-01T01:00:00Z");
    expect(consumePendingAction(toolCallId, user.userId, threadId, now)).toEqual({
      status: "valid",
      messageId: askMsgId,
      tool: "ask_choice",
    });
    expect(db.select().from(pendingActions).get()!.consumedAt).not.toBeNull();
    expect(consumePendingAction(toolCallId, user.userId, threadId, now)).toEqual({ status: "invalid" });
  });

  it("consume: expired yields a messageId overlay; unknown/foreign are invalid without closing", () => {
    const { threadId, toolCallId } = seedAskTurn({ expiresAt: new Date("2026-01-01T00:30:00Z") });
    const late = new Date("2026-01-01T01:00:00Z");
    expect(consumePendingAction(toolCallId, user.userId, threadId, late)).toEqual({
      status: "expired",
      messageId: "ask-row",
    });
    expect(consumePendingAction("nope", user.userId, threadId, late)).toEqual({ status: "invalid" });
    expect(consumePendingAction(toolCallId, "someone-else", threadId, late)).toEqual({ status: "invalid" });
  });

  it("patchToolResults rewrites matching callIds only", () => {
    const meta = {
      tools: [
        { server: "yasha", name: "ask_choice", args: "{}", result: NO_ANSWER, client: true, callId: "c1", answered: false },
        { server: "ketch", name: "search", args: "{}", result: "kept" },
        { server: "yasha", name: "ask_choice", args: "{}", result: NO_ANSWER, client: true, callId: "c2", answered: false },
      ],
    };
    const patched = JSON.parse(
      patchToolResults(JSON.stringify(meta), [
        { callId: "c1", result: "Saturday" },
        { callId: "missing", result: "ignored" },
      ]),
    ) as typeof meta;
    expect(patched.tools[0]).toMatchObject({ result: "Saturday", answered: true });
    expect(patched.tools[1]!.result).toBe("kept");
    expect(patched.tools[2]!.result).toBe(NO_ANSWER);
    // Meta without any tools array survives untouched.
    expect(patchToolResults('{"model":"m"}', [{ callId: "c1", result: "x" }])).toBe('{"model":"m"}');
  });

  it("overlayToolResults groups several answers for one row", () => {
    const { askMsgId } = seedAskTurn({});
    overlayToolResults([
      { messageId: askMsgId, callId: "call-ask-1", result: "Saturday" },
      { messageId: askMsgId, callId: "call-ask-2", result: "no such record — ignored" },
    ]);
    expect(readAskRow(askMsgId)).toMatchObject({ result: "Saturday", answered: true });
  });
});

// ── ask flow (route end-to-end) ──────────────────────────────────────────────

describe("ask flow", () => {
  it("streams standard tool chunks, persists the ask row, opens a pending action", async () => {
    mockRoute(() => sseAsk("call-ask-9", ASK_ARGS));
    const res = await post({
      id: "new",
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "book me a slot" }] }],
    });
    const chunks = await drainUi(res);
    expect(uiText(chunks)).toBe("");
    expect(uiData(chunks, "data-error")).toEqual([]); // asking is NOT an empty response
    const inputs = chunks.filter((c) => c.type.startsWith("tool-input-"));
    expect(inputs.map((c) => c.type)).toEqual(["tool-input-start", "tool-input-delta", "tool-input-delta", "tool-input-available"]);
    expect(inputs[0]).toMatchObject({ toolCallId: "call-ask-9", toolName: "ask_choice" });
    expect(inputs.at(-1)).toMatchObject({ toolName: "ask_choice", input: { question: "Which day?", options: ["Saturday", "Sunday"] } });

    const threadId = uiThread(chunks);
    const asst = db.select().from(messages).where(eq(messages.role, "assistant")).get()!;
    const meta = JSON.parse(asst.metaJson!) as { tools: Record<string, unknown>[]; parts: unknown[] };
    expect(meta.tools[0]).toMatchObject({
      server: "yasha",
      name: "ask_choice",
      result: NO_ANSWER,
      client: true,
      callId: "call-ask-9",
      answered: false,
      args: ASK_ARGS, // SDK-parsed input, compact re-serialization
    });
    expect(meta.parts).toEqual([{ type: "tools", count: 1 }]);
    const pending = db.select().from(pendingActions).all();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: "call-ask-9", threadId, messageId: asst.id, tool: "ask_choice", kind: "tool" });
  });

  it("client aborts mid-ask: nothing persists (the question was never closed)", async () => {
    // The SDK emits tool-call parts only when the upstream stream closes, so
    // an aborted ask stores neither a row nor a pending action — answers to
    // it gate out (409) and the user retries as a fresh turn.
    const stream = streamResponse();
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    bindStream(mock, stream);
    const ac = new AbortController();
    const res = await chatRoute.POST(
      makeRequest({
        method: "POST",
        path: "/api/chat",
        cookie: user.cookie,
        signal: ac.signal,
        json: { id: "new", messages: [{ id: "u-abort-ask", role: "user", parts: [{ type: "text", text: "pick a day" }] }] },
      })
    );
    stream.pushPayload({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: "call-abort", type: "function", function: { name: "ask_choice", arguments: '{"question":' } }] } },
      ],
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = "";
    for (let i = 0; i < 40 && !seen.includes("tool-input-delta"); i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += dec.decode(chunk.value, { stream: true });
    }
    expect(seen).toContain("tool-input-delta"); // deltas streamed…
    ac.abort(); // …then the connection died before the call completed
    await new Promise((r) => setTimeout(r, 50));
    expect(db.select().from(messages).where(eq(messages.role, "assistant")).all()).toHaveLength(0);
    expect(db.select().from(pendingActions).all()).toHaveLength(0);
  });

  it("interactive:false: the model never sees the ask tools", async () => {    const mock = mockRoute(() => sseChatCompletion("plain"));
    const res = await post({
      id: "new",
      interactive: false,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
    });
    const chunks = await drainUi(res);
    expect(uiText(chunks)).toBe("plain");
    expect(chunks.some((c) => c.type.startsWith("tool-input-"))).toBe(false);
    const body = JSON.parse(mock.lastCall(CHAT)!.body!) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });

  it("resume with a valid answer: consumed, overlaid, model sees the tool exchange", async () => {
    const { threadId, askMsgId, toolCallId } = seedAskTurn({});
    const mock = mockRoute(() => sseChatCompletion("Saturday it is"));
    const res = await post(resumeBody(threadId, [answerPart(toolCallId, "Saturday")]));
    expect(res.status).toBe(200);
    const chunks = await drainUi(res);
    expect(uiText(chunks)).toBe("Saturday it is");

    expect(db.select().from(pendingActions).get()!.consumedAt).not.toBeNull();
    expect(readAskRow(askMsgId)).toMatchObject({ result: "Saturday", answered: true });

    const body = JSON.parse(mock.lastCall(CHAT)!.body!) as { messages: Record<string, unknown>[] };
    const flat = JSON.stringify(body.messages);
    // Synthesized exchange with the bare (declared) tool name, then the answer.
    expect(flat).toContain('"name":"ask_choice"');
    expect(flat).toContain('"role":"tool"');
    expect(flat).toContain("Saturday");
  });

  it("resume after expiry: EXPIRED_ANSWER is overlaid, turn continues", async () => {
    const { threadId, askMsgId, toolCallId } = seedAskTurn({
      expiresAt: new Date(Date.now() - 1000),
      userMeta: { images: ["data:image/png;base64,AAA"] },
    });
    mockRoute(() => sseChatCompletion("better luck"));
    const res = await post(resumeBody(threadId, [answerPart(toolCallId, "too late")]));
    expect(res.status).toBe(200);
    await drainUi(res);
    expect(readAskRow(askMsgId).result).toBe(EXPIRED_ANSWER);
  });

  it("resume with a mix: closed replays keep their stored result, valid ones land", async () => {
    const { threadId, toolCallId } = seedAskTurn({});
    mockRoute(() => sseChatCompletion("booked"));
    // Second ask record + pending row on the same assistant message; the
    // first one was already answered (replayed here → invalid, must not move).
    const row = db.select().from(messages).where(eq(messages.id, "ask-row")).get()!;
    const meta = JSON.parse(row.metaJson!) as { tools: Record<string, unknown>[] };
    meta.tools.push({
      server: "yasha", name: "ask_choice", ms: 0, ok: true, args: "{}", result: "First answer", client: true, callId: "call-old", answered: true,
    });
    db.update(messages).set({ metaJson: JSON.stringify(meta) }).where(eq(messages.id, "ask-row")).run();
    db.insert(pendingActions)
      .values({
        id: "call-old", threadId, userId: user.userId, messageId: "ask-row", kind: "tool", tool: "ask_choice",
        argsJson: "{}", createdAt: new Date(), expiresAt: new Date(Date.now() + 1e6), consumedAt: new Date(),
      })
      .run();
    const res = await post(resumeBody(threadId, [answerPart("call-old", "replay"), answerPart(toolCallId, "Sunday")]));
    expect(res.status).toBe(200);
    await drainUi(res);
    const after = JSON.parse(db.select().from(messages).where(eq(messages.id, "ask-row")).get()!.metaJson!) as {
      tools: { callId: string; result: string }[];
    };
    expect(after.tools.find((x) => x.callId === "call-old")!.result).toBe("First answer");
    expect(after.tools.find((x) => x.callId === toolCallId)!.result).toBe("Sunday");
  });

  it("resume where NOTHING matches the gate is rejected without generating", async () => {
    const { threadId } = seedAskTurn({ pendingThreadId: "th-other" });
    const mock = mockRoute(() => sseChatCompletion("should not run"));
    const res = await post(resumeBody(threadId, [answerPart("call-ask-1", "forged")]));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "invalid_history" });
    expect(mock.calls.filter((c) => c.url.includes(CHAT))).toHaveLength(0);
  });
});
