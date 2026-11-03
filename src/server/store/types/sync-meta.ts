/**
 * SYNC LIVENESS CONSTANTS + HELPERS — moved verbatim from
 * src/server/store/types.ts (docs/DECOMPOSITION-PLAN.md step 4). Deliberately
 * import-free: both stores read these without importing the scheduler
 * (which imports the store — a cycle). sync/scheduler re-exports them.
 */

// ---------- sync-run freshness (shared by both stores + the scheduler) ----------

/**
 * TICK WATCHDOG CAP — THE ONE SHARED LIVENESS BOUND (2026-10-23, forensics
 * scratch/reliability-forensics.md §2). One scheduler tick may hold the loop
 * at most this long (30 min ≫ any real tick: the heaviest legit piece, a
 * manual bootstrap full-sync, is minutes; past the cap the watchdog RELEASES
 * the loop and the independent reaper closes the run's rows), so a bounded
 * provider's "running" sync_runs row OLDER than this cap cannot be a
 * legitimately live run. Every liveness consumer now derives from THIS single
 * constant — no drift possible:
 *   - store getRunningSyncRun nulls rows older than it (pg.ts + memory.ts);
 *   - sheets-tick's running guard re-checks against it directly;
 *   - STALE_RUN_REAP_MINUTES (below) re-derives the reaper's window from it;
 *   - sync/scheduler re-exports both for the tick watchdog + callers/tests.
 *
 * History: the 2026-09-28 owner directive ("a bounded provider's running row
 * stuck too long is a hang") was first encoded as THREE independent 15-minute
 * bounds (the store guard, a sheets-tick duplicate, the reaper window). Field
 * evidence killed that: a legitimate sheets run finished SUCCESS at 17m28s
 * (full REPLACE of 3,870 rows — scratch/fairyland-run17-out.txt) and two
 * real overlaps were captured — any 15-minute bound misclassifies live runs
 * as dead. 30 min is the tick ceiling itself, so nothing legitimately running
 * can be misclassified, while a genuinely hung row is still reaped within one
 * reaper cadence past the cap.
 *
 * Defined HERE (not in sync/scheduler) for the same no-cycle reason as the
 * reap window below: both stores need it in getRunningSyncRun without
 * importing the scheduler (which imports the store — a cycle).
 */
export const TICK_WATCHDOG_CAP_MS = 30 * 60_000;

/**
 * STALE-RUN REAP WINDOW (owner directive 2026-09-28): a bounded provider's
 * "running" sync_runs row stuck longer than this is a hung process, not a live
 * one. DELIBERATE ALIAS — derived from TICK_WATCHDOG_CAP_MS (the one shared
 * liveness bound above): the store guards null past it, the reaper reaps after
 * it, so the window and the guards can never drift apart. Kept as a public
 * minutes-valued constant because the reaper's honest error message and other
 * consumers (freshness watchdog, Settings running badge) speak in minutes.
 * Defined HERE (not in sync/scheduler) so both stores can use it in
 * getRunningSyncRun without importing the scheduler (which imports the store
 * — a cycle). sync/scheduler re-exports it for its callers/tests.
 */
export const STALE_RUN_REAP_MINUTES = TICK_WATCHDOG_CAP_MS / 60_000;

/**
 * PER-RUN WALL-CLOCK BUDGET for the HighLevel passes (2026-11-02 wedge — a
 * HighLevel pass hung ~30 min and its 'running' sync_runs row deadlocked every
 * tick behind the running guard, because nothing bounded the RUN as a whole).
 * Mirror of the Acuity budget (sync/acuity-run-budget.ts, which carries the
 * full rationale + the race mechanics); the named constant lives HERE — the
 * shared-liveness-constants home — next to the reap window it must sit under,
 * so the invariant is checkable without an import cycle (raceHighLevelRunBudget
 * in sync/highlevel-run-budget.ts consumes it).
 *
 * 10 minutes: HighLevel passes normally finish in seconds (incremental harvest
 * caps its page walks; every fetch is individually bounded by the ~90s
 * fetch-timeout), and 10 min sits WELL under the 30-min STALE_RUN_REAP_MINUTES
 * window — a breached pass rejects, the caller's EXISTING error path finishes
 * the row with the honest "run budget exceeded" error, and the next tick
 * retries, so the row never parks 'running' and the reaper keeps its meaning
 * (crashed processes only). Env-overridable via HIGHLEVEL_RUN_BUDGET_MS (ms);
 * an invalid value falls back to the default rather than disabling the bound.
 */
export const HIGHLEVEL_RUN_BUDGET_MS = 10 * 60_000;

/** The env var that can override the HighLevel run budget (milliseconds). */
export const HIGHLEVEL_RUN_BUDGET_ENV = "HIGHLEVEL_RUN_BUDGET_MS";

/**
 * Defensive started_at parse. Accepts ISO strings AND Postgres's text form
 * ("YYYY-MM-DD HH:MM:SS.ffffff+00" — space separator, microseconds) that some
 * engines' Date.parse rejects; retries with a "T" separator before giving up.
 * Returns NaN when unparsable — callers treat that as stale and never crash.
 */
export function parseSyncStartedMs(raw: string): number {
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  return Date.parse(raw.replace(" ", "T"));
}
