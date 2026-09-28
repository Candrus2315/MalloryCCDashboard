/**
 * SHEETS AUTO-SYNC + DATA-PROTECTION tests (owner directive 2026-09-28).
 *
 * Background: the scheduler never synced Google Sheets (liveAdapters typed
 * `sheets: null`; serve.ts passed nothing) so Sunday's sheet row never
 * entered the DB — and the same run.ts sheets section carried a latent
 * data-loss hazard: a failed/absent live fetch demo-REPLACEd the stored
 * leads per sheet. Pinned here:
 *
 *  - runSheetsSync (ONE core shared by full sync + background tick):
 *      · live success → UPSERT-ONLY under v2 content keys (never deletes
 *        stored rows the fetch didn't include) + honest connection row;
 *      · live FAILURE with stored leads → stored leads UNTOUCHED
 *        (demo rows never replace live data) + error surfaced;
 *      · live failure on an EMPTY dataset → demo fallback still seeds
 *        (the pre-existing demo-mode contract, unchanged);
 *      · no adapter + stored leads → untouched (skip note);
 *  - sheetsTick: adapter present → sync_runs row + leads stored; no adapter
 *    → clean skip (NEVER demo); background throttle; manual skips throttle;
 *    running-row guard;
 *  - schedulerTick includes the sheets sync (result.sheets) when an adapter
 *    is provided, and reaps zombie "running" rows before proceeding;
 *  - reapStaleSyncRuns: bounded providers' >15-min "running" rows marked
 *    failed with a clear note; fresh rows and non-reapable providers kept;
 *  - HL fetch timeout: a hung API call becomes a fast network error (no
 *    forever-running run), test-shrunk via opts.timeoutMs.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { GoogleSheetsAdapter } from "../sync/adapters";
import type { NormalizedLead } from "../sync/sheets-mapping";
import { runDemoSync, runSheetsSync } from "../sync/run";
import { sheetsTick, SHEETS_MIN_INTERVAL_MS } from "../sync/sheets-tick";
import { reapStaleSyncRuns, schedulerTick, STALE_RUN_REAP_MINUTES } from "../sync/scheduler";
import { hlRequest } from "../sync/highlevel-live";
import { getWorkDate, addDays } from "../date-logic";

const countLead = (l: NormalizedLead): NormalizedLead => l; // type helper

/** A row-per-day-count lead (the shape the owner's real sheets use). */
function dayLead(sheet: "family" | "animalia", sourceDate: string, n: number, leadType?: string): NormalizedLead {
  return {
    source_id: `SHEET#${sheet}#${sourceDate}#${n}`,
    leadType: leadType ?? sheet,
    sourceDate,
    workDate: getWorkDate(sourceDate),
    name: null,
    phone: null,
    email: null,
    sheet,
  };
}

/** Live stub returning per-day counts for BOTH sheets (family f, animalia a) for the given source dates. */
function liveStub(dates: string[], familyPerDay = 5, animaliaPerDay = 7): GoogleSheetsAdapter {
  const leads: NormalizedLead[] = [];
  for (const d of dates) {
    for (let i = 0; i < familyPerDay; i++) leads.push(dayLead("family", d, i));
    for (let i = 0; i < animaliaPerDay; i++) leads.push(dayLead("animalia", d, i));
  }
  return {
    provider: "google_sheets",
    isDemo: false,
    fetchLeads: async () => leads,
  };
}

const failingStub = (message = "Sheets API unreachable"): GoogleSheetsAdapter => ({
  provider: "google_sheets",
  isDemo: false,
  fetchLeads: async () => {
    throw new Error(message);
  },
});

const FAM = (rows: NormalizedLead[], d: string) => rows.filter((l) => l.sheet === "family" && l.sourceDate === d).length;

// ---------- runSheetsSync: the shared sync core ----------
describe("runSheetsSync — demo-replace guard + upsert-only storage", () => {
  test("live success stores per-sheet counts and writes an honest connection row", async () => {
    const store = new MemoryStore();
    const settings = await store.getSettings();
    const d = "2026-09-27";
    const res = await runSheetsSync(store, settings, liveStub([d], 55, 72));
    expect(res.live).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.count).toBe(127); // 55 family + 72 animalia
    const todayLeads = await store.getLeadsByWorkDates([getWorkDate(d)]);
    const fam = todayLeads.filter((l) => l.source_sheet === "family").length;
    const ani = todayLeads.filter((l) => l.source_sheet === "animalia").length;
    expect([fam, ani]).toEqual([55, 72]); // Sunday 2026-09-27 works into Monday 2026-09-28
    const conn = (await store.getConnections()).find((c) => c.provider === "google_sheets");
    expect(conn?.status).toBe("connected");
    expect(conn?.is_demo).toBe(false);
    expect(conn?.last_error).toBeNull();
  });

  test("LIVE FAILURE with stored leads → stored leads UNTOUCHED (demo rows never replace live data)", async () => {
    const store = new MemoryStore();
    const settings = await store.getSettings();
    // real, live data already stored (a prior successful sync)
    await runSheetsSync(store, settings, liveStub(["2026-09-27"], 55, 72));
    const before = await store.getLeadsByWorkDates([getWorkDate("2026-09-27")]);
    expect(before.length).toBe(127);
    const prevConn = (await store.getConnections()).find((c) => c.provider === "google_sheets")!;
    const prevSuccess = prevConn.last_successful_sync_at!;

    const res = await runSheetsSync(store, settings, failingStub("Sheets API is not enabled"));
    expect(res.live).toBe(false);
    expect(res.liveFailed).toBe(true);
    expect(res.error).toContain("Sheets API is not enabled");
    expect(res.count).toBe(0); // nothing stored
    const after = await store.getLeadsByWorkDates([getWorkDate("2026-09-27")]);
    expect(after.length).toBe(127); // byte-for-byte untouched
    expect(after.filter((l) => l.source_sheet === "family").length).toBe(55);
    expect(after.filter((l) => l.source_sheet === "animalia").length).toBe(72);

    const conn = (await store.getConnections()).find((c) => c.provider === "google_sheets")!;
    expect(conn.status).toBe("error");
    expect(conn.is_demo).toBe(false); // stored rows are live data, not demo
    expect(conn.last_error).toContain("Sheets API is not enabled");
    expect(conn.last_successful_sync_at).toBe(prevSuccess); // preserved (stale-data warnings read it)
  });

  test("live failure on an EMPTY dataset still demo-falls-back (demo-mode contract unchanged)", async () => {
    const store = new MemoryStore();
    const res = await runDemoSync({ store, sheetsAdapter: failingStub(), highlevelAdapter: null });
    const sheets = res.providers.find((p) => p.provider === "google_sheets")!;
    expect(sheets.error).toContain("Sheets API unreachable");
    expect(sheets.count).toBeGreaterThan(0); // demo seed allowed: no stored leads existed
    const conn = (await store.getConnections()).find((c) => c.provider === "google_sheets")!;
    expect(conn.status).toBe("error");
    expect(conn.is_demo).toBe(true);
  });

  test("NO ADAPTER with stored leads → untouched + skip note; empty dataset → demo seed", async () => {
    const store = new MemoryStore();
    const settings = await store.getSettings();
    await runSheetsSync(store, settings, liveStub(["2026-09-27"], 55, 72));
    const before = await store.getLeadsByWorkDates([getWorkDate("2026-09-27")]);
    expect(before.length).toBe(127);

    const res = await runSheetsSync(store, settings, null);
    expect(res.live).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.count).toBe(0);
    expect(res.note).toContain("Demo seed skipped");
    const after = await store.getLeadsByWorkDates([getWorkDate("2026-09-27")]);
    expect(after.length).toBe(127); // untouched

    const fresh = new MemoryStore();
    const demoRes = await runSheetsSync(fresh, await fresh.getSettings(), null);
    expect(demoRes.count).toBeGreaterThan(0); // demo dataset seeded on a truly empty store
    expect(demoRes.note).toContain("Demo dataset");
  });

  test("UPSERT-ONLY: rows removed from the sheet are KEPT (never mass-deleted)", async () => {
    // The old per-sheet REPLACE deleted every stored lead the fetch didn't
    // include — a transient mid-edit fetch could then wipe a whole sheet's
    // stored history (observed live 2026-09-28: 315 → 262 → 183 → 315).
    // Upset-only semantics: the shrunk fetch updates its own 3 rows and the
    // other 52 stay stored (history — cohort math depends on stored rows).
    const store = new MemoryStore();
    const settings = await store.getSettings();
    const d = "2026-09-27";
    await runSheetsSync(store, settings, liveStub([d], 55, 72));
    // sheet now reports only 3 family rows for that day → nothing is deleted
    const shrunk: GoogleSheetsAdapter = {
      provider: "google_sheets",
      isDemo: false,
      fetchLeads: async () => Array.from({ length: 3 }, (_, n) => dayLead("family", d, n)),
    };
    const res = await runSheetsSync(store, settings, shrunk);
    expect(res.count).toBe(3); // only the fetched rows were stored/updated
    const fam = (await store.getLeadsByWorkDates([getWorkDate(d)])).filter((l) => l.source_sheet === "family");
    expect(fam.length).toBe(55); // 52 stale rows KEPT + 3 updated in place
  });
});

// ---------- sheetsTick (background wiring) ----------
describe("sheetsTick", () => {
  test("adapter present → leads synced, sync_runs row success, connection updated", async () => {
    const store = new MemoryStore();
    const res = await sheetsTick({ store, adapter: liveStub(["2026-09-27"], 55, 72), trigger: "background" });
    expect(res.outcome).toBe("synced");
    expect(res.leads).toBe(127);
    const run = (await store.getSyncRuns(10)).find((r) => r.provider === "google_sheets");
    expect(run?.status).toBe("success");
    const conn = (await store.getConnections()).find((c) => c.provider === "google_sheets");
    expect(conn?.status).toBe("connected");
    expect(conn?.is_demo).toBe(false);
  });

  test("NO adapter → clean skip, no demo rows, no sync run started", async () => {
    const store = new MemoryStore();
    const res = await sheetsTick({ store, adapter: null, trigger: "background" });
    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("no-credentials");
    expect(await store.countLeads("google_sheets")).toBe(0);
    expect((await store.getSyncRuns(10)).filter((r) => r.provider === "google_sheets").length).toBe(0);
  });

  test("background throttle: recent sync skips; manual trigger skips the throttle", async () => {
    const store = new MemoryStore();
    const first = await sheetsTick({ store, adapter: liveStub(["2026-09-27"]), trigger: "background" });
    expect(first.outcome).toBe("synced");
    const throttled = await sheetsTick({ store, adapter: liveStub(["2026-09-27"]), trigger: "background" });
    expect(throttled.outcome).toBe("skipped");
    expect(throttled.reason).toBe("recent-sync");
    const manual = await sheetsTick({ store, adapter: liveStub(["2026-09-27"]), trigger: "manual" });
    expect(manual.outcome).toBe("synced"); // manual SYNC NOW / REFRESH ignores the throttle
  });

  test("injectable clock honors SHEETS_MIN_INTERVAL_MS (10 min)", async () => {
    const store = new MemoryStore();
    const t0 = new Date("2026-09-28T10:00:00Z");
    const first = await sheetsTick({ store, adapter: liveStub(["2026-09-27"]), trigger: "background", now: () => t0 });
    expect(first.outcome).toBe("synced");
    const soon = await sheetsTick({
      store, adapter: liveStub(["2026-09-27"]), trigger: "background",
      now: () => new Date(t0.getTime() + SHEETS_MIN_INTERVAL_MS - 1000),
    });
    expect(soon.outcome).toBe("skipped");
    expect(soon.reason).toBe("recent-sync");
    const later = await sheetsTick({
      store, adapter: liveStub(["2026-09-27"]), trigger: "background",
      now: () => new Date(t0.getTime() + SHEETS_MIN_INTERVAL_MS + 1000),
    });
    expect(later.outcome).toBe("synced");
  });

  test("running google_sheets row blocks the tick; >15-min row proceeds (crashed process)", async () => {
    const store = new MemoryStore();
    await store.insertSyncRun("google_sheets");
    const blocked = await sheetsTick({ store, adapter: liveStub(["2026-09-27"]), trigger: "background" });
    expect(blocked).toEqual({ outcome: "skipped", reason: "sync-in-progress" });
    const advanced = await sheetsTick({
      store, adapter: liveStub(["2026-09-27"]), trigger: "background",
      now: () => new Date(Date.now() + (STALE_RUN_REAP_MINUTES + 1) * 60_000),
    });
    expect(advanced.outcome).toBe("synced");
  });
});

// ---------- scheduler integration ----------
describe("schedulerTick × sheets + stale-run reaper", () => {
  test("tick INCLUDES the sheets sync when an adapter is provided", async () => {
    const store = new MemoryStore();
    const res = await schedulerTick({
      store,
      creds: null, // HighLevel skipped; sheets still piggy-backed
      liveAdapters: { sheets: liveStub(["2026-09-27"], 55, 72) },
      trigger: "background",
    });
    expect(res.sheets?.outcome).toBe("synced");
    expect(res.sheets?.leads).toBe(127);
    const run = (await store.getSyncRuns(10)).find((r) => r.provider === "google_sheets");
    expect(run?.status).toBe("success");
  });

  test("tick without any sheets adapter skips cleanly (never demo)", async () => {
    const store = new MemoryStore();
    const res = await schedulerTick({ store, creds: null, liveAdapters: { sheets: null }, trigger: "background" });
    expect(res.sheets?.outcome).toBe("skipped");
    expect(res.sheets?.reason).toBe("no-credentials");
    expect(await store.countLeads("google_sheets")).toBe(0);
  });

  test("REAPER: zombie runs >15 min marked failed with a clear note; fresh rows + non-reapable providers untouched", async () => {
    const store = new MemoryStore();
    const justOverCutoff = () => new Date(Date.now() + (STALE_RUN_REAP_MINUTES + 1) * 60_000);
    const zombieId = await store.insertSyncRun("highlevel");
    const backfillId = await store.insertSyncRun("resumable-backfill"); // not a bounded provider
    expect(await reapStaleSyncRuns(store, justOverCutoff)).toBe(1); // only the highlevel zombie
    // A row started now is fresh under the REAL clock — not reaped.
    const freshId = await store.insertSyncRun("google_sheets");
    expect(await reapStaleSyncRuns(store)).toBe(0);
    const runs = await store.getSyncRuns(10);
    const zombie = runs.find((r) => r.id === zombieId)!;
    expect(zombie.status).toBe("error");
    expect(zombie.error).toContain("stale");
    expect(zombie.error).toContain("15 minutes");
    expect(zombie.error).toContain("stale-run reaper");
    expect(runs.find((r) => r.id === freshId)!.status).toBe("running");
    expect(runs.find((r) => r.id === backfillId)!.status).toBe("running");
  });

  test("the tick reaps zombies BEFORE the guards, so a wedged run cannot block syncing", async () => {
    const store = new MemoryStore();
    await store.insertSyncRun("highlevel"); // wedged zombie (started "now")
    await store.setSyncWatermark("highlevel", new Date(Date.now() - 120_000).toISOString());
    const res = await schedulerTick({
      store,
      creds: null,
      trigger: "background",
      now: () => new Date(Date.now() + (STALE_RUN_REAP_MINUTES + 1) * 60_000),
    });
    expect(res.reaped).toBe(1);
    const zombie = (await store.getSyncRuns(10)).find((r) => r.provider === "highlevel")!;
    expect(zombie.status).toBe("error");
    expect(res.outcome).toBe("skipped"); // HighLevel skipped (no creds), but…
    // …the reaper already unblocked the provider for the NEXT tick with credentials.
  });
});

// ---------- HL fetch hard timeout ----------
describe("HighLevel fetch timeout", () => {
  test("a hung API call times out fast (network-classified), not forever", async () => {
    const started = Date.now();
    let sawSignal: unknown;
    try {
      await hlRequest(
        { path: "/users/" },
        {
          creds: { apiKey: "k", locationId: "l" },
          fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) => {
            sawSignal = init?.signal;
            return new Promise<Response>(() => {}); // never resolves — the hung case
          }) as unknown as (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }) => Promise<Response>,
          sleep: async () => {},
          timeoutMs: 80,
        },
      );
      throw new Error("expected hlRequest to throw");
    } catch (e) {
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((e as { kind?: string }).kind).toBe("network");
      expect((e as Error).message).toContain("timed out");
    }
    expect(sawSignal).toBeInstanceOf(AbortSignal); // real fetch would abort at the cap
  });
});

// sanity on the shared helper used above (guards accidental type drift)
test("dayLead helper produces work-date-correct counts", () => {
  const l = countLead(dayLead("family", "2026-09-27", 0));
  expect(l.sheet).toBe("family");
  expect(l.workDate).toBe(getWorkDate("2026-09-27"));
  expect(addDays("2026-09-27", 1)).toBe(getWorkDate("2026-09-27"));
});
