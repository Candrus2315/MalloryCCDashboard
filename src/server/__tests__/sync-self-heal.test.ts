/**
 * SYNC SELF-HEAL tests (2026-10-17 hardening, third hang of this class):
 *  - BOUNDED BODY READS: Bun's fetch honors an armed AbortSignal for a
 *    streaming body but a read PARKED on a silent socket never wakes on it
 *    (the 2026-10-15 harvest run held the 'highlevel' mutex ~14.8h on
 *    `res.json()`; /tmp/serve.log holds wedged ticks of 66.2h/19.2h/5.2h).
 *    Every sync client now races body reads against a JS-timer bound.
 *  - TICK WATCHDOG + INDEPENDENT REAPER: a hung tick used to own the
 *    scheduler loop forever, and the stale-run reaper (which lives INSIDE the
 *    tick) never ran — stale 'running' rows lingered for 13-15h. Now the
 *    loop is raced against a cap and the reaper runs on its own cadence,
 *    covering script-launched rows too (it always scanned by STATUS).
 * All tests are offline: stub fetches and a MemoryStore — no live APIs.
 */
import { describe, expect, test } from "bun:test";
import { raceBodyRead, isNetworkBodyErrorLike, makeBudgetBoundedFetch, type BoundedFetch } from "../sync/body-read";
import { HighLevelError, hlRequest, type HighLevelCreds } from "../sync/highlevel-live";
import {
  REAPER_INTERVAL_MS,
  raceTickWatchdog,
  reapStaleSyncRuns,
  runStaleRunReaperLoop,
  STALE_RUN_REAP_MINUTES,
  TICK_WATCHDOG_CAP_MS,
} from "../sync/scheduler";
import { MemoryStore } from "../store/memory";

const CREDS: HighLevelCreds = { apiKey: "test-key", locationId: "test-loc" };
const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("raceBodyRead (bounded body reads)", () => {
  test("resolves the body when it arrives well within the bound", async () => {
    const out = await raceBodyRead(Promise.resolve({ ok: 1 }), 200, "test body");
    expect(out).toEqual({ ok: 1 });
  });

  test("rejects a parked body read at the bound even though it never settles", async () => {
    const t0 = Date.now();
    await expect(
      raceBodyRead(new Promise<unknown>(() => {}), 25, "test parked body"),
    ).rejects.toThrow(/test parked body stalled.*read aborted/i);
    // the bound fired ~25ms later — a JS-timer race, not socket-dependent
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("classifies a raced timeout as network-class and JSON truncation as network-class (dual-path)", () => {
    const raced = new Error("test body stalled — no body bytes within 60s, read aborted (hung body read timed out)");
    expect(isNetworkBodyErrorLike(raced)).toBe(true);
    expect(isNetworkBodyErrorLike(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
    // a merely non-JSON document is NOT network-class
    expect(isNetworkBodyErrorLike(new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON'))).toBe(false);
  });
});

describe("hlRequest body-read bounding (the confirmed 2026-10-15 offender)", () => {
  const headersResponse = (jsonImpl: () => Promise<unknown>) =>
    ({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: jsonImpl,
    }) as unknown as Response;

  test("a 200 whose body read parks forever becomes an honest network error at the bound", async () => {
    const fetchImpl = (async () => headersResponse(() => new Promise(() => {}))) as unknown as typeof fetch;
    const t0 = Date.now();
    try {
      await hlRequest({ path: "/conversations/search", query: new URLSearchParams({ locationId: CREDS.locationId }) }, {
        creds: CREDS,
        fetchImpl,
        sleep: realSleep,
        timeoutMs: 30,
      });
      throw new Error("expected hlRequest to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(HighLevelError);
      const err = e as HighLevelError;
      expect(err.kind).toBe("network");
      expect(err.message).toContain("response body read failed");
      expect(err.message).toMatch(/timed out|stalled|aborted/i);
    }
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("a genuine non-JSON document keeps the legacy api-class message (no masking drift)", async () => {
    const fetchImpl = (async () =>
      headersResponse(() => Promise.reject(new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON')))) as unknown as typeof fetch;
    try {
      await hlRequest({ path: "/users/", query: new URLSearchParams({ locationId: CREDS.locationId }) }, {
        creds: CREDS,
        fetchImpl,
        sleep: realSleep,
        timeoutMs: 30,
      });
      throw new Error("expected hlRequest to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(HighLevelError);
      expect((e as HighLevelError).kind).toBe("api");
      expect((e as HighLevelError).message).toContain("returned non-JSON");
    }
  });
});

describe("makeBudgetBoundedFetch (run-harvest's minutes-argument actually aborts fetches)", () => {
  test("rejects BEFORE dialing when the budget is already exhausted", async () => {
    const dialed: string[] = [];
    const base: BoundedFetch = async (url) => {
      dialed.push(url);
      return new Response("{}", { status: 200 });
    };
    const budget = new AbortController();
    budget.abort();
    const bounded = makeBudgetBoundedFetch(base, budget.signal, "harvest run");
    await expect(bounded("https://services.example/x", {})).rejects.toThrow(/time budget exhausted/);
    expect(dialed).toEqual([]);
  });

  test("aborts an in-flight fetch that ignores its signal when the budget expires", async () => {
    // base fetch that NEVER settles and ignores its init signal — the exact
    // "non-cooperative" shape the race backstop exists for.
    const base: BoundedFetch = () => new Promise<Response>(() => {});
    const budget = new AbortController();
    const bounded = makeBudgetBoundedFetch(base, budget.signal, "harvest run");
    const pending = bounded("https://services.example/x", {});
    setTimeout(() => budget.abort(), 30);
    const t0 = Date.now();
    await expect(pending).rejects.toThrow(/time budget exhausted.*mid-flight/s);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("still settles normally when the budget never fires", async () => {
    const base: BoundedFetch = async () => new Response('{"ok":true}', { status: 200 });
    const budget = new AbortController();
    const bounded = makeBudgetBoundedFetch(base, budget.signal, "harvest run");
    const res = await bounded("https://services.example/x", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("tick watchdog + independent stale-run reaper (self-healing tick chain)", () => {
  test("TICK_WATCHDOG_CAP_MS is 30 minutes and the reaper cadence is 5 minutes", () => {
    expect(TICK_WATCHDOG_CAP_MS).toBe(30 * 60_000);
    expect(REAPER_INTERVAL_MS).toBe(5 * 60_000);
  });

  test("raceTickWatchdog: a settling tick wins; a parked tick loses at the cap", async () => {
    await expect(raceTickWatchdog(Promise.resolve({ outcome: "synced" }), 100, realSleep)).resolves.toBe("settled");
    const t0 = Date.now();
    await expect(raceTickWatchdog(new Promise(() => {}), 25, realSleep)).resolves.toBe("watchdog");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("the independent reaper loop closes a SCRIPT-launched stale running row (no tick needed)", async () => {
    const store = new MemoryStore();
    const staleId = await store.insertSyncRun("highlevel"); // as run-harvest.ts inserts it
    // backdate the row past the reap window — a 14.8h hang, not a live run
    const staleStarted = new Date(Date.now() - (STALE_RUN_REAP_MINUTES + 5) * 60_000).toISOString();
    (store as unknown as { syncRuns: { id: string; started_at: string }[] }).syncRuns[0].started_at = staleStarted;

    const finished: { id: string; status: string; error: string | null }[] = [];
    const originalFinish = store.finishSyncRun.bind(store);
    store.finishSyncRun = (async (id: string, status: string, rec: number, error: string | null) => {
      finished.push({ id, status, error });
      return originalFinish(id, status, rec, error);
    }) as typeof store.finishSyncRun;

    await runStaleRunReaperLoop({ store, sleep: realSleep, rounds: 1, intervalMs: 1 });

    expect(finished).toHaveLength(1);
    expect(finished[0].id).toBe(staleId);
    expect(finished[0].status).toBe("error");
    expect(finished[0].error).toContain("stale:");
  });

  test("the independent reaper loop leaves a FRESH running row alone (live runs are not zombies)", async () => {
    const store = new MemoryStore();
    await store.insertSyncRun("highlevel"); // started now — within the reap window
    const finished: unknown[] = [];
    const originalFinish = store.finishSyncRun.bind(store);
    store.finishSyncRun = (async (...args: unknown[]) => {
      finished.push(args);
      return originalFinish(...(args as [string, string, number, string | null]));
    }) as typeof store.finishSyncRun;
    await runStaleRunReaperLoop({ store, sleep: realSleep, rounds: 1, intervalMs: 1 });
    expect(finished).toHaveLength(0);
  });

  test("reapStaleSyncRuns itself (the in-tick pass) still closes stale rows of every reapable provider", async () => {
    const store = new MemoryStore();
    const ids: string[] = [];
    for (const provider of ["highlevel", "google_sheets", "acuity", "attribution", "acuity_availability"]) {
      const id = await store.insertSyncRun(provider);
      (store as unknown as { syncRuns: { id: string; started_at: string }[] })
        .syncRuns.find((r) => r.id === id)!.started_at = new Date(Date.now() - (STALE_RUN_REAP_MINUTES + 10) * 60_000).toISOString();
      ids.push(id);
    }
    const reaped = await reapStaleSyncRuns(store);
    expect(reaped).toBe(ids.length);
    for (const id of ids) {
      const row = (store as unknown as { syncRuns: { id: string; status: string; error: string | null }[] }).syncRuns.find((r) => r.id === id);
      expect(row?.status).toBe("error");
      expect(row?.error).toContain("stale:");
    }
  });
});
