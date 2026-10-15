import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db, setSetting } from "./support/db";
import { signUp } from "./support/app";
import {
  importBatches,
  jobs,
  settings,
  threadImports,
  threads,
  user as users,
  type Job,
} from "@/lib/db/schema";
import { handleGeminiImport, importModel, parseImportOptions, sweepGeminiSpools } from "@/lib/jobs/gemini-import";
import { invalidateSettingsCache } from "@/lib/settings";
import type { JobHandler } from "@/lib/jobs/worker";

type Ctx = Parameters<JobHandler>[0];

const spoolDir = mkdtempSync(join(tmpdir(), "gce-job-"));
const savedSpoolEnv = process.env.YASHA_IMPORT_DIR;
const OVERRIDE_KEYS = [
  "import.chunkSize",
  "import.maxConversations",
  "import.spoolRetentionHours",
  "fast_model",
  "smart_model",
  "memory.enabled",
];

beforeAll(() => {
  process.env.YASHA_IMPORT_DIR = spoolDir;
});

afterEach(() => {
  db.delete(jobs).run();
  for (const key of OVERRIDE_KEYS) db.delete(settings).where(eq(settings.key, key)).run();
  invalidateSettingsCache();
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

/** Write a spool + a queued batch row (what the upload route will do in P3). */
function makeBatch(userId: string, content: string, extra: Record<string, unknown> = {}): string {
  const id = randomUUID();
  writeFileSync(join(spoolDir, `${id}.ndjson`), content, "utf8");
  db.insert(importBatches)
    .values({
      id,
      userId,
      filename: "gemini_chats.ndjson",
      bytes: Buffer.byteLength(content),
      status: "queued",
      ...extra,
    })
    .run();
  return id;
}

function batchRow(id: string) {
  const row = db.select().from(importBatches).where(eq(importBatches.id, id)).get();
  if (!row) throw new Error("batch missing");
  return row;
}

async function runHandler(
  userId: string,
  payload: Record<string, unknown>,
  opts: { aborted?: boolean } = {}
): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  if (opts.aborted) ac.abort();
  const job = {
    id: randomUUID(),
    dedupeKey: "k",
    type: "import.gemini",
    threadId: null,
    userId,
    status: "running",
    attempts: 0,
    payloadJson: null,
  } as unknown as Job;
  const ctx = {
    job,
    payload,
    cfg: {} as Ctx["cfg"],
    signal: ac.signal,
    heartbeat: () => {},
    setCheckpoint: () => {},
    addCommit: () => {},
  } as unknown as Ctx;
  return handleGeminiImport(ctx);
}

const run = (userId: string, batchId: string, opts: { aborted?: boolean; model?: string } = {}) =>
  runHandler(userId, opts.model === undefined ? { batchId } : { batchId, model: opts.model }, opts);

function nextQueuedJob(userId: string, batchId: string) {
  const row = db
    .select()
    .from(jobs)
    .where(like(jobs.dedupeKey, `import.gemini:${userId}:${batchId}:%`))
    .all();
  if (row.length !== 1) throw new Error(`expected exactly one queued chunk job, got ${row.length}`);
  return row[0];
}

describe("import.gemini job handler", () => {
  it("returns no-batch for an unusable payload, an unknown batch, or another user's batch", async () => {
    const userId = await makeUser("t12j_none");
    expect(await runHandler(userId, {})).toEqual({ stop: "no-batch" });
    expect(await runHandler(userId, { batchId: randomUUID() })).toEqual({ stop: "no-batch" });
    const mine = makeBatch(userId, convLine("c1", ["q", "a"]));
    const other = await makeUser("t12j_none2");
    expect(await run(other, mine)).toEqual({ stop: "no-batch" });
    expect(existsSync(join(spoolDir, `${mine}.ndjson`))).toBe(true);
  });

  it("ignores jobs whose batch is already terminal (cancel raced the queue)", async () => {
    const userId = await makeUser("t12j_term");
    const succeeded = makeBatch(userId, convLine("c1", ["q", "a"]), { status: "succeeded" });
    const cancelled = makeBatch(userId, convLine("c2", ["q", "a"]), { status: "cancelled" });
    expect(await run(userId, succeeded)).toEqual({ stop: "already-succeeded" });
    expect(await run(userId, cancelled)).toEqual({ stop: "already-cancelled" });
    expect(db.select().from(threadImports).where(eq(threadImports.userId, userId)).all()).toHaveLength(0);
  });

  it("walks the chunk chain to EOF: succeeded, report persisted, spool deleted", async () => {
    const userId = await makeUser("t12j_chain");
    setSetting("import.chunkSize", "2");
    setSetting("fast_model", "fast.job.test");
    const batchId = makeBatch(
      userId,
      convLine("c1", ["a1", "b1"]) + convLine("c2", ["a2", "b2"]) + convLine("c3", ["a3", "b3"])
    );

    const first = await run(userId, batchId);
    expect(first).toMatchObject({ stop: "chunk", imported: 2 });
    const queued = nextQueuedJob(userId, batchId);
    expect(queued.status).toBe("pending");
    expect(JSON.parse(queued.payloadJson!)).toEqual({ batchId });

    const second = await runHandler(userId, JSON.parse(queued.payloadJson!) as Record<string, unknown>);
    expect(second).toMatchObject({ stop: "eof", status: "succeeded", imported: 1 });

    const batch = batchRow(batchId);
    expect(batch.status).toBe("succeeded");
    expect(batch.finishedAt).not.toBeNull();
    expect(existsSync(join(spoolDir, `${batchId}.ndjson`))).toBe(false);
    const report = JSON.parse(batch.countsJson!) as {
      status: string;
      counts: { imported: number };
      duplicateGroups: unknown[];
    };
    expect(report.status).toBe("succeeded");
    expect(report.counts.imported).toBe(3);
    // The instance default (fast_model — no smart configured) stamped every thread.
    const rows = db.select().from(threads).where(eq(threads.userId, userId)).all();
    expect(rows).toHaveLength(3);
    expect(rows.every((t) => t.model === "fast.job.test")).toBe(true);
  });

  it("honours an explicit model hint on the payload", async () => {
    const userId = await makeUser("t12j_model");
    const batchId = makeBatch(userId, convLine("c1", ["q", "a"]));
    await run(userId, batchId, { model: "chosen.model.test" });
    expect(db.select().from(threads).where(eq(threads.userId, userId)).all()[0].model).toBe("chosen.model.test");
  });

  it("ends partial when the file carries upstream failures", async () => {
    const userId = await makeUser("t12j_part");
    const batchId = makeBatch(
      userId,
      convLine("c1", ["q", "a"]) + JSON.stringify({ id: "f1", turns: [], flags: ["failed", "no-anchor"] }) + "\n"
    );
    const result = await run(userId, batchId);
    expect(result).toMatchObject({ stop: "eof", status: "partial", duplicates: 0 });
    const batch = batchRow(batchId);
    expect(batch.error).toBeNull();
    const report = JSON.parse(batch.countsJson!) as { status: string; failures: unknown[] };
    expect(report.status).toBe("partial");
    expect(report.failures).toHaveLength(1);
  });

  it("stops partial at the max-conversations cap", async () => {
    const userId = await makeUser("t12j_cap");
    setSetting("import.maxConversations", "2");
    const batchId = makeBatch(
      userId,
      convLine("c1", ["a1"]) + convLine("c2", ["a2"]) + convLine("c3", ["a3"])
    );
    const result = await run(userId, batchId);
    expect(result).toMatchObject({ stop: "max-conversations", status: "partial" });
    const batch = batchRow(batchId);
    expect(batch.error).toBe("max-conversations reached");
    expect(batch.imported).toBe(2);
    expect(existsSync(join(spoolDir, `${batchId}.ndjson`))).toBe(false);
  });

  it("resumes from the checkpoint after an abort and completes the chain", async () => {
    const userId = await makeUser("t12j_abort");
    const batchId = makeBatch(userId, convLine("c1", ["a1", "b1"]) + convLine("c2", ["a2", "b2"]));

    const aborted = await run(userId, batchId, { aborted: true });
    expect(aborted).toMatchObject({ stop: "retry" });
    expect(batchRow(batchId).status).toBe("running");
    expect(existsSync(join(spoolDir, `${batchId}.ndjson`))).toBe(true);
    expect(db.select().from(threads).where(eq(threads.userId, userId)).all()).toHaveLength(1);
    const queued = nextQueuedJob(userId, batchId);

    const resumed = await runHandler(userId, JSON.parse(queued.payloadJson!) as Record<string, unknown>);
    expect(resumed).toMatchObject({ stop: "eof", status: "succeeded", imported: 1 });
    expect(batchRow(batchId).imported).toBe(2);
  });

  it("enqueues memory jobs per thread when learnFromImports is on", async () => {
    const userId = await makeUser("t12j_learn");
    const batchId = makeBatch(userId, convLine("c1", ["q1", "a1"]) + convLine("c2", ["q2", "a2"]), {
      optionsJson: JSON.stringify({ learnFromImports: true }),
    });
    await run(userId, batchId);
    const memoryJobs = db
      .select()
      .from(jobs)
      .where(eq(jobs.type, "memory.fact_extraction"))
      .all();
    expect(memoryJobs).toHaveLength(2);
    const threadIds = new Set(db.select({ id: threads.id }).from(threads).where(eq(threads.userId, userId)).all().map((t) => t.id));
    expect(memoryJobs.every((j) => threadIds.has(j.threadId!))).toBe(true);
  });

  it("skips memory enqueues when the admin memory switch is off", async () => {
    const userId = await makeUser("t12j_moff");
    setSetting("memory.enabled", "false");
    invalidateSettingsCache();
    const batchId = makeBatch(userId, convLine("c1", ["q1", "a1"]), {
      optionsJson: JSON.stringify({ learnFromImports: true }),
    });
    const result = await run(userId, batchId);
    expect(result).toMatchObject({ stop: "eof", status: "succeeded", imported: 1 });
    expect(db.select().from(jobs).where(eq(jobs.type, "memory.fact_extraction")).all()).toHaveLength(0);
  });

  it("skips memory enqueues when a chunk created no threads", async () => {
    const userId = await makeUser("t12j_lean");
    const batchId = makeBatch(userId, JSON.stringify({ id: "f1", turns: [], flags: ["failed"] }) + "\n", {
      optionsJson: JSON.stringify({ learnFromImports: true }),
    });
    const result = await run(userId, batchId);
    expect(result).toMatchObject({ stop: "eof", status: "partial" });
    expect(db.select().from(jobs).where(eq(jobs.type, "memory.fact_extraction")).all()).toHaveLength(0);
  });
});

describe("import options + model + sweep helpers", () => {
  it("parses optionsJson defensively", () => {
    expect(parseImportOptions(null)).toEqual({ learnFromImports: false });
    expect(parseImportOptions("{oops")).toEqual({ learnFromImports: false });
    expect(parseImportOptions('"a string"')).toEqual({ learnFromImports: false });
    expect(parseImportOptions(JSON.stringify({ learnFromImports: "yes" }))).toEqual({ learnFromImports: false });
    expect(parseImportOptions(JSON.stringify({ learnFromImports: true }))).toEqual({ learnFromImports: true });
  });

  it("resolves the instance default model: smart → fast → placeholder", () => {
    expect(importModel()).toBe("imported");
    setSetting("smart_model", "smart.job.test");
    expect(importModel()).toBe("smart.job.test");
    db.delete(settings).where(eq(settings.key, "smart_model")).run();
    invalidateSettingsCache();
    setSetting("fast_model", "fast.job.test");
    expect(importModel()).toBe("fast.job.test");
  });

  it("sweeps spools past retention and fails their still-open batches", async () => {
    const userId = await makeUser("t12j_swp");
    const dir = mkdtempSync(join(tmpdir(), "gce-sweep-"));
    const dayMs = 86_400_000;
    const stampOld = (path: string) => utimesSync(path, new Date(Date.now() - 2 * dayMs), new Date(Date.now() - 2 * dayMs));
    try {
      process.env.YASHA_IMPORT_DIR = dir;
      setSetting("import.spoolRetentionHours", "24");

      // Old spool of a queued batch → removed, batch failed with spool_expired.
      const openId = randomUUID();
      writeFileSync(join(dir, `${openId}.ndjson`), "x\n");
      stampOld(join(dir, `${openId}.ndjson`));
      db.insert(importBatches).values({ id: openId, userId, bytes: 2, status: "queued" }).run();

      // Old spool of a succeeded batch → removed, batch untouched.
      const doneId = randomUUID();
      writeFileSync(join(dir, `${doneId}.ndjson`), "x\n");
      stampOld(join(dir, `${doneId}.ndjson`));
      db.insert(importBatches).values({ id: doneId, userId, bytes: 2, status: "succeeded" }).run();

      // Young spool, unrelated file, directory named like a spool → all survive.
      const youngId = randomUUID();
      writeFileSync(join(dir, `${youngId}.ndjson`), "x\n");
      writeFileSync(join(dir, "notes.txt"), "keep me");
      mkdirSync(join(dir, `${randomUUID()}.ndjson`));

      expect(sweepGeminiSpools()).toBe(2);
      expect(existsSync(join(dir, `${openId}.ndjson`))).toBe(false);
      expect(existsSync(join(dir, `${doneId}.ndjson`))).toBe(false);
      expect(existsSync(join(dir, `${youngId}.ndjson`))).toBe(true);
      expect(existsSync(join(dir, "notes.txt"))).toBe(true);
      const open = db.select().from(importBatches).where(eq(importBatches.id, openId)).get()!;
      expect(open.status).toBe("failed");
      expect(open.error).toBe("spool_expired");
      expect(db.select().from(importBatches).where(eq(importBatches.id, doneId)).get()!.status).toBe("succeeded");

      // Stray .ndjson without a batch row: removed, nothing to mark.
      const stray = randomUUID();
      writeFileSync(join(dir, `${stray}.ndjson`), "x\n");
      stampOld(join(dir, `${stray}.ndjson`));
      expect(sweepGeminiSpools()).toBe(1);

      // Missing spool dir → 0 (fresh instance).
      rmSync(dir, { recursive: true, force: true });
      expect(sweepGeminiSpools()).toBe(0);
    } finally {
      process.env.YASHA_IMPORT_DIR = spoolDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
