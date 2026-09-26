/**
 * Presentation-side compositions for the Reps-page redesign
 * (design/reps-redesign-spec.md). Everything here composes numbers the
 * metrics layer already produced (the getRepsData payload) — no new metrics,
 * no new queries, no redefined formulas:
 *  - "remaining" mirrors the metrics layer's own remaining semantics (Today
 *    page and buildTeamRangeMetrics): max(0, goal − actual).
 *  - pace expectation reuses weekElapsedWorkFraction (the Today redesign's
 *    expectedToDate basis): expected = weekly goal × work-week fraction.
 *  - coaching rules read the payload's own comparison rows (counts compare
 *    as %, rates as percentage points) and reuse the Today redesign's
 *    TEAMDENOM ≥ 3 gate (TREND_MIN_DENOMINATOR).
 */
import { formatDateHuman, weekElapsedWorkFraction, weekday } from "~/server/date-logic";
import { TREND_MIN_DENOMINATOR, type TeamComparison } from "~/server/metrics/compute";
import { formatCount, formatPercent } from "~/server/metrics/report-text";

// ---------- weekly goal progress (spec: WTD vs weekly goal — never range-day ÷ week) ----------

export interface GoalProgressView {
  wtd: number;
  goal: number | null;
  /** Ratio wtd ÷ weekly goal (null when no goal is resolvable). */
  achievement: number | null;
  remaining: number | null;
  /** Third cell of the goal block: the difference from goal in plain language. */
  remainingHero: string;
  remainingTone: "positive" | "neutral";
  remainingSub: string;
}

/**
 * Weekly goal progress from week-scoped bookings (WTD) and the weekly goal.
 * Plain-language difference per spec: "4 bookings remaining" / "2 above
 * weekly goal" — never a bare red "−11".
 */
export function goalProgress(input: { wtd: number; goalValue: number | null }): GoalProgressView {
  const goal = input.goalValue != null && input.goalValue > 0 ? input.goalValue : null;
  if (goal == null) {
    return {
      wtd: input.wtd,
      goal: null,
      achievement: null,
      remaining: null,
      remainingHero: "—",
      remainingTone: "neutral",
      remainingSub: "no booking goal resolvable for this range",
    };
  }
  const achievement = input.wtd / goal;
  const remaining = Math.max(0, goal - input.wtd);
  const diff = input.wtd - goal;
  if (diff > 0.0001) {
    return {
      wtd: input.wtd,
      goal,
      achievement,
      remaining: 0,
      remainingHero: formatCount(diff),
      remainingTone: "positive",
      remainingSub: "above weekly goal",
    };
  }
  if (diff >= -0.0001) {
    return {
      wtd: input.wtd,
      goal,
      achievement,
      remaining: 0,
      remainingHero: "0",
      remainingTone: "positive",
      remainingSub: "weekly goal reached",
    };
  }
  return {
    wtd: input.wtd,
    goal,
    achievement,
    remaining,
    remainingHero: formatCount(remaining),
    remainingTone: "neutral",
    remainingSub: Math.abs(remaining - 1) < 0.05 ? "booking remaining" : "bookings remaining",
  };
}

// ---------- coaching focus (spec: rule-based from real metrics — NO fake AI) ----------

export interface CoachingObservation {
  severity: "risk" | "positive";
  text: string;
}

const comparisonRow = (comparisons: TeamComparison[], metric: string): TeamComparison | null =>
  comparisons.find((c) => c.metric === metric) ?? null;

/**
 * Up to 3 coaching observations for the SELECTED rep, first-match-wins by
 * category (goal pace → conversation conversion → assigned lead conversion,
 * then positives). A rep with no recorded activity gets one honest sync/
 * assignment note instead of performance verdicts. Nothing noteworthy → []
 * (the panel renders "No major performance flags for the selected period.").
 */
export function coachingObservations(input: {
  repName: string;
  totalCalls: number;
  callsOverThreshold: number;
  totalBookings: number;
  assignedLeads: number;
  comparisons: TeamComparison[];
  teamAverages: {
    totalCalls: number | null;
    callsOverThreshold: number | null;
    conversationConversion: number | null;
    assignedLeadConversion: number | null;
  };
  /** Other reps carrying a conversation-conversion value in range (TEAMDENOM gate). */
  conversationOthers: number;
  /** Week-scoped goal figures; null when the range is multi-week (pace is a weekly notion). */
  goal: { wtd: number; goalValue: number; anchorDay: string } | null;
  today: string;
}): CoachingObservation[] {
  // 1 — no activity at all: a sync/assignment gap, not a performance verdict.
  if (input.totalCalls === 0 && input.totalBookings === 0) {
    return [
      {
        severity: "risk",
        text: `${input.repName} has no calls or bookings recorded in this range — verify sync or lead assignment.`,
      },
    ];
  }

  const risks: CoachingObservation[] = [];
  const positives: CoachingObservation[] = [];

  // 2 — weekly goal pace (week-scoped ranges only; anchor in the past or today).
  if (input.goal && input.goal.goalValue > 0 && input.goal.anchorDay <= input.today) {
    const expected = input.goal.goalValue * weekElapsedWorkFraction(input.goal.anchorDay);
    const gap = expected - input.goal.wtd;
    if (gap >= 0.5) {
      const wd = weekday(input.goal.anchorDay);
      risks.push(
        wd === 0 || wd === 6
          ? {
              severity: "risk",
              text: `Rep finished the week ${formatCount(gap)} bookings below the weekly goal (${formatCount(input.goal.wtd)} of ${formatCount(input.goal.goalValue)}).`,
            }
          : {
              severity: "risk",
              text: `Rep is ${formatCount(gap)} bookings behind weekly pace — ${formatCount(input.goal.wtd)} of ${formatCount(input.goal.goalValue)}, expected ≈ ${formatCount(expected)} by ${formatDateHuman(input.goal.anchorDay)}.`,
            },
      );
    }
  }

  // 3/4 — conversions vs team average, in percentage points. Both sides must
  // stand on ≥ TREND_MIN_DENOMINATOR qualifying reps (Today's TEAMDENOM gate)
  // so a thin denominator never produces a coaching verdict.
  const conv = comparisonRow(input.comparisons, "Conversation Conversion");
  const convRep = conv?.rep ?? null;
  const convTeam = conv?.teamAvg ?? null;
  const convValid =
    convRep != null &&
    convTeam != null &&
    input.callsOverThreshold >= TREND_MIN_DENOMINATOR &&
    input.conversationOthers >= TREND_MIN_DENOMINATOR;
  const asg = comparisonRow(input.comparisons, "Assigned Lead Conversion");
  const asgRep = asg?.rep ?? null;
  const asgTeam = asg?.teamAvg ?? null;
  const asgValid =
    asgRep != null && asgTeam != null && input.assignedLeads >= TREND_MIN_DENOMINATOR;

  if (convValid) {
    const pp = (convRep - convTeam) * 100;
    if (pp < 0) {
      const strongVolume =
        input.teamAverages.totalCalls != null && input.totalCalls > input.teamAverages.totalCalls;
      risks.push({
        severity: "risk",
        text: strongVolume
          ? `Call volume is above team average but conversation conversion is below average (${formatPercent(convRep, 1)} vs ${formatPercent(convTeam, 1)}).`
          : `Conversation conversion is ${Math.abs(pp).toFixed(1)} percentage points below team average (${formatPercent(convRep, 1)} vs ${formatPercent(convTeam, 1)}).`,
      });
    } else if (pp > 0) {
      positives.push({
        severity: "positive",
        text: `Conversation conversion is above team average (${formatPercent(convRep, 1)} vs ${formatPercent(convTeam, 1)}).`,
      });
    }
  }
  if (asgValid) {
    const pp = (asgRep - asgTeam) * 100;
    if (pp < 0) {
      risks.push({
        severity: "risk",
        text: `Assigned lead conversion is ${Math.abs(pp).toFixed(1)} percentage points below team average (${formatPercent(asgRep, 1)} vs ${formatPercent(asgTeam, 1)}).`,
      });
    } else if (pp > 0) {
      positives.push({
        severity: "positive",
        text: `Assigned lead conversion is above team average (${formatPercent(asgRep, 1)} vs ${formatPercent(asgTeam, 1)}).`,
      });
    }
  }

  // 5 — positives fill the remaining slots (goal hit first, then volume).
  if (input.goal && input.goal.goalValue > 0 && input.goal.wtd >= input.goal.goalValue) {
    positives.unshift({
      severity: "positive",
      text: `Weekly goal already reached (${formatCount(input.goal.wtd)} of ${formatCount(input.goal.goalValue)} bookings).`,
    });
  }
  if (
    input.teamAverages.callsOverThreshold != null &&
    input.callsOverThreshold > input.teamAverages.callsOverThreshold
  ) {
    positives.push({ severity: "positive", text: "Meaningful conversation volume is strong." });
  }

  return [...risks, ...positives].slice(0, 3);
}

// ---------- unassigned rollup (non-roster HighLevel users' calls) ----------

export interface UnassignedUserRollup {
  /** Display key: HL user id when known, "(no user)" when the call had none. */
  key: string;
  /** HighLevel user name when known — null renders as the raw HL user id. */
  name: string | null;
  externalId: string | null;
  calls: number;
  overThreshold: number;
}

export interface UnassignedRollup {
  users: UnassignedUserRollup[];
  totalCalls: number;
  totalOverThreshold: number;
}

/**
 * Rollup of the calls that are NOT roster-rep calls in the same window:
 * rep NULL (unknown HL user) or the rep is a roster-excluded user. This is the
 * exact complement of keepRosterRepCalls' kept set over the SAME call rows the
 * metrics layer used — never merged into roster or team totals, shown apart.
 * Sorted by call count desc (ties by key asc); a missing HL user name degrades
 * to the raw id.
 */
export function buildUnassignedRollup(input: {
  /** ALL calls in the window (the same array the metrics layer filtered). */
  calls: { rep_id: string | null; duration_seconds: number }[];
  /** Active-roster rep ids (the keepRosterRepCalls keep-set). */
  activeRepIds: Set<string>;
  /** rep_id → { name, external_id } for ALL users (roster or not). */
  userById: Map<string, { name: string; external_id: string }>;
  thresholdSeconds: number;
}): UnassignedRollup {
  const byUser = new Map<string, UnassignedUserRollup>();
  let totalCalls = 0;
  let totalOver = 0;
  for (const c of input.calls) {
    // unassigned = no rep OR rep not on the active roster (same predicate as
    // the audit endpoint's "unassigned" spec and keepRosterRepCalls' complement)
    if (c.rep_id && input.activeRepIds.has(c.rep_id)) continue;
    const u = c.rep_id ? input.userById.get(c.rep_id) : undefined;
    const key = u?.external_id ?? "(no user)";
    let row = byUser.get(key);
    if (!row) {
      row = { key, name: u?.name ?? null, externalId: u?.external_id ?? null, calls: 0, overThreshold: 0 };
      byUser.set(key, row);
    }
    row.calls += 1;
    if (c.duration_seconds > input.thresholdSeconds) row.overThreshold += 1;
    totalCalls += 1;
    if (c.duration_seconds > input.thresholdSeconds) totalOver += 1;
  }
  const users = [...byUser.values()].sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
  return { users, totalCalls, totalOverThreshold: totalOver };
}
