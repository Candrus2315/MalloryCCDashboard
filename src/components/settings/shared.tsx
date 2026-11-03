// Decomposition plan step 2: shared settings scaffolding moved verbatim from
// routes/settings.tsx — NumberField is used by CoreOpsCard + StudioRulesCard,
// WEEKDAYS by StudioRulesCard + RecurringBlocksCard.
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ================= shared field ================= */

export function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="kpi-label">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input-field mt-1 w-full"
      />
    </label>
  );
}
