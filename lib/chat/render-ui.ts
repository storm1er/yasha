// Generative UI tier 1 (issue #28): `render_ui` — the model renders a
// DECLARATIVE component tree (charts, metrics, tables, slides…) instead of
// arbitrary code. Display-only: with `execute`, so the SDK loop dispatches it
// like an MCP tool — validate → `data-card` chunk + `meta.cards` record →
// return "displayed" and the same turn continues. No user answer involved:
// no pending gate, no resume (that is the interactive tier, interactive.ts).
// Invalid input is fed back to the model as the tool result so it can
// self-correct; the client NEVER sees a partially-valid tree.
//
// Hard rules the schema enforces (the client renderer trusts the shape):
//   - closed vocabulary, `type`-discriminated, no free-form HTML/markdown;
//   - depth ≤ MAX_DEPTH and ≤ MAX_NODES nodes per card (recursion guard);
//   - every string bounded; table/metric cells coerced from numbers.

import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";

export const RENDER_UI_TOOL = "render_ui";
/** What the model gets when the tree validated. */
export const DISPLAYED = "[card displayed]";
/** Cards per turn: one step may hold many calls, so cap the spam. */
export const CARD_BUDGET = 6;
export const MAX_DEPTH = 4;
export const MAX_NODES = 40;

const TEXT_MAX = 2000;
const TITLE_MAX = 120;
const BODY_MAX = 1000;
const LABEL_MAX = 80;
const VALUE_MAX = 40;
const ITEM_MAX = 300;
const ITEMS_MAX = 30;
const COL_MAX = 40;
const COLS_MAX = 10;
const ROWS_MAX = 30;
const DATA_MAX = 60;
const SLIDES_MAX = 12;
const CHILDREN_MAX = 10;

export type GenUiText = { type: "text"; text: string };
export type GenUiMetric = {
  type: "metric";
  label: string;
  value: string;
  unit?: string;
  trend?: "up" | "down" | "flat";
};
export type GenUiBadge = {
  type: "badge";
  text: string;
  tone?: "default" | "success" | "warning" | "danger" | "info";
};
export type GenUiProgress = { type: "progress"; label?: string; value: number };
export type GenUiList = { type: "list"; items: string[]; ordered?: boolean };
export type GenUiChart = {
  type: "chart";
  chart: "bar" | "line" | "area" | "donut";
  title?: string;
  unit?: string;
  data: { label: string; value: number }[];
};
export type GenUiTable = { type: "table"; columns: string[]; rows: string[][] };
export type GenUiCard = { type: "card"; title?: string; children: GenUiNode[] };
export type GenUiGrid = { type: "grid"; cols?: number; children: GenUiNode[] };
export type GenUiSlide = { title?: string; body?: string; children?: GenUiNode[] };
export type GenUiSlides = { type: "slides"; slides: GenUiSlide[] };
export type GenUiNode =
  | GenUiText
  | GenUiMetric
  | GenUiBadge
  | GenUiProgress
  | GenUiList
  | GenUiChart
  | GenUiTable
  | GenUiCard
  | GenUiGrid
  | GenUiSlides;

/** Persisted/streamed card: stable id (React key, future updates) + tree root
 *  (a node, or several rendered stacked). */
export type RenderedCard = { id: string; root: GenUiNode | GenUiNode[] };

const str = (max: number) => z.string().min(1).max(max);
/** Cell coercion: models pass numbers/booleans for values all the time. */
const cell = (max: number) =>
  z
    .union([z.string(), z.number(), z.boolean()])
    .transform((v) => String(v))
    .pipe(z.string().min(1).max(max));

const leafText = z.object({ type: z.literal("text"), text: str(TEXT_MAX) });
const leafMetric = z.object({
  type: z.literal("metric"),
  label: str(LABEL_MAX),
  value: cell(VALUE_MAX),
  unit: str(24).optional(),
  trend: z.enum(["up", "down", "flat"]).optional(),
});
const leafBadge = z.object({
  type: z.literal("badge"),
  text: str(40),
  tone: z.enum(["default", "success", "warning", "danger", "info"]).optional(),
});
const leafProgress = z.object({
  type: z.literal("progress"),
  label: str(LABEL_MAX).optional(),
  value: z.number().min(0).max(100),
});
const leafList = z.object({
  type: z.literal("list"),
  items: z.array(str(ITEM_MAX)).min(1).max(ITEMS_MAX),
  ordered: z.boolean().optional(),
});
const leafChart = z.object({
  type: z.literal("chart"),
  chart: z.enum(["bar", "line", "area", "donut"]),
  title: str(TITLE_MAX).optional(),
  unit: str(24).optional(),
  data: z
    .array(z.object({ label: str(40), value: z.number() }))
    .min(1)
    .max(DATA_MAX),
});
const leafTable = z.object({
  type: z.literal("table"),
  columns: z.array(str(COL_MAX)).min(1).max(COLS_MAX),
  rows: z
    .array(z.array(cell(ITEM_MAX)).min(1).max(COLS_MAX))
    .max(ROWS_MAX)
    .refine((rows) => rows.every((r) => r.length === 0 || r.length <= COLS_MAX), {
      message: "row cells exceed the column budget",
    }),
});
const compSlides = z.object({
  type: z.literal("slides"),
  slides: z
    .array(
      z.object({
        title: str(TITLE_MAX).optional(),
        body: str(BODY_MAX).optional(),
        children: z.array(nodeRef()).min(1).max(CHILDREN_MAX).optional(),
      }),
    )
    .min(1)
    .max(SLIDES_MAX),
});

// Recursion: the union is built lazily so the container schemas below may
// reference `nodeRef()` before the const exists.
function nodeRef(): z.ZodType<GenUiNode> {
  return z.lazy(() => node) as z.ZodType<GenUiNode>;
}
const node: z.ZodType<GenUiNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    leafText,
    leafMetric,
    leafBadge,
    leafProgress,
    leafList,
    leafChart,
    leafTable,
    z.object({
      type: z.literal("card"),
      title: str(TITLE_MAX).optional(),
      children: z.array(nodeRef()).min(1).max(CHILDREN_MAX),
    }),
    z.object({
      type: z.literal("grid"),
      cols: z.number().int().min(1).max(4).optional(),
      children: z.array(nodeRef()).min(1).max(CHILDREN_MAX),
    }),
    compSlides,
  ]),
) as z.ZodType<GenUiNode>;

/** Shape guard over the parsed tree(s): depth + total node count ACROSS all
 *  stacked roots. Runs AFTER the zod pass (the tree is finite but
 *  recursion-deep inputs must not reach the client renderer). Returns null
 *  when within budget, else a model-readable error. */
export function checkTreeShape(roots: GenUiNode | GenUiNode[]): string | null {
  let count = 0;
  const walk = (n: GenUiNode, depth: number): boolean => {
    count += 1;
    if (count > MAX_NODES) return false;
    if (depth > MAX_DEPTH) return false;
    if (n.type === "card" || n.type === "grid") {
      for (const c of n.children) if (!walk(c, depth + 1)) return false;
    } else if (n.type === "slides") {
      for (const s of n.slides) {
        count += 1;
        if (count > MAX_NODES) return false;
        for (const c of s.children ?? []) if (!walk(c, depth + 1)) return false;
      }
    }
    return true;
  };
  for (const r of Array.isArray(roots) ? roots : [roots]) if (!walk(r, 1))
    return "tree too deep or too large (max depth 4, 40 nodes)";
  return null;
}

const inputSchema = z.object({
  root: z.union([node, z.array(node).min(1).max(CHILDREN_MAX)]),
});

export type ParseResult =
  | { ok: true; root: GenUiNode | GenUiNode[] }
  | { ok: false; error: string };

/** Validate model tool input (or a stored card). Arrays stay arrays (the
 *  client renders them stacked); single nodes stay single. */
export function parseGenUiInput(input: unknown): ParseResult {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `invalid render_ui input — ${issues}` };
  }
  const shapeError = checkTreeShape(parsed.data.root);
  if (shapeError) return { ok: false, error: `invalid render_ui input — ${shapeError}` };
  return { ok: true, root: parsed.data.root };
}

/** Re-validation of a persisted `meta.cards` array (ui-messages replay):
 *  malformed records are dropped, never rendered half-valid. */
export function parseStoredCards(raw: unknown): RenderedCard[] {
  if (!Array.isArray(raw)) return [];
  const out: RenderedCard[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, root } = entry as { id?: unknown; root?: unknown };
    if (typeof id !== "string" || !id) continue;
    const parsed = parseGenUiInput({ root });
    if (parsed.ok) out.push({ id, root: parsed.root });
  }
  return out;
}

/** AI SDK tool definition WITH execute (display-only): valid tree → `onCard`
 *  (stream + persist) then `DISPLAYED`; invalid → the error text goes back to
 *  the model as the tool result so it can self-correct; over-budget → a stop
 *  notice (one step can carry many calls). */
export function buildRenderUiTool(h: { onCard: (root: GenUiNode | GenUiNode[]) => void }): ToolSet {
  let dispatched = 0;
  return {
    [RENDER_UI_TOOL]: tool({
      description:
        "Show the user a visual card built from simple components (grid, metric, chart bar|line|area|donut, table, list, text, slides, badge, progress). The card renders inline in the chat; reply with `displayed` — do NOT repeat the card's content as text. Use it for anything a plain-text answer would render worse: numbers over time, comparisons, dashboards, step decks.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          root: {
            description:
              "One component node or an array of them. Nodes: {type:'text',text} · {type:'metric',label,value,unit?,trend?up|down|flat} · {type:'chart',chart:'bar'|'line'|'area'|'donut',data:[{label,value:number}],title?,unit?} · {type:'table',columns:[..],rows:[[..]]} · {type:'list',items:[..],ordered?} · {type:'badge',text,tone?} · {type:'progress',value:0-100,label?} · {type:'slides',slides:[{title?,body?,children?}]} · {type:'card',title?,children:[..]} · {type:'grid',cols:1-4,children:[..]} — max depth 4, ~40 nodes.",
          },
        },
        required: ["root"],
      }),
      execute: async (input: unknown) => {
        if (dispatched >= CARD_BUDGET) return `render_ui skipped: ${CARD_BUDGET} cards per reply maximum`;
        const parsed = parseGenUiInput(input);
        if (!parsed.ok) return parsed.error;
        dispatched += 1;
        h.onCard(parsed.root);
        return DISPLAYED;
      },
    }),
  };
}
