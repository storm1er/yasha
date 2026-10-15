// Route-dispatch + session helpers. Routes are invoked exactly as Next would
// call them (real NextRequest in, real Response out); session cookies come
// from the real better-auth handler at /api/auth/[...all].

import { NextRequest } from "next/server";
import { setCurrentHeaders } from "./request-context";

export const BASE = "http://localhost:3000";

export type RouteHandler = (
  req: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx?: any
) => Promise<Response> | Response;

export type CallOpts = {
  method?: string;
  path?: string;
  query?: Record<string, string | number>;
  json?: unknown;
  body?: BodyInit;
  cookie?: string | null;
  origin?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export function makeRequest(opts: CallOpts = {}): NextRequest {
  const url = new URL(opts.path ?? "/", BASE);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, String(v));
  }
  const headers = new Headers(opts.headers);
  headers.set("origin", opts.origin ?? BASE);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  const hasBody = opts.json !== undefined || opts.body !== undefined;
  if (opts.json !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new NextRequest(url, {
    method: opts.method ?? (hasBody ? "POST" : "GET"),
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
    signal: opts.signal,
  });
}

export async function callRoute(handler: RouteHandler, opts: CallOpts = {}, ctx?: unknown): Promise<Response> {
  const req = makeRequest(opts);
  setCurrentHeaders(req.headers);
  return handler(req, ctx);
}

export async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ── sessions ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthRoute = (req: NextRequest) => Promise<Response>;
let authRoute: AuthRoute | null = null;

async function authHandler(): Promise<AuthRoute> {
  if (!authRoute) {
    const mod = await import("@/app/api/auth/[...all]/route");
    authRoute = mod.All as AuthRoute;
  }
  return authRoute;
}

function extractCookie(res: Response): string | null {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const pair = c.split(";")[0];
    if (pair.startsWith("better-auth.session_token=")) return pair;
  }
  return null;
}

export const PASSWORD = "test-password-123";
let seq = 0;

export type TestUser = { username: string; email: string; password: string; cookie: string };

/** Creates + signs in a user through the real /api/auth handler (autoSignIn). */
export async function signUp(label = "user"): Promise<TestUser> {
  seq += 1;
  const username = `t9_${label}_${seq}_${Date.now().toString(36)}`.slice(0, 30);
  const email = `${username}@example.test`;
  const handler = await authHandler();
  const res = await callRoute(handler, {
    method: "POST",
    path: "/api/auth/sign-up/email",
    json: { name: `Test ${username}`, email, password: PASSWORD, username },
  });
  const cookie = extractCookie(res);
  if (!res.ok || !cookie) {
    throw new Error(`sign-up failed (${res.status}): ${await res.text()}`);
  }
  return { username, email, password: PASSWORD, cookie };
}

export async function signIn(email: string, password: string): Promise<string> {
  const handler = await authHandler();
  const res = await callRoute(handler, {
    method: "POST",
    path: "/api/auth/sign-in/email",
    json: { email, password },
  });
  const cookie = extractCookie(res);
  if (!res.ok || !cookie) {
    throw new Error(`sign-in failed (${res.status}): ${await res.text()}`);
  }
  return cookie;
}

export type AdminUser = { email: string; password: string; cookie: string; userId: string };

/** Bootstrap admin created by ensureReady() from the BOOTSTRAP_ADMIN_* test env. */
export async function adminUser(): Promise<AdminUser> {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME ?? "";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
  const cookie = await signIn(`${username}@yasha.admin`, password);
  const userId = await sessionId(cookie);
  return { email: `${username}@yasha.admin`, password, cookie, userId };
}

export async function sessionId(cookie: string): Promise<string> {
  const handler = await authHandler();
  const res = await callRoute(handler, { path: "/api/auth/get-session", cookie });
  const body = (await res.json()) as { session?: { userId?: string } } | null;
  const id = body?.session?.userId;
  if (!id) throw new Error(`no session for cookie (${res.status})`);
  return id;
}

/** Reads the SSE body fully and returns the parsed `data:` JSON payloads. */
export async function readSse(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((p) => p.length > 0)
    .map((p) => (p === "[DONE]" ? p : JSON.parse(p)));
}

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
