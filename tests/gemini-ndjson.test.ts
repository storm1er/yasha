import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyHashOf, classifyLine, readGeminiNdjson } from "@/lib/import/gemini-ndjson";

const MAX_CHARS = 10_000;

let dir = "";
function fileWith(content: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.ndjson`);
  writeFileSync(path, content, "utf8");
  return path;
}

async function collect(
  path: string,
  opts: { maxMessageChars?: number; startOffset?: number; maxLineBytes?: number } = {}
) {
  const rows = [];
  for await (const row of readGeminiNdjson(path, { maxMessageChars: MAX_CHARS, ...opts })) {
    rows.push(row);
  }
  return rows;
}

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gce-ndjson-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("classifyLine", () => {
  it("maps a clean conversation and stabilizes the body hash", () => {
    const row = classifyLine(
      line({ id: "c1", title: "Trip", turns: [{ role: "user", text: "hey" }, { role: "model", text: "hi" }] }),
      MAX_CHARS,
      12
    );
    expect(row).toMatchObject({ kind: "conversation", offsetAfter: 12 });
    if (row.kind !== "conversation") throw new Error("expected conversation");
    expect(row.conv.externalId).toBe("c1");
    expect(row.conv.title).toBe("Trip");
    expect(row.conv.turns).toEqual([
      { role: "user", text: "hey" },
      { role: "assistant", text: "hi" },
    ]);
    expect(row.conv.flags).toEqual([]);
    expect(row.conv.bodyHash).toHaveLength(64);
    expect(row.conv.bodyHash).toBe(bodyHashOf(row.conv.turns));
    // Same content → same hash; different content → different hash.
    const same = classifyLine(
      line({ id: "other", title: "Other", turns: [{ role: "user", text: "hey" }, { role: "model", text: "hi" }] }),
      MAX_CHARS,
      1
    );
    if (same.kind !== "conversation") throw new Error("expected conversation");
    expect(same.conv.bodyHash).toBe(row.conv.bodyHash);
  });

  it("accepts the assistant role alias and keeps upstream flags verbatim", () => {
    const row = classifyLine(
      line({ id: "c2", title: "x", turns: [{ role: "assistant", text: "ok" }], flags: ["needs-review"] }),
      MAX_CHARS,
      1
    );
    if (row.kind !== "conversation") throw new Error("expected conversation");
    expect(row.conv.turns[0].role).toBe("assistant");
    expect(row.conv.upstreamFlags).toEqual(["needs-review"]);
  });

  it("drops empty-text turns (image-only replies) but keeps the conversation", () => {
    const row = classifyLine(
      line({ id: "c3", title: "pic", turns: [{ role: "model", text: "" }, { role: "user", text: "look" }] }),
      MAX_CHARS,
      1
    );
    if (row.kind !== "conversation") throw new Error("expected conversation");
    expect(row.conv.turns).toEqual([{ role: "user", text: "look" }]);
  });

  it("reports a conversation with no usable text as empty", () => {
    const row = classifyLine(line({ id: "c4", title: "pic", turns: [{ role: "model", text: "   " }] }), MAX_CHARS, 3);
    expect(row).toMatchObject({ kind: "empty", externalId: "c4" });
  });

  it("flags unknown turn shapes and drops them", () => {
    const row = classifyLine(
      line({
        id: "c5",
        title: "weird",
        turns: [{ role: "tool", text: "x" }, null, { role: "user", text: "hi", }, { role: "user", text: 42 }],
      }),
      MAX_CHARS,
      1
    );
    if (row.kind !== "conversation") throw new Error("expected conversation");
    expect(row.conv.turns).toEqual([{ role: "user", text: "hi" }]);
    expect(row.conv.flags).toEqual(["unknown-role"]);
  });

  it("truncates over-long messages and flags it", () => {
    const row = classifyLine(
      line({ id: "c6", title: "long", turns: [{ role: "user", text: "a".repeat(50) }] }),
      10,
      1
    );
    if (row.kind !== "conversation") throw new Error("expected conversation");
    expect(row.conv.turns[0].text).toHaveLength(10);
    expect(row.conv.flags).toEqual(["truncated"]);
  });

  it("treats missing and placeholder titles as untitled", () => {
    const noTitle = classifyLine(line({ id: "c7", turns: [{ role: "user", text: "a" }] }), MAX_CHARS, 1);
    const placeholder = classifyLine(
      line({ id: "c8", title: "(untitled c8)", turns: [{ role: "user", text: "a" }] }),
      MAX_CHARS,
      1
    );
    const badTitle = classifyLine(
      line({ id: "c9", title: 7, turns: [{ role: "user", text: "a" }] }),
      MAX_CHARS,
      1
    );
    for (const row of [noTitle, placeholder, badTitle]) {
      if (row.kind !== "conversation") throw new Error("expected conversation");
      expect(row.conv.title).toBe("");
      expect(row.conv.flags).toContain("untitled");
    }
  });

  it("classifies upstream failures with their reason", () => {
    const withReason = classifyLine(line({ id: "f1", turns: [], flags: ["failed", "no-anchor"] }), MAX_CHARS, 1);
    const bare = classifyLine(line({ id: "f2", turns: [], flags: ["failed"] }), MAX_CHARS, 1);
    expect(withReason).toMatchObject({ kind: "failed", externalId: "f1", reason: "no-anchor" });
    expect(bare).toMatchObject({ kind: "failed", externalId: "f2", reason: "unspecified" });
  });

  it("rejects malformed lines without throwing", () => {
    const cases: [string, string][] = [
      ["not json", "invalid-json"],
      ["[1,2]", "not-an-object"],
      ["null", "not-an-object"],
      ['{"title":"no id","turns":[]}', "missing-id"],
      ['{"id":"  ","turns":[]}', "missing-id"],
      ['{"id":"x","turns":"nope","flags":1}', "missing-turns"],
    ];
    for (const [input, reason] of cases) {
      expect(classifyLine(input, MAX_CHARS, 5)).toMatchObject({ kind: "malformed", reason });
    }
  });

  it("filters non-string flags and trims the id", () => {
    const row = classifyLine(
      line({ id: "  padded  ", title: "t", turns: [{ role: "user", text: "a" }], flags: [1, "ok", null] }),
      MAX_CHARS,
      1
    );
    if (row.kind !== "conversation") throw new Error("expected conversation");
    expect(row.conv.externalId).toBe("padded");
    expect(row.conv.upstreamFlags).toEqual(["ok"]);
  });
});

describe("readGeminiNdjson", () => {
  it("yields one row per non-blank line with cumulative byte offsets", async () => {
    const first = line({ id: "a", turns: [{ role: "user", text: "one" }] });
    const second = line({ id: "b", turns: [{ role: "user", text: "deux" }] });
    const content = `${first}\n${second}   \r\n`;
    const path = fileWith(content);
    const rows = await collect(path);
    expect(rows.map((r) => r.kind)).toEqual(["conversation", "conversation"]);
    // Offsets count every byte consumed, including the skipped blank line.
    expect(rows[0].offsetAfter).toBe(Buffer.byteLength(first, "utf8"));
    expect(rows[1].offsetAfter).toBe(Buffer.byteLength(first + "\n" + second, "utf8"));
    if (rows[0].kind !== "conversation" || rows[1].kind !== "conversation") throw new Error("expected rows");
    expect(rows[1].conv.turns[0].text).toBe("deux");
  });

  it("reads a last line that has no trailing newline", async () => {
    const path = fileWith(line({ id: "a", turns: [{ role: "user", text: "x" }] }).trimEnd());
    const rows = await collect(path);
    expect(rows).toHaveLength(1);
  });

  it("yields nothing for an empty or whitespace-only file", async () => {
    expect(await collect(fileWith(""))).toEqual([]);
    expect(await collect(fileWith("\n\n   \n"))).toEqual([]);
    // Whitespace tail with no closing newline is not a line.
    expect(await collect(fileWith(line({ id: "a", turns: [{ role: "user", text: "x" }] }) + "  \t "))).toHaveLength(1);
  });

  it("resumes from a byte offset", async () => {
    const first = line({ id: "a", turns: [{ role: "user", text: "one" }] });
    const second = line({ id: "b", turns: [{ role: "user", text: "two" }] });
    const path = fileWith(first + second);
    const rows = await collect(path, { startOffset: Buffer.byteLength(first, "utf8") });
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== "conversation") throw new Error("expected conversation");
    expect(rows[0].conv.externalId).toBe("b");
    expect(rows[0].offsetAfter).toBe(Buffer.byteLength(first + second, "utf8"));
  });

  it("counts a line longer than the cap as malformed and keeps going", async () => {
    const big = line({ id: "big", title: "x".repeat(200), turns: [{ role: "user", text: "y".repeat(200) }] });
    const path = fileWith(`${big}${line({ id: "z", turns: [{ role: "user", text: "ok" }] })}`);
    const rows = await collect(path, { maxLineBytes: 80 });
    expect(rows.map((r) => r.kind)).toEqual(["malformed", "conversation"]);
    if (rows[0].kind !== "malformed" || rows[1].kind !== "conversation") throw new Error("expected rows");
    expect(rows[0].reason).toBe("line-too-long");
    expect(rows[1].conv.externalId).toBe("z");
  });

  it("reports an unterminated over-long tail as malformed", async () => {
    const path = fileWith(line({ id: "big", title: "x".repeat(300), turns: [] }).trimEnd());
    const rows = await collect(path, { maxLineBytes: 30 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "malformed", reason: "line-too-long" });
  });

  it("skips an over-long line spanning several read-stream chunks", async () => {
    const huge = line({ id: "huge", title: "t", turns: [{ role: "user", text: "z".repeat(200_000) }] });
    const after = line({ id: "after", turns: [{ role: "user", text: "ok" }] });
    const path = fileWith(`${huge}${after}`);
    const rows = await collect(path, { maxLineBytes: 1000 });
    expect(rows.map((r) => r.kind)).toEqual(["malformed", "conversation"]);
    if (rows[1].kind !== "conversation") throw new Error("expected conversation");
    expect(rows[1].conv.externalId).toBe("after");
    // Offsets stay exact: skipping a line must not desync the resume cursor.
    expect(rows[1].offsetAfter).toBe(Buffer.byteLength(huge + after, "utf8"));
  });

  it("survives multi-byte content spanning stream chunk boundaries", async () => {
    const text = "émoji 🎉 ".repeat(9000); // > 64 KiB read-stream chunk
    const path = fileWith(
      line({ id: "utf", title: "unicode", turns: [{ role: "user", text }, { role: "model", text: "fin" }] })
    );
    const rows = await collect(path, { maxMessageChars: 200_000 });
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== "conversation") throw new Error("expected conversation");
    expect(rows[0].conv.turns[0].text).toBe(text.trim());
    expect(rows[0].conv.flags).toEqual([]);
  });
});
