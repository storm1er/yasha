/** Client-safe mirror of fetchChatModels' allowlist rule (lib/lemonade-stream.ts):
 *  labels contain "chat" AND (downloaded === true OR id starts with "openrouter"). */
export function isChatCapable(entry: {
  id?: string | null;
  downloaded?: boolean;
  labels?: string[];
}): boolean {
  if (!entry.id) return false;
  if (!Array.isArray(entry.labels) || !entry.labels.includes("chat")) return false;
  return entry.downloaded === true || entry.id.startsWith("openrouter");
}
