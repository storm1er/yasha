// LLM warmup (issue #67): POST /api/backend/warm + lib/chat/warm.
// The gold assertions are the PREFIX EQUALITY ones: the warm body's system
// block and tools must be byte-identical to what the real first chat turn
// sends, since that equality is the whole point (llama.cpp KV prefix reuse).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as chatRoute from "@/app/api/chat/route";
import * as warmRoute from "@/app/api/backend/warm/route";
import { ensureReady } from "@/lib/db";
import { memories, providers, settings, userSettings, type Provider } from "@/lib/db/schema";
import { invalidateSettingsCache } from "@/lib/settings";
import { seedProvidersFromEnv } from "@/lib/provider/registry";
import {
  hasInFlightGeneration,
  releaseGeneration,
  tryAcquireGeneration,
} from "@/lib/provider/gate";
import { buildMemoryContext } from "@/lib/memory/recall";
import {
  MAX_WARM_ENTRIES,
  WARM_ABORT_AFTER_MS,
  WARM_DEDUPE_TTL_MS,
  resetWarmState,
  warmUser,
} from "@/lib/chat/warm";
import { callRoute, sessionId, signUp, waitFor, type TestUser } from "./support/app";
import { db, setFastModel, setSetting } from "./support/db";
import {
  bindStream,
  json,
  mockLemonade,
  modelsResponse,
  scriptedCompletions,
  sseChatCompletion,
  streamResponse,
  type LemonadeMock,
} from "./support/lemonade";
import { v3Body } from "./support/v3";
import { drainUi } from "./support/ui-stream";

vi.mock("@/lib/mcp/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/bridge")>();
  return { ...actual, buildToolset: vi.fn() };
});
import { buildToolset } from "@/lib/mcp/bridge";

const mockedBuild = vi.mocked(buildToolset);

const CHAT = "/v1/chat/completions";
const MODELS = "/v1/models";

type SentBody = {
  model: string;
  stream?: boolean;
  messages: { role: string; content: string }[];
  tools?: { type: string; function: { name: string; description: string; parameters: unknown } }[];
};

let mock: LemonadeMock;
let user: TestUser & { userId: string };

function warmPost(jsonBody: unknown, cookie: string | null = user.cookie) {
  return callRoute(warmRoute.POST, { method: "POST", path: "/api/backend/warm", cookie, json: jsonBody });
}

async function warmJson(jsonBody: unknown): Promise<{ scheduled: boolean; reason: string }> {
  const res = await warmPost(jsonBody);
  return (await res.json()) as { scheduled: boolean; reason: string };
}

async function sentBody(callIndex = 0): Promise<SentBody> {
  // The dispatch fetch lands asynchronously (fire-and-forget) — wait for it.
  await waitFor(() => mock.calls.filter((c) => c.url.includes(CHAT)).length > callIndex);
  const call = mock.calls.filter((c) => c.url.includes(CHAT))[callIndex];
  return JSON.parse(call!.body!) as SentBody;
}

function seedFacts(n: number) {
  const t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    db.insert(memories)
      .values({
        id: `warm-mem-${i}`,
        userId: user.userId,
        kind: "fact",
        text: `Warm fact number ${i}`,
        source: "derived",
        pinned: false,
        createdAt: new Date(t + i),
        updatedAt: new Date(t + i),
      })
      .run();
  }
}

function insertProvider(id: string, over: Partial<Provider> = {}): void {
  const now = new Date();
  db.insert(providers)
    .values({
      id,
      type: "openai_compatible",
      label: `Provider ${id}`,
      baseUrl: `http://${id}.invalid.test`,
      apiKey: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      ...over,
    })
    .run();
}

// Waits for the warm's upstream call to be torn down (the abort the drain
// performs), so module state is settled before the next assertion.
async function waitForWarmRelease() {
  await waitFor(() => mock.calls.some((c) => c.url.includes(CHAT) && c.signal?.aborted));
}

beforeAll(async () => {
  await ensureReady();
  user = Object.assign(await signUp("warmup_user"), { userId: "" });
  user.userId = await sessionId(user.cookie);
});

beforeEach(() => {
  mock = mockLemonade();
  mockedBuild.mockReset();
  db.delete(memories).run();
  db.delete(userSettings).run();
  db.delete(providers).run();
  db.delete(settings).run();
  seedProvidersFromEnv();
  setFastModel("default:fast-model.test");
  setSetting("mcp.enabled", "false");
  resetWarmState();
  releaseGeneration(user.userId);
});

afterEach(() => {
  resetWarmState();
  releaseGeneration(user.userId);
});

describe("POST /api/backend/warm — validation + soft states", () => {
  it("401 without a session", async () => {
    const res = await warmPost({}, null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("400 on invalid json; null body behaves like {}", async () => {
    const res = await callRoute(warmRoute.POST, {
      method: "POST",
      path: "/api/backend/warm",
      cookie: user.cookie,
      body: "{oops",
    });
    expect(res.status).toBe(400);

    mock.route(CHAT, () => sseChatCompletion("x"));
    expect(await warmJson(null)).toEqual({ scheduled: true, reason: "ok" });
    await waitForWarmRelease();
  });

  it("no backend → soft no_backend", async () => {
    db.delete(providers).run();
    expect(await warmJson({})).toEqual({ scheduled: false, reason: "no_backend" });
  });

  it("no model configured → soft no_model", async () => {
    db.delete(settings).run();
    invalidateSettingsCache();
    expect(await warmJson({})).toEqual({ scheduled: false, reason: "no_model" });
  });

  it("busy user (generation in flight) is never warmed on top of", async () => {
    const controller = tryAcquireGeneration(user.userId);
    expect(controller).not.toBeNull();
    expect(await warmJson({})).toEqual({ scheduled: false, reason: "busy" });
    releaseGeneration(user.userId);
  });

  it("admin kill-switch (backend.warm.enabled) gates everything", async () => {
    mock.route(CHAT, () => sseChatCompletion("x"));
    setSetting("backend.warm.enabled", "false");
    expect(await warmJson({})).toEqual({ scheduled: false, reason: "disabled" });
    expect(mock.calls.some((c) => c.url.includes(CHAT))).toBe(false); // nothing upstream
    setSetting("backend.warm.enabled", "true");
    expect(await warmJson({})).toEqual({ scheduled: true, reason: "ok" });
    await waitForWarmRelease();
  });

  it("client-chosen model is validated against the synced catalog", async () => {
    mock.route(MODELS, () => modelsResponse([{ id: "fast-model.test" }]));
    expect(await warmJson({ model: "default:ghost" })).toEqual({
      scheduled: false,
      reason: "invalid_model",
    });
    // Non-string model is ignored → the default chain applies.
    mock.route(CHAT, () => sseChatCompletion("x"));
    expect(await warmJson({ model: 42 })).toEqual({ scheduled: true, reason: "ok" });
    expect((await sentBody()).model).toBe("fast-model.test"); // provider prefix stripped
    await waitForWarmRelease();
  });
});

describe("warm request shape", () => {
  it("sends the memory block + the web toolset on the default fast model", async () => {
    seedFacts(2);
    mock.route(CHAT, () => sseChatCompletion("x"));
    expect(await warmJson({})).toEqual({ scheduled: true, reason: "ok" });
    const body = await sentBody();
    expect(body.model).toBe("fast-model.test");
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(2);
    // Byte-identical to the query-less recall the chat route injects.
    expect(body.messages[0]).toEqual({ role: "system", content: buildMemoryContext(user.userId) });
    expect(body.messages[1]!.content).toBe(".");
    expect(body.tools!.map((t) => t.function.name)).toEqual(["ask_choice", "confirm_action", "render_ui"]);
    await waitForWarmRelease();
  });

  it("prefix EQUALS the real first chat turn (system block + tools)", async () => {
    seedFacts(3);
    mock.route(CHAT, scriptedCompletions(["warming", "real answer"]));
    expect(await warmJson({})).toEqual({ scheduled: true, reason: "ok" });
    const chatRes = await callRoute(chatRoute.POST, {
      method: "POST",
      path: "/api/chat",
      cookie: user.cookie,
      json: v3Body({ message: "what do you know about me?" }),
    });
    await drainUi(chatRes);

    const warm = await sentBody(0);
    const chat = await sentBody(1);
    const chatSystem = chat.messages.filter((m) => m.role === "system");
    expect(chatSystem).toHaveLength(1);
    // THE invariant of issue #67: identical template prefix ⇒ cache hit.
    expect(warm.messages[0]).toEqual(chatSystem[0]);
    expect(chat.tools).toEqual(warm.tools);
    // The user turn is the only divergence (warm sends the dummy).
    expect(warm.messages[1]!.content).toBe(".");
    expect(String(chat.messages.find((m) => m.role === "user")!.content)).toContain("what do you know");
    await waitForWarmRelease();
  });

  it("memory gates: global off, user off, and no facts all send user-only", async () => {
    seedFacts(2);
    mock.route(CHAT, () => sseChatCompletion("x"));

    setSetting("memory.enabled", "false");
    setFastModel("default:warm-g-globally-off");
    expect(await warmJson({})).toEqual({ scheduled: true, reason: "ok" });
    expect((await sentBody()).messages.map((m) => m.role)).toEqual(["user"]);

    db.delete(userSettings).run();
    db.insert(userSettings)
      .values({ userId: user.userId, key: "memory.userEnabled", value: "false", updatedAt: new Date() })
      .run();
    setSetting("memory.enabled", "true");
    setFastModel("default:warm-g-user-off");
    expect(await warmJson({})).toEqual({ scheduled: true, reason: "ok" });
    expect((await sentBody(1)).messages.map((m) => m.role)).toEqual(["user"]);

    db.delete(memories).run();
    db.delete(userSettings).run();
    setFastModel("default:warm-g-no-facts");
    expect(await warmJson({})).toEqual({ scheduled: true, reason: "ok" });
    expect((await sentBody(2)).messages.map((m) => m.role)).toEqual(["user"]);
    await waitForWarmRelease();
  });

  it("interactive/cards flags shape the toolset like the v3 request", async () => {
    mock.route(CHAT, () => sseChatCompletion("x"));
    // Android shape: cards without the interactive asks.
    setFastModel("default:warm-flags-cards");
    await warmJson({ interactive: false, cards: true });
    expect((await sentBody()).tools!.map((t) => t.function.name)).toEqual(["render_ui"]);
    // No tools at all when both are off (and MCP is off).
    setFastModel("default:warm-flags-none");
    await warmJson({ interactive: false, cards: false });
    expect((await sentBody(1)).tools).toBeUndefined();
    await waitForWarmRelease();
  });

  it("openai_compatible provider: canonical id stripped, Bearer key sent", async () => {
    insertProvider("compat", { apiKey: "sk-1", baseUrl: "http://compat.invalid.test" });
    mock.route(MODELS, (url) =>
      url.href.includes("compat.invalid.test")
        ? modelsResponse([{ id: "m1" }])
        : modelsResponse([{ id: "fast-model.test" }])
    );
    mock.route(CHAT, () => sseChatCompletion("x"));
    expect(await warmJson({ model: "compat:m1" })).toEqual({ scheduled: true, reason: "ok" });
    const body = await sentBody();
    expect(body.model).toBe("m1");
    expect(mock.lastCall(CHAT)!.headers.authorization).toBe("Bearer sk-1");
    await waitForWarmRelease();
  });

  it("MCP specs ride the prefix, declaratively wrapped, ahead of the asks", async () => {
    setSetting("mcp.enabled", "true");
    mockedBuild.mockResolvedValue({
      specs: [
        {
          type: "function",
          function: {
            name: "mcp__s__tool",
            description: "S: tool",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ],
      handles: new Map(),
    });
    mock.route(CHAT, () => sseChatCompletion("x"));
    expect(await warmJson({})).toEqual({ scheduled: true, reason: "ok" });
    const tools = (await sentBody()).tools!;
    expect(tools.map((t) => t.function.name)).toEqual(["mcp__s__tool", "ask_choice", "confirm_action", "render_ui"]);
    expect(tools[0]!.function.parameters).toEqual({ type: "object", properties: { q: { type: "string" } } });
    await waitForWarmRelease();

    // A failing toolset build is swallowed (best-effort warm).
    mockedBuild.mockRejectedValueOnce(new Error("bridge down"));
    expect(await warmJson({})).toEqual({ scheduled: false, reason: "error" });
  });
});

describe("warm scheduling", () => {
  it("holds ONE warm slot instance-wide while the stream is open", async () => {
    const s = streamResponse();
    bindStream(mock, s);
    expect(await warmJson({})).toEqual({ scheduled: true, reason: "ok" });
    expect(await warmJson({ model: "other" })).toEqual({ scheduled: false, reason: "warm_in_flight" });
    s.pushFinish("stop");
    s.done();
    await waitForWarmRelease();
  });

  it("dedupes an identical prefix within the TTL; changed memory re-warms", async () => {
    mock.route(CHAT, () => sseChatCompletion("x"));
    const w1 = await warmUser({ userId: user.userId });
    expect(w1.reason).toBe("ok");
    await w1.done;
    const w2 = await warmUser({ userId: user.userId });
    expect(w2).toMatchObject({ scheduled: false, reason: "recent" });
    seedFacts(1);
    const w3 = await warmUser({ userId: user.userId });
    expect(w3.reason).toBe("ok");
    await w3.done;
  });

  it("the TTL window expires and the same prefix may warm again", async () => {
    mock.route(CHAT, () => sseChatCompletion("x"));
    const w1 = await warmUser({ userId: user.userId });
    await w1.done;
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(WARM_DEDUPE_TTL_MS + 1);
      const w2 = await warmUser({ userId: user.userId });
      expect(w2.reason).toBe("ok");
      await w2.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("the dedupe map is FIFO-bounded", async () => {
    mock.route(CHAT, () => sseChatCompletion("x"));
    const ids: string[] = [];
    for (let i = 0; i <= MAX_WARM_ENTRIES; i++) {
      const id = `default:evict-${i}`;
      ids.push(id);
      setFastModel(id);
      const w = await warmUser({ userId: user.userId });
      expect(w.reason).toBe("ok");
      await w.done;
    }
    // The very first prefix was evicted, so it may warm again.
    setFastModel(ids[0]!);
    const again = await warmUser({ userId: user.userId });
    expect(again.reason).toBe("ok");
    await again.done;
  });
});

describe("warm stream lifecycle", () => {
  it("a model-side render_ui call during a warm executes and its card is discarded", async () => {
    // The render_ui definition rides the real tool (execute included): the
    // warm must never dispatch side-effecting work, and render_ui's execute
    // is validation + the no-op onCard sink.
    mock.route(CHAT, () => {
      const env = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
      const line = (p: Record<string, unknown>) => `data: ${JSON.stringify({ ...env, ...p })}\n\n`;
      const body =
        line({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }) +
        line({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "render_ui", arguments: '{"root":{"type":"text","text":"hi"}}' },
                  },
                ],
              },
            },
          ],
        }) +
        line({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const w = await warmUser({ userId: user.userId });
    expect(w.reason).toBe("ok");
    await w.done;
    expect(mock.calls.some((c) => c.url.includes(CHAT))).toBe(true);
  });

  it("aborts the discarded call right after the first content chunk", async () => {
    const s = streamResponse();
    bindStream(mock, s);
    const w = await warmUser({ userId: user.userId });
    const env = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
    s.pushPayload({ ...env, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
    s.pushPayload({ ...env, choices: [{ index: 0, delta: { content: "hello" } }] });
    await w.done;
    expect(mock.lastCall(CHAT)!.signal!.aborted).toBe(true);
    expect(hasInFlightGeneration(user.userId)).toBe(false); // never takes the chat gate
  });

  it("the hard timer bounds a silent (model-loading) stream", async () => {
    const s = streamResponse();
    bindStream(mock, s);
    vi.useFakeTimers();
    try {
      const w = await warmUser({ userId: user.userId });
      vi.advanceTimersByTime(WARM_ABORT_AFTER_MS + 10);
      await w.done;
      expect(mock.lastCall(CHAT)!.signal!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("upstream errors vanish without wedging the slot", async () => {
    mock.route(CHAT, () => json({ error: "boom" }, 500));
    const w = await warmUser({ userId: user.userId });
    expect(w.reason).toBe("ok");
    await w.done;
    const next = await warmUser({ userId: user.userId });
    expect(next.reason).toBe("recent"); // slot free (not warm_in_flight), dedupe holds
  });
});

describe("rate limiting (last: enables the global limiter)", () => {
  it("the warm endpoint rides the heavy tier", async () => {
    // Fresh user ⇒ untouched `heavy|u:` bucket, so the 31st call in the
    // window is the 429. The limiter is off for the whole suite (setup.ts).
    const rlUser = await signUp("warm_rl");
    mock.route(CHAT, () => sseChatCompletion("x"));
    process.env.YASHA_RATE_LIMIT = "";
    try {
      let last = 200;
      for (let i = 0; i < 31; i++) {
        const res = await callRoute(warmRoute.POST, {
          method: "POST",
          path: "/api/backend/warm",
          cookie: rlUser.cookie,
          json: {},
        });
        last = res.status;
        if (last === 429) break;
      }
      expect(last).toBe(429);
    } finally {
      process.env.YASHA_RATE_LIMIT = "off";
      resetWarmState();
    }
  });
});
