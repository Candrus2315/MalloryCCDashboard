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
  TREND_MIN_DENOMINATOR,
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
 * One optional chip per rep, first match wins: top bookings (unique max, >0)
 * → "Top performer"; conversation conversion above the team average of
 * qualifying reps (≥ TREND_MIN_DENOMINATOR with a value — the same thin-
 * denominator gate the trends use) → "Strong conversion"; no recorded
 * activity → "No activity"; calls but no bookings → "Needs attention".
 * Reps with bookings below average get NO chip — per-rep goals are not in
 * this page's payload, so "below pace" would be an invented grade.
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
    if (maxBookings > 0 && topCount === 1 && r.totalBookings === maxBookings) {
      chips.set(r.id, { kind: "positive", label: "Top performer" });
    } else if (r.conversationConversion != null && convAvg != null && r.conversationConversion > convAvg) {
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

  // 4 — silent rep: honest sync/assignment gap, not a performance verdict
  const anyActivity = input.repRows.some((r) => r.totalBookings > 0 || r.callsOverThreshold > 0);
  if (anyActivity) {
    const silent = input.repRows.find((r) => r.totalBookings === 0 && r.callsOverThreshold === 0);
    if (silent) {
      notes.push({
        severity: "risk",
        rep: silent.name,
        text: `${silent.name} has no calls or bookings recorded in this range — verify sync or lead assignment.`,
      });
    }
    const noBookings = input.repRows.find((r) => r.callsOverThreshold > 0 && r.totalBookings === 0);
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
