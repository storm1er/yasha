import { describe, expect, it } from "vitest";
import { All, GET, POST } from "@/app/api/auth/[...all]/route";
import { GET as threadsList } from "@/app/api/threads/route";
import { adminUser, callRoute, jsonOf, PASSWORD, signUp } from "./support/app";

describe("/api/auth/[...all] (better-auth handler)", () => {
  it("signs up with username plugin + auto sign-in", async () => {
    const user = await signUp("signup");
    const res = await callRoute(All, { path: "/api/auth/get-session", cookie: user.cookie });
    const body = await jsonOf<{ user: { username: string; role: string }; session: unknown }>(res);
    expect(body.user.username).toBe(user.username);
    expect(body.user.role).toBe("user");
    expect(body.session).toBeTruthy();
  });

  it("rejects too-short passwords and duplicate usernames", async () => {
    const first = await signUp("dup");
    const short = await callRoute(All, {
      method: "POST",
      path: "/api/auth/sign-up/email",
      json: { name: "shorty", email: "short@example.test", password: "abc", username: "shorty99" },
    });
    expect(short.status).toBeGreaterThanOrEqual(400);

    const dupe = await callRoute(All, {
      method: "POST",
      path: "/api/auth/sign-up/email",
      json: { name: "copy", email: "copy@example.test", password: PASSWORD, username: first.username },
    });
    expect(dupe.status).toBeGreaterThanOrEqual(400);
  });

  it("signs in and signs out", async () => {
    const user = await signUp("cycle");
    const res = await callRoute(All, {
      method: "POST",
      path: "/api/auth/sign-in/email",
      json: { email: user.email, password: user.password },
    });
    expect(res.ok).toBe(true);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="))!.split(";")[0];
    const signedOut = await callRoute(All, { method: "POST", path: "/api/auth/sign-out", cookie });
    expect(signedOut.ok).toBe(true);
    // cookie is now dead
    const gone = await callRoute(threadsList, { cookie });
    expect(gone.status).toBe(401);
  });

  it("answers with 401 on bad credentials", async () => {
    const user = await signUp("badpass");
    const res = await callRoute(All, {
      method: "POST",
      path: "/api/auth/sign-in/email",
      json: { email: user.email, password: "wrong-password" },
    });
    expect(res.status).toBe(401);
  });

  it("GET export serves session endpoints; role is admin for the bootstrap user", async () => {
    const admin = await adminUser();
    const res = await callRoute(GET, { path: "/api/auth/get-session", cookie: admin.cookie });
    const body = await jsonOf<{ user: { role: string } }>(res);
    expect(body.user.role).toBe("admin");
  });

  it("POST export proxies to better-auth (unknown path → 404)", async () => {
    const res = await callRoute(POST, { method: "POST", path: "/api/auth/nope", json: {} });
    expect(res.status).toBe(404);
  });
});
