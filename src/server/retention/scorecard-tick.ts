/**
 * RETENTION SCORECARD TICK (stage 3c) — scheduler wiring for the weekly
 * scorecard (retention/scorecard.ts), pattern-matched on the shipped
 * retention tick (retention/tick.ts):
 *
 *   - MONDAY TRIGGER: background ticks run the scorecard only on MONDAY at
 *     or after 06:00 ET, for the PRIOR COMPLETED Mon–Sun ET week. The
 *     compute is idempotent (append-if-new; a stored week is never
 *     rewritten), so every later Monday tick re-checks and no-ops.
 *   - BOOT BACKFILL: once per process, one bounded attempt to backfill the
 *     most recent missing week at any time (a restart Monday afternoon
 *     still gets its scorecard; a failed attempt is recorded, never retried
 *     by the boot path — the Monday gate picks the week up next Monday).
 *   - FAILURES NEVER FAIL THE TICK: errors are recorded on the
 *     retention-scorecard sync_runs row and returned, never thrown.
 *   - OWN SYNC_RUNS PROVIDER: "retention-scorecard" (visible in the Sync
 *     Center / audit infra); a run row is written only when a compute is
 *     actually attempted (skips stay quiet).
 *
 * Manual triggers (SYNC NOW) always attempt the prior completed week.
 */
import type { Store } from "../store/types";
import { withSyncWriteRetry } from "../store/sync-write-retry";
import { etDateStrFromInstant, etDayStartUtc } from "../date-logic";
import {
  computeAndStoreWeeklyScorecard,
  etDayOfWeek,
  priorCompletedWeekEt,
} from "./scorecard";

/** ET minutes after midnight the Monday compute unlocks (06:00 ET). */
export const SCORECARD_COMPUTE_MINUTES_ET = 6 * 60;
/** ET weekday of Monday (Date.UTC getUTCDay convention: 0=Sun … 1=Mon). */
export const ET_MONDAY = 1;
/** Minimum gap between background scorecard CHECKS (the stored-week guard makes them cheap; this keeps Monday ticks quiet). */
export const SCORECARD_CHECK_MIN_INTERVAL_MS = 10 * 60_000;
/** A "running" retention-scorecard sync_runs row older than this is a crashed process. */
const STALE_RUNNING_CUTOFF_MS = 2 * 3_600_000;

let lastBackgroundCheckAt = 0;
/** Test seam: clear the background check throttle between tests. */
export function resetRetentionScorecardThrottle(): void {
  lastBackgroundCheckAt = 0;
}

let bootBackfillAttempted = false;
/** Test seam: re-arm the one-bounded-attempt boot backfill. */
export function resetRetentionScorecardBootBackfill(): void {
  bootBackfillAttempted = false;
}

export type RetentionScorecardTickResult =
  | { outcome: "computed"; weekStart: string; weekEnd: string; created: boolean }
  | { outcome: "already-stored"; weekStart: string; weekEnd: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "error"; error: string };

/** ET minute-of-day for an instant (against the ET calendar day). */
function etMinuteOfDay(nowMs: number): number {
  return Math.floor((nowMs - Date.parse(etDayStartUtc(etDateStrFromInstant(nowMs)))) / 60_000);
}

/**
 * Shared run body: running-guard → sync_runs row → compute+store → finish.
 * Never throws (the caller's contract is "never fails the tick").
 */
async function runScorecard(
  store: Store,
  week: { weekStart: string; weekEnd: string },
  now: () => Date,
): Promise<RetentionScorecardTickResult> {
  const running = await store.getRunningSyncRun("retention-scorecard");
  if (running) {
    const startedMs = Date.parse(running.started_at);
    const stale = !Number.isFinite(startedMs) || now().getTime() - startedMs > STALE_RUNNING_CUTOFF_MS;
    if (!stale) return { outcome: "skipped", reason: "sync-in-progress" };
  }
  const runId = await store.insertSyncRun("retention-scorecard");
  try {
    const res = await computeAndStoreWeeklyScorecard(store, { weekStart: week.weekStart, weekEnd: week.weekEnd, now });
    await store.finishSyncRun(runId, "success", res.outcome === "computed" ? 1 : 0, null);
    if (res.outcome === "already-stored") return { outcome: "already-stored", weekStart: week.weekStart, weekEnd: week.weekEnd };
    return { outcome: "computed", weekStart: week.weekStart, weekEnd: week.weekEnd, created: res.created };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await store.finishSyncRun(runId, "error", 0, msg);
    } catch {
      // the run row is best-effort; the error itself must still surface
    }
    return { outcome: "error", error: msg };
  }
}

/**
 * The Monday ~06:00 ET weekly trigger (background) / on-demand attempt (manual).
 * Background: gates = ET Monday + ≥06:00 ET + check throttle + not already
 * stored. Manual: always attempts the prior completed week (idempotent).
 */
export async function retentionScorecardTick(options?: {
  store?: Store;
  now?: () => Date;
  trigger?: "background" | "manual";
}): Promise<RetentionScorecardTickResult> {
  const now = options?.now ?? (() => new Date());
  // SYNC WRITE RESILIENCE: idempotent sync writes retry transient DB failures.
  const store = withSyncWriteRetry(options?.store ?? (await import("../store").then((m) => m.getStore())));
  const trigger = options?.trigger ?? "background";
  const nowMs = now().getTime();
  const todayEt = etDateStrFromInstant(nowMs);
  const prior = priorCompletedWeekEt(todayEt);

  if (trigger !== "manual") {
    if (etDayOfWeek(todayEt) !== ET_MONDAY) return { outcome: "skipped", reason: "not-monday" };
    if (etMinuteOfDay(nowMs) < SCORECARD_COMPUTE_MINUTES_ET) return { outcome: "skipped", reason: "before-0600-et" };
    if (nowMs - lastBackgroundCheckAt < SCORECARD_CHECK_MIN_INTERVAL_MS) {
      return { outcome: "skipped", reason: "recent-check" };
    }
    const existing = await store.getRetentionScorecard(prior.weekStart);
    if (existing) {
      lastBackgroundCheckAt = nowMs;
      return { outcome: "already-stored", weekStart: prior.weekStart, weekEnd: prior.weekEnd };
    }
  }
  const res = await runScorecard(store, prior, now);
  if (trigger !== "manual" && res.outcome !== "skipped") lastBackgroundCheckAt = nowMs;
  return res;
}

/**
 * BOOT BACKFILL — the most recent missing week, ONE bounded attempt per
 * process (success, already-stored, skip, or error; the flag consumes the
 * attempt either way). Called from the scheduler's first tick; never throws.
 */
export async function ensureRetentionScorecardBootBackfill(options?: {
  store?: Store;
  now?: () => Date;
}): Promise<RetentionScorecardTickResult> {
  if (bootBackfillAttempted) return { outcome: "skipped", reason: "boot-backfill-already-attempted" };
  bootBackfillAttempted = true;
  const now = options?.now ?? (() => new Date());
  const store = withSyncWriteRetry(options?.store ?? (await import("../store").then((m) => m.getStore())));
  const prior = priorCompletedWeekEt(etDateStrFromInstant(now().getTime()));
  const existing = await store.getRetentionScorecard(prior.weekStart);
  if (existing) return { outcome: "already-stored", weekStart: prior.weekStart, weekEnd: prior.weekEnd };
  return runScorecard(store, prior, now);
}
