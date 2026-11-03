// Public app version stamp (issue #34, Phase A): lets the Android app compare its own
// BuildConfig.VERSION_CODE against what this server would build. No auth (pre-login checks
// must work; the payload leaks nothing), auth-grade rate limit (it is unauthenticated).
// Phase C adds: the admin kill-switch (`app_updates.enabled` → 403) and the
// CHANGELOG excerpt for the offered version (shown in the update dialog).

import { NextResponse, type NextRequest } from "next/server";
import { sourceDir } from "@/lib/apk-builder";
import { ensureReady } from "@/lib/db";
import { readAppVersion } from "@/lib/app-version";
import { readReleaseNotes } from "@/lib/release-notes";
import { appUpdatesEnabled } from "@/lib/settings";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  await ensureReady();
  if (!appUpdatesEnabled()) {
    return NextResponse.json({ error: "app_updates_disabled" }, { status: 403 });
  }
  const version = await readAppVersion(sourceDir());
  if (!version) return NextResponse.json({ error: "version_unavailable" }, { status: 503 });
  const notes = await readReleaseNotes(sourceDir(), version.versionName);
  return NextResponse.json(notes ? { ...version, notes } : version);
}
