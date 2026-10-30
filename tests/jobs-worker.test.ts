import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { eq, inArray } from "drizzle-orm";
import { ensureReady } from "@/lib/db";
import { importBatches, jobCheckpoints, jobs, messages, threads } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  HANDLERS,
  activeCount,
  ensureWorker,
  startWorker,
  stopWorker,
  type JobHandler,
} from "@/lib/jobs/worker";
import { adminUser, waitFor, type AdminUser } from "./support/app";
import { db, rawSqlite, setFastModel, setSetting } from "./support/db";
import { settings } from "@/lib/db/schema";
import { invalidateSettingsCache } from "@/lib/settings";
import { mockLemonade, scriptedCompletions, sseChatCompletion, streamResponse } from "./support/lemonade";
import { setUserMemoryEnabled } from "@/lib/memory/prefs";

let admin: AdminUser;
const origEcho = HANDLERS["debug.echo"];
const openStreams: { fail(err?: Error): void }[] = [];
const g = () => (globalThis as { __yashaWorker?: Record<string, unknown> }).__yashaWorker;

type JobInsert = Partial<typeof jobs.$inferInsert> & { type: string };

function insertJob(over: JobInsert): string {
  const id = randomUUID();
  const { dedupeKey, type, ...rest } = over;
  db.insert(jobs)
    .values({
      id,
      dedupeKey: dedupeKey ?? `${type}:${id}`,
      userId: admin.userId,
      status: "pending",
      runAfter: new Date(),
      ...rest,
      type,
    })
    .run();
  return id;
}

function newThread(over: { ageMs?: number; title?: string } = {}): string {
  const id = randomUUID();
  const now = new Date();
  db.insert(threads)
    .values({
      id,
      userId: admin.userId,
      model: "m",
      title: over.title ?? "",
      createdAt: new Date(now.getTime() - (over.ageMs ?? 0)),
      updatedAt: new Date(now.getTime() - (over.ageMs ?? 0)),
    })
    .run();
  return id;
}

function addMessage(threadId: string, role: "user" | "assistant", content: string): string {
  const id = randomUUID();
  db.insert(messages)
    .values({ id, threadId, role, content, createdAt: new Date() })
    .run();
  return id;
}

function row(id: string | null | undefined) {
  if (!id) return undefined;
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

function rowByDedupe(key: string) {
  return db.select().from(jobs).where(eq(jobs.dedupeKey, key)).get();
}

beforeAll(async () => {
  await ensureReady();
  admin = await adminUser();
});

beforeEach(() => {
  stopWorker();
  delete (globalThis as Record<string, unknown>).__yashaWorker;
  db.delete(jobs).run();
  db.delete(jobCheckpoints).run();
  db.delete(messages).run();
  db.delete(threads).run();
  delete process.env.NEXT_PHASE; // worker suites drive startWorker() directly
  db.delete(settings)
    .where(
      inArray(settings.key, [
        "memory.enabled",
        "fast_model",
        "smart_model",
        "chat.title_generation",
        "memory.events.fact_extraction",
        "memory.events.thread_summary",
        "memory.events.dreaming",
      ])
    )
    .run();
  invalidateSettingsCache();
  setSetting("memory.queue.claimIntervalMs", "1"); // → 1000ms tick floor
});

afterEach(async () => {
  for (const s of openStreams.splice(0)) s.fail(new Error("test cleanup"));
  stopWorker();
  delete process.env.NEXT_PHASE;
  setUserMemoryEnabled(admin.userId, null);
  try {
    delete (HANDLERS as Record<string, unknown>)["debug.echo"];
  } catch {
    /* not configurable */
  }
  HANDLERS["debug.echo"] = origEcho;
  await waitFor(() => activeCount() === 0, 8000).catch(() => undefined);
  delete (globalThis as Record<string, unknown>).__yashaWorker;
});

describe("worker lifecycle", () => {
  it("skips start during the production build and starts otherwise", () => {
    process.env.NEXT_PHASE = "phase-production-build";
    ensureWorker();
    expect(g()?.interval).toBeUndefined();
    delete process.env.NEXT_PHASE;
    startWorker();
    const handle = g()!;
    expect(handle.interval).toBeDefined();
    startWorker(); // restart over an existing interval + started already true
    expect(g()!.interval).toBeDefined();
    stopWorker();
    expect(handle.started).toBe(false);
  });

  it("claims an import job while the memory switch is on", async () => {
    setSetting("memory.enabled", "true");
    const importJob = insertJob({
      type: "import.gemini",
      dedupeKey: `import.gemini:${admin.userId}:${randomUUID()}`,
      payloadJson: JSON.stringify({ batchId: randomUUID() }),
    });
    startWorker();
    // No such batch row → the handler finishes with the clean "no-batch" stop.
    await waitFor(() => row(importJob)?.status === "succeeded");
    expect(JSON.parse(row(importJob)!.resultJson!)).toEqual({ stop: "no-batch" });
  });

  it("cancels queued memory work when the memory switch is off; imports still run", async () => {
    setSetting("memory.enabled", "false");
    const memory = insertJob({ type: "memory.fact_extraction" });
    const importJob = insertJob({
      type: "import.gemini",
      dedupeKey: `import.gemini:${admin.userId}:${randomUUID()}`,
      payloadJson: JSON.stringify({ batchId: randomUUID() }),
    });
    startWorker();
    await waitFor(() => row(memory)?.status === "cancelled" && row(importJob)?.status === "succeeded");
    expect(row(memory)!.lastError).toBe("disabled");
    // import ingestion ignores the memory switch; unknown batch → clean stop.
    expect(JSON.parse(row(importJob)!.resultJson!)).toEqual({ stop: "no-batch" });
  });

  it("sweeps expired import spools once on start", () => {
    const dir = mkdtempSync(join(tmpdir(), "gce-sweep-w-"));
    process.env.YASHA_IMPORT_DIR = dir;
    try {
      const batchId = randomUUID();
      writeFileSync(join(dir, `${batchId}.ndjson`), "x\n");
      utimesSync(join(dir, `${batchId}.ndjson`), new Date(0), new Date(0));
      db.insert(importBatches)
        .values({ id: batchId, userId: admin.userId, filename: "f.ndjson", bytes: 2, status: "queued" })
        .run();
      startWorker();
      expect(g()!.importSpoolsSwept).toBe(true);
      expect(existsSync(join(dir, `${batchId}.ndjson`))).toBe(false);
      const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get()!;
      expect(batch.status).toBe("failed");
      expect(batch.error).toBe("spool_expired");
    } finally {
      delete process.env.YASHA_IMPORT_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stopWorker without a started worker is a no-op", () => {
    stopWorker();
    expect(g()).toBeUndefined();
  });

  it("short-circuits a tick when the only concurrency slot is busy", async () => {
    const slow = new Promise<Record<string, unknown>>((resolve) => {
      setTimeout(() => resolve({ slow: true }), 2600);
    });
    HANDLERS["debug.echo"] = () => slow;
    const first = await enqueueJob({ type: "debug.echo", userId: admin.userId });
    const second = await enqueueJob({ type: "debug.echo", userId: admin.userId });
    startWorker();
    await waitFor(() => activeCount() === 1);
    await new Promise((r) => setTimeout(r, 1300)); // a full tick passes with the slot busy
    expect(row(second!)!.status).toBe("pending");
    await waitFor(() => row(first!)?.status === "succeeded" && row(second!)?.status === "succeeded", 12_000);
    stopWorker();
    await waitFor(() => activeCount() === 0);
  });
});

describe("prune + stale lease reclaim", () => {
  it("prunes old succeeded rows/orphan checkpoints and reclaims stale leases", async () => {
    setSetting("memory.queue.retentionDays", "1");
    setSetting("memory.queue.staleLeaseMs", "10000");
    const old = new Date(Date.now() - 2 * 86_400_000);
    insertJob({ type: "debug.echo", status: "succeeded", finishedAt: old });
    insertJob({ type: "debug.echo", status: "failed", finishedAt: old });
    insertJob({ type: "debug.echo", status: "succeeded", finishedAt: new Date() });
    const threadId = newThread();
    db.insert(jobCheckpoints)
      .values({ jobType: "memory.dreaming", threadId: "ghost-thread", throughMessageId: "m", updatedAt: new Date() })
      .run();
    db.insert(jobCheckpoints)
      .values({ jobType: "memory.dreaming", threadId, throughMessageId: "m", updatedAt: new Date() })
      .run();
    const staleA = insertJob({
      type: "debug.echo",
      status: "running",
      attempts: 0,
      maxAttempts: 3,
      heartbeatAt: new Date(Date.now() - 11_000),
      lockedAt: new Date(Date.now() - 30_000),
    });
    const staleB = insertJob({
      type: "debug.echo",
      status: "running",
      attempts: 2,
      maxAttempts: 3,
      lockedAt: new Date(Date.now() - 11_000), // heartbeatAt null → falls back to lockedAt
    });
    const staleC = insertJob({
      type: "debug.echo",
      status: "running",
      attempts: 0,
      maxAttempts: 1,
      lockedAt: new Date(Date.now() - 11_000),
    });
    insertJob({ type: "debug.echo", status: "running", heartbeatAt: new Date(), lockedAt: old }); // fresh → untouched
    startWorker();
    await waitFor(() => {
      const a = row(staleA);
      return (
        a?.status === "pending" &&
        row(staleB)?.status === "failed" &&
        row(staleC)?.status === "failed" &&
        db.select().from(jobCheckpoints).all().length === 1
      );
    });
    const a = row(staleA)!;
    expect(a.attempts).toBe(1);
    expect(a.lockedAt).toBeNull();
    expect(a.heartbeatAt).toBeNull();
    expect(a.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(row(staleB)!.lastError).toContain("lease_expired");
    expect(row(staleC)!.lastError).toContain("lease_expired");
    expect(db.select().from(jobs).all().some((j) => j.status === "succeeded" && j.finishedAt!.getTime() < Date.now() - 86_400_000)).toBe(false);
    expect(db.select().from(jobCheckpoints).all()[0].threadId).toBe(threadId);
    stopWorker();
    await waitFor(() => activeCount() === 0);
  });
});

describe("claim race (another worker won the row)", () => {
  it("leaves the row pending and claims it on a later tick", async () => {
    // Simulate a cross-process claim loss exactly once on the claim UPDATE.
    const origPrepare = rawSqlite.prepare.bind(rawSqlite) as unknown as (sql: string) => unknown;
    let armed = true; // intercept exactly one claim UPDATE, then stand down
    (rawSqlite as unknown as { prepare: (sql: string) => unknown }).prepare = (sqlText: string) => {
      const stmt = origPrepare(sqlText) as Record<string, unknown>;
      if (armed && /update "jobs"/i.test(sqlText) && typeof stmt.get === "function") {
        armed = false;
        stmt.get = () => undefined; // claim UPDATE executes but reports no row back
      }
      return stmt;
    };
    try {
      const id = await enqueueJob({ type: "debug.echo", userId: admin.userId, payload: { text: "raced" } });
      startWorker();
      await waitFor(() => row(id!)?.status === "succeeded", 10_000);
      expect(JSON.parse(row(id)!.resultJson!)).toEqual({ echoed: "raced" });
    } finally {
      (rawSqlite as unknown as { prepare: unknown }).prepare = origPrepare;
      stopWorker();
      await waitFor(() => activeCount() === 0);
    }
  });
});

describe("claim rejections", () => {
  it("cancels unknown job types (no_handler in tick)", async () => {
    const id = insertJob({ type: "bogus.type" });
    startWorker();
    await waitFor(() => row(id)?.status === "cancelled");
    expect(row(id)!.lastError).toBe("no_handler");
    stopWorker();
  });

  it("cancels in run() when the handler disappears after claim", async () => {
    const id = await enqueueJob({ type: "debug.echo", userId: admin.userId });
    let reads = 0;
    Object.defineProperty(HANDLERS, "debug.echo", {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? origEcho : undefined;
      },
    });
    startWorker();
    await waitFor(() => row(id!)?.status === "cancelled");
    expect(row(id!)!.lastError).toBe("no_handler");
    expect(reads).toBeGreaterThanOrEqual(2);
    delete (HANDLERS as Record<string, unknown>)["debug.echo"];
    HANDLERS["debug.echo"] = origEcho;
    stopWorker();
  });

  it("skips title generation when the job row has no thread (defensive)", async () => {
    setFastModel(); // pass the no_model gate so we reach the no_thread branch
    const titleHandler = HANDLERS["chat.title_generation"]!;
    let reads = 0;
    Object.defineProperty(HANDLERS, "debug.echo", {
      configurable: true,
      get() {
        reads += 1;
        if (reads === 1) return origEcho;
        return (ctx: Parameters<typeof titleHandler>[0]) =>
          titleHandler({ ...ctx, job: { ...ctx.job, threadId: null } });
      },
    });
    const id = await enqueueJob({ type: "debug.echo", userId: admin.userId });
    startWorker();
    await waitFor(() => row(id!)?.status === "succeeded", 8000);
    expect(JSON.parse(row(id!)!.resultJson!)).toEqual({ titleUpdated: false, skipped: "no_thread" });
    delete (HANDLERS as Record<string, unknown>)["debug.echo"];
    HANDLERS["debug.echo"] = origEcho;
    stopWorker();
  });

  it("cancels disabled types but force payloads bypass the gate", async () => {
    // no fast_model configured → chat.title_generation not allowed...
    const t1 = newThread();
    addMessage(t1, "user", "hi");
    const blocked = await enqueueJob({ type: "chat.title_generation", threadId: t1, userId: admin.userId });
    // ...but a manual force run claims the row; the handler then skips (no model).
    const t2 = newThread();
    const forced = await enqueueJob({
      type: "chat.title_generation",
      threadId: t2,
      userId: admin.userId,
      force: true,
    });
    startWorker();
    await waitFor(() => row(blocked!)?.status === "cancelled" && row(forced!)?.status === "succeeded");
    expect(row(blocked!)!.lastError).toBe("disabled");
    expect(row(forced!)!.lastError).toBeNull();
    expect(JSON.parse(row(forced!)!.resultJson!)).toEqual({
      titleUpdated: false,
      skipped: "no_model_configured",
    });
    stopWorker();
  });

  it("cancels memory jobs for users who opted out, even when forced", async () => {
    setUserMemoryEnabled(admin.userId, false);
    const forced = await enqueueJob({ type: "memory.fact_extraction", userId: admin.userId, force: true });
    startWorker();
    await waitFor(() => row(forced!)?.status === "cancelled");
    expect(row(forced!)!.lastError).toBe("user_disabled");
    stopWorker();
  });

  it("cancels queued memory work once the memory switch is flipped off; debug keeps running", async () => {
    setSetting("memory.enabled", "true");
    invalidateSettingsCache();
    startWorker();
    // Flip off + drop the settings cache before the first claim tick fires.
    setSetting("memory.enabled", "false");
    invalidateSettingsCache();
    const mem = await enqueueJob({ type: "memory.fact_extraction", userId: admin.userId });
    // debug.echo is a manual admin job — NOT affected by the memory switch:
    const dbg = await enqueueJob({ type: "debug.echo", userId: admin.userId, force: true });
    await waitFor(() => row(mem)?.status === "cancelled" && row(dbg)?.status === "succeeded", 8000);
    expect(row(mem)!.lastError).toBe("disabled");
  });

  it("tick and run tolerate the global worker handle being deleted", async () => {
    startWorker();
    const warm = await enqueueJob({ type: "debug.echo", userId: admin.userId });
    await waitFor(() => row(warm!)?.status === "succeeded", 8000); // first ticks happened with the handle
    const orphan = g()! as { interval?: ReturnType<typeof setInterval> };
    delete (globalThis as Record<string, unknown>).__yashaWorker;
    const after = await enqueueJob({ type: "debug.echo", userId: admin.userId, payload: { text: "orphan" } });
    await waitFor(() => row(after!)?.status === "succeeded", 8000); // tick/run recreate local state
    expect(JSON.parse(row(after!)!.resultJson!)).toEqual({ echoed: "orphan" });
    if (orphan.interval) clearInterval(orphan.interval); // stopWorker can no longer find the handle
  });

  it("logs a failed tick and recovers on the next one", async () => {
    startWorker();
    const handle = g()! as { lastTickAt?: number };
    await waitFor(() => handle.lastTickAt !== undefined, 8000); // prune ran; next ticks hit reclaim
    const origPrepare = rawSqlite.prepare.bind(rawSqlite) as unknown as (sql: string) => unknown;
    let armed = true;
    (rawSqlite as unknown as { prepare: (sql: string) => unknown }).prepare = (sqlText: string) => {
      const stmt = origPrepare(sqlText) as Record<string, unknown>;
      if (armed && sqlText.startsWith("select") && /"jobs"."status" = \?$/.test(sqlText.trim())) {
        armed = false;
        stmt.all = () => {
          throw new Error("tick boom");
        };
      }
      return stmt;
    };
    try {
      const id = await enqueueJob({ type: "debug.echo", userId: admin.userId, payload: { text: "after boom" } });
      await waitFor(() => row(id)?.status === "succeeded", 12_000); // one tick failed, a later tick claims
      expect(JSON.parse(row(id)!.resultJson!)).toEqual({ echoed: "after boom" });
    } finally {
      (rawSqlite as unknown as { prepare: unknown }).prepare = origPrepare;
      stopWorker();
    }
  });

  it("skips an in-flight TYPE even when a concurrency slot is free", async () => {
    const mock = mockLemonade();
    const s1 = streamResponse();
    openStreams.push(s1);
    let n = 0;
    mock.route("/v1/chat/completions", (_url, call) => {
      n += 1;
      if (n === 1) {
        s1.attach(call.signal);
        return s1.response;
      }
      return sseChatCompletion("Free Slot");
    });
    setFastModel();
    setSetting("memory.queue.concurrency", "2");
    const t1 = newThread();
    addMessage(t1, "user", "one");
    const t2 = newThread();
    addMessage(t2, "user", "two");
    const first = await enqueueJob({ type: "chat.title_generation", threadId: t1, userId: admin.userId });
    startWorker();
    await waitFor(() => activeCount() === 1);
    const second = await enqueueJob({ type: "chat.title_generation", threadId: t2, userId: admin.userId });
    await new Promise((r) => setTimeout(r, 2200)); // a tick passes: free slot BUT same type in flight
    expect(row(second!)!.status).toBe("pending");
    s1.pushText("Busy");
    s1.pushFinish();
    s1.done();
    await waitFor(() => row(first!)?.status === "succeeded" && row(second!)?.status === "succeeded", 10_000);
    stopWorker();
    await waitFor(() => activeCount() === 0);
  });
});

describe("title generation handler", () => {
  it("generates, cleans and persists titles; skips edge cases", async () => {
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", scriptedCompletions(['  \n"First Topic."\nignored line', "# Topic Two!", '""']));
    setFastModel();
    const t1 = newThread();
    addMessage(t1, "user", "What is the capital of France?");
    addMessage(t1, "assistant", "Paris.");
    const t2 = newThread();
    addMessage(t2, "user", "   "); // whitespace-only → "[image]" placeholder
    const t3 = newThread();
    addMessage(t3, "user", "third");
    const t4 = newThread();
    addMessage(t4, "assistant", "assistant-only thread"); // no user message
    const ids: string[] = [];
    for (const [i, t] of [t1, t2, t3, t4].entries()) {
      const id = await enqueueJob({
        type: "chat.title_generation",
        threadId: t,
        userId: admin.userId,
        runAfter: new Date(Date.now() + i * 50),
      });
      ids.push(id!);
    }
    startWorker();
    await waitFor(() => ids.every((id) => row(id)?.status === "succeeded"), 12_000);
    expect(db.select().from(threads).all().find((t) => t.id === t1)!.title).toBe("First Topic");
    expect(db.select().from(threads).all().find((t) => t.id === t2)!.title).toBe("Topic Two");
    expect(JSON.parse(row(ids[2])!.resultJson!)).toEqual({ titleUpdated: false, skipped: "empty_title" });
    expect(JSON.parse(row(ids[3])!.resultJson!)).toEqual({
      titleUpdated: false,
      skipped: "no_user_message",
    });
    const bodies = mock.bodies("/v1/chat/completions") as {
      messages: { role: string; content: string }[];
      max_tokens: number;
      temperature: number;
    }[];
    expect(bodies).toHaveLength(3);
    expect(bodies[0].messages[0].content).toContain("chat thread titles");
    expect(bodies[0].messages[1].content).toBe("User: What is the capital of France?\nAssistant: Paris.");
    expect(bodies[0].max_tokens).toBe(2048);
    expect(bodies[0].temperature).toBe(0.2);
    expect(bodies[1].messages[1].content).toBe("User: [image]");
    stopWorker();
    await waitFor(() => activeCount() === 0);
  });

  it("truncates very long user content in the prompt excerpt", async () => {
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", scriptedCompletions(["Long Thread"]));
    setFastModel();
    const t = newThread();
    addMessage(t, "user", "x".repeat(1500));
    const id = await enqueueJob({ type: "chat.title_generation", threadId: t, userId: admin.userId });
    startWorker();
    await waitFor(() => row(id!)?.status === "succeeded", 8000);
    const bodies = mock.bodies("/v1/chat/completions") as { messages: { content: string }[] }[];
    const prompt = bodies[0].messages[1].content;
    expect(prompt.length).toBeLessThan(1300);
    expect(prompt).toContain("…");
    stopWorker();
  });

  it("defers a second same-type job while one is in flight (concurrency guard)", async () => {
    const mock = mockLemonade();
    const s = streamResponse();
    openStreams.push(s);
    let n = 0;
    mock.route("/v1/chat/completions", (_url, call) => {
      n += 1;
      if (n === 1) {
        s.attach(call.signal);
        return s.response;
      }
      return sseChatCompletion("Later Title");
    });
    setFastModel();
    const t1 = newThread();
    addMessage(t1, "user", "one");
    const t2 = newThread();
    addMessage(t2, "user", "two");
    const first = await enqueueJob({ type: "chat.title_generation", threadId: t1, userId: admin.userId });
    startWorker();
    await waitFor(() => activeCount() === 1);
    const second = await enqueueJob({ type: "chat.title_generation", threadId: t2, userId: admin.userId });
    await new Promise((r) => setTimeout(r, 2200)); // a tick passes while first is running
    expect(row(second!)!.status).toBe("pending"); // same-type in flight → skipped
    s.pushText("Later Title");
    s.pushFinish();
    s.done();
    await waitFor(() => row(first!)?.status === "succeeded" && row(second!)?.status === "succeeded", 10_000);
    stopWorker();
    await waitFor(() => activeCount() === 0);
  });
});

describe("run failure paths", () => {
  it("aborts on job timeout, backs off, then fails at max attempts", async () => {
    const mock = mockLemonade();
    const s = streamResponse();
    openStreams.push(s);
    let tries = 0;
    mock.route("/v1/chat/completions", (_url, call) => {
      tries += 1;
      if (tries === 1) {
        s.attach(call.signal); // attempt 1: hangs until the job timeout aborts it
        return s.response;
      }
      return sseChatCompletion(""); // attempt 2: fails fast (empty_completion)
    });
    setFastModel();
    setSetting("chat.title_generation", JSON.stringify({ timeoutMs: 1000, backoffMs: 1000, maxAttempts: 9 }));
    const t = newThread();
    addMessage(t, "user", "hangs");
    const id = await enqueueJob({
      type: "chat.title_generation",
      threadId: t,
      userId: admin.userId,
      maxAttempts: 2,
    });
    startWorker();
    await waitFor(() => row(id)?.lastError === "timeout after 1000ms", 8000);
    expect(row(id)!.status).toBe("pending");
    expect(row(id)!.attempts).toBe(1);
    expect(row(id)!.lockedAt).toBeNull();
    await waitFor(() => row(id)?.status === "failed", 8000);
    expect(row(id)!.attempts).toBe(2);
    expect(row(id)!.finishedAt).not.toBeNull();
    expect(row(id)!.lastError).toBe("empty_completion");
    stopWorker();
    await waitFor(() => activeCount() === 0);
  });

  it("records Error messages from handlers", async () => {
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", scriptedCompletions([new Error("upstream exploded")]));
    setFastModel();
    const t = newThread();
    addMessage(t, "user", "hi");
    const id = await enqueueJob({
      type: "chat.title_generation",
      threadId: t,
      userId: admin.userId,
      maxAttempts: 1,
    });
    startWorker();
    await waitFor(() => row(id)?.status === "failed", 8000);
    expect(row(id)!.lastError).toContain("upstream exploded");
    stopWorker();
  });

  it("records non-Error throws from handlers", async () => {
    HANDLERS["debug.echo"] = async () => {
      throw "boom-string";
    };
    const id = insertJob({ type: "debug.echo", maxAttempts: 1 });
    startWorker();
    await waitFor(() => row(id)?.status === "failed", 8000);
    expect(row(id)!.lastError).toBe("boom-string");
    stopWorker();
  });

  it("stores an empty result object when a handler resolves null", async () => {
    HANDLERS["debug.echo"] = (async () => null) as unknown as JobHandler;
    const id = insertJob({ type: "debug.echo" });
    startWorker();
    await waitFor(() => row(id)?.status === "succeeded", 8000);
    expect(row(id)!.resultJson).toBe("{}");
    stopWorker();
  });

  it("keeps payload empty for garbage/array/null payloads", async () => {
    const ids = [
      await enqueueJob({ type: "debug.echo", userId: admin.userId }),
      insertJob({ type: "bogus.type" }), // second candidate of another type → break at need=1
      insertJob({ type: "debug.echo", payloadJson: "not json" }),
      insertJob({ type: "debug.echo", payloadJson: "[1,2]" }),
      insertJob({ type: "debug.echo", payloadJson: "null" }),
    ];
    startWorker();
    await waitFor(() => ids.every((id) => id && (row(id)?.status === "succeeded" || row(id)?.status === "cancelled")), 15_000);
    for (const id of ids) {
      const r = row(id!)!;
      if (r.type === "debug.echo") expect(JSON.parse(r.resultJson!)).toEqual({ echoed: "" });
      else expect(r.lastError).toBe("no_handler");
    }
    stopWorker();
  });
});

describe("checkpoints + deferred commits", () => {
  it("advances the watermark and runs deferred writes atomically", async () => {
    const t = newThread();
    const cpHandler: JobHandler = async ({ payload, setCheckpoint, addCommit, heartbeat }) => {
      heartbeat();
      if (payload.cpId) setCheckpoint(String(payload.cpId));
      if (payload.tId) {
        const tId = String(payload.tId);
        addCommit((tx) => {
          tx.update(threads).set({ title: "deferred!" }).where(eq(threads.id, tId)).run();
        });
      }
      return { ok: 1 };
    };
    HANDLERS["debug.echo"] = cpHandler;
    const r1 = insertJob({ type: "debug.echo", threadId: t, payloadJson: JSON.stringify({ cpId: "m1", tId: t }) });
    const r2 = insertJob({ type: "debug.echo", payloadJson: JSON.stringify({ cpId: "m2" }) });
    const r3 = insertJob({ type: "debug.echo", threadId: t, payloadJson: JSON.stringify({ cpId: "m3", tId: t }) });
    const r4 = insertJob({ type: "debug.echo", threadId: t, payloadJson: JSON.stringify({ tId: t }) });
    startWorker();
    await waitFor(() => [r1, r2, r3, r4].every((id) => row(id)?.status === "succeeded"), 15_000);
    const cps = db.select().from(jobCheckpoints).all();
    expect(cps).toHaveLength(2); // ("debug.echo", t) updated to m3, ("debug.echo","") inserted
    expect(cps.find((c) => c.threadId === t)!.throughMessageId).toBe("m3");
    expect(cps.find((c) => c.threadId === "")!.throughMessageId).toBe("m2");
    expect(db.select().from(threads).all()[0].title).toBe("deferred!");
    expect(JSON.parse(row(r4)!.resultJson!)).toEqual({ ok: 1 });
    stopWorker();
  });
});

describe("schedule sweeps", () => {
  it("idle sweep: enqueues stale threads and re-enqueues terminal rows", async () => {
    const mock = mockLemonade();
    mock.fallback(() => sseChatCompletion("A tidy summary"));
    setFastModel();
    setSetting("chat.title_generation", JSON.stringify({ schedule: "idle", idleMinutes: 1 }));
    const old = 120_000;
    const tFresh = newThread(); // never stale → never swept
    const tA = newThread({ ageMs: old });
    const tB = newThread({ ageMs: old });
    const tC = newThread({ ageMs: old });
    const tD = newThread({ ageMs: old });
    const tE = newThread({ ageMs: old });
    for (const t of [tA, tB, tC, tD, tE]) addMessage(t, "user", "hi");
    // pending row on tA → rowAlreadyCovers → skip (no reset churn)
    db.insert(jobs)
      .values({
        id: randomUUID(),
        dedupeKey: `chat.title_generation:${tA}`,
        type: "chat.title_generation",
        threadId: tA,
        userId: admin.userId,
        status: "pending",
        runAfter: new Date(Date.now() + 600_000),
      })
      .run();
    // succeeded with finishedAt >= updatedAt → covered → stays succeeded forever
    const doneTime = new Date(Date.now() + 1000);
    db.insert(jobs)
      .values({
        id: randomUUID(),
        dedupeKey: `chat.title_generation:${tB}`,
        type: "chat.title_generation",
        threadId: tB,
        userId: admin.userId,
        status: "succeeded",
        runAfter: new Date(Date.now() + 600_000),
        finishedAt: doneTime,
      })
      .run();
    // cancelled → NOT covered → swept re-enqueue resets it
    db.insert(jobs)
      .values({
        id: randomUUID(),
        dedupeKey: `chat.title_generation:${tC}`,
        type: "chat.title_generation",
        threadId: tC,
        userId: admin.userId,
        status: "cancelled",
        runAfter: new Date(),
        finishedAt: new Date(Date.now() - 10_000),
      })
      .run();
    // succeeded but finished BEFORE the thread's last activity → re-enqueue → retitled
    db.insert(jobs)
      .values({
        id: randomUUID(),
        dedupeKey: `chat.title_generation:${tD}`,
        type: "chat.title_generation",
        threadId: tD,
        userId: admin.userId,
        status: "succeeded",
        runAfter: new Date(Date.now() + 600_000),
        finishedAt: new Date(Date.now() - 300_000),
      })
      .run();
    db.update(threads).set({ title: "STALE-TITLE", updatedAt: new Date(Date.now() - 120_000) }).where(eq(threads.id, tD)).run();
    startWorker();
    await waitFor(
      () =>
        db.select().from(threads).all().find((t) => t.id === tD)!.title === "A tidy summary" &&
        rowByDedupe(`chat.title_generation:${tC}`)!.status !== "cancelled",
      15_000
    );
    expect(rowByDedupe(`chat.title_generation:${tB}`)!.status).toBe("succeeded");
    expect(db.select().from(jobs).all().some((j) => j.dedupeKey === `chat.title_generation:${tFresh}`)).toBe(false);
    expect(rowByDedupe(`chat.title_generation:${tE}`)).toBeDefined(); // plain stale thread enqueued
    stopWorker();
    await waitFor(() => activeCount() === 0);
  });

  it("memory-disabled instance pauses the idle sweeper", async () => {
    setSetting("memory.enabled", "false");
    setFastModel();
    setSetting("memory.events.thread_summary", JSON.stringify({ schedule: "idle", idleMinutes: 1 }));
    const t = newThread({ ageMs: 120_000 });
    const id = insertJob({
      type: "memory.thread_summary",
      dedupeKey: `memory.thread_summary:${t}`,
      status: "cancelled",
      runAfter: new Date(),
      finishedAt: new Date(Date.now() - 10_000),
    });
    startWorker();
    await new Promise((r) => setTimeout(r, 2500));
    expect(row(id)!.status).toBe("cancelled"); // never re-enqueued
    stopWorker();
  });

  it("memory-disabled user pauses the idle sweeper for that user", async () => {
    setUserMemoryEnabled(admin.userId, false);
    setFastModel();
    setSetting("memory.events.thread_summary", JSON.stringify({ schedule: "idle", idleMinutes: 1 }));
    const t = newThread({ ageMs: 120_000 });
    startWorker();
    await new Promise((r) => setTimeout(r, 2500));
    expect(rowByDedupe(`memory.thread_summary:${t}`)).toBeUndefined();
  });

  it("cron sweep: fires title+dreaming rows, guards per fire minute, skips small threads", async () => {
    const mock = mockLemonade();
    mock.fallback(() => sseChatCompletion("Cron Title"));
    setFastModel();
    setSetting("chat.title_generation", JSON.stringify({ schedule: "cron", cronExpr: "*/5 * * * *" }));
    const tOk = newThread({ ageMs: 360_000 });
    addMessage(tOk, "user", "one");
    addMessage(tOk, "assistant", "two");
    const tSmall = newThread({ ageMs: 360_000 });
    addMessage(tSmall, "user", "only one message");
    const tCovered = newThread({ ageMs: 360_000 });
    addMessage(tCovered, "user", "one");
    addMessage(tCovered, "assistant", "two");
    db.insert(jobs)
      .values({
        id: randomUUID(),
        dedupeKey: `chat.title_generation:${tCovered}`,
        type: "chat.title_generation",
        threadId: tCovered,
        userId: admin.userId,
        status: "succeeded",
        runAfter: new Date(Date.now() + 600_000),
        finishedAt: new Date(), // finished after last activity → covered
      })
      .run();
    // Pre-seed the per-fire-minute guard so the sweep skips tGuarded (key must
    // equal the current prev-fire instant, as sweepCron computes it).
    const prev = CronExpressionParser.parse("*/5 * * * *", { currentDate: new Date() }).prev();
    const prevKey = (prev instanceof Date ? prev : new Date(prev.toDate())).toISOString();
    const tGuarded = newThread({ ageMs: 360_000 });
    addMessage(tGuarded, "user", "a");
    addMessage(tGuarded, "assistant", "b");
    const tCancel = newThread({ ageMs: 360_000 });
    addMessage(tCancel, "user", "a");
    addMessage(tCancel, "assistant", "b");
    db.insert(jobs)
      .values({
        id: randomUUID(),
        dedupeKey: `chat.title_generation:${tCancel}`,
        type: "chat.title_generation",
        threadId: tCancel,
        userId: admin.userId,
        status: "cancelled",
        runAfter: new Date(),
        finishedAt: new Date(Date.now() - 10_000),
      })
      .run();
    // dreaming row already covered by a fresh terminal run → cron skip
    db.insert(jobs)
      .values({
        id: randomUUID(),
        dedupeKey: `memory.dreaming:${admin.userId}`,
        type: "memory.dreaming",
        userId: admin.userId,
        status: "succeeded",
        runAfter: new Date(Date.now() + 600_000),
        finishedAt: new Date(),
        resultJson: "{}",
      })
      .run();
    // succeeded row with NO finishedAt → rowAlreadyCovers falls back to 0 → re-swept
    const tNoFinish = newThread({ ageMs: 360_000 });
    addMessage(tNoFinish, "user", "a");
    addMessage(tNoFinish, "assistant", "b");
    db.insert(jobs)
      .values({
        id: randomUUID(),
        dedupeKey: `chat.title_generation:${tNoFinish}`,
        type: "chat.title_generation",
        threadId: tNoFinish,
        userId: admin.userId,
        status: "succeeded",
        runAfter: new Date(),
      })
      .run();
    startWorker();
    (g()!.cronEnqueued as Map<string, string>).set(`chat.title_generation|chat.title_generation:${tGuarded}`, prevKey);
    await waitFor(
      () =>
        rowByDedupe(`chat.title_generation:${tOk}`)?.status === "succeeded" &&
        rowByDedupe(`chat.title_generation:${tNoFinish}`)?.resultJson === JSON.stringify({ titleUpdated: true, title: "Cron Title" }),
      15_000
    );
    expect(rowByDedupe(`memory.dreaming:${admin.userId}`)!.resultJson).toBe("{}"); // covered → untouched
    expect(rowByDedupe(`chat.title_generation:${tSmall}`)).toBeUndefined(); // <2 messages
    expect(rowByDedupe(`chat.title_generation:${tCovered}`)!.status).toBe("succeeded");
    expect(rowByDedupe(`chat.title_generation:${tGuarded}`)).toBeUndefined(); // fire-minute guard holds
    await waitFor(() => rowByDedupe(`chat.title_generation:${tCancel}`)?.status === "succeeded", 12_000); // cancelled row re-swept
    stopWorker();
    await waitFor(() => activeCount() === 0);
  });

  it("cron sweep: disabled, invalid expression and user opt-out all no-op", async () => {
    setFastModel();
    setSetting("memory.events.dreaming", JSON.stringify({ enabled: "false" }));
    setSetting("memory.events.thread_summary", JSON.stringify({ schedule: "cron", cronExpr: "bogus expr !!" }));
    const t = newThread({ ageMs: 120_000 });
    addMessage(t, "user", "x");
    startWorker();
    await new Promise((r) => setTimeout(r, 2500));
    expect(rowByDedupe(`memory.dreaming:${admin.userId}`)).toBeUndefined(); // disabled
    expect(db.select().from(jobs).all()).toHaveLength(0); // invalid cron enqueued nothing
    stopWorker();
    setUserMemoryEnabled(admin.userId, false);
    setSetting("memory.events.dreaming", JSON.stringify({}));
    startWorker();
    await new Promise((r) => setTimeout(r, 1300));
    expect(rowByDedupe(`memory.dreaming:${admin.userId}`)).toBeUndefined(); // user gated
  });
});

describe("sweeper enqueue failure", () => {
  it("logs and swallows enqueue errors from cron sweep", async () => {
    vi.resetModules();
    vi.doMock("@/lib/jobs/queue", async () => {
      const actual = await vi.importActual<Record<string, unknown>>("@/lib/jobs/queue");
      return { ...actual, enqueueJob: async () => { throw new Error("enqueue down"); } };
    });
    const w = await import("@/lib/jobs/worker");
    setFastModel();
    try {
      w.startWorker();
      // cron guard map is filled before the (failing) enqueue → observable
      await waitFor(() => (((globalThis as { __yashaWorker?: { cronEnqueued?: Map<string, string> } }).__yashaWorker?.cronEnqueued?.size ?? 0) >= 1), 8000);
    } finally {
      w.stopWorker();
      vi.doUnmock("@/lib/jobs/queue");
      vi.resetModules();
    }
  });
});

describe("module load variant (no title handler registered)", () => {
  it("computes SCHEDULED_EVENT_TYPES without chat.title_generation", async () => {
    vi.resetModules();
    vi.doMock("@/lib/jobs/handlers", () => ({ handleTitleGeneration: undefined }));
    const workerMod = await import("@/lib/jobs/worker");
    expect(workerMod.HANDLERS["chat.title_generation"]).toBeUndefined();
    vi.doUnmock("@/lib/jobs/handlers");
    vi.resetModules();
  });
});

describe("lazy instance tick + heartbeat timer", () => {
  it("a freshly loaded worker module claims, ticks and heartbeats", async () => {
    vi.resetModules();
    const w = await import("@/lib/jobs/worker");
    delete (globalThis as Record<string, unknown>).__yashaWorker;
    const slowHandler: JobHandler = ({ heartbeat }) =>
      new Promise((resolve) => {
        heartbeat();
        setTimeout(() => resolve({ slow: true }), 16_200); // outlives the 15s heartbeat interval
      });
    w.HANDLERS["debug.echo"] = slowHandler;
    const id = await enqueueJob({ type: "debug.echo", userId: admin.userId });
    w.startWorker();
    await waitFor(() => ((globalThis as { __yashaWorker?: { interval?: unknown } }).__yashaWorker?.interval !== undefined));
    try {
      const hbBefore = row(id)?.heartbeatAt?.getTime();
      await waitFor(() => row(id)?.status === "succeeded", 25_000);
      expect(row(id)!.heartbeatAt!.getTime()).toBeGreaterThan(hbBefore ?? 0); // heartbeat timer fired
      expect(JSON.parse(row(id)!.resultJson!)).toEqual({ slow: true });
    } finally {
      w.stopWorker();
      delete (globalThis as Record<string, unknown>).__yashaWorker;
      vi.resetModules();
    }
  });
});

describe("completeOnce (shared upstream call)", () => {
  it("drives one claim on the final module instance, then exercises completion paths", async () => {
    const workerMod = await import("@/lib/jobs/worker");
    delete (globalThis as Record<string, unknown>).__yashaWorker;
    workerMod.HANDLERS["debug.echo"] = async () => {
      await new Promise((r) => setTimeout(r, 1400)); // outlives one tick so a later tick sees the slot busy
      return { echoed: "final" };
    };
    const rids = [
      await enqueueJob({ type: "debug.echo", userId: admin.userId }),
      await enqueueJob({ type: "debug.echo", userId: admin.userId }),
    ];
    workerMod.startWorker();
    await waitFor(() => rids.every((id) => row(id)?.status === "succeeded"), 12_000);
    workerMod.stopWorker();
    delete (globalThis as Record<string, unknown>).__yashaWorker;
    const { completeOnce } = workerMod;
    const call = (model: string, extra: { maxTokens?: number; temperature?: number } = {}) =>
      completeOnce({ model, messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal, ...extra });
    let mock = mockLemonade();
    mock.route("/v1/chat/completions", () => new Response("nope", { status: 500 }));
    await expect(call("m")).rejects.toThrow("upstream_status_500");
    mock = mockLemonade();
    mock.route("/v1/chat/completions", () => new Response(null, { status: 200 }));
    await expect(call("m")).rejects.toThrow("upstream_status_200");
    mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion(""));
    await expect(call("m")).rejects.toThrow("empty_completion");
    // Reasoning-only first stream (empty content) → one wider retry, then the hard failure.
    expect(
      (mock.bodies("/v1/chat/completions") as { max_tokens: number }[]).map((b) => b.max_tokens)
    ).toEqual([2048, 8192]);
    mock = mockLemonade();
    let calls = 0;
    mock.route("/v1/chat/completions", () => sseChatCompletion(++calls === 1 ? "" : "Recovered"));
    await expect(call("m", { maxTokens: 400 })).resolves.toBe("Recovered");
    expect(calls).toBe(2);
    mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion("junk\nReal"));
    await expect(call("m")).resolves.toBe("junk\nReal"); // no think tags → untouched
    mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion("junk\n" + "<" + "think>x</" + "think>Real"));
    await expect(call("m")).resolves.toBe("Real"); // reasoning traces stripped
    mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion("Real", { reasoning: "deep thoughts" }));
    await expect(call("m")).resolves.toBe("Real"); // reasoning deltas ignored
    const body = JSON.parse(mock.lastCall()!.body!) as Record<string, unknown>;
    expect(body.max_tokens).toBe(2048); // sub-floor budgets are raised (thinking bills tokens)
    expect(body.temperature).toBeUndefined();
    expect(body.stream).toBe(true);
    mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion("Real"));
    await expect(call("m", { maxTokens: 4096, temperature: 0.5 })).resolves.toBe("Real");
    const body2 = JSON.parse(mock.lastCall()!.body!) as Record<string, unknown>;
    expect(body2.max_tokens).toBe(4096); // budgets above the floor are honoured as-is
    expect(body2.temperature).toBe(0.5);
    // M3 divergence (accepted): malformed SSE frames are FATAL for the SDK
    // parser (v1 skipped them) — a bad frame after partial content fails the
    // job instead of forgiving the stream.
    mock = mockLemonade();
    const s = streamResponse();
    s.pushText("junk");
    s.pushRaw("data: {this is not json\n\n");
    s.pushText("Real");
    s.done();
    mock.route("/v1/chat/completions", () => s.response);
    await expect(call("m")).rejects.toThrow("JSON parsing failed");
  });
});

describe("completeOnce abort plumbing", () => {
  it("rejects with Error('aborted') when the signal reason is not an Error", async () => {
    const mock = mockLemonade();
    mock.route("/v1/chat/completions", () => sseChatCompletion("never seen"));
    const ac = new AbortController();
    ac.abort("halt"); // non-Error abort reason → synthesized Error("aborted")
    const { completeOnce } = await import("@/lib/jobs/worker");
    await expect(
      completeOnce({ model: "m", messages: [{ role: "user", content: "hi" }], signal: ac.signal })
    ).rejects.toThrow("aborted");
  });
});
