import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureReady } from "@/lib/db";
import { ensureWorker } from "@/lib/jobs/worker";

export type AdminGuard =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse };

/**
 * Session-auth + admin-role guard for /api/admin/*.
 * No session → 401 unauthorized; session but role !== "admin" → 403 forbidden.
 * Doubles as a lazy worker start (dev HMR never re-runs instrumentation).
 */
export async function requireAdmin(): Promise<AdminGuard> {
  await ensureReady();
  ensureWorker();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  const role = (session.user as unknown as { role?: unknown }).role;
  if (role !== "admin") {
    return {
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  }
  return { ok: true, userId: session.user.id };
}

/** Uniform upstream-failure response for admin GET routes. */
export function upstreamErrorResponse(): NextResponse {
  return NextResponse.json({ error: "upstream_error" }, { status: 502 });
}
