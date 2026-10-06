/**
 * CANCELLATION RECONCILIATION tests (owner report 2026-10-06) — fixture-based,
 * NO live API (the adapter is constructed with an injected fetchImpl; the
 * NODE_ENV guard keeps every sync path off the network under the test runner).
 *
 * Pins: the single-appointment GET is THE cancellation truth call (the list
 * endpoint never returns cancelled rows); reconcileCancellations marks
 * confirmed cancellations (write-once cancelled_at, never resurrected by a
 * later upsert); the Booking Win derivation (isBookingWin — RULING 1's
 * cancelled exclusion) honors the flag on the SAME core path; and the
 * closed-vs-open classification of the flag list.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { AcuityLiveAdapter, reconcileCancellations } from "../sync/acuity-live";
import { appointmentIsPaid, filterApptsInWinBucketRange, isBookingWin } from "../metrics/compute";
import { buildCancelledWinFlags } from "../page-data";

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
  phone: "+1 917 555 0142",
  email: "cancel@example.com",
  paid: "yes",
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
const GONE_ID = "9004";
const LIST_RAW = [
  { id: 9002, calendarID: 12345, calendar: "Family Studio", type: "Family Session", datetime: "2026-10-20T14:00:00-0400", datetimeCreated: "2026-09-25T10:00:00-0400", canceled: false, firstName: "Listed", lastName: "Row", email: "listed@example.com" },
];

/** Deterministic fetch: the window list, three single-appointment probes. */
const fakeFetch = async (url: string): Promise<Response> => {
  if (url.includes("/appointments/9001")) return new Response(JSON.stringify(CANCELED_RAW), { status: 200 });
  if (url.includes("/appointments/9003")) return new Response(JSON.stringify(LIVE_MOVED_RAW), { status: 200 });
  if (url.includes(`/appointments/${GONE_ID}`)) return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(LIST_RAW), { status: 200 });
};

const makeAdapter = (): AcuityLiveAdapter =>
  new AcuityLiveAdapter({ userId: "u", apiKey: "k" }, fakeFetch, async () => {});

/** Store-shaped scheduled row (MemoryStore upsert input). */
const scheduledRow = (acuityId: string, sessionIso: string, extra: Record<string, unknown> = {}) => ({
  id: `test-${acuityId}`,
  acuity_appointment_id: acuityId,
  contact_id: null,
  calendar_id: "12345",
  calendar_name: "Family Studio",
  appointment_type: "Family Session",
  appointment_datetime: sessionIso,
  duration_minutes: 60,
  created_at: "2026-09-24T15:00:00.000Z",
  created_business_date: "2026-09-24",
  payment_state: "paid",
  booking_win_business_date: "2026-09-24",
  first_seen_paid_at: "2026-09-24T15:00:00.000Z",
  raw: { paid: "yes" },
  status: "scheduled",
  cancelled: false,
  client_name: "Test Client",
  client_phone: "",
  client_email: "",
  ...extra,
});

const nowIso = "2026-10-06T18:00:00.000Z";
const fixedNow = () => new Date(nowIso);

async function seededStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  // 9001: paid WIN, cancelled upstream → absent from the list → probe → mark.
  // 9002: present in the list → never probed.
  // 9003: absent but LIVE (moved) → refreshed, not marked.
  // 9004: absent and 404 → untouched + counted.
  await store.upsertAppointments([
    scheduledRow("9001", "2026-10-13T20:30:00.000Z"),
    scheduledRow("9002", "2026-10-20T18:00:00.000Z", { booking_win_business_date: null, payment_state: "scheduled", raw: {} }),
    scheduledRow("9003", "2026-10-20T19:00:00.000Z", { booking_win_business_date: null, payment_state: "scheduled", raw: {} }),
    scheduledRow(GONE_ID, "2026-10-27T18:00:00.000Z", { booking_win_business_date: null, payment_state: "scheduled", raw: {} }),
  ]);
  return store;
}

describe("Acuity cancellation reconciliation", () => {
  test("fetchAppointmentById parses canceled:true and returns null on 404", async () => {
    const adapter = makeAdapter();
    const parsed = await adapter.fetchAppointmentById("9001");
    expect(parsed?.cancelled).toBe(true);
    expect(parsed?.acuity_appointment_id).toBe("9001");
    expect(parsed?.status).toBe("cancelled");
    expect(await adapter.fetchAppointmentById(GONE_ID)).toBeNull();
  });

  test("reconcile marks only list-absent rows confirmed cancelled; probes are paced and capped", async () => {
    const store = await seededStore();
    const adapter = makeAdapter();
    const fetched = await adapter.fetchAppointments();
    const report = await reconcileCancellations(store, adapter, fetched, { now: fixedNow, maxProbes: 2 });
    expect(report.candidates).toBe(3); // 9001, 9003, 9004 absent from the list
    expect(report.probed).toBe(2); // capped
    expect(report.capped).toBe(1);
    expect(report.markedCancelled).toBe(1); // 9001 confirmed canceled:true
    expect(report.refreshedMissing).toBe(1); // 9003 came back live (moved)
    expect(report.notFound).toBe(0);
    const rows = await store.getAppointmentsOverlapping("1970-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z");
    const marked = rows.find((a) => a.acuity_appointment_id === "9001");
    expect(marked?.cancelled).toBe(true);
    expect(marked?.status).toBe("cancelled");
    expect(marked?.cancelled_at).toBe(nowIso);
    expect(marked?.cancellation_source).toBe("acuity-reconciliation");
    const listed = rows.find((a) => a.acuity_appointment_id === "9002");
    expect(listed?.cancelled).toBe(false);
    // refreshed row reflects the provider's CURRENT datetime (moved outside the window)
    const moved = rows.find((a) => a.acuity_appointment_id === "9003");
    expect(moved?.appointment_datetime).toBe("2027-01-20T21:30:00.000Z");
    expect(moved?.cancelled).toBe(false);
  });

  test("reconciliation is idempotent — a re-run never re-marks and never moves cancelled_at", async () => {
    const store = await seededStore();
    const adapter = makeAdapter();
    const fetched = await adapter.fetchAppointments();
    await reconcileCancellations(store, adapter, fetched, { now: fixedNow, maxProbes: 300 });
    const second = await reconcileCancellations(store, adapter, fetched, { now: fixedNow, maxProbes: 300 });
    expect(second.candidates).toBe(2); // 9003 (in-window, absent → re-probed) + 9004 (404, never confirmed → probed again)
    expect(second.markedCancelled).toBe(0);
    expect(second.refreshedMissing).toBe(1);
    expect(second.notFound).toBe(1);
    const rows = await store.getAppointmentsOverlapping("1970-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z");
    const marked = rows.find((a) => a.acuity_appointment_id === "9001");
    expect(marked?.cancelled_at).toBe(nowIso); // stamp never moved
  });

  test("a later upsert NEVER resurrects a confirmed cancellation (write-once)", async () => {
    const store = await seededStore();
    const adapter = makeAdapter();
    await reconcileCancellations(store, adapter, await adapter.fetchAppointments(), { now: fixedNow, maxProbes: 300 });
    await store.upsertAppointments([
      scheduledRow("9001", "2026-10-13T20:30:00.000Z", { cancelled: false, status: "scheduled", cancelled_at: null, cancellation_source: null }),
    ]);
    const rows = await store.getAppointmentsOverlapping("1970-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z");
    const marked = rows.find((a) => a.acuity_appointment_id === "9001");
    expect(marked?.cancelled).toBe(true);
    expect(marked?.status).toBe("cancelled");
    expect(marked?.cancelled_at).toBe(nowIso);
  });

  test("RULING 1 exclusion: a confirmed-cancelled paid booking is no longer a Booking Win on the same core path", async () => {
    const store = await seededStore();
    const rowsBefore = filterApptsInWinBucketRange(await store.getAppointmentsByWinBusinessDateBetween("2026-09-24", "2026-09-24"), "2026-09-24", "2026-09-24");
    expect(rowsBefore.filter((a) => isBookingWin(a)).length).toBe(1);
    const adapter = makeAdapter();
    await reconcileCancellations(store, adapter, await adapter.fetchAppointments(), { now: fixedNow, maxProbes: 300 });
    const rowsAfter = filterApptsInWinBucketRange(await store.getAppointmentsByWinBusinessDateBetween("2026-09-24", "2026-09-24"), "2026-09-24", "2026-09-24");
    const wins = rowsAfter.filter((a) => isBookingWin(a));
    expect(wins.length).toBe(0);
    const flagged = rowsAfter.find((a) => a.acuity_appointment_id === "9001");
    expect(flagged).toBeTruthy(); // still returned by the bucket (evidence retained) — excluded by the cancelled predicate
    expect(flagged?.payment_state).toBe("paid"); // win evidence untouched (flag list keeps it visible)
    expect(appointmentIsPaid(flagged!)).toBe(true);
  });
});

describe("Flag-list classification (closed vs open week)", () => {
  test("closed = a week with stored commission records; open = live week (applies at Sunday close)", () => {
    const rows = [
      {
        id: "a", contact_id: null, calendar_id: null, appointment_type: "Animalia Session", appointment_datetime: "2026-10-27T18:00:00.000Z",
        created_at: "2026-09-10T15:00:00.000Z", status: "cancelled", cancelled: true,
        payment_state: "paid", booking_win_business_date: "2026-09-10", cancelled_at: nowIso, cancellation_source: "acuity-reconciliation",
        client_name: "Judith Enstone", acuity_appointment_id: "1769070533",
      },
      {
        id: "b", contact_id: null, calendar_id: null, appointment_type: "Animalia Session", appointment_datetime: "2026-10-14T18:00:00.000Z",
        created_at: "2026-09-30T15:00:00.000Z", status: "cancelled", cancelled: true,
        payment_state: "paid", booking_win_business_date: "2026-09-30", cancelled_at: nowIso, cancellation_source: "acuity-reconciliation",
        client_name: "Michelle Fleck", acuity_appointment_id: "1780529195",
      },
    ] as unknown as Parameters<typeof buildCancelledWinFlags>[0];
    const flags = buildCancelledWinFlags(rows, new Set(["2026-09-07", "2026-09-28"]), () => "Allison Wittner");
    expect(flags.length).toBe(2);
    const judith = flags.find((f) => f.clientName === "Judith Enstone")!;
    expect(judith.winDate).toBe("2026-09-10");
    expect(judith.weekStart).toBe("2026-09-07");
    expect(judith.weekEnd).toBe("2026-09-13");
    expect(judith.weekClosed).toBe(true);
    expect(judith.sessionDate).toBe("2026-10-27");
    expect(judith.repName).toBe("Allison Wittner");
    const michelle = flags.find((f) => f.clientName === "Michelle Fleck")!;
    expect(michelle.weekStart).toBe("2026-09-28");
    expect(michelle.weekClosed).toBe(true);
    // an OPEN week (no stored records) classifies open:
    const open = buildCancelledWinFlags(
      [rows[1]],
      new Set(["2026-09-07"]), // week of 2026-09-28 has NO stored records in this scenario
      () => null,
    );
    expect(open[0].weekClosed).toBe(false);
    expect(open[0].repName).toBeNull();
  });
});
