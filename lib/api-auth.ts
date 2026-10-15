import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { rawSqlite } from "@/lib/db";

export type AuthedContext = { userId: string; sessionId: string };

// "Last used" bookkeeping for the /api/me/sessions view: bump the session's
// updatedAt at most once a minute per session (throttled in-process).
const ACTIVITY_FLUSH_MS = 60_000;
const lastBump = new Map<string, number>();

function bumpSessionActivity(sessionId: string, now: number): void {
  const prev = lastBump.get(sessionId);
  if (prev !== undefined && now - prev < ACTIVITY_FLUSH_MS) return;
  lastBump.set(sessionId, now);
  // Opportunistic eviction keeps the throttle map bounded.
  for (const [id, ts] of lastBump) {
    if (now - ts >= ACTIVITY_FLUSH_MS) lastBump.delete(id);
  }
  rawSqlite
    .prepare("UPDATE session SET updated_at = ? WHERE id = ?")
    .run(now, sessionId);
}

export async function getAuthedContext(): Promise<AuthedContext | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  bumpSessionActivity(session.session.id, Date.now());
  return { userId: session.user.id, sessionId: session.session.id };
}

export async function getAuthedUserId(): Promise<string | null> {
  return (await getAuthedContext())?.userId ?? null;
}
