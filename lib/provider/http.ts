// Shared upstream HTTP plumbing (provider-agnostic):
// - SSE `data:` payload iteration for upstream chat streams
// - recursive stripping of `reasoning`/`reasoning_details` upstream fields

/**
 * Recursively removes every key whose name contains "reasoning" (in place):
 * upstream `reasoning`/`reasoning_details` deltas plus `reasoning_tokens` and
 * any other reasoning-derived usage metadata. Ensures no reasoning trace,
 * counter, or field name ever reaches /v1 clients.
 */
export function stripReasoningFields<T>(value: unknown): T {
  if (Array.isArray(value)) {
    for (const item of value) stripReasoningFields(item);
    return value as T;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key.toLowerCase().includes("reasoning")) delete obj[key];
    }
    for (const nested of Object.values(obj)) stripReasoningFields(nested);
  }
  return value as T;
}

/**
 * Iterates `data:` payloads of an upstream SSE body, including the final
 * "[DONE]" sentinel. Throws if the underlying read fails mid-stream.
 */
export async function forEachSseData(
  body: ReadableStream<Uint8Array>,
  onData: (payload: string) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  }
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail.startsWith("data:")) onData(tail.slice(5).trim());
}
