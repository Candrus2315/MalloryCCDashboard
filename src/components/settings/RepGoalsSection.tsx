import { useState } from "react";
import type { SettingsData } from "~/routes/settings";

/** Users ride in the settings payload as id + name (+call_start_date). */
type SettingsUser = { id: string; name: string; call_start_date?: string };
/** Week-picker row from the payload. */
type EditorWeek = { weekStart: string; isCurrent: boolean; label: string; goal: number | null; leadBudget: number | null };
/** One repGoalsByWeek entry. */
type RepGoalRow = { rep_id: string; goal: number };

export function RepGoalsSection({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (weekStart: string, goals: { repId: string; goal: number | null }[]) => void;
}) {
  const [week, setWeek] = useState(data.weekStart);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(data.users.map((u: SettingsUser) => [u.id, String(data.repGoalsByWeek[data.weekStart]?.find((g: RepGoalRow) => g.rep_id === u.id)?.goal ?? "")])));
  const weekRow = data.editorWeeks.find((w: EditorWeek) => w.weekStart === week);
  const teamGoal = weekRow?.goal ?? 79;
  const teamShare = data.repCount > 0 ? teamGoal / data.repCount : null;

  const switchWeek = (w: string) => {
    setWeek(w);
    setDraft(Object.fromEntries(data.users.map((u: SettingsUser) => [u.id, String(data.repGoalsByWeek[w]?.find((g: RepGoalRow) => g.rep_id === u.id)?.goal ?? "")])));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="section-heading">Rep Goals</h3>
          <p className="mt-1 text-[13px] text-(--text-caption)">
            Leave blank to use the team share: {teamGoal} ÷ {data.repCount || "—"} = {teamShare != null ? (Math.round(teamShare * 100) / 100).toFixed(2) : "—"} bookings per rep (labeled on rep pages). Week of {week}.
          </p>
        </div>
        <select aria-label="Rep goals week" className="input-field" value={week} onChange={(e) => switchWeek(e.target.value)}>
          {data.editorWeeks.map((w: EditorWeek) => (
            <option key={w.weekStart} value={w.weekStart}>
              {w.label}
              {w.isCurrent ? " (current)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="card card-nest space-y-1 p-0">
        {data.users.length === 0 && <p className="p-5 text-sm text-(--text-muted)">No reps found — sync HighLevel first.</p>}
        {data.users.map((u: SettingsUser) => {
          const val = draft[u.id] ?? "";
          return (
            <div key={u.id} className="flex items-center justify-between gap-4 border-b border-(--table-border-weak) px-5 py-2.5 last:border-0">
              <span className="text-[13px] font-medium text-(--text-body)">{u.name}</span>
              <div className="flex items-center gap-3">
                {val.trim() === "" ? (
                  <span className="text-xs font-medium uppercase tracking-wide text-(--banner-fg)">team share ≈ {teamShare != null ? (Math.round(teamShare * 100) / 100).toFixed(2) : "—"}</span>
                ) : (
                  <span className="text-xs text-(--text-muted)">own goal</span>
                )}
                <input
                  type="number"
                  placeholder="team share"
                  className="input-field w-24 text-right"
                  value={val}
                  onChange={(e) => setDraft({ ...draft, [u.id]: e.target.value })}
                />
              </div>
            </div>
          );
        })}
        <div className="flex justify-end px-5 py-3">
          <button
            className="btn-primary"
            disabled={busy || data.users.length === 0}
            onClick={() => onSave(week, data.users.map((u: SettingsUser) => ({ repId: u.id, goal: (draft[u.id] ?? "").trim() === "" ? null : Number(draft[u.id]) })))}
          >
            Save rep goals
          </button>
        </div>
      </div>
    </div>
  );
}
