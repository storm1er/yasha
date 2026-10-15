import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs } from "@/lib/db/schema";
import { ensureReady } from "@/lib/db";
import { dedupeKeyFor, enqueueJob, patchJob } from "@/lib/jobs/queue";
import { adminUser, type AdminUser } from "./support/app";
import { db, setSetting } from "./support/db";

let admin: AdminUser;

function row(id: string) {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

beforeAll(async () => {
  await ensureReady();
  admin = await adminUser();
});

beforeEach(() => {
  db.delete(jobs).run();
});

describe("dedupeKeyFor", () => {
  it("uses a unique key per call for debug.echo", () => {
    const a = dedupeKeyFor("debug.echo", "th1", admin.userId);
    const b = dedupeKeyFor("debug.echo", "th1", admin.userId);
    expect(a).toMatch(/^debug\.echo:\d+:\d+$/);
    expect(b).toMatch(/^debug\.echo:\d+:\d+$/);
    expect(a).not.toBe(b);
  });

  it("keys by thread when present, else by user (empty on neither)", () => {
    expect(dedupeKeyFor("chat.title_generation", "th-9")).toBe("chat.title_generation:th-9");
    expect(dedupeKeyFor("memory.dreaming", null, "u-9")).toBe("memory.dreaming:u-9");
    expect(dedupeKeyFor("memory.dreaming")).toBe("memory.dreaming:");
  });
});

describe("enqueueJob upsert", () => {
  it("inserts a fresh pending row (payload + runAfter + maxAttempts)", async () => {
    const runAfter = new Date(Date.now() + 60_000);
    const id = await enqueueJob({
      type: "memory.fact_extraction",
      userId: admin.userId,
      runAfter,
      payload: { note: "hi" },
      maxAttempts: 7,
    });
    expect(id).toBeTruthy();
    const r = row(id!)!;
    expect(r.status).toBe("pending");
    expect(r.runAfter.getTime()).toBe(runAfter.getTime());
    expect(r.maxAttempts).toBe(7);
    expect(r.attempts).toBe(0);
    expect(JSON.parse(r.payloadJson!)).toEqual({ note: "hi" });
    expect(r.dedupeKey).toBe(`memory.fact_extraction:${admin.userId}`);
    expect(r.threadId).toBeNull();
    expect(r.resultJson).toBeNull();
    expect(r.lastError).toBeNull();
  });

  it("wraps payload on force-only and merges force into payload", async () => {
    const a = await enqueueJob({ type: "memory.dreaming", userId: admin.userId, force: true });
    expect(JSON.parse(row(a!)!.payloadJson!)).toEqual({ force: true });
    const b = await enqueueJob({
      type: "memory.thread_summary",
      userId: admin.userId,
      payload: { x: 1 },
      force: true,
    });
    expect(JSON.parse(row(b!)!.payloadJson!)).toEqual({ x: 1, force: true });
  });

  it("defaults maxAttempts from settings", async () => {
    setSetting("memory.queue.defaultMaxAttempts", "5");
    try {
      const id = await enqueueJob({ type: "memory.dreaming", userId: admin.userId });
      expect(row(id!)!.maxAttempts).toBe(5);
    } finally {
      setSetting("memory.queue.defaultMaxAttempts", "3");
    }
  });

  it("fully resets a terminal row on re-enqueue", async () => {
    const first = await enqueueJob({ type: "memory.dreaming", userId: admin.userId, payload: { v: 1 } });
    patchJob(first!, {
      status: "succeeded",
      attempts: 2,
      lastError: "boom",
      resultJson: "{}",
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 10,
      lockedAt: new Date(),
      heartbeatAt: new Date(),
    });
    const again = await enqueueJob({ type: "memory.dreaming", userId: admin.userId });
    expect(again).toBe(first); // upsert resets the SAME row (id is insert-only)
    const r = row(again!)!;
    expect(r.status).toBe("pending");
    expect(r.attempts).toBe(0);
    expect(r.lastError).toBeNull();
    expect(r.resultJson).toBeNull();
    expect(r.startedAt).toBeNull();
    expect(r.finishedAt).toBeNull();
    expect(r.durationMs).toBeNull();
    expect(r.lockedAt).toBeNull();
    expect(r.heartbeatAt).toBeNull();
    expect(r.payloadJson).toBeNull();
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it("leaves a running row untouched and returns null", async () => {
    const id = await enqueueJob({ type: "memory.thread_summary", userId: admin.userId });
    db.update(jobs)
      .set({ status: "running", lockedAt: new Date(), attempts: 1, payloadJson: "keep" })
      .where(eq(jobs.id, id!))
      .run();
    const again = await enqueueJob({
      type: "memory.thread_summary",
      userId: admin.userId,
      payload: { ignore: true },
    });
    expect(again).toBeNull();
    const r = row(id!)!;
    expect(r.status).toBe("running");
    expect(r.attempts).toBe(1);
    expect(r.payloadJson).toBe("keep");
  });
});

describe("patchJob", () => {
  it("applies partial patches by id", async () => {
    const id = await enqueueJob({ type: "debug.echo", userId: admin.userId });
    patchJob(id!, { status: "cancelled", lastError: "nope" });
    const r = row(id!)!;
    expect(r.status).toBe("cancelled");
    expect(r.lastError).toBe("nope");
    expect(r.attempts).toBe(0);
  });
});
