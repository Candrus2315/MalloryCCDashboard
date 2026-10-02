/**
 * COMMISSION WEEKLY CLOSE JOB (owner directive 2026-10-01, spec §A/§F).
 *
 * At the Sunday ET cutoff (i.e. once the next Monday has begun — the same
 * completed-week rule as the Weekly Report's lastCompletedWeekStart), the
 * software finalizes ONE weekly record per commission-eligible CC. The manager
 * never types counts: the record is computed from the existing Booking Win +
 * attribution data by the pure engine (./derive → ./engine).
 *
 * IDEMPOTENCY: a week that already has a stored record for an employee is
 * SKIPPED (frozen at first finalize — corrections happen through the
 * reason-required adjustment flow, Phase C locks submitted payroll forever).
 * The UNIQUE (user_id, week_start) key makes any concurrent re-run a no-op
 * duplicate-wise even if two ticks raced.
 *
 * HORIZON: weeks before the earliest tier_effective_date (seeded 2026-08-31,
 * the first validation cycle start) are out of scope — the historical backfill
 * owns 2026-08-31..2026-09-27 deliberately, and this job takes over after it.
 * (The tick skips weeks that already carry records, so re-running the backfill
 * never collides with it either.)
 */
import { addDays, etDateStrFromInstant, etDayEndUtc, etDayStartUtc, weekStart as weekStartOf } from "../date-logic";
import { COMMISSION_CALC_VERSION } from "./engine";
import {
  computeWeeklyCommissions,
  commissionEmployeeOf,
  tierHeldForWeek,
  type CommissionEmployeeInput,
} from "./derive";
import type { CountedBookingSnapshot, CommissionWeeklyRow, Store } from "../store/types";

/** Earliest week the tracker computes (the first validation cycle's start). */
export const COMMISSION_EPOCH_WEEK_START = "2026-08-31";

export interface CommissionCloseResult {
  outcome: "skipped" | "computed" | "error";
  /** Completed weeks examined this run. */
  weeksConsidered: number;
  /** New weekly records written this run. */
  recordsWritten: number;
  /** Week starts that gained at least one new record. */
  weeksClosed: string[];
  error?: string;
}

/** Monday starting the most recent COMPLETED Mon–Sun week (the Weekly Report's rule — one definition). */
export function lastCompletedCommissionWeekStart(today: string): string {
  return addDays(weekStartOf(today), -7);
}

/** Assemble the persisted weekly record from a pure per-employee computation. */
export function buildWeeklyRecord(opts: {
  computation: ReturnType<typeof computeWeeklyCommissions>;
  employee: CommissionEmployeeInput;
  calcDateIso: string;
}): CommissionWeeklyRow {
  const { computation, employee, calcDateIso } = opts;
  const mine = computation.employees.find((e) => e.userId === employee.userId);
  if (!mine) throw new Error(`commission: no computation row for employee ${employee.userId}`);
  const counted: CountedBookingSnapshot[] = computation.repWins
    .filter((w) => w.userId === employee.userId)
    .map((w) => ({
      id: w.appointmentId,
      acuity_appointment_id: w.acuity_appointment_id ?? null,
      client_name: w.client_name ?? null,
      appointment_type: w.appointment_type ?? null,
      win_date: w.winDate,
      manual: w.manual,
    }));
  // RULING 3 per-bonus audit: one row per $10 filled hole credited to this rep.
  const holeAudit = computation.holeAudit.filter((h) => h.userId === employee.userId);
  return {
    id: "", // store-generated (pg uuid default / memory key) — never read back from the write path
    user_id: employee.userId,
    rep_name: employee.name,
    week_start: computation.weekStart,
    week_end: computation.weekEnd,
    employment_type: employee.employmentType,
    tier: employee.tier,
    tier_effective_date_used: employee.tierEffectiveDate,
    qualifying_bookings: mine.qualifyingBookings,
    base_commission: Math.round(mine.baseCents) / 100,
    additional_commission: Math.round(mine.additionalCents) / 100,
    pool_bonus: Math.round(mine.poolCents) / 100,
    hole_bonus: Math.round(mine.holeCents) / 100,
    manual_adjustment: 0,
    total: Math.round(mine.totalCents) / 100,
    calc_date: calcDateIso,
    calc_version: COMMISSION_CALC_VERSION,
    status: "final",
    cycle_id: null,
    assignment: "unassigned",
    counted_bookings: counted,
    hole_audit: holeAudit,
  };
}

/**
 * One close tick: find completed Mon–Sun weeks (since COMMISSION_EPOCH_WEEK_START
 * through the most recent completed one) that lack a stored record for some
 * eligible employee and write those records. Every eligible employee gets a
 * record even at zero bookings (§5: no minimum to earn; §F: auto-created).
 *
 * `epochWeekStart`/`throughWeekStart` scope the walk for TESTS (a far-out
 * seeded week without touching real historical weeks on a live database);
 * production callers omit both.
 */
export async function commissionCloseTick(
  store: Store,
  opts?: { now?: () => Date; epochWeekStart?: string; throughWeekStart?: string },
): Promise<CommissionCloseResult> {
  const now = opts?.now ?? (() => new Date());
  const today = etDateStrFromInstant(now().getTime());
  const result: CommissionCloseResult = { outcome: "skipped", weeksConsidered: 0, recordsWritten: 0, weeksClosed: [] };
  try {
    const users = await store.getUsers(); // active roster only
    const employees = users.map(commissionEmployeeOf).filter((e): e is CommissionEmployeeInput => e !== null);
    if (employees.length === 0) return result; // nobody eligible — nothing to close
    const lastCompleted = opts?.throughWeekStart ?? lastCompletedCommissionWeekStart(today);
    const epoch = opts?.epochWeekStart ?? COMMISSION_EPOCH_WEEK_START;
    if (lastCompleted < epoch) return result;

    // Walk weeks oldest → newest; each week is computed independently (§S).
    let cursor = epoch;
    while (cursor <= lastCompleted) {
      const weekEnd = addDays(cursor, 6);
      result.weeksConsidered += 1;
      const existing = await store.getCommissionWeeklyRecords({ weekStart: cursor });
      const haveIds = new Set(existing.map((r) => r.user_id));
      const due = employees.filter((e) => !haveIds.has(e.userId));
      if (due.length > 0) {
        const weekEmployees = due
          .map((e) => tierHeldForWeek(e, cursor, weekEnd))
          .filter((e): e is CommissionEmployeeInput => e !== null);
        if (weekEmployees.length > 0) {
          const [wins, attributions, sessions] = await Promise.all([
            store.getAppointmentsByWinBusinessDateBetween(cursor, weekEnd),
            store.getAttributions(),
            // Session-occupancy window: the week's ET days (mon 00:00 ET .. sun 24:00 ET).
            store.getAppointmentsOverlapping(etDayStartUtc(cursor), etDayEndUtc(weekEnd)),
          ]);
          const computation = computeWeeklyCommissions({
            weekStart: cursor,
            wins,
            attributions,
            sessionAppts: sessions,
            employees: weekEmployees,
          });
          const calcDateIso = now().toISOString();
          for (const emp of weekEmployees) {
            await store.upsertCommissionWeeklyRecord(
              buildWeeklyRecord({ computation, employee: emp, calcDateIso }),
            );
            result.recordsWritten += 1;
          }
          result.weeksClosed.push(cursor);
        }
      }
      cursor = addDays(cursor, 7);
    }
    result.outcome = result.recordsWritten > 0 ? "computed" : "skipped";
    return result;
  } catch (e) {
    result.outcome = "error";
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
}
