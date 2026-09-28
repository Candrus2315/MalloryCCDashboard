/**
 * TrendCard — the Team page's restrained line chart (hand-rolled SVG, no
 * chart library). Design language: hairline axes, no chartjunk. Null values
 * (thin buckets) leave an honest gap in the line — never a fabricated zero.
 * Data arrives fully computed from the metrics layer; this component only
 * draws.
 *
 * Phase 3 evolution (all additive — omit the new props and behavior is
 * unchanged): hover-scrub with a snapped guide line + active dot + an HTML
 * tooltip composed by the caller (`tooltip`), honesty markers via `meta`
 * (hollow points on non-working days, dashed ring on the in-progress bucket),
 * and click/keyboard drill-down via `onPointClick`. Colors come from the
 * `--chart-*` tokens (app.css) instead of hardcoded hex.
 */
import { useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { formatDuration } from "~/server/metrics/report-text";
import { InfoTip } from "./InfoTip";

export type TrendUnit = "int" | "pct" | "duration";

export interface TrendPointMeta {
  /** Bucket id (TrendPoint.key). */
  key: string;
  /** In-progress day/week → dashed ring + tooltip marker. */
  isPartial?: boolean;
  /** Non-working day → hollow point, never a fake zero. */
  isNonWorking?: boolean;
  /** Lead split (E1) — carried for callers that compose split tooltips. */
  family?: number | null;
  animalia?: number | null;
}

export interface TrendTooltipView {
  title: string;
  lines: string[];
}

export interface TrendCardProps {
  title: string;
  points: { label: string; value: number | null }[];
  unit: TrendUnit;
  /** Dashed horizontal reference line (e.g. weekly lead budget on Lead Volume). */
  refLine?: { value: number; label: string } | null;
  /** Small footnote under the chart (data-honesty states only — e.g. thin-bucket rule). */
  note?: string | null;
  /**
   * Definition/methodology copy — rendered behind the shared InfoTip beside the
   * title instead of as a permanent line (microcopy pass 2026-09-28).
   */
  info?: string | null;
  /**
   * Full-width variant (Team page Lead Volume module): wider viewBox so the
   * chart gains horizontal room without scaling the text/strokes up.
   */
  wide?: boolean;
  /** Per-point honesty markers; index-aligned with `points`. */
  meta?: (TrendPointMeta | null)[];
  /** Omit → points are not clickable. Receives the snapped point index. */
  onPointClick?: (index: number) => void;
  /** Hover tooltip content, composed by the caller from the metrics layer. */
  tooltip?: (index: number) => TrendTooltipView | null;
}

function fmt(v: number, unit: TrendUnit): string {
  if (unit === "pct") return `${Math.round(v * 100)}%`;
  if (unit === "duration") return formatDuration(v);
  return String(Math.round(v));
}

// SVG geometry (viewBox units; scales with the card width). `wide` trades
// viewBox width for horizontal room on full-width cards. Phase 3: taller plot
// (148 → 176 standard / 200 wide) so the chart fills more of the card (§4).
const W = 340;
const WIDE_W = 720;
const H = 176;
const WIDE_H = 200;
const M = { l: 40, r: 10, t: 12, b: 20 };

export function TrendCard({ title, points, unit, refLine, note, info, wide, meta, onPointClick, tooltip }: TrendCardProps) {
  const w = wide ? WIDE_W : W;
  const h = wide ? WIDE_H : H;
  const PW = w - M.l - M.r;
  const PH = h - M.t - M.b;
  const values = points.map((p) => p.value);
  const hasData = values.some((v) => v != null);
  const latest = [...values].reverse().find((v): v is number => v != null) ?? null;
  const interactive = !!(tooltip || onPointClick);

  // hover-scrub state: snapped point index under the pointer / keyboard focus
  const [hover, setHover] = useState<number | null>(null);

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

  // pointer position → nearest-point index (horizontal snap, clamped)
  const indexFromPointer = (
    e: ReactPointerEvent<SVGSVGElement> | ReactMouseEvent<SVGSVGElement>,
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return null;
    const vbX = ((e.clientX - rect.left) * w) / rect.width;
    if (points.length < 2) return 0;
    const step = PW / (points.length - 1);
    return Math.max(0, Math.min(points.length - 1, Math.round((vbX - M.l) / step)));
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    setHover(indexFromPointer(e));
  };
  const onClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!onPointClick) return;
    const i = indexFromPointer(e);
    if (i != null) onPointClick(i);
  };

  const hoverPoint = hover != null ? points[hover] : null;
  const hoverMeta = hover != null ? meta?.[hover] ?? null : null;
  const tip = hover != null && tooltip ? tooltip(hover) : null;
  // HTML tooltip x: follow the snapped point, clamped inside the card edges
  const tipLeftPct = hover != null ? (x(hover) / w) * 100 : 0;

  const dotProps = (i: number) => {
    const m = meta?.[i] ?? null;
    return {
      hollow: m?.isNonWorking === true,
      partial: m?.isPartial === true,
    };
  };

  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <p className="truncate text-[13px] font-medium text-(--chip-neutral-fg)">{title}</p>
          {info && <InfoTip tip={info} label={`About ${title}`} />}
        </span>
        <p className="text-2xl font-semibold tracking-tight tabular-nums text-(--text-primary)">
          {latest == null ? "—" : fmt(latest, unit)}
        </p>
      </div>
      <div className="relative mt-2">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className={"w-full " + (onPointClick ? "cursor-pointer" : "")}
          role="img"
          aria-label={`${title} trend`}
          onPointerMove={interactive ? onMove : undefined}
          onPointerLeave={interactive ? () => setHover(null) : undefined}
          onClick={onPointClick ? onClick : undefined}
        >
          {hasData ? (
            <>
              {/* hairline gridlines + y labels */}
              {[1, 0.5, 0].map((f) => {
                const gy = M.t + PH - f * PH;
                return (
                  <g key={f}>
                    <line x1={M.l} y1={gy} x2={w - M.r} y2={gy} stroke="var(--chart-grid)" strokeWidth="0.75" />
                    <text x={M.l - 5} y={gy + 2.5} textAnchor="end" fontSize="8" fill="var(--chart-label)">
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
                    stroke="var(--chart-ref)"
                    strokeWidth="0.9"
                    strokeDasharray="4 3"
                  />
                  <text x={w - M.r} y={y(refLine.value) - 3} textAnchor="end" fontSize="8" fill="var(--chart-ref-label)">
                    {refLine.label}
                  </text>
                </g>
              )}
              {/* series line + dots */}
              {segments.map((seg, i) => (
                <polyline
                  key={i}
                  points={seg}
                  fill="none"
                  stroke="var(--chart-line)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
              {points.map((p, i) => {
                if (p.value == null) return null;
                const { hollow, partial } = dotProps(i);
                return (
                  <circle
                    key={i}
                    cx={x(i)}
                    cy={y(p.value)}
                    r="2"
                    fill={hollow ? "var(--card-bg)" : "var(--chart-dot)"}
                    stroke={hollow ? "var(--chart-dot)" : "none"}
                    strokeWidth={hollow ? 1.25 : 0}
                  />
                );
              })}
              {/* partial-bucket honesty marker: dashed ring on the in-progress point */}
              {points.map((p, i) => {
                if (p.value == null || !dotProps(i).partial) return null;
                return (
                  <circle
                    key={`partial-${i}`}
                    cx={x(i)}
                    cy={y(p.value)}
                    r="5.5"
                    fill="none"
                    stroke="var(--chart-label)"
                    strokeWidth="0.9"
                    strokeDasharray="2 2"
                  />
                );
              })}
              {/* hover guide line + active dot (enlarged, with ring) */}
              {hover != null && hoverPoint && (
                <g aria-hidden="true">
                  <line
                    x1={x(hover)}
                    y1={M.t}
                    x2={x(hover)}
                    y2={M.t + PH}
                    stroke="var(--chart-guide)"
                    strokeWidth="1"
                  />
                  {hoverPoint.value != null && (
                    <>
                      <circle cx={x(hover)} cy={y(hoverPoint.value)} r="7" fill="none" stroke="var(--chart-dot)" strokeOpacity="0.25" />
                      <circle
                        cx={x(hover)}
                        cy={y(hoverPoint.value)}
                        r="3.5"
                        fill={hoverMeta?.isNonWorking ? "var(--card-bg)" : "var(--chart-dot)"}
                        stroke={hoverMeta?.isNonWorking ? "var(--chart-dot)" : "none"}
                        strokeWidth={hoverMeta?.isNonWorking ? 1.25 : 0}
                      />
                    </>
                  )}
                </g>
              )}
              {/* x labels */}
              {points.map((p, i) =>
                i % labelStep === 0 || i === points.length - 1 ? (
                  <text
                    key={i}
                    x={x(i)}
                    y={h - 6}
                    textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                    fontSize="8"
                    fill="var(--chart-label)"
                  >
                    {p.label}
                  </text>
                ) : null,
              )}
              {/* keyboard/touch (§14): invisible per-point targets; Enter/Space
                  drills down; pointer-events none so the scrub layer owns mouse */}
              {onPointClick &&
                points.map((p, i) => {
                  if (p.value == null) return null;
                  const m = meta?.[i] ?? null;
                  const label =
                    `${p.label}: ${fmt(p.value, unit)}` +
                    (m?.isPartial ? " (in progress)" : "") +
                    (m?.isNonWorking ? " (closed)" : "");
                  return (
                    <circle
                      key={`kb-${i}`}
                      cx={x(i)}
                      cy={y(p.value)}
                      r="9"
                      fill="transparent"
                      tabIndex={0}
                      role="button"
                      aria-label={`${title} — ${label}. Opens details.`}
                      style={{ cursor: "pointer" }}
                      pointerEvents="none"
                      onFocus={() => setHover(i)}
                      onBlur={() => setHover((cur) => (cur === i ? null : cur))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onPointClick(i);
                        }
                      }}
                    />
                  );
                })}
            </>
          ) : (
            <g>
              <line x1={M.l} y1={M.t} x2={M.l} y2={M.t + PH} stroke="var(--chart-grid)" strokeWidth="0.75" />
              <line x1={M.l} y1={M.t + PH} x2={w - M.r} y2={M.t + PH} stroke="var(--chart-grid)" strokeWidth="0.75" />
              <text x={M.l + PW / 2} y={M.t + PH / 2} textAnchor="middle" fontSize="10" fill="var(--chart-label)">
                No data in this range
              </text>
            </g>
          )}
        </svg>
        {/* HTML tooltip — clamped to the card edges, pointer-transparent */}
        {tip && (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-[130px] max-w-[230px] -translate-x-1/2 rounded-lg border border-(--card-border) bg-(--card-bg) px-2.5 py-1.5 shadow-md"
            style={{
              left: `clamp(74px, ${tipLeftPct}%, calc(100% - 74px))`,
              backgroundColor: "var(--card-bg)",
            }}
          >
            <p className="text-xs font-semibold text-(--text-primary)">{tip.title}</p>
            {tip.lines.map((line, i) => (
              <p key={i} className="mt-0.5 text-xs leading-snug tabular-nums text-(--chip-neutral-fg)">
                {line}
              </p>
            ))}
          </div>
        )}
      </div>
      {note && <p className="mt-1 text-xs leading-snug text-(--text-muted)">{note}</p>}
    </div>
  );
}
