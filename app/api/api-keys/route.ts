import { NextResponse, type NextRequest } from "next/server";
import { createKey, listKeys, MAX_ACTIVE_API_KEYS } from "@/lib/api-keys";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { and, count, eq, isNull } from "drizzle-orm";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensureReady();
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const keys = await listKeys(userId);
  const activeCount =
    db
      .select({ value: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .get()?.value ?? 0;

  return NextResponse.json({ keys, activeCount, maxActive: MAX_ACTIVE_API_KEYS });
}

export async function POST(req: NextRequest) {
  await ensureReady();
  const limited = await rateLimit(req, "auth");
  if (limited) return limited;
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const name =
    typeof (body as { name?: unknown })?.name === "string"
      ? (body as { name: string }).name.trim()
      : "";
  if (!name || name.length > 50) return NextResponse.json({ error: "invalid_name" }, { status: 400 });

  try {
    const created = await createKey(userId, name);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === "key_limit_reached") {
      return NextResponse.json(
        { error: "key_limit_reached", maxActive: MAX_ACTIVE_API_KEYS },
        { status: 409 }
      );
    }
    throw err;
  }
}
