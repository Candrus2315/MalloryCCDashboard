/**
 * TODAY'S TARGET pace presentation (owner spec 2026-10-29) — pins the DISPLAY
 * day-states around the existing, CONFIRMED-CORRECT pace math. No formula is
 * re-tested here beyond what pins the state machine: paceNeeded stays
 * ceil(remaining ÷ working-days-left), the denominator stays Mon–Fri-only
 * with the owner 18:30 ET cutoff (pace-day-cutoff.test.ts owns those), and
 * what changed is what the number is CALLED and when the day rolls:
 *   open weekday   → TODAY'S TARGET "[target] bookings" + "[booked] booked ·
 *                    [N] more needed today" / "Target reached" / "[X] above
 *                    today's target" (moreNeeded never negative)
 *   closed weekday → window-closed line + "Needed [next workday]: [target]
 *                    bookings" (Thursday evening → Friday; Friday evening →
 *                    NO weekend target, pace ended, weekly remaining only)
 *   weekend        → honest "team is off — pace resumes Monday"
 * WEEKLY REMAINING ("[remaining] bookings left to hit [goal]") is present in
 * every state. Pending payments never enter bookedToday.
 */
import { describe, expect, test } from "bun:test";
import { PACE_DAY_CUTOFF_ET_MINUTES } from "../date-logic";
import { buildTodayMetrics } from "../metrics/compute";
import { todayPaceView } from "~/components/today-views";
import type { AppointmentRow } from "../metrics/compute";

// September/October 2026: Mon 9/28 … Fri 10/2, Sat 10/3, Sun 10/4 (ET).
const MON = "2026-09-28";
const TUE = "2026-09-29";
const THU = "2026-10-01";
const FRI = "2026-10-02";
const SAT = "2026-10-03";
const H1830 = PACE_DAY_CUTOFF_ET_MINUTES; // 18:30 ET = 1110

/** Paid legacy win created 10:00 ET on the given date (counts as a booking). */
const appt = (id: string, createdIso: string): AppointmentRow => ({
  id,
  contact_id: null,
  calendar_id: "cal-1",
  appointment_type: "Family Portrait Session",
  appointment_datetime: "2026-10-01T14:00:00.000Z",
  created_at: createdIso,
  status: "scheduled",
  cancelled: false,
});
const monAppts = (n: number) =>
  Array.from({ length: n }, (_, i) => appt(`w-${i}`, "2026-09-28T14:00:00.000Z")); // 10:00 ET Mon
const thuAppts = (n: number) =>
  Array.from({ length: n }, (_, i) => appt(`t-${i}`, "2026-10-01T14:00:00.000Z")); // 10:00 ET Thu
/** A pending (unpaid) booking created today — visible in the payload, never a win. */
const pendingAppt = (id: string): AppointmentRow => ({
  ...appt(id, "2026-09-28T16:00:00.000Z"),
  payment_state: "pending_payment",
});

const baseInput = (reportDate: string, todays: AppointmentRow[]) => ({
  reportDate,
  calls: [],
  apptsCreatedToday: todays,
  apptsCreatedYesterday: [],
  apptsCreatedWtd: todays,
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
});

describe("Today pace payload — the day-state around the unchanged pace math", () => {
  test("weekday before the cutoff: open — target is the total daily paceNeeded (not 'more needed')", () => {
    const m = buildTodayMetrics({ ...baseInput(MON, monAppts(13)), etNowMinutes: 18 * 60 + 29 });
    expect(m.paceDayState).toBe("open");
    expect(m.paceDaysLeft).toBe(5);
    expect(m.paceNextWorkday).toBeNull();
    expect(m.bookings.paceNeeded).toBe(14); // ceil(66/5) — unchanged formula
    const v = todayPaceView({
      paceDayState: m.paceDayState,
      paceNextWorkday: m.paceNextWorkday,
      paceNeeded: m.bookings.paceNeeded,
      bookedToday: m.bookings.today,
      remaining: m.bookings.remaining,
      weeklyGoal: m.bookings.weeklyGoal,
    });
    expect(v.state).toBe("open");
    expect(v.target).toBe(14);
    expect(v.progressLine).toBe("13 booked · 1 more needed today");
    expect(v.weeklyRemaining).toBe("66 bookings left to hit 79");
    expect(v.moreNeeded).toBe(1);
    expect(v.windowClosedLine).toBeNull();
    expect(v.offLine).toBeNull();
  });

  test("exactly at 18:30 ET: closed — same-day 'more needed' gone, rolls to the next workday", () => {
    const m = buildTodayMetrics({ ...baseInput(MON, monAppts(13)), etNowMinutes: H1830 });
    expect(m.paceDayState).toBe("closed");
    expect(m.paceDaysLeft).toBe(4);
    expect(m.paceNextWorkday).toBe(TUE);
    expect(m.bookings.paceNeeded).toBe(17); // ceil(66/4) — the rolled requirement
    const v = todayPaceView({
      paceDayState: m.paceDayState,
      paceNextWorkday: m.paceNextWorkday,
      paceNeeded: m.bookings.paceNeeded,
      bookedToday: m.bookings.today,
      remaining: m.bookings.remaining,
      weeklyGoal: m.bookings.weeklyGoal,
    });
    expect(v.state).toBe("closed");
    expect(v.windowClosedLine).toBe("Today's production window has closed (after 18:30 ET)");
    expect(v.nextWorkdayLine).toBe("Needed Tuesday: 17 bookings");
    expect(v.nextWorkdayName).toBe("Tuesday");
    expect(v.weeklyRemaining).toBe("66 bookings left to hit 79");
  });

  test("just after 18:30 ET: closed, identical roll (cutoff is inclusive from 18:30)", () => {
    const m = buildTodayMetrics({ ...baseInput(MON, monAppts(13)), etNowMinutes: H1830 + 1 });
    expect(m.paceDayState).toBe("closed");
    expect(m.paceNextWorkday).toBe(TUE);
    expect(m.bookings.paceNeeded).toBe(17);
  });

  test("Thursday evening rolls to Friday's number (dLeft 1 → the remaining total)", () => {
    const m = buildTodayMetrics({ ...baseInput(THU, thuAppts(10)), etNowMinutes: H1830 });
    expect(m.paceDayState).toBe("closed");
    expect(m.paceDaysLeft).toBe(1);
    expect(m.paceNextWorkday).toBe(FRI);
    expect(m.bookings.paceNeeded).toBe(69); // ceil(69/1): 79 − 10 WTD
    const v = todayPaceView({
      paceDayState: m.paceDayState,
      paceNextWorkday: m.paceNextWorkday,
      paceNeeded: m.bookings.paceNeeded,
      bookedToday: m.bookings.today,
      remaining: m.bookings.remaining,
      weeklyGoal: m.bookings.weeklyGoal,
    });
    expect(v.nextWorkdayLine).toBe("Needed Friday: 69 bookings");
  });

  test("Friday evening: pace has ENDED — no weekend target is ever fabricated", () => {
    const m = buildTodayMetrics({ ...baseInput(FRI, thuAppts(0)), etNowMinutes: H1830 });
    expect(m.paceDayState).toBe("closed");
    expect(m.paceWeekend).toBe(true);
    expect(m.paceNextWorkday).toBeNull();
    expect(m.bookings.paceNeeded).toBe(0);
    const v = todayPaceView({
      paceDayState: m.paceDayState,
      paceNextWorkday: m.paceNextWorkday,
      paceNeeded: m.bookings.paceNeeded,
      bookedToday: m.bookings.today,
      remaining: m.bookings.remaining,
      weeklyGoal: m.bookings.weeklyGoal,
    });
    expect(v.state).toBe("closed");
    expect(v.nextWorkdayLine).toBeNull();
    expect(v.nextWorkdayName).toBeNull();
    expect(v.offLine).toBe("no pace target until Monday — weekend bookings still count toward the week");
    expect(v.weeklyRemaining).toBe("79 bookings left to hit 79");
  });

  test("weekend honesty (Sat and Sun, before and after the cutoff clock)", () => {
    for (const day of [SAT, "2026-10-04"] as const) {
      for (const clock of [undefined, 9 * 60, H1830]) {
        const m = buildTodayMetrics({
          ...baseInput(day, []),
          ...(clock === undefined ? {} : { etNowMinutes: clock }),
        });
        expect(m.paceDayState).toBe("weekend");
        expect(m.paceWeekend).toBe(true);
        expect(m.bookings.paceNeeded).toBe(0);
        const v = todayPaceView({
          paceDayState: m.paceDayState,
          paceNextWorkday: m.paceNextWorkday,
          paceNeeded: m.bookings.paceNeeded,
          bookedToday: m.bookings.today,
          remaining: m.bookings.remaining,
          weeklyGoal: m.bookings.weeklyGoal,
        });
        expect(v.state).toBe("weekend");
        expect(v.offLine).toBe("team is off — pace resumes Monday");
        expect(v.progressLine).toBe("");
      }
    }
  });
});

describe("TodayPaceView — open-state copy states (pure display math)", () => {
  const view = (bookedToday: number, target: number, remaining = 20) =>
    todayPaceView({
      paceDayState: "open",
      paceNextWorkday: null,
      paceNeeded: target,
      bookedToday,
      remaining,
      weeklyGoal: 79,
    });

  test("zero bookings today → honest count, no negatives", () => {
    const v = view(0, 12);
    expect(v.progressLine).toBe("0 booked · 12 more needed today");
    expect(v.moreNeeded).toBe(12);
    expect(v.above).toBe(0);
    expect(v.reached).toBe(false);
  });

  test("target reached exactly → 'Target reached', moreNeeded 0 (never negative)", () => {
    const v = view(12, 12);
    expect(v.progressLine).toBe("Target reached");
    expect(v.moreNeeded).toBe(0);
    expect(v.reached).toBe(true);
  });

  test("target exceeded → '[X] above today's target', moreNeeded stays 0", () => {
    const v = view(15, 12);
    expect(v.progressLine).toBe("15 booked · 3 above today's target");
    expect(v.moreNeeded).toBe(0);
    expect(v.above).toBe(3);
    expect(v.reached).toBe(true);
  });

  test("WEEKLY REMAINING wording in every state", () => {
    expect(view(0, 12, 20).weeklyRemaining).toBe("20 bookings left to hit 79");
    expect(
      todayPaceView({
        paceDayState: "closed",
        paceNextWorkday: TUE,
        paceNeeded: 17,
        bookedToday: 13,
        remaining: 66,
        weeklyGoal: 79,
      }).weeklyRemaining,
    ).toBe("66 bookings left to hit 79");
    expect(
      todayPaceView({
        paceDayState: "weekend",
        paceNextWorkday: null,
        paceNeeded: 0,
        bookedToday: 0,
        remaining: 66,
        weeklyGoal: 79,
      }).weeklyRemaining,
    ).toBe("66 bookings left to hit 79");
  });
});

describe("pending payments never enter bookedToday (display-only exclusion intact)", () => {
  test("unpaid 'paid: no' rows are excluded from today's booked count and the target math", () => {
    const m = buildTodayMetrics({
      ...baseInput(MON, [...monAppts(13), pendingAppt("p-1"), pendingAppt("p-2")]),
      etNowMinutes: 18 * 60 + 29,
    });
    expect(m.bookings.today).toBe(13); // pending excluded — not 15
    expect(m.bookings.wtd).toBe(13);
    expect(m.bookings.remaining).toBe(66);
    expect(m.bookings.paceNeeded).toBe(14);
    const v = todayPaceView({
      paceDayState: m.paceDayState,
      paceNextWorkday: m.paceNextWorkday,
      paceNeeded: m.bookings.paceNeeded,
      bookedToday: m.bookings.today,
      remaining: m.bookings.remaining,
      weeklyGoal: m.bookings.weeklyGoal,
    });
    expect(v.progressLine).toBe("13 booked · 1 more needed today");
  });
});
