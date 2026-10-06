/**
 * PIP LANDING view-model (refinement spec §1–§2) — pure derivations from
 * stored dates, no store, no clock (ET `today` is always injected).
 * Covers: signed days-left, "ending soon ≤3 incl. past-end" rule, check-in
 * state (overdue / unscheduled / cadence-derived expected total), the
 * attention priority ladder, and the owner's four KPI counts.
 */
import { describe, expect, test } from "bun:test";
import {
  pipAttentionSeed,
  pipCheckinState,
  pipDaysUntil,
  pipEndingSoon,
  pipKpiCounts,
  pipReviewWeekIndex,
  pipWindowOverdue,
  sortPipsByDaysLeft,
} from "../pip-landing";
import type { PipCheckinRow } from "../store/types";

const TODAY = "2026-09-30";

function checkin(over: Partial<PipCheckinRow>): PipCheckinRow {
  return {
    id: over.id ?? "ck",
    pip_id: over.pip_id ?? "pip",
    checkin_date: over.checkin_date ?? "2026-09-28",
    manager_name: over.manager_name ?? "christopher",
    employee_name: over.employee_name ?? null,
    current_performance: over.current_performance ?? null,
    topics_discussed: over.topics_discussed ?? null,
    coaching_provided: over.coaching_provided ?? null,
    employee_comments: over.employee_comments ?? null,
    manager_notes: over.manager_notes ?? null,
    next_actions: over.next_actions ?? null,
    next_checkin_date: over.next_checkin_date ?? null,
    created_at: over.created_at ?? "2026-09-28T15:00:00.000Z",
  };
}

describe("pipDaysUntil", () => {
  test("signed calendar-day math (ET date-only)", () => {
    expect(pipDaysUntil("2026-10-03", TODAY)).toBe(3);
    expect(pipDaysUntil("2026-09-30", TODAY)).toBe(0);
    expect(pipDaysUntil("2026-09-27", TODAY)).toBe(-3);
    expect(pipDaysUntil(null, TODAY)).toBeNull();
  });
});

describe("ending soon / window overdue (spec §1 InfoTap rule)", () => {
  test("≤3 days counts, INCLUDING already-past end dates; 4 days does not", () => {
    expect(pipEndingSoon(3)).toBe(true);
    expect(pipEndingSoon(0)).toBe(true);
    expect(pipEndingSoon(-1)).toBe(true);
    expect(pipEndingSoon(4)).toBe(false);
    expect(pipEndingSoon(null)).toBe(false);
    expect(pipWindowOverdue(-1)).toBe(true);
    expect(pipWindowOverdue(0)).toBe(false);
    expect(pipWindowOverdue(3)).toBe(false);
    expect(pipWindowOverdue(null)).toBe(false);
  });
});

describe("pipCheckinState", () => {
  test("next = latest logged check-in's next_checkin_date; overdue when that date passed", () => {
    const cs = pipCheckinState(
      { pip_start_date: "2026-09-29", pip_end_date: "2026-11-10", checkin_cadence_days: 7 },
      [checkin({ next_checkin_date: "2026-09-29" }), checkin({ checkin_date: "2026-09-29", next_checkin_date: "2026-10-06" })],
      TODAY,
    );
    expect(cs.next_checkin_date).toBe("2026-10-06");
    expect(cs.count).toBe(2);
    expect(cs.upcoming_number).toBe(3);
    expect(cs.overdue).toBe(false);
    expect(cs.unscheduled).toBe(false);
  });
  test("overdue scheduled check-in", () => {
    const cs = pipCheckinState(
      { pip_start_date: "2026-09-01", pip_end_date: "2026-10-15", checkin_cadence_days: 7 },
      [checkin({ next_checkin_date: "2026-09-29" })],
      TODAY,
    );
    expect(cs.overdue).toBe(true);
  });
  test("unscheduled: issued with no next date recorded — not overdue", () => {
    const cs = pipCheckinState(
      { pip_start_date: "2026-09-01", pip_end_date: "2026-10-15", checkin_cadence_days: 7 },
      [checkin({ next_checkin_date: null })],
      TODAY,
    );
    expect(cs.unscheduled).toBe(true);
    expect(cs.overdue).toBe(false);
  });
  test("expected total = ceil(inclusive window days ÷ cadence)", () => {
    // 2026-09-29 → 2026-11-10 inclusive = 43 days ÷ 7 → ceil = 7
    const cs = pipCheckinState(
      { pip_start_date: "2026-09-29", pip_end_date: "2026-11-10", checkin_cadence_days: 7 },
      [],
      TODAY,
    );
    expect(cs.expected_total).toBe(7);
    expect(cs.upcoming_number).toBe(1);
  });
  test("no cadence → expected_total null (no invented schedule)", () => {
    const cs = pipCheckinState({ pip_start_date: "2026-09-01", pip_end_date: "2026-10-15", checkin_cadence_days: null }, [], TODAY);
    expect(cs.expected_total).toBeNull();
  });
});

describe("attention priority ladder (spec §1 lines + Phase 3 signals)", () => {
  test("overdue check-in outranks missed minimum > past-end > awaiting-ack > ending-soon > unscheduled", () => {
    const base = { id: "p1", status: "issued" as const };
    const overdue = pipAttentionSeed(
      base,
      "Dana",
      -2,
      pipCheckinState({ pip_start_date: "2026-09-01", pip_end_date: "2026-10-01", checkin_cadence_days: 7 }, [checkin({ next_checkin_date: "2026-09-29" })], TODAY),
    );
    expect(overdue!.rank).toBe(1);
    expect(overdue!.code).toBe("checkin_overdue");
    expect(overdue!.text).toBe("Check-in overdue — Dana, due 2026-09-29");

    const missed = pipAttentionSeed(
      base,
      "Dana",
      30,
      { next_checkin_date: "2026-10-29", count: 1, upcoming_number: 2, expected_total: 6, overdue: false, unscheduled: false },
      { awaiting_ack: false, weeks_missed: 2 },
    );
    expect(missed!.rank).toBe(2);
    expect(missed!.code).toBe("minimum_missed");
    expect(missed!.text).toBe("Weekly minimum missed in 2 completed weeks — Dana");

    const missedOne = pipAttentionSeed(
      base,
      "Dana",
      30,
      { next_checkin_date: "2026-10-29", count: 1, upcoming_number: 2, expected_total: 6, overdue: false, unscheduled: false },
      { awaiting_ack: false, weeks_missed: 1 },
    );
    expect(missedOne!.text).toBe("Weekly minimum missed in 1 completed week — Dana");

    const pastEnd = pipAttentionSeed(base, "Dana", -2, { next_checkin_date: "2026-10-29", count: 1, upcoming_number: 2, expected_total: 6, overdue: false, unscheduled: false });
    expect(pastEnd!.rank).toBe(3);
    expect(pastEnd!.code).toBe("past_end");
    expect(pastEnd!.text).toBe("Past end date, not yet closed — Dana");

    const awaitingAck = pipAttentionSeed(
      base,
      "Dana",
      30,
      { next_checkin_date: "2026-10-29", count: 1, upcoming_number: 2, expected_total: 6, overdue: false, unscheduled: false },
      { awaiting_ack: true, weeks_missed: 0 },
    );
    expect(awaitingAck!.rank).toBe(4);
    expect(awaitingAck!.code).toBe("awaiting_ack");
    expect(awaitingAck!.text).toBe("Acknowledgment not yet recorded — Dana");

    const ending = pipAttentionSeed(base, "Dana", 2, { next_checkin_date: "2026-10-29", count: 1, upcoming_number: 2, expected_total: 6, overdue: false, unscheduled: false });
    expect(ending!.rank).toBe(5);
    expect(ending!.code).toBe("ending_soon");
    expect(ending!.text).toBe("PIP window ends in 2 days — Dana");

    const oneDay = pipAttentionSeed(base, "Dana", 1, { next_checkin_date: "2026-10-29", count: 1, upcoming_number: 2, expected_total: 6, overdue: false, unscheduled: false });
    expect(oneDay!.text).toBe("PIP window ends in 1 day — Dana");

    const unscheduled = pipAttentionSeed(base, "Dana", 30, { next_checkin_date: null, count: 0, upcoming_number: 1, expected_total: 6, overdue: false, unscheduled: true });
    expect(unscheduled!.rank).toBe(6);
    expect(unscheduled!.code).toBe("unscheduled");
    expect(unscheduled!.text).toBe("Next check-in not scheduled — Dana");

    // on-schedule → null
    const calm = pipAttentionSeed(base, "Dana", 30, { next_checkin_date: "2026-10-29", count: 1, upcoming_number: 2, expected_total: 6, overdue: false, unscheduled: false });
    expect(calm).toBeNull();

    // drafts never raise attention (even when Phase-3 signals would be true)
    expect(
      pipAttentionSeed(
        { id: "p2", status: "draft" },
        "Dana",
        -5,
        { next_checkin_date: null, count: 0, upcoming_number: 1, expected_total: null, overdue: false, unscheduled: true },
        { awaiting_ack: true, weeks_missed: 3 },
      ),
    ).toBeNull();
  });
});

describe("pipReviewWeekIndex (Phase 3 workspace)", () => {
  test("1-based index within the SAME mondaysInRange list the evidence engine uses", () => {
    // Review window Mon Oct 5 → Fri Nov 6: Mondays Oct 5/12/19/26 + Nov 2 = 5 weeks.
    expect(pipReviewWeekIndex("2026-10-05", "2026-11-06", "2026-10-07")).toEqual({ index: 1, total: 5 });
    expect(pipReviewWeekIndex("2026-10-05", "2026-11-06", "2026-10-19")).toEqual({ index: 3, total: 5 });
    expect(pipReviewWeekIndex("2026-10-05", "2026-11-06", "2026-11-06")).toEqual({ index: 5, total: 5 });
  });
  test("today's week outside the window → null (never a guessed index)", () => {
    expect(pipReviewWeekIndex("2026-10-05", "2026-11-06", "2026-09-30")).toBeNull();
    expect(pipReviewWeekIndex("2026-10-05", "2026-11-06", "2026-11-09")).toBeNull();
  });
  test("inverted/invalid dates → null", () => {
    expect(pipReviewWeekIndex("2026-11-06", "2026-10-05", "2026-10-07")).toBeNull();
    expect(pipReviewWeekIndex("bad", "2026-10-05", "2026-10-07")).toBeNull();
  });
});

describe("KPI counts + default sort", () => {
  test("owner's four metrics with the documented sub-line counters", () => {
    const rows = [
      { status: "issued" as const, ending_soon: true, window_overdue: false, checkin_overdue: true },
      { status: "issued" as const, ending_soon: true, window_overdue: false, checkin_overdue: false },
      { status: "issued" as const, ending_soon: false, window_overdue: true, checkin_overdue: false },
      { status: "issued" as const, ending_soon: false, window_overdue: false, checkin_overdue: false },
      { status: "draft" as const, ending_soon: false, window_overdue: false, checkin_overdue: false },
      { status: "completed" as const, ending_soon: false, window_overdue: false, checkin_overdue: false },
    ];
    expect(pipKpiCounts(rows)).toEqual({ active: 4, checkins_due: 1, ending_soon: 2, drafts: 1, past_end: 1 });
  });
  test("days-remaining ascending, nulls last, name tie-break", () => {
    const sorted = sortPipsByDaysLeft([
      { days_left: 10, rep_name: "B", title: "t1" },
      { days_left: null, rep_name: "A", title: "t2" },
      { days_left: 3, rep_name: "C", title: "t3" },
      { days_left: -2, rep_name: "D", title: "t4" },
      { days_left: 10, rep_name: "A", title: "t0" },
    ]);
    expect(sorted.map((r) => r.rep_name)).toEqual(["D", "C", "A", "B", "A"]);
  });
});
