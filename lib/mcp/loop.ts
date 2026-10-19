// Tool-loop machinery shared by the SSE routes: accumulate fragmented
// `delta.tool_calls` parts, dispatch calls through the bridge, and rebuild
// persisted tool rounds (assistant `meta_json.tools`) into upstream messages
// so history stays tool-complete without new message rows.

import { openAiToolName, runToolCall, type ToolHandle } from "./bridge";
import type { UpstreamContentPart } from "@/lib/chat-attachments";

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
};
export type ToolRoundRecord = {
  server: string;
  name: string;
  ms: number;
  ok: boolean;
  args: string;
  result: string;
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
      onEvent({
        server: handle.serverId,
        name: handle.tool,
        status: out.ok ? "done" : "error",
        args: call.function.arguments,
        result: out.content,
        ms: out.ms,
      });
      return {
        call,
        record: { server: handle.serverId, name: handle.tool, ms: out.ms, ok: out.ok, args: call.function.arguments, result: out.content },
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
    function: { name: openAiToolName(r.server, r.name), arguments: r.args },
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
): ChatUpstreamMessage[] {
  const out: ChatUpstreamMessage[] = [];
  rows.forEach((row, i) => {
    const msg = upstream[i];
    if (row.role === "assistant" && row.metaJson) {
      const rounds = parseToolRounds(row.metaJson);
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
