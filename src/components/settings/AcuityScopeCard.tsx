import { useState } from "react";
import type { SettingsData } from "~/routes/settings";

export function AcuityScopeCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (calendars: string[], types: string[]) => void;
}) {
  // The catalog comes from the (demo) adapter; once Acuity credentials arrive
  // this card lists the real calendars/types without UI changes.
  const [calendars, setCalendars] = useState<string[]>(data.settings.acuity.calendars_included);
  const [types, setTypes] = useState<string[]>(data.settings.acuity.types_included);
  const catalogCalendars: { id: string; name: string }[] = [
    { id: "Family Studio", name: "Family Studio" },
    { id: "Animalia Studio", name: "Animalia Studio" },
    { id: "Fairyland Studio", name: "Fairyland Studio" },
  ];
  const catalogTypes = [
    "Family Portrait Session",
    "Family Mini Session",
    "Holiday Family Session",
    "Animalia Signature Session",
    "Animalia Pet Portrait",
    "Animalia Companion Session",
    "Fairyland Signature Session",
    "Fairyland Character Portrait",
    "Fairyland Enchanted Session",
  ];
  const toggle = (list: string[], v: string, set: (l: string[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="card card-nest card-dense space-y-4">
      <p className="text-xs text-(--text-muted)">
        Only selected calendars and types count toward CC reporting (demo catalog until Acuity connects).{" "}
        <span className="font-medium text-(--banner-fg)">Empty selection = everything counts.</span>
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <p className="kpi-label mb-1">Calendars</p>
          <div className="space-y-1">
            {catalogCalendars.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-[13px] text-(--text-body)">
                <input type="checkbox" checked={calendars.length === 0 || calendars.includes(c.id)} disabled={calendars.length === 0} onChange={() => toggle(calendars, c.id, setCalendars)} />
                {c.name}
              </label>
            ))}
            {calendars.length === 0 && <p className="text-xs text-(--banner-fg)">No calendars selected — all are included.</p>}
          </div>
        </div>
        <div>
          <p className="kpi-label mb-1">Appointment types</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {catalogTypes.map((t) => (
              <label key={t} className="flex items-center gap-2 text-[13px] text-(--text-body)">
                <input type="checkbox" checked={types.length === 0 || types.includes(t)} disabled={types.length === 0} onChange={() => toggle(types, t, setTypes)} />
                <span className="truncate">{t}</span>
              </label>
            ))}
          </div>
          {types.length === 0 && <p className="text-xs text-(--banner-fg)">No types selected — all are included.</p>}
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={() => onSave(calendars, types)}>
          Save Acuity scope
        </button>
      </div>
    </div>
  );
}
