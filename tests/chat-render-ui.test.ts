// Tier-1 generative UI (issue #28): `render_ui` unit coverage for the schema
// validator / tree budget / tool execute, plus route-level behavior —
// validated trees ride `data-card` chunks and `meta.cards` (interleaved via
// meta.parts), invalid input is fed back to the model, the per-turn card
// budget caps spam, and non-interactive surfaces never see the tool.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as chatRoute from "@/app/api/chat/route";
import { ensureReady } from "@/lib/db";
import { messages, threads } from "@/lib/db/schema";
import { releaseGeneration } from "@/lib/provider/gate";
import {
  buildRenderUiTool,
  CARD_BUDGET,
  DISPLAYED,
  checkTreeShape,
  parseGenUiInput,
  parseStoredCards,
  type GenUiNode,
} from "@/lib/chat/render-ui";
import { callRoute, sessionId, signUp, type TestUser } from "./support/app";
import { db, setFastModel, setSetting } from "./support/db";
import { mockLemonade, modelsResponse, sseChatCompletion, type LemonadeMock } from "./support/lemonade";
import { drainUi, uiData, uiText, type UiChunk } from "./support/ui-stream";

const CHAT = "/v1/chat/completions";
let user: TestUser & { userId: string };

beforeAll(async () => {
  await ensureReady();
  const u = await signUp("chatrender");
  user = Object.assign(u, { userId: await sessionId(u.cookie) });
});

beforeEach(() => {
  db.delete(messages).run();
  db.delete(threads).run();
  releaseGeneration(user.userId);
  setFastModel("default:fast-model.test");
  setSetting("mcp.enabled", "false"); // the tool surface is render_ui only
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const WEATHER: GenUiNode = {
  type: "card",
  title: "Weather",
  children: [
    { type: "metric", label: "Temp", value: "21°C", trend: "up" },
    { type: "chart", chart: "bar", data: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }] },
    { type: "badge", text: "sunny", tone: "success" },
  ],
};

const env = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
const sseLine = (p: Record<string, unknown>) => `data: ${JSON.stringify({ ...env, ...p })}\n\n`;
const sseRes = (body: string) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } });

/** Text lead + one tool call streamed in `fragments` arg chunks. */
function sseToolCall(
  toolName: string,
  toolCallId: string,
  args: string,
  text?: string,
): Response {
  let body = "";
  if (text) body += sseLine({ choices: [{ index: 0, delta: { role: "assistant", content: text } }] });
  const size = Math.ceil(args.length / 2);
  for (let i = 0; i < args.length; i += size) {
    const frag = args.slice(i, i + size);
    const call =
      i === 0
        ? { index: 0, id: toolCallId, type: "function", function: { name: toolName, arguments: frag } }
        : { index: 0, function: { arguments: frag } };
    body += sseLine({ choices: [{ index: 0, delta: { tool_calls: [call] } }] });
  }
  body += sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
  return sseRes(body);
}

/** Upstream sequence: one handler per model call (render_ui dispatches mid-turn). */
function scripted(...handlers: (() => Response)[]): LemonadeMock {
  const mock = mockLemonade();
  mock.route("/v1/models", () => modelsResponse([{ id: "fast-model.test" }]));
  let n = 0;
  mock.route(CHAT, () => handlers[Math.min(n++, handlers.length - 1)]());
  return mock;
}

async function post(json: Record<string, unknown>) {
  return callRoute(chatRoute.POST, {
    method: "POST",
    path: "/api/chat",
    cookie: user.cookie,
    json: { id: "new", messages: [{ id: `u-${Math.random()}`, role: "user", parts: [{ type: "text", text: "show me" }] }], ...json },
  });
}

const assistantRow = () => db.select().from(messages).where(eq(messages.role, "assistant")).all();
const toolContents = (mock: LemonadeMock): string =>
  mock.calls
    .filter((c) => c.url.includes(CHAT))
    .map((c) => c.body!)
    .join("|");

// ── parseGenUiInput ──────────────────────────────────────────────────────────

describe("parseGenUiInput", () => {
  it("accepts a single node and an array root", () => {
    expect(parseGenUiInput({ root: { type: "text", text: "hi" } })).toEqual({
      ok: true,
      root: { type: "text", text: "hi" },
    });
    const arr = parseGenUiInput({ root: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    expect(arr.ok).toBe(true);
  });

  it("accepts the full vocabulary (with number/boolean cell coercion)", () => {
    const nodes: unknown[] = [
      { type: "metric", label: "L", value: 12.5, unit: "u", trend: "down" },
      { type: "metric", label: "L", value: true },
      { type: "badge", text: "ok", tone: "warning" },
      { type: "progress", label: "p", value: 42.5 },
      { type: "progress", value: 0 },
      { type: "list", items: ["a", "b"], ordered: true },
      { type: "chart", chart: "line", data: [{ label: "x", value: 1 }], title: "t", unit: "kg" },
      { type: "chart", chart: "area", data: [{ label: "x", value: 1 }] },
      { type: "chart", chart: "donut", data: [{ label: "x", value: 1 }] },
      { type: "table", columns: ["A", "B"], rows: [["a", 1], [true, "y"]] },
      { type: "card", title: "c", children: [{ type: "text", text: "x" }] },
      { type: "grid", cols: 3, children: [{ type: "badge", text: "b" }] },
      {
        type: "slides",
        slides: [
          { title: "s1", body: "b" },
          { children: [{ type: "metric", label: "l", value: 1 }] },
        ],
      },
    ];
    for (const node of nodes) {
      const res = parseGenUiInput({ root: node });
      expect(res.ok, JSON.stringify(node)).toBe(true);
    }
    // coerced cells come back as strings
    const t = parseGenUiInput({
      root: { type: "table", columns: ["A"], rows: [[7]] },
    }) as { ok: true; root: { rows: string[][] } };
    expect(t.root.rows[0]![0]).toBe("7");
  });

  it("rejects malformed input with model-readable issues", () => {
    const bad = [
      null, // non-object input → root-path issue
      {}, // no root
      { root: { type: "nope" } }, // unknown component
      { root: [] }, // empty array
      { root: { type: "text" } }, // missing text
      { root: { type: "text", text: "" } },
      { root: { type: "text", text: "x".repeat(2001) } },
      { root: { type: "chart", chart: "scatter", data: [{ label: "a", value: 1 }] } },
      { root: { type: "chart", chart: "bar", data: [] } },
      { root: { type: "progress", value: 101 } },
      { root: { type: "metric", label: "", value: 1 } },
      { root: { type: "grid", children: [] } },
      { root: { type: "card", children: [{ type: "badge", text: "x".repeat(41) }] } },
    ];
    for (const input of bad) {
      const res = parseGenUiInput(input);
      expect(res.ok, JSON.stringify(input)).toBe(false);
      expect((res as { error: string }).error).toContain("invalid render_ui input");
    }
  });

  it("rejects over-budget trees (depth and node count)", () => {
    // depth 5: card > card > card > card > text
    const deep = parseGenUiInput({
      root: { type: "card", children: [{ type: "card", children: [{ type: "card", children: [{ type: "card", children: [{ type: "text", text: "too deep" }] }] }] }] },
    });
    expect(deep.ok).toBe(false);
    // 3 grids × (1 + 10) = 33 nodes: fits; 4 grids = 44: over MAX_NODES.
    const many = Array.from({ length: 4 }, (_, r) => ({
      type: "grid" as const,
      children: Array.from({ length: 10 }, (_, c) => ({ type: "badge" as const, text: `b${r}${c}` })),
    }));
    expect(parseGenUiInput({ root: many.slice(0, 3) }).ok).toBe(true);
    expect(parseGenUiInput({ root: many }).ok).toBe(false);
    // slides count toward the budget too
    expect(
      checkTreeShape({
        type: "slides",
        slides: Array.from({ length: 41 }, () => ({ title: "s" })),
      }),
    ).not.toBeNull();
    // …and so do the children INSIDE slides (depth-5 chain: slides>card>card>card>text)
    const deepSlides = parseGenUiInput({
      root: {
        type: "slides",
        slides: [
          {
            children: [
              { type: "card", children: [{ type: "card", children: [{ type: "card", children: [{ type: "text", text: "x" }] }] }] },
            ],
          },
        ],
      },
    });
    expect(deepSlides.ok).toBe(false);
  });
});

// ── parseStoredCards ─────────────────────────────────────────────────────────

describe("parseStoredCards", () => {
  const card = { id: "c1", root: WEATHER };
  it("keeps only well-formed records", () => {
    expect(parseStoredCards("nope")).toEqual([]);
    expect(parseStoredCards([null, 7, { root: WEATHER }, { id: "", root: WEATHER }])).toEqual([]);
    expect(parseStoredCards([card, { id: "c2", root: { type: "nope" } }])).toEqual([card]);
  });
});

// ── buildRenderUiTool ────────────────────────────────────────────────────────

describe("buildRenderUiTool", () => {
  type Exec = (input: unknown) => Promise<string>;
  const execOf = (onCard: (root: GenUiNode | GenUiNode[]) => void): Exec =>
    (buildRenderUiTool({ onCard }).render_ui as unknown as { execute: Exec }).execute;

  it("valid tree → onCard + receipt; invalid → error text, no card", async () => {
    const shown: (GenUiNode | GenUiNode[])[] = [];
    const exec = execOf((r) => shown.push(r));
    expect(await exec({ root: WEATHER })).toBe(DISPLAYED);
    expect(shown).toEqual([WEATHER]);
    expect(await exec({ root: { type: "wat" } })).toContain("invalid render_ui input");
    expect(shown).toHaveLength(1);
  });

  it(`caps at ${CARD_BUDGET} cards per turn`, async () => {
    let n = 0;
    const exec = execOf(() => (n += 1));
    for (let i = 0; i < CARD_BUDGET; i++) expect(await exec({ root: { type: "text", text: `t${i}` } })).toBe(DISPLAYED);
    expect(await exec({ root: { type: "text", text: "one too many" } })).toContain("maximum");
    expect(n).toBe(CARD_BUDGET);
  });
});

// ── route level ──────────────────────────────────────────────────────────────

describe("/api/chat render_ui", () => {
  const GOOD_ARGS = JSON.stringify({ root: WEATHER });

  beforeEach(() => {
    // the budget test drives 6 tool-dispatch steps: above the MCP default
    setSetting("mcp.maxToolRounds", String(CARD_BUDGET + 2));
  });

  it("card streams as data-card between the text and lands in meta.cards, interleaved", async () => {
    const mock = scripted(
      () => sseToolCall("render_ui", "r1", GOOD_ARGS, "Look:"),
      () => sseChatCompletion("Done."),
    );
    const res = await post({});
    const chunks = await drainUi(res);

    const cards = uiData<{ id: string; root: { title?: string } }>(chunks, "data-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.root.title).toBe("Weather");
    expect(uiText(chunks)).toBe("Look:Done.");
    // order: the text lead closes before the card part, then the tail text
    const types = chunks.map((c) => c.type);
    expect(types.indexOf("data-card")).toBeGreaterThan(types.indexOf("text-delta"));
    expect(types.lastIndexOf("text-delta")).toBeGreaterThan(types.indexOf("data-card"));

    // persisted: flat cards + interleaved parts, and the model saw the receipt
    const row = assistantRow()[0]!;
    const meta = JSON.parse(row.metaJson!) as {
      cards: { id: string; root: unknown }[];
      parts: unknown[];
    };
    expect(meta.cards).toEqual([{ id: cards[0]!.id, root: WEATHER }]);
    expect(meta.parts).toEqual([
      { type: "text", text: "Look:" },
      { type: "card" },
      { type: "text", text: "Done." },
    ]);
    expect(toolContents(mock)).toContain(DISPLAYED);
  });

  it("invalid tree: no chunk, the model gets the validation error and recovers", async () => {
    const mock = scripted(
      () => sseToolCall("render_ui", "r1", JSON.stringify({ root: { type: "chart", chart: "pie" } })),
      () => sseChatCompletion("sorry, here is text instead"),
    );
    const res = await post({});
    const chunks = await drainUi(res);
    expect(chunks.some((c) => c.type === "data-card")).toBe(false);
    expect(uiText(chunks)).toBe("sorry, here is text instead");
    expect(toolContents(mock)).toContain("invalid render_ui input");
    expect(assistantRow()[0]!.metaJson).not.toContain("cards");
  });

  it("a card with no text is output, not an empty_response", async () => {
    scripted(
      () => sseToolCall("render_ui", "r1", GOOD_ARGS),
      () => sseRes(sseLine({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n"),
    );
    const res = await post({});
    const chunks: UiChunk[] = await drainUi(res);
    expect(chunks.some((c) => c.type === "data-card")).toBe(true);
    expect(chunks.some((c) => c.type === "data-error")).toBe(false);
    const row = assistantRow()[0]!;
    expect(row.content).toBe("");
    expect((JSON.parse(row.metaJson!) as { cards: unknown[] }).cards).toHaveLength(1);
  });

  it("card budget: the 7th call in one turn is refused to the model, nothing renders", async () => {
    // calls 1..7 emit a render_ui call (the 7th trips the budget), call 8 wraps up
    const handlers = Array.from({ length: CARD_BUDGET + 2 }, (_h, i) =>
      i <= CARD_BUDGET
        ? () => sseToolCall("render_ui", `r${i}`, GOOD_ARGS)
        : () => sseChatCompletion("ok"),
    );
    const mock = scripted(...handlers);
    const res = await post({});
    const chunks = await drainUi(res);
    expect(uiData(chunks, "data-card")).toHaveLength(CARD_BUDGET);
    const lastBody = mock.calls.filter((c) => c.url.includes(CHAT)).at(-1)!.body!;
    expect(lastBody).toContain(`${CARD_BUDGET} cards per reply maximum`);
  });

  it("interactive:false + cards:true: render_ui is offered but the asks are not", async () => {
    const mock = scripted(() => sseToolCall("render_ui", "r1", GOOD_ARGS), () => sseChatCompletion("carded"));
    const res = await post({ interactive: false, cards: true });
    const chunks = await drainUi(res);
    expect(uiData(chunks, "data-card")).toHaveLength(1);
    expect(chunks.some((c) => c.type.startsWith("tool-input-"))).toBe(false);
    const body = JSON.parse(mock.lastCall(CHAT)!.body!) as { tools: { function: { name: string } }[] };
    expect(body.tools.map((t) => t.function.name)).toEqual(["render_ui"]);
  });

  it("interactive:false: the model never sees render_ui", async () => {
    const mock = scripted(() => sseChatCompletion("plain"));
    const res = await post({ interactive: false });
    expect(uiText(await drainUi(res))).toBe("plain");
    const body = JSON.parse(mock.lastCall(CHAT)!.body!) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });
});
