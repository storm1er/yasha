// LLM warmup (issue #67): fire a throwaway completion carrying the exact
// prefix a user's FIRST real message will produce — the memory-injected
// system block plus the identical tool declarations (llama.cpp renders tools
// ahead of the messages, so they are part of the cacheable prefix). One call
// therefore (a) triggers Lemonade's synchronous model LOAD off the user's
// critical path and (b) leaves the llama.cpp KV prefix cache holding the
// system block, so the real first turn only pays for its own user turn
// (measured cache_n reuse on a live instance: full system prefix reused).
//
// Purely opportunistic: every skip/failure answers {scheduled:false, reason}
// and NOTHING here may block the caller's response or touch the DB beyond
// reads. The completion itself is worthless — the stream is drained until the
// first content chunk (which can only arrive after server-side prefill) and
// aborted there; a hard timer bounds slow loads.
//
// Deliberately NOT reusing /api/chat: it inserts thread/message rows,
// persists an assistant row and enqueues memory jobs. Warm shares only the
// builders (memory recall, toolset, AI SDK serializer).

import { createHash } from "node:crypto";
import { jsonSchema, streamText, tool, type ToolSet } from "ai";
import { INTERACTIVE_TOOL_DEFS } from "@/lib/chat/interactive";
import { buildRenderUiTool } from "@/lib/chat/render-ui";
import { toModelMessages } from "@/lib/chat/model-messages";
import type { ChatUpstreamMessage } from "@/lib/mcp/loop";
import { buildToolset, type OpenAiToolSpec } from "@/lib/mcp/bridge";
import { mcpEnabled, fastModel, memoryEnabled, smartModel, warmEnabled } from "@/lib/settings";
import { getUserMcpEnabled } from "@/lib/mcp/prefs";
import { getUserMemoryEnabled } from "@/lib/memory/prefs";
import { buildMemoryContext } from "@/lib/memory/recall";
import { hasInFlightGeneration } from "@/lib/provider/gate";
import { ensureCatalog, pickProvider, upstreamModelId, type CatalogModel } from "@/lib/provider/catalog";
import { chatProviders } from "@/lib/provider/registry";
import type { ChatProvider } from "@/lib/provider/types";

/** Identical (user, model, prefix) warms inside this window are dropped —
 * the KV cache they produced is still resident, and the trigger (app open,
 * new chat, model switch) would otherwise re-burn the same prompt. The key
 * covers the whole cacheable prefix, so two users with the SAME memory block
 * also dedupe against each other. */
export const WARM_DEDUPE_TTL_MS = 60_000;

/** Hard bound on the dedupe map (memory-block churn — dreaming, per-user —
 * is the only unbounded key source): oldest entry evicted first. */
export const MAX_WARM_ENTRIES = 256;

/** A cold load can take minutes on weak hardware; never hold the single
 * warm slot longer than this. */
export const WARM_ABORT_AFTER_MS = 120_000;

export type WarmReason =
  | "ok"
  | "disabled"
  | "no_backend"
  | "no_model"
  | "invalid_model"
  | "busy"
  | "warm_in_flight"
  | "recent"
  | "error";

export type WarmOutcome = {
  scheduled: boolean;
  reason: WarmReason;
  /** Resolves when the discarded upstream call finishes (always swallows
   * errors). The route answers without awaiting it; tests do. */
  done: Promise<void>;
};

// Module state (test isolation: vi.resetModules + re-import). `inFlight`
// keeps ONE warm call instance-wide — single-model backends (max_models.llm
// = 1) serialize anyway, and stacking warms would only delay real turns.
let inFlight = false;
const warmed = new Map<string, number>();

const skip = (reason: Exclude<WarmReason, "ok">): WarmOutcome => ({
  scheduled: false,
  reason,
  done: Promise.resolve(),
});

/** Test seam (resetHealthProbes/resetProviderInstances pattern): drops the
 * dedupe map and the in-flight flag so tests never inherit module state. */
export function resetWarmState(): void {
  warmed.clear();
  inFlight = false;
}

/**
 * Warm `model` (canonical id; default chain `fast_model → smart_model` when
 * absent) for `userId`. `interactive`/`cards` mirror the v3 request flags so
 * the tools block matches the caller's real sends (web: true/true; Android:
 * false/true). A client-chosen model is validated against the synced catalog
 * (never warm an arbitrary upstream id); never throws.
 */
export async function warmUser(opts: {
  userId: string;
  model?: string | null;
  interactive?: boolean;
  cards?: boolean;
}): Promise<WarmOutcome> {
  // Admin kill-switch (Settings → Backend): nothing upstream happens at all.
  if (!warmEnabled()) return skip("disabled");
  if (inFlight) return skip("warm_in_flight");
  const providers = chatProviders();
  if (providers.length === 0) return skip("no_backend");
  const requested = typeof opts.model === "string" ? opts.model.trim() : "";
  const model = requested || fastModel() || smartModel();
  if (!model) return skip("no_model");
  // Never compete with the user's own generation for the GPU.
  if (hasInFlightGeneration(opts.userId)) return skip("busy");

  inFlight = true;
  // Single settle: skip paths release the slot inline (before any dispatch
  // exists); the dispatched path releases it when the drain finishes.
  const settle = () => {
    inFlight = false;
  };
  try {
    // Catalog: only when a client pick must be validated or a provider pick
    // is ambiguous — same laziness as /api/chat (ensureCatalog never throws).
    // Invariant: multi-provider flows always consult it, so `pickProvider`
    // below never runs against an unstored catalog.
    let catalog: CatalogModel[] = [];
    if (requested || providers.length > 1) {
      catalog = (await ensureCatalog()).models;
      if (requested && !catalog.some((m) => m.id === requested)) {
        settle();
        return skip("invalid_model");
      }
    }
    const provider =
      providers.length === 1 ? providers[0] : pickProvider(providers, catalog, model);
    const upstream = upstreamModelId(model, provider.id);
    const interactive = opts.interactive !== false;
    const cards = opts.cards !== false;
    // The memory block, built exactly like the chat route's injection
    // (gates + query-less recall — the first message is unknown here).
    const memCtx =
      memoryEnabled() && getUserMemoryEnabled(opts.userId)
        ? buildMemoryContext(opts.userId)
        : null;
    const specs: OpenAiToolSpec[] =
      mcpEnabled() && getUserMcpEnabled(opts.userId)
        ? (await buildToolset(opts.userId)).specs
        : [];

    // Prefix identity for the dedupe: everything the chat template puts
    // ahead of the (unknown) first user message.
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          provider.id,
          upstream,
          interactive,
          cards,
          memCtx ?? "",
          specs.map((s) => [s.function.name, s.function.description, s.function.parameters]),
        ])
      )
      .digest("hex");
    const last = warmed.get(key);
    if (last !== undefined && Date.now() - last < WARM_DEDUPE_TTL_MS) {
      settle();
      return skip("recent");
    }
    if (warmed.size >= MAX_WARM_ENTRIES) warmed.delete(warmed.keys().next().value as string);
    warmed.set(key, Date.now());

    const done = dispatchWarm(provider, upstream, memCtx, interactive, cards, specs);
    // The route never awaits `done`; release the slot when it settles.
    done.then(settle, settle);
    return { scheduled: true, reason: "ok", done };
  } catch {
    // Warm is best-effort: a broken toolset/memory read must not surface.
    settle();
    return skip("error");
  }
}

/** Content-bearing first chunks: only these prove the upstream got past
 * prefill (start/metadata frames arrive earlier, and a tool-call-only reply
 * proves nothing until its arguments stream — that call simply drains). */
const PREFILLED = new Set(["text-delta", "reasoning-delta"]);

async function dispatchWarm(
  provider: ChatProvider,
  upstreamModel: string,
  memCtx: string | null,
  interactive: boolean,
  cards: boolean,
  mcpSpecs: OpenAiToolSpec[]
): Promise<void> {
  try {
    // MCP tools are wrapped DECLARATIVELY (no execute): the request carries
    // the same wire definitions, but a warm can never dispatch a bridge call.
    const mcpTools: ToolSet = {};
    for (const spec of mcpSpecs) {
      mcpTools[spec.function.name] = tool({
        description: spec.function.description,
        inputSchema: jsonSchema(
          spec.function.parameters as Record<string, unknown> & { type: "object" }
        ),
      });
    }
    // Same assembly order as the real send (stream.ts allTools): MCP first,
    // then interactive asks, then render_ui. Cards ride render_ui alone.
    const renderUi = buildRenderUiTool({ onCard: () => {} });
    const tools: ToolSet = interactive
      ? { ...mcpTools, ...INTERACTIVE_TOOL_DEFS, ...renderUi }
      : cards
        ? { ...mcpTools, ...renderUi }
        : mcpTools;
    const hasTools = Object.keys(tools).length > 0;

    const messages: ChatUpstreamMessage[] = memCtx
      ? [{ role: "system", content: memCtx }, { role: "user", content: "." }]
      : [{ role: "user", content: "." }];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WARM_ABORT_AFTER_MS);
    try {
      // The very same serializer as /api/chat (AiModelFactory → compat
      // provider), so the upstream template input — tools + system block —
      // is byte-identical to the real first turn.
      const res = streamText({
        model: provider.languageModel(upstreamModel),
        messages: toModelMessages(messages),
        allowSystemInMessages: true,
        abortSignal: controller.signal,
        maxRetries: 0,
        ...(hasTools ? { tools, toolChoice: "auto" as const } : {}),
      });
      for await (const chunk of res.fullStream) {
        if (PREFILLED.has(chunk.type)) break;
      }
    } finally {
      clearTimeout(timer);
      controller.abort(); // detach the half-read body too
    }
  } catch {
    // Upstream errors, aborts and rejections all vanish: nothing to undo.
  }
}
