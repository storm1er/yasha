import { NextResponse, type NextRequest } from "next/server";
import { ensureReady } from "@/lib/db";
import { getSettingInt, mcpEnabled, mcpMaxToolRounds, memoryEnabled } from "@/lib/settings";
import { authenticateApiKey, invalidApiKeyResponse, openAiError } from "@/lib/openai-auth";
import {
  releaseGeneration,
  tryAcquireGeneration,
} from "@/lib/provider/gate";
import { forEachSseData, stripReasoningFields } from "@/lib/provider/http";
import { ensureCatalog, pickProvider, upstreamModelId } from "@/lib/provider/catalog";
import { chatProviders } from "@/lib/provider/registry";
import { buildMemoryContext } from "@/lib/memory/recall";
import { getUserMemoryEnabled } from "@/lib/memory/prefs";
import { getUserMcpEnabled } from "@/lib/mcp/prefs";
import { buildToolset, type Toolset } from "@/lib/mcp/bridge";
import {
  createToolCallAccumulator,
  dispatchToolCalls,
  type ChatUpstreamMessage,
  type OpenAiToolCall,
} from "@/lib/mcp/loop";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Generous enough to carry OpenAI-style `image_url` data URLs for vision models.
const MAX_BODY_BYTES = 12 * 1024 * 1024;

// Models whose upstream call 4xx'd with injected `tools` (per process); later
// requests skip injection entirely. Tests isolate via vi.resetModules().
const noToolSupport = new Set<string>();

function invalidRequest(message: string) {
  return openAiError(400, message, "invalid_request_error", "invalid_request");
}

function upstreamError(status?: number) {
  return openAiError(
    502,
    `Upstream request failed${status ? ` with status ${status}` : ""}.`,
    "api_error",
    "upstream_error"
  );
}

/** Plain text of the LAST user message (content may be parts). */
function lastUserText(msgs: unknown[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: unknown; content?: unknown };
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((p) =>
          p && typeof p === "object" && (p as { type?: unknown }).type === "text"
            ? String((p as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
      if (text) return text;
    }
    return "";
  }
  return "";
}

/** Normalize upstream `message.tool_calls` entries to our OpenAI shape. */
function toToolCalls(raw: unknown): OpenAiToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenAiToolCall[] = [];
  for (const c of raw) {
    const fn = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
    if (!fn || typeof fn.name !== "string") continue;
    out.push({
      id: typeof (c as { id?: unknown }).id === "string" ? String((c as { id: unknown }).id) : `call_${out.length}`,
      type: "function",
      function: { name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : "" },
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "heavy");
  if (limited) return limited;
  await ensureReady();
  // Read per-request; unset key falls back to the 15000 ms default.
  const apiFirstTokenTimeoutMs = getSettingInt("api.firstTokenTimeoutMs", 1);
  const caller = await authenticateApiKey(req);
  if (!caller) return invalidApiKeyResponse();

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return invalidRequest("Could not read request body.");
  }
  if (raw.length > MAX_BODY_BYTES) {
    return invalidRequest(`Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`);
  }
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
    body = parsed as Record<string, unknown>;
  } catch {
    return invalidRequest("Request body must be a JSON object.");
  }

  const messages = body.messages;
  const validMessages =
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every((m) => Boolean(m) && typeof m === "object" && typeof (m as { role?: unknown }).role === "string");
  if (!validMessages) {
    return invalidRequest("'messages' must be a non-empty array of objects with a string 'role'.");
  }
  const model = body.model;
  if (typeof model !== "string" || !model) {
    return invalidRequest("'model' must be a non-empty string.");
  }

  const providers = chatProviders();
  if (providers.length === 0) {
    return openAiError(
      503,
      "No backend is configured. Ask an admin to add one under Settings → Backend.",
      "api_error",
      "no_backend"
    );
  }
  const catalog = await ensureCatalog();
  if (catalog.allUnavailable && catalog.models.length === 0) {
    return upstreamError();
  }
  if (!catalog.models.some((m) => m.id === model)) {
    return openAiError(
      404,
      `The model '${model}' does not exist or you do not have access to it.`,
      "invalid_request_error",
      "model_not_found"
    );
  }

  const maxTokensCap = getSettingInt("api.maxTokensCap");
  const maxTokensDefault = Math.min(getSettingInt("api.maxTokensDefault"), maxTokensCap);
  const requested =
    typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
      ? Math.floor(body.max_tokens)
      : maxTokensDefault;
  const maxTokens = Math.min(Math.max(requested, 1), maxTokensCap);
  const stream = body.stream === true;

  // Yasha extension param (stripped before upstream): `"memory": false` opts
  // out of the key-owner memory injection. Stateless route: no persistence,
  // no memory jobs, no thread summaries.
  const { memory: memoryOpt, ...restBody } = body;
  let upstreamMessages: ChatUpstreamMessage[] = messages as ChatUpstreamMessage[];
  if (memoryOpt !== false && memoryEnabled() && getUserMemoryEnabled(caller.userId)) {
    const query = lastUserText(messages as unknown[]);
    if (query) {
      const ctx = buildMemoryContext(caller.userId, query);
      if (ctx) upstreamMessages = [{ role: "system", content: ctx }, ...upstreamMessages];
    }
  }

  // Server-side MCP tools (same loop as the app chat). A client-supplied
  // `tools` array wins: OpenAI semantics preserved, no injection.
  const clientTools = Array.isArray(body.tools) && (body.tools as unknown[]).length > 0;
  let toolset: Toolset = { specs: [], handles: new Map() };
  if (!clientTools && mcpEnabled() && getUserMcpEnabled(caller.userId) && !noToolSupport.has(model)) {
    toolset = await buildToolset(caller.userId);
  }
  let useTools = toolset.specs.length > 0;

  const maxRounds = mcpMaxToolRounds();
  const baseBody = (): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      ...restBody,
      model: upstreamModel,
      messages: upstreamMessages,
      max_tokens: maxTokens,
      stream,
    };
    if (useTools) {
      b.tools = toolset.specs;
      b.tool_choice = "auto";
    }
    return b;
  };

  const provider = pickProvider(providers, catalog.models, model);
  const upstreamModel = upstreamModelId(model, provider.id);

  const controller = tryAcquireGeneration(caller.userId);
  if (!controller) {
    return openAiError(
      429,
      "Another generation is already in flight for this user. Wait for it to finish.",
      "rate_limit_error",
      "rate_limit_exceeded"
    );
  }

  let clientAborted = false;
  const onClientAbort = () => {
    clientAborted = true;
    controller.abort();
  };
  req.signal.addEventListener("abort", onClientAbort);
  const release = () => {
    req.signal.removeEventListener("abort", onClientAbort);
    releaseGeneration(caller.userId);
  };

  const timeout = setTimeout(() => controller.abort(), apiFirstTokenTimeoutMs);

  // First round (status errors still map to HTTP responses); a 4xx before any
  // consumption with injected tools means the model rejects tool calling → one
  // silent retry without tools, remembered per model.
  let retried4xx = false;
  let upstream: Response;
  for (;;) {
    try {
      upstream = await provider.completion(baseBody(), controller.signal);
    } catch {
      clearTimeout(timeout);
      release();
      if (clientAborted) {
        return openAiError(499, "Request aborted by client.", "api_error", "aborted");
      }
      return upstreamError();
    }
    if (
      useTools &&
      !upstream.ok &&
      !retried4xx &&
      upstream.status >= 400 &&
      upstream.status < 500
    ) {
      retried4xx = true;
      useTools = false;
      noToolSupport.add(model);
      continue;
    }
    break;
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeout);
    release();
    return upstreamError(upstream.status);
  }

  if (!stream) {
    try {
      let round = 0;
      for (;;) {
        const payload = (await upstream.json()) as Record<string, unknown>;
        const calls = toToolCalls(
          (payload.choices as { message?: { tool_calls?: unknown } }[] | undefined)?.[0]?.message?.tool_calls,
        );
        if (calls.length === 0 || round >= maxRounds || controller.signal.aborted) {
          // Echo the requested alias, not the rotating internal backing model.
          payload.model = model;
          stripReasoningFields(payload);
          return NextResponse.json(payload);
        }
        const { messages: toolMsgs } = await dispatchToolCalls(
          calls,
          toolset.handles,
          () => undefined,
          controller.signal,
        );
        upstreamMessages = [...upstreamMessages, ...toolMsgs];
        round += 1;
        upstream = await provider.completion(baseBody(), controller.signal);
        if (!upstream.ok || !upstream.body) throw new Error("upstream_round_failed");
      }
    } catch {
      return upstreamError();
    } finally {
      clearTimeout(timeout);
      release();
    }
  }

  const enc = new TextEncoder();
  const streamBody = new ReadableStream<Uint8Array>({
    async start(client) {
      const send = (chunk: string) => {
        try {
          client.enqueue(enc.encode(chunk));
        } catch {
          /* client gone */
        }
      };
      let current = upstream;
      let round = 0;
      let failed = false;
      let sawAnyData = false;
      for (;;) {
        const toolAcc = createToolCallAccumulator();
        let sawData = false;
        try {
          await forEachSseData(current.body!, (payload) => {
            if (!payload) return;
            if (!sawData) {
              sawData = true;
              sawAnyData = true;
              clearTimeout(timeout);
            }
            if (payload === "[DONE]") return; // exactly one DONE is sent at the very end
            let obj: unknown;
            try {
              obj = JSON.parse(payload);
            } catch {
              return;
            }
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
              (obj as Record<string, unknown>).model = model;
              const delta = (obj as { choices?: { delta?: { tool_calls?: unknown } }[] }).choices?.[0]?.delta;
              if (delta) {
                toolAcc.feed(delta.tool_calls);
                // Client-supplied semantics: MCP tool calls are consumed
                // server-side, never forwarded.
                delete delta.tool_calls;
                if (Object.keys(delta).length === 0) return; // delta-only chunk → drop
              }
            }
            send(`data: ${JSON.stringify(stripReasoningFields(obj))}\n\n`);
          });
        } catch {
          failed = true;
        }
        clearTimeout(timeout);
        if (failed) break;
        const calls = toolAcc.calls();
        if (calls.length === 0 || round >= maxRounds || controller.signal.aborted) {
          send("data: [DONE]\n\n");
          break;
        }
        const { messages: toolMsgs } = await dispatchToolCalls(
          calls,
          toolset.handles,
          () => undefined,
          controller.signal,
        );
        upstreamMessages = [...upstreamMessages, ...toolMsgs];
        round += 1;
        try {
          current = await provider.completion(baseBody(), controller.signal);
          if (!current.ok || !current.body) throw new Error("upstream_round_failed");
        } catch {
          send(
            `data: ${JSON.stringify({
              error: { message: "Upstream tool round failed.", type: "api_error", code: "upstream_error" },
            })}\n\n`
          );
          failed = true;
          break;
        }
      }
      if (failed && !clientAborted && !sawAnyData) {
        send(
          `data: ${JSON.stringify({
            error: { message: "Upstream stream failed before any data.", type: "api_error", code: "upstream_error" },
          })}\n\n`
        );
      }
      try {
        client.close();
      } catch {
        /* already closed */
      }
      release();
    },
    cancel() {
      clientAborted = true;
      clearTimeout(timeout);
      controller.abort();
      release();
    },
  });

  return new Response(streamBody, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
