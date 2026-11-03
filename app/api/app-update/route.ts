// In-app update channel (issue #34, Phase C): ONE generic (credential-free)
// APK per server version stamp, shared by every user — the installed app
// keeps its own session through the package update. GET polls (no state
// change beyond a per-user link), POST ensures/retries the build. Downloads
// ride the per-user single-use /d/<token> route onto the shared artifact.
// Gated by the admin toggle `app_updates.enabled`.

import { NextResponse } from "next/server";
import { getAuthedContext } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { ensureRelease, releaseFor, releaseViewOf, sourceDir, sweepExpired } from "@/lib/apk-builder";
import { readAppVersion } from "@/lib/app-version";
import { appUpdatesEnabled } from "@/lib/settings";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin kill-switch: the app maps this code to "disabled by administrator".
const DISABLED = () =>
  NextResponse.json({ state: "failed", error: "app_updates_disabled" }, { status: 409 });

async function stamp() {
  return readAppVersion(sourceDir());
}

// Status poll: queued/building/ready/failed, or idle when no release exists
// yet for the current stamp. Carries the stamp + release notes for the dialog.
export async function GET(req: Request) {
  await ensureReady();
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const ctx = await getAuthedContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!appUpdatesEnabled()) return DISABLED();
  sweepExpired();
  const version = await stamp();
  if (!version) return NextResponse.json({ state: "idle" as const });
  const row = releaseFor(version.versionCode);
  const stampFields = { versionCode: version.versionCode, versionName: version.versionName };
  if (!row) return NextResponse.json({ state: "idle" as const, ...stampFields });
  return NextResponse.json({ ...releaseViewOf(row, ctx.userId), ...stampFields });
}

// Ensure the generic release for the current stamp exists (build/join/retry).
export async function POST(req: Request) {
  await ensureReady();
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const ctx = await getAuthedContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!appUpdatesEnabled()) return DISABLED();
  const version = await stamp();
  if (!version) {
    return NextResponse.json({ state: "failed", error: "version_unavailable" }, { status: 503 });
  }
  const row = ensureRelease(version.versionCode, version.versionName);
  return NextResponse.json({
    ...releaseViewOf(row, ctx.userId),
    versionCode: version.versionCode,
    versionName: version.versionName,
  });
}
