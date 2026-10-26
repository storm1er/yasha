import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as v1Models } from "@/app/v1/models/route";
import { createKey } from "@/lib/api-keys";
import { authenticateApiKey, invalidApiKeyResponse, openAiError } from "@/lib/openai-auth";
import { callRoute, jsonOf, sessionId, signUp, type TestUser } from "./support/app";
import { mockLemonade, modelsResponse } from "./support/lemonade";

let user: TestUser & { userId: string };
let plainKey: string;
let keyId: string;

beforeAll(async () => {
  vi.useFakeTimers();
  user = Object.assign(await signUp("openai"), { userId: "" });
  user.userId = await sessionId(user.cookie);
  const created = await createKey(user.userId, "edge");
  keyId = created.id;
  plainKey = created.key;
});

afterAll(() => {
  vi.useRealTimers();
});

const bearerReq = (authorization?: string) =>
  new Request("http://localhost:3000/v1/models", {
    headers: authorization === undefined ? {} : { authorization },
  });

describe("authenticateApiKey", () => {
  it("accepts an active ysk_ key", async () => {
    const caller = await authenticateApiKey(bearerReq(`Bearer ${plainKey}`));
    expect(caller).toEqual({ userId: user.userId, keyId });
  });

  it("accepts a case-insensitive Bearer scheme", async () => {
    expect(await authenticateApiKey(bearerReq(`bearer  ${plainKey} `))).not.toBeNull();
  });

  it("rejects missing / malformed headers", async () => {
    expect(await authenticateApiKey(bearerReq())).toBeNull();
    expect(await authenticateApiKey(bearerReq(""))).toBeNull();
    expect(await authenticateApiKey(bearerReq("Basic dXNlcjpwYXNz"))).toBeNull();
    expect(await authenticateApiKey(bearerReq("Bearer"))).toBeNull();
    expect(await authenticateApiKey(bearerReq("Token abc def"))).toBeNull();
  });

  it("rejects foreign-prefix, unknown and revoked keys", async () => {
    expect(await authenticateApiKey(bearerReq("Bearer sk-somethingelse"))).toBeNull();
    expect(await authenticateApiKey(bearerReq("Bearer ysk_00000000000000000000000000000000"))).toBeNull();

    const temp = await createKey(user.userId, "temp");
    await authenticateApiKey(bearerReq(`Bearer ${temp.key}`)); // active first
    const { revokeKey } = await import("@/lib/api-keys");
    expect(await revokeKey(temp.id, user.userId)).toBe(true);
    expect(await authenticateApiKey(bearerReq(`Bearer ${temp.key}`))).toBeNull();
  });
});

describe("error envelope helpers", () => {
  it("shapes OpenAI-style errors", async () => {
    const res = invalidApiKeyResponse();
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({
      error: {
        message:
          "Incorrect API key provided. Create one at /settings and pass it as 'Authorization: Bearer ysk_...'.",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
    const err = openAiError(502, "boom", "api_error", "upstream_error");
    expect(err.status).toBe(502);
    expect(await jsonOf(err)).toEqual({ error: { message: "boom", type: "api_error", code: "upstream_error" } });
  });
});

describe("GET /v1/models", () => {
  it("401 without / with a bad key", async () => {
    for (const authorization of [undefined, "Bearer nope"]) {
      const res = await callRoute(v1Models, authorization ? { headers: { authorization } } : {});
      expect(res.status).toBe(401);
      expect((await jsonOf<{ error: { code: string } }>(res)).error.code).toBe("invalid_api_key");
    }
  });

  it("502 when the upstream model list fails", async () => {
    const mock = mockLemonade();
    mock.route("/v1/models", () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await callRoute(v1Models, { headers: { authorization: `Bearer ${plainKey}` } });
    expect(res.status).toBe(502);
    expect(await jsonOf(res)).toEqual({
      error: {
        message: "Upstream model list could not be fetched.",
        type: "api_error",
        code: "upstream_error",
      },
    });
    void mock;
  });

  it("lists chat models in OpenAI envelope", async () => {
    await vi.advanceTimersByTimeAsync(61_000); // clear any models-cache residue
    mockLemonade().route(
      "/v1/models",
      modelsResponse([
        { id: "m1", downloaded: true },
        { id: "openrouter.free", downloaded: false },
      ])
    );
    const res = await callRoute(v1Models, { headers: { authorization: `Bearer ${plainKey}` } });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      object: "list",
      data: [
        { id: "default:m1", object: "model", created: 0, owned_by: "default" },
        { id: "default:openrouter.free", object: "model", created: 0, owned_by: "default" },
      ],
    });
  });
});
