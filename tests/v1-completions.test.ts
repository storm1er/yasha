import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as v1Chat from "@/app/v1/chat/completions/route";
import { ensureReady } from "@/lib/db";
import { db } from "./support/db";
import { setSetting } from "./support/db";
import { invalidateSettingsCache } from "@/lib/settings";
import { apiKeys } from "@/lib/db/schema";
import { makeRequest, sessionId, signUp, waitFor, type TestUser } from "./support/app";
import { bindStream, json, mockLemonade, modelsResponse, sseCompletion, streamResponse } from "./support/lemonade";
import { createKey } from "@/lib/api-keys";
import { hasInFlightGeneration, releaseGeneration } from "@/lib/lemonade-stream";

let user: TestUser & { userId: string };
let auth: string;

const CHAT = "/v1/chat/completions";

function post(opts: Record<string, unknown> = {}, authorization = auth) {
  return callV1({ json: { model: "fast-model.test", messages: [{ role: "user", content: "hi" }], ...opts } }, authorization);
}

async function callV1(opts: Parameters<typeof makeRequest>[0], authorization = auth) {
  const req = makeRequest({ method: "POST", path: "/v1/chat/completions", headers: { authorization }, ...opts });
  return v1Chat.POST(req as never);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await ensureReady();
  user = Object.assign(await signUp("v1proxy"), { userId: "" });
  user.userId = await sessionId(user.cookie);
  const created = await createKey(user.userId, "v1");
  auth = `Bearer ${created.key}`;
});

beforeEach(() => {
  releaseGeneration(user.userId);
  setSetting("api.maxTokensDefault", "512");
  setSetting("api.maxTokensCap", "1024");
  setSetting("api.firstTokenTimeoutMs", "30000");
  invalidateSettingsCache();
});

afterEach(() => {
  releaseGeneration(user.userId);
});

describe("v1 chat/completions auth + validation", () => {
  it("401 without a valid API key", async () => {
    const bare = makeRequest({ method: "POST", path: "/v1/chat/completions", json: {} });
    let res = await v1Chat.POST(bare as never); // no authorization header at all
    expect(res.status).toBe(401);
    res = await callV1({ json: {} }, "Bearer ysk_bogus");
    expect(res.status).toBe(401);
  });

  it("body parsing guards", async () => {
    let res = await callV1({ body: "not json" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    res = await callV1({ body: "[1,2]" });
    expect(res.status).toBe(400);
    res = await callV1({ body: "null" });
    expect(res.status).toBe(400);
    res = await callV1({ body: "x".repeat(12 * 1024 * 1024 + 10) });
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("byte limit");
  });

  it("messages + model validation", async () => {
    for (const messages of [undefined, [], "x", [null], [{ noRole: 1 }], [{ role: 7 }]]) {
      const res = await callV1({ json: { model: "fast-model.test", messages } });
      expect(res.status, JSON.stringify(messages)).toBe(400);
    }
    let res = await callV1({ json: { messages: [{ role: "user", content: "x" }] } });
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("'model'");
    res = await callV1({ json: { model: "", messages: [{ role: "user", content: "x" }] } });
    expect(res.status).toBe(400);
  });

  it("model list failure → 502; unknown model → 404 model_not_found", async () => {
    let mock = mockLemonade();
    mock.route("/v1/models", () => new Response("x", { status: 503 }));
    let res = await post();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("Lemonade");
    mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    res = await post({ model: "ghost-model" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("model_not_found");
  });

  it("429 when a generation is already in flight", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const { tryAcquireGeneration } = await import("@/lib/lemonade-stream");
    tryAcquireGeneration(user.userId);
    const res = await post();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limit_exceeded");
    releaseGeneration(user.userId);
  });
});

describe("v1 non-streaming", () => {
  beforeEach(() => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
  });

  it("passes through json, echoes model, strips reasoning everywhere", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () =>
      json({
        id: "cmpl-1",
        model: "internal-backing-model",
        choices: [{ message: { role: "assistant", content: "hello", reasoning_details: [{ x: 1 }] }, reasoning: "r" }],
        usage: { completion_tokens: 2, reasoning_tokens: 9 },
      })
    );
    const res = await post({ stream: false, max_tokens: 5000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.model).toBe("fast-model.test");
    expect(JSON.stringify(body)).not.toMatch(/reasoning/i);
    const sent = JSON.parse(mock.lastCall(CHAT)!.body!) as Record<string, unknown>;
    expect(sent.max_tokens).toBe(1024); // capped at api.maxTokensCap
    expect(sent.stream).toBe(false);
  });

  it("max_tokens clamping: floor 1, default min(default,cap)", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => json({ choices: [] }));
    setSetting("api.maxTokensDefault", "4096");
    setSetting("api.maxTokensCap", "1024");
    invalidateSettingsCache();
    await post({ max_tokens: -5 });
    expect((JSON.parse(mock.lastCall(CHAT)!.body!) as { max_tokens: number }).max_tokens).toBe(1);
    await post({ max_tokens: "abc" }); // non-number → default
    expect((JSON.parse(mock.lastCall(CHAT)!.body!) as { max_tokens: number }).max_tokens).toBe(1024);
  });

  it("upstream non-2xx → 502 with status; unparseable body → 502", async () => {
    let mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => new Response("nope", { status: 503 }));
    let res = await post({ stream: false });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("503");
    mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
    res = await post({ stream: false });
    expect(res.status).toBe(502);
    expect(hasInFlightGeneration(user.userId)).toBe(false);
  });
});

describe("v1 upstream connect failures", () => {
  beforeEach(() => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
  });

  it("fetch throw → 502 upstream_error", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await post();
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("upstream_error");
  });

  it("client aborted before upstream answered → 499", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, async (_url, call) => {
      const signal = call.signal!;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("aborted mid-flight");
    });
    const ac = new AbortController();
    const req = makeRequest({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { authorization: auth },
      json: { model: "fast-model.test", messages: [{ role: "user", content: "hi" }] },
      signal: ac.signal,
    });
    const resPromise = v1Chat.POST(req as never);
    await delay(30);
    ac.abort();
    const res = await resPromise;
    expect(res.status).toBe(499);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("aborted");
  });
});

describe("v1 streaming", () => {
  it("forwards SSE chunks, rewrites model, strips reasoning, synthesizes DONE", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"Hel","reasoning":"secret"}}],"model":"backing"}\n\n',
          "data: junk-not-json\n\n",
          "data:\n\n",
          "data: [42,\"arr\"]\n\n",
          'data: {"choices":[],"usage":{"reasoning_tokens":3,"total_tokens":5}}\n\n',
        ].join(""), // NOTE: no [DONE] → synthetic one is appended
        { headers: { "content-type": "text/event-stream" } }
      )
    );
    const res = await post({ stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"content":"Hel"');
    expect(text).not.toMatch(/reasoning/i);
    expect(text).toContain('"model":"fast-model.test"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(text).toContain("[42,\"arr\"]"); // array payload forwarded verbatim (no model rewrite)
  });

  it("request body that errors while being read → 400", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("network gone"));
      },
    });
    const req = new Request(
      "http://localhost:3000/v1/chat/completions",
      {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }
    );
    const res = await v1Chat.POST(req as never);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("Could not read");
  });

  it("passes [DONE] through once; empty payloads ignored", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    mock.route(CHAT, () =>
      sseCompletion("ok", { usage: { total_tokens: 1 } })
    );
    const res = await post({ stream: true });
    const text = await res.text();
    expect((text.match(/data: \[DONE\]/g) ?? []).length).toBe(1);
    expect(text).toContain('"content":"ok"');
  });

  it("first-token timeout on a silent stream: error event before any data", async () => {
    setSetting("api.firstTokenTimeoutMs", "1000");
    invalidateSettingsCache();
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse();
    bindStream(mock, stream);
    const res = await post({ stream: true });
    const events = (await res.text())
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    expect((events[0] as { error: { code: string } }).error.code).toBe("upstream_error");
    expect(hasInFlightGeneration(user.userId)).toBe(false);
  });

  it("client abort mid-stream: failed after data → clean close, no error event", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse();
    bindStream(mock, stream);
    const ac = new AbortController();
    const req = makeRequest({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { authorization: auth },
      json: { model: "fast-model.test", messages: [{ role: "user", content: "hi" }], stream: true },
      signal: ac.signal,
    });
    const res = await v1Chat.POST(req as never);
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
    stream.pushText("partial");
    await waitFor(() => text.includes("partial"));
    ac.abort(); // onClientAbort → controller.abort → bound body errors → failed after data
    await pump;
    expect(text).not.toContain("error");
    expect(hasInFlightGeneration(user.userId)).toBe(false);
  });

  it("reader cancel releases the slot; late sends are swallowed", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
    const stream = streamResponse();
    bindStream(mock, stream);
    const res = await post({ stream: true });
    const reader = res.body!.getReader();
    stream.pushText("chunk-a");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("chunk-a");
    await reader.cancel();
    await delay(10); // let the start-loop notice the cancelled sink
    stream.pushText("late"); // enqueue into cancelled stream → caught
    stream.done();
    await waitFor(() => !hasInFlightGeneration(user.userId));
  });

  it("db cleanup: api key row untouched after generations", async () => {
    expect(db.select().from(apiKeys).all().length).toBeGreaterThanOrEqual(1);
  });
});
