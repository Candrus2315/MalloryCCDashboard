/**
 * OWNER-RATIFIED PACE CUTOFF (2026-09-29) — "days left" for the DAILY PACE
 * figures counts today as a remaining working day ONLY before 18:30
 * America/New_York; at/after 18:30 ET today is excluded (owner's example,
 * Mon evening: (79−13)/4 = 16.5 → the existing ceil displays 17). Weekend
 * behavior unchanged (0 working days remain → pace resumes Monday; the
 * never-negative pace rule is untouched — paceNeeded returns 0 at 0 days).
 *
 * OWNER REV 90 (10/29) — FROZEN START-OF-DAY TARGET: while the day is open the
 * DAILY TARGET shown is no longer the live recalculation (goal − WTD incl.
 * today) ÷ days-left; it is the START-OF-DAY computation (goal − wins BEFORE
 * today) ÷ Mon–Fri workdays including today, HELD all day. paceNeeded keeps
 * its exact live formula but survives ONLY as the closed-state roll (after
 * 18:30 ET today is complete, so remaining-at-that-moment ÷ workdays after
 * today = the next workday's frozen target). Lead pace (dailyLeadsNeeded) is
 * NOT part of the ruling and keeps the live basis everywhere.
 *
 * SCOPE: pace paths only. daysLeftInWorkWeek (today always counts) is now the
 * FROZEN divisor semantics for the booking target, and every builder keeps the
 * live daysLeftInWorkWeekAt roll for the closed state.
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
  test("daysLeftInWorkWeek keeps today-counts semantics — the FROZEN divisor (Mon 5 … Fri 1, weekend 0)", () => {
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

describe("builders: closed-state roll + frozen open-state target (13 of 79 booked on Monday)", () => {
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

  test("buildTodayMetrics at Mon 18:30 ET: closed roll paceNeeded = ceil(66 ÷ 4) = 17; frozen target UNCHANGED at ceil(79 ÷ 5) = 16", () => {
    const m = buildTodayMetrics({ ...todayInput, etNowMinutes: H1830 });
    expect(m.paceDaysLeft).toBe(4);
    expect(m.bookings.remaining).toBe(66);
    expect(m.bookings.paceNeeded).toBe(17); // ceil(66/4) — the closed-state roll (raw 16.5, owner example)
    expect(m.bookings.frozenTarget).toBe(16); // start-of-day basis: goal 79 − 0 wins before Mon ÷ 5 workdays
    expect(m.bookings.winsBeforeToday).toBe(0);
    expect(m.paceWeekend).toBe(false);
    expect(m.leads.dailyNeeded).toBe(175); // lead pace NOT part of rev 90 — live basis unchanged
  });
  test("buildTodayMetrics WITHOUT a clock (open): live paceNeeded keeps its formula (ceil(66 ÷ 5) = 14) but the DISPLAYED frozen target is ceil(79 ÷ 5) = 16", () => {
    const m = buildTodayMetrics(todayInput);
    expect(m.paceDaysLeft).toBe(5);
    expect(m.bookings.paceNeeded).toBe(14); // legacy live formula — kept verbatim (closed roll only)
    expect(m.bookings.frozenTarget).toBe(16); // REV 90: the open-state TODAY'S TARGET — frozen start-of-day basis
    expect(m.bookings.winsBeforeToday).toBe(0);
    expect(m.leads.dailyNeeded).toBe(140);
  });
  test("buildDailyReportMetrics at Mon 18:30 ET: closed roll dailyBookingsNeeded 17; paceWeekend false; frozen basis exposed", () => {
    const m = buildDailyReportMetrics({ ...reportInput, etNowMinutes: H1830 });
    expect(m.workDaysLeft).toBe(4);
    expect(m.dailyBookingsNeeded).toBe(17); // closed roll — unchanged by rev 90
    expect(m.winsBeforeToday).toBe(0);
    expect(m.workdaysInclToday).toBe(5);
    expect(m.dailyLeadsNeeded).toBe(175);
    expect(m.paceWeekend).toBe(false);
  });
  test("buildDailyReportMetrics WITHOUT a clock (open): FROZEN start-of-day target ceil(79 ÷ 5) = 16 — no live recalculation", () => {
    const m = buildDailyReportMetrics(reportInput);
    expect(m.workDaysLeft).toBe(5);
    expect(m.dailyBookingsNeeded).toBe(16); // REV 90: frozen basis (was the live 14)
    expect(m.winsBeforeToday).toBe(0);
    expect(m.workdaysInclToday).toBe(5);
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
