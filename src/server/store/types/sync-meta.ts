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
 * 2026-11-04 publish-swap incidents (two orphaned running rows, providers
 * blocked ~36 min): the reaper window is now PER-PROVIDER — see
 * staleRunReapMinutesFor below. This constant remains the DEFAULT window for
 * every provider without a tighter override, and every default consumer
 * (store guards, reaper, watchdog, badges) reads the window THROUGH
 * staleRunReapMinutesFor, so a provider-specific window can never drift from
 * its guard.
 *
 * Defined HERE (not in sync/scheduler) for the same no-cycle reason as the
 * reap window below: both stores need it in getRunningSyncRun without
 * importing the scheduler (which imports the store — a cycle).
 */
export const TICK_WATCHDOG_CAP_MS = 30 * 60_000;

/**
 * STALE-RUN REAP WINDOW — the DEFAULT (owner directive 2026-09-28): a bounded
 * provider's "running" sync_runs row stuck longer than this is a hung process,
 * not a live one. DELIBERATE ALIAS — derived from TICK_WATCHDOG_CAP_MS (the
 * one shared liveness bound above): the store guards null past it, the reaper
 * reaps after it, so the window and the guards can never drift apart. Kept as
 * a public minutes-valued constant because the reaper's honest error message
 * and other consumers (freshness watchdog, Settings running badge) speak in
 * minutes. PER-PROVIDER windows: consumers must read the window through
 * staleRunReapMinutesFor(provider) — HighLevel carries a tighter window (see
 * HIGHLEVEL_STALE_RUN_REAP_MINUTES), every other provider uses THIS one (12
 * minutes is provably UNSAFE for them: Acuity's legit run budget is 25 min
 * and a legitimate sheets run finished SUCCESS at 17m28s).
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
 * SAFETY MARGIN between a provider's run budget and its stale-run reap window.
 * The reaper (and every running-row guard) must never reap a row a LIVE
 * process could still be finishing: a budgeted pass aborts AT its budget and
 * its caller's error path finishes the row within seconds, so a small margin
 * keeps the window strictly above every legitimate run. HighLevel's window is
 * budget (10 min) + this margin; the default window (30 min) sits 20 min above
 * the HighLevel budget and above every other provider's ceiling.
 */
export const REAP_WINDOW_MARGIN_MINUTES = 2;

/**
 * HIGHLEVEL STALE-RUN REAP WINDOW (owner directive 2026-11-05, publish-swap
 * incidents): an orphaned HighLevel 'running' row is a hung process after 12
 * minutes, not a live one — reaped within one reaper cadence past this, so a
 * serve restart/publish swap can no longer block HighLevel (and hold the
 * freshness banner up) for half an hour.
 *
 * 12 minutes = the 10-minute HIGHLEVEL_RUN_BUDGET_MS + the 2-minute
 * REAP_WINDOW_MARGIN_MINUTES. The budget already guarantees no LIVE pass can
 * hold a 'running' row past 10 minutes (a breach rejects and the caller's
 * error path finishes the row), so anything older is a dead process by
 * construction — while the window still sits safely above every legitimate
 * run. Deliberately NOT env-overridable: no env var exists for it and no new
 * config surface is warranted.
 *
 * PER-PROVIDER, NOT GLOBAL: 12 minutes is provably UNSAFE as a global window —
 * Acuity's legitimate run budget is 25 minutes (ACUITY_RUN_BUDGET_MS) and a
 * legitimate sheets run finished SUCCESS at 17m28s (the field evidence that
 * killed the old 15-minute bounds). Every OTHER provider keeps the 30-minute
 * default (STALE_RUN_REAP_MINUTES).
 */
export const HIGHLEVEL_STALE_RUN_REAP_MINUTES =
  HIGHLEVEL_RUN_BUDGET_MS / 60_000 + REAP_WINDOW_MARGIN_MINUTES;

/**
 * THE ONE WINDOW READER — the stale-run reap window for a provider, in
 * minutes. Every liveness consumer (the reaper, both stores'
 * getRunningSyncRun, the freshness watchdog, the Settings running badge, the
 * Status page's beyond-reap-bound flag) MUST read the window through this so
 * a provider's window and its guard can never drift apart — the same
 * one-reader discipline TICK_WATCHDOG_CAP_MS established for the default.
 * Providers without an override get the 30-minute default.
 */
export function staleRunReapMinutesFor(provider: string): number {
  return provider === "highlevel" ? HIGHLEVEL_STALE_RUN_REAP_MINUTES : STALE_RUN_REAP_MINUTES;
}

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
