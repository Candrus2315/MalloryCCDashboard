/**
 * OWNER-RATIFIED PACE CUTOFF (2026-09-29) — "days left" for the DAILY PACE
 * figures counts today as a remaining working day ONLY before 18:30
 * America/New_York; at/after 18:30 ET today is excluded (owner's example,
 * Mon evening: (79−13)/4 = 16.5 → the existing ceil displays 17). Weekend
 * behavior unchanged (0 working days remain → pace resumes Monday; the
 * never-negative pace rule is untouched — paceNeeded returns 0 at 0 days).
 *
 * SCOPE: pace paths only. daysLeftInWorkWeek (today always counts) stays the
 * semantics for non-pace callers, and every builder keeps it whenever no ET
 * clock is threaded — which is why all pre-existing tests keep their numbers.
 */
import { describe, expect, test } from "bun:test";
import { daysLeftInWorkWeek, daysLeftInWorkWeekAt, PACE_DAY_CUTOFF_ET_MINUTES } from "../date-logic";
import { buildDailyReportMetrics, buildTodayMetrics, paceDaysLeftForRange, paceNeeded } from "../metrics/compute";
import type { AppointmentRow } from "../store/types";

// September/October 2026: Mon 9/28, Fri 10/2, Sat 10/3, Sun 10/4 (ET).
const MON = "2026-09-28";
const TUE = "2026-09-29";
const FRI = "2026-10-02";
const SAT = "2026-10-03";
const SUN = "2026-10-04";
const H1830 = PACE_DAY_CUTOFF_ET_MINUTES; // 18:30 = 1110

const appt = (id: string): AppointmentRow => ({
  id,
  contact_id: null,
  calendar_id: "cal-1",
  appointment_type: "Family Portrait Session",
  appointment_datetime: "2026-10-01T14:00:00.000Z",
  created_at: "2026-09-28T14:00:00.000Z", // 10:00 ET Mon 9/28 → created_business_date = MON
  status: "scheduled",
  cancelled: false,
});

describe("daysLeftInWorkWeekAt — the 18:30 ET pace cutoff (owner-ratified)", () => {
  test("Mon 18:29 → 5 (today still counts)", () => {
    expect(daysLeftInWorkWeekAt(MON, 18 * 60 + 29)).toBe(5);
  });
  test("Mon 18:30 → 4 (cutoff is inclusive)", () => {
    expect(daysLeftInWorkWeekAt(MON, H1830)).toBe(4);
  });
  test("Mon 09:00 → 5", () => {
    expect(daysLeftInWorkWeekAt(MON, 9 * 60)).toBe(5);
  });
  test("Fri 18:29 → 1, Fri 18:30 → 0, Fri 18:31 → 0 (never negative)", () => {
    expect(daysLeftInWorkWeekAt(FRI, 18 * 60 + 29)).toBe(1);
    expect(daysLeftInWorkWeekAt(FRI, H1830)).toBe(0);
    expect(daysLeftInWorkWeekAt(FRI, 18 * 60 + 31)).toBe(0);
  });
  test("Sat/Sun → 0 unchanged, before AND after the cutoff", () => {
    expect(daysLeftInWorkWeekAt(SAT, 9 * 60)).toBe(0);
    expect(daysLeftInWorkWeekAt(SAT, H1830)).toBe(0);
    expect(daysLeftInWorkWeekAt(SUN, 9 * 60)).toBe(0);
    expect(daysLeftInWorkWeekAt(SUN, 23 * 60 + 59)).toBe(0);
  });
  test("sibling daysLeftInWorkWeek keeps today-counts semantics at the same clock (pace-only scope)", () => {
    expect(daysLeftInWorkWeek(MON)).toBe(5);
    expect(daysLeftInWorkWeek(FRI)).toBe(1);
    expect(daysLeftInWorkWeek(SAT)).toBe(0);
  });
});

describe("paceDaysLeftForRange (Team page pace) honors the cutoff", () => {
  const base = { rangeEnd: FRI, lastWeekStart: MON };
  test("Mon 18:29 → 5 working days through the Friday horizon", () => {
    expect(paceDaysLeftForRange({ ...base, today: MON, etNowMinutes: 18 * 60 + 29 })).toBe(5);
  });
  test("Mon 18:30 → 4 (Tue..Fri)", () => {
    expect(paceDaysLeftForRange({ ...base, today: MON, etNowMinutes: H1830 })).toBe(4);
  });
  test("Fri 18:31 → 0 — work week complete, pace resumes Monday", () => {
    expect(paceDaysLeftForRange({ ...base, today: FRI, etNowMinutes: 18 * 60 + 31 })).toBe(0);
  });
  test("weekend unchanged (0) with no clock threaded; ended range still 0", () => {
    expect(paceDaysLeftForRange({ ...base, today: SAT })).toBe(0);
    expect(paceDaysLeftForRange({ ...base, today: SUN })).toBe(0);
    expect(paceDaysLeftForRange({ rangeEnd: "2026-09-25", lastWeekStart: "2026-09-21", today: MON })).toBe(0);
  });
});

describe("builders thread the cutoff into the pace figures only (13 of 79 booked on Monday)", () => {
  const thirteenth = Array.from({ length: 13 }, (_, i) => appt(`appt-${i}`));
  const todayInput = {
    reportDate: MON,
    calls: [],
    apptsCreatedToday: thirteenth,
    apptsCreatedYesterday: [], // Today-page field — NOT the Daily Report anchor input
    apptsCreatedWtd: thirteenth,
    callsWtd: [],
    allCallsForWeek: [],
    attributions: [],
    leadsAllRecent: [],
    teamBookingGoal: 79,
    weeklyLeadBudget: 700,
    thresholdSeconds: 120,
    openSlotsByDay: [],
    reps: [],
    repGoals: [],
  } as const;
  const reportInput = {
    reportDate: MON,
    callsAnchorDay: [],
    apptsCreatedAnchorDay: [],
    apptsCreatedWtd: thirteenth,
    allCallsForWeek: [],
    attributions: [],
    leadsAllRecent: [],
    teamBookingGoal: 79,
    weeklyLeadBudget: 700,
    thresholdSeconds: 120,
  } as const;

  test("buildTodayMetrics at Mon 18:30 ET: paceDaysLeft 4 → paceNeeded = ceil(66 ÷ 4) = 17; lead pace on the same basis", () => {
    const m = buildTodayMetrics({ ...todayInput, etNowMinutes: H1830 });
    expect(m.paceDaysLeft).toBe(4);
    expect(m.bookings.remaining).toBe(66);
    expect(m.bookings.paceNeeded).toBe(17); // ceil(66/4); raw quotient 16.5 (owner example)
    expect(m.paceWeekend).toBe(false);
    expect(m.leads.dailyNeeded).toBe(175); // ceil(700/4)
  });
  test("buildTodayMetrics WITHOUT a clock keeps legacy semantics (5 days → ceil(66 ÷ 5) = 14)", () => {
    const m = buildTodayMetrics(todayInput);
    expect(m.paceDaysLeft).toBe(5);
    expect(m.bookings.paceNeeded).toBe(14);
    expect(m.leads.dailyNeeded).toBe(140);
  });
  test("buildDailyReportMetrics at Mon 18:30 ET: workDaysLeft 4 → dailyBookingsNeeded 17; paceWeekend false", () => {
    const m = buildDailyReportMetrics({ ...reportInput, etNowMinutes: H1830 });
    expect(m.workDaysLeft).toBe(4);
    expect(m.dailyBookingsNeeded).toBe(17);
    expect(m.dailyLeadsNeeded).toBe(175);
    expect(m.paceWeekend).toBe(false);
  });
  test("buildDailyReportMetrics WITHOUT a clock keeps legacy semantics (5 days → 14)", () => {
    const m = buildDailyReportMetrics(reportInput);
    expect(m.workDaysLeft).toBe(5);
    expect(m.dailyBookingsNeeded).toBe(14);
    expect(m.dailyLeadsNeeded).toBe(140);
  });
  test("paceNeeded stays never-negative at 0 days (weekend honesty untouched)", () => {
    expect(paceNeeded(66, 0)).toBe(0);
  });
  test("cutoff interacts correctly with Tuesday: Tue 18:30 → 3 (Wed..Fri)", () => {
    expect(daysLeftInWorkWeekAt(TUE, H1830)).toBe(3);
    expect(paceDaysLeftForRange({ rangeEnd: FRI, lastWeekStart: MON, today: TUE, etNowMinutes: H1830 })).toBe(3);
  });
});
