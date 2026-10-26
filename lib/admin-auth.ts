import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureReady } from "@/lib/db";
import { ensureWorker } from "@/lib/jobs/worker";
import { controlPlaneForAdmin, type ControlPlaneLookup } from "@/lib/provider/registry";
import type { ControlPlane } from "@/lib/provider/types";

export type AdminGuard =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse };

export type ControlPlaneGuard =
  | { ok: true; userId: string; cp: ControlPlane }
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

/** `?provider=` selection on control-plane routes (M3 Backend tab). */
export function providerParam(req: Request): string | undefined {
  return new URL(req.url).searchParams.get("provider") ?? undefined;
}

/** Uniform ControlPlaneLookup failure mapping (503/404/501, Q10). */
export function controlPlaneErrorResponse(lookup: Exclude<ControlPlaneLookup, { ok: true }>): NextResponse {
  const status = lookup.error === "no_backend" ? 503 : lookup.error === "provider_not_found" ? 404 : 501;
  return NextResponse.json({ error: lookup.error }, { status });
}

/**
 * requireAdmin() + control-plane capability check (docs/provider-plan.md Q10).
 * Honours `?provider=` (M3 Backend tab): unknown/disabled id → 404. Without a
 * selection: no enabled provider → 503 no_backend; provider without a
 * management plane → 501 (the UI hides these sections, so this only answers
 * direct calls).
 */
export async function requireControlPlane(req: Request): Promise<ControlPlaneGuard> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard;
  const lookup = controlPlaneForAdmin(providerParam(req));
  if (lookup.ok) return { ok: true, userId: guard.userId, cp: lookup.controlPlane };
  if (lookup.error === "no_backend") {
    return {
      ok: false,
      response: NextResponse.json({ error: "no_backend" }, { status: 503 }),
    };
  }
  if (lookup.error === "provider_not_found") {
    return {
      ok: false,
      response: NextResponse.json({ error: "provider_not_found" }, { status: 404 }),
    };
  }
  return {
    ok: false,
    response: NextResponse.json({ error: "provider_lacks_control_plane" }, { status: 501 }),
  };
}
