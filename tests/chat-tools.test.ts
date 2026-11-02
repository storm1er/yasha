import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as chatRoute from "@/app/api/chat/route";
import { killReplay } from "@/lib/chat/replay";
import { buildToolset, runToolCall, type ToolHandle } from "@/lib/mcp/bridge";
import {
  createToolCallAccumulator,
  createTurnParts,
  dispatchToolCalls,
  expandToolRounds,
  parseToolRounds,
  synthesizeToolMessages,
} from "@/lib/mcp/loop";
import { ensureReady } from "@/lib/db";
import { setUserMcpEnabled } from "@/lib/mcp/prefs";
import { db, setFastModel, setSetting } from "./support/db";
import { callRoute, sessionId, signUp, waitFor, type TestUser } from "./support/app";
import { v3Body } from "./support/v3";
import { mockLemonade, sseChatCompletion, streamResponse } from "./support/lemonade";
import { drainUi, uiData, uiErrorCode, uiText, uiThread, type UiChunk } from "./support/ui-stream";
import { jobs, messages, threads } from "@/lib/db/schema";

vi.mock("@/lib/mcp/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/bridge")>();
  return { ...actual, buildToolset: vi.fn(), runToolCall: vi.fn() };
});

const mockedBuild = vi.mocked(buildToolset);
const mockedRun = vi.mocked(runToolCall);

let user: TestUser & { userId: string };

let modelSeq = 0;

beforeAll(async () => {
  await ensureReady();
  const u = await signUp("toolsuser");
  user = Object.assign(u, { userId: await sessionId(u.cookie) });
});

const toolset = (n = 1) => ({
  specs: Array.from({ length: n }, (_, i) => ({
    type: "function" as const,
    function: {
      name: `mcp__ketch__search${i > 0 ? `_${i + 1}` : ""}`,
      description: "ketch: search",
      parameters: { type: "object", additionalProperties: true },
    },
  })),
  handles: new Map<string, ToolHandle>(
    Array.from({ length: n }, (_, i) => [
      `mcp__ketch__search${i > 0 ? `_${i + 1}` : ""}`,
      { serverId: "ketch", tool: `search${i > 0 ? `_${i + 1}` : ""}`, title: "search", userId: user.userId },
    ])
  ),
});

/** Realistic OpenAI stream that requests ONE tool call (SDK parser needs the
 *  chunk envelope + finish_reason — M0 spike finding). */
function sseToolCalls(id: string, name: string, args: string): Response {
  const env = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
  const line = (p: Record<string, unknown>) => `data: ${JSON.stringify({ ...env, ...p })}\n\n`;
  return new Response(
    line({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] },
        },
      ],
    }) +
      line({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  );
}

function sseText(text: string): Response {
  return sseChatCompletion(text);
}

/** The tool chip events (data-tool parts) in arrival order. */
const toolEvents = (chunks: UiChunk[]) => uiData<Record<string, unknown>>(chunks, "data-tool");

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  db.delete(messages).run();
  db.delete(threads).run();
  db.delete(jobs).run();
  // Unique model id per test: the capability-degradation set is module state.
  setFastModel(`tool-model-${Date.now()}-${modelSeq++}`);
  setSetting("mcp.enabled", "true");
  setSetting("mcp.maxToolRounds", "4");
  mockedBuild.mockReset();
  mockedRun.mockReset();
  mockedBuild.mockResolvedValue(toolset());
  mockedRun.mockResolvedValue({ content: "RESULT", ok: true, ms: 5 });
  setUserMcpEnabled(user.userId, null);
});

afterEach(() => {
  setUserMcpEnabled(user.userId, null);
});

async function post(json: Record<string, unknown>) {
  return callRoute(chatRoute.POST, {
    method: "POST",
    path: "/api/chat",
    cookie: user.cookie,
    json: v3Body({ message: "hi", ...json }),
  });
}

/** Read UI chunks (data frames only) until `n` arrived. */
async function readUi(res: Response, n: number): Promise<UiChunk[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let leftover = "";
  const out: UiChunk[] = [];
  while (out.length < n) {
    const { done, value } = await reader.read();
    if (done) break;
    const frames = (leftover + dec.decode(value, { stream: true })).split("\n\n");
    leftover = frames.pop() ?? "";
    for (const f of frames) {
      const payload = f.startsWith("data:") ? f.slice(f.indexOf(":") + 1).trim() : "";
      if (payload && payload !== "[DONE]") out.push(JSON.parse(payload) as UiChunk);
    }
  }
  reader.releaseLock();
  return out;
}

/** Drain the remaining body (until the stream closes) via the reader. */
async function readRest(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

describe("chat loop (MCP tools → AI SDK rounds)", () => {
  it("no round-trip without toolset", async () => {
    mockedBuild.mockResolvedValue(toolset(0));
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseText("plain answer"));
    // interactive:false — the tool-free assertion is about the whole tool
    // surface (MCP AND interactive asks); see chat-interactive tests for the
    // interactive-on behavior.
    const res = await post({ message: "hello", interactive: false });
    const chunks = await drainUi(res);
    expect(uiText(chunks)).toBe("plain answer");
    expect(toolEvents(chunks)).toEqual([]);
    expect(mock.calls).toHaveLength(1);
    // No tool definitions sent
    const body = JSON.parse(mock.lastCall("/v1/chat/completions")!.body!) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });

  it("one round-trip: event to client, result back to model, persisted meta", async () => {
    mockedBuild.mockResolvedValue(toolset());
    mockedRun.mockResolvedValue({ content: "search results here", ok: true, ms: 42 });
    const mock = mockLemonade();
    let n = 0;
    mock.route("/v1/chat/completions", () => (++n === 1 ? sseToolCalls("t0", "mcp__ketch__search", '{"q":"x"}') : sseText("FINAL")));
    const res = await post({ message: "search x" });
    const chunks = await drainUi(res);
    const events = toolEvents(chunks);
    expect(events).toHaveLength(2); // running, done
    expect(events[0]).toMatchObject({ server: "ketch", name: "search", status: "running", args: '{"q":"x"}' });
    expect(events[1]).toMatchObject({
      status: "done",
      result: "search results here",
      ms: 42,
      args: '{"q":"x"}', // raw arguments string rides on the terminal event too
    });
    expect(uiText(chunks)).toBe("FINAL");
    // second request carries the tool result with the SAME id the client saw
    // (the compat provider re-serializes to OpenAI wire format on the way out)
    const bodies = mock.bodies("/v1/chat/completions") as {
      messages: { role: string; content: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
    }[];
    const tail = bodies[1].messages.slice(-2);
    expect(tail[0]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "t0", function: { name: "mcp__ketch__search", arguments: '{"q":"x"}' } }],
    });
    expect(tail[1]).toMatchObject({ role: "tool", tool_call_id: "t0", content: "search results here" });
    // dispatched through the bridge with the raw args
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0][1]).toBe('{"q":"x"}');
    // assistant meta carries the round
    const threadId = uiThread(chunks);
    const asst = db
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant")))
      .get();
    const meta = JSON.parse(asst!.metaJson!) as { tools: unknown[] };
    expect(meta.tools).toEqual([
      { server: "ketch", name: "search", ms: 42, ok: true, args: '{"q":"x"}', result: "search results here" },
    ]);
  });

  it("parallel calls in one round: all dispatched (incl. unknown name = no chip, no round)", async () => {
    mockedBuild.mockResolvedValue(toolset(2));
    mockedRun.mockResolvedValue({ content: "ok", ok: true, ms: 5 });
    const mock = mockLemonade();
    let n = 0;
    mock.route("/v1/chat/completions", () => {
      n += 1;
      if (n === 1) {
        const env = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
        const line = (p: Record<string, unknown>) => `data: ${JSON.stringify({ ...env, ...p })}\n\n`;
        return new Response(
          line({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "a", type: "function", function: { name: "mcp__ketch__search", arguments: "{}" } },
                    { index: 1, id: "b", type: "function", function: { name: "mcp__ketch__search_2", arguments: "{}" } },
                    { index: 2, id: "c", type: "function", function: { name: "mcp__ghost__x", arguments: "{}" } },
                  ],
                },
              },
            ],
          }) +
            line({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } }
        );
      }
      return sseText("done");
    });
    const res = await post({ message: "go" });
    const chunks = await drainUi(res);
    // accepted calls run; the unknown name becomes an SDK tool-error fed back
    // to the model (no chip event, no persisted record) — M2 divergence.
    expect(mockedRun).toHaveBeenCalledTimes(2);
    const bodies = mock.bodies("/v1/chat/completions") as { messages: { role: string }[] }[];
    const toolMsgs = bodies[1].messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3); // two results + the unknown-tool error
    const asst = db
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, uiThread(chunks)), eq(messages.role, "assistant")))
      .get();
    const meta = JSON.parse(asst!.metaJson!) as { tools: { name: string }[] };
    expect(meta.tools.map((t) => t.name)).toEqual(["search", "search_2"]);
    // Divergence (M2, accepted): unknown tool names are handled by the SDK
    // (error result to the model); no chip event, no persisted record.
    const chipNames = toolEvents(chunks)
      .map((e) => `${e.name}:${e.status}`)
      .sort();
    expect(chipNames).toEqual(["search:done", "search:running", "search_2:done", "search_2:running"]);
  });

  it("tool result content is passed to the model as-is", async () => {
    mockedBuild.mockResolvedValue(toolset());
    mockedRun.mockResolvedValue({ content: "x".repeat(70000), ok: true, ms: 3 });
    const mock = mockLemonade();
    let n = 0;
    mock.route("/v1/chat/completions", () => (++n === 1 ? sseToolCalls("t0", "mcp__ketch__search", "{}") : sseText("ok")));
    await drainUi(await post({ message: "go" }));
    const bodies = mock.bodies("/v1/chat/completions") as {
      messages: { role: string; content: unknown }[];
    }[];
    const toolMsg = bodies[1].messages.find((m) => m.role === "tool");
    expect(String(toolMsg!.content).length).toBe(70000);
  });

  it("tool call arguments are parsed for the model AND the raw text is persisted", async () => {
    mockedBuild.mockResolvedValue(toolset());
    mockedRun.mockResolvedValue({ content: "ok", ok: true, ms: 1 });
    const mock = mockLemonade();
    let n = 0;
    mock.route("/v1/chat/completions", () =>
      ++n === 1 ? sseToolCalls("t0", "mcp__ketch__search", '{ "q" : "x" }') : sseText("fin")
    );
    await drainUi(await post({ message: "go" }));
    // history sent to the model: the SDK re-serializes the parsed input on the
    // wire; what we persist is the raw model text
    const bodies = mock.bodies("/v1/chat/completions") as {
      messages: { role: string; tool_calls?: { function: { arguments: string } }[] }[];
    }[];
    const call = bodies[1].messages.find((m) => m.role === "assistant")!.tool_calls![0];
    expect(JSON.parse(call.function.arguments)).toEqual({ q: "x" });
    const asst = db
      .select()
      .from(messages)
      .where(eq(messages.role, "assistant"))
      .get();
    expect(JSON.parse(asst!.metaJson!).tools[0].args).toBe('{ "q" : "x" }');
  });

  it("stops after maxToolRounds (budget guard: no more dispatches)", async () => {
    setSetting("mcp.maxToolRounds", "1");
    mockedBuild.mockResolvedValue(toolset());
    mockedRun.mockResolvedValue({ content: "r", ok: true, ms: 1 });
    const mock = mockLemonade();
    let n = 0;
    mock.route("/v1/chat/completions", () => {
      n += 1;
      return sseToolCalls(`t${n}`, "mcp__ketch__search", "{}"); // model always wants to call
    });
    const res = await post({ message: "go" });
    const chunks = await drainUi(res);
    // 2 upstream calls (round + final answering call), only 1 dispatch: the
    // budget guard discards further executions (same as v1's round cap).
    await waitFor(() => mock.calls.filter((c) => c.url.includes("/v1/chat/completions")).length === 2);
    await delay(50);
    expect(mock.calls.filter((c) => c.url.includes("/v1/chat/completions")).length).toBe(2);
    expect(mockedRun).toHaveBeenCalledTimes(1);
    // no text ever → failed turn marked on the user message
    expect(uiErrorCode(chunks)).toBe("empty_response");
  });

  it("MCP disabled by settings: no tools at all", async () => {
    setSetting("mcp.enabled", "false");
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseText("plain"));
    const res = await post({ message: "go", interactive: false });
    expect(uiText(await drainUi(res))).toBe("plain");
    expect(mockedBuild).not.toHaveBeenCalled();
    const body = JSON.parse(mock.lastCall("/v1/chat/completions")!.body!) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    setSetting("mcp.enabled", "true");
  });

  it("per-user opt-out suppresses tool injection; history is not re-armed", async () => {
    setSetting("chat.windowMessages", "10");
    setUserMcpEnabled(user.userId, false);
    const t = Date.now();
    db.insert(threads)
      .values({ id: "th-mcpoff", userId: user.userId, model: "fast-model.test", title: "x", createdAt: new Date(t), updatedAt: new Date(t) })
      .run();
    db.insert(messages)
      .values({
        id: "u1",
        threadId: "th-mcpoff",
        role: "user",
        content: "hello",
        createdAt: new Date(t + 1),
      })
      .run();
    db.insert(messages)
      .values({
        id: "a1",
        threadId: "th-mcpoff",
        role: "assistant",
        content: "Tokyo",
        metaJson: JSON.stringify({
          model: "m",
          tools: [{ server: "ketch", name: "search", ms: 5, ok: true, args: "{}", result: "capital" }],
        }),
        createdAt: new Date(t + 2),
      })
      .run();
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseText("replied"));
    const res = await post({ threadId: "th-mcpoff", message: "again", interactive: false });
    expect(uiText(await drainUi(res))).toBe("replied");
    expect(mockedBuild).not.toHaveBeenCalled();
    const body = JSON.parse(mock.lastCall("/v1/chat/completions")!.body!) as {
      tools?: unknown;
      messages: { role: string; content: unknown; tool_calls?: unknown }[];
    };
    expect(body.tools).toBeUndefined();
    // A thread with a past tool turn must NOT re-arm tool tokens while opted
    // out (route skips expandToolRounds when no toolset is attached).
    expect(body.messages.some((m) => m.role === "tool" || m.tool_calls !== undefined)).toBe(false);
    expect(body.messages.some((m) => m.role === "assistant" && m.content === "Tokyo")).toBe(true);
  });

  it("interleaved text+tool rounds persisted in execution order (issue #7)", async () => {
    mockedBuild.mockResolvedValue(toolset());
    mockedRun.mockResolvedValue({ content: "r1", ok: true, ms: 2 });
    const env = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
    const line = (p: Record<string, unknown>) => `data: ${JSON.stringify({ ...env, ...p })}\n\n`;
    const interleaved = (callId: string, text: string) =>
      new Response(
        line({ choices: [{ index: 0, delta: { content: text } }] }) +
          line({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "mcp__ketch__search", arguments: "{}" } }],
                },
              },
            ],
          }) +
          line({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    const mock = mockLemonade();
    let n = 0;
    mock.route("/v1/chat/completions", () => {
      n += 1;
      if (n === 1) return interleaved("t0", "thinking about x ");
      if (n === 2) return interleaved("t1", "then about y ");
      return sseText("at the end z");
    });
    const res = await post({ message: "go" });
    const chunks = await drainUi(res);
    expect(uiText(chunks)).toBe("thinking about x then about y at the end z");
    const threadId = uiThread(chunks);
    const asst = db
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant")))
      .get();
    const meta = JSON.parse(asst!.metaJson!) as { tools: unknown[]; parts: unknown[] };
    expect(meta.tools).toHaveLength(2);
    expect(meta.parts).toEqual([
      { type: "text", text: "thinking about x " },
      { type: "tools", count: 1 },
      { type: "text", text: "then about y " },
      { type: "tools", count: 1 },
      { type: "text", text: "at the end z" },
    ]);
  });

  it("4xx with tools → retry WITHOUT tools (capability degradation)", async () => {
    mockedBuild.mockResolvedValue(toolset());
    const mock = mockLemonade();
    let n = 0;
    mock.route("/v1/chat/completions", (url, call) => {
      n += 1;
      const body = JSON.parse(call.body!) as { tools?: unknown };
      if (n === 1) {
        expect(body.tools).toBeDefined();
        return new Response(JSON.stringify({ error: { message: "tool_choice not supported" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      expect(body.tools).toBeUndefined(); // retry must not include tools
      return sseText("text-only answer");
    });
    const res = await post({ message: "go" });
    const chunks = await drainUi(res);
    expect(uiText(chunks)).toBe("text-only answer");
    expect(uiErrorCode(chunks)).toBeUndefined();
    expect(n).toBe(2);
    // the model is remembered: a second chat turn sends NO tools from the start
    const res2 = await post({ message: "go again" });
    await drainUi(res2);
    expect(((mock.bodies("/v1/chat/completions").at(-1) ?? {}) as { tools?: unknown }).tools).toBeUndefined();
  });

  it("400 persists twice → error surfaces (one retry max)", async () => {
    mockedBuild.mockResolvedValue(toolset());
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => new Response("nope", { status: 400 }));
    const res = await post({ message: "go" });
    const chunks = await drainUi(res);
    expect(uiErrorCode(chunks)).toBe("upstream_status_400");
    expect(mock.calls.filter((c) => c.url.includes("/v1/chat/completions"))).toHaveLength(2);
  });

  it("400 recovery mid-session: later turns skip injection", async () => {
    mockedBuild.mockResolvedValue(toolset());
    const mock = mockLemonade();
    let n = 0;
    mock.route("/v1/chat/completions", (_url, call) => {
      n += 1;
      const tools = (JSON.parse(call.body!) as { tools?: unknown[] }).tools;
      if (n === 1) {
        expect(tools).toBeDefined();
        return new Response("bad", { status: 400 });
      }
      // attempt 2 (no tools) succeeds; turn 2 must never re-attach tools
      return sseText(`ok ${n}`);
    });
    expect(uiText(await drainUi(await post({ message: "first" })))).toBe("ok 2");
    const chunks2 = await drainUi(await post({ message: "second" }));
    expect(uiText(chunks2)).toBe("ok 3");
    const lastBody = mock.bodies("/v1/chat/completions").at(-1) as { tools?: unknown[] };
    expect(lastBody.tools).toBeUndefined();
  });

  it("tool loop survives an explicit stop between rounds: partial assistant persisted with tool records", async () => {
    mockedBuild.mockResolvedValue(toolset());
    mockedRun.mockResolvedValue({ content: "r1", ok: true, ms: 2 });
    const mock = mockLemonade();
    let n = 0;
    const first = streamResponse();
    first.pushText("So slowly");
    first.pushPayload({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "t0", type: "function", function: { name: "mcp__ketch__search", arguments: "{}" } }] },
        },
      ],
    });
    first.pushPayload({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    first.done();
    mock.route("/v1/chat/completions", (_url, call) => {
      n += 1;
      if (n === 1) {
        first.attach(call.signal);
        return first.response;
      }
      // Round 2 hangs until the stop route aborts (the fetch signal fires).
      return new Promise((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => reject(new Error("aborted in flight")));
      });
    });
    const res = await callRoute(chatRoute.POST, {
      method: "POST",
      path: "/api/chat",
      cookie: user.cookie,
      json: v3Body({ message: "go" }),
    });
    const chunks = await readUi(res, 7); // data-thread, start-step, text*, tool running, tool done
    expect(chunks.map((c) => c.type)).toEqual([
      "data-thread",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "data-tool",
      "data-tool",
    ]);
    // Issue #33: disconnecting is not a stop — the turn must be killed
    // explicitly. A SYNCHRONOUS hub kill (same timing the old client-abort had):
    // it lands between the tool execution and the step-end bookkeeping, so the
    // partial row keeps the round via the flushRemaining drain.
    expect(killReplay(user.userId, uiThread(chunks))).toBe(true);
    await readRest(res);
    const threadId = uiThread(chunks);
    await waitFor(() =>
      db
        .select()
        .from(messages)
        .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant")))
        .all().length === 1
    );
    const asst = db
      .select()
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant")))
      .get();
    const meta = JSON.parse(asst!.metaJson!) as { aborted?: boolean; tools: unknown[]; parts: unknown[] };
    expect(meta.aborted).toBe(true);
    expect(meta.tools).toHaveLength(1);
    expect(meta.parts).toEqual([{ type: "text", text: "So slowly" }, { type: "tools", count: 1 }]);
  });

  it("tools are NOT injected when no MCP servers are enabled (toolset empty)", async () => {
    mockedBuild.mockResolvedValue(toolset(0));
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseText("x"));
    await drainUi(await post({ message: "hi", interactive: false }));
    const body = JSON.parse(mock.lastCall("/v1/chat/completions")!.body!) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("tool definitions + tool_choice ride on the request body", async () => {
    mockedBuild.mockResolvedValue(toolset());
    const mock = mockLemonade();
    let n = 0;
    mock.route("/v1/chat/completions", () => (++n === 1 ? sseToolCalls("t0", "mcp__ketch__search", "{}") : sseText("y")));
    mockedRun.mockResolvedValue({ content: "r", ok: true, ms: 1 });
    await drainUi(await post({ message: "hi" }));
    const bodies = mock.bodies("/v1/chat/completions") as {
      tools?: { type: string; function: { name: string } }[];
      tool_choice?: string;
    }[];
    const withTools = bodies[0];
    // toolChoice "auto" is the wire default — the SDK omits it when unset
    expect(withTools.tool_choice ?? "auto").toBe("auto");
    // Interactive asks ride along (interactive defaults to true) with the
    // generative-UI tool; MCP defs keep their prefixed names.
    expect(withTools.tools?.map((t) => t.function.name)).toEqual([
      "mcp__ketch__search",
      "ask_choice",
      "confirm_action",
      "render_ui",
    ]);
    expect(withTools.tools?.[0]).toMatchObject({ type: "function", function: { name: "mcp__ketch__search" } });
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

  it("accumulator merges fragmented deltas (interleaved by index)", () => {
    const acc = createToolCallAccumulator();
    acc.feed([
      { index: 0, id: "a", function: { name: "x", arguments: '{"q' } },
      { index: 1, id: "b", function: { name: "y", arguments: "{}" } },
    ]);
    acc.feed([{ index: 0, function: { arguments: '":1}' } }]);
    const calls = acc.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ id: "a", type: "function", function: { name: "x", arguments: '{"q":1}' } });
  });

  it("createTurnParts interleaves text with tool rounds", () => {
    const t = createTurnParts();
    expect(t.parts()).toBeUndefined(); // no round dispatched → no ordering meta
    t.onText("a");
    expect(t.parts()).toBeUndefined();
    t.onToolRound(2);
    expect(t.parts()).toEqual([
      { type: "text", text: "a" },
      { type: "tools", count: 2 },
    ]);
    t.onToolRound(1); // back-to-back rounds: no empty text part between them
    t.onText("b");
    expect(t.parts()).toEqual([
      { type: "text", text: "a" },
      { type: "tools", count: 2 },
      { type: "tools", count: 1 },
      { type: "text", text: "b" },
    ]);
  });

  it("createTurnParts interleaves cards (issue #28)", () => {
    const t = createTurnParts();
    t.onCard(); // card with no surrounding text: parts open with the card
    t.onText("after");
    expect(t.parts()).toEqual([{ type: "card" }, { type: "text", text: "after" }]);
    t.onToolRound(1);
    expect(t.parts()).toEqual([
      { type: "card" },
      { type: "text", text: "after" },
      { type: "tools", count: 1 },
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
    expect(expandToolRounds(rows, up, { mcp: true, client: true })).toEqual(up); // no rounds → untouched
  });

  it("dispatchToolCalls runs parallel and pairs ids", async () => {
    mockedRun.mockResolvedValue({ content: "ok", ok: true, ms: 1 });
    const { messages: msgs } = await dispatchToolCalls(
      [
        { id: "c1", type: "function", function: { name: "mcp__ketch__search", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "mcp__ketch__search", arguments: "{}" } },
      ],
      toolset().handles,
      () => undefined
    );
    expect(msgs[0]).toMatchObject({ role: "assistant", content: null });
    expect(msgs.slice(1).map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
  });

  it("dispatchToolCalls: unknown names error without hitting the bridge", async () => {
    const events: unknown[] = [];
    const { messages, records } = await dispatchToolCalls(
      [{ id: "1", type: "function", function: { name: "ghost", arguments: "{}" } }],
      toolset().handles,
      (e) => events.push(e)
    );
    expect(mockedRun).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: false, server: "?" });
    expect(String(messages[1]!.content)).toContain("unknown tool");
  });

  it("dispatchToolCalls: truncated → flag on record AND event (issue #8)", async () => {
    mockedRun.mockResolvedValue({ content: "cut", ok: true, ms: 4, truncated: true });
    const events: Record<string, unknown>[] = [];
    const { records } = await dispatchToolCalls(
      [{ id: "1", type: "function", function: { name: "mcp__ketch__search", arguments: "{}" } }],
      toolset().handles,
      (e) => events.push(e as Record<string, unknown>)
    );
    expect(records[0]).toMatchObject({ ok: true, truncated: true });
    expect(events[1]).toMatchObject({ status: "done", truncated: true });
    // not-truncated running event: key absent (byte-stable unchanged turns)
    expect(events[0].truncated).toBeUndefined();
  });

  it("expandToolRounds filter: undeclared kinds stay out; client records keep bare names", () => {
    const mcpMeta = JSON.stringify({ tools: [{ server: "k", name: "t", args: "{}", result: "R" }] });
    const clientMeta = JSON.stringify({
      tools: [{ server: "yasha", name: "ask_choice", args: '{"question":"q"}', result: "no", client: true, callId: "c1" }],
    });
    const rows = [
      { role: "assistant", metaJson: mcpMeta },
      { role: "assistant", metaJson: clientMeta },
    ];
    const up = [
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
    ];
    // MCP declared, interactive not → client records stay out.
    let out = expandToolRounds(rows as never, up as never, { mcp: true, client: false });
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "assistant"]);
    // Interactive declared, MCP not → only the client record re-arms, under
    // its BARE declared name (the live tool set declares exactly ask_choice).
    out = expandToolRounds(rows as never, up as never, { mcp: false, client: true });
    expect(out.map((m) => m.role)).toEqual(["assistant", "assistant", "tool", "assistant"]);
    expect(out[1].tool_calls![0]).toMatchObject({ function: { name: "ask_choice" } });
  });

  it("expandToolRounds splices synthesized rounds; cutoff turns drop empty text", () => {    const meta = JSON.stringify({ tools: [{ server: "k", name: "t", args: "{}", result: "R" }] });
    const rows = [
      { role: "user", metaJson: null },
      { role: "assistant", metaJson: meta }, // answered round
      { role: "assistant", metaJson: meta }, // tool-cutoff (empty final text)
      { role: "assistant", metaJson: meta }, // parts-shaped content stays (not "" string)
    ];
    const up = [
      { role: "user", content: "q" },
      { role: "assistant", content: "answer" },
      { role: "assistant", content: "" },
      { role: "assistant", content: null },
    ];
    const out = expandToolRounds(rows as never, up as never, { mcp: true, client: true });
    expect(out.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(out[1].tool_calls![0]).toMatchObject({ type: "function", function: { arguments: "{}" } });
    expect(out[2]).toMatchObject({ tool_call_id: "call_0", content: "R" });
    expect(out[3]).toMatchObject({ content: "answer" }); // final text rides after the exchange
    expect(out[8]).toMatchObject({ content: null }); // non-string content untouched
  });
});
