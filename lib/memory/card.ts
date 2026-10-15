// User-card store: a typed, stability-filtered identity profile built by the
// dreaming handler, injected by recall. Lives in user_settings so it needs no
// migration; worker-free so the chat/recall paths never pull the worker graph.
//
// MEMORY-ENHANCEMENT-PLAN P4: entries are prefixed `identity:` | `attribute:` |
// `relationship:` | `rule:` (one fact per entry); behavioral traits never
// belong here (they live as insight memories). Invalid prefixes are dropped in
// code. Legacy `{ text }` rows keep rendering until the next dream migrates
// them (lazy migration).

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userSettings } from "@/lib/db/schema";
import type { JobTx } from "@/lib/jobs/worker";

const CARD_KEY = "memory.userCard";

export const CARD_ENTRY_PREFIXES = ["identity", "attribute", "relationship", "rule"] as const;
const MAX_ENTRIES = 40;
const ENTRY_MAX_CHARS = 160;

/** `entries` = null for legacy prose cards (pre-P4 `{ text }` rows). */
export type UserCard = { text: string; entries: string[] | null; version: number; updatedAt: string };

/** Keep only `prefix:…` entries with a known prefix; dedupe, cap, truncate. */
export function parseCardEntries(items: unknown[]): string[] {
  const out: string[] = [];
  for (const item of items.slice(0, MAX_ENTRIES)) {
    if (typeof item !== "string") continue;
    const entry = item.trim().slice(0, ENTRY_MAX_CHARS);
    const prefix = entry.split(":")[0].trim().toLowerCase();
    if (!(CARD_ENTRY_PREFIXES as readonly string[]).includes(prefix)) continue;
    if (entry.length <= prefix.length + 1) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
  }
  return out.slice(0, MAX_ENTRIES);
}

export function getMemoryCard(userId: string): UserCard | null {
  const row = db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, userId), eq(userSettings.key, CARD_KEY)))
    .get();
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<UserCard> & { text?: unknown };
    const version = typeof v.version === "number" ? v.version : 0;
    const updatedAt = typeof v.updatedAt === "string" ? v.updatedAt : "";
    if (Array.isArray(v.entries)) {
      const entries = parseCardEntries(v.entries);
      if (entries.length === 0) return null;
      return { text: entries.join("\n"), entries, version, updatedAt };
    }
    if (typeof v.text === "string" && v.text.trim()) {
      return { text: v.text.trim(), entries: null, version, updatedAt };
    }
    return null;
  } catch {
    return null;
  }
}

export function setMemoryCardTx(
  executor: JobTx | typeof db,
  userId: string,
  card: { entries: string[]; version: number; updatedAt: string }
): void {
  const value = JSON.stringify(card);
  const existing = executor
    .select({ userId: userSettings.userId })
    .from(userSettings)
    .where(and(eq(userSettings.userId, userId), eq(userSettings.key, CARD_KEY)))
    .get();
  if (existing) {
    executor
      .update(userSettings)
      .set({ value, updatedAt: new Date() })
      .where(and(eq(userSettings.userId, userId), eq(userSettings.key, CARD_KEY)))
      .run();
  } else {
    executor
      .insert(userSettings)
      .values({ userId, key: CARD_KEY, value, updatedAt: new Date() })
      .run();
  }
}
