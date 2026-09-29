/**
 * WEEKLY REPORT helpers (pure) — the owner's Monday leadership report
 * (owner directive 2026-09-29). ONE page answers "last week + month to date"
 * without hand-pulled SQL.
 *
 * All window math reuses the centralized ET helpers in ../date-logic —
 * no new timezone arithmetic lives here:
 *  - LAST WEEK = the most recent COMPLETED Mon–Sun work week. A Mon–Sun week
 *    is complete only once the next Monday has begun, so on every ET calendar
 *    day the completed week is the one that ended the previous Sunday:
 *    lastCompletedWeekStart = weekStart(today) − 7 days. (On a Sunday the
 *    in-progress week is by definition not complete and the same subtraction
 *    already skips it.)
 *  - MONTH TO DATE = current calendar month start (ET) .. today, matching the
 *    app-wide "This Month" to-date convention (resolveRange "this-month").
 *
 * Booking numbers are BOOKING WINS (deposit-paid) bucketed on
 * booking_win_business_date — the same rev-12 win model every other page
 * counts. Attribution join: booking_attributions → users; manual overrides
 * ARE rep bookings (rep_id set); wins with no attribution rep (engine
 * unattributed/online) count in the TEAM total but NEVER in a rep row
 * (rev-13 rule) — they surface as the separate online/unattributed line.
 */
import { addDays, weekStart } from "../date-logic";
import type { AppointmentRow, AttributionRow, LeadRow } from "./compute";
import { bookingWinBusinessDateOf, isBookingWin } from "./compute";

/** Session-type split (owner definition): animalia = type contains "animalia" (case-insensitive); everything else family. */
export function isAnimaliaSession(appointmentType: string): boolean {
  return /animalia/i.test(appointmentType ?? "");
}

/** Monday starting the most recent COMPLETED Mon–Sun work week (see module doc). */
export function lastCompletedWeekStart(today: string): string {
  return addDays(weekStart(today), -7);
}

/** First ET calendar date of the month containing `today` (MTD window start). */
export function monthStartDate(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

/** Family/animalia session-type split over booking wins. */
export function splitWinsBySessionType(wins: AppointmentRow[]): { family: number; animalia: number } {
  let family = 0;
  let animalia = 0;
  for (const w of wins) {
    if (isAnimaliaSession(w.appointment_type)) animalia += 1;
    else family += 1;
  }
  return { family, animalia };
}

/**
 * Paid wins per ET calendar date (booking_win_business_date) — the daily
 * strip of the last-week section. Only dates in `dates` are returned, in
 * order, zero-filled; out-of-window wins are ignored by construction.
 */
export function winsByDate(wins: AppointmentRow[], dates: string[]): Map<string, number> {
  const out = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const w of wins) {
    const d = bookingWinBusinessDateOf(w);
    if (d && out.has(d)) out.set(d, out.get(d)! + 1);
  }
  return out;
}

/** One "by rep" row of the weekly report. Unattributed wins never land here. */
export interface WeeklyRepRow {
  rep_id: string;
  rep_name: string;
  /** Attributed paid wins (manual overrides included — they are rep bookings). */
  total: number;
  /** How many of those were manual overrides (owner rulings) — provenance. */
  manual: number;
}

/** Attribution state of one win: a rep (with manual flag) or unattributed/online. */
export interface WinOwnership {
  repCounts: Map<string, { total: number; manual: number }>;
  /** Wins with NO attribution rep — the online/unattributed line (team total only). */
  unattributed: number;
  /** Rep-attributed subset, for the assigned-lead conversion numerator. */
  repWins: AppointmentRow[];
}

/**
 * Ownership split of paid wins via booking_attributions (rev-13 rule):
 * rep_id set → that rep (manual_override flagged separately); no attribution
 * row or rep_id NULL → unattributed/online — visible, team-total only.
 */
export function splitWinOwnership(wins: AppointmentRow[], attributions: AttributionRow[]): WinOwnership {
  const byAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  const repCounts = new Map<string, { total: number; manual: number }>();
  let unattributed = 0;
  const repWins: AppointmentRow[] = [];
  for (const w of wins) {
    const attr = byAppt.get(w.id);
    if (attr?.rep_id) {
      const cur = repCounts.get(attr.rep_id) ?? { total: 0, manual: 0 };
      cur.total += 1;
      if (attr.manual_override) cur.manual += 1;
      repCounts.set(attr.rep_id, cur);
      repWins.push(w);
    } else {
      unattributed += 1;
    }
  }
  return { repCounts, unattributed, repWins };
}

/** Build the ordered rep rows: name map lookups, largest first; a rep with zero wins still appears. */
export function buildWeeklyRepRows(
  repCounts: Map<string, { total: number; manual: number }>,
  nameById: Map<string, string>,
  rosterIds: string[],
): WeeklyRepRow[] {
  const ids = new Set<string>([...rosterIds, ...repCounts.keys()]);
  const rows: WeeklyRepRow[] = [];
  for (const id of ids) {
    const c = repCounts.get(id);
    rows.push({
      rep_id: id,
      rep_name: nameById.get(id) ?? "Unknown rep",
      total: c?.total ?? 0,
      manual: c?.manual ?? 0,
    });
  }
  return rows.sort((a, b) => b.total - a.total || a.rep_name.localeCompare(b.rep_name));
}

/** Conversion rate; null when the denominator is 0 (never a fabricated 0%). */
export function conversionRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Assigned-lead conversion denominator rows: leads whose SOURCE_DATE falls in
 * [start, end] with an assigned rep. The weekly report converts the week's
 * lead cohorts (source-dated) against the wins attributed that week —
 * different from the work-date cohort the operational pages use, and labeled
 * as such in the UI.
 */
export function assignedLeadsInRange(leads: LeadRow[], start: string, end: string): LeadRow[] {
  return leads.filter((l) => l.source_date >= start && l.source_date <= end && l.assigned_rep_id != null);
}

/** Lead counts by sheet type over the fetched lead rows (no date filter — callers pass the window). */
export function splitLeadsByType(leads: LeadRow[]): { family: number; animalia: number; total: number } {
  let family = 0;
  let animalia = 0;
  for (const l of leads) {
    if (/animalia/i.test(l.lead_type)) animalia += 1;
    else family += 1;
  }
  return { family, animalia, total: leads.length };
}

/** Format "X/Goal (±N)" — the weekly bookings-vs-goal string (−/±/+, goal "—" when unset). */
export function goalVsActual(actual: number, goal: number | null): string {
  if (goal == null) return `${actual}/—`;
  const diff = actual - goal;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  return `${actual}/${goal} (${sign}${Math.abs(diff)})`;
}
