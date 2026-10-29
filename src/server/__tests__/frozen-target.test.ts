/**
 * FROZEN START-OF-DAY DAILY TARGET (owner rev 90, ratified 10/29) — the daily
 * target is computed ONCE at the start of each production day and HELD all
 * day; it is never recalculated as bookings land. Owner's pinned example MUST
 * be reached from live data (no hard-coded dates):
 *   goal 79 · 49 entering Thursday → deficit 30 ÷ 2 workdays (Thu+Fri) = 15 →
 *   TODAY'S TARGET 15 all day; 12 booked during Thursday → "12 booked · 3
 *   remaining"; Weekly Remaining 18.
 *
 * Coverage (owner-required regression):
 *   - pinned example (helper + buildTodayMetrics + view copy)
 *   - INTRADAY INVARIANCE: same target at 09:00 ET and 17:29 ET with
 *     different same-day booking counts (the live paceNeeded moves — the
 *     frozen target does not)
 *   - every weekday Mon–Fri divisor; Sat/Sun no target (anywhere)
 *   - goal already reached / exceeded entering the day → floor 0, "Target reached"
 *   - zero booked today; pending payments excluded from winsBeforeToday
 *   - 18:30 trio (just before / exactly at / just after) + Thursday evening +
 *     Friday evening states
 *   - DAILY REPORT + COPIED CC REPORT: same frozen basis — page figure ==
 *     copied "Daily: N" line == Today's target for the same production day
 *     (open AND closed states, pre/post-cutoff anchor variants)
 * Guardrails pinned: win qualification untouched (isBookingWin), deposit-week
 * bucketing untouched, Mon–Sun actuals untouched, WEEKLY REMAINING stays live,
 * the live paceNeeded formula survives verbatim for the closed-state roll.
 */
import { describe, expect, test } from "bun:test";
import { PACE_DAY_CUTOFF_ET_MINUTES } from "../date-logic";
import { buildDailyReportMetrics, buildTodayMetrics, frozenDailyTarget } from "../metrics/compute";
import { buildDailyReportText } from "../metrics/report-text";
import { todayPaceView } from "~/components/today-views";
import type { AppointmentRow } from "../metrics/compute";

// Week of Mon 2026-09-28 … Sun 2026-10-04 (ET). The PINNED example is Thursday
// 2026-10-01 with 49 wins entering the day — reached from the input data, not
// hard-coded into the code under test.
const MON = "2026-09-28";
const TUE = "2026-09-29";
const WED = "2026-09-30";
const THU = "2026-10-01";
const FRI = "2026-10-02";
const SAT = "2026-10-03";
const SUN = "2026-10-04";
const H1830 = PACE_DAY_CUTOFF_ET_MINUTES; // 18:30 ET

/** Paid legacy win created 10:00 ET on the given ET date (10:00 ET = 14:00Z; DST-safe for these dates). */
const winAppt = (id: string, etDate: string): AppointmentRow => ({
  id,
  contact_id: null,
  calendar_id: "cal-1",
  appointment_type: "Family Portrait Session",
  appointment_datetime: "2026-10-01T14:00:00.000Z",
  created_at: `${etDate}T14:00:00.000Z`, // 10:00 ET → created_business_date = etDate
  status: "scheduled",
  cancelled: false,
});
const winsOn = (tag: string, etDate: string, n: number) =>
  Array.from({ length: n }, (_, i) => winAppt(`${tag}-${i}`, etDate));
/** A pending (unpaid) booking — visible, never a win, never in the frozen basis. */
const pendingAppt = (id: string, etDate: string): AppointmentRow => ({
  ...winAppt(id, etDate),
  payment_state: "pending_payment",
});

const todayInput = (reportDate: string, wtd: AppointmentRow[], todays: AppointmentRow[]) => ({
  reportDate,
  calls: [],
  apptsCreatedToday: todays,
  apptsCreatedYesterday: [],
  apptsCreatedWtd: wtd,
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

const reportInput = (reportDate: string, wtd: AppointmentRow[]) => ({
  reportDate,
  callsAnchorDay: [],
  apptsCreatedAnchorDay: [],
  apptsCreatedWtd: wtd,
  allCallsForWeek: [],
  attributions: [],
  leadsAllRecent: [],
  teamBookingGoal: 79,
  weeklyLeadBudget: 700,
  thresholdSeconds: 120,
});

const viewOf = (m: ReturnType<typeof buildTodayMetrics>) =>
  todayPaceView({
    paceDayState: m.paceDayState,
    paceNextWorkday: m.paceNextWorkday,
    paceNeeded: m.bookings.paceNeeded,
    frozenTarget: m.bookings.frozenTarget,
    bookedToday: m.bookings.today,
    remaining: m.bookings.remaining,
    weeklyGoal: m.bookings.weeklyGoal,
  });

// PINNED EXAMPLE DATA — 49 wins Mon–Wed; 12 booked during Thursday.
const monWed49 = [...winsOn("m", MON, 25), ...winsOn("t", TUE, 15), ...winsOn("w", WED, 9)];
const thu12 = winsOn("th", THU, 12);
const wtd61 = [...monWed49, ...thu12];

describe("frozenDailyTarget — the pure formula (owner rev 90)", () => {
  test("PINNED owner example: goal 79, 49 entering Thursday, 2 workdays (Thu+Fri) → 15", () => {
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 49, workdaysLeftInclToday: 2 })).toBe(15);
  });
  test("every weekday divisor from the same 49 entering the day: Mon 6 · Tue 8 · Wed 10 · Thu 15 · Fri 30", () => {
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 49, workdaysLeftInclToday: 5 })).toBe(6); // ceil(30/5)
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 49, workdaysLeftInclToday: 4 })).toBe(8); // ceil(30/4)=7.5↑
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 49, workdaysLeftInclToday: 3 })).toBe(10);
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 49, workdaysLeftInclToday: 2 })).toBe(15);
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 49, workdaysLeftInclToday: 1 })).toBe(30);
  });
  test("Sat/Sun (0 workdays incl. today) → 0 — no target is ever fabricated for the weekend", () => {
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 0, workdaysLeftInclToday: 0 })).toBe(0);
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 49, workdaysLeftInclToday: 0 })).toBe(0);
  });
  test("weekly goal already reached / exceeded entering the day → floor 0 (never negative)", () => {
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 79, workdaysLeftInclToday: 2 })).toBe(0);
    expect(frozenDailyTarget({ goal: 79, winsBeforeToday: 90, workdaysLeftInclToday: 3 })).toBe(0);
    expect(frozenDailyTarget({ goal: 0, winsBeforeToday: 0, workdaysLeftInclToday: 5 })).toBe(0);
  });
});

describe("buildTodayMetrics — the frozen target through the real pipeline", () => {
  test("PINNED example end-to-end: Thu with 49 entering, 12 booked → target 15 all day · '12 booked · 3 remaining to today's target' · Weekly Remaining 18", () => {
    const m = buildTodayMetrics(todayInput(THU, wtd61, thu12));
    expect(m.bookings.winsBeforeToday).toBe(49); // 49 entering Thursday — today's 12 NOT in the basis
    expect(m.bookings.frozenTarget).toBe(15);
    expect(m.bookings.today).toBe(12);
    expect(m.bookings.wtd).toBe(61);
    expect(m.bookings.remaining).toBe(18); // WEEKLY REMAINING stays LIVE: 79 − 61
    const v = viewOf(m);
    expect(v.target).toBe(15);
    expect(v.progressLine).toBe("12 booked · 3 remaining to today's target");
    expect(v.weeklyRemaining).toBe("18 bookings left to hit 79");
    expect(v.reached).toBe(false);
  });

  test("INTRADAY INVARIANCE: 09:00 with 12 booked vs 17:29 with 20 booked — same frozen target 15 (live paceNeeded moves, frozen does not)", () => {
    const morning = buildTodayMetrics(todayInput(THU, [...monWed49, ...thu12], thu12));
    const evening = buildTodayMetrics({
      ...todayInput(THU, [...monWed49, ...winsOn("th", THU, 20)], winsOn("th", THU, 20)),
      etNowMinutes: 17 * 60 + 29,
    });
    expect(morning.paceDayState).toBe("open");
    expect(evening.paceDayState).toBe("open");
    expect(morning.bookings.frozenTarget).toBe(15);
    expect(evening.bookings.frozenTarget).toBe(15); // HELD — not reduced as bookings land
    // the OLD live basis would have dropped 10 → 5 across the day (self-defeating);
    // paceNeeded still computes it, but the OPEN display never shows it:
    expect(evening.bookings.paceNeeded).toBe(5);
    expect(viewOf(morning).target).toBe(15);
    expect(viewOf(evening).target).toBe(15);
  });

  test("every weekday threads the right Mon–Fri divisor through the builders (49 entering each day, none booked today)", () => {
    // Monday: nothing before it in the Mon–Sun week → ceil(79/5) = 16
    const mon = buildTodayMetrics(todayInput(MON, winsOn("m", MON, 0), []));
    expect(mon.bookings.frozenTarget).toBe(16);
    // Tuesday–Friday: all 49 wins dated Monday, so 49 have landed BEFORE each day
    // → 30 deficit ÷ workdays INCLUDING today (Tue=4, Wed=3, Thu=2, Fri=1)
    const before49 = winsOn("m", MON, 49);
    expect(buildTodayMetrics(todayInput(TUE, before49, [])).bookings.frozenTarget).toBe(8); // ceil(30/4)
    expect(buildTodayMetrics(todayInput(WED, before49, [])).bookings.frozenTarget).toBe(10); // ceil(30/3)
    expect(buildTodayMetrics(todayInput(THU, before49, [])).bookings.frozenTarget).toBe(15); // ceil(30/2) — pinned
    expect(buildTodayMetrics(todayInput(FRI, before49, [])).bookings.frozenTarget).toBe(30); // ceil(30/1)
  });

  test("Sat/Sun: frozen target 0 on the payload — no target anywhere, any clock", () => {
    for (const day of [SAT, SUN]) {
      for (const clock of [undefined, 9 * 60, H1830]) {
        const m = buildTodayMetrics({ ...todayInput(day, monWed49, []), ...(clock ? { etNowMinutes: clock } : {}) });
        expect(m.bookings.frozenTarget).toBe(0);
        expect(viewOf(m).target).toBe(0);
        expect(viewOf(m).offLine).toBe("team is off — pace resumes Monday");
      }
    }
  });

  test("goal already reached entering the day → target 0, display 'Target reached' (never a negative)", () => {
    const over = buildTodayMetrics(todayInput(THU, [...winsOn("x", MON, 40), ...winsOn("y", TUE, 45)], thu12));
    expect(over.bookings.winsBeforeToday).toBe(85);
    expect(over.bookings.frozenTarget).toBe(0);
    const v = viewOf(over);
    expect(v.target).toBe(0);
    expect(v.moreNeeded).toBe(0);
    expect(v.above).toBe(12); // 12 booked vs a 0 floor → 12 above
    expect(v.progressLine).toBe("12 booked · 12 above today's target");
  });

  test("zero booked today → honest '0 booked · N remaining to today's target'", () => {
    const m = buildTodayMetrics(todayInput(THU, monWed49, []));
    const v = viewOf(m);
    expect(v.progressLine).toBe("0 booked · 15 remaining to today's target");
  });

  test("pending payments never enter winsBeforeToday (unpaid rows excluded from the frozen basis)", () => {
    const withPending = buildTodayMetrics(
      todayInput(THU, [...monWed49, pendingAppt("p1", WED), pendingAppt("p2", WED)], thu12),
    );
    expect(withPending.bookings.winsBeforeToday).toBe(49); // not 51
    expect(withPending.bookings.frozenTarget).toBe(15);
  });

  test("18:30 TRIO (Thursday): just before → open frozen 15; exactly at / just after → closed roll = Friday's frozen target 18", () => {
    const before = buildTodayMetrics({ ...todayInput(THU, wtd61, thu12), etNowMinutes: H1830 - 1 });
    expect(before.paceDayState).toBe("open");
    expect(viewOf(before).target).toBe(15);
    expect(viewOf(before).progressLine).toBe("12 booked · 3 remaining to today's target");

    const at = buildTodayMetrics({ ...todayInput(THU, wtd61, thu12), etNowMinutes: H1830 });
    expect(at.paceDayState).toBe("closed");
    expect(at.paceNextWorkday).toBe(FRI);
    // after the cutoff today is complete: remaining 18 ÷ workdays after today (1) = 18
    expect(at.bookings.paceNeeded).toBe(18);
    const vAt = viewOf(at);
    expect(vAt.target).toBe(18);
    expect(vAt.nextWorkdayLine).toBe("Needed Friday: 18 bookings");
    // …which equals FRIDAY's frozen start-of-day target from the same final data:
    expect(buildTodayMetrics(todayInput(FRI, wtd61, [])).bookings.frozenTarget).toBe(18);

    const after = buildTodayMetrics({ ...todayInput(THU, wtd61, thu12), etNowMinutes: H1830 + 1 });
    expect(after.paceDayState).toBe("closed");
    expect(viewOf(after).target).toBe(18);
  });

  test("Thursday evening rolls forward; FRIDAY evening: pace ended — no weekend target from the (frozen) Friday basis", () => {
    const fri = buildTodayMetrics({ ...todayInput(FRI, wtd61, []), etNowMinutes: H1830 });
    expect(fri.paceDayState).toBe("closed");
    expect(fri.paceWeekend).toBe(true);
    expect(fri.paceNextWorkday).toBeNull();
    expect(fri.bookings.frozenTarget).toBe(18); // Friday's start-of-day basis is held…
    const v = viewOf(fri);
    expect(v.target).toBe(0); // …but the display shows 0 — never a weekend target
    expect(v.nextWorkdayLine).toBeNull();
    expect(v.offLine).toBe("no pace target until Monday — weekend bookings still count toward the week");
    expect(v.weeklyRemaining).toBe("18 bookings left to hit 79"); // live weekly remaining, still honest
  });

  test("next production day rolls from the prior day's FINAL completed total (wins-before-today rolls forward automatically)", () => {
    // Thursday's final: 61. Friday's start-of-day basis = 61 → target ceil(18/1) = 18.
    const friday = buildTodayMetrics(todayInput(FRI, wtd61, []));
    expect(friday.bookings.winsBeforeToday).toBe(61);
    expect(friday.bookings.frozenTarget).toBe(18);
    // …and a hypothetical Saturday's basis would carry Friday's finals into next Monday's week —
    // Mon–Sun week logic (untouched) decides which wins are "before" each production day.
  });
});

describe("DAILY REPORT + COPIED CC REPORT — same frozen basis, same production day", () => {
  test("OPEN state (pre-cutoff + legacy no-clock): page figure == Today's frozen target == 'Daily: N' copied line", () => {
    for (const clock of [undefined, 9 * 60, H1830 - 1]) {
      const tm = buildTodayMetrics({ ...todayInput(THU, wtd61, thu12), ...(clock ? { etNowMinutes: clock } : {}) });
      const dr = buildDailyReportMetrics({
        ...reportInput(THU, wtd61),
        ...(clock ? { etNowMinutes: clock } : {}),
      });
      expect(tm.paceDayState).toBe("open");
      expect(dr.anchorDate).toBe(WED); // pre-cutoff anchor (performance figures) — pace is NOT anchor-keyed
      expect(dr.dailyBookingsNeeded).toBe(tm.bookings.frozenTarget); // SAME production day, SAME frozen number
      expect(dr.dailyBookingsNeeded).toBe(15);
      expect(dr.winsBeforeToday).toBe(tm.bookings.winsBeforeToday);
      expect(dr.workdaysInclToday).toBe(2);
      const text = buildDailyReportText(dr, {});
      expect(text).toContain(`Daily: ${dr.dailyBookingsNeeded}`);
      expect(text).toContain("Daily: 15");
    }
  });

  test("CLOSED state (18:30 trio on the Daily Report): page figure == Today's closed roll == 'Daily: N' copied line", () => {
    for (const clock of [H1830, H1830 + 1]) {
      const tm = buildTodayMetrics({ ...todayInput(THU, wtd61, thu12), etNowMinutes: clock });
      const dr = buildDailyReportMetrics({ ...reportInput(THU, wtd61), etNowMinutes: clock });
      expect(tm.paceDayState).toBe("closed");
      expect(dr.anchorDate).toBe(THU); // post-cutoff anchor = today (complete operating day)
      expect(dr.dailyBookingsNeeded).toBe(tm.bookings.paceNeeded); // both roll to the next workday
      expect(dr.dailyBookingsNeeded).toBe(18);
      expect(buildDailyReportText(dr, {})).toContain("Daily: 18");
    }
  });

  test("weekend + Friday-evening honesty on the Daily Report: 0 / no weekend target, matching Today", () => {
    const sat = buildDailyReportMetrics({ ...reportInput(SAT, wtd61), etNowMinutes: 9 * 60 });
    expect(sat.paceWeekend).toBe(true);
    expect(sat.dailyBookingsNeeded).toBe(0);
    expect(buildTodayMetrics(todayInput(SAT, wtd61, [])).bookings.frozenTarget).toBe(0);

    const friEve = buildDailyReportMetrics({ ...reportInput(FRI, wtd61), etNowMinutes: H1830 });
    const friEveToday = buildTodayMetrics({ ...todayInput(FRI, wtd61, []), etNowMinutes: H1830 });
    expect(friEve.dailyBookingsNeeded).toBe(0);
    expect(friEveToday.bookings.frozenTarget).toBe(18); // frozen basis held…
    expect(friEveToday.bookings.paceNeeded).toBe(0); // …roll has no workday left → 0 shown
    expect(friEve.dailyBookingsNeeded).toBe(friEveToday.bookings.paceNeeded);
    expect(friEve.paceWeekend).toBe(true);
  });

  test("goal reached entering the day: Daily Report figure 0 == Today figure 0, copied line 'Daily: 0'", () => {
    const overWtd = [...winsOn("x", MON, 40), ...winsOn("y", TUE, 45)];
    const tm = buildTodayMetrics(todayInput(THU, overWtd, thu12));
    const dr = buildDailyReportMetrics(reportInput(THU, overWtd));
    expect(tm.bookings.frozenTarget).toBe(0);
    expect(dr.dailyBookingsNeeded).toBe(0);
    expect(dr.dailyBookingsNeeded).toBe(tm.bookings.frozenTarget);
    expect(buildDailyReportText(dr, {})).toContain("Daily: 0");
    expect(viewOf(tm).progressLine).toBe("12 booked · 12 above today's target");
  });
});
