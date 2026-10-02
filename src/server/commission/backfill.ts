/**
 * HISTORICAL BACKFILL — THE ACCEPTANCE TEST (spec §R/§25/§26; owner directive
 * 2026-10-01). Rebuild, from REAL stored booking data, four independent Mon–Sun
 * weekly calculations and the first commission cycle:
 *
 *   W1 2026-08-31..09-06 · W2 2026-09-07..09-13 · W3 2026-09-14..09-20 ·
 *   W4 2026-09-21..09-27
 *   Commission Cycle "Aug 31 – Sep 27, 2026" · submission Mon 2026-10-05 ·
 *   payroll Fri 2026-10-09.
 *
 * If the software cannot reproduce this cycle from existing data, the feature
 * is NOT complete — so the computation here is the exact same pure path the
 * live close job uses (computeWeeklyCommissions over stored rows). No second
 * engine, no manual numbers.
 *
 * READ-ONLY by default: computeValidationWeeks() only reads. The deliberate
 * write (weekly records + the cycle row) happens exclusively through
 * writeBackfillCycle() — invoked by scripts/commission-backfill.ts with
 * --write AFTER the lead reviews the printed numbers.
 */
import { addDays } from "../date-logic";
import type { Store } from "../store/types";
import {
  commissionEmployeeOf,
  computeWeeklyCommissions,
  tierHeldForWeek,
  type CommissionEmployeeInput,
  type WeeklyComputation,
} from "./derive";
import { buildWeeklyRecord } from "./close";
import { etDayEndUtc, etDayStartUtc } from "../date-logic";

/** The four validation weeks (Mondays), oldest first (spec §25). */
export const VALIDATION_WEEK_STARTS = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"] as const;

/** Deterministic cycle id for the first cycle (slug — stable across re-runs). */
export const BACKFILL_CYCLE_ID = "cycle-2026-08-31-2026-09-27";
export const BACKFILL_CYCLE_LABEL = "Aug 31 – Sep 27, 2026";
export const BACKFILL_CYCLE_SUBMISSION_DATE = "2026-10-05"; // first Monday of October
export const BACKFILL_CYCLE_PAYROLL_DATE = "2026-10-09";

/**
 * Compute the four validation weeks INDEPENDENTLY from stored data.
 * READ-ONLY — no store writes. Each week: pull its win-bucket appointments +
 * session occupancy + attributions, resolve the employees/tiers held that week,
 * and run the pure weekly calc.
 */
export async function computeValidationWeeks(store: Store, opts?: { weekStarts?: readonly string[] }): Promise<WeeklyComputation[]> {
  const weekStarts = opts?.weekStarts ?? VALIDATION_WEEK_STARTS;
  const users = await store.getUsers();
  const employees = users.map(commissionEmployeeOf).filter((e): e is CommissionEmployeeInput => e !== null);
  const attributions = await store.getAttributions();
  const out: WeeklyComputation[] = [];
  for (const weekStart of weekStarts) {
    const weekEnd = addDays(weekStart, 6);
    const [wins, sessions] = await Promise.all([
      store.getAppointmentsByWinBusinessDateBetween(weekStart, weekEnd),
      store.getAppointmentsOverlapping(etDayStartUtc(weekStart), etDayEndUtc(weekEnd)),
    ]);
    const weekEmployees = employees
      .map((e) => tierHeldForWeek(e, weekStart, weekEnd))
      .filter((e): e is CommissionEmployeeInput => e !== null);
    out.push(
      computeWeeklyCommissions({
        weekStart,
        wins,
        attributions,
        sessionAppts: sessions,
        employees: weekEmployees,
      }),
    );
  }
  return out;
}

/** One employee's cycle rollup line (spec §26 validation screen shape). */
export interface CycleRollupEmployee {
  userId: string;
  name: string;
  employmentType: string;
  tier: number;
  weeks: Array<{ weekStart: string; bookings: number; totalCents: number }>;
  totalBookings: number;
  totalBaseCents: number;
  totalPoolCents: number;
  totalHoleCents: number;
  totalCents: number;
}

export interface CycleRollup {
  cycleId: string;
  label: string;
  weekStarts: string[];
  perEmployee: CycleRollupEmployee[];
  teamTotalBookings: number;
  teamTotalCents: number;
  teamPoolCents: number;
  teamHoleCents: number;
}

/** Sum the weekly computations into the cycle rollup (never re-derives — sums the computed weeks). */
export function rollupCycle(cycleId: string, label: string, weeks: WeeklyComputation[]): CycleRollup {
  const byUser = new Map<string, CycleRollupEmployee>();
  let teamTotalBookings = 0;
  let teamTotalCents = 0;
  let teamPoolCents = 0;
  let teamHoleCents = 0;
  for (const week of weeks) {
    for (const emp of week.employees) {
      let row = byUser.get(emp.userId);
      if (!row) {
        row = {
          userId: emp.userId,
          name: emp.name,
          employmentType: emp.employmentType,
          tier: emp.tier,
          weeks: [],
          totalBookings: 0,
          totalBaseCents: 0,
          totalPoolCents: 0,
          totalHoleCents: 0,
          totalCents: 0,
        };
        byUser.set(emp.userId, row);
      }
      row.weeks.push({ weekStart: week.weekStart, bookings: emp.qualifyingBookings, totalCents: emp.totalCents });
      row.totalBookings += emp.qualifyingBookings;
      row.totalBaseCents += emp.baseCents + emp.additionalCents;
      row.totalPoolCents += emp.poolCents;
      row.totalHoleCents += emp.holeCents;
      row.totalCents += emp.totalCents;
      teamTotalBookings += emp.qualifyingBookings;
      teamTotalCents += emp.totalCents;
      teamPoolCents += emp.poolCents;
      teamHoleCents += emp.holeCents;
    }
  }
  return {
    cycleId,
    label,
    weekStarts: weeks.map((w) => w.weekStart),
    perEmployee: [...byUser.values()],
    teamTotalBookings,
    teamTotalCents,
    teamPoolCents,
    teamHoleCents,
  };
}

/** The deterministic first-cycle row (spec §R: Aug 31 – Sep 27, 2026 · payroll Oct 9, 2026 · submission Oct 5). */
export function buildBackfillCycleRow(): {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  submission_date: string;
  payroll_date: string;
  status: "in_progress";
  submitted_date: null;
  submitted_by: null;
  final_snapshot: null;
  created_at: string;
  updated_at: string;
} {
  const nowIso = new Date().toISOString();
  return {
    id: BACKFILL_CYCLE_ID,
    label: BACKFILL_CYCLE_LABEL,
    start_date: VALIDATION_WEEK_STARTS[0],
    end_date: addDays(VALIDATION_WEEK_STARTS[VALIDATION_WEEK_STARTS.length - 1], 6),
    submission_date: BACKFILL_CYCLE_SUBMISSION_DATE,
    payroll_date: BACKFILL_CYCLE_PAYROLL_DATE,
    status: "in_progress",
    submitted_date: null,
    submitted_by: null,
    final_snapshot: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * THE DELIBERATE WRITE (never called from page paths or the scheduler):
 * writes the four weekly records (status final, assignment 'unassigned') and
 * the cycle row. Idempotent by construction (weekly upserts keyed
 * (user_id, week_start); the cycle row upserts by slug) — but it exists only
 * for the reviewed, deliberate backfill run.
 */
export async function writeBackfillCycle(
  store: Store,
  opts?: { calcDateIso?: string },
): Promise<{ recordsWritten: number; cycleId: string }> {
  const weeks = await computeValidationWeeks(store);
  const calcDateIso = opts?.calcDateIso ?? new Date().toISOString();
  let recordsWritten = 0;
  for (const computation of weeks) {
    for (const emp of computation.employees) {
      const employee: CommissionEmployeeInput = {
        userId: emp.userId,
        name: emp.name,
        employmentType: emp.employmentType,
        tier: emp.tier,
        tierEffectiveDate: emp.tierEffectiveDateUsed,
      };
      const record = buildWeeklyRecord({ computation, employee, calcDateIso });
      // The first cycle is assembled BY the backfill (RULING 4): its four
      // weekly records are born Assigned to Current Cycle, never re-counted
      // into another cycle (Phase C's submission flow locks the membership).
      record.cycle_id = BACKFILL_CYCLE_ID;
      record.assignment = "current_cycle";
      await store.upsertCommissionWeeklyRecord(record);
      recordsWritten += 1;
    }
  }
  await store.upsertCommissionCycle(buildBackfillCycleRow());
  return { recordsWritten, cycleId: BACKFILL_CYCLE_ID };
}
