// Unit tests for the resume-stream replay hub (lib/chat/replay.ts, issue #33).

import { describe, expect, it, vi } from "vitest";
import {
  SSE_HEADERS,
  attachReplay,
  isGenerating,
  killReplay,
  openReplay,
  sseResponse,
} from "@/lib/chat/replay";

const U = "u-replay";

/** Drain a view into its frames without blocking on close. */
function collect(rs: ReadableStream<string>) {
  const out: string[] = [];
  const reader = rs.getReader();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  })();
  return { out, pump };
}

describe("replay hub", () => {
  it("buffers frames; a view replays from zero and receives live appends", async () => {
    const sink = openReplay(U, "t1", undefined, () => {});
    sink.frame("data: a\n\n");
    const { out, pump } = collect(sink.view());
    sink.frame("data: b\n\n");
    sink.close();
    await pump;
    expect(out.join("")).toBe("data: a\n\ndata: b\n\ndata: [DONE]\n\n");
  });

  it("attachReplay joins the live hub, is null after close; isGenerating follows", async () => {
    const sink = openReplay(U, "t2", undefined, () => {});
    expect(isGenerating(U, "t2")).toBe(true);
    sink.frame("data: x\n\n");
    const { out, pump } = collect(attachReplay(U, "t2")!);
    sink.close();
    await pump;
    expect(out.join("")).toBe("data: x\n\ndata: [DONE]\n\n");
    expect(attachReplay(U, "t2")).toBeNull();
    expect(isGenerating(U, "t2")).toBe(false);
  });

  it("other users and other threads never see the hub", () => {
    const sink = openReplay(U, "t3", undefined, () => {});
    expect(attachReplay("someone-else", "t3")).toBeNull();
    expect(attachReplay(U, "other-thread")).toBeNull();
    sink.close();
  });

  it("cancelling a view only unsubscribes — the hub keeps buffering", async () => {
    const sink = openReplay(U, "t4", undefined, () => {});
    const reader = sink.view().getReader();
    sink.frame("data: a\n\n");
    expect((await reader.read()).value).toBe("data: a\n\n");
    await reader.cancel();
    sink.frame("data: b\n\n");
    const { out, pump } = collect(sink.view());
    sink.close();
    await pump;
    expect(out.join("")).toBe("data: a\n\ndata: b\n\ndata: [DONE]\n\n");
  });

  it("killReplay runs the hook exactly while running; false once closed", () => {
    let killed = 0;
    const sink = openReplay(U, "t5", undefined, () => killed++);
    expect(killReplay(U, "t5")).toBe(true);
    expect(killed).toBe(1);
    sink.close();
    expect(killReplay(U, "t5")).toBe(false);
    expect(killed).toBe(1);
  });

  it("reopening a thread kills the stale hub; the stale sink cannot evict the successor", () => {
    let killed = 0;
    const stale = openReplay(U, "t6", undefined, () => killed++);
    const fresh = openReplay(U, "t6", undefined, () => killed++);
    expect(killed).toBe(1); // safety net for a hub whose stream never ended
    stale.close();
    expect(isGenerating(U, "t6")).toBe(true);
    fresh.close();
    expect(isGenerating(U, "t6")).toBe(false);
  });

  it("heartbeat: stream-open frames the buffer; pings flow only while draining", async () => {
    vi.useFakeTimers();
    const sink = openReplay(U, "t7", 50, () => {});
    sink.frame("data: a\n\n");
    sink.frame("data: b\n\n");
    const reader = sink.view().getReader();
    // Queue ahead of the reader (desiredSize <= 0): the first tick pings nobody.
    await vi.advanceTimersByTimeAsync(50);
    expect((await reader.read()).value).toBe(": stream-open\n\n");
    expect((await reader.read()).value).toBe("data: a\n\n");
    expect((await reader.read()).value).toBe("data: b\n\n");
    // Drained again → the next tick reaches the view.
    await vi.advanceTimersByTimeAsync(50);
    expect((await reader.read()).value).toBe(": keep-alive\n\n");
    sink.close();
    vi.useRealTimers();
  });

  it("no heartbeat → no stream-open frame; views see data only", async () => {
    const sink = openReplay(U, "t8", undefined, () => {});
    sink.frame("data: a\n\n");
    const { out, pump } = collect(sink.view());
    sink.close();
    await pump;
    expect(out[0]).toBe("data: a\n\n");
  });

  it("fan-out cap: attach yields null past MAX_VIEWS; sink.view() falls back to a closed stream", async () => {
    const sink = openReplay(U, "t9", undefined, () => {});
    const held = Array.from({ length: 8 }, () => sink.view()); // POST + 7 reattaches
    expect(attachReplay(U, "t9")).toBeNull();
    const fallback = sink.view();
    expect((await fallback.getReader().read()).done).toBe(true);
    sink.close();
    void held;
  });

  it("sseResponse carries the SDK-compatible SSE headers", () => {
    const empty = new ReadableStream<string>({ start: (c) => c.close() });
    const res = sseResponse(empty);
    for (const [k, v] of Object.entries(SSE_HEADERS)) expect(res.headers.get(k)).toBe(v);
  });
});
