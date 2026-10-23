/**
 * BACKGROUND GOOGLE SHEETS TICK — the scheduler wiring for the lead sheets
 * sync, pattern-matched on availabilityTick (acuity-live.ts):
 *
 *   - RUNNING GUARD: skip while a google_sheets sync_runs row is in flight
 *     (staleness is the ONE shared liveness bound — TICK_WATCHDOG_CAP_MS, 30
 *     min, the tick ceiling, canonical in store/types.ts: the store nulls
 *     rows past it and the scheduler's stale-run reaper closes them within
 *     one cadence; this guard re-checks with the SAME parse and bound so it
 *     passes only when the run is genuinely past the bound);
 *   - ADAPTER: the LIVE adapter only — built from the service-account secret +
 *     current Settings sheet config each tick (tests inject via `adapter`).
 *     NO ADAPTER → SKIP. Sheets never demo-falls-back in the background:
 *     demo rows may only ever seed a dataset with no stored google_sheets
 *     leads at all, and that path lives in runSheetsSync (full sync /
 *     bootstrap on a demo-mode DB), never here;
 *   - THROTTLE: background triggers run at most once per
 *     SHEETS_MIN_INTERVAL_MS (sheet data is daily; ~10 min keeps the pages
 *     fresh without hammering Google). Manual triggers (REFRESH / SYNC NOW)
 *     skip the throttle;
 *   - FAILURES NEVER FAIL THE TICK: the error is recorded on the sync_runs +
 *     connection rows (runSheetsSync) and returned — never thrown into the
 *     scheduler loop.
 *
 * ONE computation core (runSheetsSync in run.ts) is shared with the full sync,
 * so background and manual sheets syncs behave identically: live fetch →
 * contact linking → per-sheet REPLACE, with stored leads never demo-replaced.
 */
import { getStore } from "../store";
import { withSyncWriteRetry } from "../store/sync-write-retry";
import { parseSyncStartedMs, TICK_WATCHDOG_CAP_MS, type Store } from "../store/types";
import type { GoogleSheetsAdapter } from "./adapters";
import { runSheetsSync } from "./run";
import { createSheetsAdapter } from "./sheets-live";

/** Minimum gap between BACKGROUND sheets syncs (sheet data is daily). */
export const SHEETS_MIN_INTERVAL_MS = 10 * 60_000;
// (No local running-row staleness constant: the ONE shared liveness bound
// TICK_WATCHDOG_CAP_MS — store/types.ts, 30 min, the tick ceiling — owns it.
// The old duplicate SHEETS_STALE_RUNNING_MS = 15 min misclassified live runs
// as dead: a legit sheets run finished SUCCESS at 17m28s and the guard then
// admitted a second run while the first was still alive — forensics §2.)

export interface SheetsTickResult {
  outcome: "synced" | "skipped" | "error";
  leads?: number;
  reason?: string;
  error?: string;
}

export async function sheetsTick(options?: {
  store?: Store;
  /** Test injection; absent → resolve the live adapter from env + settings (null when no secret → skip). */
  adapter?: GoogleSheetsAdapter | null;
  now?: () => Date;
  trigger?: "background" | "manual";
}): Promise<SheetsTickResult> {
  const now = options?.now ?? (() => new Date());
  // SYNC WRITE RESILIENCE: idempotent sync writes retry transient DB failures.
  const store = withSyncWriteRetry(options?.store ?? (await getStore()));
  const trigger = options?.trigger ?? "background";

  // --- skip 1: a sheets sync run is already in progress ---
  // ONE SHARED LIVENESS BOUND (2026-10-23, forensics §2): the store already
  // nulls rows past TICK_WATCHDOG_CAP_MS (30 min), but this guard re-checks
  // with the SAME parse (parseSyncStartedMs — the store's, not a bare
  // Date.parse that misreads the Postgres text form) and the SAME bound, so
  // it passes only when the run is genuinely past the bound. The scheduler's
  // reaper closes such a row within one reaper cadence for good.
  const running = await store.getRunningSyncRun("google_sheets");
  if (running) {
    const startedMs = parseSyncStartedMs(running.started_at);
    const stale = !Number.isFinite(startedMs) || now().getTime() - startedMs > TICK_WATCHDOG_CAP_MS;
    if (!stale) return { outcome: "skipped", reason: "sync-in-progress" };
  }

  // --- adapter: LIVE only, resolved fresh each tick from the secret + settings ---
  const adapter = "adapter" in (options ?? {})
    ? options?.adapter ?? null
    : createSheetsAdapter((await store.getSettings()).sheets);
  if (!adapter) return { outcome: "skipped", reason: "no-credentials" };

  // --- skip 3: throttle background triggers via the connection row ---
  if (trigger === "background") {
    const prev = (await store.getConnections()).find((c) => c.provider === "google_sheets");
    const last = prev?.last_sync_at ? Date.parse(prev.last_sync_at) : NaN;
    if (Number.isFinite(last) && now().getTime() - last < SHEETS_MIN_INTERVAL_MS) {
      return { outcome: "skipped", reason: "recent-sync" };
    }
  }

  const runId = await store.insertSyncRun("google_sheets");
  try {
    const res = await runSheetsSync(store, await store.getSettings(), adapter, { nowIso: now().toISOString() });
    await store.finishSyncRun(runId, res.error ? "error" : "success", res.count, res.error ?? null);
    if (res.error) return { outcome: "error", leads: res.count, error: res.error };
    return { outcome: "synced", leads: res.count };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishSyncRun(runId, "error", 0, msg);
    return { outcome: "error", error: msg };
  }
}
