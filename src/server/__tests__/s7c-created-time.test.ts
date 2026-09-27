/**
 * S7c — AUTHORITATIVE CREATION TIMESTAMP + CORRECTED BUSINESS DATES
 * (owner directive 2026-09-28; supersedes the date-only handling).
 *
 * Pins:
 *  1. datetimeCreated (ISO 8601 with stated offset) is the authoritative
 *     creation instant — created_at respects the offset; the original string
 *     is preserved; precision "full"; created_business_date = the instant in
 *     America/New_York.
 *  2. The ~11 PM–midnight EDGE: Acuity's stated offsets are FIXED (-0500/-0600)
 *     while ET is DST-aware. "2026-09-21T23:30:00-0500" = 04:30Z = 00:30 EDT
 *     Sep 22 → created_business_date 2026-09-22 (one day LATER than the stated
 *     local date) — instant→ET is the rule, not an error.
 *  3. DST winter case: "-0500" IS ET in January, so 23:30 stays on its date.
 *  4. Date-only fallback: dateCreated is parsed AS A CALENDAR DATE (never
 *     UTC-converted) — created_business_date = 2026-09-21, precision
 *     "date_only", created_at = the documented midnight-UTC display encoding.
 *  5. Metric bucketing reads created_business_date (filter + count + trends).
 *  6. Engine window = [created_business_date − 1, created_business_date].
 *  7. FULL provider object flows to the store row (raw forensics gap closed).
 */
import { describe, expect, test } from "bun:test";
import {
  parseAcuityAppointment,
  parseAcuityDateCreatedCalendar,
} from "../sync/acuity-live";
import { normalizePgBusinessDate } from "../store/pg";
import {
  attributionWindowDates,
  bookingCreationDateEt,
  matchAppointmentsToCalls,
  type AttributionCall,
} from "../metrics/attribution";
import {
  countBookingsCreatedBetween,
  filterApptsCreatedInEtRange,
  type AppointmentRow,
  type AttributionRow,
} from "../metrics/compute";

const FULL_ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "1775101731",
  datetime: "2026-10-07T20:30:00-0400",
  datetimeCreated: "2026-09-21T11:27:31-0500",
  dateCreated: "September 21, 2026",
  calendarID: "10283642",
  calendar: "MALLORY PORTRAITS",
  calendarTimezone: "America/New_York",
  type: "Family Portrait Session",
  duration: 60,
  canceled: false,
  firstName: "Jane",
  lastName: "Doe",
  phone: "(917) 555-0142",
  email: "jane@example.com",
  ...over,
});

describe("S7c: datetimeCreated parsing (both offsets)", () => {
  test("-0500 offset → true UTC instant + ET business date, precision full, source kept", () => {
    const parsed = parseAcuityAppointment(FULL_ROW({}));
    expect(parsed).not.toBeNull();
    // 11:27:31 at stated -0500 → 16:27:31Z (the stated offset decides)
    expect(parsed!.createdAt).toBe("2026-09-21T16:27:31.000Z");
    expect(parsed!.createdAtBusinessDate).toBe("2026-09-21"); // 12:27 PM EDT
    expect(parsed!.createdTimeSource).toBe("2026-09-21T11:27:31-0500");
    expect(parsed!.createdTimePrecision).toBe("full");
    // forensics: the FULL provider object is carried to the store row
    expect(parsed!.raw).toBeTruthy();
    expect((parsed!.raw as Record<string, unknown>).datetimeCreated).toBe("2026-09-21T11:27:31-0500");
  });

  test("evening booking crosses into the next ET day when the stated offset is fixed -0500 during EDT", () => {
    const parsed = parseAcuityAppointment(FULL_ROW({ datetimeCreated: "2026-09-21T23:30:00-0500" }));
    // 23:30 -0500 = 04:30Z Sep 22 → EDT 00:30 Sep 22
    expect(parsed!.createdAt).toBe("2026-09-22T04:30:00.000Z");
    expect(parsed!.createdAtBusinessDate).toBe("2026-09-22");
  });

  test("-0600 offset row: instant + ET date (DST-aware conversion)", () => {
    const parsed = parseAcuityAppointment(FULL_ROW({ datetimeCreated: "2026-09-21T21:30:00-0600" }));
    // 21:30 at -0600 → 03:30Z Sep 22 → EDT 23:30 Sep 21
    expect(parsed!.createdAt).toBe("2026-09-22T03:30:00.000Z");
    expect(parsed!.createdAtBusinessDate).toBe("2026-09-21");
    expect(parsed!.createdTimePrecision).toBe("full");
  });

  test("winter (EST) row: stated -0500 equals ET, midnight edge keeps the same date", () => {
    const parsed = parseAcuityAppointment(FULL_ROW({ datetimeCreated: "2026-01-15T23:30:00-0500" }));
    expect(parsed!.createdAt).toBe("2026-01-16T04:30:00.000Z");
    expect(parsed!.createdAtBusinessDate).toBe("2026-01-15"); // 23:30 EST
  });
});

describe("S7c: date-only fallback parses dateCreated AS A CALENDAR DATE", () => {
  test("'September 21, 2026' → 2026-09-21 (no month-name or TZ guessing errors)", () => {
    expect(parseAcuityDateCreatedCalendar("September 21, 2026")).toBe("2026-09-21");
    expect(parseAcuityDateCreatedCalendar("Sep 1, 2026")).toBe("2026-09-01");
    expect(parseAcuityDateCreatedCalendar("2026-09-21")).toBe("2026-09-21");
    expect(parseAcuityDateCreatedCalendar("not a date")).toBe(null);
  });

  test("date-only row: business date is the CALENDAR DATE, never UTC-shifted to Sep 20", () => {
    const parsed = parseAcuityAppointment(
      FULL_ROW({ datetimeCreated: undefined, dateCreated: "September 21, 2026" }),
    );
    expect(parsed).not.toBe(null);
    expect(parsed!.createdAtBusinessDate).toBe("2026-09-21"); // NOT 2026-09-20
    expect(parsed!.createdAt).toBe("2026-09-21T00:00:00.000Z"); // documented display encoding
    expect(parsed!.createdTimeSource).toBe("September 21, 2026");
    expect(parsed!.createdTimePrecision).toBe("date_only");
  });

  test("neither datetimeCreated nor dateCreated → session fallback, precision marked, never 'full'", () => {
    const parsed = parseAcuityAppointment(
      FULL_ROW({ datetimeCreated: undefined, dateCreated: undefined }),
    );
    expect(parsed).not.toBe(null);
    expect(parsed!.createdTimePrecision).toBe("session_fallback");
    expect(parsed!.canceledAndFallbackCreated).toBe(true);
  });
});

describe("S7c: metric bucketing on created_business_date", () => {
  const cbd = (id: string, date: string, cancelled = false): AppointmentRow => ({
    id,
    contact_id: "k1",
    calendar_id: "c",
    appointment_type: "t",
    appointment_datetime: "2026-10-01T14:00:00.000Z",
    created_at: "2026-09-21T16:00:00.000Z",
    created_business_date: date,
    status: cancelled ? "cancelled" : "scheduled",
    cancelled,
  });

  test("countBookingsCreatedBetween uses ET business dates (63-shape, not the old 48)", () => {
    // A booking created 2026-09-21T16:27Z (= Sep 21 ET) previously bucketed to
    // Sep 20 via midnight-UTC ET conversion — now its business date decides.
    const rows = [cbd("a", "2026-09-21"), cbd("b", "2026-09-25"), cbd("c", "2026-09-20"), cbd("x", "2026-09-21", true)];
    expect(countBookingsCreatedBetween(rows, "2026-09-21", "2026-09-25")).toBe(2);
    expect(countBookingsCreatedBetween(rows, "2026-09-21", "2026-09-25")).not.toBe(3);
    expect(countBookingsCreatedBetween(rows, "", "9999")).toBe(3); // cancelled row never counts
  });

  test("the 11 PM edge booking buckets on the LATER ET date (instant→ET rule)", () => {
    // stated 2026-09-21T23:30:00-0500 → ET Sep 22 → daily bucket Sep 22
    const rows = [cbd("edge", "2026-09-22")];
    expect(countBookingsCreatedBetween(rows, "2026-09-21", "2026-09-21")).toBe(0);
    expect(countBookingsCreatedBetween(rows, "2026-09-22", "2026-09-22")).toBe(1);
  });

  test("filterApptsCreatedInEtRange is inclusive both ends and drops rows without a business date", () => {
    const rows = [
      { ...cbd("in", "2026-09-24") },
      { ...cbd("edge-in", "2026-09-25") },
      { ...cbd("before", "2026-09-23") },
      { ...cbd("after", "2026-09-26") },
      { ...cbd("no-date", "2026-09-24"), created_business_date: null },
    ];
    expect(filterApptsCreatedInEtRange(rows, "2026-09-24", "2026-09-25").map((a) => a.id)).toEqual(["in", "edge-in"]);
  });
});

describe("S7c: attribution engine window = [created_business_date − 1, created_business_date]", () => {
  test("business date anchors the window exactly", () => {
    const anchor = bookingCreationDateEt({
      created_at: "2026-09-21T16:27:31.000Z",
      created_business_date: "2026-09-21",
      appointment_datetime: "2026-10-07T20:30:00.000Z",
    });
    expect(anchor).toEqual({ date: "2026-09-21", anchoredOn: "created_business_date" });
    expect(attributionWindowDates("2026-09-21")).toEqual({ from: "2026-09-20", to: "2026-09-21" });
  });

  test("legacy rows without the column keep the pre-S7c anchor logic", () => {
    expect(bookingCreationDateEt({ created_at: "2026-09-21T00:00:00.000Z" })).toEqual({
      date: "2026-09-21",
      anchoredOn: "created_at",
    });
    expect(bookingCreationDateEt({ created_at: "2026-09-21T16:27:31.000Z" })).toEqual({
      date: "2026-09-21",
      anchoredOn: "created_at",
    });
  });

  const call = (id: string, startedAt: string, dur = 300): AttributionCall => ({
    id,
    external_call_id: id,
    rep_id: "r1",
    contact_id: "k1",
    started_at: startedAt,
    duration_seconds: dur,
  });
  const appt = (over: Partial<AppointmentRow>): AppointmentRow => ({
    id: "a1",
    contact_id: "k1",
    calendar_id: "c",
    appointment_type: "t",
    appointment_datetime: "2026-10-07T20:30:00.000Z",
    created_at: "2026-09-21T16:27:31.000Z",
    created_business_date: "2026-09-21",
    status: "scheduled",
    cancelled: false,
    ...over,
  });

  test("window is [cbd−1, cbd]: call on the day BEFORE the stated-date window enters", () => {
    // OLD (midnight-UTC ET-date) window for this row was Sep 19..20; the
    // corrected business date 2026-09-21 opens Sep 20..21 — a Sep 21 call now
    // qualifies.
    const matches = matchAppointmentsToCalls(
      [appt({ created_business_date: "2026-09-21" })],
      [call("c-21", "2026-09-21T14:00:00.000Z")], // Sep 21 10:00 EDT
      [{ id: "k1", phone: null, email: null }],
      { meeting_threshold_seconds: 120, attribution_window_hours: 24 },
      { users: [{ id: "r1", is_active: true }] },
    );
    expect(matches[0].status).toBe("attributed");
    expect(matches[0].window?.from).toBe("2026-09-20");
    expect(matches[0].window?.to).toBe("2026-09-21");
  });

  test("call BEFORE cbd−1 never qualifies (window shifted, not widened)", () => {
    const matches = matchAppointmentsToCalls(
      [appt({ created_business_date: "2026-09-21" })],
      [call("c-old", "2026-09-19T14:00:00.000Z")],
      [{ id: "k1", phone: null, email: null }],
      { meeting_threshold_seconds: 120, attribution_window_hours: 24 },
      { users: [{ id: "r1", is_active: true }] },
    );
    expect(matches[0].status).toBe("unattributed");
  });

  test("attribution rows still classify into the three-way split after re-derivation", () => {
    const rows: AttributionRow[] = [
      { id: "a1", appointment_id: "x1", call_id: "c1", rep_id: "r1", method: "contact_id", confidence: 1, manual_override: false },
      { id: "a2", appointment_id: "x2", call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false, note: "ambiguous — phone matches 2 distinct contacts" },
      { id: "a3", appointment_id: "x3", call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false, note: "no-qualifying-call" },
    ];
    const attributed = rows.filter((r) => r.rep_id).length;
    const ambiguous = rows.filter((r) => !r.rep_id && (r.note ?? "").startsWith("ambiguous")).length;
    expect(attributed + ambiguous + (rows.length - attributed - ambiguous)).toBe(3);
  });

  test("pg business-date normalization: postgres.js Date → YYYY-MM-DD, never 'Tue Sep 08'", () => {
    // pg `date` columns arrive as JS Dates (UTC midnight). String(Date).slice(0,10)
    // yields "Tue Sep 08" and silently breaks every DATE_ONLY_RE consumer.
    expect(normalizePgBusinessDate(new Date("2026-09-08T00:00:00.000Z"))).toBe("2026-09-08");
    expect(normalizePgBusinessDate(new Date("2025-11-21T00:00:00.000Z"))).toBe("2025-11-21");
    expect(normalizePgBusinessDate("2026-09-08")).toBe("2026-09-08");
    expect(normalizePgBusinessDate("2026-09-08T00:00:00.000Z")).toBe("2026-09-08");
    expect(normalizePgBusinessDate(null)).toBeNull();
    expect(normalizePgBusinessDate(undefined)).toBeNull();
    expect(normalizePgBusinessDate("")).toBeNull();
    expect(normalizePgBusinessDate("Tue Sep 08 2026 00:00:00 GMT+0000")).toBeNull();
    expect(normalizePgBusinessDate(new Date("not a date"))).toBeNull();
  });
});
