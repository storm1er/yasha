import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as v1Chat from "@/app/v1/chat/completions/route";
import { buildToolset, runToolCall, type ToolHandle } from "@/lib/mcp/bridge";
import { ensureReady } from "@/lib/db";
import { db, setSetting } from "./support/db";
import { invalidateSettingsCache } from "@/lib/settings";
import { memories } from "@/lib/db/schema";
import { makeRequest, sessionId, signUp, type TestUser } from "./support/app";
import { json, mockLemonade, modelsResponse, sseCompletion, type LemonadeMock } from "./support/lemonade";
import { createKey } from "@/lib/api-keys";
import { releaseGeneration } from "@/lib/provider/gate";
import { setUserMemoryEnabled } from "@/lib/memory/prefs";
import { setUserMcpEnabled } from "@/lib/mcp/prefs";

vi.mock("@/lib/mcp/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/bridge")>();
  return { ...actual, buildToolset: vi.fn(), runToolCall: vi.fn() };
});

let user: TestUser & { userId: string };
let auth: string;
let mock: LemonadeMock;
let modelSeq = 0;

const CHAT = "/v1/chat/completions";

const toolset = {
  specs: [{ type: "function" as const, function: { name: "mcp__ketch__search", description: "d", parameters: {} } }],
  handles: new Map<string, ToolHandle>([
    ["mcp__ketch__search", { serverId: "ketch", tool: "search", title: "ketch: search", userId: "u1" }],
  ]),
};

function sseToolCalls(name: string, args = "{}"): Response {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t0", function: { name, arguments: args } }] } }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function jsonToolCalls(name: string, args = "{}"): Response {
  return json({
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t0", function: { name, arguments: args } }] } }],
    usage: { total_tokens: 1 },
  });
}

function post(jsonBody: Record<string, unknown>, authorization = auth) {
  // fresh model id per request batch avoids cross-test no-tool-support memo bleed
  const model = jsonBody.model ?? `default:v1-model-${modelSeq}.test`; // canonical request id
  const req = makeRequest({
    method: "POST",
    path: "/v1/chat/completions",
    headers: { authorization },
    json: { model, messages: [{ role: "user", content: "hi" }], ...jsonBody },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return v1Chat.POST(req as any);
}

function bodies() {
  return mock.bodies(CHAT) as {
    messages: Record<string, unknown>[];
    tools?: unknown[];
    tool_choice?: string;
    memory?: unknown;
  }[];
}

beforeAll(async () => {
  await ensureReady();
  user = Object.assign(await signUp("v1tools"), { userId: "" });
  user.userId = await sessionId(user.cookie);
  const created = await createKey(user.userId, "v1t");
  auth = `Bearer ${created.key}`;
});

beforeEach(() => {
  releaseGeneration(user.userId);
  db.delete(memories).run();
  modelSeq += 1;
  setSetting("mcp.enabled", "true");
  setSetting("mcp.maxToolRounds", "4");
  setSetting("api.maxTokensDefault", "512");
  setSetting("api.maxTokensCap", "1024");
  setSetting("api.firstTokenTimeoutMs", "30000");
  setUserMemoryEnabled(user.userId, null);
  invalidateSettingsCache();
  vi.mocked(buildToolset).mockResolvedValue(toolset);
  vi.mocked(runToolCall).mockResolvedValue({ content: "RESULT", ok: true, ms: 3 });
  mock = mockLemonade();
  // superset list: the module-level 60s models cache may hold an earlier
  // response, so every model id any test might use must be in it
  mock.route("/v1/models", () =>
    modelsResponse(
      Array.from({ length: 200 }, (_, i) => ({ id: `v1-model-${i}.test` })).concat({ id: "v1-model.test" }),
    ),
  );
});

afterEach(() => {
  releaseGeneration(user.userId);
  vi.clearAllMocks();
});

describe("v1 memory injection", () => {
  it("injects the key owner's memory block", async () => {
    const t = Date.now();
    db.insert(memories)
      .values({ id: "m1", userId: user.userId, kind: "fact", text: "loves trains", source: "derived", pinned: false, createdAt: new Date(t), updatedAt: new Date(t) })
      .run();
    mock.route(CHAT, () => sseCompletion("ok"));
    const res = await post({ stream: true });
    expect(res.status).toBe(200);
    await res.text();
    const sys = bodies()[0].messages[0];
    expect(sys.role).toBe("system");
    expect(String(sys.content)).toContain("loves trains");
  });

  it('"memory": false opts out and is stripped from upstream', async () => {
    const t = Date.now();
    db.insert(memories)
      .values({ id: "m2", userId: user.userId, kind: "fact", text: "loves trains", source: "derived", pinned: false, createdAt: new Date(t), updatedAt: new Date(t) })
      .run();
    mock.route(CHAT, () => sseCompletion("ok"));
    await (await post({ stream: true, memory: false })).text();
    const sent = bodies()[0];
    expect(sent.messages.some((m) => m.role === "system")).toBe(false);
    expect(sent.memory).toBeUndefined();
  });

  it("respects the per-user memory override", async () => {
    setUserMemoryEnabled(user.userId, false);
    const t = Date.now();
    db.insert(memories)
      .values({ id: "m3", userId: user.userId, kind: "fact", text: "loves trains", source: "derived", pinned: false, createdAt: new Date(t), updatedAt: new Date(t) })
      .run();
    mock.route(CHAT, () => sseCompletion("ok"));
    await (await post({ stream: true })).text();
    expect(bodies()[0].messages.some((m) => m.role === "system")).toBe(false);
  });

  it("system-only conversation: no memory block", async () => {
    const t = Date.now();
    db.insert(memories)
      .values({ id: "m4", userId: user.userId, kind: "fact", text: "loves trains", source: "derived", pinned: false, createdAt: new Date(t), updatedAt: new Date(t) })
      .run();
    mock.route(CHAT, () => sseCompletion("ok"));
    await (await post({ stream: true, messages: [{ role: "system", content: "be nice" }] })).text();
    expect(bodies()[0].messages).toHaveLength(1);
  });
});

describe("v1 server-side tools", () => {
  it("per-user opt-out suppresses tool injection", async () => {
    setUserMcpEnabled(user.userId, false);
    try {
      mock.route(CHAT, () => sseCompletion("plain"));
      const res = await post({ stream: true });
      await res.text();
      expect(bodies()[0].tools).toBeUndefined();
    } finally {
      setUserMcpEnabled(user.userId, null);
    }
  });

  it("client-supplied tools pass through untouched (no injection)", async () => {
    const clientTool = { type: "function", function: { name: "my_tool" } };
    mock.route(CHAT, () => sseCompletion("ok"));
    await (await post({ stream: true, tools: [clientTool] })).text();
    const sent = bodies()[0];
    expect(sent.tools).toEqual([clientTool]);
    expect(sent.tool_choice).toBeUndefined();
    expect(vi.mocked(buildToolset)).not.toHaveBeenCalled();
  });

  it("streaming: consumes tool round server-side, forwards only content + one DONE", async () => {
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      if (n === 1)
        return new Response(
          [
            { choices: [{ delta: { content: "thinking" } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "t0", function: { name: "mcp__ketch__search", arguments: '{"q":"a"}' } }] } }] },
            "[DONE]",
          ]
            .map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      return sseCompletion("final answer");
    });
    const res = await post({ stream: true });
    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)) as { choices?: { delta?: Record<string, unknown> }[] });
    const all = JSON.stringify(events);
    expect(all).not.toContain("tool_calls");
    expect(all).toContain("final answer");
    expect((text.match(/data: \[DONE\]/g) ?? [])).toHaveLength(1);

    const sent2 = bodies()[1];
    expect(sent2.tool_choice).toBe("auto");
    const tail = sent2.messages.slice(-2);
    expect(tail[0]).toMatchObject({ role: "assistant", tool_calls: [{ id: "t0" }] });
    expect(tail[1]).toMatchObject({ role: "tool", tool_call_id: "t0", content: "RESULT" });
  });

  it("non-streaming: runs the loop and returns the final completion", async () => {
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      if (n === 1) return jsonToolCalls("mcp__ketch__search", "{}");
      return json({ choices: [{ message: { role: "assistant", content: "done" } }], usage: {} });
    });
    const res = await post({ stream: false });
    const out = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(out.choices[0].message.content).toBe("done");
    expect(bodies()[1].messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("stops at mcp.maxToolRounds (final tool_calls returned as-is)", async () => {
    setSetting("mcp.maxToolRounds", "1");
    mock.route(CHAT, () => jsonToolCalls("mcp__ketch__search"));
    const res = await post({ stream: false });
    const out = (await res.json()) as { choices: { message: { tool_calls?: unknown[] } }[] };
    expect(out.choices[0].message.tool_calls).toHaveLength(1);
    expect(mock.calls.filter((c) => c.url.includes(CHAT))).toHaveLength(2);
  });

  it("unknown tool name still produces an error tool result", async () => {
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      return n === 1 ? jsonToolCalls("mcp__ghost__x") : json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    });
    const res = await post({ stream: false });
    expect(((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe("ok");
    const toolMsg = bodies()[1].messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("unknown tool");
    expect(vi.mocked(runToolCall)).not.toHaveBeenCalled();
  });

  it("tool error result is fed back to the model", async () => {
    vi.mocked(runToolCall).mockResolvedValue({ content: "tool error: boom", ok: false, ms: 1 });
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      return n === 1 ? sseToolCalls("mcp__ketch__search") : sseCompletion("recovered");
    });
    const res = await post({ stream: true });
    expect(await res.text()).toContain("recovered");
    const toolMsg = bodies()[1].messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("tool error: boom");
  });

  it("4xx with tools → silent retry + model memoized", async () => {
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      if (n === 1) return json({ error: "no tools" }, 400);
      return json({ choices: [{ message: { role: "assistant", content: "plain" } }] });
    });
    const res = await post({ stream: false });
    expect(((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe("plain");
    const b = bodies();
    expect(b[0].tools).toBeDefined();
    expect(b[1].tools).toBeUndefined();

    await post({ stream: false }); // same model → buildToolset skipped from now on
    expect(vi.mocked(buildToolset)).toHaveBeenCalledTimes(1);
  });

  it("4xx twice → 502 upstream_error", async () => {
    mock.route(CHAT, () => json({ error: "nope" }, 400));
    const res = await post({ stream: false });
    expect(res.status).toBe(502);
    expect(mock.calls.filter((c) => c.url.includes(CHAT))).toHaveLength(2);
  });

  it("streaming round-2 upstream failure → error event, no DONE", async () => {
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      if (n === 1) return sseToolCalls("mcp__ketch__search");
      return json({ error: "boom" }, 500);
    });
    const res = await post({ stream: true });
    const text = await res.text();
    expect(text).toContain("Upstream tool round failed");
    expect(text).not.toContain("[DONE]");
  });

  it("non-streaming round-2 failure → 502", async () => {
    let n = 0;
    mock.route(CHAT, () => {
      n += 1;
      if (n === 1) return jsonToolCalls("mcp__ketch__search");
      return json({ error: "boom" }, 500);
    });
    const res = await post({ stream: false });
    expect(res.status).toBe(502);
  });

  it("user content parts drive the memory query; empty/null content skipped", async () => {
    const t = Date.now();
    db.insert(memories)
      .values({ id: "m5", userId: user.userId, kind: "fact", text: "loves trains", source: "derived", pinned: false, createdAt: new Date(t), updatedAt: new Date(t) })
      .run();
    mock.route(CHAT, () => sseCompletion("ok"));
    await (
      await post({
        stream: true,
        messages: [{ role: "user", content: [{ type: "text" }, { type: "text", text: "trains?" }, { type: "image_url", image_url: { url: "data:," } }] }],
      })
    ).text();
    expect(String(bodies()[0].messages[0].content)).toContain("loves trains");

    await (await post({ stream: true, messages: [{ role: "user", content: [] }] })).text();
    expect(bodies()[1].messages.some((m) => m.role === "system")).toBe(false);

    await (await post({ stream: true, messages: [{ role: "user", content: null }] })).text();
    expect(bodies()[2].messages.some((m) => m.role === "system")).toBe(false);
  });

  it("malformed tool_calls entries: skipped or id-synthesized", async () => {
    mock.route(CHAT, () =>
      json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "x" }, { function: { name: "mcp__ketch__search" } }],
            },
          },
        ],
      }),
    );
    const res = await post({ stream: false });
    expect(res.status).toBe(200);
    const assistant = bodies()[1].messages.find((m) => m.tool_calls) as {
      tool_calls: { id: string; function: { name: string } }[];
    };
    expect(assistant.tool_calls).toHaveLength(1); // entry without function skipped
    expect(assistant.tool_calls[0]).toMatchObject({ id: "call_0", function: { name: "mcp__ketch__search" } });
  });

  it("mcp disabled → no tools injected", async () => {
    setSetting("mcp.enabled", "false");
    mock.route(CHAT, () => sseCompletion("ok"));
    await (await post({ stream: true })).text();
    expect(bodies()[0].tools).toBeUndefined();
    expect(vi.mocked(buildToolset)).not.toHaveBeenCalled();
  });
});
