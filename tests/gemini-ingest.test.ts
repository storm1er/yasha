import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./support/db";
import { signUp } from "./support/app";
import { importBatches, messages, threadImports, threads, user as users } from "@/lib/db/schema";
import {
  ensureSpoolDir,
  ingestGeminiChunk,
  readSamples,
  spoolPathFor,
  type GeminiChunkOptions,
} from "@/lib/import/gemini-ingest";

const ANCHOR = Date.parse("2026-01-01T00:00:00.000Z");

let spoolDir = "";
let savedSpoolEnv: string | undefined;

beforeAll(() => {
  spoolDir = mkdtempSync(join(tmpdir(), "gce-spool-"));
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

function opts(over: Partial<GeminiChunkOptions> = {}): GeminiChunkOptions {
  return {
    userId: "",
    batchId: "",
    model: "gemini-import-model",
    chunkSize: 100,
    maxMessageChars: 5000,
    maxConversations: 1000,
    anchorMs: ANCHOR,
    ...over,
  };
}

function convLine(id: string, texts: string[], extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    id,
    title: `Chat ${id}`,
    turns: texts.map((text, i) => ({ role: i % 2 === 0 ? "user" : "model", text })),
    source: "scraper",
    flags: [],
    ...extra,
  })}\n`;
}

function makeBatch(userId: string, content: string): string {
  const id = randomUUID();
  writeFileSync(ensureSpoolDir(id), content, "utf8");
  db.insert(importBatches)
    .values({ id, userId, filename: "gemini_chats.ndjson", bytes: Buffer.byteLength(content), status: "queued" })
    .run();
  return id;
}

function batch(id: string) {
  const row = db.select().from(importBatches).where(eq(importBatches.id, id)).get();
  if (!row) throw new Error("batch missing");
  return row;
}

function messagesOf(threadId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt))
    .all();
}

function provenance(userId: string, externalId: string) {
  const row = db
    .select()
    .from(threadImports)
    .where(and(eq(threadImports.userId, userId), eq(threadImports.externalId, externalId)))
    .get();
  if (!row) throw new Error(`provenance missing for ${externalId}`);
  return row;
}

describe("ingestGeminiChunk", () => {
  it("imports conversations with synthetic ordering and provenance", async () => {
    const userId = await makeUser("t11_imp");
    const content =
      convLine("c1", ["first question", "first answer"]) + convLine("c2", ["another", "reply", "follow-up"]);
    const batchId = makeBatch(userId, content);

    const outcome = await ingestGeminiChunk(opts({ userId, batchId }));

    expect(outcome.stop).toBe("eof");
    expect(outcome).toMatchObject({
      lines: 2, imported: 2, skippedUnchanged: 0, skippedChanged: 0, failed: 0, empty: 0, malformed: 0, flagged: 0,
    });
    expect(outcome.createdThreadIds).toHaveLength(2);

    const row = batch(batchId);
    expect(row.status).toBe("running");
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.checkpointLines).toBe(2);
    expect(row.totalLines).toBe(2);
    expect(row.checkpointOffset).toBe(Buffer.byteLength(content, "utf8"));

    const stored = db
      .select()
      .from(threads)
      .where(eq(threads.userId, userId))
      .orderBy(asc(threads.createdAt))
      .all();
    expect(stored.map((t) => t.title)).toEqual(["Chat c1", "Chat c2"]);
    expect(stored.every((t) => t.model === "gemini-import-model")).toBe(true);

    const c1 = messagesOf(stored[0].id);
    expect(c1.map((m) => [m.role, m.content])).toEqual([
      ["user", "first question"],
      ["assistant", "first answer"],
    ]);
    expect(new Date(c1[0].createdAt).getTime()).toBe(ANCHOR + 2);
    expect(c1[1].createdAt.getTime() - c1[0].createdAt.getTime()).toBe(1);
    expect(JSON.parse(String(c1[0].metaJson))).toEqual({
      imported: { provider: "gemini", externalId: "c1", turnIndex: 0 },
    });

    const prov = provenance(userId, "c2");
    expect(prov).toMatchObject({ userId, importId: batchId, provider: "gemini", turnCount: 3, lineIndex: 2 });
    expect(prov.bodyHash).toHaveLength(64);
    expect(prov.flagsJson).toBeNull();
  });

  it("keeps upstream and Yasha flags on the provenance row", async () => {
    const userId = await makeUser("t11_flag");
    const batchId = makeBatch(
      userId,
      convLine("c1", ["only question"], { id: "c1", title: "(untitled c1)", flags: ["needs-review"] })
    );
    const outcome = await ingestGeminiChunk(opts({ userId, batchId }));
    expect(outcome.flagged).toBe(1);
    expect(JSON.parse(String(provenance(userId, "c1").flagsJson))).toEqual(["needs-review", "untitled"]);
  });

  it("processes a file chunk by chunk and resumes from the checkpoint", async () => {
    const userId = await makeUser("t11_chunk");
    const content = ["a", "b", "c", "d", "e"].map((id) => convLine(id, ["q", "a"])).join("");
    const batchId = makeBatch(userId, content);

    const first = await ingestGeminiChunk(opts({ userId, batchId, chunkSize: 2 }));
    expect(first).toMatchObject({ stop: "chunk", lines: 2, imported: 2 });
    expect(batch(batchId).checkpointLines).toBe(2);

    const second = await ingestGeminiChunk(opts({ userId, batchId, chunkSize: 2 }));
    expect(second).toMatchObject({ stop: "chunk", lines: 2, imported: 2 });

    const third = await ingestGeminiChunk(opts({ userId, batchId, chunkSize: 2 }));
    expect(third).toMatchObject({ stop: "eof", lines: 1, imported: 1 });
    expect(batch(batchId)).toMatchObject({ checkpointLines: 5, imported: 5, totalLines: 5 });
    expect(db.select().from(threads).where(eq(threads.userId, userId)).all()).toHaveLength(5);
  });

  it("re-uploading the same file imports nothing twice", async () => {
    const userId = await makeUser("t11_again");
    const content = ["x", "y"].map((id) => convLine(id, ["q", "a"])).join("");
    await ingestGeminiChunk(opts({ userId, batchId: makeBatch(userId, content) }));

    const second = await ingestGeminiChunk(opts({ userId, batchId: makeBatch(userId, content) }));
    expect(second).toMatchObject({ imported: 0, skippedUnchanged: 2, skippedChanged: 0 });
    expect(db.select().from(threads).where(eq(threads.userId, userId)).all()).toHaveLength(2);
  });

  it("re-creates a thread the user deleted in the meantime", async () => {
    const userId = await makeUser("t11_recr");
    const content = convLine("c1", ["q", "a"]);
    await ingestGeminiChunk(opts({ userId, batchId: makeBatch(userId, content) }));
    const thread = db.select().from(threads).where(eq(threads.userId, userId)).all()[0];
    db.delete(threads).where(eq(threads.id, thread.id)).run();
    expect(
      db
        .select()
        .from(threadImports)
        .where(and(eq(threadImports.userId, userId), eq(threadImports.externalId, "c1")))
        .all()
    ).toHaveLength(0);

    const again = await ingestGeminiChunk(opts({ userId, batchId: makeBatch(userId, content) }));
    expect(again.imported).toBe(1);
  });

  it("never overwrites an existing import: changed content is skipped", async () => {
    const userId = await makeUser("t11_chng");
    await ingestGeminiChunk(opts({ userId, batchId: makeBatch(userId, convLine("c1", ["v1", "a1"])) }));

    const secondBatch = makeBatch(userId, convLine("c1", ["v2 refined", "a2"]));
    const changed = await ingestGeminiChunk(opts({ userId, batchId: secondBatch }));
    expect(changed).toMatchObject({ imported: 0, skippedUnchanged: 0, skippedChanged: 1 });
    const samples = readSamples(batch(secondBatch).countsJson);
    expect(samples.failures).toEqual([{ externalId: "c1", reason: "already-imported" }]);
  });

  it("stops collecting samples once the caps are reached", async () => {
    const userId = await makeUser("t11_cap");
    await ingestGeminiChunk(opts({ userId, batchId: makeBatch(userId, convLine("c1", ["v1", "a1"])) }));

    const second = makeBatch(userId, convLine("c1", ["v2", "a2"]));
    const filled = { failures: Array.from({ length: 50 }, (_, i) => ({ externalId: `f${i}`, reason: "r" })), malformed: [] };
    db.update(importBatches).set({ countsJson: JSON.stringify(filled) }).where(eq(importBatches.id, second)).run();

    const outcome = await ingestGeminiChunk(opts({ userId, batchId: second }));
    expect(outcome.skippedChanged).toBe(1);
    expect(readSamples(batch(second).countsJson).failures).toHaveLength(50);
  });

  it("counts a conversation repeated inside one file once", async () => {
    const userId = await makeUser("t11_dup");
    const content = convLine("c1", ["q", "a"]) + convLine("c1", ["q", "a"]);
    const outcome = await ingestGeminiChunk(opts({ userId, batchId: makeBatch(userId, content) }));
    expect(outcome).toMatchObject({ imported: 1, skippedUnchanged: 1 });
  });

  it("counts failed, empty and malformed rows and caps the samples", async () => {
    const userId = await makeUser("t11_cnt");
    const failures = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ id: `f${i}`, turns: [], flags: ["failed", "no-anchor"] })
    ).join("\n");
    const malformed = Array.from({ length: 25 }, () => "not json").join("\n");
    const content = `${failures}\n${malformed}\n${JSON.stringify({ id: "e1", turns: [{ role: "user", text: " " }] })}\n`;
    const batchId = makeBatch(userId, content);

    const outcome = await ingestGeminiChunk(opts({ userId, batchId }));
    expect(outcome).toMatchObject({ failed: 60, malformed: 25, empty: 1, imported: 0 });

    const row = batch(batchId);
    expect(row).toMatchObject({ failedCount: 60, malformedCount: 25 });
    const samples = readSamples(row.countsJson);
    expect(samples.failures).toHaveLength(50);
    expect(samples.malformed).toHaveLength(20);
  });

  it("stops at maxConversations", async () => {
    const userId = await makeUser("t11_max");
    const content = ["a", "b", "c", "d"].map((id) => convLine(id, ["q"])).join("");
    const outcome = await ingestGeminiChunk(
      opts({ userId, batchId: makeBatch(userId, content), maxConversations: 3 })
    );
    expect(outcome).toMatchObject({ stop: "max-conversations", imported: 3 });
  });

  it("cancels between rows and keeps what it committed", async () => {
    const userId = await makeUser("t11_cancel");
    const content = ["a", "b", "c"].map((id) => convLine(id, ["q"])).join("");
    const batchId = makeBatch(userId, content);
    let checks = 0;
    const outcome = await ingestGeminiChunk(
      opts({ userId, batchId, shouldStop: () => ++checks > 1 })
    );
    expect(outcome).toMatchObject({ stop: "cancelled", lines: 2, imported: 2 });
    expect(batch(batchId)).toMatchObject({ checkpointLines: 2, imported: 2 });
    // Resuming finishes the rest.
    const resumed = await ingestGeminiChunk(opts({ userId, batchId }));
    expect(resumed).toMatchObject({ stop: "eof", lines: 1, imported: 1 });
  });

  it("does nothing for an unknown batch or another user's batch", async () => {
    const userId = await makeUser("t11_nob");
    const otherId = await makeUser("t11_nob2");
    const mine = makeBatch(userId, convLine("c1", ["q"]));

    expect(await ingestGeminiChunk(opts({ userId, batchId: randomUUID() }))).toMatchObject({
      stop: "no-batch",
      imported: 0,
    });
    expect(await ingestGeminiChunk(opts({ userId: otherId, batchId: mine }))).toMatchObject({ stop: "no-batch" });
    expect(db.select().from(threads).where(eq(threads.userId, userId)).all()).toHaveLength(0);
  });

  it("falls back to the first turn for a title and applies the message cap", async () => {
    const userId = await makeUser("t11_titl");
    const long = "word ".repeat(80);
    const batchId = makeBatch(
      userId,
      `${JSON.stringify({ id: "c1", turns: [{ role: "user", text: `  ${long}  ` }] })}\n`
    );
    await ingestGeminiChunk(opts({ userId, batchId, maxMessageChars: 120 }));
    const thread = db.select().from(threads).where(eq(threads.userId, userId)).all()[0];
    expect(thread.title).toBe(long.trim().slice(0, 60).trim());
    expect(messagesOf(thread.id)[0].content).toHaveLength(120);
    expect(JSON.parse(String(provenance(userId, "c1").flagsJson))).toContain("truncated");
  });
});

describe("spool paths and sample parsing", () => {
  it("validates the batch id and honours the spool dir override", () => {
    expect(() => spoolPathFor("../../etc/passwd")).toThrow(/invalid import batch id/);
    const id = randomUUID();
    expect(spoolPathFor(id)).toBe(join(spoolDir, `${id}.ndjson`));

    // Without the override the spool lives next to the database (apk-builds convention).
    delete process.env.YASHA_IMPORT_DIR;
    try {
      expect(spoolPathFor(id)).toBe(join(dirname(process.env.DATABASE_PATH!), "imports", `${id}.ndjson`));
    } finally {
      process.env.YASHA_IMPORT_DIR = spoolDir;
    }
    expect(ensureSpoolDir(id)).toBe(join(spoolDir, `${id}.ndjson`));
  });

  it("reads samples defensively", () => {
    expect(readSamples(null)).toEqual({ failures: [], malformed: [] });
    expect(readSamples("null")).toEqual({ failures: [], malformed: [] });
    expect(readSamples("{oops")).toEqual({ failures: [], malformed: [] });
    expect(readSamples("[1,2]")).toEqual({ failures: [], malformed: [] });
    expect(
      readSamples(
        JSON.stringify({
          failures: [{ externalId: "a", reason: "r" }, { externalId: 1 }, null],
          malformed: ["bad", 7, null],
        })
      )
    ).toEqual({ failures: [{ externalId: "a", reason: "r" }], malformed: ["bad"] });
  });
});

describe("spool races with cancel/retention", () => {
  it("stops cleanly when a cancelled batch's spool vanished (cancel race)", async () => {
    const userId = await makeUser("t13e_cx");
    const batchId = makeBatch(userId, convLine("c1", ["q", "a"]));
    rmSync(spoolPathFor(batchId), { force: true });
    db.update(importBatches).set({ status: "cancelled" }).where(eq(importBatches.id, batchId)).run();
    const outcome = await ingestGeminiChunk(opts({ userId, batchId }));
    expect(outcome.stop).toBe("cancelled");
    expect(outcome.imported).toBe(0);
    expect(batch(batchId).status).toBe("cancelled");
  });

  it("rethrows ENOENT when the batch was NOT cancelled (retention ate it mid-run)", async () => {
    const userId = await makeUser("t13e_ex");
    const batchId = makeBatch(userId, convLine("c1", ["q", "a"]));
    rmSync(spoolPathFor(batchId), { force: true });
    await expect(ingestGeminiChunk(opts({ userId, batchId }))).rejects.toThrow(/ENOENT/);
  });

  it("rethrows non-ENOENT stream errors (e.g. the spool path is a directory)", async () => {
    const userId = await makeUser("t13e_dx");
    const batchId = makeBatch(userId, convLine("c1", ["q", "a"]));
    rmSync(spoolPathFor(batchId), { force: true });
    mkdirSync(spoolPathFor(batchId));
    await expect(ingestGeminiChunk(opts({ userId, batchId }))).rejects.toThrow(/EISDIR/);
    rmSync(spoolPathFor(batchId), { recursive: true, force: true });
  });

  it("keeps a mid-chunk cancel when the chunk commits (status never resurrected)", async () => {
    const userId = await makeUser("t13e_mc");
    const batchId = makeBatch(userId, convLine("c1", ["q", "a"]) + convLine("c2", ["q2", "a2"]));
    db.update(importBatches).set({ status: "cancelled" }).where(eq(importBatches.id, batchId)).run();
    // Ingest does not re-check status mid-chunk: the in-flight chunk commits…
    const outcome = await ingestGeminiChunk(opts({ userId, batchId }));
    expect(outcome.imported).toBe(2);
    // …but the cancel survives the status flip and the checkpoint advanced.
    const row = batch(batchId);
    expect(row.status).toBe("cancelled");
    expect(row.imported).toBe(2);
    expect(row.checkpointOffset).toBeGreaterThan(0);
  });
});
