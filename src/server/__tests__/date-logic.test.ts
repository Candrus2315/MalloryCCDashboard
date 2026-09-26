import { describe, expect, test } from "bun:test";
import {
  addDays,
  dateRange,
  daysLeftInWorkWeek,
  etDateStrFromInstant,
  etDayStartUtc,
  getLeadCohort,
  getWorkDate,
  weekElapsedWorkFraction,
  weekStart,
  weekday,
  workingDaysBetween,
} from "../date-logic";

describe("getLeadCohort (SPEC lead date logic)", () => {
  test("MONDAY RULE: Mon 9/28 pulls Fri 9/25 + Sat 9/26 + Sun 9/27", () => {
    expect(getLeadCohort("2026-09-28")).toEqual(["2026-09-25", "2026-09-26", "2026-09-27"]);
  });

  test("Tuesday–Friday each pull the previous calendar day", () => {
    expect(getLeadCohort("2026-09-22")).toEqual(["2026-09-21"]); // Tue → Mon
    expect(getLeadCohort("2026-09-23")).toEqual(["2026-09-22"]); // Wed → Tue
    expect(getLeadCohort("2026-09-24")).toEqual(["2026-09-23"]); // Thu → Wed
    expect(getLeadCohort("2026-09-25")).toEqual(["2026-09-24"]); // Fri → Thu
  });

  test("Saturday/Sunday prefer the upcoming Monday's cohort (documented behavior)", () => {
    // Sat 9/26 → next Monday 9/28 → cohort Fri 25, Sat 26, Sun 27 (incl. today + tomorrow)
    expect(getLeadCohort("2026-09-26")).toEqual(["2026-09-25", "2026-09-26", "2026-09-27"]);
    // Sun 9/27 → next Monday 9/28 → cohort Fri 25, Sat 26, Sun 27 (incl. today)
    expect(getLeadCohort("2026-09-27")).toEqual(["2026-09-25", "2026-09-26", "2026-09-27"]);
  });

  test("cohort is empty-safe across month boundaries", () => {
    // Tue 9/1 → Mon 8/31
    expect(getLeadCohort("2026-09-01")).toEqual(["2026-08-31"]);
    // Mon 3/2 → Fri 2/27 + Sat 2/28 + Sun 3/1
    expect(getLeadCohort("2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });

  test("getWorkDate is the inverse of getLeadCohort", () => {
    expect(getWorkDate("2026-09-25")).toBe("2026-09-28"); // Fri → Mon
    expect(getWorkDate("2026-09-26")).toBe("2026-09-28"); // Sat → Mon
    expect(getWorkDate("2026-09-27")).toBe("2026-09-28"); // Sun → Mon
    expect(getWorkDate("2026-09-28")).toBe("2026-09-29"); // Mon → Tue
    expect(getWorkDate("2026-09-21")).toBe("2026-09-22"); // Mon → Tue
    expect(getWorkDate("2026-09-24")).toBe("2026-09-25"); // Thu → Fri
    // Every source date in a cohort maps to the report date.
    for (const src of getLeadCohort("2026-09-28")) expect(getWorkDate(src)).toBe("2026-09-28");
  });
});

describe("timezone + calendar helpers (America/New_York)", () => {
  test("etDateStrFromInstant respects ET day boundaries (EDT, UTC-4)", () => {
    // 2026-09-28 03:59:59 UTC = 2026-09-27 23:59:59 ET → still the 27th
    expect(etDateStrFromInstant(Date.UTC(2026, 8, 28, 3, 59, 59))).toBe("2026-09-27");
    // 2026-09-28 04:00:00 UTC = 2026-09-28 00:00:00 ET
    expect(etDateStrFromInstant(Date.UTC(2026, 8, 28, 4, 0, 0))).toBe("2026-09-28");
  });

  test("etDateStrFromInstant handles EST (UTC-5)", () => {
    // 2026-01-15 04:59:59 UTC = 2026-01-14 23:59:59 ET
    expect(etDateStrFromInstant(Date.UTC(2026, 0, 15, 4, 59, 59))).toBe("2026-01-14");
    expect(etDateStrFromInstant(Date.UTC(2026, 0, 15, 5, 0, 0))).toBe("2026-01-15");
  });

  test("etDayStartUtc is ET midnight", () => {
    // ET midnight on 2026-09-28 (EDT) = 04:00 UTC
    expect(etDayStartUtc("2026-09-28")).toBe("2026-09-28T04:00:00.000Z");
    // ET midnight on 2026-01-15 (EST) = 05:00 UTC
    expect(etDayStartUtc("2026-01-15")).toBe("2026-01-15T05:00:00.000Z");
  });

  test("weekStart returns Monday of the Mon–Sun week", () => {
    expect(weekStart("2026-09-28")).toBe("2026-09-28"); // Monday
    expect(weekStart("2026-09-25")).toBe("2026-09-21"); // Friday
    expect(weekStart("2026-09-27")).toBe("2026-09-21"); // Sunday
  });

  test("daysLeftInWorkWeek: WORKING days only (agents work Mon–Fri)", () => {
    expect(daysLeftInWorkWeek("2026-09-21")).toBe(5); // Monday → Mon..Fri
    expect(daysLeftInWorkWeek("2026-09-22")).toBe(4); // Tuesday
    expect(daysLeftInWorkWeek("2026-09-25")).toBe(1); // Friday → today only
    expect(daysLeftInWorkWeek("2026-09-26")).toBe(0); // Saturday — no working days left
    expect(daysLeftInWorkWeek("2026-09-27")).toBe(0); // Sunday
  });
  test("weekElapsedWorkFraction: Mon 1/5 … Fri 5/5; Sat/Sun 5/5 (week's work done)", () => {
    expect(weekElapsedWorkFraction("2026-09-21")).toBeCloseTo(1 / 5, 6); // Monday
    expect(weekElapsedWorkFraction("2026-09-23")).toBeCloseTo(3 / 5, 6); // Wednesday
    expect(weekElapsedWorkFraction("2026-09-25")).toBe(1); // Friday — full week's pace expected
    expect(weekElapsedWorkFraction("2026-09-26")).toBe(1); // Saturday
    expect(weekElapsedWorkFraction("2026-09-27")).toBe(1); // Sunday
  });
  test("workingDaysBetween counts Mon–Fri only", () => {
    expect(workingDaysBetween("2026-09-25", "2026-09-25")).toBe(1); // Fri alone
    expect(workingDaysBetween("2026-09-25", "2026-09-27")).toBe(1); // Fri..Sun → Fri
    expect(workingDaysBetween("2026-09-26", "2026-09-27")).toBe(0); // pure weekend
    expect(workingDaysBetween("2026-09-25", "2026-10-02")).toBe(6); // Fri Sep 25 → Fri Oct 2
    expect(workingDaysBetween("2026-09-26", "2026-09-25")).toBe(0); // inverted → 0, never negative
  });

  test("addDays and dateRange cross months correctly", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(weekday("2026-09-25")).toBe(5); // Friday
    expect(dateRange("2026-09-28", "2026-09-30")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
  });
});
