import { beforeAll, describe, expect, it } from "vitest";
import { user } from "@/lib/db/schema";
import { seedBootstrapAdmin } from "@/lib/db/bootstrap";
import { ensureReady, userCount } from "@/lib/db";
import { callRoute, signUp } from "./support/app";
import { GET as threadsList } from "@/app/api/threads/route";
import { db, rawSqlite } from "./support/db";

// In THIS file the bootstrap env is absent at first ensureReady(), so no admin
// is seeded (the happy-path seed runs in every other file — see setup.ts).
const savedUser = process.env.BOOTSTRAP_ADMIN_USERNAME;
const savedPass = process.env.BOOTSTRAP_ADMIN_PASSWORD;

beforeAll(async () => {
  delete process.env.BOOTSTRAP_ADMIN_USERNAME;
  await ensureReady();
});

describe("bootstrap admin seeding", () => {
  it("does not seed without BOOTSTRAP_ADMIN_* env", async () => {
    expect(db.select().from(user).all().some((u) => u.role === "admin")).toBe(false);
    expect(userCount()).toBe(0);
    // routes still work; users can register
    const u = await signUp("boot");
    expect((await callRoute(threadsList, { cookie: u.cookie })).status).toBe(200);
    // even with the password set, a missing username short-circuits
    process.env.BOOTSTRAP_ADMIN_PASSWORD = savedPass;
    await seedBootstrapAdmin();
    expect(db.select().from(user).all().some((x) => x.role === "admin")).toBe(false);
    process.env.BOOTSTRAP_ADMIN_USERNAME = savedUser;
  });

  it("never touches an existing user base", async () => {
    const before = userCount();
    await seedBootstrapAdmin();
    expect(userCount()).toBe(before);
    expect(db.select().from(user).all().some((u) => u.role === "admin")).toBe(false);
  });
});

describe("instrumentation.register", () => {
  it("prepares DB + skips the worker off the node runtime and on edge", async () => {
    const { register } = await import("@/instrumentation");
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(globalThis.__yashaWorker).toBeUndefined();

    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.NEXT_PHASE; // opt in to a real worker start for this case
    await register();
    // migrations applied → settings table queryable
    rawSqlite.prepare("select 1 from settings").get();
    // Worker starts under the nodejs runtime (globalThis singleton + interval).
    expect(globalThis.__yashaWorker?.interval).toBeDefined();
    delete process.env.NEXT_RUNTIME;
  });
});
