// /api/chat stream assembly on the AI SDK (M2, docs/AI-SDK-MIGRATION-PLAN.MD).
//
// Transport contract (protocol v3 response stream, docs/protocol-v3.md §Response):
//   data-thread {threadId}        custom part, first frame of every turn
//   text-start / text-delta / text-end  assistant text (per-step remapped ids)
//   data-tool   ToolEvent         live tool-chip state machine (mirrors v1);
//               terminal events may carry `card` (issue #16 generative UI —
//               lib/chat/generative.ts), persisted on meta.tools entries
//   tool-input-start/delta/available    interactive asks (ask_choice /
//               confirm_action) forwarded as STANDARD tool chunks; the client
//               answers via useChat's addToolOutput (docs/protocol-v3.md)
//   data-error  {code}            terminal failure (timeout / upstream_* / empty_response)
//   [DONE]      by createUIMessageStreamResponse; keepAliveMs carries the
//               idle-proxy heartbeat (replaces the hand-rolled `: ping`).
//
// Deliberately dropped at the seam: reasoning parts (AGENTS rule 1 — only
// content is forwarded/persisted), MCP tool-* chunks (chips ride data-tool),
// and start/finish bookkeeping. Persistence semantics are unchanged from v1:
// success → assistant row; mid-stream death with output → partial row
// (`aborted: true`); no output → error marked on the user message.

import { eq } from "drizzle-orm";
import {
  APICallError,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { db } from "@/lib/db";
import { messages, threads } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { mcpMaxToolRounds, memoryEnabled, resolveEventConfig } from "@/lib/settings";
import { getUserMemoryEnabled } from "@/lib/memory/prefs";
import { createAiToolLoop } from "@/lib/mcp/ai-tools";
import { createTurnParts, type ToolRoundRecord } from "@/lib/mcp/loop";
import type { Toolset } from "@/lib/mcp/bridge";
import {
  INTERACTIVE_SERVER,
  INTERACTIVE_TOOL_DEFS,
  NO_ANSWER,
  createPendingActions,
  isInteractiveToolName,
  type InteractiveToolName,
} from "@/lib/chat/interactive";

export type ChatStreamOpts = {
  req: Request;
  /** Aborts the upstream call on client disconnect or first-token timeout. */
  controller: AbortController;
  userId: string;
  threadId: string;
  userMsgId: string;
  /** Attachment meta of the persisted user message (re-serialized on failure). */
  userMeta: Record<string, unknown>;
  model: string;
  languageModel: LanguageModelV4;
  modelMessages: ModelMessage[];
  toolset: Toolset;
  /** Protocol v3 (docs/protocol-v3.md): the surface can answer interactive
   *  tool cards, so ask_choice/confirm_action join the tool set and their
   *  tool-input-* chunks are forwarded (pending rows land at persist time).
   *  False ⇒ the model never sees those tools. */
  interactive: boolean;
  newThread: boolean;
  firstTokenTimeoutMs: number;
  heartbeatMs: number;
  /** A 4xx with tools attached: remember so later turns skip injection. */
  onToolsRejected: () => void;
  release: () => void;
};

// streamText's own lifecycle parts: emitted by the SDK loop even when the
// upstream call never opened an HTTP response (connect failure), so they must
// NOT count as evidence that a response stream started.
const LIFECYCLE_CHUNKS = new Set(["start", "start-step", "finish-step", "finish", "abort"]);

export function buildChatResponse(opts: ChatStreamOpts): Response {
  const state = {
    assistantText: "",
    usage: null as Record<string, unknown> | null,
    errorCode: null as string | null,
    httpStatus: null as number | null,
    firstTokenSeen: false,
    responseStarted: false,
    timedOut: false,
    clientAborted: false,
  };
  const toolRecords: ToolRoundRecord[] = [];
  // Execution-order interleaving of text and tool rounds (issue #7) — same
  // accumulator as v1, persisted verbatim in meta.parts.
  const turnParts = createTurnParts();
  const toolsMeta = (): Record<string, unknown> => {
    const parts = turnParts.parts();
    return parts ? { tools: toolRecords, parts } : {};
  };

  // Failed turns keep the user message and annotate its meta with the error
  // code so both clients render a persistent "retry?" notice after reload.
  const markFailed = (code: string) =>
    db
      .update(messages)
      .set({ metaJson: JSON.stringify({ ...opts.userMeta, error: code }) })
      .where(eq(messages.id, opts.userMsgId))
      .run();

  // Called only from onEnd, and only with non-empty assistantText (each
  // branch below checks) — onEnd fires exactly once, so no latch is needed.
  const persist = async (extra: Record<string, unknown>) => {
    const now = new Date();
    const assistantMsgId = crypto.randomUUID();
    await db
      .insert(messages)
      .values({
        id: assistantMsgId,
        threadId: opts.threadId,
        role: "assistant",
        content: state.assistantText,
        metaJson: JSON.stringify({ model: opts.model, usage: state.usage, ...toolsMeta(), ...extra }),
        createdAt: now,
      })
      .run();
    await db.update(threads).set({ updatedAt: now }).where(eq(threads.id, opts.threadId)).run();
    // Interactive asks (protocol v3): the client can only answer what was
    // rendered, and answers are only accepted against these rows.
    const asks = toolRecords.filter((r) => r.client && r.callId);
    if (asks.length > 0) {
      createPendingActions(
        { threadId: opts.threadId, userId: opts.userId, messageId: assistantMsgId },
        asks.map((r) => ({ toolCallId: r.callId!, tool: r.name as InteractiveToolName, args: r.args })),
        now,
      );
    }
    // Fire-and-forget, INSERT-only: zero latency added to the SSE path.
    if (opts.newThread && resolveEventConfig("chat.title_generation").schedule === "after_persist") {
      void enqueueJob({
        type: "chat.title_generation",
        threadId: opts.threadId,
        userId: opts.userId,
        payload: { fromMessageId: opts.userMsgId },
      }).catch(() => {
        /* queue best-effort */
      });
    }
    if (memoryEnabled() && getUserMemoryEnabled(opts.userId)) {
      for (const type of ["memory.fact_extraction", "memory.thread_summary"] as const) {
        const cfg = resolveEventConfig(type);
        if (!cfg.enabled || cfg.schedule !== "after_persist") continue;
        void enqueueJob({
          type,
          threadId: opts.threadId,
          userId: opts.userId,
          payload: { fromMessageId: opts.userMsgId },
        }).catch(() => {
          /* queue best-effort */
        });
      }
    }
  };

  const onClientAbort = () => {
    state.clientAborted = true;
    opts.controller.abort();
  };
  opts.req.signal.addEventListener("abort", onClientAbort);

  // v1 error-code mapping over SDK errors: provider HTTP failures keep the
  // upstream_status_N shape; an SDK-wrapped mid-stream death carries the
  // ORIGINAL 2xx status (response-handler wraps pull errors, 2xx + error =
  // stream failure); a parse-level failure after the response opened (no
  // status) is likewise a stream failure; anything else (fetch-level throw,
  // no status) is a connect failure. Aborts never come through here: a
  // signal-driven death always surfaces as an `abort` chunk, handled by the
  // loop's abort arm (timeout) and onEnd (partial persist).
  const errorToCode = (error: unknown): string => {
    if (error instanceof APICallError && typeof error.statusCode === "number")
      return error.statusCode >= 200 && error.statusCode < 300
        ? "upstream_stream"
        : `upstream_status_${error.statusCode}`;
    return state.responseStarted ? "upstream_stream" : "upstream_connect";
  };

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const send = (chunk: UIMessageChunk) => {
        try {
          writer.write(chunk);
        } catch {
          /* client gone */
        }
      };
      send({ type: "data-thread", data: { threadId: opts.threadId } });

      const maxRounds = mcpMaxToolRounds();
      let roundsDispatched = 0;
      const toolLoop = createAiToolLoop({
        toolset: opts.toolset,
        sendEvent: (ev) => send({ type: "data-tool", data: ev }),
        canDispatch: () => roundsDispatched < maxRounds,
      });
      // Interactive asks are recorded into `toolRecords` in stream order (so
      // meta.tools, parts interleaving and the pending rows all agree).
      const interactiveToolCalls = new Set<string>();
      const allTools = opts.interactive
        ? { ...(toolLoop.tools ?? {}), ...INTERACTIVE_TOOL_DEFS }
        : toolLoop.tools;

      // First-token timeout: aborts the upstream call when no delta arrives.
      // clearTimeout is idempotent, so no null-ing dance is needed.
      const timeout = setTimeout(() => {
        state.timedOut = true;
        opts.controller.abort();
      }, opts.firstTokenTimeoutMs);
      const clearFirstTokenTimer = () => {
        clearTimeout(timeout);
        state.firstTokenSeen = true;
      };

      let useTools = allTools !== undefined;
      let attempt = 0;
      for (;;) {
        attempt += 1;
        let textSeq = 0;
        const textIds = new Map<string, string>();
        // The compat provider reuses "txt-0" across model calls; parts must be
        // unique for the whole UI stream, so ids are remapped per attempt.
        const remap = (id: string): string => {
          let mapped = textIds.get(id);
          if (!mapped) {
            mapped = `t${textSeq++}`;
            textIds.set(id, mapped);
          }
          return mapped;
        };

        const res = streamText({
          model: opts.languageModel,
          messages: opts.modelMessages,
          allowSystemInMessages: true,
          abortSignal: opts.controller.signal,
          maxRetries: 0,
          ...(useTools && allTools
            ? {
                tools: allTools,
                toolChoice: "auto" as const,
                // max tool-dispatch rounds + one final answering call; the
                // per-round dispatch budget itself lives in canDispatch above.
                stopWhen: stepCountIs(maxRounds + 1),
              }
            : {}),
          onError: ({ error }) => {
            if (error instanceof APICallError && typeof error.statusCode === "number")
              state.httpStatus = error.statusCode;
          },
          onChunk: ({ chunk }) => {
            toolLoop.feedChunk(chunk);
            if (
              !state.firstTokenSeen &&
              (chunk.type === "text-delta" || chunk.type === "tool-input-start")
            )
              clearFirstTokenTimer();
            if (chunk.type === "text-delta") {
              state.assistantText += chunk.text;
              turnParts.onText(chunk.text);
            }
          },
          onStepEnd: (step) => {
            const round = toolLoop.takeRound(step.toolCalls);
            if (round.length > 0) {
              roundsDispatched += 1;
              toolRecords.push(...round);
              turnParts.onToolRound(round.length);
            }
          },
        });

        try {
          for await (const chunk of res.fullStream) {
            // Model-produced chunks prove an opened response stream — the
            // connect/stream error split (lifecycle parts do not).
            if (chunk.type !== "error" && !LIFECYCLE_CHUNKS.has(chunk.type))
              state.responseStarted = true;
            if (chunk.type === "text-start") send({ type: "text-start", id: remap(chunk.id) });
            else if (chunk.type === "text-delta")
              send({ type: "text-delta", id: remap(chunk.id), delta: chunk.text });
            else if (chunk.type === "text-end") send({ type: "text-end", id: remap(chunk.id) });
            else if (
              opts.interactive &&
              chunk.type === "tool-input-start" &&
              isInteractiveToolName(chunk.toolName)
            ) {
              // Interactive asks ride STANDARD tool chunks (docs/protocol-v3.md):
              // useChat turns them into typed tool parts the client answers.
              interactiveToolCalls.add(chunk.id);
              send({ type: "tool-input-start", toolCallId: chunk.id, toolName: chunk.toolName });
            } else if (
              opts.interactive &&
              chunk.type === "tool-input-delta" &&
              interactiveToolCalls.has(chunk.id)
            ) {
              send({ type: "tool-input-delta", toolCallId: chunk.id, inputTextDelta: chunk.delta });
            } else if (
              opts.interactive &&
              chunk.type === "tool-call" &&
              isInteractiveToolName(chunk.toolName)
            ) {
              // The loop stops here (no execute): record the ask in stream
              // order, then announce the finished input to the client. Args
              // come from the SDK-parsed input (interactive args need no
              // verbatim-delta fidelity: the record is written once, then
              // replayed byte-stably from storage).
              interactiveToolCalls.delete(chunk.toolCallId);
              toolRecords.push({
                server: INTERACTIVE_SERVER,
                name: chunk.toolName,
                ms: 0,
                ok: true,
                args: JSON.stringify(chunk.input),
                result: NO_ANSWER,
                client: true,
                callId: chunk.toolCallId,
                answered: false,
              });
              turnParts.onToolRound(1);
              send({
                type: "tool-input-available",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              });
            } else if (chunk.type === "error") {
              state.errorCode ??= errorToCode(chunk.error);
              break;
            } else if (chunk.type === "abort") {
              // First-token timeout aborts through the same signal: without a
              // single delta this is the v1 "timeout" failure, not a client abort.
              if (state.timedOut && !state.firstTokenSeen) state.errorCode ??= "timeout";
              break;
            }
            // All other chunks are dropped on purpose (see header comment).
          }
        } catch (error) {
          state.errorCode ??= errorToCode(error);
        }

        // Aborts can land between the last tool execution and its step-end
        // callback: drain whatever onStepEnd did not claim so the partial row
        // keeps its tool records and the text/tools interleaving (v1 parity).
        const unclaimed = toolLoop.flushRemaining();
        if (unclaimed.length > 0) {
          roundsDispatched += 1;
          toolRecords.push(...unclaimed);
          turnParts.onToolRound(unclaimed.length);
        }

        try {
          const usage = await res.totalUsage;
          // meta.usage keeps the v1 shape: the raw wire usage object, null
          // when the provider sent none (SDK wrapper object otherwise).
          state.usage = (usage.raw as Record<string, unknown> | undefined) ?? null;
        } catch {
          /* usage is best-effort metadata */
        }

        // Capability degradation (once per request): a 4xx before any delta
        // with tools attached means the model rejects tool calling — retry
        // without tools and remember the model id.
        if (
          attempt === 1 &&
          useTools &&
          !state.firstTokenSeen &&
          state.httpStatus !== null &&
          state.httpStatus >= 400 &&
          state.httpStatus < 500
        ) {
          useTools = false;
          state.errorCode = null;
          opts.onToolsRejected();
          continue;
        }
        break;
      }

      if (state.errorCode) send({ type: "data-error", data: { code: state.errorCode } });
      // An interactive ask IS output: a turn that ends on a question is not
      // an empty response.
      else if (!state.clientAborted && state.assistantText.length === 0 && !toolRecords.some((r) => r.client))
        send({ type: "data-error", data: { code: "empty_response" } });

      clearTimeout(timeout);
    },
    // No onError hook here: every failure inside execute() is already caught
    // and mapped (error codes ride data-error parts); a thrown execute would
    // only mean a broken invariant, which the SDK's sanitized default covers.
    onEnd: async ({ isAborted }) => {
      const aborted = state.clientAborted || isAborted;
      try {
        if (state.errorCode) {
          // v1 mapping: partial output → aborted row; nothing → markFailed.
          if (state.assistantText.length > 0) await persist({ aborted: true });
          else await markFailed(state.errorCode);
        } else if (aborted) {
          if (state.assistantText.length > 0) await persist({ aborted: true });
          // No interactive exemption here: the SDK emits tool-call parts only
          // when the upstream stream CLOSES, so an aborted stream never has
          // ask records to persist. A question cut off mid-stream is retried
          // as a fresh turn (its answers gate 409 with nothing stored).
        } else if (state.assistantText.length === 0 && !toolRecords.some((r) => r.client)) {
          await markFailed("empty_response");
        } else {
          await persist({});
        }
      } catch {
        /* persistence best-effort */
      }
      opts.req.signal.removeEventListener("abort", onClientAbort);
      opts.release();
    },
  });

  const response = createUIMessageStreamResponse({
    stream,
    keepAliveMs: opts.heartbeatMs,
    headers: {
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });

  // Consumer cancel without a req abort (tab close racing the request): mirrors
  // the v1 ReadableStream.cancel() arm. Flag + abort go first so the execute's
  // onEnd (driven by the abort) persists the partial as `aborted: true` and
  // releases the slot — success persistence can never win that race.
  const reader = response.body!.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    pull: async (ctrl) => {
      const { done, value } = await reader.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel: (reason) => {
      state.clientAborted = true;
      opts.controller.abort();
      return reader.cancel(reason);
    },
  });
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
