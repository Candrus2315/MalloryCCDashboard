/**
 * PIP LANDING VIEW-MODEL (refinement spec §1–§2, 9/30) — pure, rule-based
 * derivations from STORED PIP dates + check-ins for the command-center
 * landing. NO scoring, NO labels, NO lifecycle logic, NO store access: every
 * input is a row the manager already sees; every output is calendar date math
 * (America/New_York, date-only) or a count. The owner's KPI strip, the
 * attention panel, and the dense active-PIP rows all render from these.
 *
 * "Ending soon" = window ends in ≤3 ET calendar days, INCLUDING any PIP
 * already past its end date but not yet closed (spec §1 KPI InfoTip — fixed
 * threshold, never varies). Days-left is signed: negative = past end date.
 */
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

/** One attention seed (employee-facing name resolved by the caller). */
export interface PipAttentionSeed {
  pip_id: string;
  employee: string;
  text: string;
  /** Presentation priority within one PIP: overdue check-in > past end > ending soon > unscheduled. */
  rank: number;
}

/** The single highest-priority attention line for one PIP, or null when on schedule. */
export function pipAttentionSeed(
  pip: Pick<PipRow, "id" | "status">,
  employeeName: string | null,
  daysLeft: number | null,
  checkins: PipCheckinState,
): PipAttentionSeed | null {
  if (pip.status !== "issued") return null;
  const name = employeeName ?? "Unassigned";
  // 1 — check-in overdue (rule: a scheduled date has passed)
  if (checkins.overdue && checkins.next_checkin_date) {
    return {
      pip_id: pip.id,
      employee: name,
      text: `Check-in overdue — ${name}, due ${checkins.next_checkin_date}`,
      rank: 1,
    };
  }
  // 2 — past end date, not yet closed
  if (pipWindowOverdue(daysLeft)) {
    return { pip_id: pip.id, employee: name, text: `Past end date, not yet closed — ${name}`, rank: 2 };
  }
  // 3 — window ends within 3 days (future end date only; past-end is rank 2)
  if (daysLeft != null && daysLeft >= 0 && daysLeft <= 3) {
    const unit = daysLeft === 1 ? "1 day" : `${daysLeft} days`;
    return { pip_id: pip.id, employee: name, text: `PIP window ends in ${unit} — ${name}`, rank: 3 };
  }
  // 4 — issued but no next check-in recorded
  if (checkins.unscheduled) {
    return { pip_id: pip.id, employee: name, text: `Next check-in not scheduled — ${name}`, rank: 4 };
  }
  return null;
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
