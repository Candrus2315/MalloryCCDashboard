import { weekdayName, formatDateShort } from "~/server/date-logic";
import { formatInt } from "~/server/metrics/report-text";

/**
 * DAILY BOOKING RHYTHM — one Mon–Sun strip, bottom-anchored proportional bars.
 * Bar heights are the presentation-only share of the week's strongest day; the
 * printed count is always the payload's exact number. Zero days read quiet
 * (a bare rail + a muted 0), never dominant.
 *
 * Extracted verbatim from routes/weekly.tsx (decomposition plan step 1) —
 * pure presentational component over the payload, no server logic.
 */
export function RhythmStrip({ daily }: { daily: { date: string; count: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  return (
    <div className="overflow-x-auto">
      {/* P1-8 (mobile): the 7-col strip scrolls past MON–THU at 390 — phones get
          the same cells wrapped 4+3 (7 items in grid-cols-4). Same bars, same
          numbers, same labels; ≥768 keeps the single-row strip byte-identical. */}
      <div className="grid min-w-[560px] grid-cols-7 gap-3 max-md:min-w-0 max-md:grid-cols-4">
        {daily.map((d) => (
          <div key={d.date} className="min-w-0">
            <p className="text-[12px] font-medium uppercase tracking-wide text-(--text-caption)">
              {weekdayName(d.date, false)}
            </p>
            <p className="text-[12px] tabular-nums text-(--text-muted)">{formatDateShort(d.date)}</p>
            <div className="mt-2 flex h-14 items-end border-b border-(--table-border-weak)" aria-hidden="true">
              <div
                className="w-full rounded-t-sm bg-(--bar-fill)"
                style={{ height: `${Math.max(0, Math.min(100, (d.count / max) * 100))}%` }}
              />
            </div>
            <p
              className={
                "mt-1.5 text-lg font-semibold tracking-tight tabular-nums " +
                (d.count > 0 ? "text-(--text-primary)" : "text-(--text-muted)")
              }
            >
              {formatInt(d.count)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
