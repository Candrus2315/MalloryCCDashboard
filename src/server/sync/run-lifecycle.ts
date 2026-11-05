/**
 * SYNC RUN LIFECYCLE — the restart gap closer (2026-11-04 incident).
 *
 * THE GAP: the serve process is killed mid-HighLevel-pass on every server-side
 * ship (publish restarts). Its sync_runs row stayed 'running' with no closer,
 * and the sync-in-progress guard then skipped EVERY scheduler tick until the
 * row aged past STALE_RUN_REAP_MINUTES (30 min) and the independent reaper
 * closed it — three ~30-min dead zones in one afternoon (rows 18:56:19,
 * 19:25:33 and one earlier, all eventually reaped 'error'). The reaper works;
 * the gap was the SHUTDOWN path (nobody closes the dying process's rows) and
 * the BOOT path (nothing reaps leftover rows before the first tick).
 *
 * This module owns the SHUTDOWN half + the per-process run registry:
 *   - a registry of sync-run ids THIS process opened (installed as an
 *     idempotent patch on the store singleton inside getStore(), so every
 *     writer — scheduler ticks, manual SYNC NOW, backfills — is tracked),
 *   - SIGTERM/SIGINT (and beforeExit, where Bun supports it) handlers that
 *     close those rows as status='interrupted' (a NEW status: distinguishable
 *     from a real API failure 'error' and from the reaper's stale 'error',
 *     auditable in the Sync Center), then exit — hard-capped at
 *     SHUTDOWN_CLOSER_CAP_MS so a dying DB can never hang shutdown,
 *   - idempotent everywhere: a second signal force-exits immediately, a run
 *     already finished/reaped is never clobbered (finishSyncRun's honest-finish
 *     guard does the transition only while the row is still 'running').
 *
 * The BOOT half (force-reap stale rows before the first tick, same criteria as
 * the reaper) lives in scheduler.ts next to the reaper it reuses:
 * bootReapStaleSyncRuns. Together: a graceful restart leaves NO orphan rows at
 * all; even a hard kill (SIGKILL/OOM) costs at most one reaper window — the
 * pre-2026-11-04 behavior of a full 30-min tick dead zone per restart is gone.
 */
import type { Store } from "../store/types";
import { withSyncWriteRetry } from "../store/sync-write-retry";

/** New terminal status: the process was shut down (SIGTERM/SIGINT) mid-run. */
export const INTERRUPTED_SYNC_RUN_STATUS = "interrupted";

/** The error text stamped on an interrupted row (audited in the Sync Center). */
export function interruptedSyncRunError(reason: string): string {
  return `interrupted: the server process was shut down (${reason}) while this run was in flight — closed by the shutdown run-closer so the next boot starts clean; the next tick retries`;
}

// ---------------------------------------------------------------------------
// Per-process open-run registry
// ---------------------------------------------------------------------------

/**
 * Sync-run ids this process inserted that are not (yet) known to have
 * finished. Bounded: released on every finish (any status, including the
 * reaper closing a zombie via the same patched finishSyncRun).
 *
 * Lives on globalThis (same pattern as the pg-store registry in
 * store/index.ts) so EVERY module graph in the process shares ONE registry:
 * the serve entry (src graph) runs the shutdown closer, but the BUILT SSR
 * bundle (dist/server/server.js — its own bundled copy of these modules)
 * opens manual-SYNC-NOW rows through its own store instance; those ids must
 * be closable by the src graph's closer at SIGTERM. Unique run ids make the
 * set safe to share; a vite-HMR module re-execution also can no longer
 * orphan the registry.
 */
const REGISTRY_KEY = "__malloryOpenSyncRunIds";
function openRunIdRegistry(): Set<string> {
  const g = globalThis as unknown as Record<string, Set<string> | undefined>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Set();
  return g[REGISTRY_KEY];
}

export function trackOpenSyncRun(id: string): void {
  openRunIdRegistry().add(id);
}

export function releaseOpenSyncRun(id: string): void {
  openRunIdRegistry().delete(id);
}

/** Snapshot of the ids possibly still in flight (the closer works on this). */
export function openSyncRunIds(): string[] {
  return [...openRunIdRegistry()];
}

/** Test hook: reset the process-global registry between tests. */
export function clearTrackedOpenSyncRuns(): void {
  openRunIdRegistry().clear();
}

// ---------------------------------------------------------------------------
// Store patch — tracking at the one choke point every writer shares
// ---------------------------------------------------------------------------

const TRACKING_BRAND = Symbol("mallory.syncRunTrackingInstalled");

/** True when the store already carries the tracking patch (test aid). */
export function isSyncRunTrackingInstalled(store: Store): boolean {
  return (store as unknown as Record<symbol, unknown>)[TRACKING_BRAND] === true;
}

/**
 * Patch a store instance so insertSyncRun tracks the returned id and
 * finishSyncRun releases it. Installed on EVERY store getStore() resolves
 * (both the Postgres and the in-memory fallback) — a process-global brand
 * makes re-installation a no-op, so the memory→postgres probe swap (and any
 * number of getStore callers) can never double-wrap.
 *
 * Instance-level patch, NOT a wrapper object: identity, prototype and
 * instanceof stay untouched, and outer wrappers (withSyncWriteRetry binds to
 * the target at call time) pick the patched methods up transparently.
 */
export function installSyncRunTracking(store: Store): void {
  const branded = store as unknown as Record<symbol, unknown>;
  if (branded[TRACKING_BRAND] === true) return;
  branded[TRACKING_BRAND] = true;
  const originalInsert = store.insertSyncRun.bind(store);
  const originalFinish = store.finishSyncRun.bind(store);
  store.insertSyncRun = async (provider: string): Promise<string> => {
    const id = await originalInsert(provider);
    trackOpenSyncRun(id);
    return id;
  };
  store.finishSyncRun = async (
    id: string,
    status: string,
    recordsUpserted: number,
    error: string | null,
  ): Promise<boolean> => {
    const applied = await originalFinish(id, status, recordsUpserted, error);
    // Release in BOTH cases: applied → terminal; rejected → the row was
    // already finished or reaped by someone — either way it is not in flight.
    releaseOpenSyncRun(id);
    return applied;
  };
}

// ---------------------------------------------------------------------------
// The closer
// ---------------------------------------------------------------------------

export interface CloseOpenSyncRunsOptions {
  /** Why the process is closing (signal name / "beforeExit") — stamped into the row's error. */
  reason?: string;
  /** Close only these ids (default: every id this process still tracks). */
  ids?: string[];
  now?: () => Date;
  log?: (msg: string) => void;
}

/**
 * Close every still-open sync run this process tracked as 'interrupted'.
 * finishSyncRun's honest-finish guard makes this safe against every race:
 * a run that already finished 'success' or was reaped 'error' keeps its
 * record (the closer's finish is rejected, not clobbered). Returns the number
 * of rows actually transitioned. Writes go through withSyncWriteRetry like
 * every other sync-layer finish (bounded retries; the caller's overall
 * shutdown cap still bounds the whole pass).
 */
export async function closeOpenSyncRuns(store: Store, opts?: CloseOpenSyncRunsOptions): Promise<number> {
  const ids = opts?.ids ?? openSyncRunIds();
  const error = interruptedSyncRunError(opts?.reason ?? "shutdown");
  const retrying = withSyncWriteRetry(store);
  let closed = 0;
  for (const id of ids) {
    let applied = false;
    try {
      applied = await retrying.finishSyncRun(id, INTERRUPTED_SYNC_RUN_STATUS, 0, error);
    } catch {
      applied = false; // DB unreachable mid-shutdown — leave the id to the reaper
    }
    releaseOpenSyncRun(id);
    if (applied) closed++;
  }
  if (opts?.log) {
    const skipped = ids.length - closed;
    opts.log(`[shutdown] run-closer: closed ${String(closed)} in-flight sync run(s) as '${INTERRUPTED_SYNC_RUN_STATUS}'${skipped > 0 ? ` (${String(skipped)} already finished/reaped — left untouched)` : ""}`);
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Signal installation
// ---------------------------------------------------------------------------

/** The whole graceful closer (store resolution + all row closes) may take at most this long. */
export const SHUTDOWN_CLOSER_CAP_MS = 3_000;

export interface ShutdownSyncRunCloserOptions {
  /** Pre-resolved store (tests). Takes precedence over getStoreImpl. */
  store?: Store;
  /** Lazy store resolution (serve passes () => getStore() — the freshest instance). */
  getStoreImpl?: () => Store | Promise<Store>;
  /** Signals to listen on (default: SIGTERM + SIGINT). */
  signals?: string[];
  /** Test seam — where signal handlers register. Default: process.on. */
  registerSignal?: (signal: string, handler: (signal: string) => void) => void;
  /**
   * Test seam — where the beforeExit hook registers; pass null to disable
   * (default: process.on("beforeExit"), a best-effort last-resort closer for
   * natural exits; the serve's long-lived timers mean it effectively never
   * fires there, but a script or a drained loop benefits).
   */
  registerBeforeExit?: ((handler: () => void) => void) | null;
  /** Test seam — default process.exit. */
  exit?: (code: number) => void;
  /** Whole-handler deadline in ms (default SHUTDOWN_CLOSER_CAP_MS). */
  capMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
  /**
   * PORTABILITY (2026-11-05): give the single-scheduler lease back before
   * exit (SIGTERM/SIGINT/beforeExit) so a standby instance picks up the tick
   * duty within one interval instead of waiting for our session to die.
   * serve.ts wires `() => schedulerLease()?.release()`. Best-effort: a failure
   * never blocks shutdown (the session-level advisory lock dies with the
   * process anyway).
   */
  releaseLease?: () => Promise<void>;
  /**
   * PORTABILITY (2026-11-05): close DB pools before exit so a graceful
   * shutdown leaves zero open connections (a SIGKILL/OOM never gets this
   * far — that is what the boot reap is for). serve.ts wires the
   * store registry closer. Best-effort, inside the same shutdown cap.
   */
  closeStores?: () => Promise<void>;
}

export interface ShutdownSyncRunCloser {
  /** The SIGTERM/SIGINT handler (returned for tests; also registered for real). */
  handleSignal: (signal: string) => Promise<number>;
  /** The beforeExit hook (returned for tests; also registered when enabled). */
  handleBeforeExit: () => Promise<number>;
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * PORTABILITY teardown: release the scheduler lease, then close the DB pools —
 * every step best-effort (a dying DB can never hang shutdown; the hard cap in
 * handleSignal bounds the whole pass regardless).
 */
async function shutdownTeardown(opts: ShutdownSyncRunCloserOptions | undefined, log: (msg: string) => void): Promise<void> {
  if (opts?.releaseLease) {
    try {
      await opts.releaseLease();
    } catch (e) {
      log(`[shutdown] lease release skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (opts?.closeStores) {
    try {
      await opts.closeStores();
    } catch (e) {
      log(`[shutdown] pool close skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Install the shutdown run-closer on this process: SIGTERM/SIGINT close this
 * process's in-flight sync runs as 'interrupted' then exit — the whole pass
 * hard-capped at capMs (a dying DB can never hang shutdown), a SECOND signal
 * force-exits immediately (the graceful path is already running or wedged),
 * and beforeExit is a best-effort natural-exit last resort that never calls
 * exit itself. Idempotent per process: once a close pass has begun, later
 * signals/beforeExit fire the force path (or no-op) instead of double-closing.
 */
export function installShutdownSyncRunCloser(opts?: ShutdownSyncRunCloserOptions): ShutdownSyncRunCloser {
  const exitFn = opts?.exit ?? ((code: number) => process.exit(code));
  const log = opts?.log ?? ((msg: string) => console.log(msg));
  const registerSignal = opts?.registerSignal ?? ((signal: string, handler: (signal: string) => void) => { process.on(signal as NodeJS.Signals, handler); });
  const registerBeforeExit = opts?.registerBeforeExit === undefined
    ? ((handler: () => void) => { process.on("beforeExit", handler); })
    : opts.registerBeforeExit;
  const capMs = opts?.capMs ?? SHUTDOWN_CLOSER_CAP_MS;
  const nowFn = opts?.now ?? (() => Date.now());
  const signals = opts?.signals ?? ["SIGTERM", "SIGINT"];

  const resolveStore = async (): Promise<Store | null> => {
    if (opts?.store) return opts.store;
    if (opts?.getStoreImpl) return await opts.getStoreImpl();
    return null;
  };

  let closing = false;

  const handleSignal = (signal: string): Promise<number> => {
    if (closing) {
      log(`[shutdown] ${signal} received again — force exit (the graceful run-closer is already running)`);
      exitFn(0);
      return Promise.resolve(-1);
    }
    closing = true;
    const deadline = nowFn() + capMs;
    const work = (async (): Promise<number> => {
      const store = await resolveStore();
      let closed = 0;
      if (store) closed = await closeOpenSyncRuns(store, { reason: signal, log });
      await shutdownTeardown(opts, log);
      return closed;
    })();
    // ONE deadline over the whole pass (store resolution + every close): the
    // race resolves with whichever lands first; the work continues detached
    // but the process exits at the cap no matter what.
    return Promise.race([
      work.catch((e: unknown) => {
        log(`[shutdown] run-closer failed: ${e instanceof Error ? e.message : String(e)} (the next boot's reap and the independent reaper cover the rows)`);
        return 0;
      }),
      sleepMs(Math.max(0, deadline - nowFn())).then(() => -2),
    ]).then((closed) => {
      if (closed === -2) log(`[shutdown] run-closer exceeded its ${String(capMs)}ms cap — force exit (any row still open is reaped at boot or by the independent reaper)`);
      exitFn(0);
      return closed;
    });
  };

  const handleBeforeExit = async (): Promise<number> => {
    if (closing) return -1; // a signal path already owns the close (never loop)
    closing = true;
    try {
      const store = await resolveStore();
      let closed = 0;
      if (store) closed = await closeOpenSyncRuns(store, { reason: "beforeExit", log });
      await shutdownTeardown(opts, log);
      return closed;
    } catch {
      return 0; // best-effort — the process is exiting either way
    }
    // Deliberately NO exit call: beforeExit means the loop drained naturally.
  };

  for (const signal of signals) {
    registerSignal(signal, () => { void handleSignal(signal); });
  }
  if (registerBeforeExit) registerBeforeExit(() => { void handleBeforeExit(); });

  return { handleSignal, handleBeforeExit };
}
