// Unit tests for the M4 client message mapper (lib/chat/ui-messages.ts):
// stored thread rows ⇄ UIMessages ⇄ the renderer's ChatMessage model.

import { describe, expect, it } from "vitest";
import {
  captionPending,
  lastTurnErrored,
  messageText,
  projectMessages,
  storedToUiMessages,
  threadIdFromMessages,
  type ChatMessageMeta,
  type ServerMessage,
  type ToolChip,
  type YashaUIMessage,
} from "@/lib/chat/ui-messages";

const chip = (over: Partial<ToolChip> = {}): ToolChip => ({
  server: "ketch",
  name: "search",
  status: "running",
  ...over,
});

const msg = (over: Partial<YashaUIMessage> & Pick<YashaUIMessage, "role">): YashaUIMessage => ({
  id: `m-${over.role}-${Math.random().toString(36).slice(2, 8)}`,
  parts: [],
  ...over,
});

const text = (t: string) => ({ type: "text" as const, text: t });
const tool = (c: ToolChip) => ({ type: "data-tool" as const, data: c });
const thread = (threadId: string) => ({ type: "data-thread" as const, data: { threadId } });
const fail = (code: string) => ({ type: "data-error" as const, data: { code } });

describe("messageText", () => {
  it("empty for undefined and non-text parts", () => {
    expect(messageText(undefined)).toBe("");
    expect(
      messageText(
        msg({ role: "user", parts: [thread("t1"), text("a"), text("b"), fail("x")] as never }),
      )
    ).toBe("ab");
  });
});

describe("captionPending", () => {
  it("only audio rows without an outcome are pending", () => {
    expect(captionPending({ id: "1", role: "user", content: "hi", meta: null })).toBe(false);
    expect(captionPending({ id: "2", role: "user", content: "hi", meta: {} })).toBe(false);
    expect(
      captionPending({ id: "3", role: "user", content: "hi", meta: { audio: "data:audio/wav;base64,AA==" } })
    ).toBe(true);
    expect(
      captionPending({
        id: "4",
        role: "user",
        content: "hi",
        meta: { audio: "a", audioTranscript: "done" },
      })
    ).toBe(false);
    expect(
      captionPending({ id: "5", role: "user", content: "hi", meta: { audio: "a", audioTranscriptFailed: true } })
    ).toBe(false);
  });
});

describe("threadIdFromMessages / lastTurnErrored", () => {
  it("finds the announced thread id or none", () => {
    expect(threadIdFromMessages([])).toBeNull();
    expect(threadIdFromMessages([msg({ role: "user", parts: [text("hi")] })])).toBeNull();
    expect(threadIdFromMessages([msg({ role: "assistant", parts: [thread("t9"), text("yo")] })])).toBe("t9");
  });

  it("detects the terminal error part on the LAST assistant message only", () => {
    expect(lastTurnErrored([])).toBe(false);
    expect(lastTurnErrored([msg({ role: "assistant", parts: [fail("timeout")] })])).toBe(true);
    expect(lastTurnErrored([msg({ role: "assistant", parts: [fail("timeout")] }), msg({ role: "user" })])).toBe(false);
    expect(lastTurnErrored([msg({ role: "assistant", parts: [text("ok")] })])).toBe(false);
  });
});

describe("storedToUiMessages", () => {
  it("maps user rows: content + filtered metadata", () => {
    const row: ServerMessage = {
      id: "u1",
      role: "user",
      content: "hello",
      meta: {
        images: ["data:image/png;base64,AAA", 42],
        audio: "data:audio/wav;base64,BBB",
        audioTranscript: " transcript ",
        audioTranscriptFailed: true,
        error: "upstream_connect",
      },
    };
    const [m] = storedToUiMessages([row]);
    expect(m.id).toBe("u1");
    expect(m.role).toBe("user");
    expect(m.parts).toEqual([text("hello")]);
    expect(m.metadata).toEqual({
      images: ["data:image/png;base64,AAA"],
      audio: "data:audio/wav;base64,BBB",
      audioTranscript: " transcript ",
      audioTranscriptFailed: true,
      turnError: "upstream_connect",
    });
  });

  it("user row without meta/content → no parts, empty metadata", () => {
    const [m] = storedToUiMessages([{ id: "u2", role: "user", content: "", meta: null }]);
    expect(m.parts).toEqual([]);
    expect(m.metadata).toEqual({});
  });

  it("ignores non-array images and all-junk image entries", () => {
    const [a] = storedToUiMessages([{ id: "u3", role: "user", content: "x", meta: { images: "nope" } }]);
    expect(a.metadata?.images).toBeUndefined();
    const [b] = storedToUiMessages([{ id: "u4", role: "user", content: "x", meta: { images: [1, 2] } }]);
    expect(b.metadata?.images).toBeUndefined();
  });

  it("assistant row: valid meta.parts → ordered text/data-tool parts", () => {
    const row: ServerMessage = {
      id: "a1",
      role: "assistant",
      content: "AB",
      meta: {
        tools: [
          { server: "k", name: "one", ok: true, args: "{}", result: "R1", truncated: true },
          { server: "k", name: "two", ok: false, result: "boom" },
        ],
        parts: [
          { type: "text", text: "A" },
          { type: "tools", count: 1 },
          { type: "text", text: "B" },
          { type: "tools", count: 1 },
        ],
      },
    };
    const [m] = storedToUiMessages([row]);
    expect(m.parts).toEqual([
      text("A"),
      tool({ server: "k", name: "one", status: "done", args: "{}", result: "R1", truncated: true }),
      text("B"),
      tool({ server: "k", name: "two", status: "error", args: undefined, result: "boom", truncated: undefined }),
    ]);
  });

  it("assistant row: junk tool entries are dropped", () => {
    const row: ServerMessage = {
      id: "a2",
      role: "assistant",
      content: "",
      meta: {
        tools: [null, "junk", { server: "k" }, { server: "k", name: "ok", ok: true }],
      },
    };
    const [m] = storedToUiMessages([row]);
    expect(m.parts).toEqual([tool({ server: "k", name: "ok", status: "done", args: undefined, result: undefined, truncated: undefined })]);
  });

  // Issue #16: stored meta.tools entries may carry a validated card; anything
  // malformed degrades to a plain chip (never a partial shape).
  it("assistant row: stored card passes through, malformed card is dropped", () => {
    const valid = { kind: "info", title: "T", fields: [{ label: "l", value: "v" }] };
    const [m] = storedToUiMessages([
      {
        id: "a16",
        role: "assistant",
        content: "",
        meta: {
          tools: [
            { server: "k", name: "good", ok: true, card: valid },
            { server: "k", name: "bad", ok: true, card: { noTitle: 1 } },
          ],
        },
      },
    ]);
    expect(m.parts).toEqual([
      tool({ server: "k", name: "good", status: "done", args: undefined, result: undefined, truncated: undefined, card: valid }),
      tool({ server: "k", name: "bad", status: "done", args: undefined, result: undefined, truncated: undefined }),
    ]);
  });

  it("assistant row: mismatched/garbled meta.parts → chips-then-text fallback", () => {
    const cases: unknown[] = [
      undefined, // no parts key at all
      "nope", // not an array
      [null], // junk entry
      [{ type: "text" }], // text not a string
      [{ type: "tools", count: "x" }], // count not a number
      [{ type: "tools", count: -1 }], // negative count
      [{ type: "tools", count: 1.5 }], // non-integer count
      [{ type: "weird" }], // unknown part type
      [{ type: "text", text: "A" }], // leaves chips unconsumed
    ];
    for (const parts of cases) {
      const [m] = storedToUiMessages([
        {
          id: "a3",
          role: "assistant",
          content: "fallback text",
          meta: { tools: [{ server: "k", name: "t", ok: true }], ...(parts ? { parts } : {}) },
        },
      ]);
      expect(m.parts).toEqual([
        tool({ server: "k", name: "t", status: "done", args: undefined, result: undefined, truncated: undefined }),
        text("fallback text"),
      ]);
    }
  });

  it("assistant fallback without content → chips only", () => {
    const [m] = storedToUiMessages([
      { id: "a4", role: "assistant", content: "", meta: { tools: [{ server: "k", name: "t", ok: false }] } },
    ]);
    expect(m.parts).toEqual([tool({ server: "k", name: "t", status: "error", args: undefined, result: undefined, truncated: undefined })]);
  });

  it("assistant row without tools meta → plain text part", () => {
    const [m] = storedToUiMessages([{ id: "a5", role: "assistant", content: "plain", meta: null }]);
    expect(m.parts).toEqual([text("plain")]);
  });
});

describe("projectMessages", () => {
  it("user messages pass metadata through", () => {
    const meta: ChatMessageMeta = { images: ["i"], audio: "a", turnError: "timeout", audioCaptionPending: true };
    const [m] = projectMessages([msg({ role: "user", parts: [text("hi")], metadata: meta })], false);
    expect(m).toEqual({
      id: m.id,
      role: "user",
      content: "hi",
      images: ["i"],
      audio: "a",
      audioTranscript: undefined,
      audioTranscriptFailed: undefined,
      audioCaptionPending: true,
      turnError: "timeout",
    });
  });

  it("assistant messages with only invisible parts produce no row", () => {
    expect(projectMessages([msg({ role: "assistant", parts: [thread("t")] })], true)).toEqual([]);
    expect(
      projectMessages([msg({ role: "assistant", parts: [thread("t"), fail("upstream_connect")] })], false)
    ).toEqual([]);
  });

  it("coalesces text parts and skips empty ones", () => {
    const [m] = projectMessages(
      [msg({ role: "assistant", parts: [text(""), text("Hello "), text("world")] })],
      false
    );
    expect(m.content).toBe("Hello world");
    expect(m.segments).toEqual([{ kind: "text", text: "Hello world" }]);
    expect(m.tools).toBeUndefined();
  });

  it("interleaves text and tool rounds like the live stream", () => {
    const running = chip({ name: "search" });
    const done = chip({ name: "search", status: "done", result: "R" });
    const [m] = projectMessages(
      [msg({ role: "assistant", parts: [text("A"), tool(running), tool(done), text("B")] })],
      false
    );
    expect(m.content).toBe("AB");
    expect(m.tools).toEqual([done]);
    expect(m.segments).toEqual([
      { kind: "text", text: "A" },
      { kind: "tools", tools: [done] },
      { kind: "text", text: "B" },
    ]);
  });

  it("stored terminal chips append (no running chip to replace)", () => {
    const c1 = chip({ name: "one", status: "done" });
    const c2 = chip({ name: "two", status: "error" });
    const [m] = projectMessages([msg({ role: "assistant", parts: [tool(c1), tool(c2), text("ok")] })], false);
    expect(m.tools).toEqual([c1, c2]);
    expect(m.segments).toEqual([
      { kind: "tools", tools: [c1, c2] },
      { kind: "text", text: "ok" },
    ]);
  });

  it("parallel same-name calls: terminal events replace runnings in order", () => {
    const r1 = chip({ name: "x" });
    const r2 = chip({ name: "x" });
    const d1 = chip({ name: "x", status: "done", result: "one" });
    const d2 = chip({ name: "x", status: "done", result: "two" });
    const [m] = projectMessages(
      [msg({ role: "assistant", parts: [tool(r1), tool(r2), tool(d1), tool(d2)] })],
      false
    );
    expect(m.tools).toEqual([d1, d2]);
    expect(m.segments).toEqual([{ kind: "tools", tools: [d1, d2] }]);
  });

  it("flags the last assistant row while streaming", () => {
    const rows = projectMessages(
      [
        msg({ role: "user", parts: [text("q1")] }),
        msg({ role: "assistant", parts: [text("a1")] }),
        msg({ role: "user", parts: [text("q2")] }),
        msg({ role: "assistant", parts: [text("partial")] }),
      ],
      true
    );
    expect(rows.map((r) => r.streaming)).toEqual([undefined, undefined, undefined, true]);
    // not streaming anymore → nobody flagged
    const done = projectMessages(
      [msg({ role: "assistant", parts: [text("a1")] })],
      false
    );
    expect(done[0].streaming).toBeUndefined();
  });

  it("a running chip alone makes the assistant row visible", () => {
    const [m] = projectMessages([msg({ role: "assistant", parts: [thread("t"), tool(chip())] })], true);
    expect(m.content).toBe("");
    expect(m.tools).toEqual([chip()]);
    expect(m.streaming).toBe(true);
  });
});

// ── protocol v3 interactive asks ─────────────────────────────────────────────

const part = (p: Record<string, unknown>) => p as unknown as YashaUIMessage["parts"][number];

describe("projectMessages — interactive asks", () => {
  it("extracts an ask_choice ask with non-string options filtered out", () => {
    const [m] = projectMessages(
      [
        msg({
          role: "assistant",
          parts: [
            part({
              type: "tool-ask_choice",
              toolCallId: "c1",
              state: "input-available",
              input: { question: "Which day?", options: ["Sat", 7, "Sun"] },
            }),
          ],
        }),
      ],
      false
    );
    expect(m.interactive).toEqual([
      { toolCallId: "c1", tool: "ask_choice", question: "Which day?", options: ["Sat", "Sun"], detail: undefined, answered: undefined },
    ]);
  });

  it("skips parts without a renderable question (streaming, partial, input-less)", () => {
    const out = projectMessages(
      [
        msg({
          role: "assistant",
          parts: [
            part({ type: "tool-ask_choice", toolCallId: "c0", state: "input-streaming", input: { question: "half" } }),
            part({ type: "tool-ask_choice", toolCallId: "c1", state: "input-available", input: { options: ["a"] } }),
            part({ type: "tool-confirm_action", toolCallId: "c2", state: "input-available" }),
            part({ type: "data-thread", data: { threadId: "t" } }),
          ],
        }),
      ],
      false
    );
    expect(out).toEqual([]); // a question-less ask is not yet a visible turn
  });

  it("answered parts normalize the output; confirm keeps its detail", () => {
    const [m] = projectMessages(
      [
        msg({
          role: "assistant",
          parts: [
            part({
              type: "tool-ask_choice",
              toolCallId: "c1",
              state: "output-available",
              input: { question: "q?" },
              output: { picked: "Sat" },
            }),
            part({
              type: "tool-confirm_action",
              toolCallId: "c2",
              state: "output-available",
              input: { question: "Ship?", detail: "irreversible" },
              output: "confirmed",
            }),
            part({ type: "tool-confirm_action", toolCallId: "c3", state: "output-available", input: { question: "z?" }, output: null }),
          ],
        }),
      ],
      false
    );
    expect(m.interactive?.[0]?.answered).toBe('{"picked":"Sat"}');
    expect(m.interactive?.[1]).toMatchObject({ tool: "confirm_action", detail: "irreversible", answered: "confirmed" });
    expect(m.interactive?.[2]?.answered).toBe("null");
  });
});

// ── tier-1 generative UI cards (issue #28) ──────────────────────────────────

const renderCard = (id: string) => ({ id, root: { type: "text" as const, text: `card ${id}` } });
const cardPart = (id: string) => ({ type: "data-card" as const, data: renderCard(id) });

describe("storedToUiMessages — generative cards", () => {
  it("meta.parts card entries splice meta.cards between the text parts", () => {
    const [m] = storedToUiMessages([
      {
        id: "a-card",
        role: "assistant",
        content: "AB",
        meta: {
          cards: [renderCard("c1")],
          parts: [
            { type: "text", text: "A" },
            { type: "card" },
            { type: "text", text: "B" },
          ],
        },
      },
    ]);
    expect(m.parts).toEqual([text("A"), cardPart("c1"), text("B")]);
  });

  it("parts without card entries (legacy/mismatch) → fallback appends the cards last", () => {
    const [m] = storedToUiMessages([
      {
        id: "a-card-mismatch",
        role: "assistant",
        content: "AB",
        meta: { cards: [renderCard("c1")], parts: [{ type: "text", text: "A" }] },
      },
    ]);
    expect(m.parts).toEqual([text("AB"), cardPart("c1")]);
  });

  it("card entry with no backing meta.cards record → fallback", () => {
    const [m] = storedToUiMessages([
      {
        id: "a-card-orphan",
        role: "assistant",
        content: "AB",
        meta: { parts: [{ type: "text", text: "A" }, { type: "card" }, { type: "text", text: "B" }] },
      },
    ]);
    expect(m.parts).toEqual([text("AB")]);
  });

  it("malformed stored cards are dropped (never rendered half-valid)", () => {
    const [m] = storedToUiMessages([
      {
        id: "a-card-junk",
        role: "assistant",
        content: "",
        meta: {
          cards: [
            { id: 7, root: { type: "text", text: "x" } }, // id must be a string
            { id: "c2", root: { type: "nope" } }, // unknown component
          ],
        },
      },
    ]);
    expect(m.parts).toEqual([]);
  });
});

describe("projectMessages — generative cards", () => {
  it("data-card parts render as card segments, in order with the text", () => {
    const [m] = projectMessages(
      [msg({ role: "assistant", parts: [text("before "), cardPart("c1"), text("after"), cardPart("c2")] })],
      false
    );
    expect(m.segments).toEqual([
      { kind: "text", text: "before " },
      { kind: "card", card: renderCard("c1") },
      { kind: "text", text: "after" },
      { kind: "card", card: renderCard("c2") },
    ]);
  });

  it("a card with no text is still a visible turn", () => {
    const [m] = projectMessages([msg({ role: "assistant", parts: [cardPart("c1")] })], false);
    expect(m).toMatchObject({ role: "assistant", content: "" });
    expect(m.segments).toEqual([{ kind: "card", card: renderCard("c1") }]);
  });
});
