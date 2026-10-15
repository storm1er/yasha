import { useId } from "react";
import { cn } from "@/lib/utils";

type SparkleProps = {
  className?: string;
  title?: string;
};

const CLOVER =
  "M12 5.075A5.2 5.2 0 1 0 5.075 12A5.2 5.2 0 1 0 12 18.925A5.2 5.2 0 1 0 18.925 12A5.2 5.2 0 1 0 12 5.075Z";

const POLES: ReadonlyArray<{ cx: number; cy: number; color: string }> = [
  { cx: 12, cy: 4.9, color: "#EA4335" },
  { cx: 12, cy: 19.1, color: "#34A853" },
  { cx: 4.9, cy: 12, color: "#FBBC04" },
  { cx: 19.1, cy: 12, color: "#4285F4" },
];

/**
 * "Melting clover" brand mark: a quatrefoil (four overlapping lobes) painted
 * by four soft radial poles that bleed into each other — up red, left yellow,
 * down green, right blue.
 */
export function Sparkle({ className, title }: SparkleProps) {
  const uid = useId().replace(/:/g, "_");
  const clipId = `${uid}-clover`;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
      className={cn("shrink-0", className)}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={clipId}>
          <path d={CLOVER} />
        </clipPath>
        {POLES.map((p, i) => (
          <radialGradient
            key={p.color}
            id={`${uid}-${i}`}
            cx={p.cx}
            cy={p.cy}
            r="10"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor={p.color} />
            <stop offset=".3" stopColor={p.color} stopOpacity=".92" />
            <stop offset=".62" stopColor={p.color} stopOpacity=".5" />
            <stop offset="1" stopColor={p.color} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {POLES.map((p, i) => (
          <rect key={p.color} width="24" height="24" fill={`url(#${uid}-${i})`} />
        ))}
      </g>
    </svg>
  );
}
