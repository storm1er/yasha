import { beforeAll, describe, expect, it } from "vitest";
import { GET, PATCH } from "@/app/api/admin/users/route";
import { adminUser, callRoute, jsonOf, signIn, signUp, type TestUser } from "./support/app";
import { db } from "./support/db";
import { account, user } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

let admin: Awaited<ReturnType<typeof adminUser>>;
let victim: TestUser;

beforeAll(async () => {
  admin = await adminUser();
  victim = await signUp("adm");
});

const patch = (body: unknown, cookie: string | null = admin.cookie) =>
  callRoute(PATCH, { method: "PATCH", path: "/u", cookie, json: body });

function userIdOf(email: string): string {
  const row = db.select({ id: user.id }).from(user).where(eq(user.email, email)).get();
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

describe("GET /api/admin/users", () => {
  it("401 unauthenticated, 403 non-admin, 200 with the list", async () => {
    expect((await callRoute(GET)).status).toBe(401);
    expect((await callRoute(GET, { cookie: victim.cookie })).status).toBe(403);
    const res = await callRoute(GET, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const { users } = await jsonOf<{ users: { email: string; username: string | null; role: string }[] }>(res);
    expect(users.some((u) => u.email === victim.email && u.username === victim.username)).toBe(true);
    expect(users.some((u) => u.email === admin.email && u.role === "admin")).toBe(true);
  });
});

describe("PATCH /api/admin/users — validation", () => {
  it("rejects malformed payloads", async () => {
    expect(
      (await callRoute(PATCH, { method: "PATCH", path: "/u", cookie: admin.cookie, body: "{oops", headers: { "content-type": "application/json" } })).status,
    ).toBe(400);
    expect((await patch([1, 2])).status).toBe(400); // array
    expect((await patch("nope")).status).toBe(400); // non-object
    expect((await patch({})).status).toBe(400); // missing userId
    expect((await patch({ userId: 7, username: "ok-user" })).status).toBe(400); // non-string userId
    expect((await patch({ userId: "", username: "ok-user" })).status).toBe(400); // empty userId
    const id = userIdOf(victim.email);
    expect((await patch({ userId: id })).status).toBe(400); // nothing to change
    expect((await patch({ userId: id, username: 5 })).status).toBe(400); // non-string username
    expect((await patch({ userId: id, username: "ab" })).status).toBe(400); // too short
    expect((await patch({ userId: id, email: "nope" })).status).toBe(400);
    expect((await patch({ userId: id, password: "short" })).status).toBe(400);
    expect((await patch({ userId: id, password: "x".repeat(501) })).status).toBe(400);
    expect((await patch({ userId: "ghost-user", username: "valid-name" })).status).toBe(404);
    expect((await patch({ userId: admin.userId, username: "valid-name" }, victim.cookie)).status).toBe(403);
    expect(
      (await callRoute(PATCH, { method: "PATCH", path: "/u", json: { userId: "x", username: "ok-name" } })).status,
    ).toBe(401);
  });
});

describe("PATCH /api/admin/users — self-service by normal users", () => {
  it("lets a user edit their own username/email/password", async () => {
    const self = await signUp("admself");
    const id = userIdOf(self.email);
    const renamed = await patch({ userId: id, username: "Self_Renamed" }, self.cookie);
    expect(renamed.status).toBe(200);
    expect(db.select().from(user).where(eq(user.id, id)).get()!.username).toBe("self_renamed");
    expect((await patch({ userId: id, email: "self-new@example.test" }, self.cookie)).status).toBe(200);
    const newPass = `Self-New-Pass-${Date.now()}`;
    expect((await patch({ userId: id, password: newPass }, self.cookie)).status).toBe(200);
    const cookie = await signIn("self-new@example.test", newPass);
    expect(cookie).toContain("better-auth.session_token=");
  });

  it("rejects edits of other accounts and self-editing admin rows the same way", async () => {
    const self = await signUp("admoth");
    expect((await patch({ userId: admin.userId, username: "hijacked_name" }, self.cookie)).status).toBe(403);
    expect((await patch({ userId: userIdOf(victim.email), email: "x@example.test" }, self.cookie)).status).toBe(403);
  });
});

describe("PATCH /api/admin/users — updates", () => {
  it("renames the user (lowercase username + display case + name sync)", async () => {
    const id = userIdOf(victim.email);
    const res = await patch({ userId: id, username: "Renamed_One" });
    expect(res.status).toBe(200);
    const row = db.select().from(user).where(eq(user.id, id)).get()!;
    expect(row.username).toBe("renamed_one");
    expect(row.displayUsername).toBe("Renamed_One");
    expect(row.name).toBe("Renamed_One");
    const { user: returned } = await jsonOf<{ user: { username: string } }>(res);
    expect(returned.username).toBe("renamed_one");
  });

  it("accepts an unchanged username (self is not a conflict)", async () => {
    const id = userIdOf(victim.email);
    expect((await patch({ userId: id, username: "renamed_one" })).status).toBe(200);
  });

  it("rejects usernames taken by someone else", async () => {
    const other = await signUp("adm2");
    const res = await patch({ userId: userIdOf(victim.email), username: other.username });
    expect(res.status).toBe(409);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("username_taken");
  });

  it("changes the email (lowercased) and sign-in follows the new address", async () => {
    const id = userIdOf(victim.email);
    const newEmail = `Renamed-${Date.now()}@Example.TEST`;
    const res = await patch({ userId: id, email: newEmail });
    expect(res.status).toBe(200);
    const stored = db.select().from(user).where(eq(user.id, id)).get()!;
    expect(stored.email).toBe(newEmail.toLowerCase());
    // same password still works at the new address
    const cookie = await signIn(newEmail.toLowerCase(), victim.password);
    expect(cookie).toContain("better-auth.session_token=");
    victim.email = newEmail.toLowerCase();
  });

  it("accepts an unchanged email (self is not a conflict)", async () => {
    expect((await patch({ userId: userIdOf(victim.email), email: victim.email })).status).toBe(200);
  });

  it("rejects emails taken by someone else", async () => {
    const res = await patch({ userId: userIdOf(victim.email), email: admin.email });
    expect(res.status).toBe(409);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("email_taken");
  });

  it("resets the password: old one fails, new one signs in", async () => {
    const newPassword = `Brand-New-Pass-${Date.now()}`;
    const res = await patch({ userId: userIdOf(victim.email), password: newPassword });
    expect(res.status).toBe(200);
    expect((await jsonOf<{ passwordChanged: boolean }>(res)).passwordChanged).toBe(true);
    await expect(signIn(victim.email, victim.password)).rejects.toThrow();
    const cookie = await signIn(victim.email, newPassword);
    expect(cookie).toContain("better-auth.session_token=");
    victim.password = newPassword;
  });

  it("rejects password resets for accounts without a credential", async () => {
    const lonely = await signUp("adm3");
    db.delete(account).where(eq(account.userId, userIdOf(lonely.email))).run();
    const res = await patch({ userId: userIdOf(lonely.email), password: "whatever-123" });
    expect(res.status).toBe(409);
    expect((await jsonOf<{ error: string }>(res)).error).toBe("no_credential_account");
  });
});
