/**
 * AVAILABILITY FEED — pure detector + fetch-plan tests. Fixtures are the raw
 * 2026-10-06 live-probe snapshots (fixtures/availability-feed/) plus the
 * booked-truth rows observed in the DB for the same days (percal.out).
 * The 2026-10-24 16:30 divergence (§1.5) MUST reproduce here — that case is
 * exactly why the discrepancy detector exists.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAcuityOpenTime, parseAcuityTypeFull } from "../sync/acuity-availability";
import {
  addMonths,
  detectAvailabilityDiscrepancies,
  monthDates,
  monthKeyOf,
  planAvailabilityFetches,
  representativeTypePairs,
  type AcuityCalendarInfo,
  type AcuityTypeFull,
  type AvailabilityDatesRow,
  type AvailabilitySlotRow,
  type CalendarTypePair,
  type DetectorBookedAppt,
} from "../sync/availability-feed";
import { scheduledSlotTimesForDay } from "../commission/derive";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "availability-feed");
const loadFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
const fixtureTimes = (name: string): string[] =>
  ((loadFixture(name) as Record<string, unknown>[]) ?? []).map((r) => parseAcuityOpenTime(r)!.timeEt);

const CALS: AcuityCalendarInfo[] = (loadFixture("calendars.json") as Record<string, unknown>[])
  .map((r) => ({ id: String(r.id), name: String(r.name), timezone: String(r.timezone) }));
const TYPES: AcuityTypeFull[] = (loadFixture("appointment-types.json") as Record<string, unknown>[])
  .map((r) => parseAcuityTypeFull(r)!)
  .filter(Boolean);

/** A non-cancelled booked row on the main calendar at one grid time. */
const bookedRow = (date: string, time: string, overrides?: Partial<DetectorBookedAppt>): DetectorBookedAppt => ({
  id: `appt-${date}-${time.replace(":", "")}`,
  acuity_appointment_id: `${Number(date.replace(/-/g, ""))}${time.replace(":", "")}`,
  client_name: `Client ${date} ${time}`,
  appointment_type: "Portrait Session",
  // 2026-10 is EDT (-04:00): 09:00 ET == 13:00 UTC
  appointment_datetime: `${date}T${time}:00-04:00`,
  cancelled: false,
  status: "scheduled",
  ...overrides,
});

/** The booked set observed in the DB (percal.out) for one probed day, as HH:mm list. */
const BOOKED_1008 = ["09:00", "10:00", "11:00", "12:00", "14:30", "15:30", "16:30", "17:30"];
const BOOKED_1012 = ["09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30"];
const BOOKED_1024 = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "16:30", "17:30"];

describe("discrepancy detector (the owner's equation, pure)", () => {
  test("EXACT day (2026-10-08): Acuity open == grid − booked → zero discrepancies", () => {
    const date = "2026-10-08";
    const grid = scheduledSlotTimesForDay(date);
    expect(grid).toHaveLength(10);
    const booked = BOOKED_1008.map((t) => bookedRow(date, t));
    const out = detectAvailabilityDiscrepancies({
      calendarId: "1335091",
      date,
      gridTimes: grid,
      acuityOpen: fixtureTimes("times-2026-10-08-cal1335091.json"), // 08:00, 13:30
      booked,
    });
    expect(out).toEqual([]);
  });

  test("EXACT day (2026-10-12): open == grid − booked → zero discrepancies", () => {
    const date = "2026-10-12";
    const booked = BOOKED_1012.map((t) => bookedRow(date, t));
    const out = detectAvailabilityDiscrepancies({
      calendarId: "1335091",
      date,
      gridTimes: scheduledSlotTimesForDay(date),
      acuityOpen: fixtureTimes("t2-2026-10-12-main.json"), // 08:00, 17:30
      booked,
    });
    expect(out).toEqual([]);
  });

  test("THE 2026-10-24 16:30 DIVERGENCE reproduces as acuity-open-but-booked with both sides in detail", () => {
    const date = "2026-10-24";
    const booked = BOOKED_1024.map((t) => bookedRow(date, t, { appointment_type: 'Alliance Portrait Session + 20" Portrait' }));
    const out = detectAvailabilityDiscrepancies({
      calendarId: "1335091",
      date,
      gridTimes: scheduledSlotTimesForDay(date),
      acuityOpen: fixtureTimes("t2-2026-10-24-main.json"), // 15:30 AND 16:30 (16:30 is booked)
      booked,
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("acuity-open-but-booked");
    expect(out[0].calendar_id).toBe("1335091");
    expect(out[0].date_et).toBe("2026-10-24");
    expect(out[0].time_et).toBe("16:30");
    // both sides attached: acuity open + the occupying booking identified
    expect(out[0].detail.acuity).toBe("open");
    expect(out[0].detail.grid).toBe("canonical");
    const bookedList = out[0].detail.booked as Array<Record<string, unknown>>;
    expect(bookedList).toHaveLength(1);
    expect(bookedList[0].appointment_type).toBe('Alliance Portrait Session + 20" Portrait');
    // 15:30 (genuinely open on both sides) is NOT flagged
    expect(out.map((d) => d.time_et)).not.toContain("15:30");
  });

  test("cancelled appointment frees its slot (2026-10-13): cancelled 14:30 row never counts as booked", () => {
    const date = "2026-10-13";
    // DB (percal.out): active rows 09,10,11,12,15:30,17:30 + a CANCELLED 14:30 row
    // + a cancelled+active PAIR at 16:30 — the grid open set is 13:30 + 14:30.
    const booked = [
      ...["09:00", "10:00", "11:00", "12:00", "15:30", "17:30"].map((t) => bookedRow(date, t)),
      bookedRow(date, "14:30", { cancelled: true, status: "cancelled" }), // cancelled — frees its slot
      bookedRow(date, "16:30", { cancelled: true, status: "cancelled" }), // the cancelled half of the pair
      bookedRow(date, "16:30", { id: "appt-active-1630" }), // the active half
    ];
    const out = detectAvailabilityDiscrepancies({
      calendarId: "1335091",
      date,
      gridTimes: scheduledSlotTimesForDay(date), // Tuesday: 9 slots
      acuityOpen: fixtureTimes("times-2026-10-13-cal1335091.json"), // 13:30, 14:30
      booked,
    });
    expect(out).toEqual([]);
  });

  test("acuity-silent-but-open: a free grid slot the feed does not offer is flagged, both sides attached", () => {
    const date = "2026-10-15";
    const booked = ["09:00", "10:00", "11:00", "12:00", "14:30", "15:30"].map((t) => bookedRow(date, t));
    // grid open = 08:00, 13:30, 16:30, 17:30 — the feed only offers 08:00 + 17:30
    const out = detectAvailabilityDiscrepancies({
      calendarId: "1335091",
      date,
      gridTimes: scheduledSlotTimesForDay(date),
      acuityOpen: ["08:00", "17:30"],
      booked,
    });
    expect(out.map((d) => `${d.time_et}:${d.kind}`)).toEqual(["13:30:acuity-silent-but-open", "16:30:acuity-silent-but-open"]);
    expect(out[0].detail.acuity).toBe("silent");
    expect(out[0].detail.booked).toEqual([]);
  });

  test("off-grid-acuity-time: a feed time outside the canonical grid is flagged (not a hole, never displayed open)", () => {
    const date = "2026-10-19";
    // booked = every grid slot except 08:00/09:00 → both sides agree on those two;
    // the feed additionally offers 12:30, which the canonical grid does not define
    const booked = ["10:00", "11:00", "12:00", "13:30", "14:30", "15:30", "16:30", "17:30"].map((t) => bookedRow(date, t));
    const out = detectAvailabilityDiscrepancies({
      calendarId: "1335091",
      date,
      gridTimes: scheduledSlotTimesForDay(date),
      acuityOpen: ["08:00", "09:00", "12:30"], // 12:30 is NOT on the grid
      booked,
    });
    expect(out.map((d) => `${d.time_et}:${d.kind}`)).toEqual(["12:30:off-grid-acuity-time"]);
  });

  test("unparseable appointment datetime is skipped, never guessed into a slot", () => {
    const date = "2026-10-24";
    // one row has an unparseable datetime — the detector must NOT guess which
    // slot it occupies (if it were guessed into 16:30, the feed offering 16:30
    // would fire acuity-open-but-booked; it must read clean instead)
    const booked: DetectorBookedAppt[] = [
      ...["08:00", "09:00", "10:00", "11:00", "12:00", "13:30", "14:30", "17:30"].map((t) => bookedRow(date, t)),
      { ...bookedRow(date, "16:30"), appointment_datetime: "not-a-date" },
    ];
    const out = detectAvailabilityDiscrepancies({
      calendarId: "1335091",
      date,
      gridTimes: scheduledSlotTimesForDay(date),
      acuityOpen: ["15:30", "16:30"],
      booked,
    });
    expect(out).toEqual([]);
  });
});

describe("representative type pairs (the /appointment-types hard binding)", () => {
  test("main picks Portrait Session; Annex + Zoom pick their only bound types; unbound calendars are warned", () => {
    const { pairs, warnings } = representativeTypePairs(CALS, TYPES);
    const main = pairs.find((p) => p.calendarId === "1335091")!;
    expect(main.appointmentTypeId).toBe("3599872"); // Portrait Session
    const annex = pairs.find((p) => p.calendarId === "12107308")!;
    expect(annex.appointmentTypeName).toBe("Session Fee, Portrait Session Only");
    const zoom = pairs.find((p) => p.calendarId === "4932380")!;
    expect(zoom.appointmentTypeName).toBe("Proof Only Appointment");
    expect(pairs).toHaveLength(3);
    expect(warnings).toEqual([]);
    // a calendar with NO bound type is skipped with a warning, never guessed
    const lonely = representativeTypePairs([{ id: "999", name: "Nowhere", timezone: "America/New_York" }], TYPES);
    expect(lonely.pairs).toHaveLength(0);
    expect(lonely.warnings[0]).toContain("999");
  });
});

describe("fetch plan (rate-limit-aware, pure)", () => {
  const NOW = Date.parse("2026-10-06T18:00:00Z");
  const TODAY = "2026-10-06";
  const pairs: CalendarTypePair[] = [
    { calendarId: "1335091", calendarName: "MALLORY PORTRAITS", appointmentTypeId: "3599872", appointmentTypeName: "Portrait Session" },
    { calendarId: "12107308", calendarName: "The Annex", appointmentTypeId: "15232940", appointmentTypeName: "Session Fee, Portrait Session Only" },
    { calendarId: "4932380", calendarName: "Zoom", appointmentTypeId: "24168854", appointmentTypeName: "Proof Only Appointment" },
  ];
  const datesRow = (month: string, calendarId: string, dates: string[], fetchedAt: string): AvailabilityDatesRow => ({
    calendar_id: calendarId,
    appointment_type_id: pairs.find((p) => p.calendarId === calendarId)!.appointmentTypeId,
    month,
    dates_et: dates,
    fetched_at: fetchedAt,
    run_id: "run-1",
  });
  const slotRow = (calendarId: string, dateEt: string, timeEt: string, lastConfirmedAt: string): AvailabilitySlotRow => ({
    id: `${calendarId}-${dateEt}-${timeEt}`,
    calendar_id: calendarId,
    date_et: dateEt,
    time_et: timeEt,
    slots_available: 1,
    source: "acuity",
    first_seen_at: lastConfirmedAt,
    last_confirmed_at: lastConfirmedAt,
    run_id: "run-1",
  });
  const FRESH = new Date(NOW - 60_000).toISOString();
  const STALE = new Date(NOW - 10 * 3_600_000).toISOString();

  test("past months are never swept; missing months sweep per pair", () => {
    const plan = planAvailabilityFetches({
      today: TODAY,
      months: ["2026-08", "2026-09", "2026-10", "2026-11", "2027-05"],
      dates: [],
      pairs,
      cachedDates: [],
      cachedSlots: [],
      datesTtlMs: 6 * 3_600_000,
      timesTtlMs: 2 * 3_600_000,
      nowMs: NOW,
      timesCap: 20,
    });
    // 2026-08/09 are past (booked-truth days; the feed has no past availability)
    expect(new Set(plan.sweeps.map((s) => s.month))).toEqual(new Set(["2026-10", "2026-11", "2027-05"]));
    // 3 months × 3 calendars = 9 sweep calls (one /availability/dates per pair); dates fetches: none
    expect(plan.sweeps).toHaveLength(9);
    expect(new Set(plan.sweeps.map((s) => `${s.month}:${s.calendarId}`))).toEqual(
      new Set(["2026-10:1335091", "2026-10:12107308", "2026-10:4932380", "2026-11:1335091", "2026-11:12107308", "2026-11:4932380", "2027-05:1335091", "2027-05:12107308", "2027-05:4932380"]),
    );
    expect(plan.sweeps.every((s) => s.reason === "missing")).toBe(true);
    expect(plan.times).toEqual([]);
  });

  test("fresh month index authorizes time probes only for dates it marks open; [] months probe nothing", () => {
    const plan = planAvailabilityFetches({
      today: TODAY,
      months: ["2026-10"],
      dates: ["2026-10-08", "2026-10-09", "2026-10-24", "2026-10-26"],
      pairs: [pairs[0]], // main only
      cachedDates: [
        datesRow("2026-10", "1335091", ["2026-10-08", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-24", "2026-10-31"], FRESH),
      ],
      cachedSlots: [slotRow("1335091", "2026-10-08", "08:00", FRESH), slotRow("1335091", "2026-10-08", "13:30", FRESH)],
      datesTtlMs: 6 * 3_600_000,
      timesTtlMs: 2 * 3_600_000,
      nowMs: NOW,
      timesCap: 20,
    });
    // 10-08 has fresh slot rows → nothing; 10-24 marked open, no slot rows → missing;
    // 10-09 and 10-26 are NOT in the month index (Acuity says closed) → NO probe
    expect(plan.sweeps).toEqual([]);
    expect(plan.times).toEqual([{ date: "2026-10-24", calendarId: "1335091", appointmentTypeId: "3599872", reason: "missing" }]);
  });

  test("stale month index defers its dates' probes (sweep first); stale slot rows re-probe; cap keeps soonest", () => {
    const plan = planAvailabilityFetches({
      today: TODAY,
      months: ["2026-10", "2026-11"],
      dates: ["2026-10-24", "2026-10-31", "2026-11-01", "2026-11-03"],
      pairs: [pairs[0]],
      cachedDates: [
        datesRow("2026-10", "1335091", ["2026-10-24", "2026-10-31"], STALE), // stale month → defer times
        datesRow("2026-11", "1335091", ["2026-11-01"], FRESH), // fresh
      ],
      cachedSlots: [
        slotRow("1335091", "2026-11-01", "08:00", STALE), // marked open, stale confirmation → re-probe
        slotRow("1335091", "2026-11-01", "13:30", STALE),
      ],
      datesTtlMs: 6 * 3_600_000,
      timesTtlMs: 2 * 3_600_000,
      nowMs: NOW,
      timesCap: 5,
    });
    expect(plan.sweeps).toEqual([{ month: "2026-10", calendarId: "1335091", appointmentTypeId: "3599872", reason: "stale" }]);
    // 10-24/10-31: month stale → deferred; 11-03: fresh index says closed → nothing
    expect(plan.times).toEqual([{ date: "2026-11-01", calendarId: "1335091", appointmentTypeId: "3599872", reason: "stale" }]);
  });

  test("times cap bounds the per-run probe count (soonest dates first)", () => {
    const openDates = ["2026-10-08", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-24", "2026-10-31"];
    const plan = planAvailabilityFetches({
      today: TODAY,
      months: ["2026-10"],
      dates: openDates,
      pairs: [pairs[0]],
      cachedDates: [datesRow("2026-10", "1335091", openDates, FRESH)],
      cachedSlots: [], // none cached → every open date wants a probe
      datesTtlMs: 6 * 3_600_000,
      timesTtlMs: 2 * 3_600_000,
      nowMs: NOW,
      timesCap: 3,
    });
    expect(plan.times).toHaveLength(3);
    expect(plan.times.map((t) => t.date)).toEqual(["2026-10-08", "2026-10-12", "2026-10-13"]);
  });
});

describe("month helpers (pure)", () => {
  test("monthKeyOf / monthDates / addMonths", () => {
    expect(monthKeyOf("2026-10-13")).toBe("2026-10");
    expect(monthDates("2026-10")).toHaveLength(31);
    expect(monthDates("2026-02")).toHaveLength(28); // 2026 is not a leap year
    expect(monthDates("2024-02")).toHaveLength(29);
    expect(addMonths("2026-10", 1)).toBe("2026-11");
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2026-10", 0)).toBe("2026-10");
  });
});
