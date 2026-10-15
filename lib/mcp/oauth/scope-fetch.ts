// Fetch wrapper that keeps OAuth sessions alive with authorization servers
// (e.g. better-auth-based ones like mcp.arctracker.io) that only issue
// refresh tokens when the grant includes `offline_access`. Such servers often
// advertise `offline_access` in the AS metadata but omit it from the scope
// they advertise to clients (401 `WWW-Authenticate: scope=` and the
// protected-resource `scopes_supported`) — and the MCP SDK takes the
// requested scope from those, so the refresh token is never granted and the
// session dies at first expiry. We supplement both spots, and only when the
// AS actually supports the scope (servers that don't are untouched).

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const PRM_PATH = "/.well-known/oauth-protected-resource";
const OFFLINE_ACCESS = "offline_access";
const AS_SUPPORT_TTL_MS = 10 * 60_000;

type PrmDoc = { scopes_supported?: unknown; authorization_servers?: unknown };

const supportCache = new Map<string, { ok: boolean; at: number }>();

async function asSupportsOfflineAccess(servers: unknown, fetchImpl: typeof fetch): Promise<boolean> {
  if (!Array.isArray(servers)) return false;
  for (const as of servers) {
    if (typeof as !== "string" || !/^https?:\/\//.test(as)) continue;
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      try {
        const res = await fetchImpl(`${as.replace(/\/+$/, "")}${path}`);
        if (!res.ok) continue;
        const meta = (await res.json()) as { scopes_supported?: unknown };
        if (Array.isArray(meta.scopes_supported) && meta.scopes_supported.includes(OFFLINE_ACCESS)) return true;
      } catch {
        // AS metadata unreachable — treat as unsupported.
      }
    }
  }
  return false;
}

/** Memoized probe: does the AS behind this protected-resource metadata doc
 * support `offline_access`? */
async function offlineSupported(prmUrl: string, fetchImpl: typeof fetch, now = Date.now()): Promise<boolean> {
  const hit = supportCache.get(prmUrl);
  if (hit && now - hit.at < AS_SUPPORT_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const res = await fetchImpl(prmUrl);
    if (res.ok) {
      const prm = (await res.json()) as PrmDoc;
      if (prm && typeof prm === "object" && Array.isArray(prm.scopes_supported)) {
        ok = await asSupportsOfflineAccess(prm.authorization_servers, fetchImpl);
      }
    }
  } catch {
    ok = false;
  }
  supportCache.set(prmUrl, { ok, at: now });
  return ok;
}

function extractHeaderField(header: string, field: string): string | undefined {
  const m = header.match(new RegExp(`${field}="([^"]*)"`));
  return m?.[1];
}

/** Wrap `fetch` so OAuth discovery and the 401 scope hint include
 * `offline_access` whenever the authorization server supports it. */
export function oauthScopeAwareFetch(fetchImpl: typeof fetch = fetch): FetchLike {
  return async (input, init) => {
    const res = await fetchImpl(input as string | URL, init);
    const url = input instanceof URL ? input.href : input;
    if (!res.ok) return supplementWwwAuthScope(res, fetchImpl);

    // PRM discovery document: append offline_access to scopes_supported.
    if (!url.includes(PRM_PATH)) return res;
    let prm: PrmDoc;
    try {
      prm = (await res.clone().json()) as PrmDoc;
    } catch {
      return res;
    }
    if (
      !prm ||
      typeof prm !== "object" ||
      !Array.isArray(prm.scopes_supported) ||
      (prm.scopes_supported as string[]).includes(OFFLINE_ACCESS)
    ) {
      return res;
    }
    if (!(await offlineSupported(url, fetchImpl))) return res;
    const patched = { ...prm, scopes_supported: [...(prm.scopes_supported as string[]), OFFLINE_ACCESS] };
    return new Response(JSON.stringify(patched), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/** 401 responses: if `WWW-Authenticate` carries a `scope="…"` missing
 * offline_access but the AS supports it, rewrite the header with the extra
 * scope (the SDK prefers this hint over PRM discovery). */
async function supplementWwwAuthScope(res: Response, fetchImpl: typeof fetch): Promise<Response> {
  const wwwAuth = res.headers.get("www-authenticate");
  if (!wwwAuth || !/^bearer/i.test(wwwAuth)) return res;
  const scope = extractHeaderField(wwwAuth, "scope");
  if (!scope || scope.split(/\s+/).includes(OFFLINE_ACCESS)) return res;
  const prmUrl = extractHeaderField(wwwAuth, "resource_metadata");
  if (!prmUrl) return res;
  if (!(await offlineSupported(prmUrl, fetchImpl))) return res;
  const headers = new Headers(res.headers);
  headers.set("www-authenticate", wwwAuth.replace(`scope="${scope}"`, `scope="${scope} ${OFFLINE_ACCESS}"`));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
