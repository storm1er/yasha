// Public app version stamp (issue #34, Phase A): lets the Android app compare its own
// BuildConfig.VERSION_CODE against what this server would build. No auth (pre-login checks
// must work; the payload leaks nothing), auth-grade rate limit (it is unauthenticated).

import { NextResponse, type NextRequest } from "next/server";
import { readAppVersion } from "@/lib/app-version";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const version = await readAppVersion(
    process.env.YASHA_APK_SOURCE_DIR ?? "/opt/yasha-android",
  );
  if (!version) return NextResponse.json({ error: "version_unavailable" }, { status: 503 });
  return NextResponse.json(version);
}
