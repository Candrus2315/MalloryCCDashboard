/**
 * HIGHLEVEL HANG-BOUNDS tests (2026-11-02 wedge — a HighLevel pass hung ~30
 * min and its 'running' sync_runs row deadlocked every background tick behind
 * the running guard, because the stale-run reaper only closes rows past
 * STALE_RUN_REAP_MINUTES = 30 min and nothing bounded the RUN as a whole).
 *
 * Mirror of acuity-run-budget.test.ts. MemoryStore-based, NO live API (every
 * fetch/sleep is injected; the hung fixture never settles). Pins:
 *  1. the PER-RUN WALL-CLOCK BUDGET — HIGHLEVEL_RUN_BUDGET_MS is 10 min and
 *     sits WELL under the 30-min reap window (the same invariant pin the
 *     Acuity test carries, so the relationship survives constant edits);
 *     a breach finishes the sync_runs row with the honest "run budget
 *     exceeded" error on BOTH entry paths (runProvider's highlevel section in
 *     run.ts + highlevelTick's incremental harvest) instead of parking
 *     `running` until the reaper; a healthy short pass never trips it;
 *  2. the REAP BEFORE THE RUNNING-GUARD — highlevelTick reaps stale 'running'
 *     rows BEFORE its sync-in-progress guard, so a stale row can never
 *     deadlock ticks between restarts (or behind a DIRECT highlevelTick call,
 *     e.g. the freshness watchdog's forced recovery, which bypasses
 *     schedulerTick's own reap pass); a LIVE (young) row is never touched and
 *     still skips the tick (overlap protection intact).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  HIGHLEVEL_RUN_BUDGET_MS,
  STALE_RUN_REAP_MINUTES,
  TICK_WATCHDOG_CAP_MS,
  type SyncRunRow,
} from "../store/types";
import {
  HighLevelRunBudgetExceededError,
  highlevelRunBudgetMs,
  raceHighLevelRunBudget,
} from "../sync/highlevel-run-budget";
import { highlevelTick } from "../sync/scheduler";
import { runDemoSync } from "../sync/run";
import type { LiveHighLevelAdapter, } from "../sync/highlevel-live";
import type { AcuityLiveAdapter } from "../sync/acuity-live";

const CREDENTIALS = { apiKey: "test-api-key", locationId: "loc_123" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOW = Date.now();
const secondsAgoIso = (s: number) => new Date(NOW - s * 1000).toISOString();
const hoursAgoMs = (h: number) => NOW - h * 3_600_000;

/** Minimal incremental fixture fetch (mirrors scheduler.test.ts shapes). */
function makeIncrementalFetch(opts: { seen?: string[]; hang?: boolean } = {}) {
  return async (url: string): Promise<Response> => {
    opts.seen?.push(String(url));
    if (opts.hang) return new Promise<Response>(() => {}); // the hung-pass shape
    const path = String(url).split("?")[0];
    if (path.endsWith("/users/")) return json({ users: [{ id: "usr_new", firstName: "Alex", lastName: "Morgan", email: "alex@mallory.test", deleted: false }] });
    if (path.endsWith("/conversations/search")) return json({ conversations: [{ id: "conv_new", lastMessageDate: NOW - 30_000, contactId: "cnt_new", lastMessageType: "TYPE_CALL" }] });
    if (path.includes("/conversations/conv_new/messages")) return json({ messages: { lastMessageId: null, nextPage: false, messages: [{ id: "call_new1", direction: "outbound", status: "completed", contactId: "cnt_new", userId: "usr_new", conversationId: "conv_new", dateAdded: secondsAgoIso(30), meta: { call: { duration: 240, status: "completed" } }, messageType: "TYPE_CALL" }] } });
    if (path.endsWith("/contacts/cnt_new")) return json({ contact: { id: "cnt_new", contactName: "Emma Carter", phone: "+19175550142", email: "emma@example.test", assignedTo: "usr_new" } });
    return json({});
  };
}

/** Stub live adapter that never touches the network; optional hang body. */
function stubAcuity(appts: Promise<unknown[]> | Error): AcuityLiveAdapter {
  return {
    provider: "acuity",
    isDemo: false,
    lastRun: { requests: 1, window: { minDate: "2026-09-27", maxDate: "2026-11-02" }, truncated: false, warnings: [] },
    fetchAppointments: () => (appts instanceof Error ? Promise.reject(appts) : appts),
    fetchBlockedTimes: async () => [],
  } as unknown as AcuityLiveAdapter;
}

/** A live HighLevel adapter whose FIRST call hangs forever — the 11/2 wedge shape. */
const hungHl = () =>
  ({
    provider: "highlevel",
    isDemo: false,
    fetchUsers: () => new Promise(() => {}),
  }) as unknown as LiveHighLevelAdapter;

const hlRow = (runs: SyncRunRow[]) => runs.find((r) => r.provider === "highlevel")!;

// ---------- the constant + its relationship to the reap window ----------

describe("HIGHLEVEL_RUN_BUDGET_MS (the named constant)", () => {
  test("the named default is 10 min and sits WELL under the 30-min reap window", () => {
    expect(HIGHLEVEL_RUN_BUDGET_MS).toBe(10 * 60_000);
    expect(HIGHLEVEL_RUN_BUDGET_MS).toBeLessThan(STALE_RUN_REAP_MINUTES * 60_000);
    // The reap window derives from the tick ceiling — the budget sits under
    // BOTH aliases of the same 30-min liveness bound.
    expect(HIGHLEVEL_RUN_BUDGET_MS).toBeLessThan(TICK_WATCHDOG_CAP_MS);
  });

  test("HIGHLEVEL_RUN_BUDGET_MS env override applies; invalid values fall back to the default", () => {
    const prev = process.env.HIGHLEVEL_RUN_BUDGET_MS;
    try {
      process.env.HIGHLEVEL_RUN_BUDGET_MS = "1234";
      expect(highlevelRunBudgetMs()).toBe(1234);
      process.env.HIGHLEVEL_RUN_BUDGET_MS = "junk";
      expect(highlevelRunBudgetMs()).toBe(HIGHLEVEL_RUN_BUDGET_MS);
      process.env.HIGHLEVEL_RUN_BUDGET_MS = "-5";
      expect(highlevelRunBudgetMs()).toBe(HIGHLEVEL_RUN_BUDGET_MS);
      delete process.env.HIGHLEVEL_RUN_BUDGET_MS;
      expect(highlevelRunBudgetMs()).toBe(HIGHLEVEL_RUN_BUDGET_MS);
    } finally {
      if (prev === undefined) delete process.env.HIGHLEVEL_RUN_BUDGET_MS;
      else process.env.HIGHLEVEL_RUN_BUDGET_MS = prev;
    }
  });

  test("breach rejects with the honest 'run budget exceeded' error; healthy short pass resolves", async () => {
    let err: unknown;
    try {
      await raceHighLevelRunBudget(() => new Promise(() => {}), { budgetMs: 20 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HighLevelRunBudgetExceededError);
    expect((err as Error).message).toContain("run budget exceeded");
    const out = await raceHighLevelRunBudget(async () => 7, { budgetMs: 20 });
    expect(out).toBe(7);
  });
});

// ---------- entry path A — runProvider's highlevel section (run.ts) ----------

describe("entry path A — the full-sync/bootstrap pass (run.ts)", () => {
  test("budget breach → the run finishes with an honest error row, NOT parked 'running'", async () => {
    const prev = process.env.HIGHLEVEL_RUN_BUDGET_MS;
    try {
      process.env.HIGHLEVEL_RUN_BUDGET_MS = "30";
      const store = new MemoryStore();
      const res = await runDemoSync({
        store,
        sheetsAdapter: null,
        highlevelAdapter: hungHl(),
        acuityAdapter: stubAcuity(Promise.resolve([])),
      });
      const hl = res.providers.find((p) => p.provider === "highlevel")!;
      expect(hl.error).toContain("run budget exceeded");
      const row = hlRow(await store.getSyncRuns(20));
      expect(row.status).toBe("error");
      expect(row.error).toContain("run budget exceeded");
      expect(row.records_upserted).toBe(0);
      expect(await store.getRunningSyncRun("highlevel")).toBeNull(); // not parked; background ticks resume immediately
    } finally {
      if (prev === undefined) delete process.env.HIGHLEVEL_RUN_BUDGET_MS;
      else process.env.HIGHLEVEL_RUN_BUDGET_MS = prev;
    }
  });

  test("healthy short pass unchanged: success row, no budget trip, downstream providers still run", async () => {
    const store = new MemoryStore();
    const res = await runDemoSync({
      store,
      sheetsAdapter: null,
      highlevelAdapter: {
        provider: "highlevel",
        isDemo: false,
        lastRun: { requests: 3, endpointNotes: [], warnings: [] },
        fetchUsers: async () => [{ external_id: "usr_new", name: "Alex Morgan", email: "alex@mallory.test" }],
        fetchContacts: async () => [],
        fetchCalls: async () => [],
        fetchOpportunities: async () => [],
      } as unknown as LiveHighLevelAdapter,
      acuityAdapter: stubAcuity(Promise.resolve([])),
    });
    const hl = res.providers.find((p) => p.provider === "highlevel")!;
    expect(hl.error).toBeNull();
    expect(hlRow(await store.getSyncRuns(20)).status).toBe("success");
    expect(res.providers.map((p) => p.provider)).toContain("google_sheets");
  });
});

// ---------- entry path B — highlevelTick's incremental harvest ----------

describe("entry path B — highlevelTick's incremental harvest pass", () => {
  test("budget breach → tick error, row finished 'error', not parked 'running'; the next tick's guard is clear", async () => {
    const prev = process.env.HIGHLEVEL_RUN_BUDGET_MS;
    try {
      process.env.HIGHLEVEL_RUN_BUDGET_MS = "30";
      const store = new MemoryStore();
      await store.setSyncWatermark("highlevel", secondsAgoIso(120));
      const res = await highlevelTick({
        store,
        creds: CREDENTIALS,
        fetchImpl: makeIncrementalFetch({ hang: true }),
        trigger: "background",
      });
      expect(res.outcome).toBe("error");
      expect(res.error).toContain("run budget exceeded");
      const row = hlRow(await store.getSyncRuns(10));
      expect(row.status).toBe("error");
      expect(row.error).toContain("run budget exceeded");
      expect(row.records_upserted).toBe(0);
      expect(await store.getRunningSyncRun("highlevel")).toBeNull();
      // the connection row records the same honest error (availabilityTick contract)
      const conn = (await store.getConnections()).find((c) => c.provider === "highlevel");
      expect(conn?.status).toBe("error");
      expect(conn?.last_error).toContain("run budget exceeded");
    } finally {
      if (prev === undefined) delete process.env.HIGHLEVEL_RUN_BUDGET_MS;
      else process.env.HIGHLEVEL_RUN_BUDGET_MS = prev;
    }
  });

  test("healthy short pass unchanged: 'synced' with the DEFAULT 10-min budget", async () => {
    const store = new MemoryStore();
    await store.setSyncWatermark("highlevel", secondsAgoIso(120));
    const res = await highlevelTick({
      store,
      creds: CREDENTIALS,
      fetchImpl: makeIncrementalFetch(),
      trigger: "background",
    });
    expect(res.outcome).toBe("synced");
    expect(res.calls).toBe(1);
    expect(hlRow(await store.getSyncRuns(10)).status).toBe("success");
  });
});

// ---------- the reap before the running-guard ----------

describe("reap BEFORE the sync-in-progress guard (item b)", () => {
  test("a stale 'running' row is reaped by a DIRECT highlevelTick call — before the guard (freshness-watchdog path)", async () => {
    const store = new MemoryStore();
    await store.insertSyncRun("highlevel"); // 'running', started real-now
    // The tick's clock reads 40 minutes later: the row is past the reap window.
    const res = await highlevelTick({
      store,
      creds: null, // the tick still skips (no credentials) — but AFTER reaping
      now: () => new Date(Date.now() + 40 * 60_000),
    });
    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("no-credentials");
    const row = hlRow(await store.getSyncRuns(10));
    expect(row.status).toBe("error");
    expect(row.error).toContain("stale:");
    expect(row.error).toContain("exceeded 30 minutes");
  });

  test("a LIVE (young) 'running' row still skips the tick — the reap never touches live rows", async () => {
    const store = new MemoryStore();
    await store.insertSyncRun("highlevel"); // started seconds ago — a live run
    const res = await highlevelTick({ store, creds: null });
    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("sync-in-progress");
    expect(await store.getRunningSyncRun("highlevel")).not.toBeNull();
  });
});
