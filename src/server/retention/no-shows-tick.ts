/**
 * RETENTION NO-SHOW TICK (stage 4b) — scheduler wiring for the no-show
 * pipeline engine (retention/no-shows.ts), pattern-matched on the shipped
 * retention + cancellations + scorecard ticks:
 *
 *   own sync_runs provider "retention-no-shows" (never collides with the
 *   compute / scorecard / cancellations runs);
 *   a running-guard that skips when the provider already has an in-flight
 *   run (stale rows honest-fail via the shared reap discipline);
 *   a 5-minute background throttle (manual SYNC NOW skips it);
 *   the engine never fails the tick — a caught error records the run and
 *   returns honestly.
 *
 * The compute itself is idempotent and cheap (diff-writes only), so a tick
 * that runs costs seconds and re-runs write nothing. No new loop, no new
 * process: it piggy-backs the existing scheduler tick.
 */
import type { Store } from "../store/types";
import { withSyncWriteRetry } from "../store/sync-write-retry";
import { computeRetentionNoShows, type RetentionNoShowsResult } from "./no-shows";

/** Minimum gap between BACKGROUND no-show passes (manual skips it). */
export const RETENTION_NOSHOW_MIN_INTERVAL_MS = 5 * 60_000;
/** A "running" no-show run older than this is a crashed process — skip + let the reaper close it. */
export const RETENTION_NOSHOW_STALE_RUNNING_MS = 15 * 60_000;

let lastBackgroundTickAt = 0;

export type RetentionNoShowTickResult =
  | (RetentionNoShowsResult & { outcome: "synced" })
  | { outcome: "skipped"; reason: string }
  | { outcome: "error"; error: string };

/**
 * One no-show pipeline pass. Injectable store + clock for tests. Never called
 * from the UI (the "do not write to retention tables from the UI" rule).
 */
export async function retentionNoShowTick(options?: {
  store?: Store;
  now?: () => Date;
  trigger?: "background" | "manual";
}): Promise<RetentionNoShowTickResult> {
  const now = options?.now ?? (() => new Date());
  const store = withSyncWriteRetry(options?.store ?? (await import("../store").then((m) => m.getStore())));
  const trigger = options?.trigger ?? "background";
  const running = await store.getRunningSyncRun("retention-no-shows");
  if (running) {
    const startedMs = Date.parse(running.started_at);
    const stale = !Number.isFinite(startedMs) || now().getTime() - startedMs > RETENTION_NOSHOW_STALE_RUNNING_MS;
    return { outcome: "skipped", reason: stale ? "stale-run-in-progress" : "sync-in-progress" };
  }
  if (trigger === "background" && now().getTime() - lastBackgroundTickAt < RETENTION_NOSHOW_MIN_INTERVAL_MS) {
    return { outcome: "skipped", reason: "throttled" };
  }
  const runId = await store.insertSyncRun("retention-no-shows");
  try {
    const res = await computeRetentionNoShows(store, { now });
    await store.finishSyncRun(runId, "success", res.noShowsEvaluated, null);
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
