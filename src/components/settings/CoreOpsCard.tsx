import { useState } from "react";
import { InfoTip } from "~/components/InfoTip";
import { NumberField } from "~/components/settings/shared";
import type { SettingsData } from "~/routes/settings";

export function CoreOpsCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (thresholdSeconds: number, windowHours: number) => void;
}) {
  const [threshold, setThreshold] = useState(String(data.settings.meaningful_call_threshold_seconds));
  const [windowHours, setWindowHours] = useState(String(data.settings.attribution_window_hours));
  return (
    <div className="card card-nest card-dense space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <NumberField label="Meaningful Call Threshold (seconds)" value={threshold} onChange={setThreshold} />
        <NumberField label="Booking Attribution Window (hours)" value={windowHours} onChange={setWindowHours} />
        <div>
          <span className="kpi-label flex items-center gap-1.5">
            Operational Time Zone
            <InfoTip tip="Fixed because work_date and reporting are stored in ET." label="Why the time zone is fixed" />
          </span>
          <p className="mt-1 text-sm font-medium text-(--text-primary)">{data.settings.timezone}</p>
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={() => onSave(Number(threshold), Number(windowHours))}>
          Save operational settings
        </button>
      </div>
    </div>
  );
}
