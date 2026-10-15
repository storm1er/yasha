import { NextResponse, type NextRequest } from "next/server";
import { ensureReady } from "@/lib/db";
import { dropConnection } from "@/lib/mcp/client";
import { completeAuthorization } from "@/lib/mcp/oauth/provider";
import { clearCredentials, consumePendingByState, saveVerifier } from "@/lib/mcp/oauth/store";
import { invalidateCatalog } from "@/lib/mcp/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OAuth redirect target for the admin AND user "Connect" flows. NOT session-
// gated: it is reached via a cross-site redirect from the authorization
// server; the one-shot, high-entropy `state` (backed by the pending row) is
// what authenticates and binds the request (CSRF protection per OAuth 2.1).

function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title>` +
      `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem;margin:auto">` +
      `<h2>${title}</h2><p>${body}</p><p><button onclick="window.close()">Close this window</button></p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

export async function GET(req: NextRequest) {
  await ensureReady();
  const params = req.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const error = params.get("error");

  const pending = state ? consumePendingByState(state) : undefined;
  if (!pending) {
    return page("Authorization failed", "This authorization request is invalid or has expired. Start again from the MCP settings.", 400);
  }
  // consumePendingByState() already consumed (cleared) the pending row;
  // re-arm just the PKCE verifier for the exchange, then scrub it.
  if (error || !code) {
    return page("Authorization failed", "The authorization was denied or incomplete. You can retry from the MCP settings.", 400);
  }
  // The connect flow always stores a verifier with the pending state.
  saveVerifier(pending.serverId, pending.verifier as string);
  try {
    await completeAuthorization(pending.serverId, pending.serverUrl, code);
  } catch {
    clearCredentials(pending.serverId, "verifier");
    return page("Authorization failed", "The authorization code could not be exchanged. You can retry from the MCP settings.", 502);
  }
  clearCredentials(pending.serverId, "verifier");
  dropConnection(pending.serverId);
  invalidateCatalog(pending.serverId);
  return page("Connected", "You can close this window and return to the MCP settings.", 200);
}
