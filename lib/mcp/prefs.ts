// Per-user tool-use opt-out (`user_settings`, JSON values), mirroring the
// memory prefs pattern. Row absent = follow the instance default.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userSettings } from "@/lib/db/schema";
import { mcpEnabled } from "@/lib/settings";

export const USER_MCP_KEY = "mcp.userEnabled";

/** undefined = no personal override (follow instance default). */
export function getUserMcpOverride(userId: string): boolean | undefined {
  const row = db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, userId), eq(userSettings.key, USER_MCP_KEY)))
    .get();
  if (!row) return undefined;
  const v = row.value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** Effective personal tool-use state: override ?? `mcp.enabled` instance default. */
export function getUserMcpEnabled(userId: string): boolean {
  const ov = getUserMcpOverride(userId);
  return ov === undefined ? mcpEnabled() : ov;
}

export function setUserMcpEnabled(userId: string, value: boolean | null): void {
  if (value === null) {
    db.delete(userSettings)
      .where(and(eq(userSettings.userId, userId), eq(userSettings.key, USER_MCP_KEY)))
      .run();
    return;
  }
  const now = new Date();
  const scope = and(eq(userSettings.userId, userId), eq(userSettings.key, USER_MCP_KEY));
  db.transaction((tx) => {
    tx.delete(userSettings).where(scope).run();
    tx.insert(userSettings).values({ userId, key: USER_MCP_KEY, value: String(value), updatedAt: now }).run();
  });
}
