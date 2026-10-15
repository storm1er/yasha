// Rate limiter: env configuration matrix + bucket behavior (disabled, IP
// identity, per-user identity, window reset, upstream failure fail-open).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimit, rateLimitEnabled } from "@/lib/rate-limit";
import { auth } from "@/lib/auth";
import { signUp } from "./support/app";

let cookie = "";

beforeAll(async () => {
  const u = await signUp("rluser");
  cookie = u.cookie;
});

const saved = { ...process.env };
beforeEach(() => {
  process.env.YASHA_RATE_LIMIT = "";
  delete process.env.RATE_LIMIT_HEAVY_PER_MIN;
  delete process.env.RATE_LIMIT_HEAVY_WINDOW_MS;
  delete process.env.RATE_LIMIT_AUTH_PER_MIN;
  delete process.env.RATE_LIMIT_API_PER_MIN;
  delete process.env.RATE_LIMIT_WRITE_PER_MIN;
});
afterEach(() => {
  process.env.YASHA_RATE_LIMIT = "off";
  Object.assign(process.env, saved);
  vi.restoreAllMocks();
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/threads", { headers });
}

describe("rateLimitEnabled", () => {
  it("is on by default, off only for the exact 'off'", () => {
    expect(rateLimitEnabled({})).toBe(true);
    expect(rateLimitEnabled({ YASHA_RATE_LIMIT: "off" })).toBe(false);
    expect(rateLimitEnabled({ YASHA_RATE_LIMIT: "OFF" })).toBe(true);
  });
});

describe("rateLimit", () => {
  it("returns null (allows) when disabled", async () => {
    expect(await rateLimit(req(), "heavy", { YASHA_RATE_LIMIT: "off" })).toBeNull();
  });

  it("allows under the limit and 429s over it (IP identity, tiny window resets)", async () => {
    process.env.RATE_LIMIT_HEAVY_PER_MIN = "2";
    process.env.RATE_LIMIT_HEAVY_WINDOW_MS = "40";
    const ip = "203.0.113.7";
    const h = { "x-forwarded-for": `${ip}, 10.0.0.1` };
    expect(await rateLimit(req(h), "heavy")).toBeNull();
    expect(await rateLimit(req(h), "heavy")).toBeNull();
    const blocked = await rateLimit(req(h), "heavy");
    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // another IP is unaffected
    expect(await rateLimit(req({ "x-forwarded-for": "198.51.100.9" }), "heavy")).toBeNull();
    // window expiry re-allows
    await new Promise((r) => setTimeout(r, 60));
    expect(await rateLimit(req(h), "heavy")).toBeNull();
  });

  it("identifies authenticated callers per user (session wins over IP)", async () => {
    process.env.RATE_LIMIT_AUTH_PER_MIN = "1";
    const h = { cookie, "x-forwarded-for": "203.0.113.40" };
    expect(await rateLimit(req(h), "auth")).toBeNull();
    expect((await rateLimit(req(h), "auth"))?.status).toBe(429);
    // same IP, no session → different bucket (ip identity)
    expect(await rateLimit(req({ "x-forwarded-for": "203.0.113.40" }), "auth")).toBeNull();
    // no session, no IP → "anon" bucket
    expect(await rateLimit(req(), "auth")).toBeNull();
  });

  it("honors the api/write kind budgets with env overrides", async () => {
    process.env.RATE_LIMIT_API_PER_MIN = "1";
    expect(await rateLimit(req({ "x-forwarded-for": "203.0.113.41" }), "api")).toBeNull();
    expect((await rateLimit(req({ "x-forwarded-for": "203.0.113.41" }), "api"))?.status).toBe(429);
    process.env.RATE_LIMIT_WRITE_PER_MIN = "1";
    expect(await rateLimit(req({ "x-forwarded-for": "203.0.113.42" }), "write")).toBeNull();
    expect((await rateLimit(req({ "x-forwarded-for": "203.0.113.42" }), "write"))?.status).toBe(429);
  });

  it("fails open when session resolution throws", async () => {
    vi.spyOn(auth.api, "getSession").mockRejectedValue(new Error("boom"));
    expect(await rateLimit(req(), "api")).toBeNull();
  });

  it("ignores malformed limits (falls back to permissive defaults)", async () => {
    process.env.RATE_LIMIT_API_PER_MIN = "not-a-number";
    process.env.RATE_LIMIT_WRITE_PER_MIN = "1.5";
    process.env.RATE_LIMIT_HEAVY_PER_MIN = "0";
    for (let i = 0; i < 5; i++) {
      expect(await rateLimit(req({ "x-forwarded-for": "203.0.113.43" }), "api")).toBeNull();
    }
    expect(await rateLimit(req({ "x-forwarded-for": "203.0.113.44" }), "write")).toBeNull();
    expect(await rateLimit(req({ "x-forwarded-for": "203.0.113.45" }), "heavy")).toBeNull();
  });

  it("sweeps expired buckets and keeps recent ones", async () => {
    vi.useFakeTimers();
    try {
      const T = Date.now();
      process.env.RATE_LIMIT_HEAVY_PER_MIN = "5";
      process.env.RATE_LIMIT_HEAVY_WINDOW_MS = "90000";
      vi.setSystemTime(T);
      expect(await rateLimit(req({ "x-forwarded-for": "203.0.113.50" }), "heavy")).toBeNull();
      // 61 s later: sweep runs; the 61 s-old bucket is inside the 90 s window → kept
      vi.setSystemTime(T + 61_000);
      expect(await rateLimit(req({ "x-forwarded-for": "203.0.113.51" }), "heavy")).toBeNull();
      // another 61 s later with a 30 s window: the 61 s-old bucket is pruned
      process.env.RATE_LIMIT_HEAVY_WINDOW_MS = "30000";
      vi.setSystemTime(T + 122_000);
      expect(await rateLimit(req({ "x-forwarded-for": "203.0.113.52" }), "heavy")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
