/**
 * AVAILABILITY REBUILD PR-3 §4 — SYNC PANEL tests (owner spec §1 sync
 * visibility): connected/disconnected, BOTH last-successful-sync rows (the
 * appointment sync + the availability feed), the coverage horizon, and the
 * DISCREPANCY LIST with BOTH sides attached. Resolved discrepancies drop off
 * via the existing resolved_at machinery (the store test covers resolution;
 * here the panel reads unresolvedOnly).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { availabilityPageData } from "../page-data";
import { composeAvailabilitySync, type AvailabilitySyncPanel } from "../availability-view";

const TODAY = "2026-10-06";
const RUN = "run-pr3-sync";

function syncPanelOf(p: Awaited<ReturnType<typeof availabilityPageData>>): AvailabilitySyncPanel {
  return (p.view as { sync: AvailabilitySyncPanel }).sync;
}

describe("composeAvailabilitySync — the panel payload", () => {
  const connection = { connected: true, mode: "live" as const, lastSyncAt: "2026-10-06T21:06:52.000Z", stale: false };
  const feedRuns = [
    {
      id: "r2",
      status: "success",
      scope: { trigger: "manual", months: ["2026-10"], dates: ["2026-10-07"] },
      calls_made: 10,
      started_at: "2026-10-06T21:10:00.000Z",
      finished_at: "2026-10-06T21:10:12.000Z",
      error: null,
    },
    {
      id: "r1",
      status: "error",
      scope: { trigger: "background" },
      calls_made: 2,
      started_at: "2026-10-06T20:00:00.000Z",
      finished_at: "2026-10-06T20:00:03.000Z",
      error: "acuity 500",
    },
  ];
  const discrepancies = [
    {
      id: "d1",
      run_id: RUN,
      calendar_id: "1335091",
      date_et: "2026-10-24",
      time_et: "16:30",
      kind: "acuity-open-but-booked" as const,
      detail: {
        acuity: "open",
        booked: [{ id: "a1", client_name: "Alliance Move", appointment_type: "Alliance Portrait Session", created_at: "2026-10-06T18:27:00.000Z" }],
        grid: "canonical",
      },
      detected_at: "2026-10-06T21:13:00.000Z",
      resolved_at: null,
    },
  ];

  test("both sync rows surface; feed last-success skips the failed run", () => {
    const panel = composeAvailabilitySync({ connection, feedRuns, discrepancies, coverageHorizonDate: "2026-11-01", noFeedData: false });
    expect(panel.connected).toBe(true);
    expect(panel.mode).toBe("live");
    expect(panel.appointmentLastSyncAt).toBe("2026-10-06T21:06:52.000Z"); // the appointment sync row
    expect(panel.feedLastSuccessAt).toBe("2026-10-06T21:10:12.000Z"); // the availability-feed row
    expect(panel.feedRuns).toHaveLength(2);
    expect(panel.feedRuns[0]).toMatchObject({ status: "success", trigger: "manual", callsMade: 10, error: null });
    expect(panel.feedRuns[1]).toMatchObject({ status: "error", trigger: "background", error: "acuity 500" });
    expect(panel.coverageHorizonDate).toBe("2026-11-01");
  });

  test("the discrepancy row carries BOTH sides (the feed's answer AND the booked truth)", () => {
    const panel = composeAvailabilitySync({ connection, feedRuns, discrepancies, coverageHorizonDate: null, noFeedData: false });
    expect(panel.discrepancies.count).toBe(1);
    const row = panel.discrepancies.rows[0];
    expect(row).toMatchObject({
      calendarId: "1335091",
      dateEt: "2026-10-24",
      timeEt: "16:30",
      kind: "acuity-open-but-booked",
      acuitySide: "open",
      grid: "canonical",
    });
    expect(row.bookedCount).toBe(1);
    expect(row.booked[0]).toEqual({ client: "Alliance Move", type: "Alliance Portrait Session", createdAt: "2026-10-06T18:27:00.000Z" });
  });

  test("honest empties: no runs, no discrepancies, no connection", () => {
    const panel = composeAvailabilitySync({
      connection: { connected: false, mode: "disconnected", lastSyncAt: null, stale: false },
      feedRuns: [],
      discrepancies: [],
      coverageHorizonDate: null,
      noFeedData: true,
    });
    expect(panel).toMatchObject({
      connected: false,
      mode: "disconnected",
      appointmentLastSyncAt: null,
      feedLastSuccessAt: null,
      feedRuns: [],
      coverageHorizonDate: null,
      noFeedData: true,
      discrepancies: { count: 0, rows: [] },
    });
  });
});

describe("availabilityPageData view path — the sync panel + push rows from cache reads", () => {
  test("seeded feed run + unresolved discrepancy + catalog surface in the payload; resolved rows drop off", async () => {
    const store = new MemoryStore();
    // the feed's catalog (what the filter options read)
    await store.putAvailabilityCatalog(
      {
        calendars: [{ calendar_id: "1335091", name: "MALLORY PORTRAITS" }],
        types: [{ appointment_type_id: "3599872", name: "Portrait Session", calendar_ids: ["1335091"], duration_minutes: 60 }],
      },
      RUN,
      "2026-10-06T21:00:00.000Z",
    );
    // one successful availability-feed run
    const runId = await store.insertAvailabilitySyncRun({ trigger: "manual", months: ["2026-10"], dates: ["2026-10-07"] });
    await store.finishAvailabilitySyncRun(runId, "success", 10, null);
    // ONE unresolved discrepancy (both sides) + one RESOLVED one (drops off)
    await store.applyAvailabilityDiscrepancies(RUN, [{ calendar_id: "1335091", date_et: "2026-10-24" }], [
      {
        calendar_id: "1335091",
        date_et: "2026-10-24",
        time_et: "16:30",
        kind: "acuity-open-but-booked",
        detail: { acuity: "open", booked: [{ client_name: "Gwen Weitz", appointment_type: "Family Session", created_at: "2026-01-15T00:00:00.000Z" }], grid: "canonical" },
      },
      {
        calendar_id: "1335091",
        date_et: "2026-10-24",
        time_et: "15:30",
        kind: "acuity-silent-but-open",
        detail: { acuity: "silent", booked: [], grid: "canonical" },
      },
    ]);
    // resolve the silent-side row (a later run no longer sees it) — the panel must show only the open-but-booked one
    await store.applyAvailabilityDiscrepancies(RUN, [{ calendar_id: "1335091", date_et: "2026-10-24" }], [
      {
        calendar_id: "1335091",
        date_et: "2026-10-24",
        time_et: "16:30",
        kind: "acuity-open-but-booked",
        detail: { acuity: "open", booked: [{ client_name: "Gwen Weitz", appointment_type: "Family Session", created_at: "2026-01-15T00:00:00.000Z" }], grid: "canonical" },
      },
    ]);

    const data = await availabilityPageData({ store, today: TODAY, view: { view: "days", from: TODAY } });
    const view = data.view as {
      datesToPush: Array<Record<string, unknown>>;
      pushRangeLabel: string;
      filterOptions: { calendars: Array<{ id: string }>; types: unknown[] };
      sync: AvailabilitySyncPanel;
    };

    // sync panel
    expect(view.sync.feedLastSuccessAt).toBeTypeOf("string");
    expect(view.sync.feedRuns[0]).toMatchObject({ status: "success", trigger: "manual", callsMade: 10 });
    expect(view.sync.discrepancies.count).toBe(1); // the resolved silent-side row dropped off
    expect(view.sync.discrepancies.rows[0]).toMatchObject({
      dateEt: "2026-10-24",
      timeEt: "16:30",
      kind: "acuity-open-but-booked",
      acuitySide: "open",
      bookedCount: 1,
    });
    expect(view.sync.discrepancies.rows[0].booked[0]?.client).toBe("Gwen Weitz");

    // filter options from the cached catalog
    expect(view.filterOptions.calendars).toEqual([{ id: "1335091", name: "MALLORY PORTRAITS" }]);
    expect(view.filterOptions.types).toHaveLength(1);

    // push rows: ladder-sorted, each with the §7 column set
    expect(view.pushRangeLabel).toBe("the 14-day window Tue, Oct 6 – Mon, Oct 19, 2026");
    expect(view.datesToPush.length).toBeGreaterThan(0);
    for (const row of view.datesToPush) {
      expect(Object.keys(row).sort()).toEqual(["booked", "capacity", "date", "holes", "label", "openings", "utilization"]);
    }
    for (let i = 1; i < view.datesToPush.length; i += 1) {
      const prev = view.datesToPush[i - 1] as { holes: number };
      const cur = view.datesToPush[i] as { holes: number };
      expect(prev.holes).toBeGreaterThanOrEqual(cur.holes);
    }
  });
});
