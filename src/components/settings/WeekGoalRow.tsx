import { useState } from "react";

export interface EditorWeek {
  weekStart: string;
  isCurrent: boolean;
  label: string;
  goal: number | null;
  leadBudget: number | null;
}

export function WeekGoalRow({ week, busy, onSave }: { week: EditorWeek; busy: boolean; onSave: (goal: number, budget: number) => void }) {
  const [goal, setGoal] = useState(String(week.goal ?? 79));
  const [budget, setBudget] = useState(String(week.leadBudget ?? 700));
  return (
    <tr className={week.isCurrent ? "bg-(--row-highlight)" : ""}>
      <td className="sticky left-0 bg-(--card-bg)">
        <span className="font-medium text-(--text-primary)">{week.label}</span>
        {week.isCurrent && <span className="ml-2 rounded-full bg-(--chip-current-bg) px-2 py-0.5 text-xs font-medium text-(--chip-current-fg)">current</span>}
        <span className="ml-2 text-xs text-(--text-muted)">{week.weekStart}</span>
      </td>
      <td className="text-right">
        <input type="number" className="input-field w-24 text-right" value={goal} onChange={(e) => setGoal(e.target.value)} />
      </td>
      <td className="text-right">
        <input type="number" className="input-field w-24 text-right" value={budget} onChange={(e) => setBudget(e.target.value)} />
      </td>
      <td className="text-right">
        <button className="btn-secondary text-xs" disabled={busy} onClick={() => onSave(Number(goal), Number(budget))}>
          Save
        </button>
      </td>
    </tr>
  );
}
