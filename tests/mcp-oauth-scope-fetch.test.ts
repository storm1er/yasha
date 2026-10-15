// Scope-aware fetch: PRM discovery gets `offline_access` appended to
// scopes_supported only when the AS metadata advertises it (keeps refresh
// tokens available on better-auth-style authorization servers).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, mockLemonade, type LemonadeMock } from "./support/lemonade";
import { oauthScopeAwareFetch } from "@/lib/mcp/oauth/scope-fetch";

const PRM = "https://mcp.test/.well-known/oauth-protected-resource";
const AS_META = "https://auth.test/.well-known/oauth-authorization-server";
const AS_OIDC = "https://auth.test/.well-known/openid-configuration";

let mock: LemonadeMock;
let fetch: ReturnType<typeof oauthScopeAwareFetch>;

function asMeta(scopes: string[] | undefined) {
  const meta = { issuer: "https://auth.test", ...(scopes ? { scopes_supported: scopes } : {}) };
  mock.route(AS_META, () => json(meta));
}

beforeEach(() => {
  mock = mockLemonade();
  fetch = oauthScopeAwareFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function scopes(url: string): Promise<unknown> {
  const res = await fetch(url);
  return (await res.json())?.scopes_supported;
}

describe("oauthScopeAwareFetch", () => {
  it("passes non-PRM responses through untouched", async () => {
    mock.route("other", () => json({ scopes_supported: ["a"] }));
    const res = await fetch("https://mcp.test/other");
    expect(await res.json()).toEqual({ scopes_supported: ["a"] });
  });

  it("passes failed PRM responses through", async () => {
    mock.route(`${PRM}?t=1`, () => json({ error: "nope" }, 404));
    const res = await fetch(`${PRM}?t=1`);
    expect(res.status).toBe(404);
  });

  it("passes garbage PRM payloads through", async () => {
    mock.route(`${PRM}?t=2`, () => new Response("<html>", { status: 200 }));
    const res = await fetch(`${PRM}?t=2`);
    expect(await res.text()).toBe("<html>");
  });

  it("leaves PRM docs without scopes_supported alone", async () => {
    mock.route(`${PRM}?t=3`, () => json({ resource: "https://mcp.test/mcp" }));
    expect(await scopes(`${PRM}?t=3`)).toBeUndefined();
  });

  it("leaves PRM docs that already include offline_access alone (no AS probe)", async () => {
    mock.route(`${PRM}?t=4`, () => json({ scopes_supported: ["game:read", "offline_access"], authorization_servers: ["https://auth.test"] }));
    expect(await scopes(`${PRM}?t=4`)).toEqual(["game:read", "offline_access"]);
    expect(mock.calls.some((c) => c.url.includes(".well-known/oauth-authorization-server"))).toBe(false);
  });

  it("appends offline_access when the AS metadata supports it", async () => {
    mock.route(`${PRM}?t=5`, () =>
      json({ resource: "https://mcp.test/mcp", scopes_supported: ["game:read"], authorization_servers: ["https://auth.test"] }, 201)
    );
    asMeta(["game:read", "offline_access"]);
    const res = await fetch(`${PRM}?t=5`);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      resource: "https://mcp.test/mcp",
      scopes_supported: ["game:read", "offline_access"],
    });
  });

  it("does not append when the AS does not support offline_access", async () => {
    mock.route(`${PRM}?t=6`, () => json({ scopes_supported: ["game:read"], authorization_servers: ["https://auth.test"] }));
    asMeta(["game:read"]);
    expect(await scopes(`${PRM}?t=6`)).toEqual(["game:read"]);
  });

  it("falls back to openid-configuration discovery", async () => {
    mock.route(`${PRM}?t=7`, () => json({ scopes_supported: ["a"], authorization_servers: ["https://auth.test"] }));
    mock.route(AS_META, () => json({ error: "not_found" }, 404));
    mock.route(AS_OIDC, () => json({ issuer: "https://auth.test", scopes_supported: ["offline_access"] }));
    expect(await scopes(`${PRM}?t=7`)).toEqual(["a", "offline_access"]);
  });

  it("treats unreachable AS metadata as unsupported", async () => {
    mock.route(`${PRM}?t=8`, () => json({ scopes_supported: ["a"], authorization_servers: ["https://auth.test"] }));
    mock.route(AS_META, () => {
      throw new Error("socket closed");
    });
    expect(await scopes(`${PRM}?t=8`)).toEqual(["a"]);
  });

  it("tolerates malformed authorization_servers lists and non-http entries", async () => {
    mock.route(`${PRM}?t=9`, () => json({ scopes_supported: ["a"], authorization_servers: ["ftp://bad", 42] }));
    expect(await scopes(`${PRM}?t=9`)).toEqual(["a"]);
    mock.route("https://weird.test/.well-known/oauth-protected-resource", () =>
      json({ scopes_supported: ["a"], authorization_servers: "https://auth.test" })
    );
    expect(
      await scopes("https://weird.test/.well-known/oauth-protected-resource")
    ).toEqual(["a"]);
  });

describe("401 WWW-Authenticate scope supplement", () => {
  function prm401(prmUrl: string, asSupports: boolean) {
    mock.route(prmUrl, () =>
      json({ scopes_supported: ["game:read"], authorization_servers: ["https://auth.test"] })
    );
    if (asSupports) asMeta(["game:read", "offline_access"]);
    else asMeta(["game:read"]);
  }

  function resp401(prmUrl: string, scope: string | null, scheme = "Bearer") {
    const parts = [`${scheme} resource_metadata="${prmUrl}"`];
    if (scope !== null) parts.push(`scope="${scope}"`);
    mock.route("mcp.live.test", () =>
      new Response("nope", { status: 401, headers: { "www-authenticate": parts.join(", ") } })
    );
    return fetch("https://mcp.live.test/mcp");
  }

  it("adds offline_access to the bearer scope hint when the AS supports it", async () => {
    prm401("https://mcp.live.test/prm-a", true);
    const res = await resp401("https://mcp.live.test/prm-a", "game:read progress:read");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('scope="game:read progress:read offline_access"');
  });

  it("does not touch the scope when the AS does not support offline_access", async () => {
    prm401("https://mcp.live.test/prm-b", false);
    const res = await resp401("https://mcp.live.test/prm-b", "game:read");
    expect(res.headers.get("www-authenticate")).toContain('scope="game:read"');
    expect(res.headers.get("www-authenticate")).not.toContain("offline_access");
  });

  it("leaves scopes that already include offline_access alone (no probe)", async () => {
    mock.route("mcp.live.test", () =>
      new Response("nope", {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.live.test/prm-c", scope="offline_access"' },
      })
    );
    const res = await resp401("https://mcp.live.test/prm-c", "offline_access");
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://mcp.live.test/prm-c", scope="offline_access"');
    expect(mock.calls.some((c) => c.url.includes("prm-c"))).toBe(false);
  });

  it("ignores 401s without a scope or without resource_metadata or non-bearer", async () => {
    mock.route("mcp.live.test", () =>
      new Response("nope", { status: 401, headers: { "www-authenticate": "Basic realm=x" } })
    );
    let res = await fetch("https://mcp.live.test/mcp");
    expect(res.headers.get("www-authenticate")).toBe("Basic realm=x");

    mock.route("mcp.live2.test", () =>
      new Response("nope", { status: 401, headers: { "www-authenticate": 'Bearer scope="a b"' } })
    );
    res = await fetch("https://mcp.live2.test/mcp");
    expect(res.headers.get("www-authenticate")).toBe('Bearer scope="a b"');

    mock.route("mcp.live3.test", () =>
      new Response("nope", { status: 401, headers: { "www-authenticate": "Bearer" } })
    );
    res = await fetch("https://mcp.live3.test/mcp");
    expect(res.status).toBe(401);
  });

  it("caches the AS support probe", async () => {
    prm401("https://mcp.live.test/prm-d", true);
    await resp401("https://mcp.live.test/prm-d", "game:read");
    const before = mock.calls.filter((c) => c.url.includes("oauth-authorization-server")).length;
    await resp401("https://mcp.live.test/prm-d", "game:read");
    const after = mock.calls.filter((c) => c.url.includes("oauth-authorization-server")).length;
    expect(after).toBe(before);
  });
});

  it("accepts URL-instance inputs", async () => {
    mock.route(`${PRM}?t=10`, () => json({ scopes_supported: ["a"] }));
    const res = await fetch(new URL(`${PRM}?t=10`));
    expect(await res.json()).toMatchObject({ scopes_supported: ["a"] });
  });

  it("treats a failing PRM probe as unsupported (401 path)", async () => {
    mock.route("mcp.live.probe", () =>
      new Response("nope", {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.live.test/prm-e", scope="a b"' },
      })
    );
    mock.route("https://mcp.live.test/prm-e", () => json({ error: "gone" }, 404));
    const res = await fetch("https://mcp.live.probe/mcp");
    expect(res.headers.get("www-authenticate")).toContain('scope="a b"');
  });

  it("treats a throwing PRM probe as unsupported (401 path)", async () => {
    mock.route("mcp.live.throw", () =>
      new Response("nope", {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.live.test/prm-f", scope="a b"' },
      })
    );
    mock.route("https://mcp.live.test/prm-f", () => {
      throw new Error("socket reset");
    });
    const res = await fetch("https://mcp.live.throw/mcp");
    expect(res.headers.get("www-authenticate")).toContain('scope="a b"');
  });

  it("skips the probe when the PRM body has no scopes_supported array (401 path)", async () => {
    mock.route("mcp.live.arr", () =>
      new Response("nope", {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.live.test/prm-g", scope="a b"' },
      })
    );
    mock.route("https://mcp.live.test/prm-g", () => json({ resource: "x" }));
    const res = await fetch("https://mcp.live.arr/mcp");
    expect(res.headers.get("www-authenticate")).toContain('scope="a b"');
  });
});
