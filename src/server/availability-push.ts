/**
 * AVAILABILITY REBUILD PR-3 §1 — DATES TO PUSH (owner spec §7, reworked onto
 * the LOCKED hole rule). Pure arithmetic over the range-view payload's days —
 * no engine, no second source: every number is the view payload's (the ONE
 * availability engine's capacity/booked, the ONE hole derivation's holes, the
 * honest displayed open count).
 *
 * OWNER PRIORITY LADDER (spec §7): priority-sorted
 *   (1) holes        — the locked rule's hole count, most first
 *   (2) large open  — more open slots first
 *   (3) low utilization — least-booked first
 *   (4) near-term    — chronological tiebreak
 *
 * Included: FUTURE-or-today days with real capacity (>0) and something to
 * push (holes > 0 or openings > 0). Excluded, never guessed around:
 *   - past days (booked-truth territory — nothing to push into the past),
 *   - closed days (capacity 0 — no schedule to push),
 *   - fully booked days (open 0 AND holes 0 — nothing to fill),
 *   - days whose open count is UNKNOWN (Acuity-uncovered months render "—" —
 *     pushing an unknown count would fabricate; they re-enter once covered).
 */
import { formatDateHuman } from "./date-logic";
import type { AvailabilityRangeDay } from "./page-data";

/** One row of the Dates-to-Push panel. */
export interface AvailabilityPushRow {
  date: string;
  /** "Wed Oct 7" — the owner's example label shape (no year). */
  label: string;
  /** The displayed open count (feed-authoritative / estimated / real 0). */
  openings: number;
  /** The ONE hole derivation's count (locked rule: capacity − booked). */
  holes: number;
  capacity: number;
  booked: number;
  /** booked ÷ capacity (0..1) — capacity > 0 is an inclusion precondition. */
  utilization: number;
}

/**
 * "Wed Oct 7" from "2026-10-07" — weekday short + short month + day-of-month,
 * no year (the owner's §10 per-day line shape; identical to the page's
 * pushDayLabel composition, kept here so the server payload carries it).
 */
export function pushRowLabel(date: string): string {
  return formatDateHuman(date).replace(", ", " ");
}

/**
 * THE push list for one range-view payload. Sorted by the owner's ladder;
 * ties resolve toward near-term. `limit` caps the panel (default 8 — a
 * month-range scan; the legacy 7-day panel used 3, the rebuilt page shows the
 * fuller list the month view makes useful).
 */
export function deriveDatesToPush(days: AvailabilityRangeDay[], today: string, limit = 8): AvailabilityPushRow[] {
  return days
    .filter(
      (d) =>
        d.date >= today &&
        d.totalCapacity > 0 &&
        d.openCount != null &&
        (d.holes > 0 || d.openCount > 0),
    )
    .sort(
      (a, b) =>
        b.holes - a.holes ||
        (b.openCount ?? 0) - (a.openCount ?? 0) ||
        (a.utilization ?? 0) - (b.utilization ?? 0) ||
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0),
    )
    .slice(0, Math.max(0, limit))
    .map((d) => ({
      date: d.date,
      label: pushRowLabel(d.date),
      openings: d.openCount ?? 0,
      holes: d.holes,
      capacity: d.totalCapacity,
      booked: d.booked,
      utilization: d.utilization ?? 0,
    }));
}

/** The range label the panel renders ("visible month October 2026" / "the 14-day window Oct 6 – Oct 19, 2026" / the day's own 14-day window). */
export function pushRangeLabel(
  request: { kind: "month" | "days" | "day"; label: string },
  windowLabel: string,
): string {
  if (request.kind === "month") return `visible month ${request.label}`;
  if (request.kind === "days") return `the 14-day window ${request.label}`;
  return `the 14-day window ${windowLabel}`;
}
