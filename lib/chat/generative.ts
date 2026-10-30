// Generative UI — display-only cards (issue #16, Milestone 1).
//
// Contract (shared with both clients — web renders ToolChip.card, Android
// renders ToolProgress/CardDto under the tool chip): an MCP tool may return a
// JSON envelope as its result text:
//
//   { "yasha_card": { "kind"?: string, "title": string, "body"?: string,
//                     "fields"?: [{ "label": string, "value": string }],
//                     "links"?: [{ "label": string, "url": string }] }, ... }
//
// A VALID envelope is surfaced as the optional `card` on the terminal
// `data-tool` event (lib/mcp/ai-tools.ts) and persisted on the
// ToolRoundRecord (meta.tools) — the stream protocol and meta shape only gain
// an optional field, so old clients keep rendering the raw result unchanged.
// Anything invalid (malformed JSON, wrong shapes, overlong text, non-http(s)
// links) degrades to `null`: the tool result stays a plain text result.

export const CARD_KIND_DEFAULT = "info";

export type GenerativeCardField = { label: string; value: string };
export type GenerativeCardLink = { label: string; url: string };

export type GenerativeCard = {
  kind: string;
  title: string;
  body?: string;
  fields?: GenerativeCardField[];
  links?: GenerativeCardLink[];
};

const KIND_MAX = 40;
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const LABEL_MAX = 80;
const VALUE_MAX = 500;
const FIELDS_MAX = 12;
const LINKS_MAX = 6;
const URL_MAX = 2048;

const isString = (v: unknown): v is string => typeof v === "string";
const isBoundedString = (v: unknown, max: number): v is string => isString(v) && v.length > 0 && v.length <= max;

/** Only http(s) links render — blocks `javascript:`/`data:` exfiltration. */
function isHttpUrl(v: unknown): v is string {
  if (!isBoundedString(v, URL_MAX)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Manual validation (codebase style — no schema lib): any violation rejects
 *  the WHOLE card (return null); accepted cards are trimmed copies. */
export function parseGenerativeCard(raw: unknown): GenerativeCard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;

  const kind = c.kind === undefined ? CARD_KIND_DEFAULT : isBoundedString(c.kind, KIND_MAX) ? c.kind : null;
  if (kind === null || !isBoundedString(c.title, TITLE_MAX)) return null;
  if (c.body !== undefined && !(isString(c.body) && c.body.length <= BODY_MAX)) return null;

  let fields: GenerativeCardField[] | undefined;
  if (c.fields !== undefined) {
    if (!Array.isArray(c.fields) || c.fields.length > FIELDS_MAX) return null;
    const parsed = c.fields.map((f) => {
      if (!f || typeof f !== "object") return null;
      const o = f as Record<string, unknown>;
      if (!isBoundedString(o.label, LABEL_MAX) || !isString(o.value) || o.value.length > VALUE_MAX) return null;
      return { label: o.label, value: o.value };
    });
    if (parsed.some((f) => f === null)) return null;
    fields = parsed as GenerativeCardField[];
  }

  let links: GenerativeCardLink[] | undefined;
  if (c.links !== undefined) {
    if (!Array.isArray(c.links) || c.links.length > LINKS_MAX) return null;
    const parsed = c.links.map((l) => {
      if (!l || typeof l !== "object") return null;
      const o = l as Record<string, unknown>;
      if (!isBoundedString(o.label, LABEL_MAX) || !isHttpUrl(o.url)) return null;
      return { label: o.label, url: o.url };
    });
    if (parsed.some((l) => l === null)) return null;
    links = parsed as GenerativeCardLink[];
  }

  return {
    kind,
    title: c.title.trim(),
    ...(isString(c.body) ? { body: c.body } : {}),
    ...(fields ? { fields } : {}),
    ...(links ? { links } : {}),
  };
}

/** Extract the card from a tool result string, or null when the result is not
 *  a valid envelope. The raw string always keeps flowing to the model. */
export function extractToolCard(result: string): GenerativeCard | null {
  // Cheap pre-filter: 99% of tool results are plain text without the marker.
  if (!result.includes("yasha_card")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parseGenerativeCard((parsed as Record<string, unknown>).yasha_card);
}
