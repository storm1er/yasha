import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./support/db";
import { signUp } from "./support/app";
import { importBatches, threadImports, user as users } from "@/lib/db/schema";
import { ensureSpoolDir, ingestGeminiChunk } from "@/lib/import/gemini-ingest";
import { buildGeminiImportReport, SUSPECT_RUN_MIN } from "@/lib/import/gemini-report";

let spoolDir = "";
let savedSpoolEnv: string | undefined;

beforeAll(() => {
  spoolDir = mkdtempSync(join(tmpdir(), "gce-report-"));
  savedSpoolEnv = process.env.YASHA_IMPORT_DIR;
  process.env.YASHA_IMPORT_DIR = spoolDir;
});

afterAll(() => {
  if (savedSpoolEnv === undefined) delete process.env.YASHA_IMPORT_DIR;
  else process.env.YASHA_IMPORT_DIR = savedSpoolEnv;
  rmSync(spoolDir, { recursive: true, force: true });
});

async function makeUser(label: string): Promise<string> {
  const account = await signUp(label);
  const row = db.select({ id: users.id }).from(users).where(eq(users.username, account.username)).get();
  if (!row) throw new Error("user missing");
  return row.id;
}

function line(id: string, texts: string[], extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    id,
    title: `Chat ${id}`,
    turns: texts.map((text, i) => ({ role: i % 2 === 0 ? "user" : "model", text })),
    source: "scraper",
    flags: [],
    ...extra,
  })}\n`;
}

/** Seeds a finished batch by running the real importer, so the report is read
 *  off the same rows the queue job writes. */
async function importFile(userId: string, content: string): Promise<string> {
  const id = randomUUID();
  writeFileSync(ensureSpoolDir(id), content, "utf8");
  db.insert(importBatches)
    .values({
      id,
      userId,
      filename: "gemini_chats.ndjson",
      bytes: Buffer.byteLength(content),
      status: "queued",
    })
    .run();
  // Same loop the future queue job will run: one chunk at a time to EOF.
  for (;;) {
    const outcome = await ingestGeminiChunk({
      userId,
      batchId: id,
      model: "m",
      chunkSize: 100,
      maxMessageChars: 5000,
      maxConversations: 1000,
      anchorMs: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    if (outcome.stop === "eof") break;
  }
  db.update(importBatches)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(importBatches.id, id))
    .run();
  return id;
}

function flagsOf(userId: string, externalId: string): string[] {
  const row = db
    .select({ flagsJson: threadImports.flagsJson })
    .from(threadImports)
    .where(and(eq(threadImports.userId, userId), eq(threadImports.externalId, externalId)))
    .get();
  return row?.flagsJson ? (JSON.parse(row.flagsJson) as string[]) : [];
}

describe("buildGeminiImportReport", () => {
  it("returns null for an unknown or foreign batch", async () => {
    const userId = await makeUser("t11_rep0");
    expect(buildGeminiImportReport({ batchId: randomUUID(), userId })).toBeNull();

    const mine = await importFile(userId, line("c1", ["q", "a"]));
    const other = await makeUser("t11_rep0b");
    expect(buildGeminiImportReport({ batchId: mine, userId: other })).toBeNull();
  });

  it("reports counters, failures and malformed samples", async () => {
    const userId = await makeUser("t11_rep1");
    const content =
      line("c1", ["q", "a"]) +
      JSON.stringify({ id: "f1", turns: [], flags: ["failed", "duplicate-body"] }) +
      "\nnot json\n" +
      line("c2", ["q two", "a two"], { flags: ["needs-review"] });
    const batchId = await importFile(userId, content);

    const report = buildGeminiImportReport({ batchId, userId });
    expect(report).not.toBeNull();
    expect(report).toMatchObject({
      batchId,
      status: "succeeded",
      provider: "gemini",
      filename: "gemini_chats.ndjson",
      error: null,
      suspects: 0,
      suspectRun: null,
    });
    expect(report?.counts).toMatchObject({ lines: 4, imported: 2, failed: 1, malformed: 1, flagged: 1 });
    expect(report?.failures).toEqual([{ externalId: "f1", reason: "duplicate-body" }]);
    expect(report?.malformedSamples).toEqual(["invalid-json"]);
    expect(report?.duplicateGroups).toEqual([]);
  });

  it("groups conversations sharing one body, per user", async () => {
    const userId = await makeUser("t11_rep2");
    const twin = ["same prompt", "same answer"];
    const batchId = await importFile(userId, line("a1", twin) + line("a2", twin) + line("a3", ["x", "y"]));

    const otherUser = await makeUser("t11_rep2b");
    const otherBatch = await importFile(otherUser, line("b1", twin));

    const report = buildGeminiImportReport({ batchId, userId });
    expect(report?.duplicateGroups).toHaveLength(1);
    expect(report?.duplicateGroups[0]).toMatchObject({ count: 2 });
    expect(report?.duplicateGroups[0].bodyHash).toHaveLength(12);
    expect(report?.duplicateGroups[0].externalIds.sort()).toEqual(["a1", "a2"]);
    // Duplicate auditing is user-scoped: another account's copy is not the user's problem.
    expect(buildGeminiImportReport({ batchId: otherBatch, userId: otherUser })?.duplicateGroups).toEqual([]);
  });

  it("flags a contiguous duplicate run and stays idempotent", async () => {
    const userId = await makeUser("t11_rep3");
    const stub = ["prompt", "STALE STUB"];
    const content =
      line("ok1", ["real", "answer"]) +
      line("d1", stub) +
      line("d2", stub) +
      line("d3", stub) +
      line("ok2", ["other", "answer"]);
    const batchId = await importFile(userId, content);

    const report = buildGeminiImportReport({ batchId, userId });
    expect(report?.suspectRun).toMatchObject({ startLine: 2, length: SUSPECT_RUN_MIN });
    expect(report?.suspects).toBe(SUSPECT_RUN_MIN);
    for (const id of ["d1", "d2", "d3"]) expect(flagsOf(userId, id)).toContain("suspect-duplicates");
    expect(flagsOf(userId, "ok1")).toEqual([]);

    // Re-reading a report must not stack the flag.
    const again = buildGeminiImportReport({ batchId, userId });
    expect(again?.suspects).toBe(SUSPECT_RUN_MIN);
    expect(flagsOf(userId, "d2")).toEqual(["suspect-duplicates"]);
  });

  it("keeps threads of a suspect run (nothing is dropped)", async () => {
    const userId = await makeUser("t11_rep4");
    const stub = ["p", "STUB"];
    const batchId = await importFile(userId, line("d1", stub) + line("d2", stub) + line("d3", stub));
    const report = buildGeminiImportReport({ batchId, userId });
    expect(report?.counts.imported).toBe(3);
    expect(report?.suspectRun?.length).toBe(3);
  });

  it("does not call a pair of duplicates a run", async () => {
    const userId = await makeUser("t11_rep5");
    const twin = ["p", "same"];
    const batchId = await importFile(userId, line("d1", twin) + line("d2", twin) + line("d3", ["u", "v"]));
    const report = buildGeminiImportReport({ batchId, userId });
    expect(report?.suspectRun).toBeNull();
    expect(report?.suspects).toBe(0);
  });

  it("previews without writing when markSuspects is false", async () => {
    const userId = await makeUser("t11_rep6");
    const stub = ["p", "STUB"];
    const batchId = await importFile(userId, line("d1", stub) + line("d2", stub) + line("d3", stub));

    const preview = buildGeminiImportReport({ batchId, userId, markSuspects: false });
    expect(preview?.suspects).toBe(3);
    expect(flagsOf(userId, "d1")).toEqual([]);

    const applied = buildGeminiImportReport({ batchId, userId });
    expect(applied?.suspects).toBe(3);
    expect(flagsOf(userId, "d1")).toContain("suspect-duplicates");
  });

  it("caps the marking work on a catastrophic capture", async () => {
    const userId = await makeUser("t11_rep8");
    const stub = ["p", "STUB"];
    const ids = Array.from({ length: 501 }, (_, i) => `s${i}`);
    const batchId = await importFile(userId, ids.map((id) => line(id, stub)).join(""));

    const report = buildGeminiImportReport({ batchId, userId });
    expect(report?.suspectRun?.length).toBe(501);
    expect(report?.suspects).toBe(501);
    const flagged = db
      .select({ id: threadImports.threadId })
      .from(threadImports)
      .where(and(eq(threadImports.userId, userId), sql`${threadImports.flagsJson} LIKE '%suspect-duplicates%'`))
      .all();
    expect(flagged).toHaveLength(500);
  });

  it("reports the longest run when a capture has several", async () => {
    const userId = await makeUser("t11_rep7");
    const pair = ["p", "pair"];
    const triple = ["p", "triple"];
    const quad = ["p", "quad"];
    const batchId = await importFile(
      userId,
      line("a1", pair) +
        line("a2", pair) +
        line("b1", triple) +
        line("b2", triple) +
        line("b3", triple) +
        line("c1", quad) +
        line("c2", quad) +
        line("c3", quad) +
        line("c4", quad)
    );
    const report = buildGeminiImportReport({ batchId, userId });
    expect(report?.suspectRun).toMatchObject({ startLine: 6, length: 4 });
    expect(report?.suspects).toBe(4);
  });
});
