/**
 * QA PHASE 3 — §26 divergence split (display-only): unit tests for
 * buildAttributionDriftFlags — the pure classifier behind the validation
 * page's "Cancelled after close" vs "Attribution evidence restored — source
 * intact" buckets + the W1 explanatory banner. No data is rewritten anywhere.
 */
import { describe, expect, test } from "bun:test";
import { buildAttributionDriftFlags, type DriftedWinFlag } from "../page-data";
import type { AppointmentRow } from "../store/types";
import type { AttributionRow, CallRow, CommissionWeeklyRow } from "../store/types";

const CALC = "2026-10-02T22:26:31.000Z";
const WIPE = "2026-10-07T19:30:54.754Z";

function storedRow(over: Partial<CommissionWeeklyRow> = {}): CommissionWeeklyRow {
  return {
    id: "rec1",
    user_id: "u-allison",
    rep_name: "Allison Wittner",
    week_start: "2026-08-31",
    week_end: "2026-09-06",
    qualifying_bookings: 49,
    counted_bookings: [],
    calc_date: CALC,
    ...over,
  } as unknown as CommissionWeeklyRow;
}

function appt(over: Partial<AppointmentRow> = {}): AppointmentRow {
  return {
    id: "appt1",
    contact_id: null,
    calendar_id: null,
    appointment_type: "Studio Session",
    appointment_datetime: "2026-09-09T18:00:00.000Z",
    created_at: "2026-08-31T19:00:00.000Z",
    status: "completed",
    cancelled: false,
    created_business_date: "2026-08-31",
    ...over,
  } as unknown as AppointmentRow;
}

function attr(over: Partial<AttributionRow> = {}): AttributionRow {
  return {
    id: "a1",
    appointment_id: "appt1",
    call_id: null,
    rep_id: null,
    method: "none",
    confidence: 0,
    manual_override: false,
    ...over,
  };
}

function call(over: Partial<CallRow> = {}): CallRow {
  return {
    id: "c1",
    rep_id: "u-allison",
    contact_id: null,
    started_at: "2026-08-31T18:55:00.000Z", // 14:55 ET on 08-31
    duration_seconds: 60,
    over_two_minutes: false,
    ...over,
  } as unknown as CallRow;
}

const ACTIVE = new Set(["u-allison"]);

function classify(
  stored: CommissionWeeklyRow[],
  appts: AppointmentRow[],
  attributions: AttributionRow[],
  calls: CallRow[],
  activeRepIds: ReadonlySet<string> = ACTIVE,
): DriftedWinFlag[] {
  return buildAttributionDriftFlags(stored, new Map(appts.map((a) => [a.id, a])), attributions, calls, activeRepIds);
}

describe("buildAttributionDriftFlags (§26 split, display-only)", () => {
  test("classifies a post-close re-derivation with source evidence intact", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "appt1", win_date: "2026-08-31", manual: false, client_name: "Jkeya Lynch", appointment_type: "Studio Session" }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt()],
      [attr({ updated_at: WIPE })],
      [call()],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      appointmentId: "appt1",
      clientName: "Jkeya Lynch",
      repName: "Allison Wittner",
      winDate: "2026-08-31",
      weekStart: "2026-08-31",
      rewrittenAt: WIPE,
      calcDate: CALC,
      createdDate: "2026-08-31",
    });
  });

  test("a call the DAY BEFORE the created date (created-1 window) still counts as source-intact", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "appt1", win_date: "2026-09-01", manual: false }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt({ created_business_date: "2026-09-01" })],
      [attr({ updated_at: WIPE })],
      [call({ started_at: "2026-08-31T15:00:00.000Z" })], // 11:00 ET on 08-31
    );
    expect(out).toHaveLength(1);
  });

  test("cancelled counted bookings are EXCLUDED (they live in the cancelled flag list)", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "appt1", win_date: "2026-08-31", manual: false }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt({ cancelled: true, cancelled_at: "2026-10-06T16:58:00.000Z" })],
      [attr({ updated_at: WIPE })],
      [call()],
    );
    expect(out).toHaveLength(0);
  });

  test("manual counted bookings are EXCLUDED (manual rows survive ticks and agree)", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "appt1", win_date: "2026-08-31", manual: true }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt()],
      [attr({ updated_at: WIPE })],
      [call()],
    );
    expect(out).toHaveLength(0);
  });

  test("a still-attributed row (rep_id set) is NOT a wipe", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "appt1", win_date: "2026-08-31", manual: false }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt()],
      [attr({ rep_id: "u-allison", updated_at: WIPE })],
      [call()],
    );
    expect(out).toHaveLength(0);
  });

  test("an attribution row rewritten BEFORE calc_date is not post-close drift", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "appt1", win_date: "2026-08-31", manual: false }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt()],
      [attr({ updated_at: "2026-10-01T00:00:00.000Z" })],
      [call()],
    );
    expect(out).toHaveLength(0);
  });

  test("no in-window call evidence → NOT claimed as source-intact (never whitewashed)", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "appt1", win_date: "2026-08-31", manual: false }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt()],
      [attr({ updated_at: WIPE })],
      [call({ started_at: "2026-09-20T15:00:00.000Z" })], // outside the created-1..created window
    );
    expect(out).toHaveLength(0);
  });

  test("unknown rewrite time (no updated_at) is never classified as drift", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "appt1", win_date: "2026-08-31", manual: false }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt()],
      [attr({})],
      [call()],
    );
    expect(out).toHaveLength(0);
  });

  test("an appointment row that cannot be found is skipped honestly", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "gone", win_date: "2026-08-31", manual: false }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt()],
      [attr({ appointment_id: "gone", updated_at: WIPE })],
      [call()],
    );
    expect(out).toHaveLength(0);
  });

  test("a non-active roster rep's call does not establish source evidence", () => {
    const out = classify(
      [storedRow({ counted_bookings: [{ id: "appt1", win_date: "2026-08-31", manual: false }] as CommissionWeeklyRow["counted_bookings"] })],
      [appt()],
      [attr({ updated_at: WIPE })],
      [call({ rep_id: "u-inactive" })],
      ACTIVE,
    );
    expect(out).toHaveLength(0);
  });
});
