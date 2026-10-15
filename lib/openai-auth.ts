import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { API_KEY_PREFIX, hashApiKey } from "@/lib/api-keys";

/** Caller identity resolved from a `ysk_` API key (NOT the session cookie). */
export type OpenAiCaller = { userId: string; keyId: string };

/** OpenAI-style error envelope shared by all /v1 routes. */
export function openAiError(
  status: number,
  message: string,
  type: string,
  code: string
): NextResponse {
  return NextResponse.json({ error: { message, type, code } }, { status });
}

export function invalidApiKeyResponse(): NextResponse {
  return openAiError(
    401,
    "Incorrect API key provided. Create one at /settings and pass it as 'Authorization: Bearer ysk_...'.",
    "authentication_error",
    "invalid_api_key"
  );
}

/**
 * Reads `Authorization: Bearer ysk_...`, hashes it (SHA-256) and resolves the
 * matching *active* api_keys row. Returns null on missing/malformed/revoked
 * or unknown keys; callers answer with invalidApiKeyResponse().
 */
export async function authenticateApiKey(req: Request): Promise<OpenAiCaller | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const key = match?.[1];
  if (!key || !key.startsWith(API_KEY_PREFIX)) return null;
  const row = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
    .limit(1)
    .get();
  return row ? { userId: row.userId, keyId: row.id } : null;
}
