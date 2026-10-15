import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { user } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureReady();
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // A valid session row implies the user row exists (FK cascade on delete).
  const row = db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      locale: user.locale,
    })
    .from(user)
    .where(eq(user.id, userId))
    .get()!;
  return NextResponse.json({ user: row });
}
