/**
 * RETENTION TICK (stage 3a) — the scheduler wiring for the retention
 * computation core (retention/compute.ts), pattern-matched on
 * attributionTick (sync/attribution-tick.ts):
 *
 *   - RUNNING GUARD: skip while a "retention" sync_runs row is in flight
 *     (a stale row older than 12h is a crashed process, not a live one);
 *   - THROTTLE: background triggers run at most once per
 *     RETENTION_MIN_INTERVAL_MS (5 min) — manual triggers skip it;
 *   - FAILURES NEVER FAIL THE TICK: errors are recorded on the sync_runs row
 *     and returned, never thrown into the scheduler loop.
 *
 * The compute itself is idempotent and cheap (diff-writes only), so a tick
 * that runs costs seconds and re-runs write nothing. No new loop, no new
 * process: it piggy-backs the existing scheduler tick like every other
 * independent refresh (owner reliability directive).
 */
import type { Store } from "../store/types";
import { withSyncWriteRetry } from "../store/sync-write-retry";
import { computeRetention, type RetentionComputeResult } from "./compute";

/** Minimum gap between BACKGROUND retention recomputes (manual skips it). */
export const RETENTION_MIN_INTERVAL_MS = 5 * 60_000;
/** A "running" retention sync_runs row older than this is a crashed process. */
const STALE_RUNNING_CUTOFF_MS = 12 * 3_600_000;

let lastBackgroundTickAt = 0;
/** Test seam: clear the background throttle between tests. */
export function resetRetentionThrottle(): void {
  lastBackgroundTickAt = 0;
}

export type RetentionTickResult =
  | (RetentionComputeResult & { outcome: "synced" })
  | { outcome: "skipped"; reason: string }
  | { outcome: "error"; error: string };

export async function retentionTick(options?: {
  store?: Store;
  now?: () => Date;
  trigger?: "background" | "manual";
}): Promise<RetentionTickResult> {
  const now = options?.now ?? (() => new Date());
  // SYNC WRITE RESILIENCE: idempotent sync writes retry transient DB failures.
  const store = withSyncWriteRetry(options?.store ?? (await import("../store").then((m) => m.getStore())));
  const trigger = options?.trigger ?? "background";

  const running = await store.getRunningSyncRun("retention");
  if (running) {
    const startedMs = Date.parse(running.started_at);
    const stale = !Number.isFinite(startedMs) || now().getTime() - startedMs > STALE_RUNNING_CUTOFF_MS;
    if (!stale) return { outcome: "skipped", reason: "sync-in-progress" };
  }

  if (trigger === "background" && now().getTime() - lastBackgroundTickAt < RETENTION_MIN_INTERVAL_MS) {
    return { outcome: "skipped", reason: "recent-tick" };
  }

  const runId = await store.insertSyncRun("retention");
  try {
    const res = await computeRetention(store, { now });
    await store.finishSyncRun(runId, "success", res.appointmentsEvaluated, null);
    if (trigger === "background") lastBackgroundTickAt = now().getTime();
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishSyncRun(runId, "error", 0, msg);
    return { outcome: "error", error: msg };
  }
}
