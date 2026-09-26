/**
 * Day-card strip + shared slot reveal panel (today-redesign-spec §3.4).
 * Renders ONE card per available day — the Today payload carries exactly two
 * (today + tomorrow), and the strip grows horizontally when the engineer
 * later extends `openSlots` to `openSlotsByDay` (spec §7.1): no redesign, no
 * placeholders — just pass more `days`.
 *
 * Interaction: click/tap pins a day (`aria-pressed`); on lg+ hover-capable
 * screens, hovering previews another day's slots WITHOUT moving the pin.
 *
 * Status semantics (owner directive): low availability is GOOD for Mallory.
 * Each card carries a precomputed AvailabilityStatusView (ladder + closed
 * test live in today-views.ts — pure and tested); this component only styles
 * the five tones. Closed is never merged into Fully booked.
 */
import { useEffect, useState } from "react";
import { availabilityDayMessage, type AvailabilityStatusView } from "./today-views";

export interface DayCardData {
  /** Stable id — the ET date is ideal once openSlotsByDay lands. */
  key: string;
  /** "Today" / "Tomorrow" (the payload's concrete days). */
  prefix: string;
  /** Short weekday, e.g. "Fri". */
  weekday: string;
  openCount: number;
  slots: string[];
  /** Owner-directed status ladder (today-views.ts): label + tone. */
  status: AvailabilityStatusView;
}

/**
 * Tone → presentation, within the dashboard design language (warm white bg,
 * charcoal type, minimal borders; no aggressive red/green anywhere):
 *   positive (Fully booked) — quiet success: subtle emerald tint
 *   strong   (Nearly full)  — solid charcoal, no color alarm
 *   neutral  (Openings available) — stone, same family as slot chips
 *   attention(Needs bookings) — muted amber, management attention, NOT red
 *   muted    (Closed) — plain gray text, no badge background
 */
const TONE_STYLES: Record<AvailabilityStatusView["tone"], { badge: string; dot: string | null }> = {
  positive: { badge: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-600" },
  strong: { badge: "bg-stone-900 text-white", dot: "bg-stone-300" },
  neutral: { badge: "bg-stone-100 text-stone-500", dot: "bg-stone-400" },
  attention: { badge: "bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  muted: { badge: "text-stone-400", dot: "bg-stone-300" },
};

export function DayCardStrip({ days }: { days: DayCardData[] }) {
  const [selected, setSelected] = useState(days[0]?.key ?? "");
  const [preview, setPreview] = useState<string | null>(null);
  const [canPreview, setCanPreview] = useState(false);

  useEffect(() => {
    // hover-preview is a lg+ desktop affordance only (spec §3.4)
    const mq = window.matchMedia("(min-width: 1024px) and (hover: hover)");
    const update = () => setCanPreview(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const shownKey = canPreview && preview ? preview : selected;
  const shown = days.find((d) => d.key === shownKey) ?? days.find((d) => d.key === selected) ?? days[0];
  const shownMessage = shown ? availabilityDayMessage(shown.status.status) : null;

  return (
    <div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {days.map((d) => {
          const isSelected = d.key === selected;
          const tone = TONE_STYLES[d.status.tone];
          return (
            <button
              key={d.key}
              type="button"
              aria-pressed={isSelected}
              onClick={() => setSelected(d.key)}
              onMouseEnter={() => setPreview(d.key)}
              onMouseLeave={() => setPreview(null)}
              onFocus={() => setPreview(d.key)}
              onBlur={() => setPreview(null)}
              className={`day-card ${isSelected ? "day-card-on" : "day-card-off"}`}
            >
              <span className="block text-[11px] font-medium uppercase tracking-wide text-stone-500">
                {d.prefix} · {d.weekday}
              </span>
              <span className="mt-2 block text-2xl font-semibold tracking-tight text-stone-900 tabular-nums">
                {d.openCount} <span className="text-xs font-normal text-stone-400">open</span>
              </span>
              <span
                className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone.badge}`}
              >
                {tone.dot && <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />}
                {d.status.label}
              </span>
            </button>
          );
        })}
      </div>
      {shown && (
        <div className="mt-3">
          {shownMessage ? (
            <p
              className={`text-sm ${shown.status.status === "closed" ? "text-stone-400" : "font-medium text-stone-700"}`}
            >
              {shownMessage}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {shown.slots.map((s) => (
                <span key={s} className="rounded-md bg-stone-100 px-2 py-1 text-xs font-medium text-stone-600">
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
