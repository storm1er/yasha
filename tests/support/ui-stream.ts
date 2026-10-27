// Parsers for the AI SDK UI message stream (protocol v2, M2): SSE frames of
// JSON UIMessageChunks + `data: [DONE]` + keep-alive comment lines.

export type UiChunk = Record<string, unknown> & { type: string };

export function parseUiChunks(raw: string): UiChunk[] {
  return raw
    .split("\n\n")
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice(f.indexOf(":") + 1).trim())
    .filter((d) => d && d !== "[DONE]")
    .map((d) => JSON.parse(d) as UiChunk);
}

/** Concatenated assistant text from text-delta chunks. */
export function uiText(chunks: UiChunk[]): string {
  return chunks
    .filter((c) => c.type === "text-delta")
    .map((c) => String(c.delta ?? ""))
    .join("");
}

export function uiData<T = Record<string, unknown>>(chunks: UiChunk[], type: string): T[] {
  return chunks.filter((c) => c.type === type).map((c) => c.data as T);
}

export function uiThread(chunks: UiChunk[]): string {
  return String(uiData<{ threadId: string }>(chunks, "data-thread")[0]!.threadId);
}

export function uiErrorCode(chunks: UiChunk[]): string | undefined {
  return uiData<{ code: string }>(chunks, "data-error")[0]?.code;
}

/** Raw text → chunks (drains the whole response body). */
export async function drainUi(res: Response): Promise<UiChunk[]> {
  return parseUiChunks(await res.text());
}
