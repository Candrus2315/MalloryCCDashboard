/**
 * AVAILABILITY REBUILD PR-3 §2 — COPY AVAILABILITY formatters (owner spec §10).
 * Pure — byte-frozen output, verified by availability-copy.test.ts (the CC
 * Report copy-test precedent: the exact clipboard bytes are the contract).
 *
 * The owner's Slack-clean example:
 *   AVAILABILITY TO PUSH
 *   Wed Oct 7 — 2 Open | 1 Hole | 80% Full
 *
 * Copy targets: Today / a specific date / Next 7 days / Next 14 days /
 * Dates to Push — each renders the SAME block over its day set (single-day
 * targets render a one-day block). The EXISTING single-day copy sentence
 * (availabilityCopyText in availability-views.ts — "Saturday Availability —
 * 5 appointments remaining: …") is untouched and stays on the Day view.
 *
 * Honesty: a day with an UNKNOWN open count (Acuity-uncovered month) renders
 * "Open —"; a day with no schedule capacity (closed) is excluded from the
 * block entirely — there is nothing to push on a day the studio schedule
 * does not offer, and a fabricated 0 would read as "fully booked".
 */
import { formatDateHuman } from "~/server/date-logic";

/** The minimal day shape the copy formatters read (the view payload's days). */
export interface AvailabilityCopyDay {
  date: string;
  /** The DISPLAYED open count (feed-authoritative / estimated / real 0); null = unknown. */
  openCount: number | null;
  holes: number;
  capacity: number;
  booked: number;
  utilization: number | null;
}

/** Block header — the owner's exact token. */
export const AVAILABILITY_COPY_HEADER = "AVAILABILITY TO PUSH";

/** "Wed Oct 7" — weekday short + short month + day-of-month, no year. */
export function copyDayLabel(date: string): string {
  return formatDateHuman(date).replace(", ", " ");
}

/** Whole-percent utilization, e.g. "80% Full" (null → "—% Full" never happens: closed days are excluded upstream). */
function utilToken(utilization: number | null): string {
  return `${utilization == null ? "—" : String(Math.round(utilization * 100))}% Full`;
}

/**
 * ONE per-day line — the owner's exact shape:
 *   "Wed Oct 7 — 2 Open | 1 Hole | 80% Full"
 * Open never pluralizes ("2 Open"); Hole pluralizes ("1 Hole" / "3 Holes");
 * an unknown open count renders "Open —" (never a fabricated 0).
 */
export function availabilityCopyDayLine(day: AvailabilityCopyDay): string {
  const open = day.openCount == null ? "Open —" : `${day.openCount} Open`;
  const holes = `${day.holes} Hole${day.holes === 1 ? "" : "s"}`;
  return `${copyDayLabel(day.date)} — ${open} | ${holes} | ${utilToken(day.utilization)}`;
}

/**
 * THE multi-day block: header + one line per included day. Closed days
 * (capacity 0) are dropped; everything else in the given order. An EMPTY
 * selection renders the honest nothing-to-push sentence — the header always
 * stands, so a paste into Slack is never headerless.
 */
export function availabilityPushCopy(days: AvailabilityCopyDay[]): string {
  const included = days.filter((d) => d.capacity > 0);
  if (included.length === 0) {
    return `${AVAILABILITY_COPY_HEADER}\nNothing to push — every day is fully booked or closed.`;
  }
  return [AVAILABILITY_COPY_HEADER, ...included.map(availabilityCopyDayLine)].join("\n");
}
