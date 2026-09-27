/**
 * THE metrics layer — the ONE source of truth for every KPI on every page
 * (including the future Daily Report). Pages never compute their own numbers;
 * they call query functions that feed plain rows into these pure functions.
 *
 * Definitions (SPEC):
 *  - CONVERSATION CONVERSION = Bookings From Calls Over Threshold / Calls Over Threshold
 *  - ASSIGNED LEAD CONVERSION = Total Bookings / Assigned Leads
 *  - GOAL ACHIEVEMENT = Actual Bookings / Booking Goal
 *  - A "booking" = a non-cancelled appointment, counted by the day it was
 *    CREATED (created_business_date, ET business date) — the studio tracks sales made, not session date.
 *  - "Bookings From Calls Over Threshold" = bookings attributed to a call whose
 *    duration exceeds the meaningful-call threshold AND created within the
 *    attribution window (enforced by the attribution engine at sync time;
 *    re-checked here against the configured threshold).
 *  - Daily Pace Needed = remaining bookings this week ÷ days left in week
 *    (Mon–Sun week, counting today).
 *  - Weekly leads counted by work_date (the operational week Mon..Sun).
 */

import {
  addDays,
  dateRange,
  daysLeftInWorkWeek,
  workingDaysBetween,
  etToday,
  formatDateHuman,
  getLeadCohort,
  mondaysInRange,
  repOperatingState,
  weekStart,
} from "../date-logic";
// Availability engine (runtime import — availability.ts depends on this
// module's TYPES only, so there is no cycle). One engine, two consumers.
import { computeDayAvailability } from "./availability";
// CANONICAL identity normalizers (owner-ratified attribution program,
// Session 2): EVERY Acuity↔HL identity comparison in this module goes through
// the one definition in identity/normalize.ts — a HighLevel "+15088891019"
// matches an Acuity "5088891019" (11-digit leading 1 dropped), emails compare
// trimmed+lowercased. The former divergent local shims are gone.
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";
// Attribution-window date math (owner-ratified 2026-09-26 DATE-GRANULARITY
// window). attribution.ts imports nothing from this module, so the runtime
// import is acyclic — the old cycle note referred to src/server/attribution.ts
// (the retired engine the sync no longer uses).
import { attributionWindowDates, bookingCreationDateEt, callDateEt } from "./attribution";

/**
 * OWNER SPEC (ux-charts-tables-spec.md §9 + accuracy pass 3): a positive
 * performance chip may exist only when the rep's conversion stands on a
 * MINIMUM QUALIFYING SAMPLE — at least this many calls over the meaningful
 * threshold. A rep at 0.0% (or with 1–4 qualifying calls) must never earn a
 * positive chip no matter how the team compares. Tunable in one place.
 */
export const MIN_CONVERSION_SAMPLE = 5;

// ---------- row shapes (plain, serializable) ----------

export interface CallRow {
  id: string;
  rep_id: string | null;
  contact_id: string | null;
  started_at: string; // ISO UTC
  duration_seconds: number;
  over_two_minutes: boolean;
  /**
   * HighLevel call id (the provider's message id) — the attribution engine's
   * candidate id, the call→contact backfill's ledger join-out key and the
   * attribution audit trail's join-out key. Optional: tests may omit it (the
   * engine falls back to the internal id).
   */
  external_call_id?: string | null;
  /**
   * RAW HighLevel userId, preserved verbatim even when the call has no roster
   * rep (immutable-source guarantee). Carried so the roster filter can apply
   * mapping-driven eligibility AT QUERY TIME (src/server/roster.ts) — the DB
   * row itself is never rewritten. Optional: tests may omit it.
   */
  provider_rep_external_id?: string | null;
  /**
   * The HighLevel conversation the call message came from (raw source id,
   * preserved verbatim). The call→contact restoration backfill joins it to
   * harvest_conversations.contact_id (parent-conversation tier). Optional:
   * tests may omit it.
   */
  conversation_id?: string | null;
  /**
   * HOW the call's contact was (last) resolved, written by the call→contact
   * restoration backfill: "direct_message_contact" | "parent_conversation_contact"
   * | "exact_phone" | "exact_email" | "ambiguous" | "unresolved" (plus the
   * pre-backfill legacy rows: null). Optional; carried so audit/debug reads
   * see the resolution provenance without a second query.
   */
  contact_resolution_method?: string | null;
}

export interface AppointmentRow {
  id: string;
  contact_id: string | null;
  calendar_id: string | null;
  /**
   * Optional extras carried by the availability paths (store joins for the
   * Acuity-driven surfaces; plain metrics callers omit them):
   * duration_minutes = per-appointment session length (Acuity), calendar_name
   * = human calendar label (Acuity scope matching), acuity_appointment_id =
   * provider id.
   */
  duration_minutes?: number | null;
  calendar_name?: string | null;
  acuity_appointment_id?: string | null;
  appointment_type: string;
  appointment_datetime: string; // ISO UTC (session time)
  created_at: string; // ISO UTC (authoritative creation instant from Acuity datetimeCreated; date-only rows carry the documented midnight-UTC display encoding)
  status: string; // scheduled | cancelled | completed
  cancelled: boolean;
  /**
   * S7c AUTHORITATIVE CREATION TIME (owner directive 2026-09-28): the ET
   * business date the booking was MADE on (YYYY-MM-DD) — created_at converted
   * to America/New_York, or the dateCreated CALENDAR DATE for date-only rows
   * (never UTC-shifted). THE created-based metrics bucket (daily/weekly/goal
   * pacing) reads THIS column; created_at stays the exact instant and
   * Appointments Scheduled stays on appointment_datetime.
   */
  created_business_date?: string | null;
  /** Original source string the creation time came from (datetimeCreated or dateCreated). */
  created_time_source?: string | null;
  /** full = datetimeCreated existed; date_only = calendar date from dateCreated; session_fallback = neither. */
  created_time_precision?: string | null;
  /** FULL provider object as Acuity returned it (forensics; written by the live sync). */
  raw?: Record<string, unknown> | null;
}

export interface AttributionRow {
  id: string;
  appointment_id: string;
  call_id: string | null;
  rep_id: string | null;
  method: string; // contact_id | phone | email | manual | none
  confidence: number;
  manual_override: boolean;
  /**
   * Audit/debug note persisted with the row (booking_attributions.note). The
   * sync wiring records the attribution window limitation here:
   * "date_granularity_window" + the exact window dates the match was
   * evaluated against (Acuity dateCreated is date-only — the scheduled
   * session date is never used and intra-day ordering is never assumed).
   */
  note?: string | null;
  /**
   * S4b refined no-rep classification (booking_attributions.reason_code) —
   * the engine's triage category for UNATTRIBUTED rows ("no-window-interaction"
   * | "interaction-without-roster-rep" | "no-matching-contact" |
   * "no-contact-identity" | "bad-datetime") or "ambiguous" on ambiguous rows.
   * NULL on attributed and manually-assigned rows. Grouped queue counts read
   * this column; the audit note is never parsed for it.
   */
  reason_code?: string | null;
}

export interface LeadRow {
  id: string;
  lead_type: string; // family | animalia
  source_date: string; // YYYY-MM-DD
  work_date: string; // YYYY-MM-DD
  contact_id: string | null;
  assigned_rep_id: string | null;
  source_sheet: string; // family | animalia
}

export interface RepGoalRow {
  rep_id: string;
  week_start: string;
  goal: number;
  /**
   * PRESENTATION PASSTHROUGH ONLY — set only by the Today path after goal
   * resolution (resolveRepGoal's basis/note, verbatim). Raw rep_goals rows
   * leave these unset. No computation, no metric redefinition.
   */
  goal_basis?: GoalBasis | null;
  goal_note?: string | null;
}

export interface Rep {
  id: string;
  name: string;
  /** Explicit activation date (ET) when set — drives "Not Yet Active" state. */
  call_start_date?: string | null;
}

// ---------- helpers ----------

const pct = (num: number, den: number): number | null =>
  den > 0 ? num / den : null;

export function isoDayOf(instant: string): string {
  // NOTE: callers pass ET day bounds so `instant` falls in the right UTC day;
  // day-of-bookings is resolved with ET calendar helpers at query time.
  return instant.slice(0, 10);
}

// ---------- ET range filters (pure; same semantics as the SQL bounds) ----------

/**
 * Keep rows whose instant falls in [etDayStartUtc(start), etDayEndUtc(end)).
 * The store applies the identical bounds in SQL; these pure mirrors let tests
 * pin the boundary behavior (boundary day in, day before/after out) and let
 * queries double-check the store result cheaply.
 */
export function filterInstantsInEtRange<T>(
  rows: T[],
  getInstant: (row: T) => string,
  start: string,
  end: string,
): T[] {
  const startUtc = etDayStartOf(start);
  const endUtc = etDayEndUtc(end); // start of the day AFTER `end` (exclusive)
  return rows.filter((r) => {
    const t = getInstant(r);
    return t >= startUtc && t < endUtc;
  });
}

export function filterCallsInEtRange(calls: CallRow[], start: string, end: string): CallRow[] {
  return filterInstantsInEtRange(calls, (c) => c.started_at, start, end);
}

/**
 * S7c: the ET BUSINESS DATE a booking was MADE on — THE created-based bucket
 * key. `created_business_date` (written by the S7c sync from Acuity
 * datetimeCreated / the dateCreated calendar date) is authoritative; a row
 * without it (legacy store row not yet re-synced) falls back to the SAME
 * derivation the attribution engine's anchor uses for legacy rows: a
 * midnight-UTC created_at is read as a CALENDAR DATE (the date-only display
 * encoding — never UTC-shifted), a real timestamp becomes its ET date. Rows
 * with neither parseable field bucket nowhere (never guessed into a day).
 */
export function createdBusinessDateOf(appt: Pick<AppointmentRow, "created_at" | "created_business_date">): string | null {
  return bookingCreationDateEt({
    created_at: appt.created_at,
    created_business_date: appt.created_business_date,
  })?.date ?? null;
}

export function filterApptsCreatedInEtRange(
  appts: AppointmentRow[],
  start: string,
  end: string,
): AppointmentRow[] {
  // S7c: the created-based bucket is the ET BUSINESS DATE (created_business_date
  // — the booking-MADE calendar date in America/New_York), compared as calendar
  // dates inclusive both ends. The old instant bounds on created_at mis-bucketed
  // every booking whose instant encoding was date-only (midnight UTC → the
  // previous ET day).
  return appts.filter((r) => {
    const d = createdBusinessDateOf(r);
    return d != null && d >= start && d <= end;
  });
}

/** Assemble one rep's full performance model for the Reps page detail panel. */
export function buildRepDetail(input: {
  rep: Rep;
  metrics: RepRangeMetrics;
  goal: RepGoalInfo | null;
  weeks: string[];
}) {
  const goal = input.goal;
  const actual = input.metrics.totalBookings;
  const goalValue = goal?.value ?? 0;
  return {
    rep: input.rep,
    metrics: input.metrics,
    goal,
    goalWeeks: input.weeks,
    actual,
    goalAchievement: goalAchievement(actual, goalValue),
    differenceFromGoal: goalValue > 0 || goal != null ? actual - goalValue : null,
  };
}

// ---------- calls ----------

export interface CallsSummary {
  total: number;
  overThreshold: number;
  avgDurationSeconds: number | null;
}

/** Total calls, calls over threshold, avg duration for an arbitrary set of calls. */
export function summarizeCalls(calls: CallRow[], thresholdSeconds: number): CallsSummary {
  const total = calls.length;
  const over = calls.filter((c) => c.duration_seconds > thresholdSeconds).length;
  const avg =
    total > 0 ? Math.round(calls.reduce((s, c) => s + c.duration_seconds, 0) / total) : null;
  return { total, overThreshold: over, avgDurationSeconds: avg };
}

/** Group a calls summary per rep. */
export function callsByRep(calls: CallRow[], thresholdSeconds: number): Map<string, CallsSummary> {
  const m = new Map<string, CallRow[]>();
  for (const c of calls) {
    if (!c.rep_id) continue;
    const arr = m.get(c.rep_id) ?? [];
    arr.push(c);
    m.set(c.rep_id, arr);
  }
  return new Map([...m.entries()].map(([rep, rows]) => [rep, summarizeCalls(rows, thresholdSeconds)]));
}

// ---------- bookings ----------

export function isBooking(a: AppointmentRow): boolean {
  return !a.cancelled && a.status !== "cancelled";
}

/**
 * Count bookings (non-cancelled) whose ET BUSINESS DATE (created_business_date)
 * falls in [start, end] inclusive — both bounds are YYYY-MM-DD ET calendar
 * dates (S7c: bucketing is the booking-MADE ET date, never an instant window).
 */
export function countBookingsCreatedBetween(appts: AppointmentRow[], start: string, end: string): number {
  return appts.filter(
    (a) => {
      const d = createdBusinessDateOf(a);
      return isBooking(a) && d != null && d >= start && d <= end;
    },
  ).length;
}

/** Rep-level booking counts (via attributions; manual overrides included, unattributed excluded). */
export function bookingsByRep(appts: AppointmentRow[], attributions: AttributionRow[]): Map<string, number> {
  const byAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  const m = new Map<string, number>();
  for (const appt of appts) {
    if (!isBooking(appt)) continue;
    const attr = byAppt.get(appt.id);
    if (!attr?.rep_id) continue;
    m.set(attr.rep_id, (m.get(attr.rep_id) ?? 0) + 1);
  }
  return m;
}

/** Bookings attributable to a call over the CURRENT threshold (conversation-conversion numerator). */
export function bookingsFromOverThresholdCalls(
  appts: AppointmentRow[],
  attributions: AttributionRow[],
  calls: CallRow[],
  thresholdSeconds: number,
): AppointmentRow[] {
  const callById = new Map(calls.map((c) => [c.id, c]));
  const byAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  return appts.filter((appt) => {
    if (!isBooking(appt)) return false;
    const attr = byAppt.get(appt.id);
    if (!attr?.call_id) return false;
    const call = callById.get(attr.call_id);
    return !!call && call.duration_seconds > thresholdSeconds;
  });
}

// ---------- conversions ----------

export function conversationConversion(bookingsFromOver: number, callsOverThreshold: number): number | null {
  return pct(bookingsFromOver, callsOverThreshold);
}

export function assignedLeadConversion(totalBookings: number, assignedLeads: number): number | null {
  return pct(totalBookings, assignedLeads);
}

export function goalAchievement(actual: number, goal: number): number | null {
  return goal > 0 ? actual / goal : null;
}

export function paceNeeded(remaining: number, daysLeft: number): number {
  if (daysLeft <= 0) return 0;
  return Math.max(0, Math.ceil(remaining / daysLeft));
}

// ---------- leads ----------

export interface LeadSummary {
  family: number;
  animalia: number;
  total: number;
}

/**
 * Manual lead-count corrections (Settings → Overrides). A delta adjusts the
 * sheet-synced count for one work_date + sheet — e.g. a duplicate row or a
 * lead that arrived outside the sync. Adjustments flow THROUGH the metrics
 * functions (never added at page level) so every surface agrees.
 */
export interface LeadCountAdjustment {
  work_date: string; // ET date the cohort is worked
  sheet: string; // "family" | "animalia" (source_sheet)
  delta: number; // correction vs the synced rows (+/-)
}

function applyLeadAdjustments(
  base: LeadSummary,
  adjustments: LeadCountAdjustment[] | undefined,
  include: (a: LeadCountAdjustment) => boolean,
): LeadSummary {
  if (!adjustments || adjustments.length === 0) return base;
  let family = base.family;
  let animalia = base.animalia;
  for (const a of adjustments) {
    if (!include(a)) continue;
    const d = Number(a.delta) || 0;
    if (a.sheet === "family") family += d;
    else if (a.sheet === "animalia") animalia += d;
  }
  return { family, animalia, total: family + animalia };
}

/** Leads the team works on reportDate (work_date = reportDate), by type. */
export function leadsToday(leads: LeadRow[], reportDate: string, adjustments?: LeadCountAdjustment[]): LeadSummary {
  const rows = leads.filter((l) => l.work_date === reportDate);
  return applyLeadAdjustments(summarizeLeadRows(rows), adjustments, (a) => a.work_date === reportDate);
}

function summarizeLeadRows(rows: LeadRow[]): LeadSummary {
  const family = rows.filter((l) => l.lead_type === "family").length;
  const animalia = rows.filter((l) => l.lead_type === "animalia").length;
  return { family, animalia, total: family + animalia };
}

/** Weekly leads: work_date within the operational week (Mon..Sun) containing reportDate. */
export function leadsForWeek(leads: LeadRow[], reportDate: string, adjustments?: LeadCountAdjustment[]): LeadSummary {
  const ws = weekStart(reportDate);
  const we = addDays(ws, 6);
  return applyLeadAdjustments(summarizeLeadRows(leads.filter((l) => l.work_date >= ws && l.work_date <= we)), adjustments, (a) => a.work_date >= ws && a.work_date <= we);
}

export function leadBudgetUsage(weekLeads: number, weeklyBudget: number): number | null {
  return weeklyBudget > 0 ? weekLeads / weeklyBudget : null;
}

export function leadsRemaining(weekLeads: number, weeklyBudget: number): number {
  return Math.max(0, weeklyBudget - weekLeads);
}

export function dailyLeadsNeeded(weekLeads: number, weeklyBudget: number, reportDate: string): number {
  return paceNeeded(leadsRemaining(weekLeads, weeklyBudget), daysLeftInWorkWeek(reportDate));
}

/** Assigned leads per rep: leads (work_date in range) whose assigned rep matches. */
export function assignedLeadsByRep(leads: LeadRow[], startWorkDate: string, endWorkDate: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of leads) {
    if (l.work_date < startWorkDate || l.work_date > endWorkDate) continue;
    if (!l.assigned_rep_id) continue;
    m.set(l.assigned_rep_id, (m.get(l.assigned_rep_id) ?? 0) + 1);
  }
  return m;
}

// ---------- aggregated dashboard model ----------

export interface TodayMetrics {
  date: string;
  weekStart: string;
  leadCohortSourceDates: string[];
  bookings: {
    today: number;
    yesterday: number;
    wtd: number;
    weeklyGoal: number;
    remaining: number;
    paceNeeded: number;
    goalAchievement: number | null;
  };
  /**
   * Working-day pace context (agents work Mon–Fri): days left INCLUDING today;
   * paceWeekend=true means no working days remain — pace resumes Monday and
   * every "per day" number shows 0 rather than a fiction.
   */
  paceDaysLeft: number;
  paceWeekend: boolean;
  callsToday: CallsSummary;
  conversionsToday: {
    conversation: number | null;
    assignedLead: number | null;
  };
  leads: {
    today: LeadSummary;
    weekly: LeadSummary;
    weeklyBudget: number;
    percentUsed: number | null;
    remaining: number;
    dailyNeeded: number;
  };
  /** Open studio slots per day (today + the next 6), spec §7.1. */
  openSlotsByDay: { date: string; slots: string[] }[];
  repRows: RepPerformanceRow[];
}

export interface RepPerformanceRow {
  repId: string;
  name: string;
  totalCalls: number;
  callsOverThreshold: number;
  bookingsFromOverThreshold: number;
  totalBookings: number;
  /**
   * Assigned leads this week (raw count). PRESENTATION PASSTHROUGH ONLY — the
   * exact number repRangeSummaries already computed (it is the denominator of
   * assignedLeadConversion); exposed so the Today detail panel can show the
   * count and the pooled benchmark's numerator/denominator without recomputing
   * anything. No metric redefinition.
   */
  assignedLeads: number;
  conversationConversion: number | null;
  assignedLeadConversion: number | null;
  avgCallDurationSeconds: number | null;
  goal: number;
  actual: number;
  goalPercent: number | null;
  /**
   * PRESENTATION PASSTHROUGH ONLY — resolveRepGoal's basis/note carried
   * verbatim from the resolved rep_goals rows (undefined when the caller
   * passes raw rows, e.g. tests). No computation here — the goal VALUE was
   * already resolved upstream; these only label where it came from.
   */
  goalBasis?: GoalBasis | null;
  goalNote?: string | null;
  /**
   * Operating state from users.call_start_date vs the report date (ET):
   * "not-yet-active" reps are visible with zero calls EXPECTED — no activity
   * chips, no coaching/attention notes, no negative messaging. Chips and
   * attention rules MUST consult this before any other rule.
   */
  operatingState: "active" | "not-yet-active";
  /** The activation date itself (null when the rep has always been monitored). */
  callStartDate: string | null;
}

/**
 * Build the full Today-page metric model. Inputs are raw rows; every number a
 * page shows flows through here.
 */
export function buildTodayMetrics(input: {
  reportDate?: string;
  calls: CallRow[]; // calls started today (ET)
  apptsCreatedToday: AppointmentRow[];
  apptsCreatedYesterday: AppointmentRow[];
  apptsCreatedWtd: AppointmentRow[]; // includes today's
  callsWtd: CallRow[];
  allCallsForWeek: CallRow[]; // for over-threshold join
  attributions: AttributionRow[];
  leadsAllRecent: LeadRow[]; // leads whose work_date falls in this week (incl today's cohort)
  leadCountAdjustments?: LeadCountAdjustment[];
  teamBookingGoal: number;
  weeklyLeadBudget: number;
  thresholdSeconds: number;
  /** Open slots per day: entry i covers addDays(reportDate, i), i in 0..6 (spec §7.1). */
  openSlotsByDay: { date: string; slots: string[] }[];
  reps: Rep[];
  repGoals: RepGoalRow[];
}): TodayMetrics {
  const reportDate = input.reportDate ?? etToday();
  const ws = weekStart(reportDate);

  const callsToday = summarizeCalls(input.calls, input.thresholdSeconds);

  const bookingsToday = countBookingsCreatedBetween(input.apptsCreatedToday, "", "9999");
  const bookingsYesterday = countBookingsCreatedBetween(input.apptsCreatedYesterday, "", "9999");
  const bookingsWtd = countBookingsCreatedBetween(input.apptsCreatedWtd, "", "9999");

  const fromOverWeek = bookingsFromOverThresholdCalls(
    input.apptsCreatedWtd,
    input.attributions,
    input.allCallsForWeek,
    input.thresholdSeconds,
  );
  const fromOverToday = bookingsFromOverThresholdCalls(
    input.apptsCreatedToday,
    input.attributions,
    input.allCallsForWeek,
    input.thresholdSeconds,
  );

  const leadsTodaySummary = leadsToday(input.leadsAllRecent, reportDate, input.leadCountAdjustments);
  const weeklyLeads = leadsForWeek(input.leadsAllRecent, reportDate, input.leadCountAdjustments);
  const assignedLeadsWeek = [...assignedLeadsByRep(input.leadsAllRecent, ws, addDays(ws, 6)).values()].reduce(
    (a, b) => a + b,
    0,
  );

  const remaining = Math.max(0, input.teamBookingGoal - bookingsWtd);
  const dLeft = daysLeftInWorkWeek(reportDate); // working days only — agents work Mon–Fri

  const repRows = buildRepPerformanceRows({
    reps: input.reps,
    calls: input.callsWtd,
    appts: input.apptsCreatedWtd,
    attributions: input.attributions,
    allCallsForWeek: input.allCallsForWeek,
    leads: input.leadsAllRecent,
    weekStart: ws,
    weekEnd: addDays(ws, 6),
    repGoals: input.repGoals,
    thresholdSeconds: input.thresholdSeconds,
    today: reportDate,
  });

  return {
    date: reportDate,
    weekStart: ws,
    leadCohortSourceDates: getLeadCohort(reportDate),
    bookings: {
      today: bookingsToday,
      yesterday: bookingsYesterday,
      wtd: bookingsWtd,
      weeklyGoal: input.teamBookingGoal,
      remaining,
      paceNeeded: paceNeeded(remaining, dLeft),
      goalAchievement: goalAchievement(bookingsWtd, input.teamBookingGoal),
    },
    paceDaysLeft: dLeft,
    paceWeekend: dLeft === 0,
    callsToday,
    conversionsToday: {
      conversation: conversationConversion(fromOverToday.length, callsToday.overThreshold),
      assignedLead: assignedLeadConversion(bookingsToday, leadsTodaySummary.total),
    },
    leads: {
      today: leadsTodaySummary,
      weekly: weeklyLeads,
      weeklyBudget: input.weeklyLeadBudget,
      percentUsed: leadBudgetUsage(weeklyLeads.total, input.weeklyLeadBudget),
      remaining: leadsRemaining(weeklyLeads.total, input.weeklyLeadBudget),
      dailyNeeded: dailyLeadsNeeded(weeklyLeads.total, input.weeklyLeadBudget, reportDate),
    },
    openSlotsByDay: input.openSlotsByDay,
    repRows,
  };
}

/** One row of the Today rep-performance table (weekly figures). */
export function buildRepPerformanceRows(input: {
  reps: Rep[];
  calls: CallRow[];
  appts: AppointmentRow[];
  attributions: AttributionRow[];
  allCallsForWeek: CallRow[];
  leads: LeadRow[];
  weekStart: string;
  weekEnd: string;
  repGoals: RepGoalRow[];
  thresholdSeconds: number;
  /** Report date (ET) for the operating-state boundary; defaults to weekEnd. */
  today?: string;
}): RepPerformanceRow[] {
  const summaries = repRangeSummaries({
    reps: input.reps,
    calls: input.calls,
    appts: input.appts,
    attributions: input.attributions,
    allCallsForJoin: input.allCallsForWeek,
    leads: input.leads,
    workStart: input.weekStart,
    workEnd: input.weekEnd,
    thresholdSeconds: input.thresholdSeconds,
  });
  // goal rows may carry the resolved basis/note (Today path) — keep the whole
  // row so the passthrough survives; goal VALUE lookup semantics unchanged.
  const goalByRep = new Map(input.repGoals.map((g) => [g.rep_id, g]));
  const today = input.today ?? input.weekEnd;
  return input.reps
    .map((rep) => {
      const s = summaries.get(rep.id)!;
      const goalRow = goalByRep.get(rep.id);
      const goal = goalRow?.goal ?? 0;
      return {
        repId: rep.id,
        name: rep.name,
        totalCalls: s.totalCalls,
        callsOverThreshold: s.callsOverThreshold,
        bookingsFromOverThreshold: s.bookingsFromOverThreshold,
        totalBookings: s.totalBookings,
        assignedLeads: s.assignedLeads,
        conversationConversion: s.conversationConversion,
        assignedLeadConversion: s.assignedLeadConversion,
        avgCallDurationSeconds: s.avgCallDurationSeconds,
        goal,
        // PRESENTATION PASSTHROUGH — resolveRepGoal's basis/note, verbatim.
        goalBasis: goalRow?.goal_basis ?? null,
        goalNote: goalRow?.goal_note ?? null,
        actual: s.totalBookings,
        goalPercent: goalAchievement(s.totalBookings, goal),
        operatingState: repOperatingState(rep.call_start_date, today),
        callStartDate: rep.call_start_date ?? null,
      };
    })
    .sort((a, b) => b.totalBookings - a.totalBookings || b.totalCalls - a.totalCalls);
}

// ---------- individual rep performance (Reps page) ----------

export interface RepRangeMetrics {
  repId: string;
  totalCalls: number;
  callsOverThreshold: number;
  bookingsFromOverThreshold: number;
  totalBookings: number;
  assignedLeads: number;
  conversationConversion: number | null;
  assignedLeadConversion: number | null;
  avgCallDurationSeconds: number | null;
}

/**
 * Per-rep aggregates over an arbitrary date range. The Reps page builds its
 * detail, team averages, and rep selector ALL from this one map — one source
 * of truth, shared with the Today rep table via buildRepPerformanceRows.
 * Rows must already be ET-range-filtered (queries use etRangeBounds; the pure
 * helpers below re-apply the same bounds so tests cover the real logic).
 */
export function repRangeSummaries(input: {
  reps: Rep[];
  calls: CallRow[]; // calls started in the ET range
  appts: AppointmentRow[]; // appointments CREATED in the ET range
  attributions: AttributionRow[];
  allCallsForJoin: CallRow[]; // includes look-back before the range for attribution joins
  leads: LeadRow[]; // leads with work_date in the range
  workStart: string;
  workEnd: string;
  thresholdSeconds: number;
}): Map<string, RepRangeMetrics> {
  const callSummaries = callsByRep(input.calls, input.thresholdSeconds);
  const bookings = bookingsByRep(input.appts, input.attributions);
  const fromOver = bookingsFromOverThresholdCalls(
    input.appts,
    input.attributions,
    input.allCallsForJoin,
    input.thresholdSeconds,
  );
  const byAppt = new Map(input.attributions.map((a) => [a.appointment_id, a]));
  const fromOverByRep = new Map<string, number>();
  for (const appt of fromOver) {
    const rep = byAppt.get(appt.id)?.rep_id;
    if (rep) fromOverByRep.set(rep, (fromOverByRep.get(rep) ?? 0) + 1);
  }
  const assigned = assignedLeadsByRep(input.leads, input.workStart, input.workEnd);

  return new Map(
    input.reps.map((rep) => {
      const cs = callSummaries.get(rep.id) ?? {
        total: 0,
        overThreshold: 0,
        avgDurationSeconds: null,
      };
      const totalBookings = bookings.get(rep.id) ?? 0;
      const fromOverCount = fromOverByRep.get(rep.id) ?? 0;
      const assignedLeads = assigned.get(rep.id) ?? 0;
      return [
        rep.id,
        {
          repId: rep.id,
          totalCalls: cs.total,
          callsOverThreshold: cs.overThreshold,
          bookingsFromOverThreshold: fromOverCount,
          totalBookings,
          assignedLeads,
          conversationConversion: conversationConversion(fromOverCount, cs.overThreshold),
          assignedLeadConversion: assignedLeadConversion(totalBookings, assignedLeads),
          avgCallDurationSeconds: cs.avgDurationSeconds,
        },
      ];
    }),
  );
}

// ---------- rep booking goal (rep_goals with team-share fallback) ----------

export type GoalBasis = "rep-goal" | "team-share" | "mixed";

export interface RepGoalInfo {
  /** Summed over the range's weeks (weekly goals add up over multi-week ranges). */
  value: number;
  basis: GoalBasis;
  /** Human note on where the goal came from — always shown next to the goal. */
  note: string;
}

/**
 * Booking goal for one rep over a range: rep_goals per covered week, falling
 * back per week to an even share of that week's team booking goal when no rep
 * goal is set. The basis says which was actually used ("mixed" when a range
 * spans weeks of both kinds) — the page labels it, never silently guesses.
 */
export function resolveRepGoal(input: {
  weeks: string[]; // Mondays covering the range (>= 1)
  repGoalsByWeek: Map<string, number>; // this rep's goal per week, when set
  teamGoalByWeek: Map<string, number>; // team booking goal per week (default 79 when absent)
  repCount: number; // active reps — team goal is shared evenly
}): RepGoalInfo | null {
  if (input.weeks.length === 0) return null;
  if (input.repCount <= 0) return null;
  let value = 0;
  let repGoalWeeks = 0;
  let shareWeeks = 0;
  for (const week of input.weeks) {
    const repGoal = input.repGoalsByWeek.get(week);
    if (repGoal != null && repGoal > 0) {
      value += repGoal;
      repGoalWeeks += 1;
    } else {
      const teamGoal = input.teamGoalByWeek.get(week) ?? 79;
      value += teamGoal / input.repCount;
      shareWeeks += 1;
    }
  }
  const lastWeek = input.weeks[input.weeks.length - 1];
  const basis: GoalBasis =
    shareWeeks === 0 ? "rep-goal" : repGoalWeeks === 0 ? "team-share" : "mixed";
  const note =
    basis === "rep-goal"
      ? input.weeks.length === 1
        ? `rep goal · week of ${lastWeek}`
        : `rep goals summed over ${input.weeks.length} weeks`
      : basis === "team-share"
        ? `team goal share — weekly team goal ÷ ${input.repCount} reps`
        : "rep goal where set, team share otherwise";
  return { value, basis, note };
}

// ---------- performance vs team average ----------

/** How a difference is expressed: counts in %, rates in percentage points, durations in seconds. */
export type ComparisonUnit = "pct" | "pp" | "seconds";

export interface TeamComparison {
  metric: string; // display label
  rep: number | null;
  teamAvg: number | null;
  diff: number | null;
  unit: ComparisonUnit;
}

export interface TeamAverages {
  repCount: number; // reps averaged in (viewed rep excluded)
  totalCalls: number | null;
  callsOverThreshold: number | null;
  bookingsFromOverThreshold: number | null;
  totalBookings: number | null;
  assignedLeads: number | null;
  conversationConversion: number | null;
  assignedLeadConversion: number | null;
  avgCallDurationSeconds: number | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Team averages over the same range, EXCLUDING the viewed rep. Counts average
 * across all other reps (zero-activity reps included — they are part of the
 * team); rates and durations average only over reps that have a value, and are
 * null when none do (shown as "—", never a fake number).
 */
export function buildTeamAverages(input: { others: RepRangeMetrics[] }): TeamAverages {
  const o = input.others;
  return {
    repCount: o.length,
    totalCalls: mean(o.map((m) => m.totalCalls)),
    callsOverThreshold: mean(o.map((m) => m.callsOverThreshold)),
    bookingsFromOverThreshold: mean(o.map((m) => m.bookingsFromOverThreshold)),
    totalBookings: mean(o.map((m) => m.totalBookings)),
    assignedLeads: mean(o.map((m) => m.assignedLeads)),
    conversationConversion: mean(
      o.map((m) => m.conversationConversion).filter((v): v is number => v != null),
    ),
    assignedLeadConversion: mean(
      o.map((m) => m.assignedLeadConversion).filter((v): v is number => v != null),
    ),
    avgCallDurationSeconds: mean(
      o.map((m) => m.avgCallDurationSeconds).filter((v): v is number => v != null),
    ),
  };
}

/** Counts compare as % difference (SPEC: 74 vs 68 → +8.8%); rates as percentage points (57.1% vs 54.5% → +2.6 pp); durations in seconds. */
export function teamDifference(rep: number | null, teamAvg: number | null, unit: ComparisonUnit): number | null {
  if (rep == null || teamAvg == null) return null;
  if (unit === "pp") return (rep - teamAvg) * 100;
  if (unit === "seconds") return rep - teamAvg;
  if (teamAvg === 0) return null; // % difference undefined against a zero team average
  return ((rep - teamAvg) / teamAvg) * 100;
}

/** The SPEC comparison block: one row per metric with the correct diff unit. */
export function compareWithTeam(rep: RepRangeMetrics, team: TeamAverages): TeamComparison[] {
  const row = (
    metric: string,
    repVal: number | null,
    teamVal: number | null,
    unit: ComparisonUnit,
  ): TeamComparison => ({
    metric,
    rep: repVal,
    teamAvg: teamVal,
    diff: teamDifference(repVal, teamVal, unit),
    unit,
  });
  return [
    row("Calls", rep.totalCalls, team.totalCalls, "pct"),
    row("Calls Over 2 Min", rep.callsOverThreshold, team.callsOverThreshold, "pct"),
    row("Bookings From Calls Over 2 Minutes", rep.bookingsFromOverThreshold, team.bookingsFromOverThreshold, "pct"),
    row("Conversation Conversion", rep.conversationConversion, team.conversationConversion, "pp"),
    row("Total Bookings", rep.totalBookings, team.totalBookings, "pct"),
    row("Assigned Lead Conversion", rep.assignedLeadConversion, team.assignedLeadConversion, "pp"),
    row("Average Call Duration", rep.avgCallDurationSeconds, team.avgCallDurationSeconds, "seconds"),
  ];
}

// ---------- team performance (Team page) ----------

export interface TeamGoalInfo {
  /** Summed over the range's covered weeks (weekly team goals add up). */
  value: number;
  /** "team-goal" when every covered week has a stored goal, "with-default" when the 79 default filled any gap. */
  basis: "team-goal" | "with-default";
  /** Human note on where the goal came from — always shown next to the goal. */
  note: string;
}

/**
 * Team booking goal over a range: the stored weekly team goal per covered week
 * (team_goals), falling back per week to the 79 default when unset. Multi-week
 * ranges SUM the weekly goals (owner-ratified semantics, same as the Reps
 * page); the basis/note say which was used — never silently guessed.
 */
export function resolveTeamGoal(input: {
  weeks: string[]; // Mondays covering the range (>= 1)
  teamGoalByWeek: Map<string, number>; // team booking goal per week when stored
}): TeamGoalInfo {
  let value = 0;
  let defaultedWeeks = 0;
  for (const week of input.weeks) {
    const goal = input.teamGoalByWeek.get(week);
    if (goal != null && goal > 0) value += goal;
    else {
      value += 79;
      defaultedWeeks += 1;
    }
  }
  const lastWeek = input.weeks[input.weeks.length - 1];
  const defaultNote = defaultedWeeks === 0 ? "" : ` · default 79 where unset (${defaultedWeeks} wk)`;
  const note =
    input.weeks.length === 1
      ? defaultedWeeks === 0
        ? `team booking goal · week of ${lastWeek}`
        : `default weekly goal · week of ${lastWeek} (none stored)`
      : `weekly team goals summed over ${input.weeks.length} weeks${defaultNote}`;
  return { value, basis: defaultedWeeks === 0 ? "team-goal" : "with-default", note };
}

/**
 * WORKING days left for the team Daily Pace Needed: from today through the
 * FRIDAY of the last week covered by the range (agents work Mon–Fri), counting
 * working days only. A range that already ended has 0 days left → pace 0 (nothing
 * left to do about it). On a weekend with the horizon in the current week this
 * is also 0 — the work week is done; pace resumes Monday. For to-date ranges
 * this matches the Today page's daysLeftInWorkWeek — same semantics, extra
 * working days only when a custom range extends past the current week.
 */
export function paceDaysLeftForRange(input: { rangeEnd: string; lastWeekStart: string; today: string }): number {
  if (input.rangeEnd < input.today) return 0; // range fully elapsed — no pace needed
  const horizon = addDays(input.lastWeekStart, 4); // Friday of the last covered week
  if (horizon < input.today) return 0;
  return workingDaysBetween(input.today, horizon);
}

export interface TeamRangeMetrics {
  totalCalls: number;
  callsOverThreshold: number;
  bookingsFromOverThreshold: number;
  totalBookings: number;
  assignedLeads: number;
  conversationConversion: number | null;
  assignedLeadConversion: number | null;
  avgCallDurationSeconds: number | null;
  goal: TeamGoalInfo;
  actual: number;
  remaining: number;
  goalAchievement: number | null;
  paceNeeded: number;
  paceDaysLeft: number;
  /** Human note on the pace basis (days left + horizon, or why it is 0). */
  paceNote: string;
}

/**
 * Team-level aggregates over an arbitrary date range — the Team page KPI
 * block's single source of truth. Same conversions-on-own-period-data rules
 * as the rep layer; leads use work_date cohorting; bookings are non-cancelled
 * appointments counted by ET business date (created_business_date — S7c). Rows must already be ET-range-filtered
 * (the query applies etRangeBounds; the pure filters re-check the same bounds).
 */
export function buildTeamRangeMetrics(input: {
  calls: CallRow[]; // calls started in the ET range
  appts: AppointmentRow[]; // appointments CREATED in the ET range
  attributions: AttributionRow[];
  allCallsForJoin: CallRow[]; // includes look-back before the range for attribution joins
  leads: LeadRow[]; // leads with work_date in the range
  workStart: string;
  workEnd: string;
  weeks: string[]; // Mondays covering the range
  teamGoalByWeek: Map<string, number>;
  today: string;
  thresholdSeconds: number;
  /**
   * Active-roster rep IDs (optional). When given, team-level numbers only see
   * roster reps: callers pass calls already filtered through keepRosterRepCalls,
   * and assigned leads are counted for active reps only — non-roster users'
   * rows stay in the DB but never reach team rollups (owner: metrics reflect
   * only the CC team).
   */
  activeRepIds?: Set<string>;
}): TeamRangeMetrics {
  const cs = summarizeCalls(input.calls, input.thresholdSeconds);
  const totalBookings = countBookingsCreatedBetween(input.appts, "", "9999");
  const fromOver = bookingsFromOverThresholdCalls(
    input.appts,
    input.attributions,
    input.allCallsForJoin,
    input.thresholdSeconds,
  ).length;
  const assignedByRep = assignedLeadsByRep(input.leads, input.workStart, input.workEnd);
  const assignedLeads = [...assignedByRep.entries()]
    .filter(([repId]) => !input.activeRepIds || input.activeRepIds.has(repId))
    .reduce((a, [, n]) => a + n, 0);

  const goal = resolveTeamGoal({ weeks: input.weeks, teamGoalByWeek: input.teamGoalByWeek });
  const actual = totalBookings;
  const remaining = Math.max(0, goal.value - actual);
  const paceDaysLeft = paceDaysLeftForRange({
    rangeEnd: input.workEnd,
    lastWeekStart: input.weeks[input.weeks.length - 1],
    today: input.today,
  });
  const horizon = addDays(input.weeks[input.weeks.length - 1], 4); // Friday of the last covered week
  const paceNote =
    input.workEnd < input.today
      ? "range already ended — no pace needed"
      : paceDaysLeft === 0
        ? "work week complete — pace resumes Monday"
        : `${paceDaysLeft} ${paceDaysLeft === 1 ? "working day" : "working days"} left through ${formatDateHuman(horizon)}`;

  return {
    totalCalls: cs.total,
    callsOverThreshold: cs.overThreshold,
    bookingsFromOverThreshold: fromOver,
    totalBookings,
    assignedLeads,
    conversationConversion: conversationConversion(fromOver, cs.overThreshold),
    assignedLeadConversion: assignedLeadConversion(totalBookings, assignedLeads),
    avgCallDurationSeconds: cs.avgDurationSeconds,
    goal,
    actual,
    remaining,
    goalAchievement: goalAchievement(actual, goal.value),
    paceNeeded: paceNeeded(remaining, paceDaysLeft),
    paceDaysLeft,
    paceNote,
  };
}

// ---------- team trends (simple, restrained; hand-rolled SVG on the page) ----------

/** Buckets with fewer than this many denominator rows show "—" (never a spike from 1–2 points). */
export const TREND_MIN_DENOMINATOR = 3;

export type TrendBucketMode = "day" | "week";

export interface TrendPoint {
  /** Bucket id: ET calendar date ("day") or week Monday ("week"). */
  key: string;
  /** Short axis label, e.g. "Sep 25" or "Wk of Sep 21". */
  label: string;
  bookings: number;
  calls: number;
  callsOverThreshold: number;
  bookingsFromOverThreshold: number;
  conversationConversion: number | null; // null when calls over threshold < TREND_MIN_DENOMINATOR
  assignedLeadConversion: number | null; // null when assigned leads worked < TREND_MIN_DENOMINATOR
  avgCallDurationSeconds: number | null;
  /** Leads worked in the bucket (work_date cohort — consistent with the metrics layer). */
  leads: number;
  /** Family-sheet share of `leads` — split of the SAME already-computed rows (no new math). */
  family: number;
  /** Animalia-sheet share of `leads` — split of the SAME already-computed rows (no new math). */
  animalia: number;
  /** Reference-line value: weekly lead budget per week, budget ÷ 7 per day. */
  budgetRef: number;
}

export interface TeamTrends {
  bucketMode: TrendBucketMode;
  /** How the buckets were built — shown on the page so the axis is never ambiguous. */
  bucketNote: string;
  points: TrendPoint[];
}

function shortDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

// ---------- lead-source split (Family / Animalia) ----------
export interface LeadSplit {
  family: number;
  animalia: number;
}
/**
 * Split ALREADY-COMPUTED lead rows by source sheet — no new math, no new
 * cohort logic: rows counted here are exactly the rows the caller already
 * aggregated into a `leads` total. A row counts as family/animalia when its
 * lead_type (source_sheet fallback) names that sheet; rows with any other or
 * blank type stay in the total but in NEITHER split (never guessed).
 */
export function splitLeadRows(leads: LeadRow[]): LeadSplit {
  let family = 0;
  let animalia = 0;
  for (const l of leads) {
    const t = (l.lead_type || l.source_sheet || "").trim().toLowerCase();
    if (t === "family") family += 1;
    else if (t === "animalia") animalia += 1;
  }
  return { family, animalia };
}

/**
 * Trend buckets for the Team page. Ranges of ≤ 31 days get one bucket per ET
 * calendar day; longer ranges bucket by operational week (Mon–Sun), with
 * clamped partial weeks at the edges. All aggregation flows through the same
 * metrics helpers as every other number — no parallel math here.
 */
export function buildTeamTrends(input: {
  calls: CallRow[];
  appts: AppointmentRow[];
  attributions: AttributionRow[];
  allCallsForJoin: CallRow[];
  leads: LeadRow[];
  leadCountAdjustments?: LeadCountAdjustment[];
  start: string;
  end: string;
  /** Stored weekly lead budget per covered week (default 700 when unset) — budgets are editable by week. */
  weeklyBudgetByWeek: Map<string, number>;
  thresholdSeconds: number;
}): TeamTrends {
  const days = dateRange(input.start, input.end);
  const mode: TrendBucketMode = days.length <= 31 ? "day" : "week";

  // clamped bucket boundaries: [bucketStart, bucketEnd] inclusive ET dates
  const buckets: Array<{ key: string; start: string; end: string }> = [];
  if (mode === "day") {
    for (const d of days) buckets.push({ key: d, start: d, end: d });
  } else {
    for (const ws of mondaysInRange(input.start, input.end)) {
      buckets.push({ key: ws, start: ws < input.start ? input.start : ws, end: addDays(ws, 6) > input.end ? input.end : addDays(ws, 6) });
    }
  }

  const points = buckets.map((b) => {
    // S7c: bookings bucket by ET BUSINESS DATE (created_business_date) — the
    // calendar dates the bookings were made on; calls stay instant-bounded.
    const startUtc = etDayStartOf(b.start);
    const endUtc = etDayEndUtc(b.end);
    const bCalls = input.calls.filter((c) => c.started_at >= startUtc && c.started_at < endUtc);
    const bAppts = input.appts.filter((a) => {
      const d = createdBusinessDateOf(a);
      return d != null && d >= b.start && d <= b.end;
    });
    const bLeads = input.leads.filter((l) => l.work_date >= b.start && l.work_date <= b.end);
    const bAdjustment = (input.leadCountAdjustments ?? [])
      .filter((a) => a.work_date >= b.start && a.work_date <= b.end)
      .reduce((sum, a) => sum + (Number(a.delta) || 0), 0);
    const bLeadsCount = bLeads.length + bAdjustment;
    const leadSplit = splitLeadRows(bLeads);
    const cs = summarizeCalls(bCalls, input.thresholdSeconds);
    const bookings = countBookingsCreatedBetween(bAppts, "", "9999");
    const fromOver = bookingsFromOverThresholdCalls(
      bAppts,
      input.attributions,
      input.allCallsForJoin,
      input.thresholdSeconds,
    ).length;
    const weeklyBudget = input.weeklyBudgetByWeek.get(weekStart(b.start)) ?? 700;
    return {
      key: b.key,
      label: mode === "day" ? shortDayLabel(b.key) : `Wk of ${shortDayLabel(b.key)}`,
      bookings,
      calls: cs.total,
      callsOverThreshold: cs.overThreshold,
      bookingsFromOverThreshold: fromOver,
      conversationConversion: cs.overThreshold >= TREND_MIN_DENOMINATOR ? conversationConversion(fromOver, cs.overThreshold) : null,
      assignedLeadConversion: bLeadsCount >= TREND_MIN_DENOMINATOR ? assignedLeadConversion(bookings, bLeadsCount) : null,
      avgCallDurationSeconds: cs.avgDurationSeconds,
      leads: bLeadsCount,
      family: leadSplit.family,
      animalia: leadSplit.animalia,
      budgetRef: mode === "week" ? weeklyBudget : weeklyBudget / 7,
    } satisfies TrendPoint;
  });

  return {
    bucketMode: mode,
    bucketNote:
      mode === "day"
        ? `Daily points (ET) · conversions show "—" for days with fewer than ${TREND_MIN_DENOMINATOR} qualifying rows`
        : `Weekly buckets (Mon–Sun, ET) · conversions show "—" for weeks with fewer than ${TREND_MIN_DENOMINATOR} qualifying rows`,
    points,
  };
}

// ---------- studio availability ----------

export interface AvailabilityRule {
  weekday: number; // 0=Sun..6=Sat
  open_time: string; // "HH:MM"
  close_time: string; // "HH:MM"
  active: boolean;
}

export interface BlockedTimeRow {
  id: string;
  start_at: string; // ISO UTC
  end_at: string; // ISO UTC
  reason: string | null;
}

/**
 * Open studio slots for an ET calendar date: generated from studio hours,
 * slot interval and appointment duration, minus booked appointments (with
 * padding) and blocked times. Pure — used by Today and Availability pages.
 *
 * DELEGATES to computeDayAvailability (src/server/metrics/availability.ts) —
 * the ONE availability engine. Today gets the same slot list as before; the
 * Availability payload additionally gets capacity/booked/utilization/blocked
 * from the same evaluation, so the two pages can never diverge. The only
 * behavior refinement: an appointment's session end now uses its stored
 * duration_minutes when present (owner spec: "availability must respect the
 * selected type's duration") instead of the hardcoded 1-hour approximation.
 */
export function computeOpenSlots(input: {
  date: string;
  rules: AvailabilityRule[];
  blocked: BlockedTimeRow[];
  appointments: AppointmentRow[]; // appointments whose session time overlaps the day
  slotIntervalMin: number;
  durationMin: number;
  paddingMin: number;
}): string[] {
  return computeDayAvailability(input).openSlotTimes;
}

/**
 * Weekly recurring blocked times (Settings): expand a weekday pattern into the
 * concrete UTC block rows the open-slot engine consumes for ONE ET date. Pure —
 * queries call it per queried day so the engine itself stays date-agnostic.
 */
export interface RecurringBlock {
  id: string;
  weekday: number; // 0=Sun..6=Sat
  start_time: string; // "HH:MM" ET
  end_time: string; // "HH:MM" ET
  reason: string | null;
  active: boolean;
}

export function materializeRecurringBlocks(date: string, blocks: RecurringBlock[]): BlockedTimeRow[] {
  const wd = weekdayOf(date);
  const baseMs = new Date(etDayStartOf(date)).getTime(); // ET midnight → UTC ms
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  return blocks
    .filter((b) => b.active && b.weekday === wd)
    .map((b) => ({
      id: `recurring:${b.id}:${date}`,
      start_at: new Date(baseMs + toMin(b.start_time) * 60_000).toISOString(),
      end_at: new Date(baseMs + toMin(b.end_time) * 60_000).toISOString(),
      reason: b.reason ?? null,
    }));
}

// ---------- unattributed bookings queue (SPEC: manual attribution) ----------

/** Appointment row plus the client fields the queue needs (store returns these joined). */
export interface AppointmentWithClient extends AppointmentRow {
  acuity_appointment_id?: string | null;
  client_name?: string | null;
  client_phone?: string | null;
  client_email?: string | null;
  calendar_name?: string | null;
}

export interface QueueCandidateCall {
  call_id: string;
  rep_id: string | null;
  started_at: string;
  duration_seconds: number;
}

export interface UnattributedBookingRow {
  appointment_id: string;
  acuity_appointment_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  appointment_type: string;
  calendar_name: string | null;
  appointment_datetime: string;
  created_at: string;
  /** Contact's assigned owner — the default pick when Christopher assigns manually. */
  suggested_rep_id: string | null;
  candidate_calls: QueueCandidateCall[]; // qualifying calls, most recent first (max 3)
  /**
   * WHY the booking is unattributed — the attribution engine's reason for this
   * appointment ("no-qualifying-call" | "ambiguous" | "no-contact-identity" |
   * "bad-datetime" | "manually-assigned"), or null when no engine result was
   * supplied. Never guessed here; the queue renders what the engine said.
   */
  reason: string | null;
  /**
   * S4b refined no-rep category (booking_attributions.reason_code): the
   * stored tick-time classification when the booking has a verdict row
   * ("no-window-interaction" | "interaction-without-roster-rep" |
   * "no-matching-contact" | "no-contact-identity" | "bad-datetime" |
   * "ambiguous"), else the live engine match's noRepReason, else null. The
   * grouped queue summary and the per-row reason label read THIS, never the
   * freeform note.
   */
  reason_code: string | null;
  /** True when the stored attribution row for this appointment is a manual override. */
  manual: boolean;
}

/**
 * Active bookings with no attributed rep — the queue SPEC requires ("If
 * attribution is unclear, put it in UNATTRIBUTED BOOKINGS"). Pure: suggests
 * the contact's owner and lists qualifying calls (over threshold, whose ET
 * date falls in the owner-ratified DATE-GRANULARITY attribution window — the
 * booking's creation date or the immediately preceding one, America/New_York)
 * but NEVER guesses on its own.
 */
export function buildUnattributedQueue(input: {
  appointments: AppointmentWithClient[];
  attributions: AttributionRow[];
  calls: CallRow[];
  contacts: { id: string; phone: string | null; email: string | null; assigned_rep_id: string | null }[];
  thresholdSeconds: number;
  /**
   * LEGACY knob (kept so call sites compile): the engine's candidate window
   * is now the DATE-GRANULARITY rule (creation ET date and the day before) and
   * no longer derives from an hour count.
   */
  windowHours?: number;
  /** Engine results (matchAppointmentsToCalls) — supply the per-appointment reason. */
  matches?: { appointmentId: string; reason?: string; noRepReason?: string | null }[];
}): UnattributedBookingRow[] {
  const attributed = new Set(input.attributions.filter((a) => a.rep_id).map((a) => a.appointment_id));
  const manualIds = new Set(input.attributions.filter((a) => a.manual_override).map((a) => a.appointment_id));
  const matchByAppt = new Map((input.matches ?? []).map((m) => [m.appointmentId, m]));
  const storedByAppt = new Map(input.attributions.map((a) => [a.appointment_id, a]));
  const contactById = new Map(input.contacts.map((c) => [c.id, c]));
  const contactByPhone = new Map<string, (typeof input.contacts)[number]>();
  const contactByEmail = new Map<string, (typeof input.contacts)[number]>();
  for (const c of input.contacts) {
    const p = normalizeUSPhone(c.phone);
    if (p) contactByPhone.set(p, c);
    const e = normalizeEmail(c.email);
    if (e) contactByEmail.set(e, c);
  }

  const rows: UnattributedBookingRow[] = [];
  // ET-date membership in the attribution window (call date == creation date
  // or the day before; unparseable calls never qualify).
  const inWindowDate = (startedAt: string, window: { from: string; to: string }): boolean => {
    const d = callDateEt(startedAt);
    return d != null && d >= window.from && d <= window.to;
  };
  for (const a of input.appointments) {
    if (!isBooking(a) || attributed.has(a.id)) continue;
    const contact =
      (a.contact_id ? contactById.get(a.contact_id) : undefined) ??
      (a.client_phone ? contactByPhone.get(normalizeUSPhone(a.client_phone) ?? "") : undefined) ??
      (a.client_email ? contactByEmail.get(normalizeEmail(a.client_email) ?? "") : undefined);
    // DATE-GRANULARITY candidate window (owner-ratified 2026-09-26): the call's
    // ET date must equal the booking's creation ET date or the day before.
    // Acuity dateCreated is date-only; intra-day ordering is never assumed.
    const anchor = bookingCreationDateEt(a);
    const window = anchor ? attributionWindowDates(anchor.date) : null;
    const candidates: QueueCandidateCall[] = (contact && window
      ? input.calls.filter(
          (c) =>
            c.contact_id === contact.id &&
            c.duration_seconds > input.thresholdSeconds &&
            inWindowDate(c.started_at, window),
        )
      : []
    )
      .sort((x, y) => (x.started_at < y.started_at ? 1 : -1))
      .slice(0, 3)
      .map((c) => ({ call_id: c.id, rep_id: c.rep_id, started_at: c.started_at, duration_seconds: c.duration_seconds }));
    rows.push({
      appointment_id: a.id,
      acuity_appointment_id: a.acuity_appointment_id ?? null,
      client_name: a.client_name ?? null,
      client_phone: a.client_phone ?? null,
      client_email: a.client_email ?? null,
      appointment_type: a.appointment_type,
      calendar_name: a.calendar_name ?? null,
      appointment_datetime: a.appointment_datetime,
      created_at: a.created_at,
      suggested_rep_id: contact?.assigned_rep_id ?? null,
      candidate_calls: candidates,
      reason: manualIds.has(a.id) ? "manually-assigned" : matchByAppt.get(a.id)?.reason ?? null,
      // S4b: the STORED tick-time classification is the truth about why this
      // booking has no rep (the queue's live engine run does not see the
      // harvest interactions); the live match's refined reason is the
      // fallback for bookings whose verdict row has not been written yet.
      reason_code: manualIds.has(a.id)
        ? null
        : storedByAppt.get(a.id)?.reason_code ?? matchByAppt.get(a.id)?.noRepReason ?? null,
      manual: manualIds.has(a.id),
    });
  }
  rows.sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
  return rows;
}

// ---------- booking-coverage invariants (SPEC: the totals must reconcile) ----------

/**
 * THE THREE ATTRIBUTION STATES (owner directive 2026-09-27, S5b) — MUTUALLY
 * EXCLUSIVE everywhere they are computed and displayed:
 *
 *   Total Bookings = Attributed + Ambiguous + Unattributed
 *
 * Ambiguous is its OWN state, NEVER folded into Unattributed. Operationally
 * both may need manual follow-up, but they are different data states and stay
 * visibly separate. Ambiguous rows stay Ambiguous until Christopher assigns
 * them by hand — they are never silently counted as cleanly unattributed.
 */
export type BookingAttributionState = "attributed" | "ambiguous" | "unattributed";

/**
 * How an ambiguous verdict is recognized on a STORED row. toAttributionRows
 * persists the engine reason as the note's first token ("ambiguous — <detail>;
 * …"), so the prefix IS the stored state marker — read through this one
 * helper only, never re-derived ad hoc. Rows whose note does not start with
 * it (and carry no rep) are genuinely unattributed.
 */
export const AMBIGUOUS_NOTE_PREFIX = "ambiguous";

/** The ONE stored-row → state classifier (mutually exclusive by construction). */
export function attributionStateOf(row: Pick<AttributionRow, "rep_id" | "note" | "manual_override">): BookingAttributionState {
  // A rep on the row (manual assignment included) is attributed — the note is
  // audit context only and never downgrades an owned booking.
  if (row.rep_id !== null) return "attributed";
  if ((row.note ?? "").startsWith(AMBIGUOUS_NOTE_PREFIX)) return "ambiguous";
  return "unattributed";
}

export interface BookingCoverage {
  /** ALL qualifying (non-Zoom, non-cancelled) bookings in the period — attribution NOT required. */
  total: number;
  /** Bookings with an attribution row naming a rep (manual assignments included). */
  attributed: number;
  /** Ambiguous verdicts (identity conflicts, multi-rep evidence) — their OWN state, never inside Unattributed. */
  ambiguous: number;
  /** Genuinely unattributed bookings — EXCLUDES ambiguous (three-way invariant). */
  unattributed: number;
}

/**
 * THE coverage invariant (owner directive 2026-09-27): Attributed + Ambiguous
 * + Unattributed === Total, where Total = every qualifying booking in the
 * period regardless of identity resolution. The three states are mutually
 * exclusive BY CONSTRUCTION (attributionStateOf — each booking lands in
 * exactly one), so Ambiguous can never silently inflate Unattributed. Total
 * can NEVER shrink because identity resolution is incomplete — incomplete
 * identity only moves bookings between states. Pure; the metrics layer is the
 * one place this is computed.
 */
export function bookingCoverage(appts: AppointmentRow[], attributions: AttributionRow[]): BookingCoverage {
  const s = bookingAttributionSplit(appts, attributions);
  return { total: s.total, attributed: s.attributed, ambiguous: s.ambiguous, unattributed: s.unattributed + s.withoutVerdict };
}

export interface BookingAttributionSplit extends BookingCoverage {
  /**
   * Qualifying bookings with NO stored verdict row at all (e.g. older than the
   * attribution recompute window). A missing row is an HONEST gap, never
   * silently reported as unattributed: Total = A + Am + U + withoutVerdict.
   */
  withoutVerdict: number;
}

/**
 * The display-facing three-way split over one period's bookings, straight off
 * the STORED attribution states (attributionStateOf — no recomputation, no
 * guessing). Bookings without a stored verdict row surface as `withoutVerdict`
 * so a page can say so instead of inventing a state.
 */
export function bookingAttributionSplit(appts: AppointmentRow[], attributions: AttributionRow[]): BookingAttributionSplit {
  const qualifying = appts.filter((a) => isBooking(a));
  const qualifyingIds = new Set(qualifying.map((a) => a.id));
  const rowByAppt = new Map(
    attributions.filter((r) => qualifyingIds.has(r.appointment_id)).map((r) => [r.appointment_id, r]),
  );
  let attributed = 0;
  let ambiguous = 0;
  let unattributed = 0;
  let withoutVerdict = 0;
  for (const a of qualifying) {
    const row = rowByAppt.get(a.id);
    if (!row) {
      withoutVerdict += 1;
      continue;
    }
    switch (attributionStateOf(row)) {
      case "attributed":
        attributed += 1;
        break;
      case "ambiguous":
        ambiguous += 1;
        break;
      case "unattributed":
        unattributed += 1;
        break;
    }
  }
  return { total: qualifying.length, attributed, ambiguous, unattributed, withoutVerdict };
}

/**
 * Assert the coverage invariant for one evaluation:
 *   1. every qualifying booking carries EXACTLY ONE verdict row;
 *   2. Attributed + Ambiguous + Unattributed equals the qualifying Total
 *      (the three states are mutually exclusive — Ambiguous is never folded
 *      into Unattributed);
 *   3. (when supplied) the engine produced a verdict for every booking.
 * Throws on violation — the sync records the error, never silently persists a
 * dishonest split.
 */
export function assertBookingInvariant(
  appts: AppointmentRow[],
  attributions: AttributionRow[],
  verdicts?: { engineAttributed: number; engineUnattributed: number },
): void {
  const cov = bookingCoverage(appts, attributions);
  const qualifyingIds = new Set(appts.filter((a) => isBooking(a)).map((a) => a.id));
  const rowsForQualifying = attributions.filter((r) => qualifyingIds.has(r.appointment_id));
  if (rowsForQualifying.length !== cov.total || new Set(rowsForQualifying.map((r) => r.appointment_id)).size !== cov.total) {
    throw new Error(
      `Booking invariant violated: ${cov.total} qualifying bookings carry ${rowsForQualifying.length} verdict rows (expected exactly one each)`,
    );
  }
  if (cov.attributed + cov.ambiguous + cov.unattributed !== cov.total) {
    throw new Error(
      `Booking invariant violated: attributed(${cov.attributed}) + ambiguous(${cov.ambiguous}) + unattributed(${cov.unattributed}) must equal total(${cov.total})`,
    );
  }
  if (verdicts && verdicts.engineAttributed + verdicts.engineUnattributed !== cov.total) {
    throw new Error(
      `Booking invariant violated: engine verdicts attributed(${verdicts.engineAttributed}) + unattributed(${verdicts.engineUnattributed}) must equal total(${cov.total})`,
    );
  }
}
// ---------- writer protection (owner directive 2026-09-27) ----------
/**
 * DEGRADATION GUARD — the 49→3 failure shape. The stale-writer incident
 * (9/26–9/27): an outdated deployed process rewrote booking_attributions with
 * old semantics every 2–5 min, silently re-classifying 46 engine-attributed
 * rows to unattributed (49→3). This guard makes that shape a LOUD refusal:
 * a write that would strip attribution from more than
 * ATTRIBUTION_DEGRADE_MAX_STRIP_FRACTION of the currently-attributed,
 * non-manual rows it touches (and touches at least
 * ATTRIBUTION_DEGRADE_MIN_TOUCHED of them) is refused by the store — the
 * tick records an error sync_run and the table keeps its verdicts.
 *
 * Pure: both store implementations call this ONE function, so memory and PG
 * enforce identical semantics. Deliberate changes recover via documented
 * paths (higher writer version takes over; `force` on the store call;
 * per-booking manual assignment is never guarded — it IS a recovery path).
 */
export const ATTRIBUTION_DEGRADE_MIN_TOUCHED = 10;
export const ATTRIBUTION_DEGRADE_MAX_STRIP_FRACTION = 0.2;
export function attributionDegradation(
  existing: AttributionRow[],
  incoming: AttributionRow[],
): { stripped: number; touched: number } | null {
  const incomingByAppt = new Map(incoming.map((r) => [r.appointment_id, r]));
  let touched = 0;
  let stripped = 0;
  for (const ex of existing) {
    if (ex.manual_override) continue; // manual rows are skipped by the upsert — never strippable
    if (ex.rep_id === null) continue; // only attributed rows can be stripped
    const inc = incomingByAppt.get(ex.appointment_id);
    if (!inc) continue; // not touched by this write
    touched += 1;
    if (inc.rep_id === null) stripped += 1; // attributed → rep-less (unattributed or ambiguous)
  }
  if (touched < ATTRIBUTION_DEGRADE_MIN_TOUCHED) return null;
  if (stripped > 0 && stripped / touched > ATTRIBUTION_DEGRADE_MAX_STRIP_FRACTION) {
    return { stripped, touched };
  }
  return null;
}

// ---------- daily report (SPEC: Daily CC Report) ----------
/**
 * The full Daily Report metric model. Every number on the Daily Report page
 * (and in the copied report text) comes from here — the page never computes.
 * Performance is YESTERDAY'S (the report is written the next morning) plus
 * CURRENT WEEK progress for goals/leads, exactly per SPEC.
 */
export interface DailyReportMetrics {
  reportDate: string;
  weekStart: string;
  leadCohortSourceDates: string[];
  bookingsYesterday: number;
  bookingsWtd: number;
  weeklyBookingGoal: number;
  bookingsLeft: number;
  dailyBookingsNeeded: number;
  /** Working days left in the week (Mon–Fri incl. today); 0 on a weekend. */
  workDaysLeft: number;
  /** True when no working days remain (Sat/Sun) — pace figures show 0 + a note. */
  paceWeekend: boolean;
  /** Bookings from >threshold calls yesterday ÷ calls >threshold yesterday. */
  conversationConversion: number | null;
  /** Bookings created yesterday ÷ leads worked yesterday (work-date logic). */
  assignedLeadConversion: number | null;
  /** Bookings WTD ÷ weekly booking goal. */
  goalAchievement: number | null;
  weeklyLeadBudget: number;
  leadsToday: number;
  familyLeadsToday: number;
  animaliaLeadsToday: number;
  weeklyLeads: number;
  leadBudgetUsedPct: number | null;
  leadsRemaining: number;
  dailyLeadsNeeded: number;
}

/** Assemble the Daily Report metrics from raw rows. Pure — no DB, no Date.now. */
export function buildDailyReportMetrics(input: {
  reportDate: string;
  callsYesterday: CallRow[]; // calls started yesterday (ET)
  apptsCreatedYesterday: AppointmentRow[];
  apptsCreatedWtd: AppointmentRow[]; // week-to-date, includes yesterday+today
  allCallsForWeek: CallRow[]; // for the over-threshold join
  attributions: AttributionRow[];
  leadsAllRecent: LeadRow[]; // leads whose work_date falls in this week (incl today's cohort)
  leadCountAdjustments?: LeadCountAdjustment[];
  teamBookingGoal: number;
  weeklyLeadBudget: number;
  thresholdSeconds: number;
}): DailyReportMetrics {
  const reportDate = input.reportDate;
  const ws = weekStart(reportDate);

  const bookingsYesterday = countBookingsCreatedBetween(input.apptsCreatedYesterday, "", "9999");
  const bookingsWtd = countBookingsCreatedBetween(input.apptsCreatedWtd, "", "9999");

  const fromOverYesterday = bookingsFromOverThresholdCalls(
    input.apptsCreatedYesterday,
    input.attributions,
    input.allCallsForWeek,
    input.thresholdSeconds,
  );
  const callsYesterday = summarizeCalls(input.callsYesterday, input.thresholdSeconds);

  const adj = input.leadCountAdjustments;
  const todayCohort = leadsToday(input.leadsAllRecent, reportDate, adj);
  const weekly = leadsForWeek(input.leadsAllRecent, reportDate, adj);
  const yesterdayWork = addDays(reportDate, -1);
  // Leads the team WORKED yesterday = work_date === yesterday (Mon handled by
  // the work_date stored per lead — getWorkDate already folded Fri–Sun → Mon).
  const yesterdayLeads = applyLeadAdjustments(
    summarizeLeadRows(input.leadsAllRecent.filter((l) => l.work_date === yesterdayWork)),
    adj,
    (a) => a.work_date === yesterdayWork,
  );

  const bookingsLeft = Math.max(0, input.teamBookingGoal - bookingsWtd);
  const workDaysLeft = daysLeftInWorkWeek(reportDate);

  return {
    reportDate,
    weekStart: ws,
    leadCohortSourceDates: getLeadCohort(reportDate),
    bookingsYesterday,
    bookingsWtd,
    weeklyBookingGoal: input.teamBookingGoal,
    bookingsLeft,
    dailyBookingsNeeded: paceNeeded(bookingsLeft, workDaysLeft),
    workDaysLeft,
    paceWeekend: workDaysLeft === 0,
    conversationConversion: conversationConversion(fromOverYesterday.length, callsYesterday.overThreshold),
    assignedLeadConversion: assignedLeadConversion(bookingsYesterday, yesterdayLeads.total),
    goalAchievement: goalAchievement(bookingsWtd, input.teamBookingGoal),
    weeklyLeadBudget: input.weeklyLeadBudget,
    leadsToday: todayCohort.total,
    familyLeadsToday: todayCohort.family,
    animaliaLeadsToday: todayCohort.animalia,
    weeklyLeads: weekly.total,
    leadBudgetUsedPct: leadBudgetUsage(weekly.total, input.weeklyLeadBudget),
    leadsRemaining: leadsRemaining(weekly.total, input.weeklyLeadBudget),
    dailyLeadsNeeded: dailyLeadsNeeded(weekly.total, input.weeklyLeadBudget, reportDate),
  };
}

// local shims to avoid circular imports
import { etDayEndUtc, etDayStartUtc as etDayStartOf } from "../date-logic";
function weekdayOf(dateStr: string): number {
  // weekday() is calendar-pure; import at top instead once — kept local for clarity
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export { dateRange };
