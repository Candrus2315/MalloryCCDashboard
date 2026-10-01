/**
 * FIXED FACTUAL STATEMENTS (Phase 2 — owner-approved pattern, 9/30).
 *
 * Deterministic string templates over VERIFIED evidence data. Explicitly NOT
 * AI: no subjective language, no recommendations, no conclusions — every
 * sentence is a pure function of the stored numbers and states exactly what
 * they are (dates and counts). All statements live in this ONE module so the
 * approved wording stays reviewable in a single file.
 *
 * A statement renders only when every placeholder has a verified value; when
 * the manager has not entered the weekly goal (or no weeks are completed yet),
 * the statement is simply absent from the list and the UI's caption explains
 * what is needed — never a placeholder number.
 */
import { pipDateShort, pipGoalLabel, type PipEvidence } from "./pip-evidence";

export interface PipFactStatement {
  /** Stable key (snapshot + UI tests reference these). */
  key: string;
  text: string;
}

function weekLabel(w: { week_start: string; week_end: string }): string {
  return `${pipDateShort(w.week_start)} – ${pipDateShort(w.week_end)}`;
}

export interface PipStatementInput {
  repName: string;
  /** The PIP's weekly minimum — THE goal the statements reference (manager-entered). */
  weeklyGoalMin: number;
  hardWeeklyMinimum: boolean;
  reviewStart: string;
  reviewEnd: string;
  weeksReviewed: number; // completed work weeks
  weeksGoalMet: number;
  goalHitRatePct: number | null;
  totalWinsCompletedWeeks: number;
  firstCompletedWeek: { week_start: string; week_end: string; actual: number } | null;
  bestCompletedWeek: { week_start: string; week_end: string; actual: number } | null;
  lastCompletedWeekEnd: string | null;
}

/**
 * The owner-approved core statement, verbatim pattern:
 * "{REP_NAME}'s current weekly booking goal is {CURRENT_GOAL}. During the
 * previous {WEEKS_REVIEWED} completed work weeks, {REP_NAME} met or exceeded
 * the weekly booking goal {WEEKS_GOAL_MET} time(s), representing
 * {GOAL_HIT_RATE}% of the reviewed weeks."
 */
export function goalWeeksStatement(input: PipStatementInput): string {
  const rate = input.goalHitRatePct == null ? "—" : String(input.goalHitRatePct);
  return (
    `${input.repName}'s current weekly booking goal is ${pipGoalLabel(input.weeklyGoalMin)}. ` +
    `During the previous ${input.weeksReviewed} completed work weeks, ${input.repName} met or exceeded ` +
    `the weekly booking goal ${input.weeksGoalMet} time(s), representing ${rate}% of the reviewed weeks.`
  );
}

/**
 * Build the full statement list for an evidence payload. Order is fixed (the
 * document reads top-to-bottom the same way every time). Returns [] when the
 * goal is unset or no completed weeks exist — the caller shows the honest
 * caption instead.
 */
export function buildPipStatements(input: PipStatementInput): PipFactStatement[] {
  if (!Number.isFinite(input.weeklyGoalMin) || input.weeksReviewed <= 0) return [];
  const out: PipFactStatement[] = [];

  // 1. Owner-approved core statement (goal + weeks met + hit rate).
  out.push({ key: "goal_weeks", text: goalWeeksStatement(input) });

  // 2. Total paid bookings credited across the reviewed weeks.
  const windowEnd = input.lastCompletedWeekEnd ?? input.reviewEnd;
  out.push({
    key: "total_wins",
    text:
      `Across the ${input.weeksReviewed} completed work week(s) reviewed ` +
      `(${pipDateShort(input.reviewStart)} – ${pipDateShort(windowEnd)}), ` +
      `${input.repName} was credited with ${input.totalWinsCompletedWeeks} paid booking(s).`,
  });

  // 3. Best week — highest count; ties resolve to the EARLIEST week (deterministic).
  if (input.bestCompletedWeek) {
    out.push({
      key: "best_week",
      text:
        `The highest weekly total in the reviewed weeks was ${input.bestCompletedWeek.actual} paid booking(s), ` +
        `in the week of ${weekLabel(input.bestCompletedWeek)}.`,
    });
  }

  // 4. First reviewed week.
  if (input.firstCompletedWeek) {
    out.push({
      key: "first_week",
      text:
        `In the first reviewed week (${weekLabel(input.firstCompletedWeek)}), ` +
        `${input.repName} was credited with ${input.firstCompletedWeek.actual} paid booking(s).`,
    });
  }

  // 5. Hard-minimum rule statement (only when the manager flagged the goal as a hard weekly minimum).
  if (input.hardWeeklyMinimum) {
    out.push({
      key: "hard_minimum",
      text:
        `The weekly booking goal of ${pipGoalLabel(input.weeklyGoalMin)} is a hard weekly minimum: ` +
        `each reviewed week is evaluated individually against ${pipGoalLabel(input.weeklyGoalMin)}; ` +
        `weeks are never averaged.`,
    });
  }

  return out;
}

/** Convenience: statements straight off a computed evidence payload. */
export function statementsFromEvidence(e: PipEvidence): PipFactStatement[] {
  const completed = e.weekly.filter((w) => w.state === "completed" && w.actual != null);
  const best = completed.reduce<{ week_start: string; week_end: string; actual: number } | null>((acc, w) => {
    if (acc == null || w.actual! > acc.actual) return { week_start: w.week_start, week_end: w.week_end, actual: w.actual! };
    return acc;
  }, null);
  const first = completed.length > 0 ? completed[0] : null;
  return buildPipStatements({
    repName: e.rep_name,
    weeklyGoalMin: e.weekly[0]?.pip_goal ?? Number.NaN,
    hardWeeklyMinimum: e.hard_weekly_minimum,
    reviewStart: e.review_start,
    reviewEnd: e.review_end,
    weeksReviewed: e.weeks_completed,
    weeksGoalMet: e.weeks_goal_met,
    goalHitRatePct: e.goal_hit_rate_pct,
    totalWinsCompletedWeeks: e.total_wins_completed_weeks,
    firstCompletedWeek: first ? { week_start: first.week_start, week_end: first.week_end, actual: first.actual! } : null,
    bestCompletedWeek: best,
    lastCompletedWeekEnd: completed.length > 0 ? completed[completed.length - 1].clamped_end : null,
  });
}
