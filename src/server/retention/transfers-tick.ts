/**
 * RETENTION TRANSFERS TICK (stage 5) — scheduler wiring for the transfers
 * engine (retention/transfers.ts), pattern-matched on the shipped retention +
 * cancellations + no-shows ticks:
 *
 *   own sync_runs provider "retention-transfers" (never collides with the
 *   compute / scorecard / cancellations / no-shows runs);
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
import { computeRetentionTransfers, type RetentionTransfersResult } from "./transfers";

/** Minimum gap between BACKGROUND transfers passes (manual skips it). */
export const RETENTION_TRANSFERS_MIN_INTERVAL_MS = 5 * 60_000;
/** A "running" transfers run older than this is a crashed process — skip + let the reaper close it. */
export const RETENTION_TRANSFERS_STALE_RUNNING_MS = 15 * 60_000;

let lastBackgroundTickAt = 0;
/** Test seam: clear the background throttle between tests (same as the sibling ticks). */
export function resetRetentionTransfersThrottle(): void {
  lastBackgroundTickAt = 0;
}

export type RetentionTransfersTickResult =
  | (RetentionTransfersResult & { outcome: "synced" })
  | { outcome: "skipped"; reason: string }
  | { outcome: "error"; error: string };

/**
 * One transfers pipeline pass. Injectable store + clock for tests. Never
 * called from the UI (the "do not write to retention tables from the UI"
 * rule) — the tick owns it.
 */
export async function retentionTransfersTick(options?: {
  store?: Store;
  now?: () => Date;
  trigger?: "background" | "manual";
}): Promise<RetentionTransfersTickResult> {
  const now = options?.now ?? (() => new Date());
  const store = withSyncWriteRetry(options?.store ?? (await import("../store").then((m) => m.getStore())));
  const trigger = options?.trigger ?? "background";
  const running = await store.getRunningSyncRun("retention-transfers");
  if (running) {
    const startedMs = Date.parse(running.started_at);
    const stale = !Number.isFinite(startedMs) || now().getTime() - startedMs > RETENTION_TRANSFERS_STALE_RUNNING_MS;
    return { outcome: "skipped", reason: stale ? "stale-run-in-progress" : "sync-in-progress" };
  }
  if (trigger === "background" && now().getTime() - lastBackgroundTickAt < RETENTION_TRANSFERS_MIN_INTERVAL_MS) {
    return { outcome: "skipped", reason: "throttled" };
  }
  const runId = await store.insertSyncRun("retention-transfers");
  try {
    const res = await computeRetentionTransfers(store, { now });
    await store.finishSyncRun(runId, "success", res.transfersEvaluated, null);
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
