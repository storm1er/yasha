// Per-user extraction opt-out: { userEnabled: boolean | null } — null = follow
// the instance default (`memory.enabled`).

import { NextResponse, type NextRequest } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { ensureReady } from "@/lib/db";
import { getUserMemoryOverride, setUserMemoryEnabled } from "@/lib/memory/prefs";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!("userEnabled" in obj)) return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  const value = obj.userEnabled;
  if (value !== null && typeof value !== "boolean") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  setUserMemoryEnabled(userId, value as boolean | null);
  return NextResponse.json({ ok: true, userEnabled: getUserMemoryOverride(userId) ?? null });
}
