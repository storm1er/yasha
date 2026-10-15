import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/me/route";
import { callRoute, jsonOf, signUp } from "./support/app";

describe("GET /api/me", () => {
  it("401 unauthenticated", async () => {
    expect((await callRoute(GET)).status).toBe(401);
  });

  it("returns the caller's own row", async () => {
    const self = await signUp("me1");
    const res = await callRoute(GET, { cookie: self.cookie });
    expect(res.status).toBe(200);
    const { user } = await jsonOf<{ user: { email: string; username: string; role: string } }>(res);
    expect(user.email).toBe(self.email);
    expect(user.username).toBe(self.username);
    expect(user.role).toBe("user");
  });
});
