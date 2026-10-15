// Account output/UI locale (locale-aware memory): signed-in users set the
// canonical locale here; the language switcher and the Android app PATCH it.

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getAuthedUserId } from "@/lib/api-auth";
import { db, ensureReady } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { isLocale } from "@/i18n/routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  await ensureReady();
  const userId = await getAuthedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { locale?: unknown };
  try {
    body = (await req.json()) as { locale?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_locale" }, { status: 400 });
  }
  const locale = typeof body?.locale === "string" && isLocale(body.locale) ? body.locale : null;
  if (!locale) return NextResponse.json({ error: "invalid_locale" }, { status: 400 });
  db.update(user).set({ locale }).where(eq(user.id, userId)).run();
  return NextResponse.json({ locale });
}
