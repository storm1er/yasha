import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as adminActions from "@/app/api/admin/actions/route";
import * as adminDlCtrl from "@/app/api/admin/downloads-control/route";
import * as adminDownloads from "@/app/api/admin/downloads/route";
import * as adminJobs from "@/app/api/admin/jobs/route";
import * as adminModels from "@/app/api/admin/models/route";
import * as adminOptions from "@/app/api/admin/models/[id]/options/route";
import * as adminRegistry from "@/app/api/admin/registry/route";
import * as adminServer from "@/app/api/admin/server/route";
import * as adminSettings from "@/app/api/admin/settings/route";
import * as adminVariants from "@/app/api/admin/variants/route";
import { ensureReady } from "@/lib/db";
import { jobs, threads } from "@/lib/db/schema";
import { adminUser, callRoute, jsonOf, sessionId, signUp, type AdminUser, type RouteHandler, type TestUser } from "./support/app";
import { db, setSetting } from "./support/db";
import { eq } from "drizzle-orm";
import { json, json as jsonResponse, mockLemonade } from "./support/lemonade";
import { setUserMemoryEnabled } from "@/lib/memory/prefs";

let admin: AdminUser;
let user: TestUser;
let userId: string;

function optsCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function withMutationFlag<T>(fn: () => Promise<T>): Promise<T> {
  process.env.ADMIN_ALLOW_BACKEND_MUTATIONS = "true";
  try {
    return await fn();
  } finally {
    delete process.env.ADMIN_ALLOW_BACKEND_MUTATIONS;
  }
}

beforeAll(async () => {
  await ensureReady();
  admin = await adminUser();
  const u = await signUp("adminguard");
  userId = await sessionId(u.cookie);
  user = Object.assign(u, { userId });
});

beforeEach(() => {
  db.delete(jobs).run();
});

afterEach(() => {
  delete process.env.ADMIN_ALLOW_BACKEND_MUTATIONS;
});

describe("admin guard (requireAdmin)", () => {
  const guards: [string, RouteHandler][] = [
    ["server", adminServer.GET],
    ["models", adminModels.GET],
    ["downloads", adminDownloads.GET],
    ["registry", adminRegistry.GET],
    ["variants", adminVariants.GET],
    ["settings", adminSettings.GET],
    ["jobs", adminJobs.GET],
  ];
  it("401 without session and 403 for non-admin on every guarded route", async () => {
    for (const [name, handler] of guards) {
      const anon = await callRoute(handler, { method: "GET", path: `/api/admin/${name}` });
      expect(anon.status, name).toBe(401);
      expect(await jsonOf(anon)).toEqual({ error: "unauthorized" });
    }
    const anonPost = await callRoute(adminActions.POST, { method: "POST", path: "/api/admin/actions", json: {} });
    expect(anonPost.status).toBe(401);
    const anonDl = await callRoute(adminDlCtrl.POST, { method: "POST", path: "/api/admin/downloads-control", json: {} });
    expect(anonDl.status).toBe(401);
    const anonOpts = await callRoute(adminOptions.GET, { path: "/api/admin/models/m/options" }, optsCtx("m"));
    expect(anonOpts.status).toBe(401);
    const anonOptsPost = await callRoute(adminOptions.POST, { method: "POST", path: "/o", json: {} }, optsCtx("m"));
    expect(anonOptsPost.status).toBe(401);
    const anonJobsPost = await callRoute(adminJobs.POST, { method: "POST", path: "/api/admin/jobs", json: {} });
    expect(anonJobsPost.status).toBe(401);
    const anonSettingsPost = await callRoute(adminSettings.POST, { method: "POST", path: "/api/admin/settings", json: {} });
    expect(anonSettingsPost.status).toBe(401);
  });

  it("403 forbidden for signed-in non-admins on every guarded route", async () => {
    for (const [name, handler] of guards) {
      const res = await callRoute(handler, { method: "GET", path: `/api/admin/${name}`, cookie: user.cookie });
      expect(res.status, name).toBe(403);
      expect(await jsonOf(res)).toEqual({ error: "forbidden" });
    }
    const p403 = await callRoute(adminActions.POST, { method: "POST", path: "/api/admin/actions", json: { action: "load", model: "m" }, cookie: user.cookie });
    expect(p403.status).toBe(403);
    const o403 = await callRoute(adminOptions.GET, { path: "/o", cookie: user.cookie }, optsCtx("m"));
    expect(o403.status).toBe(403);
  });
});

describe("admin GET passthrough routes", () => {
  it("server: all three upstreams ok", async () => {
    const mock = mockLemonade();
    mock.route("/v1/health", jsonResponse({ status: "ok" }));
    mock.route("/v1/system-info", jsonResponse({ platform: "linux" }));
    mock.route("/v1/system-stats", jsonResponse({ memory: {} }));
    const res = await callRoute(adminServer.GET, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      health: { status: "ok" },
      systemInfo: { platform: "linux" },
      systemStats: { memory: {} },
    });
  });

  it("server: partial failures null out, total failure → 502", async () => {
    let mock = mockLemonade();
    mock.route("/v1/health", jsonResponse({ status: "ok" }));
    mock.route("/v1/system-info", () => new Response("x", { status: 500 }));
    mock.route("/v1/system-stats", () => new Response("x", { status: 503 }));
    let res = await callRoute(adminServer.GET, { cookie: admin.cookie });
    expect(await jsonOf(res)).toEqual({ health: { status: "ok" }, systemInfo: null, systemStats: null });
    mock = mockLemonade();
    mock.route("/v1/health", () => new Response("x", { status: 500 }));
    mock.route("/v1/system-info", () => json({ platform: "linux" }));
    res = await callRoute(adminServer.GET, { cookie: admin.cookie });
    expect(await jsonOf(res)).toEqual({ health: null, systemInfo: { platform: "linux" }, systemStats: null });
    mock = mockLemonade();
    mock.fallback(() => new Response("x", { status: 500 }));
    res = await callRoute(adminServer.GET, { cookie: admin.cookie });
    expect(res.status).toBe(502);
    expect(await jsonOf(res)).toEqual({ error: "upstream_error" });
  });

  it("models: lenient coercion + mutations flag + upstream failure", async () => {
    let mock = mockLemonade();
    mock.route("/v1/models", () =>
      json({
        data: [
          { id: "m1", recipe: "llamacpp", size: 123, downloaded: true, labels: ["chat", 7, null], checkpoint: "repo/x", max_context_window: 8192 },
          { id: 5, recipe: 2, size: true, downloaded: "yes", labels: "no", checkpoint: 3, max_context_window: "big" },
          { size: "1GB" },
        ],
      })
    );
    let res = await callRoute(adminModels.GET, { cookie: admin.cookie });
    let body = await jsonOf<{ models: Record<string, unknown>[]; count: number; mutations_enabled: boolean }>(res);
    expect(body.count).toBe(3);
    expect(body.mutations_enabled).toBe(false);
    expect(body.models[0]).toEqual({
      id: "m1",
      recipe: "llamacpp",
      size: 123,
      downloaded: true,
      labels: ["chat"],
      checkpoint: "repo/x",
      max_context_window: 8192,
    });
    expect(body.models[1]).toEqual({ id: null, recipe: null, size: null, downloaded: false, labels: [], checkpoint: null, max_context_window: null });
    expect(body.models[2].size).toBe("1GB");

    mock = mockLemonade();
    mock.route("/v1/models", () => json({ no_data: true }));
    await withMutationFlag(async () => {
      res = await callRoute(adminModels.GET, { cookie: admin.cookie });
      body = await jsonOf<typeof body>(res);
      expect(body.models).toEqual([]);
      expect(body.mutations_enabled).toBe(true);
    });

    mock = mockLemonade();
    mock.route("/v1/models", () => new Response("x", { status: 500 }));
    res = await callRoute(adminModels.GET, { cookie: admin.cookie });
    expect(res.status).toBe(502);
  });

  it("registry: validation + passthrough + failure", async () => {
    let res = await callRoute(adminRegistry.GET, { cookie: admin.cookie });
    expect(res.status).toBe(400);
    res = await callRoute(adminRegistry.GET, { cookie: admin.cookie, query: { q: "x".repeat(201) } });
    expect(res.status).toBe(400);
    const mock = mockLemonade();
    mock.route("/v1/registry/search", () => json({ results: [{ name: "abc" }] }));
    res = await callRoute(adminRegistry.GET, { cookie: admin.cookie, query: { q: " abc " } });
    expect(await jsonOf(res)).toEqual({ results: [{ name: "abc" }] });
    expect(mock.lastCall()!.url).toContain("q=abc");
    const mock2 = mockLemonade();
    mock2.route("/v1/registry/search", () => new Response("x", { status: 500 }));
    res = await callRoute(adminRegistry.GET, { cookie: admin.cookie, query: { q: "abc" } });
    expect(res.status).toBe(502);
  });

  it("variants: validation + passthrough + failure", async () => {
    let res = await callRoute(adminVariants.GET, { cookie: admin.cookie });
    expect(res.status).toBe(400);
    res = await callRoute(adminVariants.GET, { cookie: admin.cookie, query: { name: "  " } });
    expect(res.status).toBe(400);
    res = await callRoute(adminVariants.GET, { cookie: admin.cookie, query: { name: "n".repeat(201) } });
    expect(res.status).toBe(400);
    const mock = mockLemonade();
    mock.route("/v1/pull/variants", () => json({ variants: [{ file: "f.gguf" }] }));
    res = await callRoute(adminVariants.GET, { cookie: admin.cookie, query: { name: " org / m " } });
    expect(await jsonOf(res)).toEqual({ variants: [{ file: "f.gguf" }] });
    expect(mock.lastCall()!.url).toContain("checkpoint=org");
    const mock2 = mockLemonade();
    mock2.fallback(() => new Response("x", { status: 500 }));
    res = await callRoute(adminVariants.GET, { cookie: admin.cookie, query: { name: "x" } });
    expect(res.status).toBe(502);
  });

  it("downloads: passthrough + failure", async () => {
    let mock = mockLemonade();
    mock.route("/v1/downloads", () => json({ downloads: [], activeCount: 0 }));
    let res = await callRoute(adminDownloads.GET, { cookie: admin.cookie });
    expect(await jsonOf(res)).toEqual({ downloads: [], activeCount: 0 });
    mock = mockLemonade();
    mock.fallback(() => new Response("x", { status: 500 }));
    res = await callRoute(adminDownloads.GET, { cookie: admin.cookie });
    expect(res.status).toBe(502);
  });

  it("models/{id}/options GET: validation, loaded/pinned enrichment, failure", async () => {
    let res = await callRoute(adminOptions.GET, { cookie: admin.cookie }, optsCtx(""));
    expect(res.status).toBe(400);
    res = await callRoute(adminOptions.GET, { cookie: admin.cookie }, optsCtx("x".repeat(201)));
    expect(res.status).toBe(400);

    let mock = mockLemonade();
    mock.route("/options", () => json({ model_name: "m1", effective: { ctx_size: 8 } }));
    mock.route("/v1/health", () => json({ all_models_loaded: [{ model_name: "m1", pinned: true }] }));
    res = await callRoute(adminOptions.GET, { cookie: admin.cookie }, optsCtx("m1"));
    expect(await jsonOf(res)).toEqual({ model_name: "m1", effective: { ctx_size: 8 }, loaded: true, pinned: true });

    mock = mockLemonade();
    mock.route("/options", () => json({ model_name: "m2" }));
    mock.route("/v1/health", () => json({ all_models_loaded: [{ model_name: "m2", pinned: false }] }));
    res = await callRoute(adminOptions.GET, { cookie: admin.cookie }, optsCtx("m2"));
    expect(await jsonOf(res)).toMatchObject({ loaded: true, pinned: false });

    mock = mockLemonade();
    mock.route("/options", () => json({ model_name: "m3" }));
    mock.route("/v1/health", () => json({ status: "ok" })); // no all_models_loaded → []
    res = await callRoute(adminOptions.GET, { cookie: admin.cookie }, optsCtx("m3"));
    expect(await jsonOf(res)).toMatchObject({ loaded: false, pinned: false });

    mock = mockLemonade();
    mock.fallback(() => new Response("x", { status: 500 }));
    res = await callRoute(adminOptions.GET, { cookie: admin.cookie }, optsCtx("m1"));
    expect(res.status).toBe(502);
  });
});

describe("admin settings route", () => {
  it("GET exposes typed defaults, stored values and effective event configs", async () => {
    setSetting("fast_model", "fast-x");
    setSetting("memory.enabled", "false");
    setSetting("memory.queue.concurrency", "abc"); // garbage int row → null
    setSetting("memory.events.dreaming", "not json"); // garbage event → effective defaults
    const res = await callRoute(adminSettings.GET, { cookie: admin.cookie });
    const { values } = await jsonOf<{ values: Record<string, unknown> }>(res);
    expect(values.fast_model).toBe("fast-x");
    expect(values.smart_model).toBeNull();
    expect(values["memory.enabled"]).toBe(false);
    expect(values["memory.queue.concurrency"]).toBeNull();
    expect(values["chat.windowMessages"]).toBe(20); // absent int → DEFAULTS
    const dreaming = values["memory.events.dreaming"] as Record<string, unknown>;
    expect(dreaming.schedule).toBe("cron");
    expect(dreaming.enabled).toBe(true);
  });

  it("POST clears a string key back to unset", async () => {
    await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { fast_model: "fast-clear-me" } });
    const res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { fast_model: "" } });
    expect(res.status).toBe(200);
    const { values } = await jsonOf<{ values: Record<string, unknown> }>(res);
    expect(values.fast_model).toBeNull();
  });

  it("POST rejects malformed payloads and unknown keys", async () => {
    let res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, body: "{oops", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    for (const body of [[1, 2], "str", null, {}]) {
      res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { nope: 1 } });
    expect(res.status).toBe(400);
  });

  it("POST validates string / bool / int keys", async () => {
    let res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { fast_model: 5 } });
    expect(res.status).toBe(400);
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { fast_model: "  " } });
    expect(res.status).toBe(400);
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { fast_model: "x".repeat(201) } });
    expect(res.status).toBe(400);
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { "memory.enabled": 1 } });
    expect(res.status).toBe(400);
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { "chat.windowMessages": 2.5 } });
    expect(res.status).toBe(400);
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { "chat.windowMessages": 201 } });
    expect(res.status).toBe(400);
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { "chat.windowMessages": "zero" } });
    expect(res.status).toBe(400);
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { "chat.windowMessages": true } });
    expect(res.status).toBe(400);
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { "chat.maxAudioBytes": 65535 } });
    expect(res.status).toBe(400); // below the 64 KiB floor
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { "chat.maxAudioBytes": 33554433 } });
    expect(res.status).toBe(400); // above the 32 MiB cap

    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { smart_model: " smart ", "memory.enabled": true, "memory.queue.concurrency": "4", "api.firstTokenTimeoutMs": 7, "mcp.userPrivateUrls": true } });
    expect(res.status).toBe(200);
    const { values } = await jsonOf<{ values: Record<string, unknown> }>(res);
    expect(values.smart_model).toBe("smart");
    expect(values["memory.enabled"]).toBe(true);
    expect(values["memory.queue.concurrency"]).toBe(4);
    expect(values["api.firstTokenTimeoutMs"]).toBe(7);
    expect(values["mcp.userPrivateUrls"]).toBe(true);
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { "memory.enabled": "false" } });
    expect((await jsonOf<{ values: Record<string, unknown> }>(res)).values["memory.enabled"]).toBe(false);

    // vision_model has been removed from the settings surface
    res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { vision_model: "vision-x" } });
    expect(res.status).toBe(400);
  });

  it("POST validates per-event job configs", async () => {
    const key = "chat.title_generation";
    for (const bad of [
      "string",
      [1],
      { unknown: 1 },
      { schedule: "whenever" },
      { schedule: "idle", idleMinutes: 0 },
      { schedule: "idle", idleMinutes: 1441 },
      { schedule: "idle", idleMinutes: 2.5 },
      { schedule: "cron", cronExpr: "   " },
      { schedule: "cron", cronExpr: "x".repeat(101) },
      { schedule: "cron", cronExpr: "garbage expr" },
      { schedule: "after_persist", model: " " },
      { schedule: "after_persist", model: "x".repeat(201) },
      { schedule: "idle", timeoutMs: 999 },
      { schedule: "idle", timeoutMs: 3_600_001 },
      { schedule: "idle", maxAttempts: 0 },
      { schedule: "idle", maxAttempts: 11 },
      { schedule: "idle", backoffMs: 500 },
      { schedule: "idle", enabled: "yes" },
    ]) {
      const res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { [key]: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    for (const bad of [{ enabled: true }, { schedule: "cron", cronExpr: "" }, { schedule: "idle", unknownField: 1 }]) {
      const res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { [key]: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const res = await callRoute(adminSettings.POST, { method: "POST", path: "/s", cookie: admin.cookie, json: { [key]: { schedule: "cron", cronExpr: " 0 4 * * * ", idleMinutes: 5, model: " fast-model ", timeoutMs: 2000, maxAttempts: 2, backoffMs: 1500, enabled: true } } });
    expect(res.status).toBe(200);
    const { values } = await jsonOf<{ values: Record<string, unknown> }>(res);
    expect(values[key]).toMatchObject({ schedule: "cron", cronExpr: "0 4 * * *", idleMinutes: 5, model: "fast-model", timeoutMs: 2000, maxAttempts: 2, backoffMs: 1500, enabled: true });
  });
});

describe("admin jobs route", () => {
  it("GET filters by status/type/q with label joins and limit clamps", async () => {
    const threadId = "th-admin-1";
    db.insert(jobs)
      .values({ id: "j1", dedupeKey: "d:j1", type: "debug.echo", userId: admin.userId, status: "pending", runAfter: new Date() })
      .run();
    db.insert(jobs)
      .values({ id: "j2", dedupeKey: "d:j2", type: "memory.dreaming", userId: admin.userId, status: "succeeded", runAfter: new Date(), startedAt: new Date(), finishedAt: new Date(), durationMs: 5 })
      .run();
    let res = await callRoute(adminJobs.GET, { cookie: admin.cookie });
    let body = await jsonOf<{ jobs: Record<string, unknown>[] }>(res);
    expect(body.jobs.map((j) => j.id)).toEqual(["j1"]);
    expect(body.jobs[0].scope).toEqual({ threadId: null, threadTitle: null, userId: admin.userId, userName: "troot_admin" });

    res = await callRoute(adminJobs.GET, { cookie: admin.cookie, query: { status: "succeeded" } });
    body = await jsonOf(res);
    expect(body.jobs[0].startedAt).not.toBeNull();

    res = await callRoute(adminJobs.GET, { cookie: admin.cookie, query: { status: "bogus" } });
    expect(res.status).toBe(400);
    res = await callRoute(adminJobs.GET, { cookie: admin.cookie, query: { type: "nope" } });
    expect(res.status).toBe(400);
    res = await callRoute(adminJobs.GET, { cookie: admin.cookie, query: { type: "debug.echo", q: admin.userId, limit: "0" } });
    body = await jsonOf(res);
    expect(body.jobs).toHaveLength(1);
    res = await callRoute(adminJobs.GET, { cookie: admin.cookie, query: { q: threadId, status: "pending" } });
    expect((await jsonOf<{ jobs: unknown[] }>(res)).jobs).toHaveLength(0);
    for (const limit of ["-5", "999", "abc", "42"]) {
      res = await callRoute(adminJobs.GET, { cookie: admin.cookie, query: { limit } });
      expect(res.status, limit).toBe(200);
    }
  });

  it("POST cancel / retry / retryAllFailed", async () => {
    db.insert(jobs).values({ id: "c1", dedupeKey: "d:c1", type: "debug.echo", userId: admin.userId, status: "pending", runAfter: new Date() }).run();
    db.insert(jobs).values({ id: "c2", dedupeKey: "d:c2", type: "debug.echo", userId: admin.userId, status: "succeeded", runAfter: new Date() }).run();
    db.insert(jobs).values({ id: "c3", dedupeKey: "d:c3", type: "debug.echo", userId: admin.userId, status: "failed", runAfter: new Date(), attempts: 3, lastError: "boom", finishedAt: new Date() }).run();
    db.insert(jobs).values({ id: "c4", dedupeKey: "d:c4", type: "debug.echo", userId: admin.userId, status: "failed", runAfter: new Date(), attempts: 1 }).run();

    let res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, body: "nope", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "cancel" } });
    expect(res.status).toBe(400);
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "cancel", jobId: "c2" } });
    expect(res.status).toBe(409);
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "cancel", jobId: "c1" } });
    expect(res.status).toBe(200);
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "retry" } });
    expect(res.status).toBe(400);
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "retry", jobId: "c1" } });
    expect(res.status).toBe(409);
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "retry", jobId: "c3" } });
    expect(res.status).toBe(200);
    const c3 = db.select().from(jobs).where(eq(jobs.id, "c3")).get();
    expect(c3!.status).toBe("pending");
    expect(c3!.attempts).toBe(0);
    expect(c3!.lastError).toBeNull();
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "retryAllFailed" } });
    expect(await jsonOf(res)).toEqual({ ok: true, retried: 1 }); // only c4 left failed
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "bogus" } });
    expect(res.status).toBe(400);
  });

  it("POST runNow: debug.echo, dreaming fan-out, title single/backfill", async () => {
    let res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "bogus" } });
    expect(res.status).toBe(400);
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "debug.echo", text: "t".repeat(600) } });
    expect(await jsonOf(res)).toEqual({ ok: true, enqueued: 1 });
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "debug.echo" } });
    expect((await jsonOf<{ enqueued: number }>(res)).enqueued).toBe(1);

    setSetting("memory.enabled", "false");
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "memory.dreaming" } });
    expect(await jsonOf(res)).toEqual({ ok: true, enqueued: 0, considered: 0, disabled: true });
    setSetting("memory.enabled", "true");
    // user opted out of memory → skipped; admin already has a RUNNING dream row → not re-counted
    setUserMemoryEnabled(userId, false);
    db.insert(jobs).values({ id: "drun", dedupeKey: `memory.dreaming:${admin.userId}`, type: "memory.dreaming", userId: admin.userId, status: "running", runAfter: new Date() }).run();
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "memory.dreaming" } });
    expect(await jsonOf(res)).toEqual({ ok: true, enqueued: 0, considered: 2 });
    setUserMemoryEnabled(userId, null);
    db.delete(jobs).run();
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "memory.dreaming" } });
    const dream = await jsonOf<{ enqueued: number; considered: number }>(res);
    expect(dream.enqueued).toBeGreaterThanOrEqual(1);
    expect(dream.considered).toBeGreaterThanOrEqual(2); // admin + the non-admin test user
    expect(db.select().from(jobs).all().length).toBe(dream.enqueued);

    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "chat.title_generation" } });
    expect(res.status).toBe(400);
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "chat.title_generation", threadId: "ghost" } });
    expect(res.status).toBe(404);

    const now = new Date();
    db.insert(threads).values({ id: "th-runnow", userId: admin.userId, model: "m", title: "", createdAt: now, updatedAt: now }).run();
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "chat.title_generation", threadId: " th-runnow " } });
    expect(await jsonOf(res)).toEqual({ ok: true, enqueued: 1, skippedRunning: false });
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "chat.title_generation", all: true } });
    expect(await jsonOf(res)).toEqual({ ok: true, enqueued: 1, considered: 1 });
    // same thread row now RUNNING → re-run reports skippedRunning + backfill enqueues nothing
    db.update(jobs).set({ status: "running" }).where(eq(jobs.type, "chat.title_generation")).run();
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "chat.title_generation", threadId: "th-runnow" } });
    expect(await jsonOf(res)).toEqual({ ok: true, enqueued: 0, skippedRunning: true });
    res = await callRoute(adminJobs.POST, { method: "POST", path: "/j", cookie: admin.cookie, json: { action: "runNow", type: "chat.title_generation", all: true } });
    expect(await jsonOf(res)).toEqual({ ok: true, enqueued: 0, considered: 1 });
    db.delete(jobs).run();
    db.delete(threads).run();
  });

  it("POST runNow backfill paginates past one 50-thread page (regression: silent 50 cap)", async () => {
    // An import of 51 chats must enqueue 51 jobs, not 50. The first run hits an
    // exact page multiple (empty next page → drain-and-stop); the second covers
    // the partial final page + the (updatedAt,id) keyset cursor.
    const base = new Date(Date.UTC(2025, 5, 1)).getTime();
    db.insert(threads)
      .values(
        Array.from({ length: 50 }, (_, i) => ({
          id: `pg-${String(i).padStart(2, "0")}`,
          userId: admin.userId,
          model: "m",
          title: "",
          createdAt: new Date(base + i),
          updatedAt: new Date(base + i),
        }))
      )
      .run();
    let res = await callRoute(adminJobs.POST, {
      method: "POST",
      path: "/j",
      cookie: admin.cookie,
      json: { action: "runNow", type: "memory.fact_extraction", all: true },
    });
    expect(await jsonOf(res)).toEqual({ ok: true, enqueued: 50, considered: 50 });

    db.insert(threads)
      .values({ id: "pg-50", userId: admin.userId, model: "m", title: "", createdAt: new Date(base + 50), updatedAt: new Date(base + 50) })
      .run();
    res = await callRoute(adminJobs.POST, {
      method: "POST",
      path: "/j",
      cookie: admin.cookie,
      json: { action: "runNow", type: "memory.fact_extraction", all: true },
    });
    expect(await jsonOf(res)).toEqual({ ok: true, enqueued: 51, considered: 51 });
    const factJobs = db.select().from(jobs).where(eq(jobs.type, "memory.fact_extraction")).all();
    expect(new Set(factJobs.map((j) => j.threadId)).size).toBe(51);
    db.delete(jobs).run();
    db.delete(threads).run();
  });
});

describe("admin actions route (mutations)", () => {
  const post = (json: unknown, adminCookie = true) =>
    callRoute(adminActions.POST, { method: "POST", path: "/a", json, cookie: adminCookie ? admin.cookie : null });

  it("rejects malformed requests", async () => {
    let res = await post({ action: 5 });
    expect(res.status).toBe(400);
    res = await post({ action: "fly", model: "m" });
    expect(res.status).toBe(400);
    res = await post({ action: "load", model: "  " });
    expect(res.status).toBe(400);
    res = await post({ action: "load", model: "x".repeat(201) });
    expect(res.status).toBe(400);
    res = await post({ action: "pull", model: "bad name!" });
    expect(res.status).toBe(400);
    res = await post({ action: "load", model: "ok" , checkpoint: "cp" });
    expect((await jsonOf<{ detail?: string }>(res)).detail).toBe("recipe_required_for_checkpoint");
    res = await post({ action: "pull", model: "m", checkpoint: "c".repeat(301), recipe: "r" });
    expect((await jsonOf<{ detail?: string }>(res)).detail).toBe("checkpoint_too_long");
    res = await post({ action: "pull", model: "m", recipe: "r".repeat(61) });
    expect((await jsonOf<{ detail?: string }>(res)).detail).toBe("recipe_too_long");
    res = await post({ action: "pull", model: "m", source: "s".repeat(31) });
    expect((await jsonOf<{ detail?: string }>(res)).detail).toBe("source_too_long");
    res = await post({ action: "pull", model: "m", source: "kaggle" });
    expect((await jsonOf<{ detail?: string }>(res)).detail).toBe("invalid_source");
    res = await post({ action: "pull", model: "m", mmproj: "m".repeat(201) });
    expect((await jsonOf<{ detail?: string }>(res)).detail).toBe("mmproj_too_long");
  });

  it("503 mutations_disabled while the flag is off", async () => {
    for (const action of ["load", "unload", "delete", "pull"]) {
      const res = await post({ action, model: "m" });
      expect(res.status, action).toBe(503);
      expect(await jsonOf(res)).toEqual({ error: "mutations_disabled" });
    }
  });

  it("flag on: pull passthrough + error mapping", async () => {
    await withMutationFlag(async () => {
      let mock = mockLemonade();
      mock.route("/v1/pull", () => json({ status: "ok", id: "job1" }));
      let res = await post({ action: "pull", model: " MyModel-1.7B ", recipe: "llamacpp", checkpoint: "repo:Q4", source: "huggingface", mmproj: "mm.gguf", vision: true, embedding: false, reranking: false });
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toEqual({ ok: true, action: "pull", result: { status: "ok", id: "job1" } });
      const sent = mock.lastCall()!;
      const body = JSON.parse(sent.body!) as Record<string, unknown>;
      expect(body).toEqual({ model_name: "MyModel-1.7B", stream: true, subscribe: false, do_not_upgrade: true, recipe: "llamacpp", checkpoint: "repo:Q4", source: "huggingface", mmproj: "mm.gguf", vision: true, embedding: false, reranking: false });

      mock = mockLemonade();
      mock.route("/v1/pull", () => json({ status: "error", message: "no such model" }));
      res = await post({ action: "pull", model: "m" });
      expect(res.status).toBe(502);
      expect(await jsonOf(res)).toEqual({ error: "upstream_error", detail: "no such model" });

      mock = mockLemonade();
      mock.route("/v1/pull", () => json({ status: "error" }));
      res = await post({ action: "pull", model: "m" });
      expect((await jsonOf<{ detail: string }>(res)).detail).toBe("pull_failed");

      mock = mockLemonade();
      mock.route("/v1/pull", () => json({ status: "error", message: 42 }));
      res = await post({ action: "pull", model: "m" });
      expect((await jsonOf<{ detail: string }>(res)).detail).toBe("pull_failed");

      mock = mockLemonade();
      mock.route("/v1/pull", () => new Response("boom", { status: 500 }));
      res = await post({ action: "pull", model: "m" });
      expect(res.status).toBe(502);
      expect((await jsonOf<{ detail: string }>(res)).detail).toBe("upstream_status_500");

      mock = mockLemonade();
      mock.route("/v1/pull", () => { throw "kaboom"; });
      res = await post({ action: "pull", model: "m" });
      expect(res.status).toBe(502);
      expect((await jsonOf<{ detail: string }>(res)).detail).toBe("upstream_error");
    });
  });

  it("flag on: load with per-load options + unload/delete passthrough", async () => {
    await withMutationFlag(async () => {
      let mock = mockLemonade();
      mock.route("/v1/load", () => json({ status: "loaded" }));
      let res = await post({ action: "load", model: "m", ctx_size: 4096, llamacpp_backend: "cuda", llamacpp_args: "-ngl 99", merge_args: true, pinned: false });
      expect(res.status).toBe(200);
      expect(JSON.parse(mock.lastCall()!.body!)).toEqual({ model_name: "m", ctx_size: 4096, llamacpp_backend: "cuda", llamacpp_args: "-ngl 99", merge_args: true, pinned: false });

      res = await post({ action: "load", model: "m", ctx_size: 0, llamacpp_backend: "b".repeat(61), llamacpp_args: "a".repeat(2001), merge_args: "yes", pinned: 1 });
      expect(res.status).toBe(200);
      expect(JSON.parse(mock.lastCall()!.body!)).toEqual({ model_name: "m" });

      res = await post({ action: "load", model: "m", ctx_size: 8_388_609 });
      expect(JSON.parse(mock.lastCall()!.body!)).toEqual({ model_name: "m" });

      mock = mockLemonade();
      mock.route("/v1/unload", () => json({ status: "unloaded" }));
      mock.route("/v1/delete", () => json({ status: "deleted" }));
      res = await post({ action: "unload", model: "m" });
      expect(res.status).toBe(200);
      res = await post({ action: "delete", model: " m " });
      expect((await jsonOf<{ result: Record<string, unknown> }>(res)).result).toEqual({ status: "deleted" });
      expect(JSON.parse(mock.lastCall()!.body!)).toEqual({ model_name: "m" });
    });
  });

  it("invalid_json body → 400", async () => {
    const res = await callRoute(adminActions.POST, { method: "POST", path: "/a", cookie: admin.cookie, body: "{oops", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });
});

describe("admin downloads-control route", () => {
  const post = (json: unknown) =>
    callRoute(adminDlCtrl.POST, { method: "POST", path: "/d", json, cookie: admin.cookie });

  it("validates id/action and honours the mutation flag", async () => {
    let res = await callRoute(adminDlCtrl.POST, { method: "POST", path: "/d", cookie: admin.cookie, body: "{oops", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    res = await post({ id: "  ", action: "pause" });
    expect(res.status).toBe(400);
    res = await post({ id: "i".repeat(301), action: "pause" });
    expect(res.status).toBe(400);
    res = await post({ id: "d1", action: "stop" });
    expect(res.status).toBe(400);
    expect((await jsonOf<{ allowed: string[] }>(res)).allowed).toEqual(["pause", "cancel", "remove"]);
    res = await post({ id: "d1", action: "pause" });
    expect(res.status).toBe(503);

    await withMutationFlag(async () => {
      let mock = mockLemonade();
      mock.route("/v1/downloads/control", () => json({ status: "ok" }));
      res = await post({ id: " d1 ", action: "cancel" });
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toEqual({ ok: true, action: "cancel", result: { status: "ok" } });
      expect(JSON.parse(mock.lastCall()!.body!)).toEqual({ id: "d1", action: "cancel" });

      mock = mockLemonade();
      mock.route("/v1/downloads/control", () => new Response("gone", { status: 404 }));
      res = await post({ id: "d1", action: "remove" });
      expect(res.status).toBe(502);
      expect((await jsonOf<{ detail: string }>(res)).detail).toBe("upstream_status_404");

      mock = mockLemonade();
      mock.route("/v1/downloads/control", () => { throw 42; });
      res = await post({ id: "d1", action: "pause" });
      expect((await jsonOf<{ detail: string }>(res)).detail).toBe("upstream_error");
    });
  });
});

describe("admin model options POST", () => {
  const post = (json: unknown, id = "m1") =>
    callRoute(adminOptions.POST, { method: "POST", path: "/o", json, cookie: admin.cookie }, optsCtx(id));

  it("validates body, options, pin", async () => {
    let res = await callRoute(adminOptions.POST, { method: "POST", path: "/o", cookie: admin.cookie, body: "{oops", headers: { "content-type": "application/json" } }, optsCtx("m1"));
    expect(res.status).toBe(400);
    res = await post({}, "");
    expect(res.status).toBe(400);
    res = await post({}, "x".repeat(201));
    expect(res.status).toBe(400);
    res = await post({ options: [1] });
    expect(res.status).toBe(400);
    res = await post({ options: "str" });
    expect((await jsonOf<{ detail?: string }>(res)).detail).toBe("invalid_options");
    res = await post({ options: { nope: 1 } });
    expect((await jsonOf<{ detail?: string }>(res)).detail).toBe("unknown_option_nope");
    for (const bad of [
      { ctx_size: 0 },
      { ctx_size: 1.5 },
      { ctx_size: 8_388_609 },
      { ctx_size: "8192" },
      { llamacpp_backend: "b".repeat(61) },
      { llamacpp_args: "a".repeat(2001) },
      { merge_args: "true" },
    ]) {
      res = await post({ options: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await jsonOf<{ detail?: string }>(res)).detail).toContain("invalid_option_");
    }
    res = await post({ pin: "yes" });
    expect(res.status).toBe(400);
    res = await post({ options: {} });
    expect((await jsonOf<{ detail?: string }>(res)).detail).toBe("empty_patch");
    res = await post({ options: { ctx_size: null } });
    expect(res.status).toBe(503); // a null value clears the key → a real patch
  });

  it("flag off → 503 even with a valid patch", async () => {
    const res = await post({ options: { ctx_size: 4096 } });
    expect(res.status).toBe(503);
  });

  it("flag on: saves options, pins loaded models only, maps failures", async () => {
    await withMutationFlag(async () => {
      let mock = mockLemonade();
      mock.route("/options", () => json({ saved: { ctx_size: 4096 } }));
      mock.route("/internal/pin", () => json({ ok: true }));
      mock.route("/v1/health", () => json({ all_models_loaded: [{ model_name: "m1", pinned: false }] }));
      let res = await post({ options: { ctx_size: 4096, llamacpp_backend: null } });
      expect(res.status).toBe(200); // options-only patch, no pin key
      res = await post({ options: { ctx_size: 4096, llamacpp_backend: null }, pin: true });
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toEqual({ ok: true, options: { saved: { ctx_size: 4096 } }, pinnedApplied: true });
      expect(mock.calls.some((c) => c.url.includes("/internal/pin"))).toBe(true);

      // pin on an unloaded model → skipped silently
      mock = mockLemonade();
      mock.route("/v1/health", () => json({ all_models_loaded: [] }));
      res = await post({ pin: false });
      expect(await jsonOf(res)).toEqual({ ok: true, options: null, pinnedApplied: false });
      expect(mock.calls.some((c) => c.url.includes("/internal/pin"))).toBe(false);

      // upstream failure while saving options
      mock = mockLemonade();
      mock.route("/options", () => new Response("x", { status: 500 }));
      res = await post({ options: { merge_args: true } });
      expect(res.status).toBe(502);
      expect((await jsonOf<{ detail: string }>(res)).detail).toBe("upstream_status_500");

      // non-Error throw
      mock = mockLemonade();
      mock.route("/options", () => { throw { weird: true }; });
      res = await post({ options: { merge_args: false } });
      expect((await jsonOf<{ detail: string }>(res)).detail).toBe("upstream_error");
    });
  });
});

describe("lib/provider/lemonade adapter", () => {
  const KEYED_URL = "http://lemonade.invalid.test";
  const keyed = () => import("@/lib/provider/lemonade").then((m) => new m.LemonadeProvider("p1", KEYED_URL, "secret-key"));
  const keyless = () => import("@/lib/provider/lemonade").then((m) => new m.LemonadeProvider("p0", KEYED_URL, null));

  it("getJson: success carries Authorization header when the provider row has a key", async () => {
    const lib = await keyed();
    const mock = mockLemonade();
    mock.route("/v1/health", () => json({ status: "ok" }));
    await expect(lib.health()).resolves.toEqual({ status: "ok" });
    expect(mock.lastCall()!.headers.authorization).toBe("Bearer secret-key");
    mock.route("/v1/stats", () => json({ total_requests: 1 }));
    await expect(lib.stats()).resolves.toEqual({ total_requests: 1 });

    const plain = await keyless();
    mock.route("/v1/system-info", () => json({ cpus: 2 }));
    await plain.systemInfo();
    expect(mock.lastCall()!.headers.authorization).toBeUndefined();
  });

  it("getJson: non-2xx throws upstream_status_*", async () => {
    const lib = await keyed();
    const mock = mockLemonade();
    mock.fallback(() => new Response("x", { status: 404 }));
    await expect(lib.systemInfo()).rejects.toThrow("upstream_status_404");
    await expect(lib.systemStats()).rejects.toThrow("upstream_status_404");
    await expect(lib.models()).rejects.toThrow("upstream_status_404");
    await expect(lib.downloads()).rejects.toThrow("upstream_status_404");
    await expect(lib.registrySearch("a b/c")).rejects.toThrow("upstream_status_404");
    expect(mock.lastCall()!.url).toContain("q=a%20b%2Fc");
    await expect(lib.pullVariants("a&b")).rejects.toThrow("upstream_status_404");
    expect(mock.lastCall()!.url).toContain("checkpoint=a%26b");
    await expect(lib.modelOptions("m/1")).rejects.toThrow("upstream_status_404");
    expect(mock.lastCall()!.url).toContain("/v1/models/m%2F1/options");
  });

  it("loadedModels: array passthrough vs non-array → []", async () => {
    const lib = await keyed();
    let mock = mockLemonade();
    mock.route("/v1/health", () => json({ all_models_loaded: [{ model_name: "m" }] }));
    await expect(lib.loadedModels()).resolves.toEqual([{ model_name: "m" }]);
    mock = mockLemonade();
    mock.route("/v1/health", () => json({ all_models_loaded: "nope" }));
    await expect(lib.loadedModels()).resolves.toEqual([]);
  });

  it("mutating helpers refuse without the flag", async () => {
    const lib = await keyed();
    const m = await import("@/lib/provider/lemonade");
    expect(m.backendMutationsEnabled()).toBe(false);
    await expect(lib.pull("m")).rejects.toThrow("mutations_disabled:pull");
    await expect(lib.load("m")).rejects.toThrow("mutations_disabled:load");
    await expect(lib.unload("m")).rejects.toThrow("mutations_disabled:unload");
    await expect(lib.del("m")).rejects.toThrow("mutations_disabled:delete");
    await expect(lib.setModelOptions("m", {})).rejects.toThrow("mutations_disabled:set_model_options");
    await expect(lib.pin("m", true)).rejects.toThrow("mutations_disabled:pin_model");
    await expect(lib.downloadsControl("d", "pause")).rejects.toThrow("mutations_disabled:downloads_control_pause");
  });

  it("postJson body handling with the flag on", async () => {
    const lib = await keyed();
    await withMutationFlag(async () => {
      let mock = mockLemonade();
      mock.route("/v1/load", () => new Response("plain text ack", { status: 200, headers: { "content-type": "text/plain" } }));
      await expect(lib.load("m", { ctx_size: 1, pinned: true })).resolves.toEqual({ raw: "plain text ack" });
      expect(JSON.parse(mock.lastCall()!.body!)).toEqual({ model_name: "m", ctx_size: 1, pinned: true });

      mock = mockLemonade();
      mock.route("/v1/unload", () => new Response("", { status: 200 }));
      await expect(lib.unload("m")).resolves.toBeNull();

      mock = mockLemonade();
      mock.route("/v1/delete", () => new Response("nope", { status: 500 }));
      await expect(lib.del("m")).rejects.toThrow("upstream_status_500");

      mock = mockLemonade();
      mock.route("/v1/pull", () => json({ status: "ok" }));
      await lib.pull("m", { recipe: "r", checkpoint: undefined, vision: false });
      const body = JSON.parse(mock.lastCall()!.body!) as Record<string, unknown>;
      expect(body).toEqual({ model_name: "m", stream: true, subscribe: false, do_not_upgrade: true, recipe: "r", vision: false });

      mock = mockLemonade();
      mock.route("/options", () => json({ saved: 1 }));
      await expect(lib.setModelOptions("m/1", { ctx_size: 4 })).resolves.toEqual({ saved: 1 });
      expect(mock.lastCall()!.url).toContain("/v1/models/m%2F1/options");

      mock = mockLemonade();
      mock.route("/internal/pin", () => json({ ok: 1 }));
      await expect(lib.pin("m", false)).resolves.toEqual({ ok: 1 });

      mock = mockLemonade();
      mock.route("/v1/downloads/control", () => json({ status: "ok" }));
      await expect(lib.downloadsControl("d", "remove")).resolves.toEqual({ status: "ok" });
    });
  });
});
