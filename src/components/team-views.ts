/**
 * Presentation-side compositions for the Team-page redesign
 * (design/team-redesign-spec.md, "Phase 6"). Everything here composes numbers
 * the metrics layer already produced (the getTeamData payload) — no new
 * metrics, no new queries, no redefined formulas:
 *  - paceSummary rearranges buildTeamRangeMetrics' own goal/pace outputs into
 *    the spec's one-unit pacing sentence ("51 of 79 bookings · 64.6% achieved
 *    · 28 remaining · 28 needed today"). Weekends (pace=0) surface the
 *    metrics layer's honest paceNote verbatim instead of inventing a number.
 *  - leadPacing only SUMS the payload's own trend buckets (leads, budgetRef)
 *    — the same aggregation the trend chart draws — to answer "are we getting
 *    enough leads" at range scope.
 *  - rep chips + attention notes are rule-based from real payload values
 *    (spec §5/§6: NO grades, NO gamification, NO fake AI).
 */
import { isWorkday } from "~/server/date-logic";
import {
  MIN_CONVERSION_SAMPLE,
  TREND_MIN_DENOMINATOR,
  type ComparisonUnit,
  type TeamRangeMetrics,
  type TrendBucketMode,
  type TrendPoint,
} from "~/server/metrics/compute";
import type { RepStripRow } from "~/server/queries";
import { formatCount, formatInt, formatPercent } from "~/server/metrics/report-text";
import type { AttentionNote, ChipView } from "./today-views";

// ---------- goal pacing (spec §2: the weekly pace module reads as ONE unit) ----------

export interface PaceSummary {
  actual: number;
  goalValue: number;
  achieved: string | null;
  remaining: string;
  /** "28 needed per working day" · weekend honesty · ended-range honesty. */
  paceClause: string;
  /** Metrics layer's own pace basis note, shown when pace is active. */
  paceFootnote: string | null;
  /** 0–100, capped at 100 (over-achievement fills the bar). */
  barPct: number | null;
  hit: boolean;
}

/**
 * The spec's pacing sentence, from the payload's own numbers. paceNeeded>0 →
 * "per working day" (or "today" on the last working day, where the two are
 * the same thing). paceNeeded=0 with the range still open → weekend: "0
 * needed today" plus the metrics layer's own note. Ended range → no pace.
 */
export function paceSummary(input: { metrics: TeamRangeMetrics; rangeEnd: string; today: string }): PaceSummary {
  const m = input.metrics;
  const base: PaceSummary = {
    actual: m.actual,
    goalValue: m.goal.value,
    achieved: null,
    remaining: formatCount(m.remaining),
    paceClause: m.paceNote,
    paceFootnote: null,
    barPct: null,
    hit: false,
  };
  if (!(m.goal.value > 0) || m.goalAchievement == null) return base;

  let paceClause: string;
  let paceFootnote: string | null = null;
  if (input.rangeEnd < input.today) {
    paceClause = "No pace needed — range already ended.";
  } else if (m.paceNeeded > 0) {
    paceClause =
      m.paceDaysLeft === 1
        ? `${formatInt(m.paceNeeded)} needed today (last working day)`
        : `${formatInt(m.paceNeeded)} needed per working day`;
    paceFootnote = m.paceNote;
  } else {
    paceClause = `0 needed today · ${m.paceNote}`;
  }
  return {
    actual: m.actual,
    goalValue: m.goal.value,
    achieved: formatPercent(m.goalAchievement, 1),
    remaining: formatCount(m.remaining),
    paceClause,
    paceFootnote,
    barPct: Math.min(m.goalAchievement, 1) * 100,
    hit: m.goalAchievement >= 1,
  };
}

// ---------- lead volume vs budget pace (spec §4: "are we getting enough leads?") ----------

export interface LeadPacing {
  leads: number;
  budget: number;
  ratio: number | null;
  /** "Above budget pace" / "Below budget pace" / "On budget pace" / null (no budget). */
  verdict: string | null;
  /** "+12 leads" / "−8 leads" — null when on pace or no budget. */
  delta: string | null;
  /** "104% of budget pace" — null when no budget. */
  pct: string | null;
}

/**
 * Range-scope lead pacing: sums the payload's own trend buckets (leads by
 * work_date; budgetRef = weekly budget per week bucket, budget ÷ 7 per day
 * bucket). Comparison is against the budget ROUNDED to whole leads so a
 * float-dust difference never reads "Above by 0.3 leads".
 */
export function leadPacing(points: TrendPoint[]): LeadPacing {
  const leads = points.reduce((a, p) => a + p.leads, 0);
  const budget = points.reduce((a, p) => a + p.budgetRef, 0);
  if (!(budget > 0)) return { leads, budget, ratio: null, verdict: null, delta: null, pct: null };
  const ratio = leads / budget;
  const rd = Math.round(leads - budget);
  if (rd === 0) return { leads, budget, ratio, verdict: "On budget pace", delta: null, pct: formatPercent(ratio, 0) };
  const verdict = rd > 0 ? "Above budget pace" : "Below budget pace";
  const delta = `${rd > 0 ? "+" : "−"}${formatInt(Math.abs(rd))} ${Math.abs(rd) === 1 ? "lead" : "leads"}`;
  return { leads, budget, ratio, verdict, delta, pct: formatPercent(ratio, 0) };
}

// ---------- by-rep status chips (spec §5: real metrics only, one per rep max) ----------

/**
 * One optional chip per rep, FIRST match wins (spec §5 + ux-charts-tables-spec
 * §9/§10): "Not Yet Active" (call_start_date in the future — visible, zero
 * calls expected, no other chip) → top bookings (unique max, >0) → "Top
 * performer"; conversation conversion EXCEEDING the team average of qualifying
 * reps → "Strong conversion" — but ONLY with a genuine sample: the rep needs
 * callsOverThreshold > 0 AND ≥ MIN_CONVERSION_SAMPLE qualifying calls, and the
 * team average must exist (≥ TREND_MIN_DENOMINATOR reps with a value — the
 * thin-denominator gate the trends use). A rep at 0.0% (or on an all-zero
 * team) never earns it; no chip is auto-substituted in its place.
 * No recorded activity → "No activity"; calls but no bookings → "Needs
 * attention" (both skipped for not-yet-active reps). Reps with bookings below
 * average get NO chip — per-rep goals are not in this page's payload, so
 * "below pace" would be an invented grade.
 */
export function repChips(rows: RepStripRow[]): Map<string, ChipView> {
  const withConv = rows.filter((r) => r.conversationConversion != null);
  const convAvg =
    withConv.length >= TREND_MIN_DENOMINATOR
      ? withConv.reduce((a, r) => a + (r.conversationConversion ?? 0), 0) / withConv.length
      : null;
  const maxBookings = rows.reduce((a, r) => Math.max(a, r.totalBookings), 0);
  const topCount = rows.filter((r) => r.totalBookings === maxBookings && maxBookings > 0).length;

  const chips = new Map<string, ChipView>();
  for (const r of rows) {
    if (r.operatingState === "not-yet-active") {
      chips.set(r.id, { kind: "neutral", label: "Not Yet Active" });
    } else if (maxBookings > 0 && topCount === 1 && r.totalBookings === maxBookings) {
      chips.set(r.id, { kind: "positive", label: "Top performer" });
    } else if (
      r.conversationConversion != null &&
      convAvg != null &&
      r.callsOverThreshold > 0 &&
      r.callsOverThreshold >= MIN_CONVERSION_SAMPLE &&
      r.conversationConversion > convAvg
    ) {
      chips.set(r.id, { kind: "positive", label: "Strong conversion" });
    } else if (r.totalBookings === 0 && r.callsOverThreshold === 0) {
      chips.set(r.id, { kind: "neutral", label: "No activity" });
    } else if (r.totalBookings === 0 && r.callsOverThreshold > 0) {
      chips.set(r.id, { kind: "risk", label: "Needs attention" });
    }
  }
  return chips;
}

// ---------- team attention (spec §6: rule-based, 3–5 notes, no fake AI) ----------

/**
 * Up to 5 management notes from real payload metrics, risks first. Rules:
 * goal pace → pace vs recent daily booking average (day-bucketed ranges only)
 * → top rep → silent rep → leads vs budget pace → unavailable conversion.
 * Nothing noteworthy → [] (the panel renders its all-clear line).
 */
export function attentionNotes(input: {
  metrics: TeamRangeMetrics;
  points: TrendPoint[];
  bucketMode: TrendBucketMode;
  repRows: RepStripRow[];
  rangeEnd: string;
  today: string;
}): AttentionNote[] {
  const m = input.metrics;
  const notes: AttentionNote[] = [];

  // 1 — goal pacing (the page's primary story)
  if (m.goal.value > 0 && m.goalAchievement != null) {
    if (m.actual >= m.goal.value) {
      notes.push({
        severity: "positive",
        rep: "",
        text: `Booking goal reached: ${formatInt(m.actual)} of ${formatCount(m.goal.value)} bookings.`,
      });
    } else if (m.paceNeeded > 0) {
      notes.push({
        severity: "risk",
        rep: "",
        text: `Team is at ${formatPercent(m.goalAchievement, 1)} of goal with ${m.paceDaysLeft} working ${
          m.paceDaysLeft === 1 ? "day" : "days"
        } remaining — ${formatInt(m.paceNeeded)} bookings per working day needed.`,
      });
    } else if (input.rangeEnd < input.today) {
      notes.push({
        severity: "risk",
        rep: "",
        text: `Team finished the range at ${formatPercent(m.goalAchievement, 1)} of goal (${formatCount(
          m.remaining,
        )} bookings short).`,
      });
    } else {
      notes.push({
        severity: "risk",
        rep: "",
        text: `Team is at ${formatPercent(m.goalAchievement, 1)} of goal — ${formatCount(
          m.remaining,
        )} bookings remaining (${m.paceNote}).`,
      });
    }
  }

  // 2 — pace needed vs the recent daily booking average (day buckets only;
  //     pace is a weekly notion, so multi-week ranges skip this rule)
  if (input.bucketMode === "day" && m.paceNeeded > 0) {
    const workdayBuckets = input.points.filter((p) => isWorkday(p.key));
    const recent = workdayBuckets.slice(-5);
    if (recent.length >= TREND_MIN_DENOMINATOR) {
      const avg = recent.reduce((a, p) => a + p.bookings, 0) / recent.length;
      if (avg === 0) {
        notes.push({
          severity: "risk",
          rep: "",
          text: `No bookings in the last ${recent.length} working days — daily pace needed is ${formatInt(m.paceNeeded)}.`,
        });
      } else if (avg < m.paceNeeded) {
        notes.push({
          severity: "risk",
          rep: "",
          text: `Daily pace needed is ${formatInt(m.paceNeeded)}, above the recent daily booking average of ${formatCount(avg)}.`,
        });
      } else {
        notes.push({
          severity: "positive",
          rep: "",
          text: `Recent daily booking average (${formatCount(avg)}) already exceeds the pace needed (${formatInt(m.paceNeeded)}).`,
        });
      }
    }
  }

  // 3 — top rep (unique max only — a tie is not "the" top performer)
  const maxBookings = input.repRows.reduce((a, r) => Math.max(a, r.totalBookings), 0);
  if (maxBookings > 0) {
    const top = input.repRows.filter((r) => r.totalBookings === maxBookings);
    if (top.length === 1) {
      notes.push({
        severity: "positive",
        rep: top[0].name,
        text: `${top[0].name} leads the team in bookings (${formatInt(maxBookings)}).`,
      });
    }
  }

  // 4 — silent rep: honest sync/assignment gap, not a performance verdict.
  // "Not Yet Active" reps (call_start_date in the future) are EXPECTED to show
  // zero calls — they never trigger activity or attention rules (owner spec).
  const anyActivity = input.repRows.some((r) => r.totalBookings > 0 || r.callsOverThreshold > 0);
  if (anyActivity) {
    const silent = input.repRows.find(
      (r) => r.operatingState !== "not-yet-active" && r.totalBookings === 0 && r.callsOverThreshold === 0,
    );
    if (silent) {
      notes.push({
        severity: "risk",
        rep: silent.name,
        text: `${silent.name} has no calls or bookings recorded in this range — verify sync or lead assignment.`,
      });
    }
    const noBookings = input.repRows.find(
      (r) => r.operatingState !== "not-yet-active" && r.callsOverThreshold > 0 && r.totalBookings === 0,
    );
    if (noBookings) {
      notes.push({
        severity: "risk",
        rep: noBookings.name,
        text: `${noBookings.name} has ${formatInt(noBookings.callsOverThreshold)} calls over threshold but no bookings yet.`,
      });
    }
  }

  // 5 — lead volume vs budget pace
  const lp = leadPacing(input.points);
  if (lp.verdict === "Below budget pace") {
    notes.push({
      severity: "risk",
      rep: "",
      text: `Lead volume is below budget pace (${formatInt(lp.leads)} of ~${formatInt(Math.round(lp.budget))} expected).`,
    });
  } else if (lp.verdict === "Above budget pace") {
    notes.push({
      severity: "positive",
      rep: "",
      text: `Lead volume is above budget pace (${formatInt(lp.leads)} vs ~${formatInt(Math.round(lp.budget))}).`,
    });
  }

  // 6 — Assigned Lead Conversion unavailable in this range
  if (m.assignedLeads === 0 && m.totalBookings > 0) {
    notes.push({
      severity: "risk",
      rep: "",
      text:
        m.conversationConversion != null
          ? `Conversation conversion is ${formatPercent(m.conversationConversion, 1)}, but Assigned Lead Conversion is unavailable — no assigned leads were worked.`
          : "Assigned Lead Conversion is unavailable — no assigned leads were worked in this range.",
    });
  }

  const risks = notes.filter((n) => n.severity === "risk");
  const positives = notes.filter((n) => n.severity === "positive");
  return [...risks, ...positives].slice(0, 5);
}

// ---------- By-Rep table (merged-build Phase 4: §7 five-column management table) ----------

/** Sortable By-Rep columns — the §7 primary five. */
export type RepSortKey = "rep" | "bookings" | "calls" | "conv" | "avg-duration";

function repSortValue(r: RepStripRow, key: RepSortKey): number | string | null {
  switch (key) {
    case "rep":
      return r.name;
    case "bookings":
      return r.totalBookings;
    case "calls":
      return r.callsOverThreshold;
    case "conv":
      return r.conversationConversion;
    case "avg-duration":
      return r.avgCallDurationSeconds;
  }
}

/**
 * Native comparator for the By-Rep table. Rep name compares
 * lexicographically (direction-aware); every metric numerically. Missing
 * values sort LAST in both directions — never as zero (existing rule).
 */
export function compareRepRows(a: RepStripRow, b: RepStripRow, key: RepSortKey, asc: boolean): number {
  if (key === "rep") return a.name.localeCompare(b.name) * (asc ? 1 : -1);
  const av = repSortValue(a, key);
  const bv = repSortValue(b, key);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return ((av as number) - (bv as number)) * (asc ? 1 : -1);
}

/** Goal-cell math for the §7 Bookings column — exact numbers, bar as supplement (§8). */
export interface GoalCellView {
  /** Actual, whole ("8"). */
  actual: string;
  /** Goal with the explaining decimal ("15.8") — null when there is no goal. */
  goal: string | null;
  /** "50.6%" (1dp) — null when the ratio is undefined (no positive goal). */
  pct: string | null;
  /** 0–100 capped (over-achievement fills, never overflows) — null = no bar. */
  barPct: number | null;
  hit: boolean;
}

/**
 * "8 / 15.8" + 4px bar + "50.6%". A null goal → no bar, no pct ("—", never an
 * invented goal); a literal 0 goal renders "8 / 0" honestly but no pct (the
 * ratio is undefined, never ∞). E-strip payload (RepStripRow.goal) feeds it.
 */
export function goalCell(actual: number, goal: number | null): GoalCellView {
  if (goal == null) {
    return { actual: formatInt(actual), goal: null, pct: null, barPct: null, hit: false };
  }
  if (!(goal > 0)) {
    return { actual: formatInt(actual), goal: formatCount(goal), pct: null, barPct: null, hit: false };
  }
  const ratio = actual / goal;
  return {
    actual: formatInt(actual),
    goal: formatCount(goal),
    pct: formatPercent(ratio, 1),
    barPct: Math.min(ratio, 1) * 100,
    hit: ratio >= 1,
  };
}

// ---------- §11 restraint: thin-sample comparison diffs read as reference ----

/** Shared footnote for the comparison table when any diff is restrained. */
export const SMALL_SAMPLE_FOOTNOTE = "Small sample — difference shown for reference.";

/** The comparison-table row shape (compute.ts TeamComparison, structurally). */
export interface ComparisonRowLike {
  metric: string;
  teamAvg: number | null;
  diff: number | null;
  unit: ComparisonUnit;
}

/** The rep-side counts a diff's basis can rest on (compute.ts RepRangeMetrics fields). */
export interface RepSampleCounts {
  totalCalls: number;
  callsOverThreshold: number;
  bookingsFromOverThreshold: number;
  totalBookings: number;
  assignedLeads: number;
}

/**
 * The sample size a comparison row's diff rests on, from real payload counts:
 *  - count rows ("pct"): the SMALLER of rep count and team average — the
 *    "+700% vs an average of 0.5" case is exactly the misleading one, so the
 *    tiny side governs;
 *  - rate rows ("pp"): the rep's own rate denominator (qualifying calls for
 *    Conversation Conversion, assigned leads for Assigned Lead Conversion);
 *  - duration rows: the calls behind the rep's average.
 * Unknown metric labels → null (restrained — never shout on an unknown basis).
 */
export function diffSampleDenominator(row: ComparisonRowLike, rep: RepSampleCounts): number | null {
  const smaller = (a: number, b: number | null): number | null => (b == null ? a : Math.min(a, b));
  switch (row.metric) {
    case "Calls":
      return smaller(rep.totalCalls, row.teamAvg);
    case "Calls Over 2 Min":
      return smaller(rep.callsOverThreshold, row.teamAvg);
    case "Bookings From Calls Over 2 Minutes":
      return smaller(rep.bookingsFromOverThreshold, row.teamAvg);
    case "Conversation Conversion":
      return rep.callsOverThreshold;
    case "Total Bookings":
      return smaller(rep.totalBookings, row.teamAvg);
    case "Assigned Lead Conversion":
      return rep.assignedLeads;
    case "Average Call Duration":
      return rep.totalCalls;
    default:
      return null;
  }
}

/**
 * §11: a diff whose basis is a thin sample renders muted (stone-400, no
 * color/arrow emphasis — exact math kept) plus the shared footnote. Rate
 * denominators below TREND_MIN_DENOMINATOR (= 3), tiny count bases, and a
 * null diff (nothing to emphasize) all restrain. The "+700%" case stays valid
 * math with a restrained visual.
 */
export function restrainedDiff(diff: number | null, sampleDenominator: number | null): boolean {
  if (diff == null) return true;
  if (sampleDenominator == null) return true;
  return sampleDenominator < TREND_MIN_DENOMINATOR;
}
