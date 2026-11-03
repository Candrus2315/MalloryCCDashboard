import { useState } from "react";
import type { SettingsData } from "~/routes/settings";

/**
 * MONTHLY BOOKING GOAL (owner-approved 2026-09-29): one goal per calendar
 * month, current + next (rep_goals precedent at month grain). Empty → unset —
 * the Weekly report renders an honest "—" until a goal exists; a month NEVER
 * inherits another month's number.
 */
export function MonthlyGoalsSection({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (goals: { month: string; goal: number | null }[]) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.monthlyGoals.map((g) => [g.month, g.goal != null ? String(g.goal) : ""])),
  );
  return (
    <div className="space-y-3">
      <div>
        <h3 className="section-heading">Monthly Booking Goal</h3>
        <p className="mt-1 text-[13px] text-(--text-caption)">
          One booking goal per calendar month (America/New_York) — the Weekly report compares month-to-date paid
          bookings against this month's goal. A month never inherits another month's goal. Clear a field to unset it.
          Changes are audited.
        </p>
      </div>
      <div className="card card-nest space-y-1 p-0">
        {data.monthlyGoals.map((g) => (
          <div key={g.month} className="flex items-center justify-between gap-4 border-b border-(--table-border-weak) px-5 py-2.5 last:border-0">
            <span className="text-[13px] font-medium text-(--text-body)">
              {g.label}
              {g.isCurrent && <span className="ml-2 rounded-full bg-(--chip-current-bg) px-2 py-0.5 text-xs font-medium text-(--chip-current-fg)">current</span>}
              <span className="ml-2 text-xs text-(--text-muted)">{g.month}</span>
            </span>
            <input
              type="number"
              placeholder="not set"
              aria-label={`Booking goal for ${g.label}`}
              className="input-field w-28 text-right"
              value={draft[g.month] ?? ""}
              onChange={(e) => setDraft({ ...draft, [g.month]: e.target.value })}
            />
          </div>
        ))}
        <div className="flex justify-end px-5 py-3">
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() => onSave(data.monthlyGoals.map((g) => ({ month: g.month, goal: (draft[g.month] ?? "").trim() === "" ? null : Number(draft[g.month]) })))}
          >
            Save monthly goals
          </button>
        </div>
      </div>
    </div>
  );
}
