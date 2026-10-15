// Per-user Android APK builder.
//
// The web container ships the full toolchain (JDK + Android SDK + gradle, see
// docker/Dockerfile) — builds run in-process as child processes (no DinD).
// Each build bakes the server base URL + a dedicated better-auth session
// token into the APK (BuildConfig fields) so the app never shows a login
// screen. The download URL (/d/<token>) is single-use: claiming flips the row
// atomically and the APK file is deleted once served.

import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, lt, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { apkBuilds, session, user, type ApkBuild, type ApkBuildStatus } from "@/lib/db/schema";

// Baked session lifetime (app re-probes; sign-out in the app deletes it).
const SESSION_TTL_MS = 390 * 24 * 3_600_000;
// Download links / abandoned builds expire after this.
const BUILD_TTL_MS = 24 * 3_600_000;
const LOG_TAIL = 1500;

function baseDir(): string {
  // DATABASE_PATH is always set in-container (dev + runtime images).
  return process.env.YASHA_APK_BUILD_DIR ?? join(dirname(process.env.DATABASE_PATH!), "apk-builds");
}
function sourceDir(): string {
  return process.env.YASHA_APK_SOURCE_DIR ?? "/opt/yasha-android";
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

// better-auth session cookies are `token.base64(HMAC-SHA256(token, secret))`;
// the app replays this signed value verbatim as its Cookie header.
function signSessionCookie(token: string): string {
  const sig = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(token)
    .digest("base64");
  return `${token}.${sig}`;
}

/**
 * Server base URL baked into the APK: the first BETTER_AUTH_TRUSTED_ORIGINS
 * entry (the public origin — in-container the request URL is the 0.0.0.0 bind
 * address). When unset, builds are REFUSED: falling back to the incoming
 * request origin would let a spoofed Host header bake an attacker-chosen
 * server URL into a user's APK (the error is surfaced to the user in the UI).
 */
export function apkServerUrl(): string {
  const first = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .find(Boolean);
  if (!first) throw new Error("trusted_origins_unset");
  return first;
}

export type ApkStatusView = {
  state: ApkBuildStatus;
  error?: string;
  downloadUrl?: string;
  expiresAt?: string;
};

export function getBuild(userId: string): ApkBuild | null {
  return db.select().from(apkBuilds).where(eq(apkBuilds.userId, userId)).get() ?? null;
}

export function viewOf(row: ApkBuild): ApkStatusView {
  const view: ApkStatusView = { state: row.status };
  if (row.status === "ready") {
    view.downloadUrl = `/d/${row.token}`;
    view.expiresAt = row.expiresAt.toISOString();
  }
  if (row.status === "failed" && row.error) view.error = row.error;
  return view;
}

/** Discard the previous link (if any) and start a new build. */
export async function rebuild(userId: string, serverUrl: string): Promise<ApkStatusView> {
  const existing = getBuild(userId);
  if (existing && existing.status === "building") return viewOf(existing);
  return startFreshBuild(userId, serverUrl, existing);
}

function startFreshBuild(userId: string, serverUrl: string, existing: ApkBuild | null): ApkStatusView {
  const now = new Date();
  const token = newToken();
  const sessionId = crypto.randomUUID();
  db.insert(session)
    .values({
      id: sessionId,
      token,
      userId,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      userAgent: "Yasha Android app",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const values = {
    token,
    serverUrl,
    sessionId,
    status: "queued" as ApkBuildStatus,
    apkPath: null,
    error: null,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + BUILD_TTL_MS),
  };
  if (existing) {
    cleanupArtifacts(existing);
    db.update(apkBuilds).set(values).where(eq(apkBuilds.userId, userId)).run();
  } else {
    db.insert(apkBuilds)
      .values({ id: crypto.randomUUID(), userId, createdAt: now, ...values })
      .run();
  }
  const row = getBuild(userId)!;
  queueBuild(row.id);
  return viewOf(row);
}

// Builds run one at a time (gradle is heavy; single-replica assumption).
let chain: Promise<void> = Promise.resolve();

function queueBuild(rowId: string): void {
  // runBuild only throws if even markFailed's DB write throws (disk gone) —
  // swallow so one poisoned build cannot reject every later queued build.
  chain = chain.then(() => runBuild(rowId)).catch(() => {});
}

/** Resolves once every queued build has settled (tests + graceful shutdown). */
export function buildsSettled(): Promise<void> {
  return chain;
}

function markFailed(rowId: string, error: string): void {
  db.update(apkBuilds)
    .set({ status: "failed", error: error.slice(0, 2000), updatedAt: new Date() })
    .where(eq(apkBuilds.id, rowId))
    .run();
}

export async function runBuild(rowId: string): Promise<void> {
  const row = db.select().from(apkBuilds).where(eq(apkBuilds.id, rowId)).get();
  // Row replaced/deleted while queued → nothing to do.
  if (!row || row.status !== "queued") return;
  db.update(apkBuilds).set({ status: "building", updatedAt: new Date() }).where(eq(apkBuilds.id, rowId)).run();
  try {
    if (!existsSync(join(sourceDir(), "settings.gradle.kts"))) throw new Error("toolchain_unavailable");
    // FK guarantees the user row (deleted users cascade-delete this build).
    const owner = db.select({ username: user.username }).from(user).where(eq(user.id, row.userId)).get()!;
    const workDir = join(baseDir(), "work", row.id);
    const gradleHome = process.env.GRADLE_USER_HOME ?? join(baseDir(), "gradle-home");
    const androidHome = join(baseDir(), ".android");
    mkdirSync(join(baseDir(), "work"), { recursive: true });
    mkdirSync(androidHome, { recursive: true });
    rmSync(workDir, { recursive: true, force: true });
    cpSync(sourceDir(), workDir, {
      recursive: true,
      filter: (src) => !/(^|[/\\])(build|\.gradle|\.cxx|local\.properties)$/.test(src),
    });
    const sessionToken = db
      .select({ token: session.token })
      .from(session)
      .where(eq(session.id, row.sessionId))
      .get()?.token;
    // Session revoked (e.g. user deleted) → a baked APK would be useless.
    if (!sessionToken) throw new Error("session_revoked");
    const gradle = await runGradle(workDir, row.serverUrl, signSessionCookie(sessionToken), sanitize(owner.username ?? ""), {
      GRADLE_USER_HOME: gradleHome,
      ANDROID_USER_HOME: androidHome,
    });
    if (gradle.code !== 0) throw new Error(`gradle_failed (exit ${gradle.code}): ${gradle.tail}`);
    const apkOut = join(workDir, "app/build/outputs/apk/debug/app-debug.apk");
    if (!existsSync(apkOut)) throw new Error("apk_missing");
    const finalPath = join(baseDir(), `${row.id}.apk`);
    copyFileSync(apkOut, finalPath);
    rmSync(workDir, { recursive: true, force: true });
    db.update(apkBuilds)
      .set({ status: "ready", apkPath: finalPath, error: null, updatedAt: new Date() })
      .where(eq(apkBuilds.id, rowId))
      .run();
  } catch (err) {
    markFailed(rowId, err instanceof Error ? err.message : String(err));
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "");
}

function runGradle(
  workDir: string,
  serverUrl: string,
  sessionToken: string,
  username: string,
  env: Record<string, string>
): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "gradle",
      [
        "--no-daemon",
        "-p",
        workDir,
        "assembleDebug",
        `-PyashaServerUrl=${serverUrl}`,
        `-PyashaSessionToken=${sessionToken}`,
        `-PyashaUsername=${username}`,
      ],
      { cwd: workDir, env: { ...process.env, ...env } }
    );
    let log = "";
    const onData = (chunk: Buffer | string) => {
      log = (log + String(chunk)).slice(-LOG_TAIL);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => reject(`gradle_spawn_failed: ${err}`));
    let timedOut = false;
    const timeoutMs = Number(process.env.YASHA_APK_BUILD_TIMEOUT_MS ?? 30 * 60_000);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("build_timeout"));
      else resolve({ code, tail: log.trim().split("\n").slice(-15).join("\n") });
    });
  });
}

export type ClaimedDownload = { id: string; userId: string; path: string; fileName: string };

/** Atomic single-use claim of a ready build (returns the row only once). */
export function claimForDownload(token: string): ClaimedDownload | null {
  const claimed = db
    .update(apkBuilds)
    .set({ status: "consumed", updatedAt: new Date() })
    .where(and(eq(apkBuilds.token, token), eq(apkBuilds.status, "ready")))
    .returning()
    .get();
  if (!claimed) return null;
  if (!claimed.apkPath || !existsSync(claimed.apkPath)) {
    markFailed(claimed.id, "apk_file_missing");
    return null;
  }
  const owner = db.select({ username: user.username }).from(user).where(eq(user.id, claimed.userId)).get()!;
  return {
    id: claimed.id,
    userId: claimed.userId,
    path: claimed.apkPath,
    fileName: `yasha-${sanitize(owner.username ?? "") || "app"}.apk`,
  };
}

/** Drop the APK file once it has been streamed to the device. */
export function deleteDownloadedApk(claimed: ClaimedDownload): void {
  rmSync(claimed.path, { force: true });
}

export function cleanupArtifacts(row: ApkBuild): void {
  if (row.apkPath && existsSync(row.apkPath)) rmSync(row.apkPath, { force: true });
  // A consumed build's session is live on the phone — only unused ones die.
  if (row.status !== "consumed") db.delete(session).where(eq(session.id, row.sessionId)).run();
}

// ── Expiry sweep (throttled; called from status polls) ───────────────────────

let lastSweepAt = 0;

export function sweepExpired(now = Date.now()): void {
  if (now - lastSweepAt < 60_000) return;
  lastSweepAt = now;
  const expired = db
    .select()
    .from(apkBuilds)
    .where(and(lt(apkBuilds.expiresAt, new Date(now)), ne(apkBuilds.status, "building")))
    .all();
  for (const row of expired) {
    if (row.apkPath) rmSync(row.apkPath, { force: true });
    rmSync(join(baseDir(), "work", row.id), { recursive: true, force: true });
    db.delete(apkBuilds).where(eq(apkBuilds.id, row.id)).run();
    // Consumed rows leave their session alive for the installed app.
    if (row.status !== "consumed") db.delete(session).where(eq(session.id, row.sessionId)).run();
  }
}
