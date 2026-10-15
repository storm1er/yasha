// Shared fake OAuth authorization server + MCP endpoint for the MCP OAuth
// tests (drives the SDK's discovery/DCR/code-exchange/refresh flows through
// mockLemonade's fetch stub).

import { json, mockLemonade, type LemonadeMock, type MockCall } from "./lemonade";

export const MCP_URL = "https://mcp.test/mcp";
export const PRM_URL = "https://mcp.test/.well-known/oauth-protected-resource";

export type MockAuth = {
  mock: LemonadeMock;
  tokenReplies: { code: () => Response; refresh: () => Response };
  tokenCalls: () => MockCall[];
};

export function mockAuthServer(): MockAuth {
  const mock = mockLemonade();
  const tokenReplies = {
    code: () =>
      json({ access_token: "at-code", refresh_token: "rt-1", token_type: "Bearer", expires_in: 3600 }),
    refresh: () =>
      json({ access_token: "at-refreshed", refresh_token: "rt-2", token_type: "Bearer", expires_in: 3600 }),
  };

  // MCP endpoint: always 401 + resource_metadata pointer (authorization dance).
  mock.route("mcp.test/mcp", () =>
    new Response("unauthorized", {
      status: 401,
      headers: { "www-authenticate": `Bearer resource_metadata="${PRM_URL}"` },
    })
  );
  mock.route(PRM_URL, () =>
    json({
      resource: MCP_URL,
      authorization_servers: ["https://auth.test"],
      scopes_supported: ["mcp:tools"],
    })
  );
  // RFC 8414 metadata for issuer https://auth.test (root path).
  mock.route("auth.test/.well-known/oauth-authorization-server", () =>
    json({
      issuer: "https://auth.test",
      authorization_endpoint: "https://auth.test/authorize",
      token_endpoint: "https://auth.test/token",
      registration_endpoint: "https://auth.test/register",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    })
  );
  // RFC 7591: the AS echoes the registered client metadata back.
  mock.route("auth.test/register", (_url, call) =>
    json({
      ...(JSON.parse(call.body || "{}") as Record<string, unknown>),
      client_id: "cid-123",
      client_id_issued_at: 1730000000,
    })
  );
  mock.route("auth.test/token", (_url, call) =>
    (call.body ?? "").includes("grant_type=authorization_code") ? tokenReplies.code() : tokenReplies.refresh()
  );

  return {
    mock,
    tokenReplies,
    tokenCalls: () => mock.calls.filter((c) => c.url.includes("auth.test/token")),
  };
}
