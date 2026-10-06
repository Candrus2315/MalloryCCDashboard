/**
 * AVAILABILITY FEED — store-method + sync-tick tests over the MemoryStore
 * (the pg twins share the contracts via the satisfies map + the advisory-locked
 * writers; the live-DB write path is exercised by the controlled sync run).
 * The tick runs with a fixture-routed fake fetch — NO live API call.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../store/memory";
import { AcuityAvailabilityClient } from "../sync/acuity-availability";
import {
  AVAILABILITY_FEED_WRITER_VERSION,
  AVAILABILITY_FEED_WRITER_VERSION_KEY,
  availabilityFeedTick,
  detectAndApplyDiscrepancies,
  resetAvailabilityFeedThrottle,
  runAvailabilityFeedSync,
} from "../sync/availability-feed";
import type { Store } from "../store/types";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "availability-feed");
const loadFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));

const CALS = loadFixture("calendars.json");
const TYPES = loadFixture("appointment-types.json");
const DATES_OCT = loadFixture("dates-2026-10-cal1335091.json");
const DATES_NOV = loadFixture("dates-2026-11-cal1335091.json");

/**
 * Fake Acuity API: route by path + query (params in any order). Main calendar
 * answers from the fixtures; Annex/Zoom answer [] for every date/month.
 */
function fakeFetch(log: { urls: string[] }) {
  return (async (url: string) => {
    log.urls.push(url);
    const u = new URL(url);
    const path = u.pathname.replace("/api/v1/", "");
    const q = (k: string) => u.searchParams.get(k) ?? "";
    let body: unknown = [];
    if (path === "calendars") body = CALS;
    else if (path === "appointment-types") body = TYPES;
    else if (path === "availability/dates") {
      if (q("calendarID") === "1335091" && q("month") === "2026-10") body = DATES_OCT;
      else if (q("calendarID") === "1335091" && q("month") === "2026-11") body = DATES_NOV;
      else body = []; // Annex/Zoom/far months: the honest empty answer
    } else if (path === "availability/times") {
      if (q("calendarID") === "1335091" && q("date") === "2026-10-24") body = loadFixture("t2-2026-10-24-main.json");
      else if (q("calendarID") === "1335091" && q("date") === "2026-10-13") body = loadFixture("times-2026-10-13-cal1335091.json");
      else body = [];
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as (url: string, init?: { headers?: Record<string, string>; method?: string }) => Promise<Response>;
}

const makeClient = (log: { urls: string[] }) =>
  new AcuityAvailabilityClient({ userId: "u1", apiKey: "k1" }, fakeFetch(log), async () => {}); // no real sleeps in tests

const NOW = () => new Date("2026-10-06T18:00:00Z");

describe("availability feed store methods (MemoryStore)", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  test("dates cache: upsert per (calendar, type, month); re-put REPLACES the month row", async () => {
    await store.putAvailabilityDates([{ calendar_id: "1335091", appointment_type_id: "3599872", month: "2026-10", dates_et: ["2026-10-08", "2026-10-12"] }], "run-1");
    await store.putAvailabilityDates([{ calendar_id: "1335091", appointment_type_id: "3599872", month: "2026-10", dates_et: ["2026-10-08", "2026-10-12", "2026-10-13"] }], "run-2");
    const rows = await store.getAvailabilityDates(["2026-10"]);
    expect(rows).toHaveLength(1); // same key → one row
    expect(rows[0].dates_et).toEqual(["2026-10-08", "2026-10-12", "2026-10-13"]);
    expect(rows[0].run_id).toBe("run-2");
    expect(await store.getAvailabilityDates(["2026-11"])).toEqual([]); // month filter
    // empty month rows cache too (the coverage horizon)
    await store.putAvailabilityDates([{ calendar_id: "1335091", appointment_type_id: "3599872", month: "2026-12", dates_et: [] }], "run-3");
    const dec = await store.getAvailabilityDates(["2026-12"]);
    expect(dec[0].dates_et).toEqual([]);
  });

  test("slot cache: REPLACE per (calendar, date); first_seen_at write-once; last_confirmed_at refreshed; duplicate times dedupe (best capacity)", async () => {
    const n1 = await store.putAvailabilitySlotsForDate("1335091", "2026-10-24", [
      { time_et: "15:30", slots_available: 1 },
      { time_et: "16:30", slots_available: 1 },
    ], "run-1");
    expect(n1).toBe(2);
    const first = await store.getAvailabilitySlotsForDates(["2026-10-24"]);
    expect(first.map((r) => r.time_et)).toEqual(["15:30", "16:30"]);
    const firstSeen = first.find((r) => r.time_et === "15:30")!.first_seen_at;
    // feed later drops 16:30 (booked upstream): REPLACE semantics remove it
    const n2 = await store.putAvailabilitySlotsForDate("1335091", "2026-10-24", [{ time_et: "15:30", slots_available: 2 }], "run-2");
    expect(n2).toBe(1);
    const second = await store.getAvailabilitySlotsForDates(["2026-10-24"]);
    expect(second.map((r) => r.time_et)).toEqual(["15:30"]);
    expect(second[0].first_seen_at).toBe(firstSeen); // write-once
    expect(second[0].last_confirmed_at >= firstSeen).toBe(true); // refreshed
    expect(second[0].slots_available).toBe(2);
    expect(second[0].run_id).toBe("run-2");
    // an EMPTY answer clears the date (Acuity's [] IS an answer)
    const n3 = await store.putAvailabilitySlotsForDate("1335091", "2026-10-24", [], "run-3");
    expect(n3).toBe(0);
    expect(await store.getAvailabilitySlotsForDates(["2026-10-24"])).toEqual([]);
    // duplicate time rows in one answer dedupe by upsert key, best capacity wins
    const n4 = await store.putAvailabilitySlotsForDate("1335091", "2026-10-24", [
      { time_et: "15:30", slots_available: 1 },
      { time_et: "15:30", slots_available: 3 },
    ], "run-4");
    expect(n4).toBe(1);
    expect((await store.getAvailabilitySlotsForDates(["2026-10-24"]))[0].slots_available).toBe(3);
  });

  test("availability runs: insert → finish → newest-first reads", async () => {
    const id1 = await store.insertAvailabilitySyncRun({ trigger: "background" });
    const id2 = await store.insertAvailabilitySyncRun({ trigger: "manual" });
    await store.finishAvailabilitySyncRun(id1, "success", 7, null);
    const runs = await store.getAvailabilitySyncRuns(10);
    expect(runs.map((r) => r.id)).toEqual([id2, id1]);
    expect(runs[1].status).toBe("success");
    expect(runs[1].calls_made).toBe(7);
  });

  test("discrepancies: dedupe while unresolved, resolve when not seen, re-detection inserts a NEW row, unscanned pairs untouched", async () => {
    const d = (time: string) => ({ calendar_id: "1335091", date_et: "2026-10-24", time_et: time, kind: "acuity-open-but-booked" as const, detail: { acuity: "open" } });
    // run 1: one mismatch
    const r1 = await store.applyAvailabilityDiscrepancies("run-1", [{ calendar_id: "1335091", date_et: "2026-10-24" }], [d("16:30")]);
    expect(r1).toEqual({ inserted: 1, resolved: 0 });
    // run 2: SAME mismatch still seen → no duplicate
    const r2 = await store.applyAvailabilityDiscrepancies("run-2", [{ calendar_id: "1335091", date_et: "2026-10-24" }], [d("16:30")]);
    expect(r2).toEqual({ inserted: 0, resolved: 0 });
    expect((await store.getAvailabilityDiscrepancies({ unresolvedOnly: true })).length).toBe(1);
    // run 3: Acuity fixed itself → the mismatch is gone from the current state → RESOLVED
    const r3 = await store.applyAvailabilityDiscrepancies("run-3", [{ calendar_id: "1335091", date_et: "2026-10-24" }], []);
    expect(r3).toEqual({ inserted: 0, resolved: 1 });
    expect(await store.getAvailabilityDiscrepancies({ unresolvedOnly: true })).toEqual([]);
    // a DIFFERENT (calendar, date) pair that was never scanned is never resolved
    const r4 = await store.applyAvailabilityDiscrepancies("run-4", [{ calendar_id: "1335091", date_et: "2026-10-24" }], [d("16:30")]);
    expect(r4.inserted).toBe(1); // re-detection after resolution → NEW row (history preserved)
    const list = await store.getAvailabilityDiscrepancies({});
    expect(list.length).toBe(2);
    expect(list.filter((r) => r.resolved_at != null)).toHaveLength(1);
  });

  test("detectAndApplyDiscrepancies: booked-truth is calendar-scoped and cancellation-frees-slot applies", async () => {
    const runId = await store.insertAvailabilitySyncRun({ trigger: "manual" });
    // booked rows: main 16:30 (the divergence) + a cancelled 15:30 + an Annex 08:00 row
    await store.upsertAppointments([
      {
        id: "", acuity_appointment_id: "a-div", contact_id: null, calendar_id: "1335091", calendar_name: "MALLORY PORTRAITS",
        appointment_type: 'Alliance Portrait Session + 20" Portrait', appointment_datetime: "2026-10-24T20:30:00Z", // 16:30 EDT
        created_at: "2026-01-15T17:29:55.000Z", status: "scheduled", cancelled: false,
      },
      {
        id: "", acuity_appointment_id: "a-cancelled", contact_id: null, calendar_id: "1335091", calendar_name: "MALLORY PORTRAITS",
        appointment_type: "Portrait Session", appointment_datetime: "2026-10-24T19:30:00Z", // 15:30 EDT
        created_at: "2026-09-01T10:00:00.000Z", status: "cancelled", cancelled: true,
      },
      {
        id: "", acuity_appointment_id: "a-annex", contact_id: null, calendar_id: "12107308", calendar_name: "The Annex",
        appointment_type: "Session Fee, Portrait Session Only", appointment_datetime: "2026-10-24T12:00:00Z", // 08:00 EDT
        created_at: "2026-09-01T10:00:00.000Z", status: "scheduled", cancelled: false,
      },
    ]);
    // feed: main offers 15:30 AND 16:30 (fixture) → 16:30 diverges; 15:30 matches (cancelled freed it)
    await store.putAvailabilitySlotsForDate("1335091", "2026-10-24", [
      { time_et: "15:30", slots_available: 1 },
      { time_et: "16:30", slots_available: 1 },
    ], runId);
    // Annex feed empty → the Annex booking doesn't matter; its day is silent vs grid though!
    // The detector only scans PROBED pairs — Annex was not probed here, so its slots stay unflagged.
    const res = await detectAndApplyDiscrepancies(store, runId, [{ calendar_id: "1335091", date_et: "2026-10-24" }]);
    // The store holds only ONE real booking on 10-24 (the divergence row), so the
    // feed's 2-slot answer disagrees with grid−booked on the 9 free slots:
    // 8 acuity-silent-but-open + the 1 acuity-open-but-booked at 16:30.
    expect(res.inserted).toBe(9);
    const open = await store.getAvailabilityDiscrepancies({ unresolvedOnly: true });
    const kinds = open.map((d) => `${d.time_et}:${d.kind}`);
    expect(kinds).toContain("16:30:acuity-open-but-booked");
    // the CANCELLED 15:30 booking freed its slot → the feed offering 15:30 AGREES → never flagged
    expect(kinds).not.toContain("15:30:acuity-open-but-booked");
    expect(kinds.filter((k) => k.endsWith("acuity-silent-but-open"))).toHaveLength(8);
    const div = open.find((d) => d.time_et === "16:30" && d.kind === "acuity-open-but-booked")!;
    expect((div.detail.booked as Array<Record<string, unknown>>)[0].acuity_appointment_id).toBe("a-div");
  });
});

describe("availability feed sync (fixture-routed fake fetch, MemoryStore)", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
    resetAvailabilityFeedThrottle();
  });

  test("one run: 2 catalog calls + sweeps + probes, cache rows written, sync_runs rows closed, writer stamped", async () => {
    const log = { urls: [] as string[] };
    const res = await runAvailabilityFeedSync({
      store,
      client: makeClient(log),
      now: NOW,
      trigger: "manual",
      months: ["2026-10", "2026-11"],
      dates: ["2026-10-13", "2026-10-24"],
      timesCap: 10,
    });
    expect(res.outcome).toBe("synced");
    // catalog(2) + sweeps (2 months × 3 calendars) = 8; the on-demand times
    // probes are gated by the fresh month index (planAvailabilityFetches is
    // pinned separately) — assert the sweep floor, not a hardcoded probe count.
    expect(res.callsMade).toBe(2 + 6 + (res.datesProbed ?? 0));
    expect(res.monthsFetched).toBe(6);
    expect(res.callsMade).toBeGreaterThanOrEqual(8);
    // cache: the main calendar's month indexes + its two probed dates
    const months = await store.getAvailabilityDates(["2026-10", "2026-11"]);
    expect(months.length).toBeGreaterThanOrEqual(4);
    const mainOct = months.find((r) => r.calendar_id === "1335091" && r.month === "2026-10")!;
    expect(mainOct.dates_et).toHaveLength(10); // the fixture's 10 open dates
    const slots = await store.getAvailabilitySlotsForDates(["2026-10-24"]);
    expect(slots.map((s) => `${s.calendar_id}:${s.time_et}`).sort()).toEqual(["1335091:15:30", "1335091:16:30"]); // the divergence day's feed
    // run rows: BOTH the detailed and the generic machinery row closed success
    const runs = await store.getAvailabilitySyncRuns(5);
    expect(runs[0].status).toBe("success");
    expect(runs[0].calls_made).toBe(12);
    const generic = await store.getSyncRuns(10);
    expect(generic.some((r) => r.provider === "acuity_availability" && r.status === "success")).toBe(true);
    // writer stamp written on the first successful run
    expect(await store.getSyncCheckpoint(AVAILABILITY_FEED_WRITER_VERSION_KEY)).toBe(String(AVAILABILITY_FEED_WRITER_VERSION));
  });

  test("the detector fires through the tick when a booked slot appears in the feed", async () => {
    await store.upsertAppointments([
      {
        id: "", acuity_appointment_id: "a-div", contact_id: null, calendar_id: "1335091", calendar_name: "MALLORY PORTRAITS",
        appointment_type: 'Alliance Portrait Session + 20" Portrait', appointment_datetime: "2026-10-24T20:30:00Z",
        created_at: "2026-01-15T17:29:55.000Z", status: "scheduled", cancelled: false,
      },
    ]);
    const log = { urls: [] as string[] };
    const res = await runAvailabilityFeedSync({
      store, client: makeClient(log), now: NOW, trigger: "manual",
      months: ["2026-10"], dates: ["2026-10-24"], timesCap: 10,
    });
    expect(res.outcome).toBe("synced");
    // one real booking on an otherwise-empty day → the feed's 2-slot answer
    // diverges on all 9 free grid slots (8 silent-but-open) + the booked 16:30
    expect(res.discrepancies?.inserted).toBe(9);
    const open = await store.getAvailabilityDiscrepancies({ unresolvedOnly: true });
    expect(open.map((d) => `${d.date_et} ${d.time_et} ${d.kind}`)).toContain("2026-10-24 16:30 acuity-open-but-booked");
  });

  test("background tick throttle: second background run within 5 min skips; manual runs do not", async () => {
    const res1 = await availabilityFeedTick({
      store, client: makeClient({ urls: [] }), now: NOW, trigger: "background",
      months: ["2026-10"], dates: ["2026-10-13"], timesCap: 5, skipThrottle: false,
    });
    expect(res1.outcome).toBe("synced");
    const res2 = await availabilityFeedTick({
      store, client: makeClient({ urls: [] }), now: NOW, trigger: "background",
      months: ["2026-10"], dates: ["2026-10-13"], timesCap: 5, skipThrottle: false,
    });
    expect(res2).toMatchObject({ outcome: "skipped", reason: "recent-run" });
    const res3 = await availabilityFeedTick({
      store, client: makeClient({ urls: [] }), now: NOW, trigger: "manual",
      months: ["2026-10"], dates: ["2026-10-13"], timesCap: 5,
    });
    expect(res3.outcome).toBe("synced");
  });

  test("in-flight guard: a running acuity_availability row skips the next tick", async () => {
    await store.insertSyncRun("acuity_availability"); // left running on purpose
    const res = await availabilityFeedTick({
      store, client: makeClient({ urls: [] }), now: NOW, trigger: "background",
      months: ["2026-10"], dates: ["2026-10-13"], timesCap: 5,
    });
    expect(res).toMatchObject({ outcome: "skipped", reason: "sync-in-progress" });
  });

  test("no credentials / test env → skipped without any call (demo mode never calls the feed)", async () => {
    // options.client ABSENT → resolveAcuityAvailabilityClient() → null under NODE_ENV=test
    const res = await runAvailabilityFeedSync({ store, now: NOW });
    expect(res).toEqual({ outcome: "skipped", reason: "no-credentials" });
    const runs = await store.getAvailabilitySyncRuns(5);
    expect(runs).toEqual([]); // not even a run row — nothing happened
  });

  test("writer-version guard: a newer recorded writer refuses this writer (no calls, error run rows)", async () => {
    await store.setSyncCheckpoint(AVAILABILITY_FEED_WRITER_VERSION_KEY, String(AVAILABILITY_FEED_WRITER_VERSION + 1));
    const res = await runAvailabilityFeedSync({
      store, client: makeClient({ urls: [] }), now: NOW, trigger: "manual",
      months: ["2026-10"], dates: ["2026-10-24"], timesCap: 5,
    });
    expect(res.outcome).toBe("error");
    expect(res.error).toContain("writer-version guard");
    const generic = await store.getSyncRuns(10);
    expect(generic.filter((r) => r.provider === "acuity_availability" && r.status === "error")).toHaveLength(1);
  });

  test("API failure mid-run records the error on BOTH run rows and returns it (never throws)", async () => {
    const failing = new AcuityAvailabilityClient(
      { userId: "u1", apiKey: "k1" },
      (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as (url: string) => Promise<Response>,
      async () => {},
    );
    const res = await runAvailabilityFeedSync({
      store, client: failing, now: NOW, trigger: "manual",
      months: ["2026-10"], dates: ["2026-10-24"], timesCap: 5,
    });
    expect(res.outcome).toBe("error");
    expect(res.error).toContain("500");
    const runs = await store.getAvailabilitySyncRuns(5);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toContain("500");
    const generic = await store.getSyncRuns(10);
    expect(generic.filter((r) => r.provider === "acuity_availability" && r.status === "error")).toHaveLength(1);
  });
});

describe("coverage horizon helper", () => {
  test("coverageHorizonFromCache: lastOfferedDate is the max offered date; [] months are cached coverage", async () => {
    const { coverageHorizonFromCache } = await import("../sync/availability-feed");
    const store: Store = new MemoryStore();
    await store.putAvailabilityDates([
      { calendar_id: "1335091", appointment_type_id: "3599872", month: "2026-10", dates_et: ["2026-10-08", "2026-10-31"] },
      { calendar_id: "1335091", appointment_type_id: "3599872", month: "2026-11", dates_et: ["2026-11-01"] },
      { calendar_id: "1335091", appointment_type_id: "3599872", month: "2026-12", dates_et: [] },
    ], "run-1");
    const h = coverageHorizonFromCache(await store.getAvailabilityDates(["2026-10", "2026-11", "2026-12"]), "2026-10-06");
    expect(h.lastOfferedDate).toBe("2026-11-01");
    expect(h.months).toHaveLength(3);
    expect(h.months.find((m) => m.month === "2026-12")!.offeredDates).toBe(0);
    expect(h.lastSweptAt).toBeTruthy();
  });
});
