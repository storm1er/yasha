// In-app update trigger (issue #34, Phase B): starts/polls the build of the
// caller's own update APK. Thin wrapper over lib/apk-builder with session
// reuse — the baked session IS the caller's current one, so token rotation
// follows the app's own lifecycle (no 390-day session per update). Download
// stays on the existing single-use /d/<token> route.

import { NextResponse } from "next/server";
import { getAuthedContext } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { apkServerUrl, getBuild, rebuildForUpdate, sweepExpired, updateViewOf } from "@/lib/apk-builder";
import { readAppVersion } from "@/lib/app-version";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The stamp the build would carry (same source as GET /api/app/version).
async function buildStamp(): Promise<Record<string, number | string>> {
  const version = await readAppVersion(process.env.YASHA_APK_SOURCE_DIR ?? "/opt/yasha-android");
  return version ? { versionCode: version.versionCode, versionName: version.versionName } : {};
}

// Explicit misconfiguration → same stable error the web download surfaces.
const MISCONFIG = () =>
  NextResponse.json(
    {
      state: "failed",
      error: "trusted_origins_unset",
      detail: "Set BETTER_AUTH_TRUSTED_ORIGINS to the public origin of this instance to enable app builds.",
    },
    { status: 409 },
  );

// Status poll (no state change): queued/building/ready/failed, or idle when no
// build exists yet for this user.
export async function GET(req: Request) {
  await ensureReady();
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const ctx = await getAuthedContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  sweepExpired();
  const stamp = await buildStamp();
  const row = getBuild(ctx.userId);
  if (!row) return NextResponse.json({ state: "idle" as const, ...stamp });
  return NextResponse.json({ ...updateViewOf(row), ...stamp });
}

// Start (or replace) the update build, baking the CALLER's current session.
// An in-flight build is returned as-is (mirrors rebuild() semantics).
export async function POST(req: Request) {
  await ensureReady();
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const ctx = await getAuthedContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const row = await rebuildForUpdate(ctx.userId, ctx.sessionId, apkServerUrl());
    return NextResponse.json({ ...updateViewOf(row), ...(await buildStamp()) });
  } catch {
    return MISCONFIG();
  }
}
