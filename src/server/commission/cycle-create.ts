/**
 * COMMISSION CYCLE CREATE + ASSIGN — metadata only (RULING 4: monthly cycles
 * roll up their four Mon–Sun weekly pages).
 *
 * There is NO automatic cycle-creation path: `upsertCommissionCycle` is called
 * only from `backfill.ts` (September's creation) and `lifecycle.ts` (status
 * updates of an EXISTING cycle). This module gives the deliberate, narrow path
 * that creates a cycle row and attaches ALREADY-STORED final weekly rows to it.
 *
 * MONEY-PATH HARD RULES (deliberate, never called from page paths or the
 * scheduler):
 *  - ZERO changes to any stored weekly value: qualifying_bookings, total,
 *    base/additional/pool/hole, manual_adjustment, counted_bookings, status —
 *    untouched. The ONLY writes are (a) the new commission_cycles row (insert-
 *    if-missing — an existing cycle row is never re-upserted, so a manager's
 *    later status/label edits survive a rerun) and (b) cycle_id + assignment
 *    ('current_cycle') on in-window stored final rows, via the store's narrow
 *    §S membership method `setCommissionRecordAssignment` — never
 *    `upsertCommissionWeeklyRecord`, never a recompute, never a rewrite.
 *  - OVERLAP GUARD: a window overlapping ANY existing cycle's span (September's
 *    cycle-2026-08-31-2026-09-27 in particular) is refused before any write.
 *  - DOUBLE-COUNT GUARD: an in-window row that is not cleanly unattachable —
 *    previously_submitted, or bound to another cycle — refuses the whole run
 *    BEFORE anything is written (§S: a week may belong to exactly one cycle).
 *  - Non-final (superseded) in-window rows are never assigned — reported, skipped.
 *  - No audit rows are written here by design: this is metadata assembly of
 *    already-stored rows (the money-side audit trail lives in lifecycle.ts).
 *
 * Store-injectable (tests use MemoryStore). Idempotent: rerunning picks up
 * later closes (e.g. the Oct 12–18 / Oct 19–25 weeks once stored) and no-ops
 * on everything already assigned.
 */
import { addDays } from "../date-logic";
import type { CommissionCycleRow, Store } from "../store/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One assigned/skipped row's identity (for the script's printed receipt). */
export interface CycleAssignRow {
  userId: string;
  repName: string;
  weekStart: string;
  qualifyingBookings: number;
  totalDollars: number;
}

export interface CycleCreateAssignmentResult {
  cycleId: string;
  /** True when the cycle row was inserted by THIS run (false = already stored, left untouched). */
  cycleCreated: boolean;
  cycle: CommissionCycleRow;
  assigned: CycleAssignRow[];
  alreadyAssigned: CycleAssignRow[];
  skippedNotFinal: CycleAssignRow[];
}

/** The September-style label: "Aug 31 – Sep 27, 2026" (abbrev month, en dash). */
export function labelFromSpan(start: string, end: string): string {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const right = `${MONTHS[em - 1]} ${ed}, ${ey}`;
  return sy === ey ? `${MONTHS[sm - 1]} ${sd} – ${right}` : `${MONTHS[sm - 1]} ${sd}, ${sy} – ${right}`;
}

/** First Monday of the month AFTER `dateStr`'s month (September's submission convention). */
export function firstMondayAfter(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const d = new Date(Date.UTC(ny, nm - 1, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); // 1 = Monday
  return d.toISOString().slice(0, 10);
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const utcDay = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay();

/**
 * Create the cycle row (insert-if-missing) and assign every stored FINAL
 * weekly row whose week_start falls in [start, end] to it. Refuses BEFORE any
 * write on: bad dates, non-Monday start / non-Sunday end, overlap with an
 * existing cycle, or in-window rows that cannot be attached cleanly.
 */
export async function createAndAssignCommissionCycle(
  store: Store,
  input: {
    start: string; // first included week's Monday (ET)
    end: string; // last included week's Sunday (ET)
    label?: string; // default: September's label style from the dates
    submissionDate?: string; // default: first Monday of the month after `end`
    payrollDate?: string; // default: the Friday of submission week (+4d)
  },
): Promise<CycleCreateAssignmentResult> {
  const { start, end } = input;
  if (!isDate(start) || !isDate(end)) throw new Error(`Dates must be YYYY-MM-DD (got ${start}, ${end}).`);
  if (utcDay(start) !== 1) throw new Error(`Cycle start ${start} must be a Monday (ET).`);
  if (utcDay(end) !== 0) throw new Error(`Cycle end ${end} must be a Sunday (ET).`);
  if (end <= start) throw new Error(`Cycle end ${end} must be after start ${start}.`);

  const cycles = await store.getCommissionCycles();
  const cycleId = `cycle-${start}-${end}`;
  for (const c of cycles) {
    if (c.id === cycleId) continue; // rerun of the SAME cycle — its own window may overlap itself
    if (start <= c.end_date && end >= c.start_date) {
      throw new Error(
        `Refused: window ${start}–${end} overlaps stored cycle ${c.id} (${c.start_date}–${c.end_date}, status ${c.status}) — a week may belong to exactly one cycle (§S). Nothing written.`,
      );
    }
  }

  // PLANNING PASS (read-only) — refuse the whole run before ANY write if any
  // in-window row is not cleanly attachable.
  const records = await store.getCommissionWeeklyRecords();
  const assigned: CycleAssignRow[] = [];
  const alreadyAssigned: CycleAssignRow[] = [];
  const skippedNotFinal: CycleAssignRow[] = [];
  const idOf = (r: (typeof records)[number]): CycleAssignRow => ({
    userId: r.user_id,
    repName: r.rep_name,
    weekStart: r.week_start,
    qualifyingBookings: r.qualifying_bookings,
    totalDollars: r.total,
  });
  for (const r of records) {
    if (r.week_start < start || r.week_start > end) continue; // out of window — never touched
    if (r.cycle_id === cycleId && r.assignment === "current_cycle") {
      alreadyAssigned.push(idOf(r)); // idempotent no-op
    } else if (r.status !== "final") {
      skippedNotFinal.push(idOf(r)); // superseded rows are never assigned
    } else if (r.assignment === "unassigned" && r.cycle_id == null) {
      assigned.push(idOf(r));
    } else {
      throw new Error(
        `Refused: in-window row ${r.week_start} for ${r.rep_name} is assignment=${r.assignment}${r.cycle_id ? ` (cycle ${r.cycle_id})` : ""} — unassign it first; a week may belong to exactly one cycle (§S). Nothing written.`,
      );
    }
  }

  // WRITE PHASE — (a) the cycle row, insert-if-missing; (b) narrow membership
  // updates only (cycle_id + assignment). Money columns untouched everywhere.
  let cycleCreated = false;
  let cycle = await store.getCommissionCycle(cycleId);
  if (!cycle) {
    const submissionDate = input.submissionDate ?? firstMondayAfter(end);
    const payrollDate = input.payrollDate ?? addDays(submissionDate, 4); // Friday of submission week
    const nowIso = new Date().toISOString();
    cycle = {
      id: cycleId,
      label: input.label?.trim() || labelFromSpan(start, end),
      start_date: start,
      end_date: end,
      submission_date: submissionDate,
      payroll_date: payrollDate,
      status: "in_progress", // September's row was born in_progress (buildBackfillCycleRow)
      submitted_date: null,
      submitted_by: null,
      final_snapshot: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    await store.upsertCommissionCycle(cycle);
    cycleCreated = true;
  }
  for (const row of assigned) {
    await store.setCommissionRecordAssignment(row.userId, row.weekStart, {
      cycleId,
      assignment: "current_cycle",
    });
  }
  return { cycleId, cycleCreated, cycle, assigned, alreadyAssigned, skippedNotFinal };
}
