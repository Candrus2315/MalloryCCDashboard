/**
 * PER-RUN WALL-CLOCK BUDGET for the HighLevel passes (2026-11-02 wedge —
 * a HighLevel pass hung ~30 min and its 'running' sync_runs row deadlocked
 * every background tick behind the running guard, because the stale-run
 * reaper only closes rows past STALE_RUN_REAP_MINUTES = 30 min).
 *
 * Mirror of the Acuity pattern (acuity-run-budget.ts — module docblock there
 * carries the full rationale; the named constants HIGHLEVEL_RUN_BUDGET_MS /
 * HIGHLEVEL_RUN_BUDGET_ENV live in store/types.ts, the shared-liveness home,
 * next to the reap window they must sit under).
 *
 * WHY NO BUDGET SIGNAL IS PLUMBED DEEPER (the one deliberate divergence from
 * the Acuity helper): nothing inside a HighLevel pass consumes an AbortSignal
 * — every step is ALREADY individually bounded (per-request ~90s fetch
 * timeout, capped page walks, 100ms inter-page pacing), so the race here is
 * purely the RUN-level backstop. The budget races the pass; on breach the
 * caller's EXISTING error path finishes the sync_runs row with the honest
 * "run budget exceeded" message and the next tick retries. The body keeps
 * running detached, exactly like the Acuity breach residual — bounded
 * step-by-step (its own per-request caps), never hammering the DB unbounded.
 */

import { HIGHLEVEL_RUN_BUDGET_ENV, HIGHLEVEL_RUN_BUDGET_MS } from "../store/types";

/**
 * The effective per-run budget in ms — re-read on EVERY call (not cached at
 * module load) so tests and ops drills can set HIGHLEVEL_RUN_BUDGET_MS and
 * have the next pass honor it. Invalid/absent → the named default.
 */
export function highlevelRunBudgetMs(): number {
  const raw = process.env[HIGHLEVEL_RUN_BUDGET_ENV];
  if (!raw) return HIGHLEVEL_RUN_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : HIGHLEVEL_RUN_BUDGET_MS;
}

/**
 * The budget-breach error. Message contains "run budget exceeded" — the
 * phrase surfaces verbatim on the sync_runs row and the connection row so a
 * breached pass is readable at a glance (the reaper's "stale:" message is the
 * only thing this replaces; an honest named error beats a 30-min park).
 */
export class HighLevelRunBudgetExceededError extends Error {
  readonly budgetMs: number;

  constructor(budgetMs: number) {
    super(
      `highlevel run budget exceeded (${Math.round(budgetMs / 60_000)} min) — pass aborted so its sync_runs row could finish with this error instead of parking 'running' until the 30-min stale-run reaper`,
    );
    this.name = "HighLevelRunBudgetExceededError";
    this.budgetMs = budgetMs;
  }
}

/**
 * Run one HighLevel pass body under the per-run wall-clock budget (see module
 * docblock). Resolves with the body's value on a healthy pass — the budget
 * then never trips (timer cleared). On breach the returned promise rejects
 * with HighLevelRunBudgetExceededError; the caller's existing catch finishes
 * the sync_runs row with that message and the next tick retries.
 */
export async function raceHighLevelRunBudget<T>(
  body: () => Promise<T>,
  opts?: { budgetMs?: number },
): Promise<T> {
  const budgetMs = opts?.budgetMs ?? highlevelRunBudgetMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      body(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HighLevelRunBudgetExceededError(budgetMs)), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
