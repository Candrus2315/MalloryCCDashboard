/**
 * PER-RUN WALL-CLOCK BUDGET for the whole Acuity pass (2026-10-30 wedge fix,
 * investigation cause #2 — /home/team/shared/sync-investigation-2026-10-30.md,
 * fix candidate #2; owner-approved work).
 *
 * WHY THIS EXISTS: both Acuity entry paths (the runProvider "acuity" section
 * in sync/run.ts and the background availabilityTick in acuity-live.ts) insert
 * the sync_runs row, await the whole pass, then finish the row. Every step
 * inside a pass is individually bounded (per-request caps, body-read race,
 * statement_timeout, ingest deadline) but nothing bounded the RUN as a whole,
 * so a long chain of individually-bounded steps — or any single unbounded
 * await, e.g. the pacing-sleep hole this PR also closes — parked the row
 * `running` until the independent stale-run reaper fired ~30 minutes later,
 * while the running-guard blocked every background pass in between (the
 * 2026-10-30T19:31:08Z pass: `running`, 0 upserts, no error, ~30 min).
 *
 * THE 30-MIN REAP RELATIONSHIP (why exactly 25): the store nulls a `running`
 * row older than STALE_RUN_REAP_MINUTES = 30 (store/types.ts, derived from
 * TICK_WATCHDOG_CAP_MS) and the scheduler's reaper then marks it `error`.
 * This budget sits safely UNDER that window so a breached pass rejects and
 * the caller's EXISTING error path finishes the row with an honest
 * "run budget exceeded" error BEFORE the reaper would fire — the row never
 * parks, the running-guard never blocks, and the reaper keeps its meaning
 * (crashed processes only). A pin in acuity-run-budget.test.ts asserts
 * budget < reap window so the relationship survives constant edits.
 *
 * INTERACTION WITH THE INGEST DEADLINE (store/ingest-batch.ts,
 * INGEST_RUN_DEADLINE_MS = 40 min): for the ACUITY lane this run budget
 * supersedes the ingest deadline in practice — 25 min < 40 min, so a live
 * acuity pass breaches this budget first. The ingest deadline is untouched
 * and keeps its original job: force-stopping the DETACHED chain. After the
 * race below rejects, the body keeps running detached (bounded step-by-step:
 * per-request caps on fetches, the ingest deadline on its store writes), so
 * a zombie's remaining work still cannot hammer the DB for hours. The
 * HighLevel lane's semantics are NOT touched by this module.
 *
 * MECHANICS: raceAcuityRunBudget(body) runs the pass under Promise.race with
 * a deadline timer. On breach it aborts the budget AbortSignal (fed into
 * reconcileCancellations so queued/in-flight probes refuse or reject cleanly
 * — the makeBudgetBoundedFetch pattern, body-read.ts:83-98) and rejects with
 * AcuityRunBudgetExceededError. The default is env-overridable via
 * ACUITY_RUN_BUDGET_MS (ms) so operations can shrink it for a drill; an
 * invalid value falls back to the default rather than disabling the bound.
 */

/** Named default: 25 minutes — 5 minutes under the 30-min reap window. */
export const ACUITY_RUN_BUDGET_MS = 25 * 60_000;

/** The env var that can override the default budget (milliseconds). */
export const ACUITY_RUN_BUDGET_ENV = "ACUITY_RUN_BUDGET_MS";

/**
 * The effective per-run budget in ms — re-read on EVERY call (not cached at
 * module load) so tests and ops drills can set ACUITY_RUN_BUDGET_MS and have
 * the next pass honor it. Invalid/absent → the named default.
 */
export function acuityRunBudgetMs(): number {
  const raw = process.env[ACUITY_RUN_BUDGET_ENV];
  if (!raw) return ACUITY_RUN_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : ACUITY_RUN_BUDGET_MS;
}

/**
 * The budget-breach error. Message contains "run budget exceeded" — the
 * phrase surfaces verbatim on the sync_runs row and the connection row so a
 * breached pass is readable at a glance (the reaper's "stale:" message is the
 * only thing this replaces; an honest named error beats a 30-min park).
 */
export class AcuityRunBudgetExceededError extends Error {
  readonly budgetMs: number;

  constructor(budgetMs: number) {
    super(
      `acuity run budget exceeded (${Math.round(budgetMs / 60_000)} min) — pass aborted so its sync_runs row could finish with this error instead of parking 'running' until the 30-min stale-run reaper`,
    );
    this.name = "AcuityRunBudgetExceededError";
    this.budgetMs = budgetMs;
  }
}

/** Handed to the pass body so deep steps can honor the same deadline. */
export interface AcuityRunBudget {
  /** Aborted exactly when the budget is exhausted. */
  readonly signal: AbortSignal;
}

/**
 * Run one Acuity pass body under the per-run wall-clock budget (see module
 * docblock). Resolves with the body's value on a healthy pass — the budget
 * then never trips (timer cleared, signal never aborted). On breach the
 * budget signal aborts FIRST (so in-flight/queued probes reject immediately)
 * and the returned promise rejects with AcuityRunBudgetExceededError; the
 * caller's existing catch finishes the sync_runs row with that message. The
 * body keeps running detached — see the ingest-deadline note in the module
 * docblock for why that residual is bounded.
 */
export async function raceAcuityRunBudget<T>(
  body: (budget: AcuityRunBudget) => Promise<T>,
  opts?: { budgetMs?: number },
): Promise<T> {
  const budgetMs = opts?.budgetMs ?? acuityRunBudgetMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      body({ signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new AcuityRunBudgetExceededError(budgetMs));
          reject(new AcuityRunBudgetExceededError(budgetMs));
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
