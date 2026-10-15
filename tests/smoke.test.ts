import { describe, expect, it } from "vitest";
import { GET as threadsList } from "@/app/api/threads/route";
import { POST as authRoute } from "@/app/api/auth/[...all]/route";
import { adminUser, callRoute, jsonOf, signUp } from "./support/app";

describe("harness smoke", () => {
  it("bootstraps the admin, signs users up, guards routes", async () => {
    const admin = await adminUser();
    expect(admin.userId).toBeTruthy();

    const user = await signUp("smoke");
    const ok = await callRoute(threadsList, { cookie: user.cookie });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ threads: [] });

    const anon = await callRoute(threadsList);
    expect(anon.status).toBe(401);
  });

  it("serves better-auth get-session through the catch-all route", async () => {
    const user = await signUp("auth");
    const res = await callRoute(authRoute, { path: "/api/auth/get-session", cookie: user.cookie });
    const body = await jsonOf<{ user: { username: string } }>(res);
    expect(body.user.username).toBe(user.username);
  });
});
