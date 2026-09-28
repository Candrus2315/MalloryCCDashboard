/**
 * "Syncing…" header stuck — zombie graveyard regressions (2026-09-28).
 *
 * Two structural bugs, both verified live (a 37h HighLevel zombie plus 5+
 * attribution zombies 17–24h old kept the shell's freshness indicator on
 * "Syncing…" indefinitely):
 *
 *  1. reapStaleSyncRuns scanned getSyncRuns(200) — the 200 MOST RECENT runs.
 *     At the ~90s/sync cadence that window spans only a few hours, so stale
 *     "running" rows older than it were NEVER seen by the reaper.
 *  2. getRunningSyncRun had no recency bound — a "running" row of ANY age
 *     made getFreshnessData/refreshNow report running:true forever.
 *
 * Fix contract: the reaper scans by STATUS (getRunningSyncRuns — every
 * 'running' row of any age, same 15-min cutoff / reapable-provider set /
 * error note); getRunningSyncRun only trusts rows started within
 * STALE_RUN_REAP_MINUTES (unparsable started_at = stale, never a crash).
 * getFreshnessData/refreshNow consume getRunningSyncRun unchanged — their
 * FreshnessData shape is untouched; the header fix flows through the store.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { reapStaleSyncRuns, STALE_RUN_REAP_MINUTES } from "../sync/scheduler";
import { parseSyncStartedMs, type SyncRunRow } from "../store/types";

/** Backdoor into MemoryStore's private syncRuns — the only way to backdate a row's started_at. */
const syncRunsOf = (store: MemoryStore): SyncRunRow[] =>
  (store as unknown as { syncRuns: SyncRunRow[] }).syncRuns;

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

/** Postgres text form of a timestamp N minutes ago: "YYYY-MM-DD HH:MM:SS.ffffff+00" (space separator, microseconds). */
const pgTimestampAgo = (minutes: number): string => {
  const iso = new Date(Date.now() - minutes * 60_000).toISOString(); // 2026-09-28T12:34:56.789Z
  const [date, rest] = iso.split("T");
  const [hms, ms] = rest.replace("Z", "").split(".");
  return `${date} ${hms}.${ms}000+00`;
};

describe("stale-run reaper scans by status, not recency window", () => {
  test("a zombie BELOW the recent-200 window is reaped; a fresh row at the same depth survives", async () => {
    const store = new MemoryStore();
    const zombieId = await store.insertSyncRun("highlevel");
    // The zombie started 20 real minutes ago (the live incident: 37 HOURS).
    syncRunsOf(store).find((r) => r.id === zombieId)!.started_at = new Date(
      Date.now() - (STALE_RUN_REAP_MINUTES + 5) * 60_000,
    ).toISOString();
    const freshId = await store.insertSyncRun("google_sheets"); // fresh, SAME burial depth
    // Bury both under >200 finished runs — everything getSyncRuns(200) could
    // see (the OLD reaper's only view) is these finished rows.
    for (let i = 0; i < 205; i++) {
      await store.finishSyncRun(await store.insertSyncRun("highlevel"), "success", 1, null);
    }
    // Proof the burial is real: neither running row is inside the old window.
    const recent200 = await store.getSyncRuns(200);
    expect(recent200.some((r) => r.id === zombieId || r.id === freshId)).toBe(false);

    // Real clock — the zombie's age alone makes it stale.
    expect(await reapStaleSyncRuns(store)).toBe(1); // OLD code: 0 — zombie invisible forever

    const runs = await store.getSyncRuns(300);
    const zombie = runs.find((r) => r.id === zombieId)!;
    expect(zombie.status).toBe("error");
    expect(zombie.error).toContain("stale");
    expect(zombie.error).toContain("stale-run reaper");
    // The fresh row at the same depth is NOT touched.
    expect(runs.find((r) => r.id === freshId)!.status).toBe("running");
  });

  test("cutoff, reapable-provider set and non-reapable providers unchanged", async () => {
    const store = new MemoryStore();
    const withinCutoff = () => minutesFromNow(STALE_RUN_REAP_MINUTES - 1);
    const zombieId = await store.insertSyncRun("highlevel");
    const backfillId = await store.insertSyncRun("resumable-backfill"); // legitimately long — not reapable
    expect(await reapStaleSyncRuns(store, withinCutoff)).toBe(0); // 15-min cutoff still honored
    expect(await reapStaleSyncRuns(store)).toBe(0); // real clock: fresh rows are not zombies
    const runs = await store.getSyncRuns(10);
    expect(runs.find((r) => r.id === zombieId)!.status).toBe("running");
    expect(runs.find((r) => r.id === backfillId)!.status).toBe("running");
  });
});

describe("getRunningSyncRun freshness bound", () => {
  test("fresh running row is returned; a row older than the cutoff is NOT running", async () => {
    const store = new MemoryStore();
    const id = await store.insertSyncRun("highlevel");
    expect((await store.getRunningSyncRun("highlevel"))?.id).toBe(id);
    // Backdate beyond the reap window → the header must NOT report "Syncing…".
    syncRunsOf(store).find((r) => r.id === id)!.started_at = new Date(
      Date.now() - (STALE_RUN_REAP_MINUTES + 1) * 60_000,
    ).toISOString();
    expect(await store.getRunningSyncRun("highlevel")).toBeNull();
  });

  test("Postgres text timestamps parse (space + microseconds): fresh → row, stale → null", async () => {
    const store = new MemoryStore();
    const id = await store.insertSyncRun("highlevel");
    syncRunsOf(store).find((r) => r.id === id)!.started_at = pgTimestampAgo(2);
    expect((await store.getRunningSyncRun("highlevel"))?.id).toBe(id);
    syncRunsOf(store).find((r) => r.id === id)!.started_at = pgTimestampAgo(STALE_RUN_REAP_MINUTES + 1);
    expect(await store.getRunningSyncRun("highlevel")).toBeNull();
  });

  test("unparsable started_at is treated as stale — never a crash", async () => {
    const store = new MemoryStore();
    const id = await store.insertSyncRun("highlevel");
    syncRunsOf(store).find((r) => r.id === id)!.started_at = "not-a-timestamp";
    expect(await store.getRunningSyncRun("highlevel")).toBeNull();
  });

  test("parseSyncStartedMs: ISO + Postgres forms parse; garbage is NaN", () => {
    expect(Number.isFinite(parseSyncStartedMs(new Date().toISOString()))).toBe(true);
    expect(Number.isFinite(parseSyncStartedMs(pgTimestampAgo(1)))).toBe(true);
    expect(Number.isNaN(parseSyncStartedMs("not-a-timestamp"))).toBe(true);
  });
});
