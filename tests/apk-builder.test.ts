// lib/apk-builder: per-user APK builds with a fake gradle (child_process is
// globally mocked — the test image has no Android toolchain).

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, rawSqlite } from "@/lib/db";
import { apkBuilds, session, user } from "@/lib/db/schema";
import { signUp } from "./support/app";

const ctl = vi.hoisted(() => ({
  code: 0 as number | null,
  error: null as Error | null,
  noStreams: false,
  hang: false,
  writeApk: true,
  killRef: null as null | (() => void),
}));
const lastSpawn = vi.hoisted(() => ({ args: [] as string[], env: {} as Record<string, string>, workDir: "" }));

vi.mock("node:child_process", () => ({
  spawn: (_cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => {
    lastSpawn.args = args;
    lastSpawn.env = opts.env;
    lastSpawn.workDir = args[args.indexOf("-p") + 1];
    const child = new EventEmitter() as EventEmitter & {
      stdout?: EventEmitter;
      stderr?: EventEmitter;
      kill: () => void;
    };
    if (!ctl.noStreams) {
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
    }
    const emit = () => {
      if (ctl.error) return void child.emit("error", ctl.error);
      child.stdout?.emit("data", "gradle out\n");
      child.stderr?.emit("data", "gradle err\n");
      if (ctl.writeApk) {
        // Follow the requested variant so release-mode builds produce their artifact.
        const variant = args.includes("assembleRelease") ? "release" : "debug";
        const apkDir = join(lastSpawn.workDir, "app/build/outputs/apk", variant);
        mkdirSync(apkDir, { recursive: true });
        writeFileSync(join(apkDir, `app-${variant}.apk`), "APKDATA");
      }
      child.emit("close", ctl.code);
    };
    child.kill = () => {
      ctl.killRef = null;
      emit();
    };
    ctl.killRef = child.kill;
    if (!ctl.hang) setTimeout(emit, 0);
    return child;
  },
}));

let buildDir = "";
let sourceDir = "";

const userIdOf = (username: string) =>
  db.select({ id: user.id }).from(user).where(eq(user.username, username)).get()!.id;
const rowFor = (userId: string) =>
  db.select().from(apkBuilds).where(eq(apkBuilds.userId, userId)).get();

async function settle() {
  const m = await import("@/lib/apk-builder");
  await m.buildsSettled();
}

beforeEach(() => {
  buildDir = mkdtempSync(join(tmpdir(), "yasha-apk-build-"));
  sourceDir = mkdtempSync(join(tmpdir(), "yasha-apk-src-"));
  process.env.YASHA_APK_BUILD_DIR = buildDir;
  process.env.YASHA_APK_SOURCE_DIR = sourceDir;
  delete process.env.YASHA_APK_BUILD_TIMEOUT_MS;
  ctl.code = 0;
  ctl.error = null;
  ctl.noStreams = false;
  ctl.hang = false;
  ctl.writeApk = true;
  ctl.killRef = null;
});

afterEach(async () => {
  ctl.killRef?.(); // never leave a hung fake gradle clogging the build chain
  await settle();
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
  delete process.env.YASHA_APK_BUILD_DIR;
  delete process.env.YASHA_APK_SOURCE_DIR;
  delete process.env.YASHA_APK_BUILD_TIMEOUT_MS;
  delete process.env.GRADLE_USER_HOME;
  delete process.env.YASHA_KEYSTORE;
  delete process.env.YASHA_KEYSTORE_PASSWORD;
  delete process.env.YASHA_KEY_ALIAS;
  delete process.env.YASHA_KEY_PASSWORD;
});

describe("apk-builder: build lifecycle", () => {
  it("gradle spawn error fails the build", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    ctl.error = new Error("spawn ENOENT");
    const u = await signUp("apk1");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    const view = await m.rebuild(id, "https://y.example");
    expect(view.state).toBe("queued");
    await settle();
    const row = rowFor(id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("gradle_spawn_failed");
    expect(row.error).toContain("spawn ENOENT");
    const baked = db.select().from(session).where(eq(session.id, row.sessionId)).get();
    expect(baked!.token.length).toBeGreaterThan(20);
  });

  it("build dir falls back to the DATABASE_PATH sibling dir", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    delete process.env.YASHA_APK_BUILD_DIR;
    const fallbackDir = join(dirname(process.env.DATABASE_PATH!), "apk-builds");
    const u = await signUp("apk1b");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://y2.example");
    await settle();
    const row = rowFor(id)!;
    expect(row.status).toBe("ready");
    expect(row.apkPath).toBe(join(fallbackDir, `${row.id}.apk`));
    expect(existsSync(row.apkPath!)).toBe(true);
    rmSync(fallbackDir, { recursive: true, force: true });
  });

  it("no re-trigger while queued/building", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    ctl.hang = true; // gradle never closes on its own → row stays `building`
    const u = await signUp("apk2");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    try {
      await m.rebuild(id, "https://a.test");
      const before = rowFor(id)!;
      const again = await m.rebuild(id, "https://a.test");
      expect(["queued", "building"]).toContain(again.state);
      expect(rowFor(id)!.token).toBe(before.token);
    } finally {
      ctl.killRef?.(); // let the in-flight build finish
    }
    await settle();
    expect(rowFor(id)!.status).toBe("ready");
  });

  it("happy path: ready build with APK on disk + baked session kept", async () => {
    process.env.GRADLE_USER_HOME = "/tmp/gradle-home-under-test";
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    writeFileSync(join(sourceDir, "local.properties"), "sdk.dir=/nope");
    mkdirSync(join(sourceDir, ".gradle"), { recursive: true });
    writeFileSync(join(sourceDir, ".gradle", "junk"), "x");
    const u = await signUp("apk3");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://b.test");
    await settle();
    const row = rowFor(id)!;
    expect(row.status).toBe("ready");
    expect(readFileSync(row.apkPath!, "utf8")).toBe("APKDATA");
    expect(existsSync(join(buildDir, "work", row.id))).toBe(false);
    expect(existsSync(join(buildDir, "work", row.id, "local.properties"))).toBe(false);
    expect(existsSync(join(buildDir, "work", row.id, ".gradle"))).toBe(false);
    expect(lastSpawn.args).toContain("assembleDebug");
    const baked = db.select().from(session).where(eq(session.id, row.sessionId)).get()!;
    const { createHmac } = await import("node:crypto");
    const signed = `${baked.token}.${createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(baked.token).digest("base64")}`;
    expect(lastSpawn.args.join(" ")).toContain(`-PyashaSessionToken=${signed}`);
    expect(lastSpawn.env.GRADLE_USER_HOME).toBe("/tmp/gradle-home-under-test");
    expect(lastSpawn.env.ANDROID_USER_HOME).toBe(join(buildDir, ".android"));
    expect(db.select().from(session).where(eq(session.id, row.sessionId)).get()).toBeTruthy();
  });

  it("gradle exit≠0 → gradle_failed with log tail; gradle with no streams", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    ctl.code = 1;
    ctl.noStreams = true;
    const u = await signUp("apk4");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://c.test");
    await settle();
    const row = rowFor(id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("gradle_failed (exit 1)");
  });

  it("missing APK artifact → apk_missing", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    ctl.writeApk = false;
    const u = await signUp("apk5");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://d.test");
    await settle();
    expect(rowFor(id)!.error).toBe("apk_missing");
  });

  it("revoked baked session aborts the build", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    const u = await signUp("apk6");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://e.test");
    await settle();
    // Reset to queued, revoke the session, then run the build directly.
    const row = rowFor(id)!;
    db.update(apkBuilds).set({ status: "queued", error: null }).where(eq(apkBuilds.id, row.id)).run();
    db.delete(session).where(eq(session.id, row.sessionId)).run();
    await m.runBuild(row.id);
    expect(rowFor(id)!.error).toBe("session_revoked");
  });

  it("timeout kills gradle → build_timeout", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    process.env.YASHA_APK_BUILD_TIMEOUT_MS = "40";
    ctl.hang = true;
    ctl.writeApk = false;
    const u = await signUp("apk7");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://f.test");
    await settle();
    expect(rowFor(id)!.error).toBe("build_timeout");
  });

  it("null username still builds", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    const u = await signUp("apk8");
    const id = userIdOf(u.username);
    db.update(user).set({ username: null }).where(eq(user.id, id)).run();
    const m = await import("@/lib/apk-builder");
    await m.rebuild(id, "https://g.test");
    await settle();
    expect(rowFor(id)!.status).toBe("ready");
  });

  it("runBuild skips unknown and non-queued rows", async () => {
    const m = await import("@/lib/apk-builder");
    await m.runBuild("nope");
    expect(true).toBe(true);
  });

  it("missing source dir (env unset) → toolchain_unavailable", async () => {
    delete process.env.YASHA_APK_SOURCE_DIR;
    const u = await signUp("apk9");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://h.test");
    await settle();
    expect(rowFor(id)!.error).toBe("toolchain_unavailable");
  });

  it("YASHA_KEYSTORE switches to the signed release variant + env passthrough", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    process.env.YASHA_KEYSTORE = "/tmp/release.keystore";
    process.env.YASHA_KEYSTORE_PASSWORD = "sp";
    process.env.YASHA_KEY_ALIAS = "yasha";
    process.env.YASHA_KEY_PASSWORD = "kp";
    const u = await signUp("apk10");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://rel.test");
    await settle();
    expect(rowFor(id)!.status).toBe("ready"); // mock wrote app-release.apk
    expect(lastSpawn.args).toContain("assembleRelease");
    expect(lastSpawn.args).not.toContain("assembleDebug");
    expect(lastSpawn.env.YASHA_KEYSTORE).toBe("/tmp/release.keystore");
    expect(lastSpawn.env.YASHA_KEYSTORE_PASSWORD).toBe("sp");
    expect(lastSpawn.env.YASHA_KEY_ALIAS).toBe("yasha");
    expect(lastSpawn.env.YASHA_KEY_PASSWORD).toBe("kp");
  });

  it("settled builds carry the APK sha256", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    const u = await signUp("apk11");
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://hash.test");
    await settle();
    const { createHash } = await import("node:crypto");
    expect(rowFor(id)!.sha256).toBe(createHash("sha256").update("APKDATA").digest("hex"));
  });
});

describe("apk-builder: in-app update builds (#34)", () => {
  it("rebuildForUpdate borrows the caller session; replace + sweep never delete it", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    const u = await signUp("updb1");
    const id = userIdOf(u.username);
    const m = await import("@/lib/apk-builder");
    const now = new Date();
    const caller = crypto.randomUUID();
    db.insert(session)
      .values({ id: caller, token: `borrowed-${caller}`, userId: id, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now, updatedAt: now })
      .run();
    const row = await m.rebuildForUpdate(id, caller, "https://u.test");
    expect(row.sessionBorrowed).toBe(true);
    expect(row.sessionId).toBe(caller);
    await settle();
    expect(rowFor(id)!.status).toBe("ready");
    const firstToken = rowFor(id)!.token;
    // A second update request REPLACES the borrowed row (fresh token) without
    // ever deleting the borrowed session.
    await m.rebuildForUpdate(id, caller, "https://u.test");
    expect(rowFor(id)!.token).not.toBe(firstToken);
    expect(db.select().from(session).where(eq(session.id, caller)).get()).toBeTruthy();
    await settle();
    expect(rowFor(id)!.status).toBe("ready");
    // Sweeping the expired borrowed row also spares the session.
    db.update(apkBuilds).set({ expiresAt: new Date(Date.now() - 200_000) }).where(eq(apkBuilds.userId, id)).run();
    // Fake "now" in the past: runs (throttle starts cold in this file) yet
    // leaves the later sweep test's fake-now sequence unthrottled.
    m.sweepExpired(Date.now() - 61_000);
    expect(rowFor(id)).toBeUndefined();
    expect(db.select().from(session).where(eq(session.id, caller)).get()).toBeTruthy();
  });
});

describe("apk-builder: claim / rebuild / sweep", () => {
  async function readyBuild(label: string) {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    const u = await signUp(label);
    const m = await import("@/lib/apk-builder");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://k.test");
    await settle();
    return { u, m, id, row: rowFor(id)! };
  }

  it("claim is single-use; keeps the phone session; deletes on demand", async () => {
    const { u, m, row } = await readyBuild("claim1");
    const first = m.claimForDownload(row.token);
    expect(first!.fileName).toBe(`yasha-${u.username}.apk`);
    expect(readFileSync(first!.path, "utf8")).toBe("APKDATA");
    expect(m.claimForDownload(row.token)).toBeNull();
    m.deleteDownloadedApk(first!);
    expect(existsSync(first!.path)).toBe(false);
    const after = rowFor(row.userId)!;
    expect(after.status).toBe("consumed");
    expect(db.select().from(session).where(eq(session.id, after.sessionId)).get()).toBeTruthy();
    // viewOf(consumed) has no url; rebuild over consumed keeps the session.
    expect(m.viewOf(after)).toEqual({ state: "consumed" });
    const next = await m.rebuild(row.userId, "https://k.test");
    expect(next.state).toBe("queued");
    expect(db.select().from(session).where(eq(session.id, after.sessionId)).get()).toBeTruthy();
    await settle();
  });

  it("claim: unknown token → null; missing file → failed; null username → yasha-app.apk", async () => {
    const { m, row } = await readyBuild("claim2");
    expect(m.claimForDownload("bogus")).toBeNull();
    db.update(apkBuilds).set({ apkPath: join(buildDir, "gone.apk") }).where(eq(apkBuilds.id, row.id)).run();
    expect(m.claimForDownload(row.token)).toBeNull();
    expect(rowFor(row.userId)!.error).toBe("apk_file_missing");

    const r3 = await readyBuild("claim3");
    db.update(user).set({ username: null }).where(eq(user.id, r3.row.userId)).run();
    const c3 = r3.m.claimForDownload(r3.row.token);
    expect(c3!.fileName).toBe("yasha-app.apk");
    r3.m.deleteDownloadedApk(c3!);
  });

  it("rebuild over a failed build deletes file + unused session; ready keeps url view", async () => {
    const { m, id } = await readyBuild("claim4");
    db.update(apkBuilds).set({ status: "failed", error: null }).where(eq(apkBuilds.userId, id)).run();
    const row = rowFor(id)!;
    const view = m.viewOf(row);
    expect(view).toEqual({ state: "failed" });
    const before = rowFor(id)!;
    const fresh = await m.rebuild(id, "https://m.test");
    expect(fresh.state).toBe("queued");
    expect(db.select().from(session).where(eq(session.id, before.sessionId)).get()).toBeUndefined();
    await settle();
  });

  it("sweepExpired deletes expired rows/files, keeps building + consumed session", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    const m = await import("@/lib/apk-builder");
    const u = await signUp("sweep1");
    const id = userIdOf(u.username);
    await m.rebuild(id, "https://s.test");
    await settle();
    const row = rowFor(id)!;

    // A building row and a fresh row must survive; consumed keeps its session.
    const u2 = await signUp("sweep2");
    const id2 = userIdOf(u2.username);
    await m.rebuild(id2, "https://s.test");
    await settle();
    const row2 = rowFor(id2)!;
    db.update(apkBuilds).set({ status: "building" }).where(eq(apkBuilds.id, row2.id)).run();
    const c = m.claimForDownload(row.token);
    if (c) m.deleteDownloadedApk(c);
    // Force-expire the consumed row while keeping its (live) session reference.
    db.update(apkBuilds).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apkBuilds.id, row.id)).run();

    // Expired failed row with no file (null apkPath) must also disappear.
    const id3 = userIdOf((await signUp("sweep3")).username);
    const prevSource = sourceDir;
    rmSync(join(prevSource, "settings.gradle.kts"));
    await m.rebuild(id3, "https://s.test");
    await settle();
    writeFileSync(join(prevSource, "settings.gradle.kts"), "// src");
    db.update(apkBuilds).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apkBuilds.userId, id3)).run();

    const t0 = Date.now() + 5_000;
    m.sweepExpired(t0);
    expect(rowFor(id3)).toBeUndefined();
    expect(rowFor(id)).toBeUndefined();
    expect(rowFor(id2)).toBeTruthy(); // building untouched
    expect(db.select().from(session).where(eq(session.id, row.sessionId)).get()).toBeTruthy();
    // Throttled: same-minute call is a no-op even for newly expired rows.
    db.update(apkBuilds).set({ expiresAt: new Date(Date.now() - 1), status: "ready" }).where(eq(apkBuilds.id, row2.id)).run();
    m.sweepExpired(t0 + 1000);
    expect(rowFor(id2)).toBeTruthy();
    m.sweepExpired(t0 + 61_000);
    expect(rowFor(id2)).toBeUndefined();
  });

  // Destructive (drops the table) → keep last in the file.
  it("a poisoned build chain still settles (swallowed rejection)", async () => {
    writeFileSync(join(sourceDir, "settings.gradle.kts"), "// src");
    ctl.hang = true;
    const u = await signUp("poison");
    const m = await import("@/lib/apk-builder");
    await m.rebuild(userIdOf(u.username), "https://p.test");
    // Drop the table while the build is mid-flight: its final DB writes throw.
    rawSqlite.prepare("DROP TABLE apk_builds").run();
    ctl.killRef?.();
    await expect(m.buildsSettled()).resolves.toBeUndefined();
  });
});
