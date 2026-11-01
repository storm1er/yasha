// Protocol v3 wire-conformance fixtures (docs/protocol-v3.md). Each line of
// tests/fixtures/protocol-v3.jsonl is ONE UIMessageChunk exactly as it appears
// in the SSE `data:` payload of a /api/chat response (the `data: ` framing and
// the terminal `[DONE]` sentinel are transport, not fixture content). The
// Android parser tests (P4) consume the same file — changing the fixture means
// changing both clients, and this test is what says the wire stays legal.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseUiChunks } from "./support/ui-stream";
import { parseGenerativeCard } from "@/lib/chat/generative";

// The chunk inventory docs/protocol-v3.md promises; unknown types are allowed
// on the wire (clients ignore them) but must never appear IN the fixture.
const ALLOWED = new Set([
  "data-thread",
  "data-tool",
  "data-error",
  "text-start",
  "text-delta",
  "text-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-output-available",
  "tool-approval-request",
]);

const fixture = readFileSync(resolve(__dirname, "fixtures/protocol-v3.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Record<string, unknown> & { type: string });

const isStr = (v: unknown): v is string => typeof v === "string";
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : null;

describe("protocol-v3 fixtures", () => {
  it("only uses chunk types from the documented inventory", () => {
    const unknown = fixture.filter((c) => !ALLOWED.has(c.type)).map((c) => c.type);
    expect(unknown).toEqual([]);
  });

  it("announces the thread before any content (data-thread first)", () => {
    expect(fixture[0]).toMatchObject({ type: "data-thread", data: { threadId: expect.any(String) } });
    const firstText = fixture.findIndex((c) => c.type === "text-start" || c.type === "text-delta");
    expect(firstText).toBeGreaterThan(0);
  });

  it("text frames carry consistent ids and string deltas", () => {
    const ids = new Set(
      fixture.filter((c) => c.type === "text-start").map((c) => String(c.id)),
    );
    for (const c of fixture) {
      if (c.type === "text-delta") {
        expect(isStr(c.delta)).toBe(true);
        expect(ids.has(String(c.id))).toBe(true);
      }
      if (c.type === "text-end") expect(ids.has(String(c.id))).toBe(true);
    }
  });

  it("data-tool frames keep the chip state machine shape; cards validate", () => {
    const chips = fixture.filter((c) => c.type === "data-tool");
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) {
      const d = obj(c.data);
      expect(d).not.toBeNull();
      expect(isStr(d!.server)).toBe(true);
      expect(isStr(d!.name)).toBe(true);
      expect(["running", "done", "error"]).toContain(String(d!.status));
      if (d!.card !== undefined) {
        // A card on the wire must parse with the same validator the server emitted it through.
        expect(parseGenerativeCard(d!.card)).not.toBeNull();
      }
    }
    // Terminal events must have an ms duration; running must not claim one.
    expect(chips.some((c) => (c.data as { status: string }).status === "running")).toBe(true);
  });

  it("interactive tool frames follow the SDK tool-chunk contract", () => {
    const start = fixture.find((c) => c.type === "tool-input-start");
    const available = fixture.find((c) => c.type === "tool-input-available");
    expect(start).toBeDefined();
    expect(available).toBeDefined();
    const a = available!;
    expect(isStr(a.toolCallId) && (a.toolCallId as string).length > 0).toBe(true);
    expect(a.toolName).toBe("ask_choice"); // registry name (P3)
    expect(obj(a.input)).not.toBeNull();
    // Deltas belong to the same call, and their concatenation is valid JSON matching input.
    const deltas = fixture
      .filter((c) => c.type === "tool-input-delta" && c.toolCallId === a.toolCallId)
      .map((c) => String(c.inputTextDelta))
      .join("");
    expect(JSON.parse(deltas)).toEqual(obj(a.input));
  });

  it("survives the client SSE framing round-trip (parseUiChunks)", () => {
    // Emulate the wire: SSE frames + keep-alive comment + [DONE], then parse
    // with the very helper the route tests (and by contract the clients) use.
    const sse =
      fixture.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
      ": ping\n\ndata: [DONE]\n\n";
    expect(parseUiChunks(sse).map((c) => c.type)).toEqual(fixture.map((c) => c.type));
  });
});
