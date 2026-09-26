/**
 * Phase 7 — Team page metrics: range aggregation for team totals, goal
 * summation across multi-week ranges, pace-needed math (incl. 0/negative
 * clamping), trend bucketing (daily vs weekly switch, ET bucket boundaries,
 * thin-bucket "—" behavior), range presets, and a regression test for the
 * computeOpenSlots slot-filtering bug found while building this phase.
 */
import { describe, expect, test } from "bun:test";
import {
  buildTeamRangeMetrics,
  buildTeamTrends,
  computeOpenSlots,
  paceDaysLeftForRange,
  resolveTeamGoal,
  TREND_MIN_DENOMINATOR,
  type AppointmentRow,
  type AttributionRow,
  type AvailabilityRule,
  type CallRow,
  type LeadRow,
} from "../metrics/compute";
import { resolveRange } from "../date-logic";

// 2026-09-25 is a Friday; ET is UTC-4 (EDT) in September 2026.
const TODAY = "2026-09-25";
const call = (id: string, rep: string, contact: string, startedAt: string, dur: number): CallRow => ({
  id,
  rep_id: rep,
  contact_id: contact,
  started_at: startedAt,
  duration_seconds: dur,
  over_two_minutes: dur > 120,
});
const appt = (id: string, contact: string, createdAt: string, status = "scheduled"): AppointmentRow => ({
  id,
  contact_id: contact,
  calendar_id: "cal-1",
  appointment_type: "Family Portrait Session",
  appointment_datetime: "2026-10-01T14:00:00.000Z",
  created_at: createdAt,
  status,
  cancelled: status === "cancelled",
});
const attr = (id: string, apptId: string, callId: string | null, repId: string | null): AttributionRow => ({
  id,
  appointment_id: apptId,
  call_id: callId,
  rep_id: repId,
  method: callId ? "contact_id" : "none",
  confidence: 1,
  manual_override: false,
});
const lead = (id: string, workDate: string, repId: string | null, sourceDate = workDate): LeadRow => ({
  id,
  lead_type: "family",
  source_date: sourceDate,
  work_date: workDate,
  contact_id: null,
  assigned_rep_id: repId,
  source_sheet: "family",
});

const teamInput = (over: Partial<Parameters<typeof buildTeamRangeMetrics>[0]>) =>
  buildTeamRangeMetrics({
    calls: [],
    appts: [],
    attributions: [],
    allCallsForJoin: [],
    leads: [],
    workStart: "2026-09-21",
    workEnd: TODAY,
    weeks: ["2026-09-21"],
    teamGoalByWeek: new Map([["2026-09-21", 79]]),
    today: TODAY,
    thresholdSeconds: 120,
    ...over,
  });

describe("buildTeamRangeMetrics — team totals aggregate across reps", () => {
  const calls = [
    call("c1", "r1", "k1", "2026-09-25T14:00:00.000Z", 300), // over
    call("c2", "r2", "k2", "2026-09-25T15:00:00.000Z", 120), // exactly 120 → NOT over
    call("c3", "r1", "k3", "2026-09-25T16:00:00.000Z", 60),
  ];
  const appts = [
    appt("a1", "k1", "2026-09-25T17:00:00.000Z"),
    appt("a2", "k4", "2026-09-25T17:30:00.000Z", "cancelled"), // not a booking
    appt("a3", "k2", "2026-09-25T18:00:00.000Z"),
  ];
  const attributions = [attr("t1", "a1", "c1", "r1"), attr("t2", "a3", "c2", "r2")];

  test("sums calls, over-threshold, bookings, assigned leads; conversions on the period's own data", () => {
    const m = teamInput({
      calls,
      appts,
      attributions,
      allCallsForJoin: calls,
      leads: [lead("l1", TODAY, "r1"), lead("l2", TODAY, null)],
    });
    expect(m.totalCalls).toBe(3);
    expect(m.callsOverThreshold).toBe(1); // strictly more than 120
    expect(m.totalBookings).toBe(2); // cancelled excluded
    expect(m.bookingsFromOverThreshold).toBe(1); // only a1 → c1 (300s)
    expect(m.assignedLeads).toBe(1); // unassigned lead excluded
    expect(m.conversationConversion).toBeCloseTo(1);
    expect(m.assignedLeadConversion).toBeCloseTo(2);
    expect(m.avgCallDurationSeconds).toBe(Math.round((300 + 120 + 60) / 3));
  });

  test("bookings keep counting when the attribution join needs look-back calls before the range", () => {
    const m = teamInput({
      calls: [call("c9", "r1", "k1", "2026-09-24T20:00:00.000Z", 400)],
      appts: [appt("a1", "k1", "2026-09-25T17:00:00.000Z")],
      attributions: [attr("t1", "a1", "c9", "r1")],
      allCallsForJoin: [call("c9", "r1", "k1", "2026-09-24T20:00:00.000Z", 400)],
    });
    expect(m.totalBookings).toBe(1);
    expect(m.bookingsFromOverThreshold).toBe(1);
  });
});

describe("team goal — weekly goals summed over multi-week ranges (owner-ratified)", () => {
  test("two weeks with one stored goal: sum + default 79 for the unset week, basis with-default", () => {
    const g = resolveTeamGoal({
      weeks: ["2026-09-14", "2026-09-21"],
      teamGoalByWeek: new Map([["2026-09-14", 80]]),
    });
    expect(g.value).toBe(80 + 79);
    expect(g.basis).toBe("with-default");
    expect(g.note).toContain("summed over 2 weeks");
    expect(g.note).toContain("default 79");
  });

  test("single stored week: basis team-goal", () => {
    const g = resolveTeamGoal({ weeks: ["2026-09-21"], teamGoalByWeek: new Map([["2026-09-21", 79]]) });
    expect(g.value).toBe(79);
    expect(g.basis).toBe("team-goal");
    expect(g.note).toBe("team booking goal · week of 2026-09-21");
  });

  test("multi-week all stored: plain sum, no default note", () => {
    const g = resolveTeamGoal({
      weeks: ["2026-09-14", "2026-09-21"],
      teamGoalByWeek: new Map([
        ["2026-09-14", 80],
        ["2026-09-21", 79],
      ]),
    });
    expect(g.value).toBe(159);
    expect(g.basis).toBe("team-goal");
    expect(g.note).not.toContain("default");
  });

  test("no stored weeks → 79 default, flagged", () => {
    const g = resolveTeamGoal({ weeks: ["2026-09-21"], teamGoalByWeek: new Map() });
    expect(g.value).toBe(79);
    expect(g.basis).toBe("with-default");
  });
});

describe("pace-needed math for the team range", () => {
  test("days left: WORKING days through the FRIDAY of the last covered week", () => {
    // Friday today, horizon = Fri of the covered week → today only = 1 working day
    expect(paceDaysLeftForRange({ rangeEnd: TODAY, lastWeekStart: "2026-09-21", today: TODAY })).toBe(1);
  });
  test("days left: elapsed ranges are 0; weekend today = 0 working days this week", () => {
    expect(paceDaysLeftForRange({ rangeEnd: "2026-09-27", lastWeekStart: "2026-09-21", today: TODAY })).toBe(1); // horizon Fri Sep 25
    expect(paceDaysLeftForRange({ rangeEnd: "2026-09-20", lastWeekStart: "2026-09-14", today: TODAY })).toBe(0);
    expect(paceDaysLeftForRange({ rangeEnd: "2026-09-24", lastWeekStart: "2026-09-21", today: TODAY })).toBe(0);
    // Saturday: the week's Friday has passed → no working days left, pace resumes Monday
    expect(paceDaysLeftForRange({ rangeEnd: "2026-09-26", lastWeekStart: "2026-09-21", today: "2026-09-26" })).toBe(0);
  });
  test("custom range extending into a future week counts WORKING days through that week's Friday", () => {
    // range end Oct 2 → last covered week starts Sep 28 → horizon Fri Oct 2;
    // working days Sep 25..Oct 2 = Fri + Mon–Fri = 6
    expect(paceDaysLeftForRange({ rangeEnd: "2026-10-02", lastWeekStart: "2026-09-28", today: TODAY })).toBe(6);
  });
  test("multi-week to-date range (month-style) paces through the final covered week", () => {
    // Sep 1 (Tue) → weeks Aug 31, Sep 7, Sep 14, Sep 21; horizon Fri Sep 25 = today → 1 working day
    const m = teamInput({
      workStart: "2026-09-01",
      workEnd: TODAY,
      weeks: ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"],
      teamGoalByWeek: new Map([["2026-09-21", 79]]),
    });
    expect(m.goal.value).toBe(79 * 3 + 79);
    expect(m.paceDaysLeft).toBe(1);
    expect(m.paceNote).toContain("1 working day left through Fri, Sep 25");
  });
  test("zero/negative clamping: remaining floors at 0 and pace is 0 — never negative", () => {
    const over = teamInput({
      appts: Array.from({ length: 90 }, (_, i) => appt(`a${i}`, `k${i}`, "2026-09-25T15:00:00.000Z")),
    });
    expect(over.remaining).toBe(0); // 90 bookings vs 79 goal, floored
    expect(over.paceNeeded).toBe(0);
    expect(over.goalAchievement).toBeCloseTo(90 / 79);
  });
  test("elapsed range: pace 0 with an explicit note", () => {
    const m = teamInput({ workEnd: "2026-09-20", weeks: ["2026-09-14"] });
    expect(m.paceDaysLeft).toBe(0);
    expect(m.paceNeeded).toBe(0);
    expect(m.paceNote).toContain("no pace needed");
  });
  test("weekend with the range still open: pace 0 + honest 'resumes Monday' note", () => {
    const m = teamInput({ workEnd: "2026-09-26", weeks: ["2026-09-21"], today: "2026-09-26" }); // Saturday
    expect(m.paceDaysLeft).toBe(0);
    expect(m.paceNeeded).toBe(0);
    expect(m.paceNote).toContain("pace resumes Monday");
  });
});

describe("buildTeamTrends — bucketing", () => {
  test("switch: ≤ 31 days → daily, ≥ 32 → weekly", () => {
    const base = {
      calls: [],
      appts: [],
      attributions: [],
      allCallsForJoin: [],
      leads: [],
      weeklyBudgetByWeek: new Map<string, number>(),
      thresholdSeconds: 120,
    };
    const daily = buildTeamTrends({ ...base, start: "2026-08-26", end: "2026-09-25" });
    expect(daily.bucketMode).toBe("day");
    expect(daily.points).toHaveLength(31);
    const weekly = buildTeamTrends({ ...base, start: "2026-08-25", end: "2026-09-25" });
    expect(weekly.bucketMode).toBe("week");
    expect(weekly.points.map((p) => p.key)).toEqual([
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
    ]);
  });

  test("ET bucket boundaries: 03:59Z is the previous ET day, 04:00Z starts the ET day", () => {
    const t = buildTeamTrends({
      calls: [call("c1", "r1", "k1", "2026-09-25T04:00:00.000Z", 300)],
      appts: [appt("a1", "k1", "2026-09-25T03:59:00.000Z")],
      attributions: [],
      allCallsForJoin: [],
      leads: [],
      start: "2026-09-24",
      end: "2026-09-25",
      weeklyBudgetByWeek: new Map(),
      thresholdSeconds: 120,
    });
    expect(t.bucketMode).toBe("day");
    expect(t.points.map((p) => p.key)).toEqual(["2026-09-24", "2026-09-25"]);
    expect(t.points[0].bookings).toBe(1); // created 23:59 ET Sep 24
    expect(t.points[0].calls).toBe(0);
    expect(t.points[1].calls).toBe(1); // started 00:00 ET Sep 25
    expect(t.points[1].bookings).toBe(0);
  });

  test("weekly buckets aggregate full weeks and match the range totals", () => {
    const calls = [
      call("c1", "r1", "k1", "2026-08-25T14:00:00.000Z", 300), // partial first week (starts Aug 25)
      call("c2", "r1", "k2", "2026-09-25T14:00:00.000Z", 60), // partial last week
      call("c3", "r2", "k3", "2026-09-10T14:00:00.000Z", 120),
    ];
    const appts = [
      appt("a1", "k1", "2026-08-25T18:00:00.000Z"),
      appt("a2", "k2", "2026-09-25T18:00:00.000Z"),
      appt("a3", "k3", "2026-09-10T18:00:00.000Z", "cancelled"), // never a booking
      appt("a4", "k4", "2026-08-24T18:00:00.000Z"), // BEFORE the range → excluded everywhere
    ];
    const t = buildTeamTrends({
      calls,
      appts,
      attributions: [],
      allCallsForJoin: [],
      leads: [],
      start: "2026-08-25",
      end: "2026-09-25",
      weeklyBudgetByWeek: new Map(),
      thresholdSeconds: 120,
    });
    expect(t.points[0].key).toBe("2026-08-24"); // clamped to the range start for filtering
    expect(t.points.reduce((s, p) => s + p.bookings, 0)).toBe(2);
    expect(t.points.reduce((s, p) => s + p.calls, 0)).toBe(3);
    expect(t.points.reduce((s, p) => s + p.leads, 0)).toBe(0);
  });

  test("lead volume buckets by work_date, not source_date", () => {
    const t = buildTeamTrends({
      calls: [],
      appts: [],
      attributions: [],
      allCallsForJoin: [],
      leads: [lead("l1", "2026-09-25", "r1", "2026-09-24")], // entered Sep 24, worked Sep 25
      start: "2026-09-24",
      end: "2026-09-25",
      weeklyBudgetByWeek: new Map(),
      thresholdSeconds: 120,
    });
    expect(t.points[0].leads).toBe(0);
    expect(t.points[1].leads).toBe(1);
  });

  test("thin buckets: conversions are null below the minimum denominator, honest ratio above it", () => {
    const overCall = (id: string) => call(id, "r1", "k", "2026-09-25T14:00:00.000Z", 300);
    const fromOver = (id: string, contact: string) => appt(id, contact, "2026-09-25T16:00:00.000Z");
    const attrs = (n: number) => Array.from({ length: n }, (_, i) => attr(`t${i}`, `a${i}`, `c${i}`, "r1"));
    const t = buildTeamTrends({
      calls: [overCall("c0")], // 1 over-threshold call
      appts: [fromOver("a0", "k0"), fromOver("a1", "k1")],
      attributions: attrs(1),
      allCallsForJoin: [overCall("c0")],
      leads: [lead("l1", "2026-09-25", "r1"), lead("l2", "2026-09-25", "r1")], // 2 leads < min
      start: "2026-09-25",
      end: "2026-09-25",
      weeklyBudgetByWeek: new Map(),
      thresholdSeconds: 120,
    });
    const p = t.points[0];
    expect(p.callsOverThreshold).toBe(1);
    expect(p.bookings).toBe(2);
    expect(p.conversationConversion).toBeNull(); // 1 qualifying call → "—", not a 200% spike
    expect(p.assignedLeadConversion).toBeNull(); // 2 leads → "—"
    expect(t.bucketNote).toContain(String(TREND_MIN_DENOMINATOR));

    const t2 = buildTeamTrends({
      calls: [overCall("c0"), overCall("c1"), overCall("c2")],
      appts: [fromOver("a0", "k0"), fromOver("a1", "k1")],
      attributions: attrs(2),
      allCallsForJoin: [overCall("c0"), overCall("c1"), overCall("c2")],
      leads: [
        lead("l1", "2026-09-25", "r1"),
        lead("l2", "2026-09-25", "r1"),
        lead("l3", "2026-09-25", "r1"),
      ],
      start: "2026-09-25",
      end: "2026-09-25",
      weeklyBudgetByWeek: new Map(),
      thresholdSeconds: 120,
    });
    expect(t2.points[0].conversationConversion).toBeCloseTo(2 / 3);
    expect(t2.points[0].assignedLeadConversion).toBeCloseTo(2 / 3);
  });

  test("avg call duration is null for buckets with no calls", () => {
    const t = buildTeamTrends({
      calls: [],
      appts: [],
      attributions: [],
      allCallsForJoin: [],
      leads: [],
      start: "2026-09-25",
      end: "2026-09-25",
      weeklyBudgetByWeek: new Map(),
      thresholdSeconds: 120,
    });
    expect(t.points[0].avgCallDurationSeconds).toBeNull();
    expect(t.points[0].bookings).toBe(0);
  });

  test("lead-budget reference line: weekly budget for week buckets, ÷7 for day buckets, per-week override honored", () => {
    const weekly = buildTeamTrends({
      calls: [],
      appts: [],
      attributions: [],
      allCallsForJoin: [],
      leads: [],
      start: "2026-08-25",
      end: "2026-09-25",
      weeklyBudgetByWeek: new Map([["2026-08-24", 650]]),
      thresholdSeconds: 120,
    });
    expect(weekly.points[0].budgetRef).toBe(650); // clamped first bucket sits in the Aug 24 week
    expect(weekly.points[1].budgetRef).toBe(700);

    const daily = buildTeamTrends({
      calls: [],
      appts: [],
      attributions: [],
      allCallsForJoin: [],
      leads: [],
      start: "2026-09-21",
      end: "2026-09-25",
      weeklyBudgetByWeek: new Map(),
      thresholdSeconds: 120,
    });
    expect(daily.points.every((p) => p.budgetRef === 100)).toBe(true); // 700 ÷ 7
  });
});

describe("resolveRange — Last 7 / Last 30 presets", () => {
  test("last-7 is the 7 days ending today (ET)", () => {
    const r = resolveRange("last-7", TODAY);
    expect(r.start).toBe("2026-09-19");
    expect(r.end).toBe(TODAY);
    expect(r.label).toBe("Last 7 Days");
    expect(r.toDate).toBe(true);
    expect(r.warning).toBeNull();
  });
  test("last-30 is the 30 days ending today (ET)", () => {
    const r = resolveRange("last-30", TODAY);
    expect(r.start).toBe("2026-08-27");
    expect(r.end).toBe(TODAY);
    expect(r.label).toBe("Last 30 Days");
  });
});

describe("computeOpenSlots — regression: instants must be compared as ms, not ISO strings", () => {
  const rules: AvailabilityRule[] = [{ weekday: 5, open_time: "10:00", close_time: "16:00", active: true }]; // Friday
  test("booked and blocked slots are excluded (was: everything open via NaN comparisons)", () => {
    // appointment session at 15:00Z = 11:00 AM ET; cancelled appointments are not busy
    const slots = computeOpenSlots({
      date: "2026-09-25",
      rules,
      blocked: [{ id: "b1", start_at: "2026-09-25T17:00:00.000Z", end_at: "2026-09-25T18:00:00.000Z", reason: "lunch" }], // 1–2 PM ET
      appointments: [
        { ...appt("a1", "k1", "2026-09-25T15:00:00.000Z"), appointment_datetime: "2026-09-25T15:00:00.000Z" },
        appt("a2", "k2", "2026-09-25T15:00:00.000Z", "cancelled"),
      ],
      slotIntervalMin: 60,
      durationMin: 60,
      paddingMin: 0,
    });
    expect(slots).toEqual(["10:00 AM", "12:00 PM", "2:00 PM", "3:00 PM"]);
  });
});
