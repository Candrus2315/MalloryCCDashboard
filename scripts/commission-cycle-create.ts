/**
 * COMMISSION CYCLE CREATE RUNNER — deliberate metadata-only path (RULING 4).
 *
 * Creates a commission_cycles row for a Mon–Sun weekly span and attaches every
 * ALREADY-STORED final weekly row in that window to it. ZERO changes to any
 * stored weekly value (bookings/totals/status untouched) — the assignment is
 * the narrow `UPDATE commission_weekly SET cycle_id, assignment WHERE
 * week_start BETWEEN ... AND status='final' AND assignment='unassigned'`-style
 * operation (the store's §S membership method semantics), NEVER a row rewrite
 * and never `upsertCommissionWeeklyRecord`. The September cycle and its 16
 * weekly rows are never touched (window overlap with any existing cycle
 * refuses the run before any write).
 *
 * WHY A RAW-CLIENT TRANSACTION INSTEAD OF PgStore: PgStore.ensureSchema() runs
 * a ~204-statement DDL sweep (one round trip each) that HANGS under the
 * provider's degraded TLS (observed 10/12: frozen mid-sweep 12+ minutes). The
 * schema already exists in the live DB, so this runner wires the exact
 * MemoryStore-tested contract (`createAndAssignCommissionCycle` in
 * src/server/commission/cycle-create.ts — pin tests in
 * src/server/__tests__/commission-cycle-create.test.ts) to a thin SQL adapter
 * over ONE postgres.js transaction. All planning happens BEFORE any write and
 * every write is in one transaction: a refusal (overlap, double-bound week) or
 * a crash mid-run leaves the DB byte-identical (rollback).
 *
 * Default (no flags): DRY-RUN — runs the full plan inside a transaction that
 * is always rolled back; prints exactly what WOULD happen; writes nothing.
 * `--write`: THE DELIBERATE WRITE — same plan, committed. Idempotent: safe to
 * rerun after later weekly closes (it picks up newly stored in-window weeks;
 * an existing cycle row is left untouched — never re-upserted — so manager
 * edits to it survive reruns).
 *
 * Run:  bun scripts/commission-cycle-create.ts                     (dry-run, October default)
 *       bun scripts/commission-cycle-create.ts --write             (persist — deliberate)
 *       bun scripts/commission-cycle-create.ts --start YYYY-MM-DD --end YYYY-MM-DD \
 *            [--label "..."] [--submission-date YYYY-MM-DD] [--payroll-date YYYY-MM-DD] --write
 */
import postgres from "postgres";
import { getSecret } from "../src/server/env";
import {
  createAndAssignCommissionCycle,
  firstMondayAfter,
  labelFromSpan,
} from "../src/server/commission/cycle-create";
import type { CommissionCycleRow, CommissionWeeklyRow, Store } from "../src/server/store/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const WRITE = process.argv.includes("--write");

// October 2026 cycle defaults (RULING 4: the four Mon–Sun weeks Sep 28 – Oct 25).
const START = arg("--start") ?? "2026-09-28";
const END = arg("--end") ?? "2026-10-25";
const LABEL = arg("--label");
const SUBMISSION = arg("--submission-date");
const PAYROLL = arg("--payroll-date");

const url = getSecret("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL not resolvable — aborted, nothing touched.");
  process.exit(1);
}

/** pg dates arrive as JS Dates — normalize to the ET date string the domain uses. */
const d = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const mapCycle = (r: Record<string, unknown>): CommissionCycleRow => ({
  id: String(r.id),
  label: String(r.label),
  start_date: d(r.start_date),
  end_date: d(r.end_date),
  submission_date: d(r.submission_date),
  payroll_date: d(r.payroll_date),
  status: String(r.status) as CommissionCycleRow["status"],
  submitted_date: r.submitted_date == null ? null : d(r.submitted_date),
  submitted_by: r.submitted_by == null ? null : String(r.submitted_by),
  final_snapshot: (r.final_snapshot ?? null) as Record<string, unknown> | null,
  created_at: new Date(r.created_at as string).toISOString(),
  updated_at: new Date(r.updated_at as string).toISOString(),
});

/**
 * Thin SQL adapter implementing ONLY the five store methods the contract uses,
 * with the SAME semantics as the pg store:
 *  - setCommissionRecordAssignment = the narrow §S membership update (cycle_id
 *    + assignment only — money columns untouched, no rewrite of stored values);
 *  - upsertCommissionCycle = the same INSERT ... ON CONFLICT (id) DO UPDATE as
 *    pg.ts (the contract only calls it when the row is missing — insert-if-missing);
 *  - weekly rows carry only the columns the contract reads (planning/receipt).
 * Everything runs on ONE transaction handle: reads see a consistent snapshot
 * and writes commit-or-rollback atomically.
 */
function rawStoreAdapter(tx: postgres.Sql): Store {
  return {
    async getCommissionCycles() {
      const rows = await tx`SELECT id, label, start_date, end_date, submission_date, payroll_date, status, submitted_date, submitted_by, final_snapshot, created_at, updated_at FROM commission_cycles ORDER BY start_date DESC`;
      return rows.map((r) => mapCycle(r as Record<string, unknown>));
    },
    async getCommissionCycle(cycleId: string) {
      const rows = await tx`SELECT id, label, start_date, end_date, submission_date, payroll_date, status, submitted_date, submitted_by, final_snapshot, created_at, updated_at FROM commission_cycles WHERE id = ${cycleId}`;
      return rows[0] ? mapCycle(rows[0] as Record<string, unknown>) : null;
    },
    async upsertCommissionCycle(cycle: CommissionCycleRow) {
      await tx`INSERT INTO commission_cycles (id, label, start_date, end_date, submission_date, payroll_date, status, submitted_date, submitted_by, final_snapshot)
        VALUES (${cycle.id}, ${cycle.label}, ${cycle.start_date}::date, ${cycle.end_date}::date, ${cycle.submission_date}::date,
          ${cycle.payroll_date}::date, ${cycle.status}, ${cycle.submitted_date}::date, ${cycle.submitted_by},
          ${cycle.final_snapshot == null ? null : tx.json(cycle.final_snapshot)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
          submission_date = EXCLUDED.submission_date, payroll_date = EXCLUDED.payroll_date, status = EXCLUDED.status,
          submitted_date = EXCLUDED.submitted_date, submitted_by = EXCLUDED.submitted_by,
          final_snapshot = EXCLUDED.final_snapshot, updated_at = now()`;
    },
    async getCommissionWeeklyRecords() {
      const rows = await tx`SELECT user_id, rep_name, week_start, status, cycle_id, assignment, qualifying_bookings, total FROM commission_weekly ORDER BY week_start DESC`;
      return rows.map((r) => ({
        user_id: String(r.user_id),
        rep_name: String(r.rep_name),
        week_start: d(r.week_start),
        status: String(r.status) as CommissionWeeklyRow["status"],
        cycle_id: r.cycle_id == null ? null : String(r.cycle_id),
        assignment: String(r.assignment) as CommissionWeeklyRow["assignment"],
        qualifying_bookings: Number(r.qualifying_bookings),
        total: Number(r.total),
      })) as CommissionWeeklyRow[];
    },
    async setCommissionRecordAssignment(userId: string, weekStart: string, patch: { cycleId: string | null; assignment: CommissionWeeklyRow["assignment"] }) {
      const upd = await tx`UPDATE commission_weekly SET cycle_id = ${patch.cycleId}, assignment = ${patch.assignment}, updated_at = now()
        WHERE user_id = ${userId}::uuid AND week_start = ${weekStart}::date RETURNING user_id`;
      if (upd.length === 0) throw new Error(`No stored weekly record for ${userId}:${weekStart} — membership updates target stored records only.`);
    },
  } as unknown as Store;
}

type ContractResult = Awaited<ReturnType<typeof createAndAssignCommissionCycle>>;
const DRY_ROLLBACK = "__dry_run_rollback__";

const sql = postgres(url, { max: 1, connect_timeout: 30 });
let captured: ContractResult | null = null;
let refused: string | null = null;
try {
  await sql.begin(async (tx) => {
    // The contract plans ALL reads first and refuses BEFORE any write, but the
    // transaction makes even that moot: everything is atomic. In dry-run the
    // sentinel throw forces a rollback of whatever was staged.
    captured = await createAndAssignCommissionCycle(rawStoreAdapter(tx), {
      start: START,
      end: END,
      label: LABEL,
      submissionDate: SUBMISSION,
      payrollDate: PAYROLL,
    });
    if (!WRITE) throw DRY_ROLLBACK; // dry-run: ALWAYS rolled back, nothing persisted
    return captured;
  });
} catch (err) {
  if (err === DRY_ROLLBACK) {
    // expected dry-run exit — captured holds the planned result
  } else {
    refused = err instanceof Error ? err.message : String(err);
  }
}
if (refused != null || captured == null) {
  await sql.end();
  console.error(`\nREFUSED — transaction rolled back, nothing written. ${refused ?? "(no result)"}`);
  process.exit(1);
}
await sql.end();

const res = captured as ContractResult;
console.log(
  `COMMISSION CYCLE CREATE — ${WRITE ? "WRITE MODE (committed)" : "DRY-RUN (rolled back, nothing written)"} @ ${new Date().toISOString()}`,
);
console.log(
  `window ${START} – ${END} · label "${LABEL?.trim() || labelFromSpan(START, END)}" · submission ${SUBMISSION ?? firstMondayAfter(END)} · payroll ${PAYROLL ?? "(Friday of submission week)"}`,
);
console.log(
  `\nCYCLE ROW ${res.cycleCreated ? (WRITE ? "CREATED" : "WOULD BE CREATED") : "ALREADY STORED (left untouched)"}: ${res.cycle.id} | "${res.cycle.label}" | ${res.cycle.start_date}–${res.cycle.end_date} | submission ${res.cycle.submission_date} · payroll ${res.cycle.payroll_date} | status ${res.cycle.status}`,
);
console.log(`\n${WRITE ? "ASSIGNED" : "WOULD ASSIGN"} ${res.assigned.length} stored final weekly row(s):`);
for (const r of res.assigned) {
  console.log(`  ${r.weekStart} ${r.repName.padEnd(18)} bookings ${String(r.qualifyingBookings).padStart(3)} · total $${r.totalDollars.toFixed(2)}  → cycle ${res.cycleId}, assignment current_cycle`);
}
console.log(`ALREADY ASSIGNED ${res.alreadyAssigned.length} row(s) (idempotent no-op).`);
if (res.skippedNotFinal.length > 0) {
  console.log(`SKIPPED ${res.skippedNotFinal.length} in-window non-final row(s) (never assigned):`);
  for (const r of res.skippedNotFinal) console.log(`  ${r.weekStart} ${r.repName}`);
}
console.log(WRITE ? "\nWRITTEN (committed)." : "\nDry-run only — rolled back, nothing written. Pass --write to persist (deliberate).");
process.exit(0);
