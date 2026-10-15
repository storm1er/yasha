import { afterEach, describe, expect, it, vi } from "vitest";
import { getServerSession } from "@/lib/auth";
import { adminUser, makeRequest } from "./support/app";

describe("getServerSession", () => {
  it("resolves a real session through the server helper", async () => {
    const admin = await adminUser();
    const req = makeRequest({ path: "/api/auth/get-session", cookie: admin.cookie });
    const session = await getServerSession(req.headers);
    expect(session?.user.id).toBe(admin.userId);
  });

  it("returns null without a session cookie", async () => {
    const req = makeRequest({ path: "/api/auth/get-session" });
    expect(await getServerSession(req.headers)).toBeNull();
  });
});

describe("lib/auth env fallbacks (fresh module load without env)", () => {
  afterEach(() => {
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "";
    process.env.APP_NAME = "Yasha Tests";
    vi.resetModules();
  });

  it("applies defaults for appName/baseURL/trustedOrigins", async () => {
    vi.resetModules();
    delete process.env.APP_NAME;
    delete process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
    const { auth } = await import("@/lib/auth");
    const ctx = await (
      auth as unknown as {
        $context: Promise<{ options: { appName?: string; baseURL?: string; trustedOrigins?: string[] } }>;
      }
    ).$context;
    expect(ctx.options.appName).toBe("Yasha");
    expect(ctx.options.baseURL).toBe("http://localhost:3000");
    // no BETTER_AUTH_URL -> trustedOrigins() returns the (empty) configured list
    expect(ctx.options.trustedOrigins).toEqual([]);
  });
});

describe("ensureReady failure recovery", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/search/fts");
    vi.resetModules();
  });

  it("clears the memoized promise on failure and retries successfully", async () => {
    vi.resetModules();
    vi.doMock("@/lib/search/fts", () => {
      throw new Error("fts boom");
    });
    const dbMod = await import("@/lib/db");
    // vitest wraps factory errors; the underlying "fts boom" is in .cause
    await expect(dbMod.ensureReady()).rejects.toThrow(/fts boom|error when mocking/);
    // the failed promise must NOT be memoized: a retry completes startup
    vi.doUnmock("@/lib/search/fts");
    await dbMod.ensureReady();
    expect(dbMod.userCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("lib/db default database path", () => {
  const saved = process.env.DATABASE_PATH;

  afterEach(() => {
    process.env.DATABASE_PATH = saved;
    vi.resetModules();
  });

  it("falls back to /data/yasha.db when DATABASE_PATH is unset", async () => {
    // opens the (already WAL-modeled) on-Docker default file read-only; no
    // ensureReady()/migrations are run, and the handle is closed immediately.
    vi.resetModules();
    delete process.env.DATABASE_PATH;
    const dbMod = await import("@/lib/db");
    expect(dbMod.rawSqlite.name).toBe("/data/yasha.db");
    dbMod.rawSqlite.close();
  });
});
