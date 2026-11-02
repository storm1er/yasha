"use client";

// Tier-1 generative UI renderer (issue #28): draws a validated `render_ui`
// tree (lib/chat/render-ui.ts) inline in the assistant turn. The server has
// already bounded every string and the tree shape, so this component trusts
// its input; NOTHING here executes model code — closed vocabulary only.
// All visible strings are model data except the slides nav (aria), keyed in
// messages/{en,fr}.json.

import { useState } from "react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { ChevronLeft, ChevronRight, Minus, TrendingDown, TrendingUp } from "lucide-react";
import type { GenUiNode, RenderedCard, GenUiSlide } from "@/lib/chat/render-ui";

// recharts stays out of the server render (canvas-free but measurement-based).
const ChartView = dynamic(() => import("@/components/chat/gen-ui-chart"), { ssr: false });

const TONES: Record<string, string> = {
  default: "bg-muted text-muted-foreground",
  info: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  danger: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function SlideView({ slide }: { slide: GenUiSlide }) {
  return (
    <div className="min-w-0">
      {slide.title && <div className="text-sm font-semibold">{slide.title}</div>}
      {slide.body && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
          {slide.body}
        </p>
      )}
      {slide.children && (
        <div className="mt-2 flex flex-col gap-2">
          {slide.children.map((c, i) => (
            <NodeView key={i} node={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function SlidesNode({ slides }: { slides: GenUiSlide[] }) {
  const t = useTranslations("chat");
  const [i, setI] = useState(0);
  const idx = Math.min(i, slides.length - 1);
  return (
    <div className="flex flex-col gap-2">
      <div data-testid="gen-ui-slide" className="min-h-16">
        <SlideView slide={slides[idx]} />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          aria-label={t("genUiPrev")}
          disabled={idx === 0}
          onClick={() => setI(idx - 1)}
          className="rounded-md border p-1 transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={t("genUiNext")}
          disabled={idx >= slides.length - 1}
          onClick={() => setI(idx + 1)}
          className="rounded-md border p-1 transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
        >
          <ChevronRight className="size-3.5" />
        </button>
        <span className="tabular-nums">
          {idx + 1}/{slides.length}
        </span>
      </div>
    </div>
  );
}

function NodeView({ node }: { node: GenUiNode }) {
  switch (node.type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-[13px]">{node.text}</p>
      );
    case "metric":
      return (
        <div className="min-w-0">
          <div className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
            {node.label}
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-semibold tabular-nums">{node.value}</span>
            {node.unit && <span className="text-xs text-muted-foreground">{node.unit}</span>}
            {node.trend === "up" && <TrendingUp className="size-4 text-emerald-500" />}
            {node.trend === "down" && <TrendingDown className="size-4 text-red-500" />}
            {node.trend === "flat" && <Minus className="size-4 text-muted-foreground" />}
          </div>
        </div>
      );
    case "badge":
      return (
        <span
          className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[node.tone ?? "default"] ?? TONES.default}`}
        >
          {node.text}
        </span>
      );
    case "progress":
      return (
        <div className="min-w-0">
          {node.label && (
            <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
              <span className="truncate">{node.label}</span>
              <span className="tabular-nums">{Math.round(node.value)}%</span>
            </div>
          )}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${node.value}%` }}
            />
          </div>
        </div>
      );
    case "list": {
      const ListTag = node.ordered ? "ol" : "ul";
      return (
        <ListTag className="list-inside list-disc space-y-0.5 text-[13px] empty:hidden">
          {node.items.map((it, i) => (
            <li key={i} className="break-words whitespace-pre-wrap">
              {it}
            </li>
          ))}
        </ListTag>
      );
    }
    case "table":
      return (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                {node.columns.map((c, i) => (
                  <th
                    key={i}
                    className="border-b px-2 py-1 text-left font-medium text-muted-foreground"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cellText, c) => (
                    <td key={c} className="border-b px-2 py-1 align-top break-words">
                      {cellText}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "chart":
      return <ChartView node={node} />;
    case "card":
      return (
        <div className="min-w-0 rounded-xl border bg-card p-3 shadow-sm">
          {node.title && <div className="mb-2 text-sm font-medium">{node.title}</div>}
          <div className="flex flex-col gap-2">
            {node.children.map((c, i) => (
              <NodeView key={i} node={c} />
            ))}
          </div>
        </div>
      );
    case "grid":
      return (
        <div
          className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[repeat(var(--cols),minmax(0,1fr))]"
          style={{ "--cols": node.cols ?? 2 } as React.CSSProperties}
        >
          {node.children.map((c, i) => (
            <NodeView key={i} node={c} />
          ))}
        </div>
      );
    case "slides":
      return <SlidesNode slides={node.slides} />;
  }
}

export function GenUiCardView({ card }: { card: RenderedCard }) {
  const roots = Array.isArray(card.root) ? card.root : [card.root];
  return (
    <div
      data-testid="gen-ui-card"
      className="mt-1 flex w-[min(560px,92vw)] min-w-0 flex-col gap-2"
    >
      {roots.map((n, i) => (
        <NodeView key={i} node={n} />
      ))}
    </div>
  );
}
