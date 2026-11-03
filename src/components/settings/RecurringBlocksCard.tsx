import { useState } from "react";
import { WEEKDAYS } from "~/components/settings/shared";
import type { SettingsData } from "~/routes/settings";

export function RecurringBlocksCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (blocks: { id: string; weekday: number; start_time: string; end_time: string; reason: string | null; active: boolean }[]) => void;
}) {
  const [blocks, setBlocks] = useState(data.settings.studio.recurring_blocks.map((b) => ({ ...b })));
  return (
    <div className="space-y-3">
      <p className="text-xs text-(--text-muted)">Repeat every week on the chosen weekday — e.g. a standing lunch block. Feeds the same open-slot engine as one-off blocks.</p>
      {blocks.map((b, i) => (
        <div key={b.id} className="flex flex-wrap items-center gap-2 text-[13px]">
          <select className="input-field" value={b.weekday} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))}>
            {WEEKDAYS.map((d, wd) => (
              <option key={d} value={wd}>
                {d}
              </option>
            ))}
          </select>
          <input type="time" className="input-field" value={b.start_time} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, start_time: e.target.value } : x)))} />
          <span className="text-(--text-muted)">–</span>
          <input type="time" className="input-field" value={b.end_time} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, end_time: e.target.value } : x)))} />
          <input type="text" placeholder="Reason" className="input-field w-36" value={b.reason ?? ""} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} />
          <label className="flex items-center gap-1 text-(--chip-neutral-fg)">
            <input type="checkbox" checked={b.active} onChange={(e) => setBlocks(blocks.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))} />
            active
          </label>
          <button className="text-xs text-(--neg-text) hover:underline" onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}>
            remove
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button className="btn-secondary text-xs" onClick={() => setBlocks([...blocks, { id: `rb-${Date.now()}`, weekday: 5, start_time: "12:00", end_time: "13:00", reason: "", active: true }])}>
          Add block
        </button>
        <button className="btn-primary" disabled={busy} onClick={() => onSave(blocks)}>
          Save recurring blocks
        </button>
      </div>
    </div>
  );
}
