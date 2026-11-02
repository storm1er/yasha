"use client";

// recharts wrapper for the tier-1 `chart` node (issue #28). Dynamically
// imported from gen-ui.tsx (ssr: false) so the library never runs server-side.
// Data is already validated (1..60 {label, value} points, lib/chat/render-ui.ts).

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { GenUiChart } from "@/lib/chat/render-ui";

const PRIMARY = "var(--color-primary)";
const DONUT_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899"];
const AXIS = { fontSize: 11, fill: "currentColor" } as const;

export default function ChartView({ node }: { node: GenUiChart }) {
  return (
    <figure className="min-w-0">
      {(node.title || node.unit) && (
        <figcaption className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
          <span className="font-medium">{node.title}</span>
          {node.unit && <span className="text-muted-foreground">{node.unit}</span>}
        </figcaption>
      )}
      <div className="h-44 w-full min-w-0 text-muted-foreground">
        <ResponsiveContainer width="100%" height="100%">
          {node.chart === "bar" ? (
            <BarChart data={node.data} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} />
              <Tooltip
                cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
                contentStyle={{ background: "var(--color-popover)", borderColor: "var(--color-border)", borderRadius: 8, fontSize: 12 }}
              />
              <Bar dataKey="value" fill={PRIMARY} radius={[3, 3, 0, 0]} maxBarSize={40} />
            </BarChart>
          ) : node.chart === "line" ? (
            <LineChart data={node.data} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} />
              <Tooltip
                contentStyle={{ background: "var(--color-popover)", borderColor: "var(--color-border)", borderRadius: 8, fontSize: 12 }}
              />
              <Line type="monotone" dataKey="value" stroke={PRIMARY} strokeWidth={2} dot={false} />
            </LineChart>
          ) : node.chart === "area" ? (
            <AreaChart data={node.data} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} vertical={false} />
              <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} />
              <Tooltip
                contentStyle={{ background: "var(--color-popover)", borderColor: "var(--color-border)", borderRadius: 8, fontSize: 12 }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={PRIMARY}
                fill={PRIMARY}
                fillOpacity={0.15}
                strokeWidth={2}
              />
            </AreaChart>
          ) : (
            <PieChart>
              <Tooltip
                contentStyle={{ background: "var(--color-popover)", borderColor: "var(--color-border)", borderRadius: 8, fontSize: 12 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                iconType="circle"
                iconSize={8}
              />
              <Pie
                data={node.data}
                dataKey="value"
                nameKey="label"
                innerRadius="55%"
                outerRadius="85%"
                strokeWidth={0}
              >
                {node.data.map((_, i) => (
                  <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
