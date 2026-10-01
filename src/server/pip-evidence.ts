/**
 * PIP EVIDENCE ENGINE (Phase 2 — owner directive 9/30).
 *
 * Computes the per-week verified numbers for a PIP's review period by calling
 * the EXACT functions the dashboard pages already use. NO second calculation
 * engine lives here:
 *
 *   - Booking wins per rep per week ── same chain as repsPageData:
 *       store.getAppointmentsByWinBusinessDateBetween → filterApptsInWinBucketRange
 *       (win-bucket ET dates) → appointmentInScope (configurable Acuity scope,
 *       same getSettings() read) → applyAttributionEligibility (roster/mapping
 *       eligibility) → bookingsByRep (paid-deposit rule + rep ownership).
 *       A rep's weekly actual NEVER includes unattributed/online bookings —
 *       same rule as every rep metric in the dashboard.
 *   - Dashboard goal per week ── resolveRepGoal (rep_goals rows with the
 *       team-share fallback), one call per week with the SAME inputs the
 *       Reps/Today pages pass. Captured with its basis/note as provenance.
 *   - Week bucketing ── mondaysInRange/weekStart (Mon–Sun, America/New_York).
 *
 * The PIP's own weekly_goal_min (manager-entered on the draft) is the standard
 * the goal-met column evaluates: met = actual >= weekly_goal_min — a hard
 * per-week comparison, NEVER averaged across weeks (owner rule). When the
 * manager has not entered a weekly goal yet, met renders null ("not yet
 * evaluated") — never estimated.
 *
 * Honesty: a future week's actual is null ("—", not yet evaluated); the
 * current week's actual is a partial in-progress count and is labeled as such;
 * sync staleness raises warnings (WarningList) instead of silent zeros.
 * Nothing here scores, labels, or recommends — counts and comparisons only.
 */
import { etToday, etDayStartUtc, mondaysInRange, addDays, weekStart } from "./date-logic";
import {
  bookingsByRep,
  filterApptsInWinBucketRange,
  resolveRepGoal,
  type AppointmentRow,
  type AttributionRow,
  type GoalBasis,
} from "./metrics/compute";
import { appointmentInScope } from "./metrics/availability";
import { applyAttributionEligibility, applyRosterEligibility, buildRosterEligibility } from "./roster";
import { syncStaleWarnings } from "./queries";
import type { Store } from "./store/types";

/** State of one Mon–Sun week inside the review period (relative to `today`). */
export type PipWeekState = "completed" | "in_progress" | "future";

export interface PipEvidenceWeekRow {
  week_start: string; // Monday, YYYY-MM-DD
  week_end: string; // Sunday, YYYY-MM-DD
  /** Intersection of the Mon–Sun week with the review period (defaults are week-aligned; clamps guard partial edge weeks). */
  clamped_start: string;
  clamped_end: string;
  /** The PIP's weekly minimum (manager-entered standard) — null until the manager sets it. */
  pip_goal: number | null;
  /** Dashboard-resolved goal for this week (rep_goals with team-share fallback) + provenance. */
  dashboard_goal: number | null;
  dashboard_goal_basis: GoalBasis | null;
  dashboard_goal_note: string | null;
  /** Paid booking wins attributed to the rep in the clamped window. Null ONLY for future weeks. */
  actual: number | null;
  /** actual >= pip_goal, evaluated ONLY for completed weeks — null otherwise (never averaged). */
  met: boolean | null;
  state: PipWeekState;
}

export interface PipEvidence {
  computed_at: string; // ISO
  today: string; // ET anchor date the evidence was computed against
  rep_id: string;
  rep_name: string;
  rep_call_start_date: string | null;
  review_start: string;
  review_end: string;
  /** Active roster size used for the team-share fallback (same getUsers() list the pages use). */
  rep_count: number;
  weekly: PipEvidenceWeekRow[];
  weeks_completed: number; // completed work weeks in the review period
  weeks_goal_met: number; // of those, met the PIP weekly minimum
  goal_hit_rate_pct: number | null; // 100 * weeks_goal_met / weeks_completed (1 decimal), null when no completed weeks
  /** Sum of actuals over non-future weeks (completed + in-progress partial). */
  total_wins_to_date: number;
  /** Sum of actuals over COMPLETED weeks only (the statement basis). */
  total_wins_completed_weeks: number;
  /** The rep's dashboard goal for the CURRENT week (resolveRepGoal incl. fallback provenance). */
  current_dashboard_goal: { value: number; basis: GoalBasis; note: string } | null;
  current_week_start: string; // Monday of `today`'s week
  hard_weekly_minimum: boolean;
  warnings: string[];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Human short ET date for statements/UI ("Sep 21") — deterministic formatting of a stored YYYY-MM-DD. */
export function pipDateShort(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Goal number for statements/UI: integers plain, fractions to exactly 1 decimal (team-share fallback). */
export function pipGoalLabel(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round1(n));
}

export interface PipEvidenceInput {
  repId: string;
  reviewStart: string; // YYYY-MM-DD
  reviewEnd: string; // YYYY-MM-DD
  weeklyGoalMin: number | null;
  hardWeeklyMinimum: boolean;
  /** Injected ET today for deterministic tests (defaults to the real ET clock). */
  today?: string;
}

/**
 * Load + compute the evidence for one rep over one review period. Pure-with
 * respect to the store: every number traces to a store row through the same
 * helpers the pages use. Throws only on structurally invalid input (bad
 * dates / unknown rep) — missing DATA degrades to nulls + warnings, never.
 */
export async function pipEvidenceCore(store: Store, input: PipEvidenceInput): Promise<PipEvidence> {
  const today = input.today ?? etToday();
  const reviewStart = input.reviewStart;
  const reviewEnd = input.reviewEnd;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewStart) || !/^\d{4}-\d{2}-\d{2}$/.test(reviewEnd)) {
    throw new Error("Review period needs YYYY-MM-DD start and end dates");
  }
  if (reviewEnd < reviewStart) {
    throw new Error(`Review period end (${reviewEnd}) cannot precede its start (${reviewStart})`);
  }

  const [settings, allUsers, rosterUsers, apptsRaw, attributions, connections] = await Promise.all([
    store.getSettings(),
    store.getAllUsers(),
    store.getUsers(),
    store.getAppointmentsByWinBusinessDateBetween(reviewStart, reviewEnd),
    store.getAttributions(),
    store.getConnections(),
  ]);

  const rep = allUsers.find((u) => u.id === input.repId);
  if (!rep) throw new Error("Unknown rep — pick a rep from this database");
  const repCount = rosterUsers.length; // team-share fallback denominator, same as the pages

  // ROSTER ELIGIBILITY — the same query-time gate repsPageData applies.
  const eligibility = buildRosterEligibility(allUsers, settings.rep_mappings ?? []);
  const lookBackStart = addDays(reviewStart, -Math.ceil(settings.attribution_window_hours / 24) - 1);
  const lookBackCalls = applyRosterEligibility(await store.getAllCallsSince(etDayStartUtc(lookBackStart)), eligibility);
  const attributionsEligible = applyAttributionEligibility(attributions, lookBackCalls, eligibility);

  // In-scope wins over the whole review period (one store read, then pure
  // per-week windowing — the same filter chain the pages run).
  const appts: AppointmentRow[] = filterApptsInWinBucketRange(apptsRaw, reviewStart, reviewEnd).filter((a) =>
    appointmentInScope(a, settings.acuity),
  );

  // Goals: the exact per-week maps the pages build (per-week rep_goals rows +
  // team goal, then resolveRepGoal — the SAME resolution the pages run).
  const weeks = mondaysInRange(weekStart(reviewStart), reviewEnd);
  const currentWeekStart = weekStart(today);
  const repGoalsByWeek = new Map<string, number>();
  const teamGoalByWeek = new Map<string, number>();
  await Promise.all(
    weeks.map(async (w) => {
      const [goalRows, teamRow] = await Promise.all([store.getRepGoals(w), store.getTeamGoal(w)]);
      for (const g of goalRows) if (g.rep_id === input.repId) repGoalsByWeek.set(g.week_start, g.goal);
      if (teamRow) teamGoalByWeek.set(teamRow.week_start, teamRow.booking_goal);
    }),
  );
  // The CURRENT week's dashboard goal is provenance context (the goal in
  // force at issue) — load it even when it sits outside the review period.
  if (!repGoalsByWeek.has(currentWeekStart) && !teamGoalByWeek.has(currentWeekStart)) {
    const [goalRows, teamRow] = await Promise.all([store.getRepGoals(currentWeekStart), store.getTeamGoal(currentWeekStart)]);
    for (const g of goalRows) if (g.rep_id === input.repId) repGoalsByWeek.set(g.week_start, g.goal);
    if (teamRow) teamGoalByWeek.set(teamRow.week_start, teamRow.booking_goal);
  }
  const currentDashboardGoal = repGoalsByWeek.has(currentWeekStart) || teamGoalByWeek.has(currentWeekStart)
    ? resolveRepGoal({ weeks: [currentWeekStart], repGoalsByWeek, teamGoalByWeek, repCount })
    : null;

  const warnings: string[] = syncStaleWarnings(connections);

  const weekly: PipEvidenceWeekRow[] = [];
  for (const ws of weeks) {
    const weekEnd = addDays(ws, 6);
    const clampedStart = ws < reviewStart ? reviewStart : ws;
    const clampedEnd = weekEnd > reviewEnd ? reviewEnd : weekEnd;
    const state: PipWeekState = clampedEnd < today ? "completed" : clampedStart <= today ? "in_progress" : "future";
    let actual: number | null = null;
    if (state !== "future") {
      const weekAppts = filterApptsInWinBucketRange(appts, clampedStart, clampedEnd);
      actual = bookingsByRep(weekAppts, attributionsEligible).get(input.repId) ?? 0;
    }
    const resolved = resolveRepGoal({ weeks: [ws], repGoalsByWeek, teamGoalByWeek, repCount });
    const met = state === "completed" && input.weeklyGoalMin != null && actual != null
      ? actual >= input.weeklyGoalMin
      : null;
    weekly.push({
      week_start: ws,
      week_end: weekEnd,
      clamped_start: clampedStart,
      clamped_end: clampedEnd,
      pip_goal: input.weeklyGoalMin,
      dashboard_goal: resolved?.value ?? null,
      dashboard_goal_basis: resolved?.basis ?? null,
      dashboard_goal_note: resolved?.note ?? null,
      actual,
      met,
      state,
    });
  }

  const completed = weekly.filter((w) => w.state === "completed");
  const weeksGoalMet = completed.filter((w) => w.met === true).length;
  const totalToDate = weekly.reduce((sum, w) => sum + (w.actual ?? 0), 0);
  const totalCompleted = completed.reduce((sum, w) => sum + (w.actual ?? 0), 0);

  return {
    computed_at: new Date().toISOString(),
    today,
    rep_id: input.repId,
    rep_name: rep.name,
    rep_call_start_date: rep.call_start_date ?? null,
    review_start: reviewStart,
    review_end: reviewEnd,
    rep_count: repCount,
    weekly,
    weeks_completed: completed.length,
    weeks_goal_met: weeksGoalMet,
    goal_hit_rate_pct: completed.length > 0 ? round1((100 * weeksGoalMet) / completed.length) : null,
    total_wins_to_date: totalToDate,
    total_wins_completed_weeks: totalCompleted,
    current_dashboard_goal: currentDashboardGoal,
    current_week_start: currentWeekStart,
    hard_weekly_minimum: input.hardWeeklyMinimum === true,
    warnings,
  };
}
