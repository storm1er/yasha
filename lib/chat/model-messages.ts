// Raw OpenAI upstream messages → AI SDK ModelMessage[] (M2 conversion seam).
// The window builders (chat-attachments, expandToolRounds) stay OpenAI-shaped
// and byte-stable (prefix-cache rule); only the model call converts. Tool
// names are recovered from the preceding assistant tool_calls, mirroring the
// OpenAI wire semantics; audio parts map to the file part the compat provider
// re-emits as `input_audio` (M0 spike S7).

import type {
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from "ai";
import type { UpstreamContentPart } from "@/lib/chat-attachments";
import type { ChatUpstreamMessage } from "@/lib/mcp/loop";

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** OpenAI content-part list → AI SDK user content (string stays string). */
function userContent(content: string | UpstreamContentPart[] | null): UserModelMessage["content"] {
  if (typeof content === "string" || content === null) return content ?? "";
  const parts: NonNullable<UserModelMessage["content"]> = [];
  for (const part of content) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else if (part.type === "image_url") parts.push({ type: "image", image: part.image_url.url });
    else if (part.type === "input_audio")
      parts.push({ type: "file", data: part.input_audio.data, mediaType: `audio/${part.input_audio.format}` });
    // Unknown part types are dropped, never forwarded upstream unvalidated.
  }
  return parts;
}

export function toModelMessages(msgs: ChatUpstreamMessage[]): ModelMessage[] {
  const toolNameByCallId = new Map<string, string>();
  const out: ModelMessage[] = [];
  for (const m of msgs) {
    if (m.role === "system") {
      out.push({ role: "system", content: typeof m.content === "string" ? m.content : "" });
    } else if (m.role === "user") {
      out.push({ role: "user", content: userContent(m.content) });
    } else if (m.role === "assistant") {
      const parts: NonNullable<AssistantModelMessage["content"]> = [];
      if (typeof m.content === "string" && m.content) parts.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        toolNameByCallId.set(tc.id, tc.function.name);
        parts.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: parseArgs(tc.function.arguments),
        });
      }
      // An assistant row with no representable part (empty content, no calls)
      // rides along as empty text — never a partless message the SDK rejects.
      if (parts.length === 0) parts.push({ type: "text", text: "" });
      out.push({ role: "assistant", content: parts });
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id ?? "",
            toolName: toolNameByCallId.get(m.tool_call_id ?? "") ?? "",
            output: { type: "text", value: typeof m.content === "string" ? m.content : "" },
          },
        ],
      } satisfies ToolModelMessage);
    }
    // Other roles never occur in Yasha-stored history; dropped by design.
  }
  return out;
}
