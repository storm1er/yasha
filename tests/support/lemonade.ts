// Lemonade upstream mock: stubs global fetch with a route table. Registered
// per test (the global guard in setup.ts fails any test that talks to
// "upstream" without a mock).

import { vi } from "vitest";

export type MockCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Abort signal of the outgoing request (for abort-mid-stream tests). */
  signal?: AbortSignal | null;
};

type Reply =
  | Response
  | string
  | ((url: URL, call: MockCall) => Response | string | Promise<Response | string>);

export type LemonadeMock = {
  calls: MockCall[];
  /** First matching route wins (registration order). */
  route(matcher: string | RegExp, reply: Reply): void;
  fallback(reply: Reply): void;
  /** Parsed JSON bodies of all calls whose URL matches `needle`. */
  bodies(needle?: string): unknown[];
  lastCall(needle?: string): MockCall | undefined;
};

function toResponse(reply: Reply, url: URL, call: MockCall): Response | Promise<Response> {
  if (reply instanceof Response) return reply;
  if (typeof reply === "string") return new Response(reply, { headers: { "content-type": "text/plain" } });
  const out = reply(url, call);
  return out instanceof Response ? out : Promise.resolve(out).then((r) =>
    typeof r === "string" ? new Response(r, { headers: { "content-type": "text/plain" } }) : r
  );
}

export function mockLemonade(): LemonadeMock {
  const calls: MockCall[] = [];
  const routes: { matcher: string | RegExp; reply: Reply }[] = [];
  let fallback: Reply | null = null;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(urlStr);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const call: MockCall = {
        url: urlStr,
        method: (init?.method ?? "GET").toUpperCase(),
        headers,
        body:
          typeof init?.body === "string"
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body.toString()
              : undefined,
        signal: init?.signal ?? null,
      };
      calls.push(call);
      const route = routes.find((r) =>
        typeof r.matcher === "string" ? urlStr.includes(r.matcher) : r.matcher.test(urlStr)
      );
      const reply = route?.reply ?? fallback;
      if (!reply) {
        throw new Error(`no Lemonade mock route matches ${call.method} ${urlStr}`);
      }
      return toResponse(reply, url, call);
    })
  );

  return {
    calls,
    route(matcher, reply) {
      routes.push({ matcher, reply });
    },
    fallback(reply) {
      fallback = reply;
    },
    bodies(needle) {
      return calls
        .filter((c) => c.body !== undefined && (!needle || c.url.includes(needle)))
        .map((c) => JSON.parse(c.body as string));
    },
    lastCall(needle) {
      const list = needle ? calls.filter((c) => c.url.includes(needle)) : calls;
      return list[list.length - 1];
    },
  };
}

/** Route a matcher to a controllable stream, wiring the request abort signal
 *  into it (so generation/client aborts error the body like a real transport). */
export function bindStream(
  mock: LemonadeMock,
  s: ReturnType<typeof streamResponse>,
  matcher = "/v1/chat/completions"
): void {
  mock.route(matcher, (_url, call) => {
    s.attach(call.signal);
    return s.response;
  });
}

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Upstream GET /v1/models payload with chat-capable entries. */
export function modelsResponse(
  ids: { id: string; downloaded?: boolean; vision?: boolean; labels?: string[] }[]
): Response {
  return json({
    object: "list",
    data: ids.map((m) => ({
      id: m.id,
      object: "model",
      downloaded: m.downloaded ?? true,
      labels: m.labels ?? ["chat"],
      ...(m.vision ? { labels: [...(m.labels ?? ["chat"]), "vision"] } : {}),
    })),
  });
}

function sseLine(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

function deltaChunk(content: string): string {
  return sseLine({ choices: [{ delta: { content } }] });
}

/** Non-streaming-style upstream completion as an SSE body (what handlers read). */
export function sseCompletion(
  text: string,
  extra: { usage?: Record<string, unknown>; reasoning?: string; trailing?: string } = {}
): Response {
  let body = "";
  if (extra.reasoning) body += sseLine({ choices: [{ delta: { reasoning: extra.reasoning } }] });
  body += text ? deltaChunk(text) : "";
  if (extra.usage) body += sseLine({ choices: [], usage: extra.usage });
  if (extra.trailing) body += extra.trailing;
  body += sseLine("[DONE]");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Fully realistic chat-completions SSE: chunk envelope + role delta +
 *  finish_reason + optional usage (the AI SDK compat parser flags streams
 *  missing finish_reason — M0 spike finding, use this for SDK-driven tests). */
export function sseChatCompletion(
  text: string,
  opts: { usage?: Record<string, number>; reasoning?: string } = {}
): Response {
  const env = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "mock" };
  const line = (p: Record<string, unknown>) => `data: ${JSON.stringify({ ...env, ...p })}\n\n`;
  let body = line({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
  if (opts.reasoning) body += line({ choices: [{ index: 0, delta: { reasoning: opts.reasoning } }] });
  if (text) body += line({ choices: [{ index: 0, delta: { content: text } }] });
  body += line({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  if (opts.usage) body += line({ choices: [], usage: opts.usage });
  body += "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Scripted chat-completions SSE responses (stream=true upstream), one reply
 *  per call in order; falls back to the last entry. */
export function scriptedCompletions(texts: (string | Error)[]): (url: URL) => Response {
  let n = 0;
  return () => {
    const t = texts[Math.min(n, texts.length - 1)];
    n += 1;
    if (t instanceof Error) throw t;
    return sseCompletion(t);
  };
}

/** A streaming Response whose chunks you push manually. Honours the fetch
 *  signal (mid-stream abort errors the body, like a real transport). */
export function streamResponse(): {
  response: Response;
  pushText(text: string): void;
  pushPayload(payload: unknown): void;
  pushRaw(line: string): void;
  done(): void;
  fail(err?: Error): void;
  attach(signal?: AbortSignal | null): void;
} {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const safe = (fn: () => void) => {
    if (settled) return;
    try {
      fn();
    } catch {
      /* client already cancelled — matches real transport behaviour */
    }
  };
  // Terminal transition: guarded like safe(), but allowed to run once even
  // though it flips `settled` itself (safe() would skip its own action).
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    try {
      fn();
    } catch {
      /* client already cancelled — matches real transport behaviour */
    }
  };
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    pushText(text) {
      safe(() => controller.enqueue(enc.encode(deltaChunk(text))));
    },
    pushPayload(payload) {
      safe(() => controller.enqueue(enc.encode(sseLine(payload))));
    },
    pushRaw(line) {
      safe(() => controller.enqueue(enc.encode(line)));
    },
    done() {
      finish(() => {
        controller.enqueue(enc.encode(sseLine("[DONE]")));
        controller.close();
      });
    },
    fail(err) {
      finish(() => controller.error(err ?? new Error("stream died")));
    },
    attach(signal) {
      if (!signal) return;
      if (signal.aborted) {
        finish(() => controller.error(new Error("aborted")));
        return;
      }
      signal.addEventListener("abort", () => {
        finish(() => controller.error(new Error("aborted")));
      });
    },
  };
}
