// Basic app-level rate limiting (security review P3).
//
// Design stance: this is a coarse backstop only — a hardened deployment
// enforces rate limits at the reverse proxy. Everything is env-var
// configurable and can be disabled ENTIRELY with YASHA_RATE_LIMIT=off
// (checked per request, so flipping the env + restart turns it off).
//
// Identity: authenticated session user id when a valid session exists,
// else the x-forwarded-for client IP (trust the proxy: bind the app to the
// proxy only), else "anon". Fixed windows, in-memory per process (single
// replica by design). Over the limit → 429 + Retry-After.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export type RateKind = "api" | "auth" | "heavy" | "write";

type BucketCfg = { limit: number; windowMs: number };

type Env = Record<string, string | undefined>;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

function cfgFor(env: Env, kind: RateKind): BucketCfg {
  if (kind === "auth") {
    return { limit: positiveInt(env.RATE_LIMIT_AUTH_PER_MIN, 30), windowMs: 60_000 };
  }
  if (kind === "heavy") {
    return {
      limit: positiveInt(env.RATE_LIMIT_HEAVY_PER_MIN, 30),
      windowMs: positiveInt(env.RATE_LIMIT_HEAVY_WINDOW_MS, 60_000),
    };
  }
  if (kind === "write") {
    return { limit: positiveInt(env.RATE_LIMIT_WRITE_PER_MIN, 60), windowMs: 60_000 };
  }
  return { limit: positiveInt(env.RATE_LIMIT_API_PER_MIN, 300), windowMs: 60_000 };
}

export function rateLimitEnabled(env: Env = process.env): boolean {
  return env.YASHA_RATE_LIMIT !== "off";
}

const windows = new Map<string, { start: number; count: number }>();
let lastSweep = 0;

function sweep(now: number, windowMs: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of windows) {
    if (now - bucket.start >= windowMs) windows.delete(key);
  }
}

function tooMany(key: string, cfg: BucketCfg, now: number): number {
  sweep(now, cfg.windowMs);
  const bucket = windows.get(key);
  if (!bucket || now - bucket.start >= cfg.windowMs) {
    windows.set(key, { start: now, count: 1 });
    return 0;
  }
  bucket.count += 1;
  if (bucket.count <= cfg.limit) return 0;
  return Math.max(1, Math.ceil((bucket.start + cfg.windowMs - now) / 1000));
}

async function identity(req: Request): Promise<string> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (session?.user.id) return `u:${session.user.id}`;
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0]!.trim() : "";
  return ip ? `ip:${ip}` : "anon";
}

/**
 * Returns a 429 response when the caller is over the bucket's budget,
 * else null (request proceeds). Fail-open on internal errors.
 */
export async function rateLimit(
  req: Request,
  kind: RateKind,
  env: Env = process.env
): Promise<NextResponse | null> {
  if (!rateLimitEnabled(env)) return null;
  const cfg = cfgFor(env, kind);
  let key: string;
  try {
    key = await identity(req);
  } catch {
    return null;
  }
  const retryAfter = tooMany(`${kind}|${key}`, cfg, Date.now());
  if (retryAfter === 0) return null;
  return NextResponse.json(
    { error: "rate_limited", message: "Too many requests; slow down." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}
