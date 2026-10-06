/**
 * PIP LANDING VIEW-MODEL (refinement spec §1–§2; Phase 3 additions per the
 * management-redesign spec "Known gap" note) — pure, rule-based derivations
 * from STORED PIP dates + check-ins + acknowledgment fields for the
 * command-center landing and the Active-PIPs workspace. NO scoring, NO labels,
 * NO lifecycle logic, NO store access: every input is a row the manager
 * already sees; every output is calendar date math (America/New_York,
 * date-only) or a count. The owner's KPI strip, the attention panel, and the
 * dense active-PIP rows all render from these.
 *
 * "Ending soon" = window ends in ≤3 ET calendar days, INCLUDING any PIP
 * already past its end date but not yet closed (spec §1 KPI InfoTip — fixed
 * threshold, never varies). Days-left is signed: negative = past end date.
 *
 * PHASE 3 attention ladder — two new server-side signals join the existing
 * calendar/check-in rules (computed in pip-api.ts through the ONE evidence
 * engine, never approximated client-side):
 *  - minimum_missed: completed review weeks whose actual fell below the PIP's
 *    weekly minimum (the evidence engine's per-week `met` flags — hard
 *    per-week comparison, never averaged);
 *  - awaiting_ack: issued but no acknowledgment recorded yet
 *    (manager_acked_at null — the manager records acknowledgment; no employee
 *    logins, owner directive 9/30).
 */
import { mondaysInRange, weekStart } from "./date-logic";
import type { PipCheckinRow, PipRow, PipStatus } from "./store/types";

/** Signed whole days from `today` to `dateStr` (negative = dateStr is past). */
export function pipDaysUntil(dateStr: string | null, today: string): number | null {
  if (!dateStr) return null;
  const a = Date.parse(`${dateStr}T12:00:00Z`);
  const b = Date.parse(`${today}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/** Spec §1: "ending soon" = ≤3 ET calendar days to the window end, past-end included. */
export function pipEndingSoon(daysLeft: number | null): boolean {
  return daysLeft != null && daysLeft <= 3;
}

/** Spec §1: window end date is already past (and the PIP is not closed). */
export function pipWindowOverdue(daysLeft: number | null): boolean {
  return daysLeft != null && daysLeft < 0;
}

export interface PipCheckinState {
  /** The upcoming check-in date per the LATEST logged check-in's next_checkin_date. */
  next_checkin_date: string | null;
  /** Check-ins logged so far. */
  count: number;
  /** The upcoming check-in is its number in the log (1-based). */
  upcoming_number: number;
  /** Cadence-derived total for the window ("check-in 2 of 6") — null when no cadence/window. */
  expected_total: number | null;
  /** A SCHEDULED check-in date has passed (ET) — the "Check-ins due" rule. */
  overdue: boolean;
  /** Issued but no next check-in recorded (attention line, NOT counted as due). */
  unscheduled: boolean;
}

/**
 * Check-in state from STORED dates only — nothing is auto-scheduled: the
 * next check-in exists only when a logged check-in recorded one. The
 * expected total is presentation math from the manager's own cadence entry
 * (ceil of inclusive window days ÷ cadence days), never a scheduling action.
 */
export function pipCheckinState(
  pip: Pick<PipRow, "pip_start_date" | "pip_end_date" | "checkin_cadence_days">,
  checkins: PipCheckinRow[],
  today: string,
): PipCheckinState {
  const sorted = [...checkins].sort(
    (a, b) => a.checkin_date.localeCompare(b.checkin_date) || a.created_at.localeCompare(b.created_at),
  );
  const next = sorted.length > 0 ? (sorted[sorted.length - 1].next_checkin_date ?? null) : null;
  let expectedTotal: number | null = null;
  if (pip.checkin_cadence_days != null && pip.checkin_cadence_days > 0 && pip.pip_start_date && pip.pip_end_date) {
    const inclusive = pipDaysUntil(pip.pip_end_date, pip.pip_start_date);
    if (inclusive != null && inclusive >= 0) expectedTotal = Math.ceil((inclusive + 1) / pip.checkin_cadence_days);
  }
  return {
    next_checkin_date: next,
    count: sorted.length,
    upcoming_number: sorted.length + 1,
    expected_total: expectedTotal,
    overdue: next != null && next < today,
    unscheduled: next == null,
  };
}

/** Stable attention codes — the UI groups/colors by these, never by parsing text. */
export type PipAttentionCode =
  | "checkin_overdue"
  | "minimum_missed"
  | "past_end"
  | "awaiting_ack"
  | "ending_soon"
  | "unscheduled";

/**
 * One attention seed (employee-facing name resolved by the caller). One line
 * per PIP — the highest-priority rule that fired (the priority ladder below).
 */
export interface PipAttentionSeed {
  pip_id: string;
  employee: string;
  text: string;
  code: PipAttentionCode;
  /**
   * Presentation priority within one PIP:
   * overdue check-in (1) > weekly minimum missed (2) > past end (3) >
   * awaiting acknowledgment (4) > ending soon (5) > unscheduled (6).
   */
  rank: number;
}

/**
 * The Phase-3 signals pip-api computes SERVER-SIDE (through the ONE evidence
 * engine) and hands to the ladder. Defaults keep the 4-arg call shape valid
 * for every existing caller/test: no new signal fires unless the server layer
 * derived one.
 */
export interface PipAttentionExtras {
  /** Issued but no acknowledgment recorded yet (manager_acked_at null). */
  awaiting_ack: boolean;
  /** Completed review weeks whose actual fell below the weekly minimum. */
  weeks_missed: number;
}

const NO_EXTRAS: PipAttentionExtras = { awaiting_ack: false, weeks_missed: 0 };

/** The single highest-priority attention line for one PIP, or null when on schedule. */
export function pipAttentionSeed(
  pip: Pick<PipRow, "id" | "status">,
  employeeName: string | null,
  daysLeft: number | null,
  checkins: PipCheckinState,
  extras: PipAttentionExtras = NO_EXTRAS,
): PipAttentionSeed | null {
  if (pip.status !== "issued") return null;
  const name = employeeName ?? "Unassigned";
  // 1 — check-in overdue (rule: a scheduled date has passed)
  if (checkins.overdue && checkins.next_checkin_date) {
    return {
      pip_id: pip.id,
      employee: name,
      text: `Check-in overdue — ${name}, due ${checkins.next_checkin_date}`,
      code: "checkin_overdue",
      rank: 1,
    };
  }
  // 2 — weekly minimum missed (server-side evidence-engine derivation; hard
  // per-week rule — one completed week below the minimum is enough to surface)
  if (extras.weeks_missed > 0) {
    const n = extras.weeks_missed;
    const unit = n === 1 ? "1 completed week" : `${n} completed weeks`;
    return {
      pip_id: pip.id,
      employee: name,
      text: `Weekly minimum missed in ${unit} — ${name}`,
      code: "minimum_missed",
      rank: 2,
    };
  }
  // 3 — past end date, not yet closed
  if (pipWindowOverdue(daysLeft)) {
    return { pip_id: pip.id, employee: name, text: `Past end date, not yet closed — ${name}`, code: "past_end", rank: 3 };
  }
  // 4 — issued but no acknowledgment recorded (manager records it)
  if (extras.awaiting_ack) {
    return {
      pip_id: pip.id,
      employee: name,
      text: `Acknowledgment not yet recorded — ${name}`,
      code: "awaiting_ack",
      rank: 4,
    };
  }
  // 5 — window ends within 3 days (future end date only; past-end is rank 3)
  if (daysLeft != null && daysLeft >= 0 && daysLeft <= 3) {
    const unit = daysLeft === 1 ? "1 day" : `${daysLeft} days`;
    return { pip_id: pip.id, employee: name, text: `PIP window ends in ${unit} — ${name}`, code: "ending_soon", rank: 5 };
  }
  // 6 — issued but no next check-in recorded
  if (checkins.unscheduled) {
    return { pip_id: pip.id, employee: name, text: `Next check-in not scheduled — ${name}`, code: "unscheduled", rank: 6 };
  }
  return null;
}

/**
 * PHASE 3 — "which week" derivation for the Active-PIPs workspace: the 1-based
 * index of TODAY's Mon–Sun week within the review window's week list (the SAME
 * mondaysInRange list the evidence engine's weekly rows use, so the workspace
 * label and the weekly goal-met table always agree). Null when today's week is
 * outside the window (window not started / already ended) — honest, never a
 * guessed index.
 */
export function pipReviewWeekIndex(
  reviewStart: string,
  reviewEnd: string,
  today: string,
): { index: number; total: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewStart) || !/^\d{4}-\d{2}-\d{2}$/.test(reviewEnd) || reviewEnd < reviewStart) {
    return null;
  }
  const weeks = mondaysInRange(reviewStart, reviewEnd);
  const idx = weeks.indexOf(weekStart(today));
  return idx === -1 ? null : { index: idx + 1, total: weeks.length };
}

/** The owner's four KPI counts (spec §1), derived from the landing rows. */
export interface PipKpiCounts {
  active: number;
  checkins_due: number;
  ending_soon: number;
  drafts: number;
  past_end: number; // Active-PIPs sub-line: "{n} past end date"
}

export function pipKpiCounts(
  pips: { status: PipStatus; ending_soon: boolean; window_overdue: boolean; checkin_overdue: boolean }[],
): PipKpiCounts {
  const active = pips.filter((p) => p.status === "issued");
  return {
    active: active.length,
    checkins_due: active.filter((p) => p.checkin_overdue).length,
    ending_soon: active.filter((p) => p.ending_soon).length,
    drafts: pips.filter((p) => p.status === "draft").length,
    past_end: active.filter((p) => p.window_overdue).length,
  };
}

/**
 * Days-remaining-ascending default sort (spec §2). Rows without an end date
 * sort last within their group; ties break by employee name, then title.
 */
export function sortPipsByDaysLeft<
  T extends { days_left: number | null; rep_name: string | null; title: string },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const da = a.days_left ?? Number.POSITIVE_INFINITY;
    const db = b.days_left ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    const na = a.rep_name ?? "";
    const nb = b.rep_name ?? "";
    if (na !== nb) return na.localeCompare(nb);
    return a.title.localeCompare(b.title);
  });
}
