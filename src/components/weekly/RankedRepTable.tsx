import { formatInt, formatPercent } from "~/server/metrics/report-text";
import { InfoTip } from "~/components/InfoTip";

/**
 * REP CONTRIBUTION — ranked table (payload rows are already largest-first).
 * Share of team = rep wins ÷ team total (both payload numbers; presentation
 * ratio). Weekly goal / goal achievement: the weekly payload carries no
 * per-rep goals — honest "—" (owner directive: no new goal logic here).
 *
 * Extracted verbatim from routes/weekly.tsx (decomposition plan step 1) —
 * pure presentational component over the payload, no server logic.
 */
export function RankedRepTable({ rows, unattributed, total }: {
  rows: { rep_id: string; rep_name: string; total: number; manual: number }[];
  unattributed: number;
  total: number;
}) {
  const share = (n: number) => (total > 0 ? Math.min(100, (n / total) * 100) : null);
  return (
    <div className="overflow-x-auto">
      {/* P1-6 (mobile): rank + the two all-dash goal columns hide on phones and
          the table drops its 560px floor, so Rep | Paid bookings | Share fits
          390 without the mid-word clip. The dash columns carry no data ("—"
          only — no per-rep goals in this payload); ≥768 keeps all six columns. */}
      <table className="w-full min-w-[560px] text-sm max-md:min-w-0">
        <thead>
          <tr className="border-b border-(--card-border) text-left text-xs text-(--text-caption)">
            <th scope="col" className="w-8 py-1.5 pr-2 font-medium max-md:hidden" aria-label="Rank" />
            <th scope="col" className="py-1.5 pr-3 font-medium">Rep</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">Paid bookings</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Share of team</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium max-md:hidden">
              <span className="inline-flex items-center gap-1.5">
                Weekly goal
                <InfoTip
                  label="Why per-rep goal columns show —"
                  tip="The weekly report payload doesn't include per-rep weekly goals (those live on the Reps page). The columns stay as honest dashes rather than inventing goal math — owner directive: no new goal logic on this page."
                />
              </span>
            </th>
            <th scope="col" className="py-1.5 text-right font-medium max-md:hidden">Goal achievement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.rep_id} className="border-b border-(--table-border-weak) transition-colors hover:bg-(--surface-3)">
              <td className="py-2 pr-2 text-[12px] font-medium tabular-nums text-(--text-muted) max-md:hidden">{`0${i + 1}`.slice(-2)}</td>
              <td className="py-2 pr-3 font-medium text-(--text-body)">
                {r.rep_name}
                {r.manual > 0 && (
                  <span className="ml-1.5 text-[12px] font-normal text-(--text-muted)">
                    ({r.manual} manual {r.manual === 1 ? "override" : "overrides"})
                  </span>
                )}
              </td>
              <td className="py-2 pr-3 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(r.total)}</td>
              <td className="py-2 pr-3">
                <span className="flex items-center gap-2">
                  <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-(--bar-track)" aria-hidden="true">
                    {share(r.total) != null && (
                      <span className="block h-full rounded-full bg-(--bar-fill)" style={{ width: `${share(r.total)}%` }} />
                    )}
                  </span>
                  <span className="tabular-nums text-(--text-body)">{share(r.total) == null ? "—" : formatPercent(r.total / total)}</span>
                </span>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-(--text-faint) max-md:hidden">—</td>
              <td className="py-2 text-right tabular-nums text-(--text-faint) max-md:hidden">—</td>
            </tr>
          ))}
          {unattributed > 0 && (
            <tr className="border-b border-(--table-border-weak)">
              <td className="py-2 pr-2 max-md:hidden" aria-label="Unattributed" />
              <td className="py-2 pr-3 text-(--text-muted)">Online / unattributed</td>
              <td className="py-2 pr-3 text-right tabular-nums text-(--text-muted)">{formatInt(unattributed)}</td>
              <td className="py-2 pr-3 tabular-nums text-(--text-muted)">{share(unattributed) == null ? "—" : formatPercent(unattributed / total)}</td>
              <td className="py-2 pr-3 max-md:hidden" />
              <td className="py-2 max-md:hidden" />
            </tr>
          )}
          <tr>
            <td className="py-2 pr-2 max-md:hidden" />
            <td className="py-2 pr-3 font-semibold text-(--text-primary)">Team total</td>
            <td className="py-2 pr-3 text-right font-semibold tabular-nums text-(--text-primary)">{formatInt(total)}</td>
            <td className="py-2 pr-3">
              <span className="flex items-center gap-2">
                <span className="h-1 w-14 shrink-0 rounded-full bg-(--bar-fill)" aria-hidden="true" />
                <span className="tabular-nums font-semibold text-(--text-primary)">{total > 0 ? "100.00%" : "—"}</span>
              </span>
            </td>
            <td className="py-2 pr-3 max-md:hidden" />
            <td className="py-2 max-md:hidden" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
