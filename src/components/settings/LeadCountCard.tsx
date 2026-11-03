import { useState } from "react";
import { formatDateShort } from "~/server/date-logic";
import type { SettingsData } from "~/routes/settings";

export function LeadCountCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (date: string, sheet: string, count: number, reason?: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const key = (d: string, s: string) => `${d}:${s}`;
  const currentWeekRows = data.observedCounts.filter((r) => r.observed > 0 || r.adjustedDelta != null);
  return (
    <div className="card card-nest card-dense space-y-3">
      <p className="section-title">Correct a day&apos;s lead count</p>
      {currentWeekRows.length === 0 && <p className="text-[13px] text-(--text-muted)">No leads observed this week yet.</p>}
      <div className="space-y-1">
        {currentWeekRows.map((r) => {
          const effective = r.observed + (r.adjustedDelta ?? 0);
          const val = drafts[key(r.date, r.sheet)] ?? String(effective);
          return (
            <div key={key(r.date, r.sheet)} className="flex items-center justify-between gap-2 border-b border-(--table-border-weak) pb-1 text-[13px] last:border-0">
              <span>
                {formatDateShort(r.date)} · <span className="capitalize">{r.sheet}</span>
                <span className="ml-2 text-xs text-(--text-muted)">
                  synced {r.observed}
                  {r.adjustedDelta ? ` ${r.adjustedDelta > 0 ? "+" : ""}${r.adjustedDelta}` : ""}
                </span>
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="w-20 input-field text-right text-[13px]"
                  value={val}
                  onChange={(e) => setDrafts({ ...drafts, [key(r.date, r.sheet)]: e.target.value })}
                />
                <button
                  className="btn-secondary text-xs"
                  disabled={busy || Number(val) === effective}
                  onClick={() => onSave(r.date, r.sheet, Number(val), `corrected from ${effective}`)}
                >
                  Save
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-(--text-muted)">Adjustments are deltas vs the synced rows and flow through the metrics layer, so Today, Daily Report and Team agree.</p>
    </div>
  );
}
