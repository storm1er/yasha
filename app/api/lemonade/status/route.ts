import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Session-gated health probe (UI badge on the authenticated chat surface).
 * Server-side only: the Lemonade URL/key never reach the browser beyond the
 * base URL, and that base URL is no longer disclosed to anonymous callers.
 */
export async function GET() {
  if (!(await getAuthedUserId())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const base = (process.env.LEMONADE_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    return NextResponse.json({ ok: false, url: null });
  }
  try {
    const headers: Record<string, string> = {};
    const key = process.env.LEMONADE_API_KEY;
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${base}/v1/health`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json({ ok: res.ok, url: base, status: res.status });
  } catch {
    return NextResponse.json({ ok: false, url: base });
  }
}
