import { useState } from "react";
import { NumberField, WEEKDAYS } from "~/components/settings/shared";
import type { SettingsData } from "~/routes/settings";

/**
 * TWO-BLOCK DAILY SCHEDULE (owner directive 2026-09-27): every weekday carries
 * a morning AND an afternoon hour-block, each with its own active toggle. The
 * stored shape stays a flat AvailabilityRule[] (the engine runs EVERY active
 * rule for the weekday); the editor pairs the two blocks per weekday —
 * canonical order weekday asc, morning (earlier open) first. Blocks missing
 * from a legacy single-rule config appear inactive with the owner's canonical
 * times prefilled — nothing is activated without the owner's toggle.
 */
interface StudioBlockVM {
  active: boolean;
  open: string;
  close: string;
}

const STUDIO_DEFAULT_MORNING = { open: "09:00", close: "13:00" };
const STUDIO_DEFAULT_AFTERNOON = { open: "13:30", close: "18:30" };

function studioHoursToTwoBlockDays(
  stored: { weekday: number; open_time: string; close_time: string; active: boolean }[],
): StudioBlockVM[][] {
  const byDay = new Map<number, { open: string; close: string; active: boolean }[]>();
  for (const r of stored) {
    const list = byDay.get(r.weekday) ?? [];
    list.push({ open: r.open_time, close: r.close_time, active: r.active });
    byDay.set(r.weekday, list);
  }
  return Array.from({ length: 7 }, (_, wd) => {
    const list = (byDay.get(wd) ?? []).sort((a, b) => a.open.localeCompare(b.open));
    const morning = list[0];
    const afternoon = list[1];
    return [
      {
        active: morning?.active ?? false,
        open: morning?.open ?? STUDIO_DEFAULT_MORNING.open,
        close: morning?.close ?? STUDIO_DEFAULT_MORNING.close,
      },
      {
        active: afternoon?.active ?? false,
        open: afternoon?.open ?? STUDIO_DEFAULT_AFTERNOON.open,
        close: afternoon?.close ?? STUDIO_DEFAULT_AFTERNOON.close,
      },
    ];
  });
}

function studioTwoBlockDaysToHours(days: StudioBlockVM[][]): { weekday: number; open_time: string; close_time: string; active: boolean }[] {
  return days.flatMap((blocks, wd) =>
    blocks.map((b) => ({ weekday: wd, open_time: b.open, close_time: b.close, active: b.active })),
  );
}

export function StudioRulesCard({ data, busy, onSave }: {
  data: SettingsData;
  busy: boolean;
  onSave: (payload: { durationMin?: number; slotIntervalMin?: number; paddingMin?: number; hours?: { weekday: number; open_time: string; close_time: string; active: boolean }[] }) => void;
}) {
  const [duration, setDuration] = useState(String(data.settings.studio.appointment_duration_min));
  const [interval, setIntervalMin] = useState(String(data.settings.studio.slot_interval_min));
  const [padding, setPadding] = useState(String(data.settings.studio.padding_min));
  const [days, setDays] = useState<StudioBlockVM[][]>(() => studioHoursToTwoBlockDays(data.settings.studio.hours));
  const activeCount = days.flat().filter((b) => b.active).length;
  return (
    <div className="card card-nest card-dense space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Duration (min)" value={duration} onChange={setDuration} />
        <NumberField label="Slot interval (min)" value={interval} onChange={setIntervalMin} />
        <NumberField label="Padding (min)" value={padding} onChange={setPadding} />
      </div>
      <div className="space-y-1 border-t border-(--table-border-weak) pt-3">
        {/* Column legend only where the three columns actually fit (sm+); on
            phones each day stacks vertically with per-block labels. */}
        <div className="hidden items-center gap-2 text-xs font-medium uppercase tracking-wide text-(--text-muted) sm:flex">
          <span className="w-20 shrink-0">Day</span>
          <span className="w-58 shrink-0">Morning block</span>
          <span className="w-58 shrink-0">Afternoon block</span>
        </div>
        {days.map((blocks, wd) => (
          <div key={wd} className="flex flex-col gap-2 border-b border-(--table-border-weak) py-2 last:border-0 text-[13px] sm:flex-row sm:items-center sm:gap-2 sm:border-0 sm:py-0">
            <span className="w-20 shrink-0 font-medium text-(--text-body)">{WEEKDAYS[wd]}</span>
            <StudioBlockEditor day={WEEKDAYS[wd]} which="Morning" block={blocks[0]} onChange={(b) => setDays(days.map((x, j) => (j === wd ? [b, x[1]] : x)))} />
            <StudioBlockEditor day={WEEKDAYS[wd]} which="Afternoon" block={blocks[1]} onChange={(b) => setDays(days.map((x, j) => (j === wd ? [x[0], b] : x)))} />
          </div>
        ))}
        <p className="pt-1 text-xs text-(--text-muted)">
          Each active block contributes its own hourly slots; {activeCount} active block{activeCount === 1 ? "" : "s"} across the week.
        </p>
      </div>
      <div className="flex justify-end border-t border-(--table-border-weak) pt-3">
        <button className="btn-primary" disabled={busy} onClick={() => onSave({ durationMin: Number(duration), slotIntervalMin: Number(interval), paddingMin: Number(padding), hours: studioTwoBlockDaysToHours(days) })}>
          Save studio rules
        </button>
      </div>
    </div>
  );
}

function StudioBlockEditor({ day, which, block, onChange }: {
  day: string;
  which: "Morning" | "Afternoon";
  block: StudioBlockVM;
  onChange: (b: StudioBlockVM) => void;
}) {
  return (
    <span className="flex w-full items-center gap-1.5 studio-block sm:w-58 sm:shrink-0">
      <span className="w-[74px] shrink-0 text-xs font-medium uppercase tracking-wide text-(--text-muted) sm:hidden">
        {which}
      </span>
      <input
        type="checkbox"
        aria-label={`${which} block active on ${day}`}
        checked={block.active}
        onChange={(e) => onChange({ ...block, active: e.target.checked })}
      />
      <input
        type="time"
        aria-label={`${which} open time on ${day}`}
        className="input-field min-w-0 flex-1 disabled:opacity-50 sm:flex-none"
        value={block.open}
        disabled={!block.active}
        onChange={(e) => onChange({ ...block, open: e.target.value })}
      />
      <span className="shrink-0 text-(--text-muted) studio-dash">–</span>
      <input
        type="time"
        aria-label={`${which} close time on ${day}`}
        className="input-field min-w-0 flex-1 disabled:opacity-50 sm:flex-none"
        value={block.close}
        disabled={!block.active}
        onChange={(e) => onChange({ ...block, close: e.target.value })}
      />
    </span>
  );
}
