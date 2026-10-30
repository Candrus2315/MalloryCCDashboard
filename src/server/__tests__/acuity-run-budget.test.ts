/**
 * ACUITY HANG-BOUNDS tests (2026-10-30 wedge fixes #1/#2/#3 — the pass can no
 * longer hang silently; receipts in /home/team/shared/sync-investigation-2026-10-30.md).
 *
 * MemoryStore-based, NO live API (the adapter is constructed with injected
 * fetch/sleep; NODE_ENV keeps every unguarded sync path off the network).
 * Pins:
 *  1. the pacing-sleep CLAMP — a backward wall-clock step (negative sinceLast)
 *     sleeps the ordinary gap, never gapMs + |step|; healthy sleeps unchanged;
 *  2. the PER-RUN WALL-CLOCK BUDGET — a breach finishes the sync_runs row with
 *     the honest "run budget exceeded" error on BOTH entry paths (runProvider's
 *     acuity section + availabilityTick) instead of parking `running` until the
 *     30-min reaper; a healthy short pass never trips it;
 *  3. the PROBE TRAWL budget — reconcileCancellations stops on elapsed probe
 *     time or an aborted run-budget signal, warning + deferring the rest.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { STALE_RUN_REAP_MINUTES, type SyncRunRow } from "../store/types";
import {
  ACUITY_PROBE_BUDGET_MS,
  AcuityLiveAdapter,
  availabilityTick,
  reconcileCancellations,
} from "../sync/acuity-live";
import {
  ACUITY_RUN_BUDGET_MS,
  ACUITY_RUN_BUDGET_ENV,
  AcuityRunBudgetExceededError,
  acuityRunBudgetMs,
  raceAcuityRunBudget,
} from "../sync/acuity-run-budget";
import { runDemoSync } from "../sync/run";
import type { NormalizedAppointment } from "../sync/adapters";

// ---------- fixtures ----------

const CANCELED_RAW = {
  id: 9001,
  calendarID: 12345,
  calendar: "Family Studio",
  type: "Family Session",
  datetime: "2026-10-13T16:30:00-0400",
  datetimeCreated: "2026-09-24T11:00:00-0400",
  canceled: true,
  firstName: "Cancelled",
  lastName: "Win",
  email: "cancel@example.com",
};
const LIVE_MOVED_RAW = {
  id: 9003,
  calendarID: 12345,
  calendar: "Family Studio",
  type: "Family Session",
  datetime: "2027-01-20T16:30:00-0500",
  datetimeCreated: "2026-09-25T10:00:00-0400",
  canceled: false,
  firstName: "Moved",
  lastName: "Out",
  email: "moved@example.com",
};

/** Store-shaped scheduled row (MemoryStore upsert input). */
const scheduledRow = (acuityId: string, sessionIso: string) => ({
  id: `test-${acuityId}`,
  acuity_appointment_id: acuityId,
  contact_id: null,
  calendar_id: "12345",
  calendar_name: "Family Studio",
  appointment_type: "Family Session",
  appointment_datetime: sessionIso,
  duration_minutes: 60,
  created_at: "2026-09-24T15:00:00.000Z",
  status: "scheduled",
  cancelled: false,
  client_name: "Test Client",
  client_phone: "",
  client_email: "",
});

/** Three list-absent probe candidates inside the adapter's pinned window. */
async function seededProbeStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.upsertAppointments([
    scheduledRow("9001", "2026-10-13T20:30:00.000Z"),
    scheduledRow("9003", "2026-10-20T18:00:00.000Z"),
    scheduledRow("9004", "2026-10-27T18:00:00.000Z"),
  ]);
  return store;
}

/** A real adapter over a scripted fetch (no sleep pacing — tests pin timing). */
function probeAdapter(fetchImpl: (url: string) => Promise<Response>): AcuityLiveAdapter {
  const adapter = new AcuityLiveAdapter({ userId: "u", apiKey: "k" }, fetchImpl, async () => {});
  // reconcileCancellations reads the window off the adapter's last run.
  adapter.lastRun = { requests: 0, window: { minDate: "2026-10-01", maxDate: "2026-11-15" }, truncated: false, warnings: [] };
  return adapter;
}

/** Probe fetch mapping for 9001 (canceled), 9003 (live), 9004 (404). */
const probeFetch = async (url: string): Promise<Response> => {
  if (url.includes("/appointments/9001")) return new Response(JSON.stringify(CANCELED_RAW), { status: 200 });
  if (url.includes("/appointments/9003")) return new Response(JSON.stringify(LIVE_MOVED_RAW), { status: 200 });
  return new Response("{}", { status: 404 });
};

/** Stub live adapter that never touches the network; optional hang body. */
function stubAcuity(appts: Promise<NormalizedAppointment[]> | Error): AcuityLiveAdapter {
  return {
    provider: "acuity",
    isDemo: false,
    lastRun: { requests: 1, window: { minDate: "2026-09-27", maxDate: "2026-10-12" }, truncated: false, warnings: [] },
    fetchAppointments: () => (appts instanceof Error ? Promise.reject(appts) : appts),
    fetchBlockedTimes: async () => [],
  } as unknown as AcuityLiveAdapter;
}

/** An adapter whose pass hangs forever — the 19:31:08Z wedge shape. */
const hungAcuity = () => stubAcuity(new Promise<NormalizedAppointment[]>(() => {}));

const acuityRow = (runs: SyncRunRow[]) => runs.find((r) => r.provider === "acuity")!;

/** Set + restore the run-budget env override around one test. */
function withBudgetEnv(ms: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[ACUITY_RUN_BUDGET_ENV];
  process.env[ACUITY_RUN_BUDGET_ENV] = ms;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[ACUITY_RUN_BUDGET_ENV];
    else process.env[ACUITY_RUN_BUDGET_ENV] = prev;
  });
}

// ---------- fix #1: the pacing-sleep clamp ----------

describe("pacing sleep clamp (fix #1 — negative sinceLast after a backward clock step)", () => {
  const realNow = Date.now;

  test("a 12-minute backward clock step sleeps the ordinary gap — never gapMs + |step|", async () => {
    let clockMs = 1_000_000;
    Date.now = () => clockMs; // deterministic clock: advances only when this test advances it
    const sleeps: number[] = [];
    const adapter = new AcuityLiveAdapter(
      { userId: "u", apiKey: "k" },
      async () => new Response("[]", { status: 200 }),
      async (ms) => { sleeps.push(ms); },
    );
    try {
      await adapter.fetchAppointmentById("1"); // first request: lastRequestAt=0 → no pacing sleep
      expect(sleeps).toEqual([]);
      clockMs -= 12 * 60_000; // the NTP-correction / host-resume signature
      await adapter.fetchAppointmentById("2");
      // OLD behavior: sleep(1_100 + 720_000) — a silent ~13-min park BEFORE the
      // first request (the 19:31:08Z pass). NEW: clamped to the ordinary gap.
      expect(sleeps).toEqual([1_100]);
    } finally {
      Date.now = realNow;
    }
  });

  test("healthy path byte-identical: in-gap sleeps exactly gapMs - sinceLast; past the gap, none", async () => {
    let clockMs = 1_000_000;
    Date.now = () => clockMs;
    const sleeps: number[] = [];
    const adapter = new AcuityLiveAdapter(
      { userId: "u", apiKey: "k" },
      async () => new Response("[]", { status: 200 }),
      async (ms) => { sleeps.push(ms); },
    );
    try {
      await adapter.fetchAppointmentById("1");
      clockMs += 300; // 300ms since the last request
      await adapter.fetchAppointmentById("2");
      expect(sleeps).toEqual([800]); // 1100 - 300 — the exact old formula
      clockMs += 2500; // past the gap
      await adapter.fetchAppointmentById("3");
      expect(sleeps).toEqual([800]); // no new sleep
    } finally {
      Date.now = realNow;
    }
  });
});

// ---------- fix #2: the per-run wall-clock budget ----------

describe("per-run wall-clock budget (fix #2)", () => {
  test("the named default is 25 min and sits safely under the 30-min reap window", () => {
    expect(ACUITY_RUN_BUDGET_MS).toBe(25 * 60_000);
    expect(ACUITY_RUN_BUDGET_MS).toBeLessThan(STALE_RUN_REAP_MINUTES * 60_000);
  });

  test("breach rejects with the honest error and aborts the budget signal", async () => {
    let signal!: AbortSignal;
    let err: unknown;
    try {
      await raceAcuityRunBudget(
        async (budget) => {
          signal = budget.signal;
          await new Promise(() => {}); // the hung-pass shape: never settles
        },
        { budgetMs: 20 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AcuityRunBudgetExceededError);
    expect((err as Error).message).toContain("run budget exceeded");
    expect(signal.aborted).toBe(true);
  });

  test("healthy short pass: resolves, budget never trips, signal never aborted", async () => {
    let signal!: AbortSignal;
    const out = await raceAcuityRunBudget(
      async (budget) => {
        signal = budget.signal;
        return 7;
      },
      { budgetMs: 20 },
    );
    expect(out).toBe(7);
    expect(signal.aborted).toBe(false);
  });

  test("ACUITY_RUN_BUDGET_MS env override applies; invalid values fall back to the default", () => {
    const prev = process.env[ACUITY_RUN_BUDGET_ENV];
    try {
      process.env[ACUITY_RUN_BUDGET_ENV] = "1234";
      expect(acuityRunBudgetMs()).toBe(1234);
      process.env[ACUITY_RUN_BUDGET_ENV] = "junk";
      expect(acuityRunBudgetMs()).toBe(ACUITY_RUN_BUDGET_MS);
      process.env[ACUITY_RUN_BUDGET_ENV] = "-5";
      expect(acuityRunBudgetMs()).toBe(ACUITY_RUN_BUDGET_MS);
      delete process.env[ACUITY_RUN_BUDGET_ENV];
      expect(acuityRunBudgetMs()).toBe(ACUITY_RUN_BUDGET_MS);
    } finally {
      if (prev === undefined) delete process.env[ACUITY_RUN_BUDGET_ENV];
      else process.env[ACUITY_RUN_BUDGET_ENV] = prev;
    }
  });
});

describe("entry path A — runProvider's acuity section (run.ts)", () => {
  test("budget breach → the run finishes with an honest error row, NOT parked 'running'", async () =>
    withBudgetEnv("30", async () => {
      const store = new MemoryStore();
      const res = await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null, acuityAdapter: hungAcuity() });
      const acuity = res.providers.find((p) => p.provider === "acuity")!;
      expect(acuity.error).toContain("run budget exceeded");
      const row = acuityRow(await store.getSyncRuns(20));
      expect(row.status).toBe("error");
      expect(row.error).toContain("run budget exceeded");
      expect(row.records_upserted).toBe(0);
      expect(await store.getRunningSyncRun("acuity")).toBeNull(); // not parked; background passes resume immediately
    }));

  test("healthy short pass unchanged: success row, no budget trip, downstream providers still run", async () => {
    const store = new MemoryStore();
    const res = await runDemoSync({
      store,
      sheetsAdapter: null,
      highlevelAdapter: null,
      acuityAdapter: stubAcuity(Promise.resolve([])),
    });
    const acuity = res.providers.find((p) => p.provider === "acuity")!;
    expect(acuity.error).toBeNull();
    expect(acuityRow(await store.getSyncRuns(20)).status).toBe("success");
    expect(res.providers.map((p) => p.provider)).toContain("google_sheets");
  });
});

describe("entry path B — availabilityTick (acuity-live.ts)", () => {
  test("budget breach → tick error, row finished 'error', not parked 'running'", async () =>
    withBudgetEnv("30", async () => {
      const store = new MemoryStore();
      const res = await availabilityTick({ store, adapter: hungAcuity() });
      expect(res.outcome).toBe("error");
      expect(res.error).toContain("run budget exceeded");
      const row = acuityRow(await store.getSyncRuns(10));
      expect(row.status).toBe("error");
      expect(row.error).toContain("run budget exceeded");
      expect(await store.getRunningSyncRun("acuity")).toBeNull();
      // the connection row records the same honest error
      const conn = (await store.getConnections()).find((c) => c.provider === "acuity");
      expect(conn?.status).toBe("error");
      expect(conn?.last_error).toContain("run budget exceeded");
    }));

  test("healthy short pass unchanged: 'synced' with the DEFAULT 25-min budget", async () => {
    const store = new MemoryStore();
    const appt: NormalizedAppointment = {
      acuity_appointment_id: "live-3",
      calendarId: "12345",
      calendarName: "Family Studio",
      appointmentType: "Family Session",
      appointmentDatetime: "2026-09-28T14:00:00.000Z",
      createdAt: "2026-09-20T15:00:00.000Z",
      status: "scheduled",
      cancelled: false,
      clientName: "Jane Doe",
      clientPhone: "+19175550142",
      clientEmail: "jane@example.com",
      durationMinutes: 60,
    };
    const res = await availabilityTick({ store, adapter: stubAcuity(Promise.resolve([appt])) });
    expect(res.outcome).toBe("synced");
    expect(res.appointments).toBe(1);
    expect(acuityRow(await store.getSyncRuns(10)).status).toBe("success");
  });
});

// ---------- fix #3: the probe-trawl total budget ----------

describe("probe trawl total budget (fix #3)", () => {
  const BASE_MS = Date.parse("2026-10-30T12:00:00.000Z");

  test("the probe budget default is 10 min — a healthy full-cap trawl (~5.5 min of pacing) fits", () => {
    expect(ACUITY_PROBE_BUDGET_MS).toBe(10 * 60_000);
    expect(ACUITY_PROBE_BUDGET_MS).toBeLessThan(ACUITY_RUN_BUDGET_MS);
  });

  test("elapsed probe time stops the trawl GRACEFULLY: warned, deferred, run still completes", async () => {
    const store = await seededProbeStore();
    let tMs = BASE_MS;
    const adapter = probeAdapter(async (url) => {
      tMs += 6 * 60_000; // each probe consumes 6 minutes of wall clock (slow/stalled probes)
      return probeFetch(url);
    });
    const report = await reconcileCancellations(store, adapter, [], {
      now: () => new Date(tMs),
      probeBudgetMs: ACUITY_PROBE_BUDGET_MS,
    });
    expect(report.candidates).toBe(3);
    expect(report.probed).toBe(2); // 9001 + 9003 probed before the 10-min budget elapsed
    expect(report.capped).toBe(1); // 9004 left for the next pass
    expect(report.warnings.some((w) => w.includes("probe time budget (10 min) elapsed") && w.includes("1 in-window rows left unprobed"))).toBe(true);
    expect(report.markedCancelled).toBe(1); // the probed cancellation still landed
    expect(report.refreshedMissing).toBe(1);
  });

  test("an aborted run-budget signal stops the trawl BEFORE the first probe", async () => {
    const store = await seededProbeStore();
    const controller = new AbortController();
    controller.abort();
    const adapter = probeAdapter(probeFetch);
    const report = await reconcileCancellations(store, adapter, [], {
      now: () => new Date(BASE_MS),
      budgetSignal: controller.signal,
    });
    expect(report.probed).toBe(0);
    expect(report.capped).toBe(3);
    expect(report.warnings.some((w) => w.includes("run budget exhausted") && w.includes("3 in-window rows left unprobed"))).toBe(true);
    expect(report.markedCancelled).toBe(0);
  });

  test("an IN-FLIGHT probe rejects mid-flight on abort; the trawl then stops cleanly (no hang)", async () => {
    const store = await seededProbeStore();
    const controller = new AbortController();
    let probes = 0;
    const adapter = probeAdapter(async (url) => {
      probes += 1;
      if (url.includes("/appointments/9001")) {
        controller.abort(); // the run budget fires while probe 1 is in flight
        await new Promise((r) => setTimeout(r, 10)); // the underlying request is still pending
        return new Response(JSON.stringify(CANCELED_RAW), { status: 200 });
      }
      return probeFetch(url);
    });
    const report = await reconcileCancellations(store, adapter, [], {
      now: () => new Date(BASE_MS),
      budgetSignal: controller.signal,
    });
    expect(probes).toBe(1); // probe 2 never started (refused before start)
    expect(report.probed).toBe(0); // the aborted probe did not count as answered
    expect(report.capped).toBe(3); // 9001 (attempted, aborted) + 9003 + 9004 all left for the next pass
    expect(report.warnings.some((w) => w.includes("9001") && w.includes("probe aborted mid-flight"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("run budget exhausted") && w.includes("3 in-window rows left unprobed"))).toBe(true);
  });

  test("healthy trawl unchanged: no budget signal, fixed clock → every candidate probed, nothing capped", async () => {
    const store = await seededProbeStore();
    const adapter = probeAdapter(probeFetch);
    const report = await reconcileCancellations(store, adapter, [], { now: () => new Date(BASE_MS) });
    expect(report.candidates).toBe(3);
    expect(report.probed).toBe(3);
    expect(report.capped).toBe(0);
    expect(report.markedCancelled).toBe(1);
    expect(report.refreshedMissing).toBe(1);
    expect(report.notFound).toBe(1);
  });
});
