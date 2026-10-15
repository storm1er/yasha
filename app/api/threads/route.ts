import { NextResponse } from "next/server";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { threads } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensureReady();
  const limited = await rateLimit(req, "write");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      threadId: threads.id,
      title: threads.title,
      updatedAt: threads.updatedAt,
    })
    .from(threads)
    .where(eq(threads.userId, userId))
    .orderBy(desc(threads.updatedAt), desc(threads.createdAt));

  return NextResponse.json({
    threads: rows.map((r) => ({
      threadId: r.threadId,
      title: r.title,
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
}
