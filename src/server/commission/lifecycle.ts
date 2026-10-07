/**
 * COMMISSION LIFECYCLE — Phase C (owner directive 10/1, spec §N/§O/§19/§20/§S).
 *
 * The manager-owned state machine around the STORED commission rows:
 *
 *   cycle:  in_progress → ready_for_review → approved → submitted (forward-only)
 *   week:   unassigned → current_cycle → previously_submitted
 *
 * HARD RULES implemented here:
 *  - No auto-submission ever: every transition is an explicit manager action,
 *    audited (who/what/old→new/reason/when) via the reason-required
 *    commission_adjustments trail (target "cycle" rows).
 *  - SUBMITTED-CYCLE LOCK: once submitted, the cycle's stored weekly records
 *    freeze forever (the store-level write guard enforces the no-rewrite
 *    invariant; submission also flips every record to 'previously_submitted').
 *    A recompute may surface drift for review — it never rewrites.
 *  - NO DOUBLE COUNTING (spec §S): a completed week belongs to at most ONE
 *    cycle. Assigning a week that already pays in a submitted cycle is
 *    refused; assigning a week bound to another live cycle requires an
 *    explicit audited unassign first.
 *  - CORRECTIONS (spec §O/§20): any correction to a stored weekly record —
 *    pre- or post-approval — requires a reason and lands as an AUDITED
 *    money-side adjustment (manual_adjustment/total delta); the auto-calc
 *    fields (base/additional/pool/hole, counted bookings, calc version) are
 *    never silently rewritten. Booking exclusions/restores are expressed as
 *    the booking's marginal tier value (pure engine math on the record's own
 *    tier + count) so no second engine appears.
 *
 * This module is store-injectable (tests use the MemoryStore) and holds NO
 * numbers of its own — every dollar comes from stored rows or the pure engine.
 */
import { addDays, etToday } from "../date-logic";
import { rateCommission, type CommissionTierNumber, type EmploymentType } from "./engine";
import type {
  CommissionAdjustmentRow,
  CommissionAssignment,
  CommissionCycleRow,
  CommissionCycleStatus,
  CommissionWeeklyRow,
  Store,
} from "../store/types";

/** §N forward-only state machine — submitted is terminal (locked forever). */
export const CYCLE_TRANSITIONS: Record<CommissionCycleStatus, CommissionCycleStatus[]> = {
  in_progress: ["ready_for_review"],
  ready_for_review: ["approved"],
  approved: ["submitted"],
  submitted: [],
};

export const CYCLE_STATUS_LABEL: Record<CommissionCycleStatus, string> = {
  in_progress: "In Progress",
  ready_for_review: "Ready for Review",
  approved: "Approved",
  submitted: "Submitted",
};

export interface CycleTransitionResult {
  cycle: CommissionCycleRow;
  from: CommissionCycleStatus;
  to: CommissionCycleStatus;
  audit: CommissionAdjustmentRow;
}

/** One audit row for a cycle-level event (status transitions, submissions, membership moves). */
async function auditCycleEvent(
  store: Store,
  opts: {
    cycleId: string | null;
    userId?: string | null;
    target: string;
    targetId: string;
    field: string;
    oldValue: string | null;
    newValue: string | null;
    reason: string;
    actor: string;
  },
): Promise<CommissionAdjustmentRow> {
  return store.insertCommissionAdjustment({
    cycle_id: opts.cycleId,
    user_id: opts.userId ?? null,
    target: opts.target,
    target_id: opts.targetId,
    field: opts.field,
    old_value: opts.oldValue,
    new_value: opts.newValue,
    reason: opts.reason,
    changed_by: opts.actor,
  });
}

/**
 * Advance a cycle ONE step along §N's state machine. Forward-only; `to` must
 * be the legal successor of the stored status. Never auto-called — the only
 * caller is the manager's explicit action (server function), audited.
 */
export async function transitionCommissionCycle(
  store: Store,
  input: { cycleId: string; to: CommissionCycleStatus; actor: string; note?: string },
): Promise<CycleTransitionResult> {
  const cycle = await store.getCommissionCycle(input.cycleId);
  if (!cycle) throw new Error(`No stored commission cycle ${input.cycleId}.`);
  const from = cycle.status;
  if (from === "submitted") throw new Error("Cycle is submitted and locked — no status changes (spec §19).");
  const allowed = CYCLE_TRANSITIONS[from];
  if (!allowed.includes(input.to)) {
    throw new Error(`Illegal transition ${from} → ${input.to} (allowed: ${allowed.join(", ") || "none"}).`);
  }
  const updated: CommissionCycleRow = { ...cycle, status: input.to, updated_at: new Date().toISOString() };
  await store.upsertCommissionCycle(updated);
  const reason = input.note?.trim()
    ? input.note.trim()
    : `Status advanced ${CYCLE_STATUS_LABEL[from]} → ${CYCLE_STATUS_LABEL[input.to]}`;
  const audit = await auditCycleEvent(store, {
    cycleId: cycle.id,
    target: "cycle",
    targetId: cycle.id,
    field: "status",
    oldValue: from,
    newValue: input.to,
    reason,
    actor: input.actor,
  });
  return { cycle: updated, from, to: input.to, audit };
}

/** §N submission snapshot — the frozen facts saved on the cycle row at submission. */
export interface CycleFinalSnapshot {
  submittedAt: string; // ISO instant
  submissionDate: string; // ET date
  payrollDate: string;
  submissionDeadline: string;
  finalMonthlyBookingCount: number;
  finalBonusAmount: number; // dollars
  calculationVersions: number[];
  perEmployee: Array<{
    userId: string;
    name: string;
    qualifyingBookings: number;
    base: number;
    additional: number;
    pool: number;
    holes: number;
    adjustments: number;
    total: number;
  }>;
}

export interface CycleSubmissionResult {
  cycle: CommissionCycleRow;
  snapshot: CycleFinalSnapshot;
  recordsFlipped: number;
  audit: CommissionAdjustmentRow;
}

/**
 * SUBMIT an approved cycle (§N: the ONLY money-freezing action; no auto-
 * submission ever — the manager clicks it). Saves Submitted Date / Submitted
 * By / Final Monthly Booking Count / Final Bonus Amount / Calculation Version
 * / Associated Payroll Date as the immutable final_snapshot, flips every
 * cycle-bound weekly record to 'previously_submitted' (§S), and records the
 * submission + each record flip in the audit trail. After this, the store's
 * write guard refuses any rewrite of these records forever.
 */
export async function submitCommissionCycle(
  store: Store,
  input: { cycleId: string; actor: string; submittedDate?: string },
): Promise<CycleSubmissionResult> {
  const cycle = await store.getCommissionCycle(input.cycleId);
  if (!cycle) throw new Error(`No stored commission cycle ${input.cycleId}.`);
  if (cycle.status === "submitted") throw new Error("Cycle is already submitted and locked.");
  if (cycle.status !== "approved") {
    throw new Error(`Cycle must be Approved before submission (currently ${CYCLE_STATUS_LABEL[cycle.status]}).`);
  }
  const records = await store.getCommissionWeeklyRecords({ cycleId: cycle.id });
  const byUser = new Map<string, { name: string; bookings: number; base: number; additional: number; pool: number; holes: number; adjustments: number; total: number }>();
  for (const r of records) {
    const row = byUser.get(r.user_id) ?? {
      name: r.rep_name, bookings: 0, base: 0, additional: 0, pool: 0, holes: 0, adjustments: 0, total: 0,
    };
    row.bookings += r.qualifying_bookings;
    row.base += r.base_commission;
    row.additional += r.additional_commission;
    row.pool += r.pool_bonus;
    row.holes += r.hole_bonus;
    row.adjustments += r.manual_adjustment;
    row.total += r.total;
    byUser.set(r.user_id, row);
  }
  const submissionDate = input.submittedDate ?? etToday();
  const snapshot: CycleFinalSnapshot = {
    submittedAt: new Date().toISOString(),
    submissionDate,
    payrollDate: cycle.payroll_date,
    submissionDeadline: cycle.submission_date,
    finalMonthlyBookingCount: records.reduce((s, r) => s + r.qualifying_bookings, 0),
    finalBonusAmount: Math.round(records.reduce((s, r) => s + r.total, 0) * 100) / 100,
    calculationVersions: [...new Set(records.map((r) => r.calc_version))].sort((a, b) => a - b),
    perEmployee: [...byUser.entries()].map(([userId, row]) => ({
      userId,
      name: row.name,
      qualifyingBookings: row.bookings,
      base: Math.round(row.base * 100) / 100,
      additional: Math.round(row.additional * 100) / 100,
      pool: Math.round(row.pool * 100) / 100,
      holes: Math.round(row.holes * 100) / 100,
      adjustments: Math.round(row.adjustments * 100) / 100,
      total: Math.round(row.total * 100) / 100,
    })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  };
  const updated: CommissionCycleRow = {
    ...cycle,
    status: "submitted",
    submitted_date: submissionDate,
    submitted_by: input.actor,
    final_snapshot: snapshot as unknown as Record<string, unknown>,
    updated_at: new Date().toISOString(),
  };
  await store.upsertCommissionCycle(updated);
  // §S: every record in the submitted cycle becomes 'previously_submitted' —
  // the week can never be counted into another cycle (no double payments).
  let recordsFlipped = 0;
  for (const r of records) {
    if (r.assignment === "previously_submitted") continue;
    await store.setCommissionRecordAssignment(r.user_id, r.week_start, {
      cycleId: r.cycle_id,
      assignment: "previously_submitted",
    });
    await auditCycleEvent(store, {
      cycleId: cycle.id,
      userId: r.user_id,
      target: "weekly_record",
      targetId: `${r.user_id}:${r.week_start}`,
      field: "assignment",
      oldValue: r.assignment,
      newValue: "previously_submitted",
      reason: `Cycle ${cycle.label} submitted — week locked into this cycle (never re-counted).`,
      actor: input.actor,
    });
    recordsFlipped += 1;
  }
  const audit = await auditCycleEvent(store, {
    cycleId: cycle.id,
    target: "cycle",
    targetId: cycle.id,
    field: "submission",
    oldValue: "approved",
    newValue: "submitted",
    reason: `Cycle ${cycle.label} submitted: ${snapshot.finalMonthlyBookingCount} bookings · $${snapshot.finalBonusAmount.toFixed(2)} · payroll ${snapshot.payrollDate}.`,
    actor: input.actor,
  });
  return { cycle: updated, snapshot, recordsFlipped, audit };
}

export interface WeekAssignmentResult {
  assignedRecords: number;
  skippedRecords: number;
  auditRows: number;
}

/**
 * Assign completed unassigned weeks INTO a cycle (§S: unassigned → current
 * cycle; RULING 4 lets the manager pull a week in pre-approval, audited).
 * Guards make double counting structurally impossible:
 *  - the cycle must exist and not be submitted (submitted membership is frozen);
 *  - every stored record of the week must be unassigned, assigned to THIS
 *    cycle (no-op skip), or it is refused (previously_submitted / another
 *    live cycle) — a week can never pay twice.
 */
export async function assignCommissionWeeks(
  store: Store,
  input: { cycleId: string; weekStarts: string[]; actor: string; note?: string },
): Promise<WeekAssignmentResult> {
  const cycle = await store.getCommissionCycle(input.cycleId);
  if (!cycle) throw new Error(`No stored commission cycle ${input.cycleId}.`);
  if (cycle.status === "submitted") throw new Error("Cannot assign weeks into a submitted cycle (locked, spec §19).");
  let assigned = 0;
  let skipped = 0;
  let auditRows = 0;
  for (const weekStart of [...input.weekStarts].sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error(`Invalid week start ${weekStart} (YYYY-MM-DD Monday, ET).`);
    const records = await store.getCommissionWeeklyRecords({ weekStart });
    if (records.length === 0) {
      throw new Error(`Week ${weekStart} has no stored weekly records — only completed weeks with records can be assigned.`);
    }
    for (const r of records) {
      if (r.assignment === "unassigned") {
        await store.setCommissionRecordAssignment(r.user_id, r.week_start, { cycleId: cycle.id, assignment: "current_cycle" });
        await auditCycleEvent(store, {
          cycleId: cycle.id,
          userId: r.user_id,
          target: "weekly_record",
          targetId: `${r.user_id}:${r.week_start}`,
          field: "assignment",
          oldValue: "unassigned",
          newValue: "current_cycle",
          reason: input.note?.trim() || `Week ${r.week_start} assigned to cycle ${cycle.label}.`,
          actor: input.actor,
        });
        assigned += 1;
        auditRows += 1;
      } else if (r.cycle_id === cycle.id && r.assignment === "current_cycle") {
        skipped += 1; // already this cycle's — idempotent no-op
      } else {
        throw new Error(
          `Week ${r.week_start} record for ${r.rep_name} is ${r.assignment}${r.cycle_id ? ` (cycle ${r.cycle_id})` : ""} — unassign it first; a week may belong to exactly one cycle (no double counting).`,
        );
      }
    }
  }
  return { assignedRecords: assigned, skippedRecords: skipped, auditRows };
}

/**
 * Pull weeks OUT of a live (not yet submitted) cycle (§S: current cycle →
 * unassigned; audited). Refused on a submitted cycle — submitted membership is
 * frozen forever.
 */
export async function unassignCommissionWeeks(
  store: Store,
  input: { cycleId: string; weekStarts: string[]; actor: string; note?: string },
): Promise<WeekAssignmentResult> {
  const cycle = await store.getCommissionCycle(input.cycleId);
  if (!cycle) throw new Error(`No stored commission cycle ${input.cycleId}.`);
  if (cycle.status === "submitted") throw new Error("Cannot unassign weeks from a submitted cycle (locked, spec §19).");
  let unassigned = 0;
  let auditRows = 0;
  for (const weekStart of [...input.weekStarts].sort()) {
    const records = await store.getCommissionWeeklyRecords({ weekStart });
    for (const r of records) {
      if (r.cycle_id !== cycle.id) continue; // not this cycle's record — nothing to do
      if (r.assignment !== "current_cycle") continue;
      await store.setCommissionRecordAssignment(r.user_id, r.week_start, { cycleId: null, assignment: "unassigned" });
      await auditCycleEvent(store, {
        cycleId: cycle.id,
        userId: r.user_id,
        target: "weekly_record",
        targetId: `${r.user_id}:${r.week_start}`,
        field: "assignment",
        oldValue: "current_cycle",
        newValue: "unassigned",
        reason: input.note?.trim() || `Week ${r.week_start} pulled from cycle ${cycle.label}.`,
        actor: input.actor,
      });
      unassigned += 1;
      auditRows += 1;
    }
  }
  return { assignedRecords: unassigned, skippedRecords: 0, auditRows };
}

// ---------- corrections (§O/§20: reason REQUIRED, audited, money-side only) ----------

export type CorrectionKind = "manual_adjustment" | "exclude_booking" | "restore_booking" | "hole_bonus";

export interface CorrectionInput {
  /** The cycle whose record is corrected (must match the record's own cycle binding). */
  cycleId: string | null;
  userId: string;
  weekStart: string;
  kind: CorrectionKind;
  /** manual_adjustment only: the signed dollars delta. */
  deltaDollars?: number;
  /** exclude/restore only: the counted booking being excluded/restored. */
  appointmentId?: string;
  /** hole_bonus only: how many $10 holes to add (default 1). */
  holeCount?: number;
  /** REQUIRED — the audit row is rejected without it (store-enforced too). */
  reason: string;
  actor: string;
}

export interface CorrectionResult {
  record: CommissionWeeklyRow;
  audit: CommissionAdjustmentRow;
  deltaDollars: number;
  /** Human description of what the correction did (for the UI confirmation). */
  what: string;
}

/**
 * The marginal commission value of booking #n under the record's OWN tier math
 * (pure engine re-run — §Q: no second engine, no typed totals). Null when the
 * stored profile can't compute (invalid tier — surfaced, never guessed).
 */
export function marginalBookingValueCents(
  employmentType: EmploymentType,
  tier: number,
  qualifyingBookings: number,
): number | null {
  if (!Number.isInteger(qualifyingBookings) || qualifyingBookings <= 0) return null;
  try {
    const full = rateCommission(employmentType, tier as CommissionTierNumber, qualifyingBookings);
    const prev = rateCommission(employmentType, tier as CommissionTierNumber, qualifyingBookings - 1);
    return full.totalCents - prev.totalCents;
  } catch {
    return null;
  }
}

const money = (d: number): string => `$${d.toFixed(2)}`;

/**
 * Apply ONE reason-required correction to a stored weekly record. The auto-calc
 * fields NEVER change (base/additional/pool/hole, counted bookings, tier, calc
 * version are frozen evidence); the correction lands as an audited
 * manual_adjustment/total delta with who/what/old/new/reason/when recorded.
 * Works on approved AND submitted records — that is the point: corrections to
 * locked payroll are possible, but only through this audited path.
 */
export async function applyCommissionCorrection(
  store: Store,
  input: CorrectionInput,
): Promise<CorrectionResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new Error("A correction reason is required (who/what/old/new/reason/when audit).");
  const records = await store.getCommissionWeeklyRecords({ userId: input.userId, weekStart: input.weekStart });
  const record = records[0];
  if (!record) throw new Error(`No stored weekly record for ${input.userId} week ${input.weekStart}.`);
  if (input.cycleId != null && record.cycle_id !== input.cycleId) {
    throw new Error(`Record belongs to cycle ${record.cycle_id ?? "(none)"} — corrections must target its own cycle.`);
  }
  let delta = 0;
  let field = "manual_adjustment";
  let what = "manual adjustment";
  if (input.kind === "manual_adjustment") {
    delta = Number(input.deltaDollars);
    if (!Number.isFinite(delta) || Math.round(delta * 100) === 0) {
      throw new Error("Manual adjustment requires a non-zero dollar delta.");
    }
  } else if (input.kind === "exclude_booking") {
    const apptId = String(input.appointmentId ?? "");
    if (!apptId) throw new Error("Excluding a booking requires the appointment id.");
    if (!record.counted_bookings.some((c) => c.id === apptId)) {
      throw new Error("That appointment is not among this record's counted bookings — nothing to exclude.");
    }
    const cents = marginalBookingValueCents(record.employment_type, record.tier, record.qualifying_bookings);
    if (cents == null || cents === 0) {
      throw new Error("Cannot compute the booking's marginal commission value from the stored tier math — refusing to guess.");
    }
    delta = -cents / 100;
    field = `booking_excluded:${apptId}`;
    what = `excluded booking #${apptId}`;
  } else if (input.kind === "restore_booking") {
    const apptId = String(input.appointmentId ?? "");
    if (!apptId) throw new Error("Restoring a booking requires the appointment id.");
    const prior = (await store.getCommissionAdjustments({ targetId: `${input.userId}:${input.weekStart}` })).find(
      (a) => a.field === `booking_excluded:${apptId}`,
    );
    if (!prior) throw new Error("No audited exclusion found for that booking — restore follows an exclusion only.");
    const cents = marginalBookingValueCents(record.employment_type, record.tier, record.qualifying_bookings);
    if (cents == null || cents === 0) {
      throw new Error("Cannot compute the booking's marginal commission value from the stored tier math — refusing to guess.");
    }
    delta = cents / 100;
    field = `booking_restored:${apptId}`;
    what = `restored booking #${apptId}`;
  } else if (input.kind === "hole_bonus") {
    const count = Math.floor(Number(input.holeCount ?? 1));
    if (!Number.isInteger(count) || count <= 0) throw new Error("Hole-bonus correction requires a positive hole count.");
    delta = count * 10; // §H: $10 per filled hole
    field = "hole_bonus_added";
    what = `added ${count} filled-hole bonus${count === 1 ? "" : "es"} (@ $10)`;
  } else {
    throw new Error(`Unknown correction kind: ${String(input.kind)}`);
  }
  const oldAdj = Math.round(record.manual_adjustment * 100) / 100;
  const newAdj = Math.round((oldAdj + delta) * 100) / 100;
  const oldTotal = Math.round(record.total * 100) / 100;
  const newTotal = Math.round((oldTotal + delta) * 100) / 100;
  // AUDIT FIRST (reason REQUIRED, store-enforced) — then the money moves.
  const audit = await store.insertCommissionAdjustment({
    cycle_id: record.cycle_id,
    user_id: record.user_id,
    target: "weekly_record",
    target_id: `${record.user_id}:${record.week_start}`,
    field,
    old_value: `manual_adjustment ${money(oldAdj)} · total ${money(oldTotal)}`,
    new_value: `manual_adjustment ${money(newAdj)} · total ${money(newTotal)}`,
    reason,
    changed_by: input.actor,
  });
  await store.applyCommissionWeeklyCorrection(record.user_id, record.week_start, delta);
  const updated = (await store.getCommissionWeeklyRecords({ userId: record.user_id, weekStart: record.week_start }))[0];
  if (!updated) throw new Error("Correction applied but the record disappeared — investigate immediately.");
  return { record: updated, audit, deltaDollars: Math.round(delta * 100) / 100, what };
}

/**
 * The next commission submission date for a dashboard card: the stored cycle
 * with the earliest submission_date still in the future, else the newest cycle
 * whose deadline has passed WITHOUT being submitted (past-due shown honestly).
 * QA 2026-10-08: a `submitted` (terminal) cycle is no longer returned as
 * "next" — an already-submitted cycle's deadline is not upcoming or overdue,
 * and showing it under "Next Commission Submission" was misleading. Null =
 * no upcoming/unsubmitted cycle stored (the honest empty state).
 */
export function nextCommissionSubmission(
  cycles: CommissionCycleRow[],
  today: string,
): CommissionCycleRow | null {
  if (cycles.length === 0) return null;
  const sorted = [...cycles].sort((a, b) => (a.submission_date < b.submission_date ? -1 : 1));
  const upcoming = sorted.find((c) => c.submission_date >= today);
  if (upcoming) return upcoming;
  // All stored deadlines are past: the newest UNsubmitted cycle (latest
  // start_date — the one currently being worked) is the honest "next" — its
  // deadline is overdue. Submitted cycles are done and never shown as next.
  const unsubmitted = cycles.filter((c) => c.status !== "submitted");
  if (unsubmitted.length === 0) return null;
  return [...unsubmitted].sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0];
}

/** Convenience: the Monday..Sunday span of a week (labels only). */
export function weekSpan(weekStart: string): { start: string; end: string } {
  return { start: weekStart, end: addDays(weekStart, 6) };
}

/** Re-export so UI/tests can name the assignment state without a store import. */
export type { CommissionAssignment, CommissionCycleStatus };
