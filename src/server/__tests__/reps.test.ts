/**
 * Reps page metrics: date-range resolution (ET boundaries), date-ranged
 * aggregation (boundary days in/out), team-average math, the %-vs-percentage-
 * point difference distinction, and the rep-goal fallback (rep_goals → team
 * goal share). Pure layers only — no DB, no clock.
 */
import { describe, expect, test } from "bun:test";
import {
  addDays,
  formatDateHumanFull,
  mondaysInRange,
  resolveRange,
  weekStart,
} from "../date-logic";
import {
  buildRepDetail,
  buildTeamAverages,
  compareWithTeam,
  filterApptsCreatedInEtRange,
  filterCallsInEtRange,
  repRangeSummaries,
  resolveRepGoal,
  teamDifference,
  type AppointmentRow,
  type AttributionRow,
  type CallRow,
  type LeadRow,
  type RepRangeMetrics,
} from "../metrics/compute";
import { formatCount, formatDiff, formatDuration } from "../metrics/report-text";

const TODAY = "2026-09-25"; // Friday (EDT, UTC-4) — matches the SPEC example week
const ET = (date: string, hhmm: string) =>
  new Date(`${date}T${hhmm}:00.000-04:00`).toISOString(); // Sep 2026 = EDT

describe("resolveRange (ET date filters)", () => {
  test("today and yesterday are single ET days", () => {
    expect(resolveRange("today", TODAY)).toMatchObject({ start: "2026-09-25", end: "2026-09-25" });
    expect(resolveRange("yesterday", TODAY)).toMatchObject({ start: "2026-09-24", end: "2026-09-24" });
  });
  test("this week is Monday..today (week to date); boundary days in/out", () => {
    const r = resolveRange("this-week", TODAY);
    expect(r.start).toBe("2026-09-21"); // Monday
    expect(r.end).toBe("2026-09-25"); // today, NOT Sunday 9/27
    expect(weekStart(r.start)).toBe("2026-09-21");
  });
  test("last week is the full previous Mon..Sun", () => {
    const r = resolveRange("last-week", TODAY);
    expect(r.start).toBe("2026-09-14");
    expect(r.end).toBe("2026-09-20");
    expect(weekStart(r.end)).toBe("2026-09-14"); // Sunday still inside last week
  });
  test("this month runs from the 1st to today (month to date)", () => {
    const r = resolveRange("this-month", TODAY);
    expect(r.start).toBe("2026-09-01");
    expect(r.end).toBe("2026-09-25");
  });
  test("custom range is honored when valid", () => {
    const r = resolveRange("custom", TODAY, "2026-09-15", "2026-09-20");
    expect(r).toMatchObject({ start: "2026-09-15", end: "2026-09-20", warning: null });
  });
  test("invalid custom ranges fall back to Today WITH a warning (never silent)", () => {
    const reversed = resolveRange("custom", TODAY, "2026-09-20", "2026-09-15");
    expect(reversed.mode).toBe("today");
    expect(reversed.warning).toContain("after end date");
    const missing = resolveRange("custom", TODAY, undefined, "2026-09-15");
    expect(missing.mode).toBe("today");
    expect(missing.warning).toContain("both dates required");
    const malformed = resolveRange("custom", TODAY, "09/15/2026", "2026-09-20");
    expect(malformed.mode).toBe("today");
  });
  test("mondaysInRange covers multi-week ranges including partial edge weeks", () => {
    expect(mondaysInRange("2026-09-24", "2026-09-25")).toEqual(["2026-09-21"]);
    expect(mondaysInRange("2026-09-21", "2026-09-29")).toEqual(["2026-09-21", "2026-09-28"]);
    // Sep 1 2026 is a Tuesday → its week starts Mon Aug 31 (month-boundary safe)
    expect(mondaysInRange("2026-09-01", "2026-09-25")).toEqual([
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
    ]);
  });
});

describe("date-ranged aggregation: boundary days in/out (ET)", () => {
  // Range Sep 24..Sep 25 EDT → [Sep 24 04:00Z, Sep 26 04:00Z)
  const mk = (id: string, startedAt: string, dur = 300): CallRow => ({
    id,
    rep_id: "r1",
    contact_id: "k1",
    started_at: startedAt,
    duration_seconds: dur,
    over_two_minutes: dur > 120,
  });
  const calls: CallRow[] = [
    mk("before", "2026-09-24T03:59:00.000Z"), // Sep 23 23:59 ET
    mk("first-minute", "2026-09-24T04:00:00.000Z"), // Sep 24 00:00 ET — inclusive lower bound
    mk("inside", ET("2026-09-24", "10:00")),
    mk("last-minute", "2026-09-26T03:59:00.000Z"), // Sep 25 23:59 ET
    mk("after", "2026-09-26T04:00:00.000Z"), // Sep 26 00:00 ET — exclusive upper bound
  ];
  test("calls filter keeps the range days and drops the day before/after", () => {
    const kept = filterCallsInEtRange(calls, "2026-09-24", "2026-09-25");
    expect(kept.map((c) => c.id).sort()).toEqual(["first-minute", "inside", "last-minute"]);
  });
  test("appointment created bucket uses the ET BUSINESS DATE (created_business_date, S7c)", () => {
    const appt = (id: string, createdAt: string, businessDate: string): AppointmentRow => ({
      id,
      contact_id: "k1",
      calendar_id: "cal-1",
      appointment_type: "Family Portrait Session",
      appointment_datetime: "2026-10-01T14:00:00.000Z",
      created_at: createdAt,
      created_business_date: businessDate,
      status: "scheduled",
      cancelled: false,
    });
    const appts = [
      appt("day-before", "2026-09-23T20:00:00.000Z", "2026-09-23"),
      appt("in-range", ET("2026-09-25", "12:00"), "2026-09-25"),
      appt("day-after", "2026-09-26T12:00:00.000Z", "2026-09-26"),
    ];
    expect(filterApptsCreatedInEtRange(appts, "2026-09-24", "2026-09-25").map((a) => a.id)).toEqual([
      "in-range",
    ]);
  });
});

describe("repRangeSummaries (date-ranged per-rep aggregation)", () => {
  const reps = [
    { id: "r1", name: "Rep One" },
    { id: "r2", name: "Rep Two" },
  ];
  const calls: CallRow[] = [
    { id: "c1", rep_id: "r1", contact_id: "k1", started_at: ET("2026-09-24", "09:00"), duration_seconds: 300, over_two_minutes: true },
    { id: "c2", rep_id: "r1", contact_id: "k2", started_at: ET("2026-09-24", "10:00"), duration_seconds: 121, over_two_minutes: true },
    { id: "c3", rep_id: "r1", contact_id: "k3", started_at: ET("2026-09-24", "11:00"), duration_seconds: 60, over_two_minutes: false },
    { id: "c4", rep_id: "r2", contact_id: "k4", started_at: ET("2026-09-25", "09:00"), duration_seconds: 200, over_two_minutes: true },
    { id: "cOut", rep_id: "r1", contact_id: "k5", started_at: "2026-09-23T20:00:00.000Z", duration_seconds: 300, over_two_minutes: true },
  ];
  const appts: AppointmentRow[] = [
    { id: "a1", contact_id: "k2", calendar_id: "c", appointment_type: "t", appointment_datetime: "2026-10-01T14:00:00.000Z", created_at: ET("2026-09-25", "09:30"), created_business_date: "2026-09-25", status: "scheduled", cancelled: false },
    { id: "a2", contact_id: "k4", calendar_id: "c", appointment_type: "t", appointment_datetime: "2026-10-01T14:00:00.000Z", created_at: ET("2026-09-25", "10:30"), created_business_date: "2026-09-25", status: "scheduled", cancelled: false },
    { id: "a3", contact_id: "k1", calendar_id: "c", appointment_type: "t", appointment_datetime: "2026-10-01T14:00:00.000Z", created_at: ET("2026-09-25", "11:30"), created_business_date: "2026-09-25", status: "cancelled", cancelled: true },
  ];
  const attributions: AttributionRow[] = [
    { id: "at1", appointment_id: "a1", call_id: "c2", rep_id: "r1", method: "contact_id", confidence: 1, manual_override: false },
    { id: "at2", appointment_id: "a2", call_id: "c4", rep_id: "r2", method: "phone", confidence: 1, manual_override: false },
    { id: "at3", appointment_id: "a3", call_id: "c1", rep_id: "r1", method: "contact_id", confidence: 1, manual_override: false },
  ];
  const lead = (id: string, workDate: string, rep: string | null): LeadRow => ({
    id,
    lead_type: "family",
    source_date: addDays(workDate, -1),
    work_date: workDate,
    contact_id: null,
    assigned_rep_id: rep,
    source_sheet: "family",
  });
  const leads: LeadRow[] = [
    lead("l1", "2026-09-24", "r1"),
    lead("l2", "2026-09-24", "r1"),
    lead("l3", "2026-09-24", "r2"),
    lead("l4", "2026-09-25", "r1"),
    lead("lOut-before", "2026-09-23", "r1"), // before range
    lead("lOut-after", "2026-09-26", "r2"), // after range
    lead("lUnassigned", "2026-09-25", null), // no assigned rep → counted nowhere
  ];

  const summaries = () =>
    repRangeSummaries({
      reps,
      calls: filterCallsInEtRange(calls, "2026-09-24", "2026-09-25"),
      appts: filterApptsCreatedInEtRange(appts, "2026-09-24", "2026-09-25"),
      attributions,
      allCallsForJoin: calls, // includes the pre-range call for threshold re-checks
      leads,
      workStart: "2026-09-24",
      workEnd: "2026-09-25",
      thresholdSeconds: 120,
    });

  test("per-rep call aggregates respect the threshold and exclude out-of-range days", () => {
    const r1 = summaries().get("r1")!;
    expect(r1.totalCalls).toBe(3); // cOut is Sep 23 → out
    expect(r1.callsOverThreshold).toBe(2); // 300s + 121s, strictly > 120
    expect(r1.avgCallDurationSeconds).toBe(Math.round((300 + 121 + 60) / 3));
  });
  test("bookings, bookings-from-over-threshold-calls, and assigned leads per rep", () => {
    const s = summaries();
    const r1 = s.get("r1")!;
    const r2 = s.get("r2")!;
    expect(r1.totalBookings).toBe(1); // a1 (a3 cancelled)
    expect(r1.bookingsFromOverThreshold).toBe(1); // a1's call c2 = 121s > 120
    expect(r1.assignedLeads).toBe(3); // work_date Sep 24 ×2 + Sep 25 ×1
    expect(r2.totalBookings).toBe(1);
    expect(r2.bookingsFromOverThreshold).toBe(1);
    expect(r2.assignedLeads).toBe(1); // lOut-after (Sep 26) excluded
  });
  test("conversions derive from the same aggregates", () => {
    const r1 = summaries().get("r1")!;
    expect(r1.conversationConversion).toBeCloseTo(1 / 2);
    expect(r1.assignedLeadConversion).toBeCloseTo(1 / 3);
  });
});

describe("team averages + comparisons (SPEC format)", () => {
  const mkMetrics = (over: Partial<RepRangeMetrics>): RepRangeMetrics => ({
    repId: "x",
    totalCalls: 0,
    callsOverThreshold: 0,
    bookingsFromOverThreshold: 0,
    totalBookings: 0,
    assignedLeads: 0,
    conversationConversion: null,
    assignedLeadConversion: null,
    avgCallDurationSeconds: null,
    ...over,
  });
  const rep = mkMetrics({
    repId: "rep",
    totalCalls: 74,
    callsOverThreshold: 14,
    conversationConversion: 0.571,
    avgCallDurationSeconds: 300,
    totalBookings: 5,
  });
  const others = [
    mkMetrics({ repId: "a", totalCalls: 68, callsOverThreshold: 11, conversationConversion: 0.545, avgCallDurationSeconds: 255 }),
    mkMetrics({ repId: "b", totalCalls: 68, callsOverThreshold: 11, conversationConversion: 0.545, avgCallDurationSeconds: 255 }),
  ];

  test("team average EXCLUDES the viewed rep", () => {
    const t = buildTeamAverages({ others });
    expect(t.repCount).toBe(2);
    expect(t.totalCalls).toBe(68);
    expect(t.conversationConversion).toBeCloseTo(0.545);
    const withSelf = buildTeamAverages({ others: [rep, ...others] });
    expect(withSelf.totalCalls).toBe((74 + 68 + 68) / 3); // only when rep not excluded
    expect(withSelf.repCount).toBe(3);
  });
  test("counts compare as % difference — SPEC: 74 vs 68 → +8.8%", () => {
    const t = buildTeamAverages({ others });
    const rows = compareWithTeam(rep, t);
    const calls = rows.find((r) => r.metric === "Calls")!;
    expect(calls.unit).toBe("pct");
    expect(calls.diff).toBeCloseTo(((74 - 68) / 68) * 100);
    expect(formatDiff(calls.diff, "pct")).toBe("+8.8%");
  });
  test("conversion rates compare as percentage points — SPEC: 57.1% vs 54.5% → +2.6 pp", () => {
    const t = buildTeamAverages({ others });
    const rows = compareWithTeam(rep, t);
    const conv = rows.find((r) => r.metric === "Conversation Conversion")!;
    expect(conv.unit).toBe("pp");
    expect(conv.diff).toBeCloseTo((0.571 - 0.545) * 100);
    expect(formatDiff(conv.diff, "pp")).toBe("+2.6 pp");
  });
  test("durations compare in seconds", () => {
    const t = buildTeamAverages({ others });
    const dur = compareWithTeam(rep, t).find((r) => r.metric === "Average Call Duration")!;
    expect(dur.unit).toBe("seconds");
    expect(dur.diff).toBe(45);
    expect(formatDiff(dur.diff, "seconds")).toBe("+45 s");
  });
  test("missing team values render as null diffs (em dash), never zero or a guess", () => {
    const noRates = buildTeamAverages({
      others: [mkMetrics({ repId: "a" }), mkMetrics({ repId: "b" })],
    });
    expect(noRates.conversationConversion).toBeNull();
    const rows = compareWithTeam(rep, noRates);
    expect(rows.find((r) => r.metric === "Conversation Conversion")!.diff).toBeNull();
    expect(formatDiff(null, "pp")).toBe("—");
  });
  test("% difference is null against a zero team average (undefined, not infinite)", () => {
    const t = buildTeamAverages({ others: [mkMetrics({ repId: "a" })] });
    expect(t.totalCalls).toBe(0);
    expect(teamDifference(5, 0, "pct")).toBeNull();
    expect(teamDifference(5, 0, "pp")).toBe(500); // pp difference stays defined
  });
});

describe("rep booking goal: rep_goals with team-share fallback", () => {
  const W1 = "2026-09-21";
  const W2 = "2026-09-28";
  test("rep goal used when set, labeled as rep goal", () => {
    const g = resolveRepGoal({
      weeks: [W1],
      repGoalsByWeek: new Map([[W1, 14]]),
      teamGoalByWeek: new Map([[W1, 79]]),
      repCount: 6,
    });
    expect(g).toMatchObject({ value: 14, basis: "rep-goal" });
    expect(g!.note).toContain("rep goal");
  });
  test("missing rep goal falls back to the team goal share, labeled as such", () => {
    const g = resolveRepGoal({
      weeks: [W1],
      repGoalsByWeek: new Map(),
      teamGoalByWeek: new Map([[W1, 79]]),
      repCount: 6,
    });
    expect(g!.basis).toBe("team-share");
    expect(g!.value).toBeCloseTo(79 / 6);
    expect(g!.note).toContain("team goal share");
    expect(formatCount(g!.value)).toBe("13.2");
  });
  test("team goal absent entirely falls back to the 79 default", () => {
    const g = resolveRepGoal({
      weeks: [W1],
      repGoalsByWeek: new Map(),
      teamGoalByWeek: new Map(),
      repCount: 6,
    });
    expect(g!.value).toBeCloseTo(79 / 6);
  });
  test("multi-week ranges sum weekly goals; mixed sources labeled 'mixed'", () => {
    const both = resolveRepGoal({
      weeks: [W1, W2],
      repGoalsByWeek: new Map([
        [W1, 12],
        [W2, 15],
      ]),
      teamGoalByWeek: new Map([[W1, 79]]),
      repCount: 6,
    });
    expect(both).toMatchObject({ value: 27, basis: "rep-goal" });
    const mixed = resolveRepGoal({
      weeks: [W1, W2],
      repGoalsByWeek: new Map([[W1, 12]]),
      teamGoalByWeek: new Map([[W2, 79]]),
      repCount: 6,
    });
    expect(mixed!.basis).toBe("mixed");
    expect(mixed!.value).toBeCloseTo(12 + 79 / 6);
    expect(mixed!.note).toContain("team share");
  });
  test("degenerate inputs (no weeks / no reps) yield no goal", () => {
    expect(resolveRepGoal({ weeks: [], repGoalsByWeek: new Map(), teamGoalByWeek: new Map(), repCount: 6 })).toBeNull();
    expect(resolveRepGoal({ weeks: [W1], repGoalsByWeek: new Map(), teamGoalByWeek: new Map(), repCount: 0 })).toBeNull();
  });
  test("buildRepDetail: achievement + signed difference; no goal → null (never 0%)", () => {
    const metrics: RepRangeMetrics = {
      repId: "r1",
      totalCalls: 10,
      callsOverThreshold: 4,
      bookingsFromOverThreshold: 2,
      totalBookings: 5,
      assignedLeads: 40,
      conversationConversion: 0.5,
      assignedLeadConversion: 0.125,
      avgCallDurationSeconds: 180,
    };
    const withGoal = buildRepDetail({
      rep: { id: "r1", name: "Rep One" },
      metrics,
      goal: { value: 14, basis: "rep-goal", note: "rep goal" },
      weeks: ["2026-09-21"],
    });
    expect(withGoal.goalAchievement).toBeCloseTo(5 / 14);
    expect(withGoal.differenceFromGoal).toBe(-9);
    const noGoal = buildRepDetail({ rep: { id: "r1", name: "R" }, metrics, goal: null, weeks: [] });
    expect(noGoal.goalAchievement).toBeNull();
    expect(noGoal.differenceFromGoal).toBeNull();
  });
});

describe("reps page formatters", () => {
  test("formatDiff signs and units", () => {
    expect(formatDiff(8.8235, "pct")).toBe("+8.8%");
    expect(formatDiff(-3.24, "pct")).toBe("-3.2%");
    expect(formatDiff(2.5999, "pp")).toBe("+2.6 pp");
    expect(formatDiff(0, "pp")).toBe("+0.0 pp");
    expect(formatDiff(45.4, "seconds")).toBe("+45 s");
    expect(formatDiff(null, "pct")).toBe("—");
  });
  test("formatDuration m/s and h/m", () => {
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(272)).toBe("4m 32s");
    expect(formatDuration(3600)).toBe("1h 00m");
    expect(formatDuration(3661)).toBe("1h 01m");
    expect(formatDuration(null)).toBe("—");
  });
  test("formatCount: whole numbers stay whole, shares get 1 decimal", () => {
    expect(formatCount(14)).toBe("14");
    expect(formatCount(79 / 6)).toBe("13.2");
    expect(formatCount(null)).toBe("—");
  });
  test("caption helper includes the year", () => {
    expect(formatDateHumanFull("2026-09-24")).toBe("Thu, Sep 24, 2026");
  });
});
