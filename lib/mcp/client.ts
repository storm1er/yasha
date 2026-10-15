// MCP connection manager: lazy connect, one client per server, idle-close.
// Transport creation is an injectable seam (tests use InMemoryTransport pairs).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpToolTimeoutMs } from "@/lib/settings";
import { hasOauthRow, oauthStatus } from "./oauth/store";
import { oauthProvider } from "./oauth/provider";
import { oauthScopeAwareFetch } from "./oauth/scope-fetch";
import { ensureFreshToken } from "./oauth/refresh";

export const KETCH_SERVER_ID = "ketch";
/** Writable HOME for the ketch child (config/cache/tags) — `./data` volume.
 * Never an image-wide $HOME: the APK debug keystore lives in the app user's
 * real $HOME and rotating it would flip assistant-role holders (AGENTS.md). */
export const KETCH_HOME = "/data/ketch";
const IDLE_MS = 60_000;

export type McpTransportServer = {
  id: string;
  url: string | null;
  headersJson: string | null;
  /** Force the OAuth provider for this connect (admin connect action; see
   * registry.serverCatalog). Without it the provider attaches only when saved
   * tokens exist, so chat turns never clobber a pending admin flow. */
  oauth?: boolean;
};

export type TransportFactory = (server: McpTransportServer) => Transport;

function ketchEnv(): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment(), HOME: KETCH_HOME };
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("KETCH_") && v !== undefined) env[k] = v;
  }
  return env;
}

export function defaultTransport(server: McpTransportServer): Transport {
  if (server.id === KETCH_SERVER_ID && !server.url) {
    return new StdioClientTransport({
      command: "ketch",
      args: ["mcp", "serve"],
      env: ketchEnv(),
    });
  }
  if (!server.url) throw new Error(`server ${server.id} has no url`);
  const headers: Record<string, string> = {};
  if (server.headersJson) {
    const parsed: unknown = JSON.parse(server.headersJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
  }
  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers },
    // OAuth attaches only when saved tokens exist (refresh) or the admin
    // connect action forces it — chat turns never clobber a pending flow.
    // Static headers still win (requestInit headers override the bearer).
    authProvider: server.oauth === true || oauthStatus(server.id).authorized ? oauthProvider(server.id) : undefined,
    // PRM discovery goes through the scope-aware wrapper (offline_access
    // supplement keeps refresh tokens flowing on better-auth ASes).
    fetch: oauthScopeAwareFetch(),
  });
}

/** True when a connect attempt stopped at "authorization needed" (the SDK
 * threw after capturing the authorization URL on the OAuth provider). */
export function isNeedsAuthError(err: unknown): boolean {
  return err instanceof UnauthorizedError;
}

let transportFactory: TransportFactory = defaultTransport;
export function setTransportFactory(factory: TransportFactory | null): void {
  transportFactory = factory ?? defaultTransport;
}

type Conn = { client: Client; lastUsed: number };
const conns = new Map<string, Conn>();

function closeConn(id: string): void {
  const conn = conns.get(id);
  conns.delete(id);
  void conn?.client.close().catch(() => undefined);
}

/** Close connections idle for more than `maxIdleMs` (swept on every acquire). */
export function closeIdleClients(maxIdleMs = IDLE_MS, now = Date.now()): void {
  for (const [id, conn] of [...conns]) {
    if (now - conn.lastUsed >= maxIdleMs) closeConn(id);
  }
}

export function closeAllClients(): void {
  for (const [id] of [...conns]) closeConn(id);
}

let exitHooksInstalled = false;
/** Kill stdio children when the server process exits (called once from
 * instrumentation, so tests keep control over the target emitter). */
export function installExitHooks(target: NodeJS.Process = process): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  target.once("exit", () => closeAllClients());
}

/** One client per server, connected lazily; crashed/closed entries respawn. */
export async function getClient(server: McpTransportServer, signal?: AbortSignal): Promise<Client> {
  closeIdleClients();
  const existing = conns.get(server.id);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.client;
  }
  // Refresh an expiring access token before connecting: the SDK only reacts to
  // a 401 and starts a fresh authorization flow when refresh fails, which is
  // what surfaced "authorization_required" after a working session.
  if (hasOauthRow(server.id)) await ensureFreshToken(server.id);
  const client = new Client({ name: "yasha", version: "0.1.0" });
  const connecting = client.connect(transportFactory(server));
  if (signal) {
    await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error("aborted"));
        else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    ]);
  } else {
    await connecting;
  }
  conns.set(server.id, { client, lastUsed: Date.now() });
  return client;
}

/** Drop a server's connection (after errors / config changes). */
export function dropConnection(id: string): void {
  closeConn(id);
}

export async function listTools(server: McpTransportServer): Promise<ListToolsResult> {
  const client = await getClient(server);
  return client.listTools(undefined, { timeout: mcpToolTimeoutMs() });
}

export async function callTool(
  server: McpTransportServer,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const client = await getClient(server, signal);
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: mcpToolTimeoutMs(),
      signal,
    });
    return res as unknown as CallToolResult;
  } catch (err) {
    // Assume the connection may be wedged after a failed call; respawn next time.
    dropConnection(server.id);
    throw err;
  }
}
