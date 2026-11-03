// /api/app-download status routes + /d/[token] one-time APK download.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apkBuilds, apkReleaseTokens, apkReleases, session } from "@/lib/db/schema";
import { callRoute, jsonOf, sessionId, signUp } from "./support/app";

const afterCtl = vi.hoisted(() => ({ fns: [] as (() => void)[] }));

vi.mock("next/server", async (importOriginal) => {
  const mod = await (importOriginal as () => Promise<Record<string, unknown>>)();
  return { ...mod, after: (fn: () => void) => afterCtl.fns.push(fn) };
});

import { GET as statusGet, POST as statusPost } from "@/app/api/app-download/route";
import { GET as downloadGet } from "@/app/d/[token]/route";

let buildDir = "";

beforeEach(() => {
  buildDir = mkdtempSync(join(tmpdir(), "yasha-dl-"));
  process.env.YASHA_APK_BUILD_DIR = buildDir;
  process.env.YASHA_APK_SOURCE_DIR = join(buildDir, "no-such-source");
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "http://localhost:3000";
  afterCtl.fns.length = 0;
});

afterEach(() => {
  rmSync(buildDir, { recursive: true, force: true });
  delete process.env.YASHA_APK_BUILD_DIR;
  delete process.env.YASHA_APK_SOURCE_DIR;
});

async function settle() {
  const m = await import("@/lib/apk-builder");
  await m.buildsSettled();
}

function makeReady(userId: string, apkContent: string | null) {
  const now = new Date();
  db.delete(apkBuilds).where(eq(apkBuilds.userId, userId)).run();
  const token = `tok-${crypto.randomUUID()}`;
  const sessionId = crypto.randomUUID();
  db.insert(session)
    .values({ id: sessionId, token: `sess-${token}`, userId, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now, updatedAt: now })
    .run();
  let apkPath: string | null = null;
  if (apkContent !== null) {
    apkPath = join(buildDir, `${token}.apk`);
    writeFileSync(apkPath, apkContent);
  }
  db.insert(apkBuilds)
    .values({
      id: crypto.randomUUID(),
      userId,
      token,
      serverUrl: "http://localhost:3000",
      sessionId,
      status: "ready",
      apkPath,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    })
    .run();
  return { token, apkPath };
}

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

describe("baked server URL", () => {
  const savedOrigins = process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  afterEach(() => {
    if (savedOrigins === undefined) delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
    else process.env.BETTER_AUTH_TRUSTED_ORIGINS = savedOrigins;
  });

  it("uses the first BETTER_AUTH_TRUSTED_ORIGINS entry", async () => {
    const u = await signUp("dlurl1");
    const uid = await sessionId(u.cookie);
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = " https://dev-yasha.example/ ,https://other.example";
    await callRoute(statusPost, { cookie: u.cookie });
    const row = db.select().from(apkBuilds).where(eq(apkBuilds.userId, uid)).get()!;
    expect(row.serverUrl).toBe("https://dev-yasha.example");
  });

  it("refuses builds with an explicit error when unset (no Host fallback)", async () => {
    const u = await signUp("dlurl2");
    delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
    const post = await callRoute(statusPost, { cookie: u.cookie });
    expect(post.status).toBe(409);
    const body = await jsonOf<{ error: string; state: string }>(post);
    expect(body.error).toBe("trusted_origins_unset");
    expect(body.state).toBe("failed");
    expect((await callRoute(statusGet, { cookie: u.cookie })).status).toBe(409);
    const uid = await sessionId(u.cookie);
    expect(db.select().from(apkBuilds).where(eq(apkBuilds.userId, uid)).all()).toHaveLength(0);
  });
});

describe("/api/app-download", () => {
  it("requires a session", async () => {
    expect((await callRoute(statusGet)).status).toBe(401);
    expect((await callRoute(statusPost)).status).toBe(401);
  });

  it("first GET is idle (no build until POST), then reports its state", async () => {
    const u = await signUp("dl1");
    const uid = await sessionId(u.cookie);
    const first = await jsonOf<{ state: string }>(await callRoute(statusGet, { cookie: u.cookie }));
    expect(first.state).toBe("idle");
    // Viewing never queues a build.
    expect(db.select().from(apkBuilds).where(eq(apkBuilds.userId, uid)).all()).toHaveLength(0);
    await callRoute(statusPost, { cookie: u.cookie });
    const second = await jsonOf<{ state: string }>(await callRoute(statusGet, { cookie: u.cookie }));
    expect(["queued", "building", "failed"]).toContain(second.state);
    // Background build fails (no toolchain) → failed view with error.
    await settle();
    const failed = await jsonOf<{ state: string; error?: string }>(
      await callRoute(statusGet, { cookie: u.cookie })
    );
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("toolchain_unavailable");
  });

  it("POST rebuilds (new token), ready build exposes one-time URL", async () => {
    const u = await signUp("dl2");
    const uid = await sessionId(u.cookie);
    const rows = () => db.select().from(apkBuilds).where(eq(apkBuilds.userId, uid)).all();
    await callRoute(statusPost, { cookie: u.cookie });
    expect(rows().length).toBe(1);
    await settle();
    const before = rows()[0]!;
    await callRoute(statusPost, { cookie: u.cookie });
    await settle();
    const after = rows()[0]!;
    expect(after.token).not.toBe(before.token);

    // Ready state surfaces the URL + expiry.
    const ready = makeReady(after.userId, "APKDATA");
    const view = await jsonOf<{ state: string; downloadUrl?: string; expiresAt?: string }>(
      await callRoute(statusGet, { cookie: u.cookie })
    );
    expect(view.state).toBe("ready");
    expect(view.downloadUrl).toBe(`/d/${ready.token}`);
    expect(typeof view.expiresAt).toBe("string");
  });
});

describe("/d/[token]", () => {
  it("happy path: serves the APK once, deletes after send, second visit 410", async () => {
    const u = await signUp("dl4");
    const uid = await sessionId(u.cookie);
    const { token, apkPath } = makeReady(uid, "APKBYTES");
    const res = await callRoute(downloadGet, { path: `/d/${token}` }, ctx(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-length")).toBe(String("APKBYTES".length));
    expect(await res.text()).toBe("APKBYTES");
    expect(afterCtl.fns.length).toBe(1);
    afterCtl.fns[0]!();
    expect(existsSync(apkPath!)).toBe(false);
    const again = await callRoute(downloadGet, { path: `/d/${token}` }, ctx(token));
    expect(again.status).toBe(410);
    expect(await again.text()).toContain("no longer valid");
  });

  it("unknown token and missing file both 410", async () => {
    const u = await signUp("dl5");
    const uid = await (await import("./support/app")).sessionId(u.cookie);
    const missing = await callRoute(downloadGet, { path: "/d/x" }, ctx("x"));
    expect(missing.status).toBe(410);
    const { token } = makeReady(uid, null);
    const gone = await callRoute(downloadGet, { path: `/d/${token}` }, ctx(token));
    expect(gone.status).toBe(410);
    const row = db.select().from(apkBuilds).where(eq(apkBuilds.token, token)).get()!;
    expect(row.status).toBe("failed");
  });

  it("release link (issue #34 Phase C): shared APK served without deletion, single-use", async () => {
    const uid = await sessionId((await signUp("dl6")).cookie);
    const now = new Date();
    const apkPath = join(buildDir, "release-21.apk");
    writeFileSync(apkPath, "RELEASEBYTES");
    const rel = db
      .insert(apkReleases)
      .values({
        id: crypto.randomUUID(),
        versionCode: 21,
        versionName: "0.21.0",
        status: "ready",
        apkPath,
        sha256: "x",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const token = `rel-${crypto.randomUUID()}`;
    db.insert(apkReleaseTokens)
      .values({ id: crypto.randomUUID(), releaseId: rel.id, userId: uid, token, createdAt: now })
      .run();

    const res = await callRoute(downloadGet, { path: `/d/${token}` }, ctx(token));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("RELEASEBYTES");
    // Shared artifact: nothing is scheduled for deletion, the file survives.
    expect(afterCtl.fns).toHaveLength(0);
    expect(existsSync(apkPath)).toBe(true);
    const again = await callRoute(downloadGet, { path: `/d/${token}` }, ctx(token));
    expect(again.status).toBe(410);
  });
});
