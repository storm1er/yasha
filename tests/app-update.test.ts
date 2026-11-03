// /api/app-update — generic per-version releases (issue #34, Phase C). The
// source dir carries a VERSION stamp but NO settings.gradle.kts, so queued
// builds settle fast on toolchain_unavailable (no gradle mock needed).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { apkReleaseTokens, apkReleases } from "@/lib/db/schema";
import { setSetting } from "./support/db";
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
});

afterEach(() => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
  delete process.env.YASHA_APK_BUILD_DIR;
  delete process.env.YASHA_APK_SOURCE_DIR;
  db.delete(apkReleaseTokens).run();
  db.delete(apkReleases).run();
});

async function settle() {
  const m = await import("@/lib/apk-builder");
  await m.buildsSettled();
}

const releases = () => db.select().from(apkReleases).all();

function readyRelease(over: { versionCode?: number; sha256?: string | null; content?: string | null } = {}) {
  const now = new Date();
  let apkPath: string | null = null;
  if (over.content) {
    apkPath = join(buildDir, `${over.versionCode ?? 3}.apk`);
    writeFileSync(apkPath, over.content);
  }
  db.insert(apkReleases)
    .values({
      id: crypto.randomUUID(),
      versionCode: over.versionCode ?? 3,
      versionName: `0.${(over.versionCode ?? 3) - 0}.0`,
      status: "ready",
      apkPath,
      sha256: over.sha256 === undefined ? "abc123" : over.sha256,
      error: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("admin kill-switch (app_updates.enabled)", () => {
  it("both verbs answer 409 app_updates_disabled while off", async () => {
    const u = await signUp("upd0");
    setSetting("app_updates.enabled", "false");
    try {
      for (const verb of [GET, POST]) {
        const res = await callRoute(verb, { cookie: u.cookie });
        expect(res.status).toBe(409);
        expect((await jsonOf<{ error: string }>(res)).error).toBe("app_updates_disabled");
      }
      expect(releases()).toHaveLength(0);
    } finally {
      setSetting("app_updates.enabled", "true");
    }
  });
});

describe("POST /api/app-update", () => {
  it("requires a session", async () => {
    expect((await callRoute(GET)).status).toBe(401);
    expect((await callRoute(POST)).status).toBe(401);
  });

  it("queues the generic release; later users join the same row", async () => {
    const u1 = await signUp("upd1");
    const body = await jsonOf<{ state: string; versionCode: number; versionName: string }>(
      await callRoute(POST, { cookie: u1.cookie }),
    );
    expect(body.state).toBe("queued");
    expect(body).toMatchObject({ versionCode: 3, versionName: "0.3.0" });

    const u2 = await signUp("upd2");
    const again = await jsonOf<{ state: string }>(await callRoute(POST, { cookie: u2.cookie }));
    expect(again.state).toBe("queued");
    expect(releases()).toHaveLength(1);
    await settle();
    expect(releases()[0]!.status).toBe("failed"); // no toolchain in the test image
  });

  it("a failed release is retried by the next POST", async () => {
    const u = await signUp("upd3");
    await callRoute(POST, { cookie: u.cookie });
    await settle();
    expect(releases()[0]!.status).toBe("failed");
    const retry = await jsonOf<{ state: string }>(await callRoute(POST, { cookie: u.cookie }));
    expect(retry.state).toBe("queued");
    expect(releases()).toHaveLength(1);
    await settle();
  });

  it("unreadable stamp source → 503 version_unavailable", async () => {
    delete process.env.YASHA_APK_SOURCE_DIR;
    const u = await signUp("upd4");
    const res = await callRoute(POST, { cookie: u.cookie });
    expect(res.status).toBe(503);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("version_unavailable");
    expect(releases()).toHaveLength(0);
  });
});

describe("GET /api/app-update", () => {
  it("idle GET exposes the build stamp and creates nothing", async () => {
    const u = await signUp("upd5");
    const body = await jsonOf<Record<string, unknown>>(await callRoute(GET, { cookie: u.cookie }));
    expect(body).toEqual({ state: "idle", versionCode: 3, versionName: "0.3.0" });
    expect(releases()).toHaveLength(0);
  });

  it("unreadable stamp source → state idle, stamp omitted", async () => {
    // No YASHA_APK_SOURCE_DIR → falls back to /opt/yasha-android, which does
    // not exist in the test image.
    delete process.env.YASHA_APK_SOURCE_DIR;
    const u = await signUp("upd6");
    const body = await jsonOf<Record<string, unknown>>(await callRoute(GET, { cookie: u.cookie }));
    expect(body).toEqual({ state: "idle" });
  });

  it("ready release: per-user link + sha + bytes; each user gets their own link", async () => {
    readyRelease({ content: "APKDATA", sha256: "abc123" });
    const u1 = await signUp("upd7");
    const body = await jsonOf<Record<string, unknown>>(await callRoute(GET, { cookie: u1.cookie }));
    expect(String(body.downloadUrl)).toMatch(/^\/d\/.{10,}$/);
    expect(body).toMatchObject({ state: "ready", sha256: "abc123", bytes: 7, versionCode: 3, versionName: "0.3.0" });
    // Unclaimed link reused on the next poll; a different user gets a new one.
    const same = await jsonOf<{ downloadUrl: string }>(await callRoute(GET, { cookie: u1.cookie }));
    expect(same.downloadUrl).toBe(body.downloadUrl);
    const u2 = await signUp("upd8");
    const other = await jsonOf<{ downloadUrl: string }>(await callRoute(GET, { cookie: u2.cookie }));
    expect(other.downloadUrl).not.toBe(body.downloadUrl);
    expect(db.select().from(apkReleaseTokens).all()).toHaveLength(2);
  });

  it("ready row without checksum or file omits those fields", async () => {
    readyRelease({ sha256: null });
    const u = await signUp("upd9");
    const body = await jsonOf<Record<string, unknown>>(await callRoute(GET, { cookie: u.cookie }));
    expect(body).toMatchObject({ state: "ready" });
    expect(body.sha256).toBeUndefined();
    expect(body.bytes).toBeUndefined();
  });

  it("a release for a different stamp is not the channel: idle", async () => {
    readyRelease({ versionCode: 42, content: "STALE" });
    const u = await signUp("upd10");
    const body = await jsonOf<Record<string, unknown>>(await callRoute(GET, { cookie: u.cookie }));
    expect(body.state).toBe("idle");
    expect(body.downloadUrl).toBeUndefined();
  });

  // LAST: exhausts the shared auth bucket for this route key.
  it("auth-grade rate limit", async () => {
    const u = await signUp("upd11");
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
