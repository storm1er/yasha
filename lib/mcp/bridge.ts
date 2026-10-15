// Bridge between the MCP tool catalog and OpenAI-style `tools` (shared by the
// chat route and /v1). Tool output is UNTRUSTED data: fenced + neutralized,
// never instructions.

import { QUOTED_DATA_LINE, neutralizedBlock } from "@/lib/memory/transcript";
import { mcpEnabled, mcpToolResultMaxChars } from "@/lib/settings";
import { callTool } from "./client";
import { effectiveCatalogForUser, getServer, type CatalogEntry } from "./registry";

export type OpenAiToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
/** Handle stamped at build time with the requesting user; user-owned servers
 * are only callable by their owner (re-checked in `runToolCall`). */
export type ToolHandle = { serverId: string; tool: string; title: string; userId: string };

/** `mcp__<serverId>__<tool>` sanitized to the OpenAI name charset. */
export function openAiToolName(serverId: string, tool: string): string {
  return `mcp__${serverId}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export type Toolset = {
  specs: OpenAiToolSpec[];
  handles: Map<string, ToolHandle>;
};

export async function buildToolset(userId: string): Promise<Toolset> {
  if (!mcpEnabled()) return { specs: [], handles: new Map() };
  const catalog: CatalogEntry[] = await effectiveCatalogForUser(userId);
  const specs: OpenAiToolSpec[] = [];
  const handles = new Map<string, ToolHandle>();
  for (const entry of catalog) {
    if (!entry.health.ok) continue;
    for (const tool of entry.tools) {
      const name = openAiToolName(entry.server.id, tool.name);
      if (handles.has(name)) continue; // sanitized-name collision: first wins (global-first order)
      specs.push({
        type: "function",
        function: {
          name,
          description: `${entry.server.name}: ${tool.description}`.slice(0, 500),
          parameters: { type: "object", properties: {} },
        },
      });
      handles.set(name, {
        serverId: entry.server.id,
        tool: tool.name,
        title: `${entry.server.name}: ${tool.name}`,
        userId,
      });
    }
  }
  return { specs, handles };
}

export type ToolOutcome = { content: string; ok: boolean; ms: number };

/**
 * Execute one OpenAI-flavoured tool call. Never throws: failures come back as
 * `ok: false` with the error text (fed to the model as an error tool result).
 */
export async function runToolCall(handle: ToolHandle, argsJson: string, signal?: AbortSignal): Promise<ToolOutcome> {
  const started = Date.now();
  const server = getServer(handle.serverId);
  // Ownership is re-checked here (defense in depth): a user-owned server row is
  // only callable by the stamped owner. Message mirrors the unknown-server case.
  if (!server || !server.enabled || (server.ownerUserId !== null && server.ownerUserId !== handle.userId)) {
    return { content: `tool error: unknown or disabled server ${handle.serverId}`, ok: false, ms: 0 };
  }
  let args: Record<string, unknown> = {};
  if (argsJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(argsJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      return { content: "tool error: invalid arguments JSON", ok: false, ms: 0 };
    }
  }
  try {
    const res = await callTool(server, handle.tool, args, signal);
    // SDK schema guarantees `content` on a parsed CallToolResult (a missing
    // one fails client-side parsing and lands in the catch below).
    const parts = res.content!;
    let text = parts
      .map((part) =>
        part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
          ? String(part.text)
          : "[non-text content]",
      )
      .join("\n");
    const maxChars = mcpToolResultMaxChars();
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[truncated]`;
    const isError = res.isError === true;
    const body = neutralizedBlock(text || "(empty)");
    return {
      content: `${QUOTED_DATA_LINE}\n--- tool output (${handle.tool}) ---\n${body}`,
      ok: !isError,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      content: `tool error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000),
      ok: false,
      ms: Date.now() - started,
    };
  }
}
