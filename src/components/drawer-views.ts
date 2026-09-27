/**
 * Drawer + tooltip content compositions (merged-build Phase 3).
 *
 * Pure, DOM-free, unit-testable: everything here composes numbers the metrics
 * layer already produced (TrendPoint) and rows the audit endpoint already
 * returns (AuditCallRow) — no new metrics, no new queries, no redefined
 * formulas. The §16 rule lives here in one place: a drawer's record count is
 * reconciled against the chart point it was opened from, and the tooltip never
 * shows a bare percentage — always the numerator + denominator components.
 *
 * Honesty rules carried over from the rest of the dashboard:
 *  - null values render "—", never 0 (thin buckets / unavailable denominators);
 *  - partial buckets (today / in-progress week) are labeled, never passed off
 *    as final;
 *  - non-working days are "(closed)", never a fake zero;
 *  - record-level rows that are not payload'd yet are SAID to be missing —
 *    cohort dates/totals/components only, never invented rows.
 */
import { formatDateHumanFull, getLeadCohort, isWorkday, addDays } from "~/server/date-logic";
import {
  TREND_MIN_DENOMINATOR,
  type TrendBucketMode,
  type TrendPoint,
} from "~/server/metrics/compute";
import { formatDuration, formatInt, formatPercent } from "~/server/metrics/report-text";
import type { AuditCallRow } from "~/server/store/types";
import type { TrendUnit } from "./trend-chart";

// ---------- trend point meta (chart honesty markers) ----------

export interface TrendPointMeta {
  /** Bucket id (TrendPoint.key) — the drill/date URL param value. */
  key: string;
  /** In-progress day/week → "Today · In Progress" tooltip marker. */
  isPartial?: boolean;
  /** Non-working day (day buckets only) → hollow point + "(closed)" line. */
  isNonWorking?: boolean;
  /** Lead split (E1, already in TrendPoint) for the Lead Volume tooltip. */
  family?: number | null;
  animalia?: number | null;
}

/** A week bucket [Monday, Monday+6] is partial while it contains today. */
export function isPartialBucket(point: TrendPoint, today: string, bucketMode: TrendBucketMode): boolean {
  if (bucketMode === "day") return point.key === today;
  return today >= point.key && today <= addDays(point.key, 6);
}

export function isNonWorkingBucket(point: TrendPoint, bucketMode: TrendBucketMode): boolean {
  return bucketMode === "day" && !isWorkday(point.key);
}

export function buildTrendMeta(
  points: TrendPoint[],
  today: string,
  bucketMode: TrendBucketMode,
): TrendPointMeta[] {
  return points.map((p) => ({
    key: p.key,
    isPartial: isPartialBucket(p, today, bucketMode),
    isNonWorking: isNonWorkingBucket(p, bucketMode),
    family: p.family,
    animalia: p.animalia,
  }));
}

// ---------- tooltips (per-unit templates — exact playbook shapes) ----------

export interface TooltipView {
  title: string;
  lines: string[];
}

export interface TrendTooltipInput {
  /** The plotted number (what the card's polyline carries). */
  value: number | null;
  /** Point axis label, e.g. "Sep 24". */
  label: string;
  unit: TrendUnit;
  /** int unit noun: "calls" | "bookings" | "calls over 2 min". */
  noun?: string;
  /** pct unit flavor: which conversion's components to show. */
  pctKind?: "conversation" | "assigned";
  /** Full metrics-layer point — components come from HERE, never recomputed. */
  point: TrendPoint;
  today: string;
  bucketMode: TrendBucketMode;
}

export function trendTooltip(input: TrendTooltipInput): TooltipView {
  const { value, label, unit, point: p } = input;
  const partial = isPartialBucket(p, input.today, input.bucketMode);
  const closed = isNonWorkingBucket(p, input.bucketMode);
  const title = partial ? "Today · In Progress" : label;

  const lines: string[] = [];
  if (unit === "int" && input.noun === "leads") {
    // Lead Volume — the split template (Total · Family · Animalia · pace).
    lines.push(leadSplitLine(p, input.bucketMode));
  } else if (unit === "int") {
    lines.push(value == null ? `${label} · —` : `${label} · ${formatInt(value)} ${input.noun ?? ""}`.trim());
  } else if (unit === "duration") {
    lines.push(value == null ? `${label} · —` : `${formatDuration(value)} avg · ${formatInt(p.calls)} calls`);
  } else {
    // pct — never a bare %: numerator + denominator always (§2).
    if (input.pctKind === "assigned") {
      lines.push(
        value == null
          ? `— · fewer than ${TREND_MIN_DENOMINATOR} assigned leads worked`
          : `${formatPercent(value, 1)} · ${formatInt(p.bookings)} of ${formatInt(p.leads)} assigned leads worked`,
      );
    } else {
      lines.push(
        value == null
          ? `— · fewer than ${TREND_MIN_DENOMINATOR} calls > threshold`
          : `${formatPercent(value, 1)} · ${formatInt(p.bookingsFromOverThreshold)} of ${formatInt(p.callsOverThreshold)}`,
      );
    }
  }
  if (closed) lines.push("(closed)");
  return { title, lines };
}

/** Lead Volume tooltip line — split + budget pace from the SAME point. */
export function leadSplitLine(p: TrendPoint, bucketMode: TrendBucketMode): string {
  const pace =
    bucketMode === "week"
      ? `budget ${formatInt(p.budgetRef)}/wk`
      : `budget pace ${formatInt(p.budgetRef)}/day`;
  return `Total ${formatInt(p.leads)} · Family ${formatInt(p.family)} · Animalia ${formatInt(p.animalia)} · ${pace}`;
}

// ---------- drawer heading + context (§3 context preservation) ----------

export function drawerHeading(title: string, pointLabel: string): string {
  return `${title} — ${pointLabel}`;
}

export interface DrawerContextInput {
  /** data.range.label, e.g. "This Week" or "Week of Sep 21". */
  rangeLabel: string;
  /** false when the range is live/current — historical is never ambiguous. */
  isHistorical: boolean;
  thresholdSeconds: number;
  /** Record count when the drawer lists records; null → omit the line. */
  count?: number | null;
  /** Scope sentence fragment, e.g. "Roster calls" or "Work-date cohort". */
  scopeLabel?: string;
}

export function drawerContextLines(input: DrawerContextInput): string[] {
  const lines: string[] = [];
  lines.push(input.isHistorical ? `Historical · ${input.rangeLabel}` : input.rangeLabel);
  lines.push(
    input.scopeLabel
      ? `${input.scopeLabel} · threshold ${input.thresholdSeconds}s`
      : `threshold ${input.thresholdSeconds}s`,
  );
  if (input.count != null) lines.push(`${formatInt(input.count)} records`);
  return lines;
}

// ---------- §16 reconciliation ----------

export function reconciliationText(
  pointValue: number,
  drawerCount: number,
): { ok: boolean; text: string } {
  return pointValue === drawerCount
    ? { ok: true, text: `${formatInt(drawerCount)} records — matches the chart.` }
    : {
        ok: false,
        text: `${formatInt(drawerCount)} records — the chart shows ${formatInt(pointValue)}. Investigate before trusting this view.`,
      };
}

// ---------- per-metric drawer content ----------

export interface DrawerCallRowView {
  time: string;
  rep: string;
  contact: string;
  direction: string;
  duration: string;
  status: string;
}

/** Audit row → drawer table cell strings. Missing data renders "—", never blank.
 *  Accepts VIEWED rows (auditRowView output) — started_at_et is the ET presentation
 *  field, not a raw AuditCallRow property. */
export function callRowViews(rows: (AuditCallRow & { started_at_et: string })[]): DrawerCallRowView[] {
  return rows.map((r) => ({
    time: r.started_at_et,
    rep: r.rep_name ?? "—",
    contact: r.contact_name ?? "—",
    direction: r.direction ?? "—",
    duration: formatDuration(r.duration_seconds),
    status: r.call_status ?? "—",
  }));
}

export function overThresholdRows(rows: AuditCallRow[]): AuditCallRow[] {
  return rows.filter((r) => r.over_threshold);
}

/** Conversation Conversion components line — numerator + denominator always (§2). */
export function conversionComponents(fromOver: number, over: number): string {
  const pct = over >= TREND_MIN_DENOMINATOR && over > 0 ? formatPercent(fromOver / over, 1) : "—";
  return `${formatInt(fromOver)} bookings from qualifying calls / ${formatInt(over)} calls > 2 min / ${pct}`;
}

/** Average Call Duration claim line — recomputed claim from the SAME point. */
export function avgDurationLine(point: TrendPoint): string {
  return point.avgCallDurationSeconds == null
    ? "— · no calls in this bucket"
    : `${formatDuration(point.avgCallDurationSeconds)} average across ${formatInt(point.calls)} calls`;
}

/** Assigned-Lead Conversion components — bookings + assigned leads worked. */
export function assignedConversionLines(point: TrendPoint): string[] {
  return [
    point.assignedLeadConversion == null
      ? `— · fewer than ${TREND_MIN_DENOMINATOR} assigned leads worked`
      : `${formatPercent(point.assignedLeadConversion, 1)} · ${formatInt(point.bookings)} of ${formatInt(point.leads)} assigned leads worked`,
  ];
}

export interface LeadCohortView {
  split: string;
  /** Source dates whose leads the team works on this work date (ET). */
  cohort: string[];
  /** Honesty note — record-level lead rows are not payload'd yet (E3). */
  note: string;
}

/**
 * Lead Volume drill-down: the work-date cohort (getLeadCohort semantics) +
 * the Family/Animalia split. Day buckets show the cohort's source dates;
 * weekly buckets honestly omit it (a cohort is a per-day concept).
 */
export function leadCohortView(point: TrendPoint, bucketMode: TrendBucketMode): LeadCohortView {
  return {
    split: leadSplitLine(point, bucketMode),
    cohort:
      bucketMode === "day"
        ? getLeadCohort(point.key).map((d) => formatDateHumanFull(d))
        : [],
    note:
      "Record-level lead rows are not loaded yet — source dates, split and totals come from the metrics layer; no rows are invented.",
  };
}

/** Honest unavailable states (§2: drill down only where raw data exists). */
export const BOOKINGS_DRILL_UNAVAILABLE =
  "Record-level booking drill-down is not loaded yet. The count above comes from the metrics layer (non-cancelled, by created date).";

export const WEEK_BUCKET_DRILL_NOTE =
  "Weekly bucket — record-level drill-down reconciles for daily ranges (ranges up to 31 days bucket by day).";

export const LEADS_DRILL_NOTE =
  "Record-level lead rows are not loaded yet — cohort dates and totals only, never invented rows.";
