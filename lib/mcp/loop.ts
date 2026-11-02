// Tool-loop machinery shared by the SSE routes: accumulate fragmented
// `delta.tool_calls` parts, dispatch calls through the bridge, and rebuild
// persisted tool rounds (assistant `meta_json.tools`) into upstream messages
// so history stays tool-complete without new message rows.

import { openAiToolName, runToolCall, type ToolHandle } from "./bridge";
import type { UpstreamContentPart } from "@/lib/chat-attachments";
import type { GenerativeCard } from "@/lib/chat/generative";

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatUpstreamMessage = {
  role: string;
  content: string | UpstreamContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
};

/** Live SSE event. `args` rides along from the start and `result`/`ms` on the
 *  terminal event so both clients can render an expandable tool card without
 *  waiting for the thread re-sync (mirrors `ToolRoundRecord`). */
export type ToolEvent = {
  server: string;
  name: string;
  status: "running" | "done" | "error";
  args?: string;
  result?: string;
  ms?: number;
  /** Present (true) only when the result was cut at `mcp.toolResultMaxChars`
   *  — renders the amber warn chip live and after a thread reload. */
  truncated?: boolean;
  /** Generative UI (issue #16): set on the terminal event when the result was
   *  a valid `yasha_card` envelope — both clients render a structured card
   *  under the chip; old clients keep showing the raw result. */
  card?: GenerativeCard;
};
export type ToolRoundRecord = {
  server: string;
  name: string;
  ms: number;
  ok: boolean;
  args: string;
  result: string;
  truncated?: boolean;
  /** Persisted alongside the record (meta.tools) — same envelope as above. */
  card?: GenerativeCard;
  /** Protocol v3 interactive tool call (server "yasha"): `callId` is the
   *  client toolCallId the answer is validated against, `answered` flips when
   *  a validated output is overlaid (lib/chat/interactive.ts). `result` is
   *  the NO_ANSWER placeholder until then. */
  client?: boolean;
  callId?: string;
  answered?: boolean;
};

/** Accumulates `delta.tool_calls` fragments (index-keyed, args concatenated). */
export function createToolCallAccumulator(): {
  feed(toolCalls: unknown): void;
  calls(): OpenAiToolCall[];
} {
  const parts = new Map<number, { id?: string; name?: string; arguments: string }>();
  return {
    feed(toolCalls: unknown): void {
      if (!Array.isArray(toolCalls)) return;
      for (const raw of toolCalls) {
        if (!raw || typeof raw !== "object") continue;
        const tc = raw as {
          index?: unknown;
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        const index = typeof tc.index === "number" ? tc.index : 0;
        const slot = parts.get(index) ?? { arguments: "" };
        if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
        const fn = tc.function;
        if (fn && typeof fn === "object") {
          if (typeof fn.name === "string") slot.name = (slot.name ?? "") + fn.name;
          if (typeof fn.arguments === "string") slot.arguments += fn.arguments;
        }
        parts.set(index, slot);
      }
    },
    calls(): OpenAiToolCall[] {
      const out: OpenAiToolCall[] = [];
      for (const [, slot] of [...parts.entries()].sort((a, b) => a[0] - b[0])) {
        if (!slot.name) continue; // nameless argument-only fragments: ignore
        out.push({
          id: slot.id || `call_${out.length}`,
          type: "function",
          function: { name: slot.name, arguments: slot.arguments },
        });
      }
      return out;
    },
  };
}

/** Run one round of tool calls in parallel. Never rejects: failures come back
 *  as `ok: false` tool results (the model decides what to do next). */
export async function dispatchToolCalls(
  calls: OpenAiToolCall[],
  handles: Map<string, ToolHandle>,
  onEvent: (ev: ToolEvent) => void,
  signal?: AbortSignal,
): Promise<{ messages: ChatUpstreamMessage[]; records: ToolRoundRecord[] }> {
  const results = await Promise.all(
    calls.map(async (call) => {
      const handle = handles.get(call.function.name);
      if (!handle) {
        const content = `tool error: unknown tool ${call.function.name}`;
        onEvent({ server: "?", name: call.function.name, status: "error", args: call.function.arguments, result: content, ms: 0 });
        return {
          call,
          record: { server: "?", name: call.function.name, ms: 0, ok: false, args: call.function.arguments, result: content } satisfies ToolRoundRecord,
          content,
        };
      }
      onEvent({ server: handle.serverId, name: handle.tool, status: "running", args: call.function.arguments });
      const out = await runToolCall(handle, call.function.arguments, signal);
      // `truncated` is emitted only when true: unchanged turns stay byte-stable.
      const truncatedFlag = out.truncated ? { truncated: true } : {};
      onEvent({
        server: handle.serverId,
        name: handle.tool,
        status: out.ok ? "done" : "error",
        args: call.function.arguments,
        result: out.content,
        ms: out.ms,
        ...truncatedFlag,
      });
      return {
        call,
        record: {
          server: handle.serverId,
          name: handle.tool,
          ms: out.ms,
          ok: out.ok,
          args: call.function.arguments,
          result: out.content,
          ...truncatedFlag,
        },
        content: out.content,
      };
    }),
  );
  return {
    messages: [
      { role: "assistant", content: null, tool_calls: calls },
      ...results.map((r) => ({ role: "tool", content: r.content, tool_call_id: r.call.id })),
    ],
    records: results.map((r) => r.record),
  };
}

/** Ordered display parts of one assistant turn (issue #7): intermediate text
 *  segments interleaved with tool-round markers, in execution order. A `tools`
 *  part consumes the next `count` entries of the flat `meta.tools` list (which
 *  stays the execution-order source of truth — the upstream `expandToolRounds`
 *  / `synthesizeToolMessages` history is unchanged by this addition). */
export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "tools"; count: number };

/** Accumulates the interleaving of streamed assistant text and dispatched
 *  tool rounds for one assistant turn. */
export function createTurnParts(): {
  onText(delta: string): void;
  onToolRound(count: number): void;
  /** Ordered parts, or `undefined` when no tool round ran — without tool chips
   *  there is nothing to interleave and the flat text stays the display. */
  parts(): AssistantPart[] | undefined;
} {
  const parts: AssistantPart[] = [];
  let text = "";
  let hasRound = false;
  return {
    onText(delta) {
      text += delta;
    },
    onToolRound(count) {
      hasRound = true;
      if (text) {
        parts.push({ type: "text", text });
        text = "";
      }
      parts.push({ type: "tools", count });
    },
    parts() {
      if (!hasRound) return undefined;
      return text ? [...parts, { type: "text", text }] : [...parts];
    },
  };
}

/** Read persisted tool rounds out of an assistant message's meta_json. */
export function parseToolRounds(metaJson: string | null): ToolRoundRecord[] {
  if (!metaJson) return [];
  try {
    const meta = JSON.parse(metaJson) as { tools?: unknown };
    if (!Array.isArray(meta.tools)) return [];
    return meta.tools.filter(
      (t): t is ToolRoundRecord =>
        !!t &&
        typeof t === "object" &&
        typeof (t as ToolRoundRecord).server === "string" &&
        typeof (t as ToolRoundRecord).name === "string" &&
        typeof (t as ToolRoundRecord).args === "string" &&
        typeof (t as ToolRoundRecord).result === "string",
    );
  } catch {
    return [];
  }
}

/** Synthesize the OpenAI tool-call exchange for one stored assistant turn.
 *  Deterministic from stored data ⇒ byte-stable upstream history. Intermediate
 *  per-round assistant text is not stored (final content carries the answer). */
export function synthesizeToolMessages(rounds: ToolRoundRecord[]): ChatUpstreamMessage[] {
  const calls: OpenAiToolCall[] = rounds.map((r, i) => ({
    id: `call_${i}`,
    type: "function" as const,
    // Interactive records carry their declared (un-prefixed) tool name — the
    // live tool set declares exactly `ask_choice` / `confirm_action`.
    function: { name: r.client ? r.name : openAiToolName(r.server, r.name), arguments: r.args },
  }));
  return [
    { role: "assistant", content: null, tool_calls: calls },
    ...rounds.map((r, i) => ({ role: "tool", content: r.result, tool_call_id: `call_${i}` })),
  ];
}

/** Interleave stored tool rounds before their assistant messages. `upstream`
 *  is 1:1 with `rows` (pre-memory-injection window). */
export function expandToolRounds(
  rows: { role: string; metaJson: string | null }[],
  upstream: ChatUpstreamMessage[],
  // Which record kinds may be spliced back in: only what the model is being
  // offered right now (re-arming tokens for undeclared tools invites fake
  // calls — same rule for interactive records as for MCP ones).
  opts: { mcp: boolean; client: boolean },
): ChatUpstreamMessage[] {
  const out: ChatUpstreamMessage[] = [];
  rows.forEach((row, i) => {
    const msg = upstream[i];
    if (row.role === "assistant" && row.metaJson) {
      const rounds = parseToolRounds(row.metaJson).filter((r) => (r.client ? opts.client : opts.mcp));
      if (rounds.length > 0) {
        out.push(...synthesizeToolMessages(rounds));
        // The final text rides along after the exchange; a tool-cutoff message
        // (empty content) is fully represented by the synthesized block.
        if (typeof msg.content === "string" && msg.content === "") return;
      }
    }
    out.push(msg);
  });
  return out;
}
