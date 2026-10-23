/**
 * RUNNING-GUARD LIVENESS — the ONE shared bound (2026-10-23, forensics
 * scratch/reliability-forensics.md §2 "RUNNING-GUARD >15-MIN HOLE").
 *
 * Until this fix there were THREE independent 15-minute liveness bounds (the
 * store guard in pg/memory getRunningSyncRun, a sheets-tick duplicate
 * SHEETS_STALE_RUNNING_MS, and the reaper's STALE_RUN_REAP_MINUTES). Field
 * evidence killed all three: a legitimate google_sheets run finished SUCCESS
 * at 17m28s (full REPLACE of 3,870 rows — scratch/fairyland-run17-out.txt)
 * and two real overlaps were captured (run B started 83s BEFORE run A
 * finished). Any 15-min bound misclassifies live runs as dead: the store
 * nulls them, the tick guards then pass, and a SECOND run starts while the
 * first is still alive.
 *
 * The fix: ONE shared liveness bound = TICK_WATCHDOG_CAP_MS (30 min — the
 * tick ceiling itself, canonical in store/types.ts; STALE_RUN_REAP_MINUTES is
 * now derived from it and the sheets-tick guard re-checks against it
 * directly). Pinned here:
 *
 *  ① a 17.5-min sheets run that FINISHES SUCCESS is never reaped mid-flight
 *    and never admits a second run (the field evidence, pinned);
 *  ② a genuinely hung row IS reaped within reaper cadence of the new bound —
 *    and NEVER before it (fake-advancing clock + injectable sleep/interval,
 *    the runStaleRunReaperLoop test hooks);
 *  ③ two runs never overlap for the same provider: while a run is live the
 *    tick skips (exactly one running row, no new row admitted); once the run
 *    is genuinely past the bound, the reaper closes it and the SAME tick
 *    starts exactly one new run.
 *
 * Deliberate contract changes vs the old pins (noted in the PR body):
 *  - sheets-auto-sync.test.ts: the ">15-min row proceeds" semantics → the
 *    shared 30-min bound; the ">15 minutes" error-text pin is now derived
 *    from STALE_RUN_REAP_MINUTES;
 *  - zombie-run-reaper.test.ts: the 15-min cutoff header → the shared bound;
 *  - freshness-watchdog.test.ts: the "recovered" fixture row moved from 30
 *    min old (now exactly AT the bound → still possibly-live) to 45 min old.
 *
 * All offline: MemoryStore + the syncRunsOf backdoor (house pattern, see
 * zombie-run-reaper.test.ts:26-28) — no live APIs, no real waiting.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  reapStaleSyncRuns,
  runStaleRunReaperLoop,
  schedulerTick,
  STALE_RUN_REAP_MINUTES,
  TICK_WATCHDOG_CAP_MS,
} from "../sync/scheduler";
import { sheetsTick } from "../sync/sheets-tick";
import type { GoogleSheetsAdapter } from "../sync/adapters";
import { getWorkDate } from "../date-logic";
import type { SyncRunRow } from "../store/types";

/** Backdoor into MemoryStore's private syncRuns — backdate started_at (house pattern). */
const syncRunsOf = (store: MemoryStore): SyncRunRow[] =>
  (store as unknown as { syncRuns: SyncRunRow[] }).syncRuns;

const backdate = (store: MemoryStore, id: string, msAgo: number) => {
  const row = syncRunsOf(store).find((r) => r.id === id)!;
  row.started_at = new Date(Date.now() - msAgo).toISOString();
  return row;
};

/** The FIELD EVIDENCE run length: scratch/fairyland-run17-out.txt run A — 17m28s SUCCESS. */
const LEGIT_SHEETS_RUN_MS = 17.5 * 60_000;

/** A live (non-demo) sheets stub returning one real-shaped row — syncs cleanly. */
const liveSheetsStub: GoogleSheetsAdapter = {
  provider: "google_sheets",
  isDemo: false,
  fetchLeads: async () => [
    {
      source_id: "SHEET#family#2026-09-27#0",
      leadType: "family",
      sourceDate: "2026-09-27",
      workDate: getWorkDate("2026-09-27"),
      name: null,
      phone: null,
      email: null,
      sheet: "family",
    },
  ],
};

const runningSheetsRows = (store: MemoryStore) =>
  syncRunsOf(store).filter((r) => r.provider === "google_sheets" && r.status === "running");

describe("ONE shared liveness bound (TICK_WATCHDOG_CAP_MS)", () => {
  test("the reaper window derives from the tick ceiling — one number to reason about", () => {
    expect(TICK_WATCHDOG_CAP_MS).toBe(30 * 60_000);
    expect(STALE_RUN_REAP_MINUTES).toBe(TICK_WATCHDOG_CAP_MS / 60_000);
    // past any legitimate run: the longest observed legit sheets run is 17m28s
    expect(LEGIT_SHEETS_RUN_MS).toBeLessThan(TICK_WATCHDOG_CAP_MS);
  });

  test("① a 17.5-min sheets run that FINISHES SUCCESS is never reaped mid-flight and never admits a second run", async () => {
    const store = new MemoryStore();
    const runId = await store.insertSyncRun("google_sheets");
    backdate(store, runId, LEGIT_SHEETS_RUN_MS); // mid-flight at 17.5 min

    // (a) the reaper leaves it alone — a 17.5-min-old run is LIVE, not a zombie
    expect(await reapStaleSyncRuns(store)).toBe(0);
    expect(syncRunsOf(store).find((r) => r.id === runId)!.status).toBe("running");

    // (b) the store guard still reports it — the header keeps "Syncing…"
    expect((await store.getRunningSyncRun("google_sheets"))?.id).toBe(runId);

    // (c) the sheets tick guard BLOCKS — no second run admitted while it lives
    const tick = await sheetsTick({ store, adapter: liveSheetsStub, trigger: "manual" });
    expect(tick).toEqual({ outcome: "skipped", reason: "sync-in-progress" });
    expect(runningSheetsRows(store)).toHaveLength(1);
    expect(syncRunsOf(store).filter((r) => r.provider === "google_sheets")).toHaveLength(1);

    // (d) the run then finishes SUCCESS (the field evidence: 17m28s, 3,870 rows)
    // — and it was never touched by any reaper pass on the way.
    await store.finishSyncRun(runId, "success", 3870, null);
    const finished = syncRunsOf(store).find((r) => r.id === runId)!;
    expect(finished.status).toBe("success");
    expect(finished.error).toBeNull();
    expect(finished.records_upserted).toBe(3870);
    expect(runningSheetsRows(store)).toHaveLength(0);
  });

  test("② a genuinely hung row IS reaped within reaper cadence of the new bound — never BEFORE it", async () => {
    const store = new MemoryStore();
    const hungId = await store.insertSyncRun("google_sheets");
    // 29 min old at loop start: NOT yet past the 30-min shared bound.
    backdate(store, hungId, 29 * 60_000);
    const freshId = await store.insertSyncRun("google_sheets"); // a genuinely live neighbor

    // Test-shrunk-timeout house pattern: the reaper loop's injectable
    // sleep/now/intervalMs hooks with a fake-advancing clock — every pass is
    // one reaper interval (STEP_MS) apart in test time.
    const STEP_MS = 60_000;
    let simulated = Date.now();
    const statusAtPassStart: string[] = [];
    const sleep = async (ms: number) => {
      simulated += ms;
      statusAtPassStart.push(syncRunsOf(store).find((r) => r.id === hungId)!.status);
    };

    await runStaleRunReaperLoop({
      store,
      sleep,
      now: () => new Date(simulated),
      rounds: 3,
      intervalMs: STEP_MS,
    });

    // Pass 1 (age exactly 30 min): AT the bound is still possibly-live → untouched.
    // Pass 2 (age 31 min): past the bound → reaped within one reaper cadence.
    // Pass 3: nothing left to do.
    expect(statusAtPassStart).toEqual(["running", "running", "error"]);
    const hung = syncRunsOf(store).find((r) => r.id === hungId)!;
    expect(hung.status).toBe("error");
    // The honest reaper message format stays; only the number is now the shared one.
    expect(hung.error).toContain("stale:");
    expect(hung.error).toContain(`exceeded ${STALE_RUN_REAP_MINUTES} minutes`);
    expect(hung.error).toContain("stale-run reaper");
    // The genuinely live neighbor is never touched by any pass.
    expect(syncRunsOf(store).find((r) => r.id === freshId)!.status).toBe("running");
  });

  test("③ two runs never overlap for the same provider: live → skip; past-bound zombie → reaped, exactly ONE new run", async () => {
    const store = new MemoryStore();
    // A live sheets run 17.5 min in (the field evidence shape).
    const liveId = await store.insertSyncRun("google_sheets");
    backdate(store, liveId, LEGIT_SHEETS_RUN_MS);

    // Full scheduler tick (reap FIRST, sheets FOURTH — see the intra-tick
    // ordering hazard note in scheduler.ts): the live run must survive the
    // reap pass, block the sheets guard, and NO new run may be admitted.
    const blocked = await schedulerTick({
      store,
      creds: null,
      liveAdapters: { sheets: liveSheetsStub },
      trigger: "background",
    });
    expect(blocked.reaped).toBe(0);
    expect(blocked.sheets?.outcome).toBe("skipped");
    expect(blocked.sheets?.reason).toBe("sync-in-progress");
    expect(runningSheetsRows(store)).toHaveLength(1);

    // The live run finishes SUCCESS — the provider is free again.
    await store.finishSyncRun(liveId, "success", 3870, null);

    // Now the failure mode the reaper exists for: a process killed mid-run
    // leaves its row behind — 31 min old, past the shared bound, a dead
    // process and not a live one.
    const zombieId = await store.insertSyncRun("google_sheets");
    backdate(store, zombieId, TICK_WATCHDOG_CAP_MS + 60_000);

    const recovered = await schedulerTick({
      store,
      creds: null,
      liveAdapters: { sheets: liveSheetsStub },
      trigger: "background",
    });
    expect(recovered.reaped).toBe(1); // the reaper closed the zombie BEFORE the guards
    const zombie = syncRunsOf(store).find((r) => r.id === zombieId)!;
    expect(zombie.status).toBe("error");
    // EXACTLY ONE new run was admitted, and it ran through to success.
    const sheetsRuns = syncRunsOf(store).filter((r) => r.provider === "google_sheets");
    expect(sheetsRuns).toHaveLength(3); // live + zombie + exactly one new
    expect(runningSheetsRows(store)).toHaveLength(0);
    expect(sheetsRuns.filter((r) => r.status === "success")).toHaveLength(2);
    expect(recovered.sheets?.outcome).toBe("synced");
  });
});
