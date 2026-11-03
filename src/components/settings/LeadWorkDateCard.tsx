import { useState } from "react";
import { leadPickerOptionLabel } from "~/components/settings-views";
import type { SettingsData } from "~/routes/settings";

export function LeadWorkDateCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (leadId: string, workDate: string, previousWorkDate: string, reason?: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const [workDate, setWorkDate] = useState(data.today);
  const [reason, setReason] = useState("");
  const lead = data.recentLeads.find((l) => l.id === selected);
  return (
    <div className="card card-nest card-dense space-y-3">
      <p className="section-title">Correct a lead&apos;s work date</p>
      <select className="input-field w-full" value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">Choose a lead (recent cohorts)…</option>
        {data.recentLeads.slice(0, 80).map((l) => (
          <option key={l.id} value={l.id}>
            {leadPickerOptionLabel(l)}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-(--text-caption)">Move to</span>
        <input type="date" className="input-field" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        <input type="text" placeholder="Reason (optional)" className="input-field w-full sm:w-40" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button className="btn-primary w-fit" disabled={busy || !selected || !lead} onClick={() => selected && lead && onSave(selected, workDate, lead.work_date, reason)}>
        Save work date
      </button>
      <p className="text-xs text-(--text-muted)">Operational reporting counts this lead under its work date (Mon folds Fri–Sun) — moving it moves every &quot;leads today&quot; number that includes it.</p>
    </div>
  );
}
