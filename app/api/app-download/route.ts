import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { apkServerUrl, getBuild, rebuild, sweepExpired, viewOf } from "@/lib/apk-builder";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Explicit misconfiguration → visible, stable error (no Host-header fallback).
const MISCONFIG = () =>
  NextResponse.json(
    {
      state: "failed",
      error: "trusted_origins_unset",
      detail: "Set BETTER_AUTH_TRUSTED_ORIGINS to the public origin of this instance to enable app builds.",
    },
    { status: 409 }
  );

// Status poll only: a build starts exclusively on explicit user action (POST).
export async function GET(req: Request) {
  await ensureReady();
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  sweepExpired();
  const row = getBuild(userId);
  if (row) return NextResponse.json(viewOf(row));
  try {
    apkServerUrl();
  } catch {
    return MISCONFIG();
  }
  return NextResponse.json({ state: "idle" as const });
}

// Force a fresh build + new one-time link (retry / lost download).
export async function POST(req: Request) {
  await ensureReady();
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await rebuild(userId, apkServerUrl()));
  } catch {
    return MISCONFIG();
  }
}
