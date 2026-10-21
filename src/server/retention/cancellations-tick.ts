/**
 * RETENTION CANCELLATIONS TICK (stage 4a) — scheduler wiring for the
 * cancellations ledger engine (retention/cancellations.ts), pattern-matched
 * on the shipped retention + scorecard ticks:
 *
 *   - RUNNING GUARD: skip while a "retention-cancellations" sync_runs row is
 *     in flight (a stale row older than 12h is a crashed process, not a live
 *     one);
 *   - THROTTLE: background triggers run at most once per
 *     RETENTION_CANCELLATIONS_MIN_INTERVAL_MS (5 min) — manual triggers skip
 *     it;
 *   - FAILURES NEVER FAIL THE TICK: errors are recorded on the sync_runs row
 *     and returned, never thrown into the scheduler loop.
 *
 * OWN SYNC_RUNS PROVIDER: "retention-cancellations" (visible in the Sync
 * Center / audit infra). The compute is idempotent and cheap (diff-writes
 * only), so a tick that runs costs seconds and re-runs write nothing. No new
 * loop, no new process: it piggy-backs the existing scheduler tick.
 */
import type { Store } from "../store/types";
import { withSyncWriteRetry } from "../store/sync-write-retry";
import { computeRetentionCancellations, type RetentionCancellationsResult } from "./cancellations";

/** Minimum gap between BACKGROUND cancellations recomputes (manual skips it). */
export const RETENTION_CANCELLATIONS_MIN_INTERVAL_MS = 5 * 60_000;
/** A "running" retention-cancellations sync_runs row older than this is a crashed process. */
const STALE_RUNNING_CUTOFF_MS = 12 * 3_600_000;

let lastBackgroundTickAt = 0;
/** Test seam: clear the background throttle between tests. */
export function resetRetentionCancellationsThrottle(): void {
  lastBackgroundTickAt = 0;
}

export type RetentionCancellationsTickResult =
  | (RetentionCancellationsResult & { outcome: "synced" })
  | { outcome: "skipped"; reason: string }
  | { outcome: "error"; error: string };

export async function retentionCancellationsTick(options?: {
  store?: Store;
  now?: () => Date;
  trigger?: "background" | "manual";
}): Promise<RetentionCancellationsTickResult> {
  const now = options?.now ?? (() => new Date());
  // SYNC WRITE RESILIENCE: idempotent sync writes retry transient DB failures.
  const store = withSyncWriteRetry(options?.store ?? (await import("../store").then((m) => m.getStore())));
  const trigger = options?.trigger ?? "background";

  const running = await store.getRunningSyncRun("retention-cancellations");
  if (running) {
    const startedMs = Date.parse(running.started_at);
    const stale = !Number.isFinite(startedMs) || now().getTime() - startedMs > STALE_RUNNING_CUTOFF_MS;
    if (!stale) return { outcome: "skipped", reason: "sync-in-progress" };
  }

  if (trigger === "background" && now().getTime() - lastBackgroundTickAt < RETENTION_CANCELLATIONS_MIN_INTERVAL_MS) {
    return { outcome: "skipped", reason: "recent-tick" };
  }

  const runId = await store.insertSyncRun("retention-cancellations");
  try {
    const res = await computeRetentionCancellations(store, { now });
    await store.finishSyncRun(runId, "success", res.cancellationsEvaluated, null);
    if (trigger === "background") lastBackgroundTickAt = now().getTime();
    return res;
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
