/**
 * AVAILABILITY REBUILD PR-3 §1 — DATES TO PUSH tests (owner spec §7).
 *
 * The priority ladder on FIXTURE days: (1) holes, (2) large open counts,
 * (3) low utilization, (4) near-term — plus the honest exclusions (past /
 * closed / fully booked / unknown-open days never rank). Every input is an
 * AvailabilityRangeDay-shaped literal: the numbers are what the ONE engine +
 * ONE hole derivation + the feed already produced — this module only sorts.
 */
import { describe, expect, test } from "bun:test";
import { deriveDatesToPush, pushRowLabel, pushRangeLabel } from "../availability-push";
import type { AvailabilityRangeDay } from "../page-data";

const TODAY = "2026-10-06";

function day(over: Partial<AvailabilityRangeDay> & { date: string }): AvailabilityRangeDay {
  return {
    totalCapacity: 10,
    booked: 0,
    openCount: 10,
    openSlotTimes: [],
    utilization: 0,
    blockedCount: 0,
    holes: 10,
    acuity: "feed",
    feedOpenTimes: null,
    feedPending: false,
    beyondHorizon: false,
    ...over,
  };
}

describe("deriveDatesToPush — the owner's priority ladder", () => {
  const days: AvailabilityRangeDay[] = [
    day({ date: "2026-10-07", booked: 7, openCount: 3, holes: 3, utilization: 0.7 }), // 3 holes
    day({ date: "2026-10-08", booked: 2, openCount: 8, holes: 8, utilization: 0.2 }), // 8 holes — tops the ladder
    day({ date: "2026-10-09", totalCapacity: 9, booked: 7, openCount: 2, holes: 2, utilization: 7 / 9 }),
    day({ date: "2026-10-12", booked: 9, openCount: 1, holes: 1, utilization: 0.9 }),
    day({ date: "2026-10-13", booked: 10, openCount: 0, holes: 0, utilization: 1 }), // fully booked — nothing to push
    day({ date: "2026-10-14", totalCapacity: 0, booked: 0, openCount: 0, holes: 0, utilization: null }), // closed
    day({ date: "2026-10-05", booked: 0, openCount: 10, holes: 10, utilization: 0 }), // past — never pushable
    day({ date: "2026-10-15", booked: 4, openCount: 6, holes: 6, utilization: 0.4 }),
    day({ date: "2026-10-16", booked: 4, openCount: null, holes: 6, utilization: 0.4 }), // unknown open (uncovered) — excluded
  ];

  test("ranks holes first, then openings, and excludes past/closed/full/unknown days", () => {
    const rows = deriveDatesToPush(days, TODAY);
    expect(rows.map((r) => r.date)).toEqual([
      "2026-10-08", // 8 holes
      "2026-10-15", // 6 holes
      "2026-10-07", // 3 holes
      "2026-10-09", // 2 holes
      "2026-10-12", // 1 hole
    ]);
    const top = rows[0];
    expect(top).toMatchObject({ openings: 8, holes: 8, capacity: 10, booked: 2, utilization: 0.2 });
  });

  test("ties on holes break by openings desc, then utilization asc, then near-term", () => {
    const tied: AvailabilityRangeDay[] = [
      // holes 4 + open 4 on both — utilization decides (0.5 < 0.6)
      day({ date: "2026-10-19", totalCapacity: 10, booked: 6, openCount: 4, holes: 4, utilization: 0.6 }),
      day({ date: "2026-10-20", totalCapacity: 8, booked: 4, openCount: 4, holes: 4, utilization: 0.5 }),
      // holes 4 + open 4 + same utilization — near-term wins
      day({ date: "2026-10-22", totalCapacity: 10, booked: 6, openCount: 4, holes: 4, utilization: 0.6 }),
      // holes 4, openings 7 beats openings 4 (same hole count)
      day({ date: "2026-10-21", totalCapacity: 10, booked: 3, openCount: 7, holes: 4, utilization: 0.3 }),
    ];
    expect(deriveDatesToPush(tied, TODAY).map((r) => r.date)).toEqual([
      "2026-10-21", // same holes, 7 openings
      "2026-10-20", // same open, lower utilization
      "2026-10-19", // same figures, earlier date
      "2026-10-22",
    ]);
  });

  test("limit caps the panel; 0-length and all-excluded ranges are empty", () => {
    expect(deriveDatesToPush(days, TODAY, 2).map((r) => r.date)).toEqual(["2026-10-08", "2026-10-15"]);
    expect(deriveDatesToPush([], TODAY)).toEqual([]);
    expect(
      deriveDatesToPush([day({ date: "2026-10-13", booked: 10, openCount: 0, holes: 0, utilization: 1 })], TODAY),
    ).toEqual([]);
  });

  test("row labels carry the owner's 'Wed Oct 7' shape", () => {
    expect(pushRowLabel("2026-10-07")).toBe("Wed Oct 7");
    expect(pushRowLabel("2026-11-01")).toBe("Sun Nov 1");
  });

  test("range label names which range the list covers", () => {
    expect(pushRangeLabel({ kind: "month", label: "October 2026" }, "ignored")).toBe("visible month October 2026");
    expect(pushRangeLabel({ kind: "days", label: "Tue, Oct 6 – Mon, Oct 19, 2026" }, "ignored")).toBe(
      "the 14-day window Tue, Oct 6 – Mon, Oct 19, 2026",
    );
    expect(pushRangeLabel({ kind: "day", label: "Tuesday, October 13, 2026" }, "Tue, Oct 6 – Mon, Oct 19, 2026")).toBe(
      "the 14-day window Tue, Oct 6 – Mon, Oct 19, 2026",
    );
  });
});
