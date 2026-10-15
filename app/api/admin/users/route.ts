import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { requireAdmin } from "@/lib/admin-auth";
import { auth } from "@/lib/auth";
import { db, ensureReady } from "@/lib/db";
import { ensureWorker } from "@/lib/jobs/worker";
import { account, user } from "@/lib/db/schema";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mirrors the registration UI rules (components/auth-form.tsx) and the auth
// config (lib/auth.ts): username charset/length + password min length.
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

function invalid(reason: string) {
  return NextResponse.json({ error: reason }, { status: 400 });
}

export async function GET(req: Request) {
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const users = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
    })
    .from(user)
    .all();
  return NextResponse.json({ users });
}

export async function PATCH(req: NextRequest) {
  // Admins may edit any account; any signed-in user may edit their own.
  await ensureReady();
  ensureWorker();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const isAdmin = (session.user as unknown as { role?: unknown }).role === "admin";

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return invalid("invalid_payload");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_payload");
  const { userId, username, email, password } = body as Record<string, unknown>;
  if (typeof userId !== "string" || !userId) return invalid("invalid_payload");
  if (!isAdmin && userId !== session.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  for (const value of [username, email, password]) {
    if (value !== undefined && typeof value !== "string") return invalid("invalid_payload");
  }
  if (username === undefined && email === undefined && password === undefined) {
    return invalid("invalid_payload");
  }

  const target = db
    .select({ id: user.id, username: user.username })
    .from(user)
    .where(eq(user.id, userId))
    .get();
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const data: Partial<{ name: string; email: string; username: string; displayUsername: string }> = {};

  if (typeof username === "string") {
    const trimmed = username.trim();
    if (!USERNAME_RE.test(trimmed)) return invalid("invalid_username");
    const lower = trimmed.toLowerCase();
    const taken = db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.username, lower), ne(user.id, userId)))
      .get();
    if (taken) return NextResponse.json({ error: "username_taken" }, { status: 409 });
    // The username plugin (case-insensitive) stores lowercase + display case.
    data.username = lower;
    data.displayUsername = trimmed;
    data.name = trimmed;
  }

  if (typeof email === "string") {
    const lower = email.trim().toLowerCase();
    if (!EMAIL_RE.test(lower)) return invalid("invalid_email");
    const taken = db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, lower))
      .get();
    if (taken && taken.id !== userId) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    data.email = lower;
  }

  if (typeof password === "string") {
    if (password.length < MIN_PASSWORD || password.length > 500) return invalid("invalid_password");
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(password);
    const res = db
      .update(account)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
      .run();
    if (!res || res.changes === 0) {
      return NextResponse.json({ error: "no_credential_account" }, { status: 409 });
    }
  }

  if (Object.keys(data).length > 0) {
    db.update(user).set({ ...data, updatedAt: new Date() }).where(eq(user.id, userId)).run();
  }

  const updated = db
    .select({ id: user.id, name: user.name, email: user.email, username: user.username, role: user.role })
    .from(user)
    .where(eq(user.id, userId))
    .get();
  // passwordChanged → the client invites the user to disconnect their other
  // sessions (this route does NOT revoke them: the current browser stays in).
  return NextResponse.json({ ok: true, passwordChanged: typeof password === "string", user: updated });
}
