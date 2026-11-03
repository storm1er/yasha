// /api/app-update — in-app update trigger (issue #34, Phase B). The source
// dir carries a VERSION stamp but NO settings.gradle.kts, so queued builds
// settle fast on toolchain_unavailable (no gradle mock needed).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apkBuilds, session } from "@/lib/db/schema";
import { callRoute, jsonOf, sessionId, signUp } from "./support/app";

import { GET, POST } from "@/app/api/app-update/route";

let buildDir = "";
let srcDir = "";

beforeEach(() => {
  buildDir = mkdtempSync(join(tmpdir(), "yasha-upd-"));
  srcDir = mkdtempSync(join(tmpdir(), "yasha-upd-src-"));
  writeFileSync(join(srcDir, "VERSION"), "3\t0.3.0");
  process.env.YASHA_APK_BUILD_DIR = buildDir;
  process.env.YASHA_APK_SOURCE_DIR = srcDir;
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "http://localhost:3000";
});

afterEach(() => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
  delete process.env.YASHA_APK_BUILD_DIR;
  delete process.env.YASHA_APK_SOURCE_DIR;
  delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
});

async function settle() {
  const m = await import("@/lib/apk-builder");
  await m.buildsSettled();
}

const rowsOf = (userId: string) => db.select().from(apkBuilds).where(eq(apkBuilds.userId, userId)).all();
const sessionRowsOf = (userId: string) => db.select().from(session).where(eq(session.userId, userId)).all();

function makeRow(
  userId: string,
  over: { status: "building" | "ready" | "failed"; sha256?: string | null; content?: string | null; error?: string } = {
    status: "ready",
  },
) {
  const now = new Date();
  db.delete(apkBuilds).where(eq(apkBuilds.userId, userId)).run();
  const token = `upd-${crypto.randomUUID()}`;
  let apkPath: string | null = null;
  if (over.content) {
    apkPath = join(buildDir, `${token}.apk`);
    writeFileSync(apkPath, over.content);
  }
  db.insert(apkBuilds)
    .values({
      id: crypto.randomUUID(),
      userId,
      token,
      serverUrl: "http://localhost:3000",
      sessionId: crypto.randomUUID(),
      sessionBorrowed: true,
      status: over.status,
      apkPath,
      sha256: over.sha256 ?? null,
      error: over.error ?? null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    })
    .run();
  return { token, apkPath };
}

describe("POST /api/app-update", () => {
  it("requires a session", async () => {
    expect((await callRoute(GET)).status).toBe(401);
    expect((await callRoute(POST)).status).toBe(401);
  });

  it("bakes the CALLER's session — no minted row, borrowed marker set", async () => {
    const u = await signUp("upd1");
    const uid = await sessionId(u.cookie);
    const before = sessionRowsOf(uid);
    expect(before).toHaveLength(1); // the caller's own login session
    const body = await jsonOf<{ state: string }>(await callRoute(POST, { cookie: u.cookie }));
    expect(body.state).toBe("queued");
    await settle();
    const row = rowsOf(uid)[0]!;
    expect(row.sessionBorrowed).toBe(true);
    expect(row.sessionId).toBe(before[0]!.id);
    // No session was minted, and the toolchain-less build did not revoke it.
    expect(sessionRowsOf(uid)).toHaveLength(1);
    expect(row.error).toBe("toolchain_unavailable");
  });

  it("an in-flight build is returned as-is (no re-queue, token kept)", async () => {
    const u = await signUp("upd2");
    const uid = await sessionId(u.cookie);
    const { token } = makeRow(uid, { status: "building" });
    const body = await jsonOf<{ state: string; downloadUrl?: string }>(
      await callRoute(POST, { cookie: u.cookie }),
    );
    expect(body.state).toBe("building");
    expect(body.downloadUrl).toBeUndefined();
    expect(rowsOf(uid)[0]!.token).toBe(token);
  });

  it("trusted origins unset → 409, no build row", async () => {
    const u = await signUp("upd3");
    const uid = await sessionId(u.cookie);
    delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
    const res = await callRoute(POST, { cookie: u.cookie });
    expect(res.status).toBe(409);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("trusted_origins_unset");
    expect(rowsOf(uid)).toHaveLength(0);
  });
});

describe("GET /api/app-update", () => {
  it("idle GET exposes the build stamp and queues nothing", async () => {
    const u = await signUp("upd4");
    const uid = await sessionId(u.cookie);
    const body = await jsonOf<{ state: string; versionCode: number; versionName: string }>(
      await callRoute(GET, { cookie: u.cookie }),
    );
    expect(body).toEqual({ state: "idle", versionCode: 3, versionName: "0.3.0" });
    expect(rowsOf(uid)).toHaveLength(0);
  });

  it("unreadable stamp source → version fields omitted", async () => {
    // No YASHA_APK_SOURCE_DIR → falls back to /opt/yasha-android, which does
    // not exist in the test image.
    delete process.env.YASHA_APK_SOURCE_DIR;
    const u = await signUp("upd5");
    const body = await jsonOf<Record<string, unknown>>(await callRoute(GET, { cookie: u.cookie }));
    expect(body).toEqual({ state: "idle" });
  });

  it("ready build exposes link + sha256 + bytes + stamp", async () => {
    const u = await signUp("upd6");
    const uid = await sessionId(u.cookie);
    const { token } = makeRow(uid, { status: "ready", sha256: "abc123", content: "APKDATA" });
    const body = await jsonOf<Record<string, unknown>>(await callRoute(GET, { cookie: u.cookie }));
    expect(body).toEqual({
      state: "ready",
      downloadUrl: `/d/${token}`,
      sha256: "abc123",
      bytes: 7,
      versionCode: 3,
      versionName: "0.3.0",
    });
  });

  it("ready row without checksum or file omits those fields", async () => {
    const u = await signUp("upd7");
    const uid = await sessionId(u.cookie);
    const { token } = makeRow(uid, { status: "ready" });
    const body = await jsonOf<Record<string, unknown>>(await callRoute(GET, { cookie: u.cookie }));
    expect(body).toEqual({ state: "ready", downloadUrl: `/d/${token}`, versionCode: 3, versionName: "0.3.0" });
  });

  it("failed row carries the error", async () => {
    const u = await signUp("upd8");
    const uid = await sessionId(u.cookie);
    makeRow(uid, { status: "failed", error: "gradle_failed (exit 1): boom" });
    const body = await jsonOf<{ state: string; error?: string }>(await callRoute(GET, { cookie: u.cookie }));
    expect(body.state).toBe("failed");
    expect(body.error).toBe("gradle_failed (exit 1): boom");
  });

  // LAST: exhausts the shared auth bucket for this route key.
  it("auth-grade rate limit", async () => {
    const u = await signUp("upd9");
    process.env.YASHA_RATE_LIMIT = "";
    process.env.RATE_LIMIT_AUTH_PER_MIN = "2";
    try {
      const codes: number[] = [];
      codes.push((await callRoute(GET, { cookie: u.cookie })).status);
      codes.push((await callRoute(GET, { cookie: u.cookie })).status);
      // Both verbs exhaust the same auth bucket: 3rd GET and 4th POST 429.
      codes.push((await callRoute(GET, { cookie: u.cookie })).status);
      codes.push((await callRoute(POST, { cookie: u.cookie })).status);
      expect(codes).toEqual([200, 200, 429, 429]);
    } finally {
      process.env.YASHA_RATE_LIMIT = "off";
      delete process.env.RATE_LIMIT_AUTH_PER_MIN;
      vi.unstubAllEnvs();
    }
  });
});
