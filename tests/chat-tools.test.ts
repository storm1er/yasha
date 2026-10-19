import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as chatRoute from "@/app/api/chat/route";
import { buildToolset, runToolCall, type ToolHandle } from "@/lib/mcp/bridge";
import {
  createToolCallAccumulator,
  dispatchToolCalls,
  expandToolRounds,
  parseToolRounds,
  synthesizeToolMessages,
} from "@/lib/mcp/loop";
import { ensureReady } from "@/lib/db";
import { setUserMcpEnabled } from "@/lib/mcp/prefs";
import { db, setFastModel, setSetting } from "./support/db";
import { callRoute, makeRequest, sessionId, signUp, type TestUser } from "./support/app";
import { json, mockLemonade, sseCompletion, streamResponse, type LemonadeMock } from "./support/lemonade";
import { setCurrentHeaders } from "./support/request-context";
import { jobs, messages, threads } from "@/lib/db/schema";

vi.mock("@/lib/mcp/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/bridge")>();
  return { ...actual, buildToolset: vi.fn(), runToolCall: vi.fn() };
});

let user: TestUser & { userId: string };
let modelSeq = 0;

const CHAT = "/v1/chat/completions";

const toolset = {
  specs: [
    {
      type: "function" as const,
      function: { name: "mcp__ketch__search", description: "ketch: search", parameters: {} },
    },
  ],
  handles: new Map<string, ToolHandle>([
    ["mcp__ketch__search", { serverId: "ketch", tool: "search", title: "ketch: search", userId: "u1" }],
  ]),
};
const emptyToolset = { specs: [], handles: new Map<string, ToolHandle>() };

function sseToolCalls(calls: { id?: string; name: string; args?: string }[]): Response {
  let body = "";
  calls.forEach((c, i) => {
    const first = { index: i, ...(c.id ? { id: c.id } : {}), function: { name: c.name, arguments: "" } };
    body += `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [first] } }] })}\n\n`;
    if (c.args) {
      body += `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: c.args } }] } }] },
      )}\n\n`;
    }
  });
  body += "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function drain(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

async function readRest(res: Response): Promise<Record<string, unknown>[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Record<string, unknown>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  for (const part of buf.split("\n\n")) {
    if (part.startsWith("data: ") && part !== "data: [DONE]") out.push(JSON.parse(part.slice(6)));
  }
  reader.releaseLock();
  return out;
}

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

async function postChat(jsonBody: Record<string, unknown>) {
  return callRoute(chatRoute.POST, {
    method: "POST",
    path: "/api/chat",
    cookie: user.cookie,
    json: { message: "hello", ...jsonBody },
  });
}

function nextModel() {
  modelSeq += 1;
  const id = `tool-model-${modelSeq}`;
  setFastModel(id);
  return id;
}

function assistantRows(threadId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant")))
    .all();
}

function upstreamBodies(mock: LemonadeMock) {
  return mock.bodies(CHAT) as { messages: Record<string, unknown>[]; tools?: unknown; tool_choice?: string }[];
}

beforeAll(async () => {
  await ensureReady();
  const u = await signUp("tooluser");
  user = Object.assign(u, { userId: await sessionId(u.cookie) });
});

let mock: LemonadeMock;

beforeEach(() => {
  db.delete(messages).run();
  db.delete(threads).run();
  db.delete(jobs).run();
  setFastModel(`model-def-${Date.now()}-${modelSeq++}`);
  setSetting("mcp.enabled", "true");
  setSetting("mcp.maxToolRounds", "4");
  vi.mocked(buildToolset).mockResolvedValue(toolset);
  vi.mocked(runToolCall).mockResolvedValue({ content: "RESULT", ok: true, ms: 5 });
  mock = mockLemonade();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("chat tool loop", () => {
  it("per-user opt-out suppresses tool injection", async () => {
    setUserMcpEnabled(user.userId, false);
    try {
      mock.route(CHAT, () => sseCompletion("plain answer"));
      const res = await postChat({});
      const events = await drain(res);
      expect(events.map((e) => Object.keys(e)[0])).toEqual(["threadId", "c", "done"]);
      expect(upstreamBodies(mock)[0].tools).toBeUndefined();

      // A thread with a past tool turn must NOT re-arm tool tokens while opted out.
      const threadId = events[0].threadId as string;
      db.insert(messages)
        .values({
          id: "opt-tool-1",
          threadId,
          role: "assistant",
          content: "Tokyo",
          metaJson: JSON.stringify({ model: "m", tools: [{ server: "ketch", name: "search", ms: 1, ok: true, args: "{}", result: "R" }], toolCalls: [{ id: "t0", name: "mcp__ketch__search", args: "{}" }] }),
          createdAt: new Date(),
        })
        .run();
      await postChat({ threadId, message: "again?" });
      const msgs = upstreamBodies(mock)[1].messages as Record<string, unknown>[];
      expect(msgs.some((m) => m.role === "tool" || m.tool_calls !== undefined)).toBe(false);
      expect(msgs.some((m) => m.role === "assistant" && m.content === "Tokyo")).toBe(true);
    } finally {
      setUserMcpEnabled(user.userId, null);
    }
  });

  it("runs one tool round: events, rebuilt messages, meta.tools", async () => {
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      return n === 1
        ? sseToolCalls([{ id: "t0", name: "mcp__ketch__search", args: '{"q":"x"}' }])
        : sseCompletion("Answer", { usage: { total_tokens: 7 } });
    });
    const res = await postChat({});
    const events = await drain(res);
    expect(events.map((e) => Object.keys(e)[0])).toEqual(["threadId", "tool", "tool", "c", "done"]);
    expect(events[1]).toEqual({ tool: { server: "ketch", name: "search", status: "running", args: '{"q":"x"}' } });
    expect(events[2]).toEqual({ tool: { server: "ketch", name: "search", status: "done", args: '{"q":"x"}', result: "RESULT", ms: 5 } });

    const bodies = upstreamBodies(mock);
    expect(bodies[0].tools).toEqual(toolset.specs);
    expect(bodies[0].tool_choice).toBe("auto");
    const tail = bodies[1].messages.slice(-2);
    expect(tail[0]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t0", type: "function", function: { name: "mcp__ketch__search", arguments: '{"q":"x"}' } }],
    });
    expect(tail[1]).toMatchObject({ role: "tool", tool_call_id: "t0", content: "RESULT" });

    const threadId = events[0].threadId as string;
    const row = assistantRows(threadId)[0];
    const meta = JSON.parse(row.metaJson!) as {
      model: string;
      usage: unknown;
      tools: { server: string; name: string; ms: number; ok: boolean; args: string; result: string }[];
    };
    expect(meta.tools).toHaveLength(1);
    expect(meta.tools[0]).toMatchObject({ server: "ketch", name: "search", ms: 5, ok: true, args: '{"q":"x"}' });
    expect(meta.usage).toEqual({ total_tokens: 7 });
  });

  it("parallel calls incl. unknown tool name → error result, no throw", async () => {
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      return n === 1
        ? sseToolCalls([
            { id: "a", name: "mcp__ketch__search", args: "{}" },
            { id: "b", name: "mcp__ghost__x" },
          ])
        : sseCompletion("done now");
    });
    const events = await drain(await postChat({}));
    const toolEvents = events.filter((e) => e.tool).map((e) => e.tool as Record<string, unknown>);
    expect(toolEvents).toContainEqual({ server: "ketch", name: "search", status: "running", args: "{}" });
    expect(
      toolEvents.some(
        (t) => t.status === "error" && t.name === "mcp__ghost__x" && String(t.result).includes("unknown tool"),
      ),
    ).toBe(true);
    expect(toolEvents).toContainEqual({ server: "ketch", name: "search", status: "done", args: "{}", result: "RESULT", ms: 5 });

    const toolMsgs = upstreamBodies(mock)[1].messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(String(toolMsgs[1].content)).toContain("unknown tool");

    const threadId = events[0].threadId as string;
    const meta = JSON.parse(assistantRows(threadId)[0].metaJson!) as { tools: { server: string; ok: boolean }[] };
    expect(meta.tools).toEqual([
      expect.objectContaining({ server: "ketch", ok: true }),
      expect.objectContaining({ server: "?", ok: false }),
    ]);
  });

  it("tool error result → error event, model still answers, record ok:false", async () => {
    vi.mocked(runToolCall).mockResolvedValue({ content: "tool error: boom", ok: false, ms: 2 });
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      return n === 1 ? sseToolCalls([{ id: "t0", name: "mcp__ketch__search" }]) : sseCompletion("sorry");
    });
    const events = await drain(await postChat({}));
    expect(events.filter((e) => e.tool).map((e) => (e.tool as { status: string }).status)).toEqual([
      "running",
      "error",
    ]);
    const meta = JSON.parse(assistantRows(events[0].threadId as string)[0].metaJson!) as {
      tools: { ok: boolean; result: string }[];
    };
    expect(meta.tools[0]).toMatchObject({ ok: false, result: "tool error: boom" });
  });

  it("stops after mcp.maxToolRounds rounds (no further dispatch)", async () => {
    setSetting("mcp.maxToolRounds", "1");
    mock.route(CHAT, () => sseToolCalls([{ id: "t0", name: "mcp__ketch__search" }]));
    const events = await drain(await postChat({}));
    expect(events.at(-1)).toEqual({ error: "empty_response" });
    expect(mock.calls.filter((c) => c.url.includes(CHAT))).toHaveLength(2);
    expect(vi.mocked(runToolCall)).toHaveBeenCalledTimes(1);
    const userMsgs = db.select().from(messages).where(eq(messages.role, "user")).all();
    expect(userMsgs).toHaveLength(1); // turn kept + annotated so the user can retry
    expect(userMsgs[0].metaJson).toContain('"error":"empty_response"');
  });

  it("4xx with tools → silent retry without tools, model remembered", async () => {
    const model = nextModel();
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      return n === 1 ? json({ error: "tools unsupported" }, 400) : sseCompletion("plain answer");
    });
    const events = await drain(await postChat({}));
    expect(events.at(-1)).toEqual({ done: true });
    const bodies = upstreamBodies(mock);
    expect(bodies[0].tools).toBeDefined();
    expect(bodies[1].tools).toBeUndefined();
    expect(bodies[1].tool_choice).toBeUndefined();

    // Second turn on the same model: buildToolset is skipped entirely.
    mock.route(CHAT, () => sseCompletion("again"));
    await drain(await postChat({}));
    expect(vi.mocked(buildToolset)).toHaveBeenCalledTimes(1);
    expect(model).toBeTruthy();
  });

  it("4xx twice → surfaces upstream_status error", async () => {
    nextModel();
    mock.route(CHAT, () => json({ error: "nope" }, 400));
    const events = await drain(await postChat({}));
    expect(events.at(-1)).toEqual({ error: "upstream_status_400" });
    expect(mock.calls.filter((c) => c.url.includes(CHAT))).toHaveLength(2);
  });

  it("abort between rounds persists partial with tool records", async () => {
    let n = 0;
    const first = streamResponse();
    first.pushText("So slowly");
    first.pushPayload({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "t0", function: { name: "mcp__ketch__search", arguments: "{}" } }] } }],
    });
    first.done();
    mock.route(CHAT, (_url, call) => {
      n += 1;
      if (n === 1) {
        first.attach(call.signal);
        return first.response;
      }
      // Second round: hang the request until the client aborts (in-flight abort).
      return new Promise<Response>((_, rej) => {
        call.signal?.addEventListener("abort", () => rej(new Error("aborted in flight")));
      });
    });
    const reqCtrl = new AbortController();
    const req = makeRequest({
      method: "POST",
      path: "/api/chat",
      cookie: user.cookie,
      json: { message: "hello" },
      signal: reqCtrl.signal,
    });
    setCurrentHeaders(req.headers);
    const res = await chatRoute.POST(req);
    const events = await readEvents(res, 4); // threadId, c, tool running, tool done
    expect(events.map((e) => Object.keys(e)[0])).toEqual(["threadId", "c", "tool", "tool"]);
    reqCtrl.abort();
    const rest = await readRest(res);
    expect(rest.at(-1)).toMatchObject({ done: true, aborted: true });

    const rows = db.select().from(messages).where(eq(messages.role, "assistant")).all();
    const meta = JSON.parse(rows[0].metaJson!) as { aborted: boolean; tools: unknown[] };
    expect(meta.aborted).toBe(true);
    expect(meta.tools).toHaveLength(1);
  });

  it("in-flight abort during a later round fetch persists the partial", async () => {
    let n = 0;
    const hangUntilAbort = (_url: URL, call: { signal?: AbortSignal | null }): Promise<Response> =>
      new Promise((_, rej) => call.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    mock.route(CHAT, (url, call) => {
      n += 1;
      if (n === 1)
        return new Response(
          [
            { choices: [{ delta: { content: "Hmm" } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "t0", function: { name: "mcp__ketch__search", arguments: "{}" } }] } }] },
            "[DONE]",
          ]
            .map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      return hangUntilAbort(url, call);
    });
    const reqCtrl = new AbortController();
    const req = makeRequest({
      method: "POST",
      path: "/api/chat",
      cookie: user.cookie,
      json: { message: "hello" },
      signal: reqCtrl.signal,
    });
    setCurrentHeaders(req.headers);
    const res = await chatRoute.POST(req);
    await readEvents(res, 3); // threadId, tool running, tool done
    await new Promise((r) => setTimeout(r, 30)); // round-2 fetch is now in flight
    reqCtrl.abort();
    const rest = await readRest(res);
    expect(rest.at(-1)).toMatchObject({ done: true, aborted: true });
    const rows = db.select().from(messages).where(eq(messages.role, "assistant")).all();
    expect(rows).toHaveLength(1);
    expect((JSON.parse(rows[0].metaJson!) as { aborted: boolean }).aborted).toBe(true);
  });

  it("abort while first fetch hangs: nothing to persist", async () => {
    mock.route(CHAT, (_url, call) => {
      void call.signal;
      return new Promise<Response>((_, rej) => call.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    });
    const reqCtrl = new AbortController();
    const req = makeRequest({
      method: "POST",
      path: "/api/chat",
      cookie: user.cookie,
      json: { message: "hello" },
      signal: reqCtrl.signal,
    });
    setCurrentHeaders(req.headers);
    const res = await chatRoute.POST(req);
    await readEvents(res, 1); // threadId only; upstream hangs
    reqCtrl.abort();
    await res.body?.cancel().catch(() => undefined);
    expect(db.select().from(messages).where(eq(messages.role, "assistant")).all()).toHaveLength(0);
  });

  it("skips round rebuild when no tools are offered", async () => {
    const threadId = crypto.randomUUID();
    db.insert(threads)
      .values({ id: threadId, userId: user.userId, model: "hist-model", title: "t", createdAt: new Date(), updatedAt: new Date() })
      .run();
    const toolMeta = JSON.stringify({
      model: "hist-model",
      tools: [{ server: "ketch", name: "search", ms: 1, ok: true, args: '{"q":"a"}', result: "RES" }],
    });
    db.insert(messages)
      .values([
        { id: crypto.randomUUID(), threadId, role: "user", content: "ask", createdAt: new Date() },
        { id: crypto.randomUUID(), threadId, role: "assistant", content: "Final", metaJson: toolMeta, createdAt: new Date() },
      ])
      .run();
    vi.mocked(buildToolset).mockResolvedValue(emptyToolset);
    mock.route(CHAT, () => sseCompletion("next"));
    await drain(await postChat({ threadId }));
    const msgs = upstreamBodies(mock)[0].messages;
    expect(msgs.some((m) => m.tool_calls || m.role === "tool")).toBe(false);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Final")).toBe(true);

    // With tools offered again, the stored rounds are rebuilt (calls+tool before
    // the assistant text; empty-content cutoff row is fully synthesized).
    db.insert(messages)
      .values({ id: crypto.randomUUID(), threadId, role: "assistant", content: "", metaJson: toolMeta, createdAt: new Date() })
      .run();
    vi.mocked(buildToolset).mockResolvedValue(toolset);
    await drain(await postChat({ threadId, message: "again" }));
    const msgs2 = upstreamBodies(mock)[1].messages;
    const seq = msgs2
      .filter((m) => m.tool_calls || m.role === "tool" || typeof m.content === "string")
      .map((m) =>
        m.tool_calls
          ? "calls"
          : m.role === "tool"
            ? "tool"
            : `content:${String(m.content).replace(/^\[\d{4}-\d{2}-\d{2}\] /, "")}`,
      );
    // ask, [calls,tool,Final], [calls,tool] (cutoff), again
    expect(seq).toEqual(["content:ask", "calls", "tool", "content:Final", "content:hello", "content:next", "calls", "tool", "content:again"]);
    const calls = msgs2.find((m) => m.tool_calls)!.tool_calls as { id: string; function: { name: string } }[];
    expect(calls[0]).toMatchObject({ function: { name: "mcp__ketch__search" } });
  });

  it("rebuilds stored tool rounds into upstream history (empty-content cutoff too)", async () => {
    const threadId = crypto.randomUUID();
    db.insert(threads)
      .values({ id: threadId, userId: user.userId, model: "hist-model", title: "t", createdAt: new Date(), updatedAt: new Date() })
      .run();
    const toolMeta = JSON.stringify({
      model: "hist-model",
      tools: [{ server: "ketch", name: "search", ms: 1, ok: true, args: '{"q":"a"}', result: "RES" }],
    });
    db.insert(messages)
      .values([
        { id: crypto.randomUUID(), threadId, role: "user", content: "ask", createdAt: new Date() },
        { id: crypto.randomUUID(), threadId, role: "assistant", content: "Final", metaJson: toolMeta, createdAt: new Date() },
        { id: crypto.randomUUID(), threadId, role: "assistant", content: "", metaJson: toolMeta, createdAt: new Date() },
      ])
      .run();
    vi.mocked(buildToolset).mockResolvedValue(emptyToolset);
    mock.route(CHAT, () => sseCompletion("next"));
    const events = await drain(await postChat({ threadId }));
    expect(events.at(-1)).toEqual({ done: true });

    const msgs = upstreamBodies(mock)[0].messages;
    const seq = msgs
      .filter((m) => m.tool_calls || m.role === "tool" || typeof m.content === "string")
      .map((m) =>
        m.tool_calls
          ? "calls"
          : m.role === "tool"
            ? "tool"
            : `content:${String(m.content).replace(/^\[\d{4}-\d{2}-\d{2}\] /, "")}`,
      );
    // Tools not offered (emptyToolset) ⇒ stored rounds are NOT rebuilt: plain
    // assistant texts only, so the chat template never re-arms tool tokens.
    expect(seq).toEqual(["content:ask", "content:Final", "content:", "content:hello"]);
    expect(msgs.some((m) => m.tool_calls || m.role === "tool")).toBe(false);
  });
});

describe("mcp loop helpers", () => {
  it("accumulator ignores garbage and nameless fragments", () => {
    const acc = createToolCallAccumulator();
    acc.feed("nope");
    acc.feed([{ index: 2 }, { index: 3, function: null }, { index: 4, function: "x" }]); // no usable function
    acc.feed([{ index: 1, function: { arguments: "{}" } }]); // no name → dropped
    acc.feed([null, 7]);
    acc.feed([{ function: { name: "solo" } }]); // no index → 0, id synthesized
    expect(acc.calls()).toEqual([
      { id: "call_0", type: "function", function: { name: "solo", arguments: "" } },
    ]);
  });

  it("parseToolRounds filters malformed rows", () => {
    expect(parseToolRounds(null)).toEqual([]);
    expect(parseToolRounds("not json")).toEqual([]);
    expect(parseToolRounds('{"tools":"x"}')).toEqual([]);
    expect(parseToolRounds('{"tools":[{"name":"x"}]}')).toEqual([]);
    expect(parseToolRounds('{"tools":[{"server":"s","name":"n","args":"{}","result":"r"}]}')).toHaveLength(1);
  });

  it("synthesizeToolMessages + expandToolRounds interleave", () => {
    const rounds = parseToolRounds(
      '{"tools":[{"server":"s","name":"n","args":"{}","result":"r"},{"server":"s","name":"m","args":"{}","result":"r2"}]}',
    );
    const syn = synthesizeToolMessages(rounds);
    expect(syn.map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
    expect(syn[2]).toMatchObject({ tool_call_id: "call_1", content: "r2" });

    const rows = [
      { role: "user", metaJson: null },
      { role: "assistant", metaJson: '{"tools":[]}' },
      { role: "assistant", metaJson: '{"nope":1}' },
    ];
    const up = rows.map((r) => ({ role: r.role, content: "x" }));
    expect(expandToolRounds(rows, up)).toEqual(up); // no rounds → untouched
  });

  it("dispatchToolCalls runs parallel and pairs ids", async () => {
    const { messages: msgs } = await dispatchToolCalls(
      [
        { id: "c1", type: "function", function: { name: "mcp__ketch__search", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "mcp__ketch__search", arguments: "{}" } },
      ],
      toolset.handles,
      () => undefined,
    );
    expect(msgs[0]).toMatchObject({ role: "assistant", content: null });
    expect(msgs.slice(1).map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
  });
});
