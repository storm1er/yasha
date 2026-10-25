// Shared validation + API masking for the Backend tab's provider CRUD
// (docs/provider-plan.md M3). Pure helpers: routes own the DB writes.

import type { Provider } from "@/lib/db/schema";
import { PROVIDER_TYPES, type ProviderType } from "./types";

/** Slug ids only — `:` is reserved as the canonical-id separator (Q6). */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validProviderId(v: unknown): v is string {
  return typeof v === "string" && PROVIDER_ID_RE.test(v);
}

export function validProviderType(v: unknown): v is ProviderType {
  return typeof v === "string" && (PROVIDER_TYPES as readonly string[]).includes(v);
}

export function validLabel(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 80;
}

/** http(s) URL without query/hash; trailing slashes trimmed. null = invalid. */
export function normalizeBaseUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\/+$/, "");
  if (!s || s.length > 200) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.search || u.hash) return null;
    return s;
  } catch {
    return null;
  }
}

/** null clears the key; a string (trimmed, bounded) sets it. */
export function validApiKey(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && v.trim().length <= 400);
}

/** API projection of a provider row — the secret is never returned, only `hasKey`. */
export function providerRowJson(row: Provider) {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    baseUrl: row.baseUrl,
    // Routes normalize empty/whitespace keys to null on write, so a stored
    // empty string cannot happen.
    hasKey: row.apiKey !== null,
    enabled: row.enabled,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}
