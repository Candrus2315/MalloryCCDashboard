import { weekdayName, formatDateShort } from "~/server/date-logic";
import { formatInt } from "~/server/metrics/report-text";

/**
 * PER-DAY × PER-REP WINS GRID (owner request 2026-10-19) — one row per rep,
 * one column per Mon–Sun ET calendar day (Sat/Sun always shown), plus the
 * online/unattributed line (team total only) and the Team total row.
 * Bucket = booking_win_business_date, the DEPOSIT-paid ET date (Ruling 1/1a):
 * a session HELD Monday whose deposit PAID Saturday shows under Saturday, so
 * weekend deposit activity is visible instead of hiding in the weekly sum.
 * Same wins, same ownership rule as the By-Rep table (rep rows + unattributed);
 * zeros render 0 — a zero day is a computed fact, never blank. Dashboard-only:
 * the copied CC Report text carries none of this.
 *
 * Extracted verbatim from routes/weekly.tsx (decomposition plan step 1) —
 * pure presentational component over the payload, no server logic.
 */
export function DayByRepGrid({ grid }: {
  grid: {
    dates: string[];
    reps: { rep_id: string; rep_name: string; counts: number[]; total: number }[];
    unattributed: number[];
    team: number[];
  };
}) {
  const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
  const unattrTotal = sum(grid.unattributed);
  const cell = (n: number, key: string) => (
    <td
      key={key}
      className={
        "py-2 pr-3 text-right tabular-nums " + (n > 0 ? "text-(--text-primary)" : "text-(--text-muted)")
      }
    >
      {formatInt(n)}
    </td>
  );
  return (
    <div>
      <div className="overflow-x-auto">
        {/* Phone: the grid keeps every day column (that IS the feature) and
            scrolls horizontally — same overflow pattern as the RhythmStrip. */}
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-(--card-border) text-left text-xs text-(--text-caption)">
              <th scope="col" className="py-1.5 pr-3 font-medium">Rep</th>
              {grid.dates.map((d) => (
                <th key={d} scope="col" className="py-1.5 pr-3 text-right font-medium">
                  <span className="block uppercase tracking-wide">{weekdayName(d, false)}</span>
                  <span className="block font-normal tabular-nums text-(--text-muted)">{formatDateShort(d)}</span>
                </th>
              ))}
              <th scope="col" className="py-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {grid.reps.map((r) => (
              <tr key={r.rep_id} className="border-b border-(--table-border-weak) transition-colors hover:bg-(--surface-3)">
                <td className="py-2 pr-3 font-medium text-(--text-body)">{r.rep_name}</td>
                {r.counts.map((n, i) => cell(n, `${r.rep_id}-${grid.dates[i]}`))}
                <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(r.total)}</td>
              </tr>
            ))}
            {unattrTotal > 0 && (
              <tr className="border-b border-(--table-border-weak)">
                <td className="py-2 pr-3 text-(--text-muted)">Online / unattributed</td>
                {grid.unattributed.map((n, i) => cell(n, `unattr-${grid.dates[i]}`))}
                <td className="py-2 text-right tabular-nums text-(--text-muted)">{formatInt(unattrTotal)}</td>
              </tr>
            )}
            <tr>
              <td className="py-2 pr-3 font-semibold text-(--text-primary)">Team total</td>
              {grid.team.map((n, i) => cell(n, `team-${grid.dates[i]}`))}
              <td className="py-2 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(sum(grid.team))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 text-xs text-(--text-muted)">
        Sat/Sun counts are wins whose deposit was PAID that day — the session itself may have been held any earlier day.
      </p>
    </div>
  );
}
