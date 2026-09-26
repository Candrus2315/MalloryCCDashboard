/**
 * Presentation-side compositions for the Today-page redesign
 * (design/today-redesign-spec.md §0 + §6). EVERYTHING here is arithmetic on
 * numbers `buildTodayMetrics` already produced — no new metrics, no new
 * queries, no metric redefinitions. Team means reuse the EXACT semantics of
 * the metrics layer's `buildTeamAverages`:
 *   counts  = mean over all OTHER reps (zeros included)
 *   rates   = mean over other reps that have a value, null when none
 *   self    = always excluded
 * Deltas reuse the existing `teamDifference` units: rates in percentage
 * points (pp), counts in % difference, null when either side is null.
 */
import { daysLeftInWorkWeek, weekElapsedWorkFraction, weekday } from "~/server/date-logic";
import {
  TREND_MIN_DENOMINATOR,
  type AvailabilityRule,
  type RepPerformanceRow,
} from "~/server/metrics/compute";

export type ChipKind = "positive" | "risk" | "neutral";
export interface ChipView {
  kind: ChipKind;
  label: string;
}

// ---------- studio availability status (owner directive) ----------

/**
 * OWNER DIRECTIVE — availability status semantics. Low availability is GOOD
 * for Mallory (the studio is filling), so "low" must never read as negative.
 * Open-day ladder by OPEN-SLOT COUNT (not utilization): the Today payload
 * carries open slot labels only — there are no capacity/booked counts in the
 * data model, so a utilization (<60%) expression is not available without a
 * backend change; the open-count ladder is the cleaner one the data supports.
 *   0 open        → "fully-booked"  (quiet success)
 *   1–2 open      → "nearly-full"   (strong)
 *   3–5 open      → "openings-available" (neutral opportunity)
 *   6+ open       → "needs-bookings" (management attention, muted amber)
 * CLOSED days are labeled separately and NEVER merged into "fully booked" —
 * 0-open-because-booked and 0-open-because-closed are operationally different.
 */
export type AvailabilityStatus =
  | "fully-booked"
  | "nearly-full"
  | "openings-available"
  | "needs-bookings"
  | "closed";

export type AvailabilityTone = "positive" | "strong" | "neutral" | "attention" | "muted";

export interface AvailabilityStatusView {
  status: AvailabilityStatus;
  label: string;
  tone: AvailabilityTone;
}

/**
 * Closed test, presentation-side mirror of the open-slot engine
 * (compute.ts computeOpenSlots): a day is CLOSED iff no ACTIVE studio-hours
 * rule exists for its weekday. Same source data the engine already consumes —
 * `settings.studio.hours` ships in the Today payload, so no backend change.
 * Known gap (documented, not faked): a day with an ACTIVE rule whose hours
 * window is too short for even one appointment would also render 0 open and
 * read "Fully booked"; the upcoming Availability build owns fixing the data.
 */
export function studioClosedOn(date: string, hours: AvailabilityRule[]): boolean {
  return !hours.some((r) => r.weekday === weekday(date) && r.active);
}

/** The ladder. First match wins; closed always beats every open-day state. */
export function availabilityStatusView(openCount: number, closed: boolean): AvailabilityStatusView {
  if (closed) return { status: "closed", label: "Closed", tone: "muted" };
  if (openCount <= 0) return { status: "fully-booked", label: "Fully booked", tone: "positive" };
  if (openCount <= 2) return { status: "nearly-full", label: "Nearly full", tone: "strong" };
  if (openCount <= 5) return { status: "openings-available", label: "Openings available", tone: "neutral" };
  return { status: "needs-bookings", label: "Needs bookings", tone: "attention" };
}

/**
 * Selected-day message for the slot reveal panel (replaces the old ambiguous
 * "No open slots (closed or fully booked)."). Exact owner-directed copy.
 * null → the day has open slots; render the slot chips instead.
 */
export function availabilityDayMessage(status: AvailabilityStatus): string | null {
  if (status === "closed") return "Studio closed today.";
  if (status === "fully-booked") return "Fully booked for today.";
  return null;
}

export interface AttentionNote {
  severity: "risk" | "positive";
  text: string;
  rep: string;
}

/** OWNER-CORRECTED: working days only (Mon–Fri) — Mon 1/5 … Fri 5/5; Sat/Sun 5/5. */
export function weekElapsedFraction(reportDate: string): number {
  return weekElapsedWorkFraction(reportDate);
}

/** Spec §0 composition: expected bookings to date for a weekly goal. */
export function expectedToDate(goal: number, reportDate: string): number {
  return goal * weekElapsedFraction(reportDate);
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface TeamColumnMeans {
  totalCalls: number | null;
  totalBookings: number | null;
  conversationConversion: number | null;
  /** other reps carrying a non-null conversationConversion — the TEAMDENOM gate for attention rules §6.3-4/5 */
  conversationOthers: number;
  assignedLeadConversion: number | null;
}

/** Per-column team means over `rows`, excluding `repId` (buildTeamAverages semantics). */
export function teamMeansExcluding(rows: RepPerformanceRow[], repId: string): TeamColumnMeans {
  const others = rows.filter((r) => r.repId !== repId);
  const convOthers = others.map((r) => r.conversationConversion).filter((v): v is number => v != null);
  const assignedOthers = others.map((r) => r.assignedLeadConversion).filter((v): v is number => v != null);
  return {
    totalCalls: mean(others.map((r) => r.totalCalls)),
    totalBookings: mean(others.map((r) => r.totalBookings)),
    conversationConversion: mean(convOthers),
    conversationOthers: convOthers.length,
    assignedLeadConversion: mean(assignedOthers),
  };
}

export type DeltaUnit = "pct" | "pts";

/** Same units as the metrics layer's teamDifference: pts for rates, % for counts. */
export function deltaValue(rep: number | null, team: number | null, unit: DeltaUnit): number | null {
  if (rep == null || team == null) return null;
  if (unit === "pts") return (rep - team) * 100;
  if (team === 0) return null; // % difference undefined against a zero team average
  return ((rep - team) / team) * 100;
}

/** "+18.2 pts vs team" / "+14.3% vs team" — null hides the line entirely (never "0.0"). */
export function formatDelta(delta: number | null, unit: DeltaUnit): string | null {
  if (delta == null) return null;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}${unit === "pts" ? " pts" : "%"} vs team`;
}

/**
 * Status chip per spec §6.2 — FIRST MATCH WINS. Null-safe: every rule that
 * reads a nullable value checks it first. `teamConv` is the rep's team mean
 * Conversation Conversion (others only). A data gap is never labeled.
 */
export function chipFor(
  row: RepPerformanceRow,
  teamConv: number | null,
  weekElapsed: number,
): ChipView | null {
  if (row.goal === 0 && row.conversationConversion == null && row.totalCalls === 0) return null;
  if (row.goalPercent != null && row.goalPercent >= 1) return { kind: "positive", label: "Goal hit" };
  if (
    row.conversationConversion != null &&
    teamConv != null &&
    row.conversationConversion >= teamConv &&
    row.callsOverThreshold >= TREND_MIN_DENOMINATOR
  ) {
    return { kind: "positive", label: "Strong converter" };
  }
  if (
    row.conversationConversion != null &&
    teamConv != null &&
    row.conversationConversion < teamConv &&
    row.callsOverThreshold >= TREND_MIN_DENOMINATOR
  ) {
    return { kind: "risk", label: "Needs coaching" };
  }
  if (row.goal > 0 && row.actual < row.goal * weekElapsed) return { kind: "risk", label: "Below pace" };
  if (row.goal > 0) return { kind: "neutral", label: "On pace" };
  return null;
}

interface ScoredNote extends AttentionNote {
  group: 0 | 1 | 2; // 0 = pace risks, 1 = conversion deficits, 2 = positives
  score: number;
}

/**
 * Management Attention notes per spec §6.3 — per rep, FIRST MATCH WINS.
 * Panel order: at-risk first (behind pace by largest goal gap, then
 * conversion deficit in pts), positives last, capped at 5 (positives drop
 * first). Conversion rules require the team mean to stand on ≥
 * TREND_MIN_DENOMINATOR value-carrying reps (the spec's TEAMDENOM ≥ 3) —
 * the rep side is already null when its denominator is below it.
 */
export function attentionNotes(rows: RepPerformanceRow[], reportDate: string): AttentionNote[] {
  const weekElapsed = weekElapsedFraction(reportDate);
  const daysLeft = daysLeftInWorkWeek(reportDate); // working days only (Mon–Fri)
  const dayWord = daysLeft === 1 ? "day" : "days";
  const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
  const scored: ScoredNote[] = [];

  for (const r of rows) {
    // 1. No activity — a sync/assignment gap, not a performance verdict.
    if (r.totalCalls === 0 && r.totalBookings === 0) {
      scored.push({
        severity: "risk",
        group: 0,
        score: Math.max(0, r.goal * weekElapsed), // behind by the full expected-to-date amount
        rep: r.name,
        text: `${r.name} has no calls or bookings recorded this week — verify sync or lead assignment.`,
      });
      continue;
    }
    // 2. Goal hit.
    if (r.goalPercent != null && r.goalPercent >= 1) {
      scored.push({
        severity: "positive",
        group: 2,
        score: 0,
        rep: r.name,
        text: `${r.name} hit the weekly goal — ${r.actual} of ${r.goal}.`,
      });
      continue;
    }
    // 3. Behind pace.
    if (r.goal > 0 && r.actual < r.goal * weekElapsed) {
      scored.push({
        severity: "risk",
        group: 0,
        score: r.goal * weekElapsed - r.actual, // largest goal gap first
        rep: r.name,
        text:
          daysLeft === 0
            ? `${r.name} is behind pace — ${r.actual} of ${r.goal} bookings, and the work week is done. Pace resumes Monday.`
            : `${r.name} is behind pace — ${r.actual} of ${r.goal} bookings with ${daysLeft} ${dayWord} left (expected ≈ ${expectedToDate(r.goal, reportDate).toFixed(1)} by now).`,
      });
      continue;
    }
    // 4/5. Conversion vs team (both non-null, TEAMDENOM ≥ 3).
    const tm = teamMeansExcluding(rows, r.repId);
    const teamConvValid = tm.conversationConversion != null && tm.conversationOthers >= TREND_MIN_DENOMINATOR;
    if (teamConvValid && r.conversationConversion != null && r.conversationConversion < (tm.conversationConversion as number)) {
      const strongVolume = r.totalCalls >= (tm.totalCalls ?? 0) && (tm.totalCalls ?? 0) > 0;
      scored.push({
        severity: "risk",
        group: 1,
        score: ((tm.conversationConversion as number) - r.conversationConversion) * 100, // deficit in pts
        rep: r.name,
        text: strongVolume
          ? `${r.name} has strong call volume but below-team Conversation Conversion (${pct1(r.conversationConversion)} vs ${pct1(tm.conversationConversion as number)}).`
          : `${r.name} is below team average in Conversation Conversion (${pct1(r.conversationConversion)} vs ${pct1(tm.conversationConversion as number)}).`,
      });
    }
  }

  scored.sort((a, b) => a.group - b.group || b.score - a.score);
  return scored.slice(0, 5).map(({ severity, text, rep }) => ({ severity, text, rep }));
}
