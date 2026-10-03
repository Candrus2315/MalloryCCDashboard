/**
 * Shared page primitives for the command-center composition language
 * (owner redesign directive 2026-10-01 + harmonization pass).
 *
 * These were originally defined per-page on the Daily Report redesign (#26)
 * and copied into Weekly (#27) and the Commission Center (#29/#33). Wave 1 of
 * the harmonization pass hoists them ONCE so every page (Today, shell, and
 * later waves) composes the same sections from the same building blocks:
 *
 *   Panel   — LEVEL 2 content surface (the shared section container)
 *   Eyebrow — the true uppercase micro-label (the only uppercase in a section)
 *   RatioBar — clean progress visualization under a ratio metric
 *
 * Presentation only — zero data logic. All colors route through the global
 * --surface-1/2/3 tokens so light and dark themes stay in step.
 */
import type { ReactNode } from "react";

/** LEVEL 2 content panel — the shared section surface for every page. */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={"rounded-xl border border-(--card-border) bg-(--card-bg) " + className}>{children}</div>;
}

/** True eyebrow label (the only uppercase on a section). */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="kpi-label">{children}</p>;
}

/**
 * Clean progress visualization under a ratio metric. Presentation-only
 * geometry: the SAME ratio the adjacent text shows, clamped to the track;
 * null renders an empty track (missing data stays missing — never plausible).
 */
export function RatioBar({
  ratio,
  height = "h-1.5",
  max = "max-w-xl",
}: {
  ratio: number | null;
  height?: string;
  max?: string;
}) {
  const width = ratio == null || !Number.isFinite(ratio) ? 0 : Math.min(100, Math.max(0, ratio * 100));
  return (
    <div className={`${height} w-full ${max} overflow-hidden rounded-full bg-(--bar-track)`} aria-hidden="true">
      <div className="h-full rounded-full bg-(--bar-fill)" style={{ width: `${width}%` }} />
    </div>
  );
}
