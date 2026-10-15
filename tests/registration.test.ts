import { describe, expect, it } from "vitest";
import * as adminSettings from "@/app/api/admin/settings/route";
import { All } from "@/app/api/auth/[...all]/route";
import { ensureReady } from "@/lib/db";
import { seedBootstrapAdmin } from "@/lib/db/bootstrap";
import { settings, user } from "@/lib/db/schema";
import { invalidateSettingsCache } from "@/lib/settings";
import { eq } from "drizzle-orm";
import { adminUser, callRoute, jsonOf, PASSWORD, signUp, type RouteHandler } from "./support/app";
import { db, setSetting } from "./support/db";

const authRoute = All as RouteHandler;

function attemptSignUp(username: string) {
  return callRoute(authRoute, {
    method: "POST",
    path: "/api/auth/sign-up/email",
    json: { name: username, email: `${username}@example.test`, password: PASSWORD, username },
  });
}

describe("registration kill-switch (auth.allowRegistration)", () => {
  it("blocks public sign-up when disabled, restores on re-enable", async () => {
    await ensureReady();
    setSetting("auth.allowRegistration", "false");
    const blocked = await attemptSignUp("regblocked");
    expect(blocked.status).toBe(403);
    const body = await jsonOf<{ message: string; code?: string }>(blocked);
    expect(body.message).toMatch(/disabled/i);

    setSetting("auth.allowRegistration", "true");
    const ok = await attemptSignUp("regallowed");
    expect(ok.status).toBe(200);
    const user = await signUp("regafterallow");
    expect(user.cookie).toBeTruthy();
  });

  it("never blocks the bootstrap path: empty users table bypasses the kill-switch", async () => {
    await ensureReady();
    setSetting("auth.allowRegistration", "false");
    db.delete(user).run();
    // Bootstrap seed (signUpEmail with zero users) must still succeed…
    await seedBootstrapAdmin();
    expect(db.select({ id: user.id }).from(user).all()).toHaveLength(1);
    // …while public sign-up is blocked again once a user exists.
    const blocked = await attemptSignUp("regbypass");
    expect(blocked.status).toBe(403);
    setSetting("auth.allowRegistration", "true");
  });

  it("existing users can still sign in while registration is disabled", async () => {
    const admin = await adminUser();
    setSetting("auth.allowRegistration", "false");
    const res = await callRoute(authRoute, {
      method: "POST",
      path: "/api/auth/sign-in/email",
      json: { email: admin.email, password: admin.password },
    });
    expect(res.ok).toBe(true);
    setSetting("auth.allowRegistration", "true");
  });

  it("admin settings route exposes, persists and validates the bool", async () => {
    const admin = await adminUser();
    db.delete(settings).where(eq(settings.key, "auth.allowRegistration")).run();
    invalidateSettingsCache();
    const unset = await jsonOf<{ values: Record<string, unknown> }>(
      await callRoute(adminSettings.GET, { cookie: admin.cookie })
    );
    expect(unset.values["auth.allowRegistration"]).toBeNull();

    const off = await jsonOf<{ values: Record<string, unknown> }>(
      await callRoute(adminSettings.POST, {
        method: "POST",
        path: "/s",
        cookie: admin.cookie,
        json: { "auth.allowRegistration": false },
      })
    );
    expect(off.values["auth.allowRegistration"]).toBe(false);

    const bad = await callRoute(adminSettings.POST, {
      method: "POST",
      path: "/s",
      cookie: admin.cookie,
      json: { "auth.allowRegistration": "nope" },
    });
    expect(bad.status).toBe(400);

    await callRoute(adminSettings.POST, {
      method: "POST",
      path: "/s",
      cookie: admin.cookie,
      json: { "auth.allowRegistration": true },
    });
  });
});
