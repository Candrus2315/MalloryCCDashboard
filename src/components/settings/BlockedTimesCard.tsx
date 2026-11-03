import { useState } from "react";
import type { SettingsData } from "~/routes/settings";

export function BlockedTimesCard({ data, busy, onAdd, onRemove }: {
  data: SettingsData;
  busy: boolean;
  onAdd: (payload: { date: string; startHHMM: string; endHHMM: string; reason?: string }) => void;
  onRemove: (id: string, label: string) => void;
}) {
  const [date, setDate] = useState(data.today);
  const [start, setStart] = useState("12:00");
  const [end, setEnd] = useState("13:00");
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-3">
      <p className="text-xs text-(--text-muted)">Concrete availability blocks (manual corrections or imported). Removing one also writes the audit trail.</p>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <input type="date" className="input-field" value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" className="input-field" value={start} onChange={(e) => setStart(e.target.value)} />
        <span className="text-(--text-muted)">–</span>
        <input type="time" className="input-field" value={end} onChange={(e) => setEnd(e.target.value)} />
        <input type="text" placeholder="Reason" className="input-field w-40" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn-primary" disabled={busy} onClick={() => onAdd({ date, startHHMM: start, endHHMM: end, reason })}>
          Add block
        </button>
      </div>
      <div className="space-y-1">
        {data.blockedTimes.length === 0 && <p className="text-xs text-(--text-muted)">No blocked times in the next 30 days.</p>}
        {data.blockedTimes.map((b) => (
          <div key={b.id} className="flex items-center justify-between gap-3 border-b border-(--table-border-weak) pb-1 text-[13px] last:border-0">
            <span>
              {new Date(b.start_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} –{" "}
              {new Date(b.end_at).toLocaleTimeString("en-US", { timeStyle: "short" })}
              {b.reason ? <span className="ml-2 text-(--text-muted)">{b.reason}</span> : null}
            </span>
            <button className="text-xs text-(--neg-text) hover:underline disabled:opacity-50" disabled={busy} onClick={() => onRemove(b.id, `${new Date(b.start_at).toLocaleString("en-US")}${b.reason ? ` (${b.reason})` : ""}`)}>
              remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
