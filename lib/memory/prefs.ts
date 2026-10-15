// Per-user memory prefs (`user_settings`, JSON values). Row absent = follow the
// instance default (`memory.enabled`). Sync reads: same better-sqlite3 client.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userSettings } from "@/lib/db/schema";
import { memoryEnabled } from "@/lib/settings";

export const USER_MEMORY_KEY = "memory.userEnabled";

/** undefined = no personal override (follow instance default). */
export function getUserMemoryOverride(userId: string): boolean | undefined {
  const row = db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, userId), eq(userSettings.key, USER_MEMORY_KEY)))
    .get();
  if (!row) return undefined;
  const v = row.value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** Effective personal memory state: override ?? `memory.enabled` instance default. */
export function getUserMemoryEnabled(userId: string): boolean {
  const ov = getUserMemoryOverride(userId);
  return ov === undefined ? memoryEnabled() : ov;
}

export function setUserMemoryEnabled(userId: string, value: boolean | null): void {
  if (value === null) {
    db.delete(userSettings)
      .where(and(eq(userSettings.userId, userId), eq(userSettings.key, USER_MEMORY_KEY)))
      .run();
    return;
  }
  const now = new Date();
  const scope = and(eq(userSettings.userId, userId), eq(userSettings.key, USER_MEMORY_KEY));
  db.transaction((tx) => {
    const existing = tx.select({ userId: userSettings.userId }).from(userSettings).where(scope).get();
    if (existing) {
      tx.update(userSettings).set({ value: String(value), updatedAt: now }).where(scope).run();
    } else {
      tx.insert(userSettings).values({ userId, key: USER_MEMORY_KEY, value: String(value), updatedAt: now }).run();
    }
  });
}
