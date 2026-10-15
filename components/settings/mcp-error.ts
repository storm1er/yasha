// Maps MCP route error codes (POST /api/mcp/servers, /api/admin/mcp) to the
// card translation-key suffix: t(`userMcp${suffix}`) / t(`mcp${suffix}`).

export type McpErrSuffix = "Quota" | "PrivateUrl" | "BadUrl" | "BadHeaders" | "BadName" | "Error";

export function mcpErrSuffix(code: string | null): McpErrSuffix {
  switch (code) {
    case "quota_exceeded":
      return "Quota";
    case "private_url_blocked":
      return "PrivateUrl";
    case "invalid_url":
      return "BadUrl";
    case "invalid_headers":
      return "BadHeaders";
    case "invalid_name":
      return "BadName";
    default:
      return "Error";
  }
}

/** Reads the { error } body of a failed MCP card call (never throws). */
export async function mcpErrCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}
