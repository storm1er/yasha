import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, setSetting } from "./support/db";
import { callRoute, makeRequest, signUp, type TestUser } from "./support/app";
import { importBatches, jobs, settings, user as users } from "@/lib/db/schema";
import { handleGeminiImport } from "@/lib/jobs/gemini-import";
import type { JobHandler } from "@/lib/jobs/worker";
import { GET as listGet } from "@/app/api/import/gemini/route";
import { GET as detailGet, POST as detailPost } from "@/app/api/import/gemini/[id]/route";
import { POST as uploadPost, isFirstLineObject, safeFileName, scanHead } from "@/app/api/import/gemini/upload/route";

const spoolDir = mkdtempSync(join(tmpdir(), "gce-routes-"));
const savedSpoolEnv = process.env.YASHA_IMPORT_DIR;

beforeAll(() => {
  process.env.YASHA_IMPORT_DIR = spoolDir;
});

afterEach(() => {
  db.delete(jobs).run();
});

afterAll(() => {
  if (savedSpoolEnv === undefined) delete process.env.YASHA_IMPORT_DIR;
  else process.env.YASHA_IMPORT_DIR = savedSpoolEnv;
  rmSync(spoolDir, { recursive: true, force: true });
});

let seq = 0;
async function user(): Promise<TestUser> {
  return signUp(`t13r${(seq += 1)}`);
}
function userIdOf(username: string): string {
  return db.select({ id: users.id }).from(users).where(eq(users.username, username)).get()!.id;
}

const ND = { "content-type": "application/x-ndjson" };
const conv = (id: string, text: string) =>
  JSON.stringify({ id, title: `t${id}`, turns: [{ role: "user", text }, { role: "model", text: "a" + text }], flags: [] });

function upload(u: TestUser, body: BodyInit, headers: Record<string, string> = ND) {
  return callRoute(uploadPost, { method: "POST", path: "/api/import/gemini/upload", cookie: u.cookie, body, headers });
}
function batch(id: string) {
  const row = db.select().from(importBatches).where(eq(importBatches.id, id)).get();
  if (!row) throw new Error("batch missing");
  return row;
}
async function runJob(userId: string, batchId: string): Promise<Record<string, unknown>> {
  const ctx = {
    job: { id: randomUUID(), dedupeKey: "k", type: "import.gemini", threadId: null, userId, status: "running", attempts: 0, payloadJson: null } as never,
    payload: { batchId },
    cfg: {} as never,
    signal: new AbortController().signal,
    heartbeat: () => {},
    setCheckpoint: () => {},
    addCommit: () => {},
  } as unknown as Parameters<JobHandler>[0];
  return handleGeminiImport(ctx);
}

describe("POST /api/import/gemini/upload", () => {
  it("requires a session", async () => {
    const res = await callRoute(uploadPost, { method: "POST", path: "/api/import/gemini/upload", body: "{}\n", headers: ND });
    expect(res.status).toBe(401);
  });

  it("spools the body, records sha/bytes and enqueues the chain (202)", async () => {
    const u = await user();
    const content = conv("c1", "hello") + "\n" + conv("c2", "bonjour") + "\n";
    const res = await upload(u, content, { ...ND, "x-file-name": "C:\\Users\\me\\gemini_chats.ndjson" });
    expect(res.status).toBe(202);
    const { importId, bytes } = (await res.json()) as { importId: string; bytes: number };
    const row = batch(importId);
    expect(row.status).toBe("queued");
    expect(row.filename).toBe("gemini_chats.ndjson");
    expect(row.bytes).toBe(Buffer.byteLength(content));
    expect(bytes).toBe(Buffer.byteLength(content));
    expect(row.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(readFileSync(join(spoolDir, `${importId}.ndjson`), "utf8")).toBe(content);
    const queued = db.select().from(jobs).where(eq(jobs.userId, userIdOf(u.username))).all();
    expect(queued).toHaveLength(1);
    expect(queued[0].type).toBe("import.gemini");
    expect(queued[0].dedupeKey).toBe(`import.gemini:${userIdOf(u.username)}:${importId}`);

    // The queue job then imports it end-to-end.
    const result = await runJob(userIdOf(u.username), importId);
    expect(result).toMatchObject({ stop: "eof", status: "succeeded", imported: 2 });
  });

  it("regression: ?learn=1 persists optionsJson AND the chunk job enqueues fact extraction per created thread", async () => {
    const u = await user();
    const uid = userIdOf(u.username);
    const content = conv("l1", "hi") + "\n" + conv("l2", "ho") + "\n";
    const res = await callRoute(uploadPost, {
      method: "POST",
      path: "/api/import/gemini/upload",
      query: { learn: "1" },
      cookie: u.cookie,
      body: content,
      headers: ND,
    });
    expect(res.status).toBe(202);
    const { importId } = (await res.json()) as { importId: string };
    // The flag must be persisted on the batch row — the chunk job re-reads it
    // from there (dropping it here silently disabled "learn from imports").
    expect(JSON.parse(batch(importId).optionsJson!)).toEqual({ learnFromImports: true });

    // Visible through the poll endpoints too.
    const view = await callRoute(listGet, { path: "/api/import/gemini", cookie: u.cookie });
    const vbody = (await view.json()) as { imports: { options: { learnFromImports: boolean } }[] };
    expect(vbody.imports[0]!.options).toEqual({ learnFromImports: true });

    // Running the chunk job must then fan out memory.fact_extraction rows.
    const result = await runJob(uid, importId);
    expect(result).toMatchObject({ stop: "eof", imported: 2 });
    const facts = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, uid), eq(jobs.type, "memory.fact_extraction")))
      .all();
    expect(facts).toHaveLength(2);
  });

  it("?learn=true is accepted; absent/non-truthy flags persist no options", async () => {
    const uTrue = await user();
    const resTrue = await callRoute(uploadPost, {
      method: "POST",
      path: "/api/import/gemini/upload",
      query: { learn: "true" },
      cookie: uTrue.cookie,
      body: conv("t1", "x") + "\n",
      headers: ND,
    });
    expect(resTrue.status).toBe(202);
    const { importId } = (await resTrue.json()) as { importId: string };
    expect(JSON.parse(batch(importId).optionsJson!)).toEqual({ learnFromImports: true });

    const uOff = await user();
    const resOff = await callRoute(uploadPost, {
      method: "POST",
      path: "/api/import/gemini/upload",
      query: { learn: "0" },
      cookie: uOff.cookie,
      body: conv("o1", "x") + "\n",
      headers: ND,
    });
    expect(resOff.status).toBe(202);
    const off = (await resOff.json()) as { importId: string };
    expect(batch(off.importId).optionsJson).toBeNull();
  });

  it("accepts a single-line file without a trailing newline", async () => {
    const u = await user();
    const res = await upload(u, conv("solo", "x"));
    expect(res.status).toBe(202);
    const { importId } = (await res.json()) as { importId: string };
    expect(batch(importId).status).toBe("queued");
  });

  it("rejects a second active batch (one at a time)", async () => {
    const u = await user();
    const active = randomUUID();
    db.insert(importBatches)
      .values({ id: active, userId: userIdOf(u.username), filename: "x.ndjson", bytes: 1, status: "running" })
      .run();
    const res = await upload(u, conv("c", "x") + "\n");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "import_in_progress", importId: active });
  });

  it("fails stale `uploading` rows to free the slot, but not young ones", async () => {
    const u = await user();
    const old = randomUUID();
    db.insert(importBatches)
      .values({
        id: old,
        userId: userIdOf(u.username),
        filename: "x.ndjson",
        bytes: 1,
        status: "uploading",
        createdAt: new Date(Date.now() - 7 * 86_400_000),
      })
      .run();
    const res = await upload(u, conv("c", "x") + "\n");
    expect(res.status).toBe(202);
    expect(batch(old).status).toBe("failed");
    expect(batch(old).error).toBe("upload_stale");
  });

  it("rejects an empty upload (no body / zero bytes) and reaps the spool", async () => {
    const u = await user();
    const noBody = await upload(u, "");
    expect(noBody.status).toBe(400);
    const body = (await noBody.json()) as { error: string; importId: string };
    expect(body.error).toBe("empty_upload");
    expect(batch(body.importId).status).toBe("failed");
    expect(existsSync(join(spoolDir, `${body.importId}.ndjson`))).toBe(false);
  });

  it("rejects a first line that is not a JSON object", async () => {
    const u = await user();
    const res = await upload(u, `not json at all\n${conv("c", "x")}\n`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; importId: string };
    expect(body.error).toBe("not_ndjson");
    expect(existsSync(join(spoolDir, `${body.importId}.ndjson`))).toBe(false);
  });

  it("rejects a lone line (no trailing newline) that is not JSON", async () => {
    const u = await user();
    const res = await upload(u, "oops");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not_ndjson");
  });

  it("rejects a first line longer than the sanity cap", async () => {
    const u = await user();
    const res = await upload(u, "x".repeat(1_000_001));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("not_ndjson");
  });

  it("enforces import.maxUploadBytes while streaming", async () => {
    const u = await user();
    setSetting("import.maxUploadBytes", "1024");
    const res = await upload(u, "x".repeat(2048));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; importId: string };
    expect(body.error).toBe("upload_too_large");
    expect(batch(body.importId).status).toBe("failed");
    expect(existsSync(join(spoolDir, `${body.importId}.ndjson`))).toBe(false);
  });

  it("treats a client abort mid-stream as upload_aborted", async () => {
    const u = await user();
    // Multi-chunk stream: chunk 1 closes the first-line head, chunk 2 streams
    // past the head tracker, and the abort (pull 3) stops the route before it
    // processes chunk 3 — the classic mid-upload client disconnect.
    const ac = new AbortController();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 2) controller.enqueue(new TextEncoder().encode(conv(`c${pulls}`, "x") + "\n"));
        else if (pulls === 3) {
          ac.abort();
          controller.enqueue(new TextEncoder().encode(conv("c3", "late") + "\n"));
        } else controller.close();
      },
    });
    const req = makeRequest({
      method: "POST",
      path: "/api/import/gemini/upload",
      cookie: u.cookie,
      body: stream as unknown as BodyInit,
      headers: ND,
      signal: ac.signal,
    });
    const res = await uploadPostRaw(req);
    expect(res.status).toBe(499);
    const body = (await res.json()) as { error: string; importId: string };
    expect(body.error).toBe("upload_aborted");
    expect(batch(body.importId).status).toBe("failed");
    expect(existsSync(join(spoolDir, `${body.importId}.ndjson`))).toBe(false);
  });

  it("maps a storage failure to upload_failed (500)", async () => {
    const u = await user();
    // Spool dir rooted at a regular FILE → mkdirSync fails (ENOTDIR) and the
    // route must degrade cleanly. (Never probe /proc paths here: mkdir on
    // procfs blocks the event loop.)
    const blocker = join(spoolDir, "not-a-dir");
    writeFileSync(blocker, "x");
    process.env.YASHA_IMPORT_DIR = blocker;
    try {
      const res = await upload(u, conv("c", "x") + "\n");
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; importId: string };
      expect(body.error).toBe("upload_failed");
      expect(batch(body.importId).status).toBe("failed");
    } finally {
      process.env.YASHA_IMPORT_DIR = spoolDir;
    }
  });
});

describe("GET /api/import/gemini + /api/import/gemini/[id]", () => {
  it("requires a session on both", async () => {
    expect((await callRoute(listGet, { path: "/api/import/gemini" })).status).toBe(401);
    expect((await callRoute(detailGet, { path: "/x" }, { params: Promise.resolve({ id: randomUUID() }) })).status).toBe(401);
  });

  it("lists the user's batches newest first (and nobody else's)", async () => {
    const me = await user();
    const other = await user();
    const id = randomUUID();
    db.insert(importBatches)
      .values({
        id,
        userId: userIdOf(me.username),
        filename: "old.ndjson",
        bytes: 7,
        status: "succeeded",
        imported: 3,
        createdAt: new Date(Date.now() - 60_000),
      })
      .run();
    db.insert(importBatches)
      .values({ id: randomUUID(), userId: userIdOf(other.username), filename: "x", bytes: 1, status: "queued" })
      .run();
    const res = await callRoute(listGet, { path: "/api/import/gemini", cookie: me.cookie });
    const body = (await res.json()) as { imports: Record<string, unknown>[]; learnEnabled?: boolean };
    expect(body.imports).toHaveLength(1);
    expect(body.imports[0]).toMatchObject({
      importId: id,
      status: "succeeded",
      filename: "old.ndjson",
      counts: { imported: 3, failed: 0 },
      options: { learnFromImports: false },
      startedAt: null,
    });
    // learnFromImports availability flag follows the admin memory switch:
    expect(body.learnEnabled).toBe(true);
    setSetting("memory.enabled", "false");
    const offRes = await callRoute(listGet, { path: "/api/import/gemini", cookie: me.cookie });
    expect(((await offRes.json()) as { learnEnabled?: boolean }).learnEnabled).toBe(false);
    db.delete(settings).where(eq(settings.key, "memory.enabled")).run();

    const detail = await callRoute(detailGet, { path: "/x", cookie: me.cookie }, { params: Promise.resolve({ id }) });
    const dbody = (await detail.json()) as { import: Record<string, unknown>; report: unknown };
    expect(dbody.import).toMatchObject({ importId: id });
    expect(dbody.report).toBeNull();

    // another user's batch is simply not there
    const foreign = await callRoute(detailGet, { path: "/x", cookie: other.cookie }, { params: Promise.resolve({ id }) });
    expect(foreign.status).toBe(404);
    const missing = await callRoute(detailGet, { path: "/x", cookie: me.cookie }, { params: Promise.resolve({ id: randomUUID() }) });
    expect(missing.status).toBe(404);
  });

  it("returns the persisted report for a finished import; garbage degrades to null", async () => {
    const u = await user();
    const content = conv("c1", "dup") + "\n" + conv("c2", "dup2") + "\n";
    const res = await upload(u, content);
    const { importId } = (await res.json()) as { importId: string };
    await runJob(userIdOf(u.username), importId);
    const detail = await callRoute(detailGet, { path: "/x", cookie: u.cookie }, { params: Promise.resolve({ id: importId }) });
    const dbody = (await detail.json()) as { report: { status: string; counts: { imported: number } } };
    expect(dbody.report.status).toBe("succeeded");
    expect(dbody.report.counts.imported).toBe(2);

    db.update(importBatches).set({ countsJson: "{garbage" }).where(eq(importBatches.id, importId)).run();
    const again = await callRoute(detailGet, { path: "/x", cookie: u.cookie }, { params: Promise.resolve({ id: importId }) });
    expect(((await again.json()) as { report: unknown }).report).toBeNull();

    // valid JSON but not an object → still no report
    db.update(importBatches).set({ countsJson: "42" }).where(eq(importBatches.id, importId)).run();
    const scalar = await callRoute(detailGet, { path: "/x", cookie: u.cookie }, { params: Promise.resolve({ id: importId }) });
    expect(((await scalar.json()) as { report: unknown }).report).toBeNull();
  });
});

describe("POST /api/import/gemini/[id] (cancel)", () => {
  it("validates body and batch state", async () => {
    const u = await user();
    const id = randomUUID();
    db.insert(importBatches)
      .values({ id, userId: userIdOf(u.username), filename: "x", bytes: 1, status: "queued" })
      .run();

    expect((await callRoute(detailPost, { method: "POST", path: "/x", cookie: u.cookie, body: "nope" }, { params: Promise.resolve({ id }) })).status).toBe(400);
    expect((await callRoute(detailPost, { method: "POST", path: "/x", cookie: u.cookie, json: { action: "retry" } }, { params: Promise.resolve({ id }) })).status).toBe(400);
    expect((await callRoute(detailPost, { method: "POST", path: "/x", cookie: u.cookie, json: { action: "cancel" } }, { params: Promise.resolve({ id: randomUUID() }) })).status).toBe(404);

    const first = await callRoute(detailPost, { method: "POST", path: "/x", cookie: u.cookie, json: { action: "cancel" } }, { params: Promise.resolve({ id }) });
    expect(first.status).toBe(200);
    expect(batch(id).status).toBe("cancelled");
    // chain guard: the queued chunk job now stops without importing
    const result = await runJob(userIdOf(u.username), id);
    expect(result).toEqual({ stop: "already-cancelled" });

    const second = await callRoute(detailPost, { method: "POST", path: "/x", cookie: u.cookie, json: { action: "cancel" } }, { params: Promise.resolve({ id }) });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "batch_finished", status: "cancelled" });
  });

  it("reclaims the spool on cancel", async () => {
    const u = await user();
    const id = randomUUID();
    writeFileSync(join(spoolDir, `${id}.ndjson`), "x\n");
    db.insert(importBatches)
      .values({ id, userId: userIdOf(u.username), filename: "x", bytes: 2, status: "running" })
      .run();
    const res = await callRoute(detailPost, { method: "POST", path: "/x", cookie: u.cookie, json: { action: "cancel" } }, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(existsSync(join(spoolDir, `${id}.ndjson`))).toBe(false);
  });

  it("cancels even when the spool dir itself is broken", async () => {
    const u = await user();
    const id = randomUUID();
    const blocker = join(spoolDir, "cancel-blocker");
    writeFileSync(blocker, "x");
    process.env.YASHA_IMPORT_DIR = blocker;
    try {
      db.insert(importBatches)
        .values({ id, userId: userIdOf(u.username), filename: "x", bytes: 1, status: "queued" })
        .run();
      const res = await callRoute(detailPost, { method: "POST", path: "/x", cookie: u.cookie, json: { action: "cancel" } }, { params: Promise.resolve({ id }) });
      expect(res.status).toBe(200);
      expect(batch(id).status).toBe("cancelled");
    } finally {
      process.env.YASHA_IMPORT_DIR = spoolDir;
      rmSync(blocker, { force: true });
    }
  });

  it("requires a session", async () => {
    const res = await callRoute(detailPost, { method: "POST", path: "/x", json: { action: "cancel" } }, { params: Promise.resolve({ id: randomUUID() }) });
    expect(res.status).toBe(401);
  });
});

describe("upload helpers", () => {
  it("safeFileName: default, traversal, slash, blank, oversized", () => {
    expect(safeFileName(null)).toBe("gemini_chats.ndjson");
    expect(safeFileName("..\\..\\evil\\gemini.ndjson")).toBe("gemini.ndjson");
    expect(safeFileName("a/b/c.ndjson")).toBe("c.ndjson");
    expect(safeFileName("   ")).toBe("gemini_chats.ndjson");
    expect(safeFileName("x".repeat(300))).toHaveLength(200);
  });

  it("scanHead: closed, newline-closes-and-validates, accumulates, cap", () => {
    expect(scanHead(null, "anything")).toEqual({ head: null, ok: true });
    expect(scanHead("", '{"id":"x"}\ntail')).toEqual({ head: null, ok: true });
    expect(scanHead("", "nope\nrest")).toEqual({ head: null, ok: false });
    expect(scanHead("", "partial")).toEqual({ head: "partial", ok: true });
    expect(scanHead("partial ", "more")).toEqual({ head: "partial more", ok: true });
    expect(scanHead("x".repeat(999_999), "y".repeat(10_000))).toMatchObject({ ok: false });
  });

  it("isFirstLineObject: objects only", () => {
    expect(isFirstLineObject('{"id":"a"}')).toBe(true);
    expect(isFirstLineObject("[]")).toBe(false);
    expect(isFirstLineObject("null")).toBe(false);
    expect(isFirstLineObject("oops")).toBe(false);
  });
});

async function uploadPostRaw(req: Request) {
  const { setCurrentHeaders } = await import("./support/request-context");
  setCurrentHeaders(req.headers);
  return uploadPost(req as never);
}
