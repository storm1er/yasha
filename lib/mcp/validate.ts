// Shared MCP server CRUD validation (admin + user routes).

import { randomBytes } from "node:crypto";

// SSRF stance: private/LAN targets are ALLOWED for admin rows by default
// (self-hosted LAN MCP servers are the point); MCP_ALLOW_PRIVATE_URLS=false
// blocks RFC1918 / loopback / link-local / unique-local literal hosts (best
// effort: literal addresses only, no DNS resolution — documented). User-owned
// rows always block private hosts (`blockPrivate`).
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./];

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "[::1]") return true;
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(h)) return true;
  return PRIVATE_V4.some((re) => re.test(h));
}

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function validateHeaders(raw: unknown): string | null | { error: string } {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid_headers" };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 20) return { error: "invalid_headers" };
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string" || !HEADER_NAME_RE.test(k) || v.length > 1000) {
      return { error: "invalid_headers" };
    }
    out[k] = v;
  }
  return JSON.stringify(out);
}

/**
 * update-action headers patch: a string value upserts the header, null
 * deletes it. Merge-patch semantics (the GET response only ever shows masked
 * values, so a full-replace payload could never round-trip the untouched
 * secrets).
 */
export function validateHeadersPatch(raw: unknown): Record<string, string | null> | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid_headers" };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 20) return { error: "invalid_headers" };
  const out: Record<string, string | null> = {};
  for (const [k, v] of entries) {
    if (!HEADER_NAME_RE.test(k)) return { error: "invalid_headers" };
    if (v === null) out[k] = null;
    else if (typeof v === "string" && v.length <= 1000) out[k] = v;
    else return { error: "invalid_headers" };
  }
  return out;
}

/** Lenient parse of a stored headers_json blob (garbage/non-object → {}). */
export function parseHeaders(headersJson: string | null): Record<string, string> {
  if (!headersJson) return {};
  try {
    const parsed: unknown = JSON.parse(headersJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function validateUrl(raw: unknown, blockPrivate = false): string | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "invalid_url" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "invalid_url" };
  const envBlocks = process.env.MCP_ALLOW_PRIVATE_URLS === "false";
  if ((blockPrivate || envBlocks) && isPrivateHost(url.hostname)) {
    return { error: "private_url_blocked" };
  }
  return url.toString();
}

export function validateDisabledTools(raw: unknown): string | null | { error: string } {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > 200 || raw.some((t) => typeof t !== "string" || !t || t.length > 200)) {
    return { error: "invalid_disabled_tools" };
  }
  return raw.length ? JSON.stringify(raw) : null;
}

export function slugId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "server";
  return `${base}-${randomBytes(4).toString("hex")}`;
}

export function maskHeaders(headersJson: string | null): Record<string, string> | null {
  if (!headersJson) return null;
  try {
    const parsed: unknown = JSON.parse(headersJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const k of Object.keys(parsed as Record<string, unknown>)) out[k] = "••••";
    return out;
  } catch {
    return null;
  }
}
