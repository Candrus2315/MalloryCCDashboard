/**
 * RETENTION WEEKLY SCORECARD (stage 3c; plan §16 + UI-DESIGN-SPEC §4).
 *
 * Auto-computes every Monday ~06:00 ET (scorecard-tick.ts) for the PRIOR
 * COMPLETED Mon–Sun ET week; results are stored append-if-new (store
 * ret_scorecards) so past weeks render byte-identically forever — a stored
 * week is NEVER rewritten, and a recompute of the same week writes nothing.
 *
 * IN-SCOPE metrics (this stage): eligible, called (≥1 in-window attempt),
 * spoke-with, still unreached, BOTH §16 compliance flavors, Needs Review,
 * Data Match Exceptions — and, since stage 4a, the CANCELLATION FAMILY
 * (cancellations worked / saves / reschedules / recoveries / recovery rate)
 * read from the WRITTEN ret_cancellations ledger through the same
 * §16 inCancellationUniverse predicate the KPI cards and the queue use (ONE
 * source of truth). A week's cancellation events are scoped to R by
 * cancelled_at (the week the cancellations happened); the family fills ONLY
 * when the whole scored week sits inside the ledger's cancelled_at coverage
 * (weekStart ≥ today − compute_lookback_days) — an uncovered week stores null
 * ("—") rather than a false zero. Still OUT OF SCOPE (null, honest "—"):
 * no-shows and transfers — ret_transfers/no-show pipeline have no writer yet.
 *
 * Metric formulas are §16 VERBATIM, mirroring the shipped KPI-band
 * aggregation in ui-data.ts (ONE metrics source of truth — the per-week
 * figures here use the same outcome/attempt rows and the same D10/unreached
 * rules, scoped to R = the scored Mon–Sun ET week).
 *
 * OWNER RESOLUTION: a week is scored against whoever owned the Retention
 * Owner role when the week COMPLETED (effective dates bracket week_end, the
 * plan §12 convention currentRetentionOwner uses for a single date). A
 * mid-week switch scores the week to the owner of record at its close —
 * never hard-coded.
 */
import type { Store, RetentionOwnerHistoryRow, RetentionScorecardWrite, RetentionOutcomeRow } from "../store/types";
import { addDays, etDateStrFromInstant, etDayStartUtc, weekStart } from "../date-logic";
import { UNREACHED_FINAL_STATUSES } from "./classify";
import { inCancellationUniverse } from "./ui-data";

export const RETENTION_SCORECARD_VERSION = "retention-scorecard v1";

/** The prior COMPLETED Mon–Sun ET week relative to an ET calendar date. */
export function priorCompletedWeekEt(todayEt: string): { weekStart: string; weekEnd: string } {
  const thisWeekStart = weekStart(todayEt);
  const weekStartStr = addDays(thisWeekStart, -7);
  return { weekStart: weekStartStr, weekEnd: addDays(thisWeekStart, -1) };
}

/** Weekday (0=Sun..6=Sat) of an ET calendar date string — plain UTC math on the date itself. */
export function etDayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export interface RetentionOwnerForWeek {
  userId: string | null;
  name: string | null;
  initials: string | null;
}

/**
 * The Retention Owner of record for a scored week (plan §12/§16): the last
 * history row whose effective dates bracket the week's END (Sunday). Mirrors
 * currentRetentionOwner's semantics for a single date; never hard-coded.
 */
export function retentionOwnerForWeek(rows: RetentionOwnerHistoryRow[], weekEnd: string): RetentionOwnerForWeek | null {
  const active = rows
    .filter((r) => r.effective_start <= weekEnd && (r.effective_end == null || r.effective_end >= weekEnd))
    .sort((a, b) => (a.effective_start < b.effective_start ? -1 : a.effective_start > b.effective_start ? 1 : a.id < b.id ? -1 : 1));
  const cur = active[active.length - 1];
  if (!cur) return null;
  return { userId: cur.employee_user_id ?? null, name: cur.name ?? null, initials: cur.initials ?? null };
}

/** §16 ratios are null when the denominator is 0 — never a fabricated 0%/100%. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export interface ScorecardComputeInput {
  weekStart: string;
  weekEnd: string;
  dueDays: number;
  /** Scored cohort (pre-filtered by the caller: eligible, due ∈ R). */
  cohort: RetentionOutcomeRow[];
  /** Outcomes with an in-window attempt (attempt flavor numerator = its length). */
  calledCount: number;
  spokenWithCount: number;
  unreachedCount: number;
  needsReviewCount: number;
  matchExceptionsOpen: number;
  owner: RetentionOwnerForWeek | null;
  /**
   * The cancellations family for R (stage 4a), pre-derived by the caller from
   * the written ledger; null/absent = the week sits outside the ledger's
   * cancelled_at coverage — the five cells store null ("—"), never a false 0.
   */
  cancellations?: { worked: number; saves: number; reschedules: number; recoveries: number } | null;
}

/** Pure §16 assembly from pre-computed counts — directly unit-testable. */
export function buildScorecardWrite(input: ScorecardComputeInput): RetentionScorecardWrite {
  const { weekStart, weekEnd, dueDays, cohort, calledCount, spokenWithCount, unreachedCount, needsReviewCount, matchExceptionsOpen, owner, cancellations } = input;
  const eligible = cohort.length;
  return {
    weekStart,
    weekEnd,
    dueDays,
    ownerUserId: owner?.userId ?? null,
    ownerName: owner?.name ?? null,
    ownerInitials: owner?.initials ?? null,
    eligible,
    called: calledCount,
    spokenWith: spokenWithCount,
    unreached: unreachedCount,
    complianceAppointment: ratio(spokenWithCount, eligible),
    complianceAttempt: ratio(calledCount, eligible),
    // Cancellation family (stage 4a): counts over the written ledger when the
    // week is covered; recovery rate needs a denominator (worked > 0) — null
    // otherwise ("—", never a fabricated 0%/100%). Uncovered weeks store null.
    cancellationsWorked: cancellations?.worked ?? null,
    saves: cancellations?.saves ?? null,
    reschedules: cancellations?.reschedules ?? null,
    recoveries: cancellations?.recoveries ?? null,
    recoveryRate: cancellations && cancellations.worked > 0 ? cancellations.recoveries / cancellations.worked : null,
    noShows: null,
    noShowsSpoken: null,
    noShowsNotSpoken: null,
    transfers: null,
    needsReview: needsReviewCount,
    matchExceptions: matchExceptionsOpen,
    computeVersion: RETENTION_SCORECARD_VERSION,
  };
}

export interface WeeklyScorecardResult {
  outcome: "computed" | "already-stored";
  created: boolean;
  weekStart: string;
  weekEnd: string;
}

/**
 * Compute + persist the weekly scorecard for one Mon–Sun ET week.
 * Idempotent: if a stored row for weekStart exists, nothing is computed and
 * nothing is written (already-stored). Errors propagate to the caller (the
 * tick records them on its sync_runs row).
 */
export async function computeAndStoreWeeklyScorecard(
  store: Store,
  options: { weekStart: string; weekEnd: string; now?: () => Date },
): Promise<WeeklyScorecardResult> {
  const { weekStart, weekEnd } = options;
  const now = options.now ?? (() => new Date());
  const stored = await store.getRetentionScorecard(weekStart);
  if (stored) return { outcome: "already-stored", created: false, weekStart, weekEnd };

  const settings = await store.getSettings();
  const retention = settings.retention ?? {
    due_days: 7,
    qualifying_statuses: ["scheduled"],
    compute_lookback_days: 30,
    employee_initials: {},
    max_attempts: null,
    max_attempt_days: null,
    max_contact_days: null,
  };
  const dueDays = retention.due_days;
  const nowMs = now().getTime();

  // The due cohort for R (§16: eligible + due_date ∈ R), read from the SAME
  // outcome rows the KPI band aggregates — one metrics source of truth.
  const outcomes = await store.listRetentionAppointmentOutcomes();
  const cohort = outcomes.filter((o) => o.eligible && o.contact_due_date >= weekStart && o.contact_due_date <= weekEnd);
  const cohortIds = new Set(cohort.map((o) => o.appointment_id));
  const calledCount = cohort.filter((o) => o.attempts_count >= 1).length;
  const spokenWithCount = cohort.filter((o) => o.final_status === "verified_spoke_with").length;
  const needsReviewCount = cohort.filter((o) => o.final_status === "needs_review").length;

  // Still Unreached (§16 verbatim): final_status ∈ {no_answer, attempted_unclear}
  // AND (appointment window still open OR window closed with zero answered
  // attempts). For a prior-week scorecard most sessions are still 0–7 days out,
  // so the appointment rows must be consulted for the open-window test — same
  // fetch floor shape the compute/ui-data use (due window floor minus margin).
  const floorIso = etDayStartUtc(addDays(weekStart, -(dueDays + 2)));
  const appts = await store.getAppointmentsWithClientsSince(floorIso);
  const apptById = new Map(appts.map((a) => [a.id, a]));
  const apptMsOf = (o: RetentionOutcomeRow): number | null => {
    const a = apptById.get(o.appointment_id);
    if (!a) return null;
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) ? ms : null;
  };
  const unreachedCount = cohort.filter((o) => {
    if (!UNREACHED_FINAL_STATUSES.has(o.final_status)) return false;
    const ms = apptMsOf(o);
    const windowOpen = ms != null && ms >= nowMs;
    return windowOpen || !o.any_answered;
  }).length;

  const [ownerRows, matchExceptionsOpen, cancellationRows] = await Promise.all([
    store.listRetentionOwnerHistory(),
    store.countDataMatchExceptions("open"),
    store.listRetentionCancellations(),
  ]);
  const owner = retentionOwnerForWeek(ownerRows, weekEnd);

  // Cancellation family (stage 4a): the week's cancellation events, scoped to
  // R by cancelled_at ET date, counted through the SAME §16 predicate the
  // cards/queue use. COVERAGE GATE: the ledger only contains cancellations
  // whose cancelled_at sits inside the module's compute_lookback_days window —
  // a scored week older than that would silently count 0 (a false zero), so
  // an uncovered week stores null ("—") for the whole family instead.
  const coverageFloor = addDays(etDateStrFromInstant(nowMs), -retention.compute_lookback_days);
  const weekCovered = weekStart >= coverageFloor;
  const weekRows = weekCovered
    ? cancellationRows.filter((r) => {
        if (!r.cancelled_at) return false;
        const ms = Date.parse(r.cancelled_at);
        if (!Number.isFinite(ms)) return false;
        const d = etDateStrFromInstant(ms);
        return d >= weekStart && d <= weekEnd;
      })
    : [];
  const cancellations = weekCovered
    ? {
        worked: weekRows.length,
        saves: weekRows.filter((r) => inCancellationUniverse(r, "saves")).length,
        reschedules: weekRows.filter((r) => inCancellationUniverse(r, "reschedules")).length,
        recoveries: weekRows.filter((r) => inCancellationUniverse(r, "recovery")).length,
      }
    : null;

  const write = buildScorecardWrite({
    weekStart,
    weekEnd,
    dueDays,
    cohort,
    calledCount,
    spokenWithCount,
    unreachedCount,
    needsReviewCount,
    matchExceptionsOpen,
    owner,
    cancellations,
  });
  const { created, row } = await store.insertRetentionScorecardIfAbsent(write);
  if (!created && !row) throw new Error("ret_scorecards insert returned neither created row nor stored row");
  const todayEt = etDateStrFromInstant(nowMs);
  console.log(
    `[retention-scorecard] week=${weekStart}..${weekEnd} owner=${write.ownerName ?? write.ownerInitials ?? "—"} eligible=${write.eligible} called=${write.called} spoke=${write.spokenWith} unreached=${write.unreached} created=${created} (today ${todayEt})`,
  );
  return { outcome: created ? "computed" : "already-stored", created, weekStart, weekEnd };
}
