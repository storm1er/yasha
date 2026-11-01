// MCP toolset → AI SDK tool set (M2). Each spec becomes an AI SDK tool whose
// execute dispatches through the same bridge `dispatchToolCalls` used — same
// events (client tool chips), same ToolRoundRecords (meta.tools), same result
// string fed back to the model. Raw argument text is captured from the model's
// own tool-input deltas (onChunk → feedChunk) so records keep the verbatim
// args string exactly like the pre-migration loop; execute falls back to the
// SDK-parsed input when no deltas were seen.

import { jsonSchema, tool, type ToolSet } from "ai";
import type { ToolEvent, ToolRoundRecord } from "./loop";
import type { Toolset } from "./bridge";
import { runToolCall } from "./bridge";
import { extractToolCard } from "@/lib/chat/generative";

export type AiToolLoop = {
  /** AI SDK tool set; `undefined` when no MCP tools are attached. */
  tools: ToolSet | undefined;
  /** Feed every streamText chunk (consumes tool-input-delta for raw args). */
  feedChunk(chunk: { type: string; [key: string]: unknown }): void;
  /**
   * Drain the round's records at step end, in the model's call order.
   * Also prunes raw-arg state for the drained calls.
   */
  takeRound(calls: ReadonlyArray<{ toolCallId: string }>): ToolRoundRecord[];
  /**
   * Drain every still-unclaimed record in execution-completion order.
   * An abort can kill the SDK loop between the last tool execution and its
   * step-end bookkeeping; without this flush the partial row would lose the
   * round's records (v1 dispatched them synchronously and kept them).
   */
  flushRemaining(): ToolRoundRecord[];
};

export function createAiToolLoop(opts: {
  toolset: Toolset;
  sendEvent: (ev: ToolEvent) => void;
  /** False once the tool-round budget is spent: calls are then silently
   *  discarded (no bridge call, no event, no record) exactly like the v1
   *  loop's `round >= mcpMaxToolRounds()` break. */
  canDispatch: () => boolean;
}): AiToolLoop {
  const rawArgs = new Map<string, string>();
  const records = new Map<string, ToolRoundRecord>();
  const tools: ToolSet = {};

  for (const spec of opts.toolset.specs) {
    // buildToolset keeps specs and handles in lockstep, so the lookup hits.
    const handle = opts.toolset.handles.get(spec.function.name)!;
    tools[spec.function.name] = tool({
      description: spec.function.description,
      inputSchema: jsonSchema(spec.function.parameters as Record<string, unknown> & { type: "object" }),
      execute: async (input, { toolCallId, abortSignal }) => {
        if (!opts.canDispatch()) return "tool round limit reached";
        const raw = rawArgs.get(toolCallId) ?? JSON.stringify(input ?? {});
        opts.sendEvent({ server: handle.serverId, name: handle.tool, status: "running", args: raw });
        const out = await runToolCall(handle, raw, abortSignal);
        // `truncated` only when true — unchanged turns stay byte-stable.
        const truncatedFlag = out.truncated ? { truncated: true } : {};
        // Generative UI (issue #16): a valid yasha_card envelope rides the
        // terminal event and the persisted record; the raw JSON keeps flowing
        // to the model untouched, and old clients ignore the extra field.
        const card = out.ok ? extractToolCard(out.content) : null;
        const cardFlag = card ? { card } : {};
        opts.sendEvent({
          server: handle.serverId,
          name: handle.tool,
          status: out.ok ? "done" : "error",
          args: raw,
          result: out.content,
          ms: out.ms,
          ...truncatedFlag,
          ...cardFlag,
        });
        records.set(toolCallId, {
          server: handle.serverId,
          name: handle.tool,
          ms: out.ms,
          ok: out.ok,
          args: raw,
          result: out.content,
          ...truncatedFlag,
          ...cardFlag,
        });
        return out.content;
      },
    });
  }

  return {
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    feedChunk(chunk) {
      if (chunk.type === "tool-input-delta") {
        const id = chunk.id as string;
        rawArgs.set(id, (rawArgs.get(id) ?? "") + (chunk.delta as string));
      }
    },
    takeRound(calls) {
      const out: ToolRoundRecord[] = [];
      for (const call of calls) {
        const record = records.get(call.toolCallId);
        if (record) {
          out.push(record);
          records.delete(call.toolCallId);
          rawArgs.delete(call.toolCallId);
        }
        // No record = the call never executed (bad model-side args):
        // no chip, no record — the model already received the SDK's error.
      }
      return out;
    },
    flushRemaining() {
      const out = [...records.values()];
      for (const toolCallId of [...records.keys()]) {
        records.delete(toolCallId);
        rawArgs.delete(toolCallId);
      }
      return out;
    },
  };
}
