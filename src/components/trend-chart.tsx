/**
 * TrendCard — the Team page's restrained line chart (hand-rolled SVG, no
 * chart library). Design language: hairline axes, no chartjunk. Null values
 * (thin buckets) leave an honest gap in the line — never a fabricated zero.
 * Data arrives fully computed from the metrics layer; this component only
 * draws.
 */
import { formatDuration } from "~/server/metrics/report-text";

export type TrendUnit = "int" | "pct" | "duration";

export interface TrendCardProps {
  title: string;
  points: { label: string; value: number | null }[];
  unit: TrendUnit;
  /** Dashed horizontal reference line (e.g. weekly lead budget on Lead Volume). */
  refLine?: { value: number; label: string } | null;
  /** Small footnote under the chart (e.g. bucketing / thin-bucket rules). */
  note?: string | null;
  /**
   * Full-width variant (Team page Lead Volume module): wider viewBox so the
   * chart gains horizontal room without scaling the text/strokes up.
   */
  wide?: boolean;
}

function fmt(v: number, unit: TrendUnit): string {
  if (unit === "pct") return `${Math.round(v * 100)}%`;
  if (unit === "duration") return formatDuration(v);
  return String(Math.round(v));
}

// SVG geometry (viewBox units; scales with the card width). `wide` trades
// viewBox width for horizontal room on full-width cards.
const W = 340;
const WIDE_W = 720;
const H = 148;
const M = { l: 40, r: 10, t: 12, b: 20 };

export function TrendCard({ title, points, unit, refLine, note, wide }: TrendCardProps) {
  const w = wide ? WIDE_W : W;
  const PW = w - M.l - M.r;
  const PH = H - M.t - M.b;
  const values = points.map((p) => p.value);
  const hasData = values.some((v) => v != null);
  const latest = [...values].reverse().find((v): v is number => v != null) ?? null;

  const x = (i: number) => (points.length <= 1 ? M.l + PW / 2 : M.l + (i / (points.length - 1)) * PW);

  const maxVal = Math.max(
    1,
    ...values.filter((v): v is number => v != null),
    refLine?.value ?? 0,
  );
  const yMax = maxVal * 1.08;
  const y = (v: number) => M.t + PH - (v / yMax) * PH;

  // contiguous non-null runs → polyline segments (nulls break the line)
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
    } else {
      current.push(`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
    }
  });
  if (current.length) segments.push(current.join(" "));

  // sparse x labels (≤ 7 on standard cards, ≤ 10 when wide), anchored to avoid clipping
  const labelStep = Math.max(1, Math.ceil(points.length / (wide ? 10 : 7)));

  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium text-stone-600">{title}</p>
        <p className="text-2xl font-semibold tracking-tight tabular-nums text-stone-900">
          {latest == null ? "—" : fmt(latest, unit)}
        </p>
      </div>
      <svg viewBox={`0 0 ${w} ${H}`} className="mt-2 w-full" role="img" aria-label={`${title} trend`}>
        {hasData ? (
          <>
            {/* hairline gridlines + y labels */}
            {[1, 0.5, 0].map((f) => {
              const gy = M.t + PH - f * PH;
              return (
                <g key={f}>
                  <line x1={M.l} y1={gy} x2={w - M.r} y2={gy} stroke="#e7e5e4" strokeWidth="0.75" />
                  <text x={M.l - 5} y={gy + 2.5} textAnchor="end" fontSize="8" fill="#a8a29e">
                    {fmt(yMax * f, unit)}
                  </text>
                </g>
              );
            })}
            {/* reference line (e.g. weekly lead budget) */}
            {refLine && refLine.value > 0 && (
              <g>
                <line
                  x1={M.l}
                  y1={y(refLine.value)}
                  x2={w - M.r}
                  y2={y(refLine.value)}
                  stroke="#a8a29e"
                  strokeWidth="0.9"
                  strokeDasharray="4 3"
                />
                <text x={w - M.r} y={y(refLine.value) - 3} textAnchor="end" fontSize="8" fill="#78716c">
                  {refLine.label}
                </text>
              </g>
            )}
            {/* series line + dots */}
            {segments.map((seg, i) => (
              <polyline key={i} points={seg} fill="none" stroke="#1c1917" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {points.map((p, i) =>
              p.value == null ? null : <circle key={i} cx={x(i)} cy={y(p.value)} r="2" fill="#1c1917" />,
            )}
            {/* x labels */}
            {points.map((p, i) =>
              i % labelStep === 0 || i === points.length - 1 ? (
                <text
                  key={i}
                  x={x(i)}
                  y={H - 6}
                  textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                  fontSize="8"
                  fill="#a8a29e"
                >
                  {p.label}
                </text>
              ) : null,
            )}
          </>
        ) : (
          <g>
            <line x1={M.l} y1={M.t} x2={M.l} y2={M.t + PH} stroke="#e7e5e4" strokeWidth="0.75" />
            <line x1={M.l} y1={M.t + PH} x2={w - M.r} y2={M.t + PH} stroke="#e7e5e4" strokeWidth="0.75" />
            <text x={M.l + PW / 2} y={M.t + PH / 2} textAnchor="middle" fontSize="10" fill="#a8a29e">
              No data in this range
            </text>
          </g>
        )}
      </svg>
      {note && <p className="mt-1 text-[11px] leading-snug text-stone-400">{note}</p>}
    </div>
  );
}
