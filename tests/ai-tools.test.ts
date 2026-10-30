// Unit tests for the MCP → AI SDK tool wrapper (M2 seam).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAiToolLoop } from "@/lib/mcp/ai-tools";
import { runToolCall, type ToolHandle, type Toolset } from "@/lib/mcp/bridge";
import type { ToolEvent } from "@/lib/mcp/loop";

vi.mock("@/lib/mcp/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/bridge")>();
  return { ...actual, runToolCall: vi.fn() };
});

const mockedRun = vi.mocked(runToolCall);

function makeToolset(n = 1): Toolset {
  const names = Array.from({ length: n }, (_, i) => (i === 0 ? "t1" : `t${i + 1}`));
  return {
    specs: names.map((name) => ({
      type: "function" as const,
      function: { name, description: `desc ${name}`, parameters: { type: "object" } },
    })),
    handles: new Map<string, ToolHandle>(
      names.map((name) => [name, { serverId: "srv", tool: name, title: name, userId: "u" }])
    ),
  };
}

type ExecutableTool = { execute?: (input: unknown, opts: unknown) => Promise<string> };

let events: ToolEvent[];
let loop: ReturnType<typeof createAiToolLoop>;

beforeEach(() => {
  mockedRun.mockReset();
  events = [];
  loop = createAiToolLoop({ toolset: makeToolset(), sendEvent: (e) => events.push(e), canDispatch: () => true });
});

describe("createAiToolLoop", () => {
  it("no specs → no toolset", () => {
    const empty = createAiToolLoop({ toolset: { specs: [], handles: new Map() }, sendEvent: () => {}, canDispatch: () => true });
    expect(empty.tools).toBeUndefined();
  });

  it("registers every spec as a tool", () => {
    const wide = createAiToolLoop({ toolset: makeToolset(3), sendEvent: () => {}, canDispatch: () => true });
    expect(Object.keys(wide.tools!)).toEqual(["t1", "t2", "t3"]);
  });

  it("execute: running+done events, record, result passthrough", async () => {
    mockedRun.mockResolvedValue({ content: "the answer", ok: true, ms: 7 });
    const tool = loop.tools!.t1 as ExecutableTool;
    const out = await tool.execute!({ q: "x" }, { toolCallId: "c1", abortSignal: undefined });
    expect(out).toBe("the answer");
    expect(events).toEqual([
      { server: "srv", name: "t1", status: "running", args: '{"q":"x"}' },
      { server: "srv", name: "t1", status: "done", args: '{"q":"x"}', result: "the answer", ms: 7 },
    ]);
    const records = loop.takeRound([{ toolCallId: "c1" }]);
    expect(records).toEqual([{ server: "srv", name: "t1", ms: 7, ok: true, args: '{"q":"x"}', result: "the answer" }]);
    expect(loop.takeRound([{ toolCallId: "c1" }])).toEqual([]); // drained
  });

  it("raw argument deltas win over the parsed input", async () => {
    mockedRun.mockResolvedValue({ content: "r", ok: true, ms: 1 });
    loop.feedChunk({ type: "text-delta", id: "x", text: "ignored" });
    loop.feedChunk({ type: "tool-input-delta", id: "c9", delta: '{ "raw" : ' });
    loop.feedChunk({ type: "tool-input-delta", id: "c9", delta: "true }" });
    const tool = loop.tools!.t1 as ExecutableTool;
    await tool.execute!({ raw: true }, { toolCallId: "c9", abortSignal: undefined });
    expect(mockedRun.mock.calls[0][1]).toBe('{ "raw" : true }');
  });

  it("missing input falls back to {} JSON", async () => {
    mockedRun.mockResolvedValue({ content: "r", ok: false, ms: 2 });
    const tool = loop.tools!.t1 as ExecutableTool;
    await tool.execute!(undefined, { toolCallId: "c2", abortSignal: undefined });
    expect(mockedRun.mock.calls[0][1]).toBe("{}");
    expect(events[1]).toMatchObject({ status: "error" });
    const records = loop.takeRound([{ toolCallId: "c2" }]);
    expect(records[0]).toMatchObject({ ok: false, args: "{}" });
  });

  it("truncated is flagged on both event and record (issue #8)", async () => {
    mockedRun.mockResolvedValue({ content: "cut", ok: true, ms: 3, truncated: true });
    const tool = loop.tools!.t1 as ExecutableTool;
    await tool.execute!({}, { toolCallId: "c3", abortSignal: undefined });
    expect(events[1]).toMatchObject({ truncated: true });
    expect(loop.takeRound([{ toolCallId: "c3" }])[0]).toMatchObject({ truncated: true });
  });

  it("budget guard: no dispatch past the round cap (silent discard)", async () => {
    let allowed = true;
    const guarded = createAiToolLoop({
      toolset: makeToolset(),
      sendEvent: (e) => events.push(e),
      canDispatch: () => allowed,
    });
    mockedRun.mockResolvedValue({ content: "first", ok: true, ms: 1 });
    const tool = guarded.tools!.t1 as ExecutableTool;
    await tool.execute!({}, { toolCallId: "a", abortSignal: undefined });
    allowed = false;
    const out = await tool.execute!({}, { toolCallId: "b", abortSignal: undefined });
    expect(out).toBe("tool round limit reached");
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(2); // only the first call emitted events
    expect(guarded.takeRound([{ toolCallId: "a" }, { toolCallId: "b" }])).toHaveLength(1);
  });

  it("takeRound skips calls that never executed", () => {
    expect(loop.takeRound([{ toolCallId: "ghost" }])).toEqual([]);
  });

  it("flushRemaining drains unclaimed records (abort before step-end)", async () => {
    mockedRun.mockResolvedValue({ content: "r1", ok: true, ms: 1 });
    loop.feedChunk({ type: "tool-input-delta", id: "x1", delta: "{}" });
    const tool = loop.tools!.t1 as ExecutableTool;
    await tool.execute!({}, { toolCallId: "x1", abortSignal: undefined });
    const flushed = loop.flushRemaining();
    expect(flushed).toEqual([{ server: "srv", name: "t1", ms: 1, ok: true, args: "{}", result: "r1" }]);
    expect(loop.flushRemaining()).toEqual([]); // drained, incl. raw-arg state
    expect(loop.takeRound([{ toolCallId: "x1" }])).toEqual([]);
  });
});
