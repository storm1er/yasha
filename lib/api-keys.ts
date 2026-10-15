import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";

export const API_KEY_PREFIX = "ysk_";
export const MAX_ACTIVE_API_KEYS = 20;

export type ApiKeyRecord = {
  id: string;
  name: string;
  masked: string;
  createdAt: string;
  revokedAt: string | null;
};

/** SHA-256 hex digest of a full API key. Only this digest is ever persisted. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function maskFromLast4(last4: string): string {
  return `****${last4}`;
}

/**
 * Creates a new API key: `ysk_` + 32 hex chars. The full key is returned
 * exactly once here; only its SHA-256 digest is stored.
 */
export async function createKey(
  userId: string,
  name: string
): Promise<{ id: string; name: string; key: string; createdAt: string }> {
  const active =
    db
      .select({ value: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .get()?.value ?? 0;
  if (active >= MAX_ACTIVE_API_KEYS) {
    throw new Error("key_limit_reached");
  }

  const key = `${API_KEY_PREFIX}${randomBytes(16).toString("hex")}`;
  const createdAt = new Date();
  const id = randomUUID();
  await db.insert(apiKeys).values({
    id,
    userId,
    name,
    keyHash: hashApiKey(key),
    last4: key.slice(-4),
    createdAt,
  });
  return { id, name, key, createdAt: createdAt.toISOString() };
}

export async function listKeys(userId: string): Promise<ApiKeyRecord[]> {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      last4: apiKeys.last4,
      createdAt: apiKeys.createdAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(apiKeys.createdAt);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    masked: maskFromLast4(r.last4),
    createdAt: r.createdAt.toISOString(),
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  }));
}

/** Soft revoke: stamps revokedAt, keeps the row (and its hash) for audit. */
export async function revokeKey(id: string, userId: string): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .run();
  return (result.changes ?? 0) > 0;
}

/** Look up the owning user id for a presented full key (active keys only). */
export async function resolveKeyOwner(key: string): Promise<string | null> {
  const rows = await db
    .select({ userId: apiKeys.userId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
    .limit(1);
  return rows[0]?.userId ?? null;
}
