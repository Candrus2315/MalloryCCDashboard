/**
 * FIXED FACTUAL STATEMENTS — exact-string pinning (Phase 2).
 *
 * The statements are DETERMINISTIC TEMPLATES over verified evidence (owner
 * directive 9/30: no AI, no subjective language — every sentence is a pure
 * function of stored numbers). These tests pin the approved wording so it
 * cannot drift silently: any wording change must land as an intentional,
 * reviewable diff here.
 */
import { describe, expect, test } from "bun:test";
import { buildPipStatements, goalWeeksStatement, statementsFromEvidence, type PipStatementInput } from "../pip-statements";
import type { PipEvidence } from "../pip-evidence";

const base = (): PipStatementInput => ({
  repName: "Carmine Morgano",
  weeklyGoalMin: 12,
  hardWeeklyMinimum: true,
  reviewStart: "2026-09-21",
  reviewEnd: "2026-10-11",
  weeksReviewed: 3,
  weeksGoalMet: 2,
  goalHitRatePct: 66.7,
  totalWinsCompletedWeeks: 29,
  firstCompletedWeek: { week_start: "2026-09-21", week_end: "2026-09-27", actual: 9 },
  bestCompletedWeek: { week_start: "2026-09-28", week_end: "2026-10-04", actual: 12 },
  lastCompletedWeekEnd: "2026-10-11",
});

describe("goalWeeksStatement (owner-approved core, verbatim)", () => {
  test("integer goal", () => {
    expect(goalWeeksStatement(base())).toBe(
      "Carmine Morgano's current weekly booking goal is 12. " +
        "During the previous 3 completed work weeks, Carmine Morgano met or exceeded " +
        "the weekly booking goal 2 time(s), representing 66.7% of the reviewed weeks.",
    );
  });
  test("fractional goal renders to exactly 1 decimal (team-share fallback goals)", () => {
    const s = goalWeeksStatement({ ...base(), weeklyGoalMin: 39.5 });
    expect(s.startsWith("Carmine Morgano's current weekly booking goal is 39.5. ")).toBe(true);
    expect(s.includes("39.50")).toBe(false);
  });
  test("null hit rate renders the honest em dash, never a 0", () => {
    const s = goalWeeksStatement({ ...base(), goalHitRatePct: null });
    expect(s.endsWith("representing —% of the reviewed weeks.")).toBe(true);
  });
});

describe("buildPipStatements — fixed order, exact wording", () => {
  test("full set in the fixed order with exact strings", () => {
    const out = buildPipStatements(base());
    expect(out.map((s) => s.key)).toEqual(["goal_weeks", "total_wins", "best_week", "first_week", "hard_minimum"]);
    expect(out.map((s) => s.text)).toEqual([
      "Carmine Morgano's current weekly booking goal is 12. During the previous 3 completed work weeks, Carmine Morgano met or exceeded the weekly booking goal 2 time(s), representing 66.7% of the reviewed weeks.",
      "Across the 3 completed work week(s) reviewed (Sep 21 – Oct 11), Carmine Morgano was credited with 29 paid booking(s).",
      "The highest weekly total in the reviewed weeks was 12 paid booking(s), in the week of Sep 28 – Oct 4.",
      "In the first reviewed week (Sep 21 – Sep 27), Carmine Morgano was credited with 9 paid booking(s).",
      "The weekly booking goal of 12 is a hard weekly minimum: each reviewed week is evaluated individually against 12; weeks are never averaged.",
    ]);
  });
  test("no hard-minimum flag → the hard_minimum statement is absent (not blanked)", () => {
    const out = buildPipStatements({ ...base(), hardWeeklyMinimum: false });
    expect(out.map((s) => s.key)).toEqual(["goal_weeks", "total_wins", "best_week", "first_week"]);
  });
  test("best-week tie resolves to the EARLIEST week (deterministic, no judgement)", () => {
    const out = buildPipStatements({
      ...base(),
      bestCompletedWeek: { week_start: "2026-09-21", week_end: "2026-09-27", actual: 12 },
    });
    expect(out.find((s) => s.key === "best_week")!.text).toBe(
      "The highest weekly total in the reviewed weeks was 12 paid booking(s), in the week of Sep 21 – Sep 27.",
    );
  });
  test("unset goal or zero reviewed weeks → NO statements at all (UI shows the caption)", () => {
    expect(buildPipStatements({ ...base(), weeklyGoalMin: Number.NaN })).toEqual([]);
    expect(buildPipStatements({ ...base(), weeksReviewed: 0 })).toEqual([]);
  });
});

/** Minimal hand-built evidence payload mirroring the engine's shape for one completed week. */
const evidence = (over: Partial<PipEvidence> = {}): PipEvidence => ({
  computed_at: "2026-10-01T12:00:00.000Z",
  today: "2026-10-01",
  rep_id: "rep-1",
  rep_name: "Carmine Morgano",
  rep_call_start_date: null,
  review_start: "2026-09-21",
  review_end: "2026-09-27",
  rep_count: 2,
  weekly: [
    {
      week_start: "2026-09-21",
      week_end: "2026-09-27",
      clamped_start: "2026-09-21",
      clamped_end: "2026-09-27",
      pip_goal: 6,
      dashboard_goal: 40,
      dashboard_goal_basis: "team-share",
      dashboard_goal_note: "team goal share — weekly team goal ÷ 2 reps",
      actual: 9,
      met: true,
      state: "completed",
    },
  ],
  weeks_completed: 1,
  weeks_goal_met: 1,
  goal_hit_rate_pct: 100,
  total_wins_to_date: 9,
  total_wins_completed_weeks: 9,
  current_dashboard_goal: { value: 40, basis: "team-share", note: "team goal share — weekly team goal ÷ 2 reps" },
  current_week_start: "2026-09-28",
  hard_weekly_minimum: false,
  warnings: [],
  ...over,
});

describe("statementsFromEvidence (evidence → statements, the issue-path seam)", () => {
  test("derives the same statements buildPipStatements would from the evidence payload", () => {
    const out = statementsFromEvidence(evidence());
    expect(out.map((s) => s.key)).toEqual(["goal_weeks", "total_wins", "best_week", "first_week"]);
    expect(out.find((s) => s.key === "goal_weeks")!.text).toBe(
      "Carmine Morgano's current weekly booking goal is 6. During the previous 1 completed work weeks, Carmine Morgano met or exceeded the weekly booking goal 1 time(s), representing 100% of the reviewed weeks.",
    );
    expect(out.find((s) => s.key === "first_week")!.text).toBe(
      "In the first reviewed week (Sep 21 – Sep 27), Carmine Morgano was credited with 9 paid booking(s).",
    );
  });
  test("no completed weeks with actuals → empty list (honest caption path)", () => {
    expect(
      statementsFromEvidence(evidence({ weeks_completed: 0, weeks_goal_met: 0, goal_hit_rate_pct: null, weekly: [] })),
    ).toEqual([]);
  });
});
