/**
 * COMMISSION HISTORICAL BACKFILL RUNNER (spec §25 — the acceptance test).
 *
 * Default (no flags): READ-ONLY. Computes the four validation weeks from the
 * real stored booking data and prints the per-employee per-week numbers
 * (bookings / base / pool / holes / total) plus the cycle rollup — the output
 * the owner validates against their own Sep records.
 *
 * `--write`: THE DELIBERATE WRITE — persists the four weekly records (status
 * final, assignment unassigned) and the "Aug 31 – Sep 27, 2026" cycle row
 * (submission 2026-10-05, payroll 2026-10-09, status in_progress). Idempotent;
 * run only after the dry-run numbers are reviewed.
 *
 * Run:  bun scripts/commission-backfill.ts           (dry-run, read-only)
 *       bun scripts/commission-backfill.ts --write   (persist — deliberate)
 */
import { getSecret } from "../src/server/env";
import { PgStore } from "../src/server/store/pg";
import { computeValidationWeeks, rollupCycle, buildBackfillCycleRow, BACKFILL_CYCLE_ID, writeBackfillCycle } from "../src/server/commission/backfill";

const WRITE = process.argv.includes("--write");
const url = getSecret("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL not resolvable — aborted, nothing touched.");
  process.exit(1);
}
const store = new PgStore(url);
await store.ensureSchema();

console.log(`COMMISSION BACKFILL — ${WRITE ? "WRITE MODE (persisting records)" : "DRY-RUN (read-only)"} @ ${new Date().toISOString()}`);
const weeks = await computeValidationWeeks(store);
const rollup = rollupCycle(BACKFILL_CYCLE_ID, buildBackfillCycleRow().label, weeks);

for (const w of weeks) {
  console.log(`\n=== WEEK ${w.weekStart} .. ${w.weekEnd} ===`);
  console.log(`team qualifying bookings (rep-attributed): ${w.teamQualifyingBookings} — pool ${w.poolUnlocked ? `UNLOCKED ($${(w.poolTotalCents / 100).toFixed(2)})` : "LOCKED"}`);
  for (const e of w.employees) {
    console.log(
      `  ${e.name.padEnd(18)} T${e.tier} ${e.employmentType === "full_time" ? "FT" : "PT"} | bookings ${String(e.qualifyingBookings).padStart(3)} | base $${((e.baseCents + e.additionalCents) / 100).toFixed(2).padStart(8)} | pool $${(e.poolCents / 100).toFixed(2).padStart(7)} | holes ${e.filledHoles} ($${(e.holeCents / 100).toFixed(2)}) | TOTAL $${(e.totalCents / 100).toFixed(2)}`,
    );
  }
  console.log(`  slots ${w.totalSlots} · open at week start ${w.openAtStart} · filled in-week by rep wins ${w.holeAudit.length}\n  slot-day detail: ${w.holeDays.map((d) => `${d.date.slice(5)} open ${d.openAtStart}/${d.capacity}${d.filledByRep ? ` · rep-filled ${d.filledByRep}` : ""}`).join("  ")}`);
}

console.log(`\n=== CYCLE ROLLUP — ${rollup.label} (id ${rollup.cycleId}) ===`);
console.log(`submission ${buildBackfillCycleRow().submission_date} · payroll ${buildBackfillCycleRow().payroll_date} · team bookings ${rollup.teamTotalBookings} · team total $${(rollup.teamTotalCents / 100).toFixed(2)} (pool $${(rollup.teamPoolCents / 100).toFixed(2)}, holes $${(rollup.teamHoleCents / 100).toFixed(2)})`);
for (const emp of rollup.perEmployee) {
  console.log(
    `  ${emp.name.padEnd(18)} T${emp.tier} | cycle bookings ${String(emp.totalBookings).padStart(3)} | per-week [${emp.weeks.map((w) => `${w.weekStart.slice(5)}:${w.bookings}`).join(", ")}] | TOTAL $${(emp.totalCents / 100).toFixed(2)}`,
  );
}

if (WRITE) {
  const res = await writeBackfillCycle(store);
  console.log(`\nWROTE: ${res.recordsWritten} weekly records + cycle ${res.cycleId}. Re-run safe (idempotent).`);
} else {
  console.log("\nDry-run only — nothing written. Pass --write to persist (deliberate, post-review).");
}
process.exit(0);
