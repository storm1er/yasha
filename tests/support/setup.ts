// Runs in every test-file worker BEFORE app modules are imported (env vars are
// read at module load by lib/db, lib/auth, lib/lemonade-stream).
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

process.env.DATABASE_PATH = join(
  process.env.YASHA_TEST_DB_DIR ?? "/tmp",
  `${randomUUID()}.db`
);
process.env.APP_NAME = "Yasha Tests";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.BETTER_AUTH_TRUSTED_ORIGINS = "";
process.env.BETTER_AUTH_SECRET = "integration-test-secret-not-a-real-one-0123456789";
// Lemonade base points at an unroutable host; the fetch layer is stubbed in
// beforeEach anyway, so no test can ever reach a real instance.
process.env.LEMONADE_BASE_URL = "http://lemonade.invalid.test";
delete process.env.LEMONADE_API_KEY;
delete process.env.ADMIN_ALLOW_MUTATIONS;
// Rate limiter off by default for suites; tests/rate-limit.test.ts re-enables
// it per-test (env is read per request, not at import).
process.env.YASHA_RATE_LIMIT = "off";
// Worker isolation: the production-build phase makes startWorker() return early,
// so route-driven ensureWorker() never spins a claim interval in these suites
// (enqueued rows stay visible for assertions). Worker suites (jobs-worker,
// bootstrap) delete NEXT_PHASE when they drive the worker directly.
process.env.NEXT_PHASE = "phase-production-build";
delete process.env.NEXT_RUNTIME;
// Deterministic bootstrap admin seeded by ensureReady() in every test DB.
process.env.BOOTSTRAP_ADMIN_USERNAME = "troot_admin";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "bootstrap-pass-123";

/** Fetches attempted while no Lemonade mock was installed. */
const violations: string[] = [];

function guardFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    violations.push(url);
    throw new Error(`fetch to ${url} blocked: install a Lemonade mock (tests/support/lemonade.ts)`);
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  violations.length = 0;
  vi.stubGlobal("fetch", guardFetch());
});

afterEach(() => {
  if (violations.length > 0) {
    throw new Error(`un-mocked Lemonade fetch attempts: ${violations.join(", ")}`);
  }
  vi.unstubAllGlobals();
});
