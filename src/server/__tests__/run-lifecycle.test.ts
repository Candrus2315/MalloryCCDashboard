/**
 * RESTART GAP CLOSER (2026-11-04 incident) — sync/run-lifecycle.ts.
 *
 * The owner-visible incident: every server-side ship restarts the serve and
 * kills the process mid-HighLevel-pass; its sync_runs row stayed 'running'
 * with no closer, and the sync-in-progress guard then skipped EVERY scheduler
 * tick until the independent reaper's 30-min window caught the row — three
 * ~30-min dead zones in one afternoon (rows 18:56:19, 19:25:33 and one
 * earlier; the freshness watchdog force-recovered at 20:03–20:06 UTC).
 *
 * Contract pinned here:
 *   - the tracking patch records every sync-run id the process opens and
 *     releases it on ANY finish (applied, rejected, reaper-closed);
 *   - the simulated SIGTERM/SIGINT handler closes exactly those rows as
 *     status='interrupted' (new status — distinguishable from an API-failure
 *     'error' and from the reaper's stale 'error'), then exits(0); a run that
 *     already finished 'success' or was reaped 'error' is NEVER clobbered
 *     (honest-finish guard); the whole pass is hard-capped so a dying DB can
 *     never hang shutdown; a SECOND signal force-exits immediately;
 *   - beforeExit is a best-effort natural-exit closer that never calls exit;
 *   - bootReapStaleSyncRuns (scheduler.ts) force-reaps 'running' rows older
 *     than the SAME window the independent reaper uses, before the first tick
 *     — a hard kill (SIGKILL/OOM) costs at most one reaper window;
 *   - getStore() tracking-patches both the Postgres store and the in-memory
 *     fallback (the memory→postgres probe swap can never silently lose
 *     tracking).
 *
 * MemoryStore-first throughout; the freshness watchdog's recovery path is
 * untouched by this work (no regression surface — it reads success rows only).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { reapStaleSyncRuns, STALE_RUN_REAP_MINUTES, bootReapStaleSyncRuns } from "../sync/scheduler";
import {
  INTERRUPTED_SYNC_RUN_STATUS,
  clearTrackedOpenSyncRuns,
  closeOpenSyncRuns,
  installSyncRunTracking,
  installShutdownSyncRunCloser,
  isSyncRunTrackingInstalled,
  openSyncRunIds,
  type ShutdownSyncRunCloser,
  type ShutdownSyncRunCloserOptions,
} from "../sync/run-lifecycle";
import { __resetStoreProbeStateForTests, getStore } from "../store";
import type { SyncRunRow } from "../store/types";

/** Backdoor into MemoryStore's private syncRuns — backdating started_at. */
const syncRunsOf = (store: MemoryStore): SyncRunRow[] =>
  (store as unknown as { syncRuns: SyncRunRow[] }).syncRuns;

/** Harness: install the closer with every process side-effect captured. */
function harness(store: Store | undefined, extra?: Partial<ShutdownSyncRunCloserOptions>): {
  closer: ShutdownSyncRunCloser;
  exits: number[];
  logs: string[];
  signals: string[];
} {
  const exits: number[] = [];
  const logs: string[] = [];
  const signals: string[] = [];
  const closer = installShutdownSyncRunCloser({
    ...(store ? { store } : {}),
    registerSignal: (signal) => { signals.push(signal); },
    registerBeforeExit: (handler) => { void handler; }, // captured via the returned seam instead
    exit: (code) => { exits.push(code); },
    log: (msg) => { logs.push(msg); },
    ...extra,
  });
  return { closer, exits, logs, signals };
}

describe("run registry + store tracking patch", () => {
  test("insertSyncRun tracks the id; finishSyncRun releases it; the row itself is untouched", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    expect(isSyncRunTrackingInstalled(store)).toBe(true);

    const id = await store.insertSyncRun("highlevel");
    expect(openSyncRunIds()).toEqual([id]);
    expect((await store.finishSyncRun(id, "success", 7, null))).toBe(true);
    expect(openSyncRunIds()).toEqual([]);
    const row = (await store.getSyncRuns(10)).find((r) => r.id === id)!;
    expect(row.status).toBe("success"); // the patch must not alter row behavior
    expect(row.records_upserted).toBe(7);
  });

  test("a finish REJECTED by the honest-finish guard also releases (reaper closed the row)", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    const id = await store.insertSyncRun("highlevel");
    await store.finishSyncRun(id, "error", 0, "stale: reaped by the independent reaper"); // not this process's finish
    expect(openSyncRunIds()).toEqual([]);
  });

  test("double install is a no-op (no stacked wrapping)", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    const patchedInsert = store.insertSyncRun;
    installSyncRunTracking(store);
    expect(store.insertSyncRun).toBe(patchedInsert);
    expect(isSyncRunTrackingInstalled(store)).toBe(true);
  });
});

describe("shutdown run-closer (simulated SIGTERM/SIGINT)", () => {
  test("closes the in-flight row as 'interrupted' (audited, distinguishable) then exits 0", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    const id = await store.insertSyncRun("highlevel");

    const { closer, exits, logs, signals } = harness(store, { registerBeforeExit: null });
    expect(signals).toEqual(["SIGTERM", "SIGINT"]); // both installed on the process

    const closed = await closer.handleSignal("SIGTERM");
    expect(closed).toBe(1);
    const row = (await store.getSyncRuns(10)).find((r) => r.id === id)!;
    expect(row.status).toBe(INTERRUPTED_SYNC_RUN_STATUS);
    expect(row.status).not.toBe("error"); // distinguishable from a real API failure
    expect(row.error).toContain("interrupted");
    expect(row.error).toContain("SIGTERM");
    expect(row.error).toContain("shutdown run-closer");
    expect(row.finished_at).not.toBeNull();
    expect(row.records_upserted).toBe(0);
    expect(openSyncRunIds()).toEqual([]);
    expect(exits).toEqual([0]); // graceful exit AFTER the close
    expect(logs.some((l) => l.includes("closed 1 in-flight sync run(s)"))).toBe(true);
  });

  test("a run that finished NORMALLY ('success') is untouched by the shutdown close", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    const id = await store.insertSyncRun("google_sheets");
    await store.finishSyncRun(id, "success", 42, null);

    const { closer, exits } = harness(store, { registerBeforeExit: null });
    expect(await closer.handleSignal("SIGTERM")).toBe(0);
    const row = (await store.getSyncRuns(10)).find((r) => r.id === id)!;
    expect(row.status).toBe("success");
    expect(row.records_upserted).toBe(42);
    expect(exits).toEqual([0]); // shutdown still proceeds
  });

  test("an already-reaped row ('error' by the reaper) is never clobbered", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    const id = await store.insertSyncRun("highlevel");
    await store.finishSyncRun(id, "error", 0, "stale: this highlevel run exceeded 12 minutes");

    const { closer } = harness(store, { registerBeforeExit: null });
    expect(await closer.handleSignal("SIGTERM")).toBe(0);
    const row = (await store.getSyncRuns(10)).find((r) => r.id === id)!;
    expect(row.status).toBe("error");
    expect(row.error).toContain("stale:"); // the reaper's record stands
    expect(row.error).not.toContain("interrupted");
  });

  test("process-scoped: rows this process never tracked are NOT closed", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore(); // deliberately NOT tracking-patched
    const id = await store.insertSyncRun("highlevel"); // e.g. opened before the patch, or by a script

    const { closer } = harness(store, { registerBeforeExit: null });
    expect(await closer.handleSignal("SIGTERM")).toBe(0);
    expect((await store.getSyncRuns(10)).find((r) => r.id === id)!.status).toBe("running");
  });

  test("a SECOND signal force-exits immediately instead of waiting out the cap", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    await store.insertSyncRun("highlevel");
    const hanging = store as MemoryStore;
    hanging.finishSyncRun = () => new Promise<boolean>(() => {}); // DB hangs mid-close

    const { closer, exits, logs } = harness(store, { registerBeforeExit: null, capMs: 250 });
    const first = closer.handleSignal("SIGTERM"); // in flight, parked on the hung DB
    await new Promise((r) => setTimeout(r, 20));
    const second = await closer.handleSignal("SIGINT"); // must NOT wait for the cap
    expect(second).toBe(-1);
    expect(exits).toEqual([0]); // force exit already fired
    expect(logs.some((l) => l.includes("force exit"))).toBe(true);
    await first; // the bounded path resolves later (cap) and exits again
    expect(exits.length).toBe(2);
  });

  test("the whole pass is capped: a dying DB can never hang shutdown", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    await store.insertSyncRun("highlevel");
    store.finishSyncRun = () => new Promise<boolean>(() => {});

    const t0 = Date.now();
    const { closer, exits, logs } = harness(store, { registerBeforeExit: null, capMs: 60 });
    expect(await closer.handleSignal("SIGTERM")).toBe(-2);
    expect(Date.now() - t0).toBeLessThan(2_000); // bounded, not 3s-default, not forever
    expect(exits).toEqual([0]);
    expect(logs.some((l) => l.includes("cap"))).toBe(true);
  });

  test("beforeExit closes rows best-effort and NEVER calls exit; no loop after the signal path owns the close", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    const id = await store.insertSyncRun("highlevel");

    const { closer, exits } = harness(store, { signals: [] }); // no signal handlers — natural exit only
    expect(await closer.handleBeforeExit()).toBe(1);
    expect((await store.getSyncRuns(10)).find((r) => r.id === id)!.status).toBe(INTERRUPTED_SYNC_RUN_STATUS);
    expect(exits).toEqual([]); // never exits from beforeExit

    await closer.handleBeforeExit(); // second natural-exit pass: already owned → no-op
    expect(exits).toEqual([]);
  });

  test("after the signal path owns the close, a beforeExit hook no-ops", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    await store.insertSyncRun("highlevel");

    const { closer } = harness(store, { registerBeforeExit: null, capMs: 50 });
    const closing = closer.handleSignal("SIGTERM");
    await new Promise((r) => setTimeout(r, 10));
    expect(await closer.handleBeforeExit()).toBe(-1);
    await closing;
  });
});

describe("closeOpenSyncRuns (direct seam)", () => {
  test("closes exactly the given ids and releases them; idempotent on a second pass", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    installSyncRunTracking(store);
    const id = await store.insertSyncRun("attribution");
    expect(await closeOpenSyncRuns(store, { reason: "SIGINT" })).toBe(1);
    expect(await closeOpenSyncRuns(store)).toBe(0); // nothing left to close
    expect((await store.getSyncRuns(10)).find((r) => r.id === id)!.status).toBe(INTERRUPTED_SYNC_RUN_STATUS);
  });
});

describe("boot reap — bootReapStaleSyncRuns (same criteria as the independent reaper)", () => {
  test("closes stale 'running' rows before the first tick; fresh/'interrupted'/'success' rows untouched", async () => {
    clearTrackedOpenSyncRuns();
    const store = new MemoryStore();
    const staleId = await store.insertSyncRun("highlevel");
    syncRunsOf(store).find((r) => r.id === staleId)!.started_at = new Date(
      Date.now() - (STALE_RUN_REAP_MINUTES + 5) * 60_000,
    ).toISOString();
    const freshId = await store.insertSyncRun("highlevel"); // a LIVE run — must survive
    const interruptedId = await store.insertSyncRun("google_sheets");
    await store.finishSyncRun(interruptedId, INTERRUPTED_SYNC_RUN_STATUS, 0, "interrupted: ...");
    const successId = await store.insertSyncRun("acuity");
    await store.finishSyncRun(successId, "success", 3, null);

    const logs: string[] = [];
    expect(await bootReapStaleSyncRuns({ store, log: (m) => logs.push(m) })).toBe(1);

    const runs = await store.getSyncRuns(10);
    expect(runs.find((r) => r.id === staleId)!.status).toBe("error");
    expect(runs.find((r) => r.id === staleId)!.error).toContain("stale-run reaper"); // the reaper's own message
    expect(runs.find((r) => r.id === freshId)!.status).toBe("running");
    expect(runs.find((r) => r.id === interruptedId)!.status).toBe(INTERRUPTED_SYNC_RUN_STATUS);
    expect(runs.find((r) => r.id === successId)!.status).toBe("success");
    expect(logs.some((l) => l.includes("boot reap"))).toBe(true);
  });

  test("PARITY with the independent reaper: identical verdicts on identical stores", async () => {
    const mkStore = async (): Promise<{ store: MemoryStore; stale: string; fresh: string }> => {
      const store = new MemoryStore();
      const stale = await store.insertSyncRun("retention-cancellations");
      syncRunsOf(store).find((r) => r.id === stale)!.started_at = new Date(
        Date.now() - (STALE_RUN_REAP_MINUTES + 1) * 60_000,
      ).toISOString();
      const fresh = await store.insertSyncRun("retention-cancellations");
      return { store, stale, fresh };
    };
    const a = await mkStore();
    const b = await mkStore();
    expect(await reapStaleSyncRuns(a.store)).toBe(1);
    expect(await bootReapStaleSyncRuns({ store: b.store, log: () => {} })).toBe(1);
    const ra = await a.store.getSyncRuns(10);
    const rb = await b.store.getSyncRuns(10);
    expect(ra.find((r) => r.id === a.stale)!.status).toBe(rb.find((r) => r.id === b.stale)!.status);
    expect(ra.find((r) => r.id === a.fresh)!.status).toBe("running");
    expect(rb.find((r) => r.id === b.fresh)!.status).toBe("running");
  });

  test("a failing store never blocks boot (best-effort, resolves 0)", async () => {
    const store = new MemoryStore();
    (store as unknown as { getRunningSyncRuns: () => Promise<never> }).getRunningSyncRuns = () =>
      Promise.reject(new Error("db unavailable at boot"));
    const logs: string[] = [];
    expect(await bootReapStaleSyncRuns({ store, log: (m) => logs.push(m) })).toBe(0);
    expect(logs.some((l) => l.includes("boot reap skipped"))).toBe(true);
  });
});

describe("getStore wiring — the tracking patch lives INSIDE getStore", () => {
  test("the in-memory fallback store is tracking-patched (the probe swap can never lose tracking)", async () => {
    clearTrackedOpenSyncRuns();
    // getSecret matches ANY case variant of the key — save/restore all of them.
    const saved = Object.entries(process.env).filter(([k]) => k.toUpperCase() === "DATABASE_URL");
    for (const [k] of saved) delete process.env[k];
    try {
      __resetStoreProbeStateForTests();
      const store = await getStore();
      expect(store.mode).toBe("memory"); // no DATABASE_URL → honest memory fallback
      expect(isSyncRunTrackingInstalled(store)).toBe(true);
      const id = await store.insertSyncRun("highlevel");
      expect(openSyncRunIds()).toContain(id);
      await store.finishSyncRun(id, "success", 0, null);
      expect(openSyncRunIds()).not.toContain(id);
    } finally {
      for (const [k, v] of saved) process.env[k] = v;
      __resetStoreProbeStateForTests();
      clearTrackedOpenSyncRuns();
    }
  });
});
