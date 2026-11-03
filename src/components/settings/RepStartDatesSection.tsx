import { useState } from "react";
import type { SettingsData } from "~/routes/settings";

export function RepStartDatesSection({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (entries: { repId: string; date: string | null }[]) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.users.map((u) => [u.id, u.call_start_date ?? ""])),
  );
  const dirty = data.users.some((u) => (draft[u.id] ?? "") !== (u.call_start_date ?? ""));
  return (
    <div className="space-y-3">
      <div>
        <h3 className="section-heading">Rep Start Dates</h3>
        <p className="mt-1 text-[13px] text-(--text-caption)">
          A rep with a future start date stays visible in the roster as <b>Not Yet Active</b>: zero calls expected, no
          coaching flags, no zero-activity alerts, no negative messaging. Normal performance monitoring begins ON the
          start date. Clear a date to monitor the rep from whenever their records begin.
        </p>
      </div>
      <div className="card card-nest space-y-1 p-0">
        {data.users.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-4 border-b border-(--table-border-weak) px-5 py-2.5 last:border-0">
            <span className="text-[13px] font-medium text-(--text-body)">{u.name}</span>
            <input
              type="date"
              aria-label={`Call start date for ${u.name}`}
              className="input-field"
              value={draft[u.id] ?? ""}
              onChange={(e) => setDraft({ ...draft, [u.id]: e.target.value })}
            />
          </div>
        ))}
        <div className="flex justify-end px-5 py-3">
          <button
            className="btn-primary"
            disabled={busy || !dirty}
            onClick={() => onSave(data.users.map((u) => ({ repId: u.id, date: (draft[u.id] ?? "").trim() === "" ? null : draft[u.id] })))}
          >
            Save rep start dates
          </button>
        </div>
      </div>
    </div>
  );
}
