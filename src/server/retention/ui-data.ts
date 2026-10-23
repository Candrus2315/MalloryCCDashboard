/**
 * RETENTION UI DATA (stage 3b) — the read-only aggregation layer between the
 * ret_* tables (maintained by the stage-3a compute job) and the Retention
 * tab / drill-down. NO WRITES: every function here only reads (the "do not
 * write to retention tables from the UI" rule) — management actions on the
 * exceptions queue go through the shipped exceptions-api endpoints.
 *
 * SOURCE OF TRUTH: IMPLEMENTATION-PLAN.md §16 (metric formulas — D1–D14
 * approved 10/19) + UI-DESIGN-SPEC.md §2 (the 12 cards, owner order). Formulas
 * are implemented VERBATIM and echoed verbatim in the route InfoTips.
 *
 * HONESTY RULES:
 *  - Cards 6–9 (Active Cancellations, Saves, Reschedules, Recovery Rate) read
 *    ret_cancellations (stage 4a writer live). A count of 0 over a WRITTEN
 *    ledger is a fact, not a fabrication; the Recovery RATE stays null ("—")
 *    while the ledger has no eligible rows (never a fabricated 0%/100%).
 *  - Transfers (stage 5) read the WRITTEN ret_transfers ledger — the
 *    transfers engine owns it: queue rows, the Needs-Attention stage card and
 *    the This-Week KPI here; the scorecard's own transfers cell stays honest
 *    — (its scorecard writer is a follow-up).
 *  - The Weekly Scorecard is NOT computed here (separate later delegation);
 *    the page renders its EmptyState until storage exists.
 *
 * Production volumes are tiny (the 7-day excitement cohort — 239 outcomes /
 * 139 attempts live-fire), so reads are the store's bulk reads and the
 * aggregation is in-memory, matching the retention store's own doctrine.
 */
import type { Store, RetentionOutcomeRow, RetentionAttemptRow, RetentionOwnerHistoryRow, RetentionCancellationRow, RetentionTransferRow } from "../store/types";
import type { DataMatchExceptionRow, InternalClientRow } from "../store/types";
import { addDays, etDateStrFromInstant, etDayStartUtc, weekStart, OPERATIONAL_TIMEZONE } from "../date-logic";
import type { NoteEvidence } from "./classify";
import { RECOVERED_OUTCOMES } from "./cancellations";
import { DEFAULT_RETENTION_SETTINGS, normalizeRetentionSettings } from "../store/types";

// ---- Retention data-start boundary (owner directive 10/21) ----

/**
 * OWNER DIRECTIVE 10/21: "Laura just started this position Mon Oct 19th —
 * i dont need any data before the week of the 12th of Oct for the retention
 * tab." Retention DISPLAY surfaces — the 12-card overview, the Needs
 * Attention queue, the drill-downs, the Data Match Exceptions workspace and
 * the scorecard display — show nothing from before the week of Monday
 * 2026-10-12 ET. An appointment whose ET calendar date is >= 2026-10-12 is in
 * scope; anything earlier is pre-tenure noise (Laura started 10/19).
 *
 * DISPLAY-LAYER FILTER ONLY: no stored row is deleted, rewritten, or
 * backfilled, and no writer changes — attempt outcomes, the cancellations
 * ledger and the scorecard storage keep observing everything and the audit
 * trail stays complete (the departed-rep-history pattern: preserved, not
 * shown). A future Settings surface can override this by replacing this one
 * constant; every loader reads the boundary through the helpers below.
 */
export const RETENTION_DATA_START_ET = etDayStartUtc("2026-10-12"); // the ET instant of Mon 2026-10-12 00:00
/**
 * The boundary's ET calendar date, derived FROM the constant — now the
 * DEFAULT boundary only: the owner-editable value lives in settings
 * (AppSettings.retention.data_start_week_start) and every loader resolves it
 * from CURRENT settings at call time (the sheets-adapter per-tick contract —
 * no boot-frozen snapshot; regression-pinned in retention-settings.test.ts).
 * A caller that omits the parameter gets exactly the pre-settings behavior
 * (byte-identical), which is what the owner-ratified default preserves.
 */
export const RETENTION_DATA_START_DATE_ET = etDateStrFromInstant(Date.parse(RETENTION_DATA_START_ET));

/**
 * Is this appointment in retention-DISPLAY scope (owner directive 10/21)?
 * Keys on the appointment's ET calendar date — exactly the directive's
 * wording ("before the week of the 12th of Oct"), inclusive at the boundary
 * (Mon Oct 12 00:00 ET counts). An appointment whose instant cannot be
 * derived is NOT provably in scope and is excluded — nothing is guessed into
 * the owner's view (fail-honest; in practice the loaders' fetch floor always
 * covers the appointment of every stored outcome/ledger row).
 */
export function inRetentionDataScope(apptMs: number | null | undefined, dataStartWeekStart: string = RETENTION_DATA_START_DATE_ET): boolean {
  if (apptMs == null || !Number.isFinite(apptMs)) return false;
  return etDateStrFromInstant(apptMs) >= dataStartWeekStart;
}

/**
 * Is a stored scorecard week in DISPLAY scope? Stored weeks before the
 * boundary stay in the DB untouched (append-if-new, never rewritten) but are
 * not shown — the departed-rep-history pattern: preserved, not shown.
 */
export function inRetentionScorecardScope(weekStartEt: string, dataStartWeekStart: string = RETENTION_DATA_START_DATE_ET): boolean {
  return weekStartEt >= dataStartWeekStart;
}

/**
 * The triggering instant of a Data Match Exception, when derivable:
 *  - appointment-anchored rows (appt-identity / phone-mismatch): the
 *    appointment datetime via payload.subject.acuity_appointment_id, resolved
 *    through the appointments the caller already loaded (acuity id → ms);
 *  - call-anchored rows (call-identity): context.started_at;
 *  - contact-identity rows carry NO derivable date anywhere → null.
 * An exception with NO derivable trigger is NOT treated as pre-cutoff (its
 * date cannot prove it pre-tenure) — it stays visible for management; the
 * boundary hides only what it can PROVE is pre-cutoff. (Production probe
 * 10/21: all 53 live exceptions are undatable — the workspace is unchanged
 * in practice; this guard exists for future anchored rows.)
 */
export function exceptionTriggerMs(
  e: { payload: Record<string, unknown>; context: Record<string, unknown> | null },
  apptMsByAcuityId: Map<string, number>,
): number | null {
  const subject = (e.payload as { subject?: { acuity_appointment_id?: unknown } }).subject;
  if (subject && typeof subject.acuity_appointment_id === "string") return apptMsByAcuityId.get(subject.acuity_appointment_id) ?? null;
  const startedAt = (e.context as { started_at?: unknown } | null)?.started_at;
  if (typeof startedAt === "string") {
    const ms = Date.parse(startedAt);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/** Scope one Data Match Exception row for DISPLAY (owner directive 10/21 — see RETENTION_DATA_START_ET). */
export function inRetentionExceptionScope(
  e: { payload: Record<string, unknown>; context: Record<string, unknown> | null },
  apptMsByAcuityId: Map<string, number>,
  dataStartWeekStart: string = RETENTION_DATA_START_DATE_ET,
): boolean {
  const ms = exceptionTriggerMs(e, apptMsByAcuityId);
  return ms == null ? true : inRetentionDataScope(ms, dataStartWeekStart);
}

/** acuity appointment id → appointment_datetime epoch ms (exception scoping's anchor map). */
function apptMsByAcuityIdOf(appts: { acuity_appointment_id: string | null; appointment_datetime: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of appts) {
    if (a.acuity_appointment_id == null) continue;
    const ms = Date.parse(a.appointment_datetime);
    if (Number.isFinite(ms)) m.set(a.acuity_appointment_id, ms);
  }
  return m;
}

// ---- KPI catalog (labels verbatim from the owner list; UI spec §2) ----

export type RetentionKpiKey =
  | "clients-due"
  | "calls-attempted"
  | "spoken-with"
  | "unreached"
  | "compliance"
  | "active-cancellations"
  | "saves"
  | "reschedules"
  | "recovery"
  | "no-shows"
  | "match-exceptions"
  | "needs-review";

export interface RetentionKpiMeta {
  key: RetentionKpiKey;
  label: string;
  /** Static qualifying context (spec §2 example subs). Cards with dynamic subs build theirs at compute time. */
  sub?: string;
  /** §16 formula, verbatim — surfaced in InfoTips. */
  formula: string;
}

export const RETENTION_KPIS: RetentionKpiMeta[] = [
  { key: "clients-due", label: "Clients Due", sub: "due this week", formula: "count(appointments A: eligible, A.due_date ∈ R)" },
  { key: "calls-attempted", label: "Calls Attempted", sub: "distinct calls in due windows", formula: "count(retention_attempts where appointment_id ∈ A and attempt_at ∈ A.window) — distinct calls; repeat attempts each count" },
  { key: "spoken-with", label: "Clients Spoken With", formula: "count(A: final_status = 'verified_spoke_with')" },
  { key: "unreached", label: "Still Unreached", formula: "count(A: eligible, attempts ≥ 0, final_status ∈ {no_answer, attempted_unclear}, appointment_datetime ≥ now (window still open) OR window closed with zero answered attempts)" },
  { key: "compliance", label: "Contact Compliance %", sub: "spoke with ÷ due", formula: "Contact Compliance % (appointment flavor) = Clients Spoken With / Clients Due · Contact Compliance % (attempt flavor) = count(A: attempts ≥ 1 within window) / Clients Due" },
  { key: "active-cancellations", label: "Active Cancellations", sub: "awaiting outcome", formula: "count(retention_cancellations: outcome = 'pending')" },
  { key: "saves", label: "Saves", sub: "original appointment kept", formula: "count(outcome = 'saved_original')" },
  { key: "reschedules", label: "Reschedules", sub: "rebooked within window", formula: "count(outcome = 'rescheduled')" },
  { key: "recovery", label: "Recovery Rate", sub: "recovered ÷ eligible", formula: "(Saves + Reschedules) / count(eligible cancellations: internal client resolved)" },
  { key: "no-shows", label: "No-Shows", formula: "count(A: appointment_datetime < now, no-show per [D10] rule) — split spoken-with (final_status = verified) vs not-spoken" },
  { key: "match-exceptions", label: "Data Match Exceptions", sub: "match unresolved", formula: "count(data_match_exceptions: status = 'open')" },
  { key: "needs-review", label: "Needs Review", sub: "evidence conflicts", formula: "count(A: final_status = 'needs_review')" },
];

export const CANCELLATIONS_ENGINE_NOTE =
  "The cancellations ledger (ret_cancellations) is written by the retention-cancellations engine (stage 4a); its counts fill the Today row, the Needs Attention queue, This Week's Retention Performance and new weekly scorecards, and the four family drill-downs (Active Cancellations, Saves, Reschedules, Recovery Rate) list its rows through the same §16 predicate. The transfers ledger (ret_transfers) is written by the transfers engine (stage 5). Surfaces whose own writer is a follow-up (the scorecard's No-Shows and Transfers cells) render an honest — (not computed), never 0.";

export const RETENTION_KPI_LABEL: Record<RetentionKpiKey, string> = Object.fromEntries(
  RETENTION_KPIS.map((k) => [k.key, k.label]),
) as Record<RetentionKpiKey, string>;

/** Attempt-class dispositions (closed vocabulary, classify.ts §9). */
const UNREACHED_STATUSES = new Set(["no_answer", "attempted_unclear"]);

// ---- Overview (the 12-card band, "as of now" = current Mon–Sun ET week) ----

export interface RetentionCard {
  key: RetentionKpiKey;
  label: string;
  /** null renders "—" (never a fabricated 0 — see CANCELLATIONS_ENGINE_NOTE). */
  value: number | null;
  /** Ratio 0..1 for the Compliance / Recovery cards; null when not computable. */
  ratio: number | null;
  sub: string;
  /** Attention accent (amber dot + consequence sub) — Needs Review + Data Match Exceptions when > 0. */
  attention: boolean;
  /** Still Unreached only — the window split the TODAY card renders in human language. */
  split?: { open: number; missed: number };
  /** No-Shows only — the spoken / not-spoken split the RETENTION IMPACT card renders. */
  spokenSplit?: { spoken: number; notSpoken: number };
}

export interface RetentionOverviewData {
  todayEt: string;
  weekStartEt: string;
  weekEndEt: string;
  dueDays: number;
  ownerName: string | null;
  /** Max computed_at across stored outcomes (the last time the compute content changed). */
  computedAtIso: string | null;
  cards: RetentionCard[];
  exceptionsOpen: number;
  needsReviewOpen: number;
  /** Stage-5 transfers ledger rows whose ORIGINAL appointment is in display scope (owner directive 10/21) — every standing transfer, the same pool the queue's transfers segment shows. */
  transfersTotal: number;
  /** Transfers CONFIRMED (detected_at) inside the current Mon–Sun ET week — the This-Week KPI numerator. */
  transfersThisWeek: number;
  /**
   * transfersThisWeek ÷ tracked cancellations CANCELLED in the current week
   * (display-scoped, the §16 week anchor for the cancellations family). The
   * share rate exists only when the denominator is a real number of tracked
   * cancellations — otherwise null ("—", never a fabricated 0%).
   */
  transfersRate: number | null;
}

export async function retentionOverview(store: Store, now: () => Date = () => new Date()): Promise<RetentionOverviewData> {
  const nowMs = now().getTime();
  const todayEt = etDateStrFromInstant(nowMs);
  const ws = weekStart(todayEt);
  const we = addDays(ws, 6);
  const settings = await store.getSettings();
  // CURRENT settings at call time (no boot-frozen snapshot): the store
  // normalizes on read, and normalizeRetentionSettings makes the loader safe
  // even against a hand-built store whose settings omit the group — every
  // absent field falls back to DEFAULT_RETENTION_SETTINGS (byte-identical).
  const retention = normalizeRetentionSettings(settings.retention ?? DEFAULT_RETENTION_SETTINGS);
  const dueDays = retention.due_days;
  const dataStart = retention.data_start_week_start; // the DISPLAY boundary, resolved at call time
  const [outcomes, attempts, openExceptions, ownerRows, allCancellations, allTransfers] = await Promise.all([
    store.listRetentionAppointmentOutcomes(),
    store.listRetentionAttempts(),
    store.getDataMatchExceptions({ status: "open" }),
    store.listRetentionOwnerHistory(),
    store.listRetentionCancellations(),
    store.listRetentionTransfers(),
  ]);
  const ownerName = currentRetentionOwner(ownerRows, todayEt);

  // Appointment rows: needed for the D10 no-show proxy + the still-open window
  // test (both read appointment_datetime / CURRENT status). Same fetch floor
  // the compute uses, so every stored outcome's appointment is covered.
  const floorIso = etDayStartUtc(addDays(todayEt, -(retention.compute_lookback_days + dueDays + 2)));
  const appts = await store.getAppointmentsWithClientsSince(floorIso);
  const apptById = new Map(appts.map((a) => [a.id, a]));
  const apptIdMs = (appointmentId: string): number | null => {
    const a = apptById.get(appointmentId);
    if (!a) return null;
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) ? ms : null;
  };
  const apptMs = (o: RetentionOutcomeRow): number | null => apptIdMs(o.appointment_id);

  // OWNER DIRECTIVE 10/21 — the display-layer boundary (RETENTION_DATA_START_ET):
  // no pre-cutoff appointment may contribute to any card. The writers keep
  // observing everything; this only narrows what the loaders RETURN.
  const cancellationRows = allCancellations.filter((r) => inRetentionDataScope(apptIdMs(r.appointment_id), dataStart));
  const exceptionsOpen = openExceptions.filter((e) => inRetentionExceptionScope(e, apptMsByAcuityIdOf(appts), dataStart)).length;

  // STAGE-5 TRANSFERS — the written ret_transfers ledger, DISPLAY-scoped on
  // the ORIGINAL appointment's session instant (the row is attributed to the
  // original booker's client series, so the original's instant is the row's
  // scope anchor; a row whose original cannot be placed is not provably in
  // scope and stays hidden — fail-honest, same as the cancellations family).
  const transferRows = allTransfers.filter((r) => inRetentionDataScope(apptIdMs(r.appointment_id), dataStart));
  const transfersThisWeek = transferRows.filter((r) => {
    const ms = Date.parse(r.detected_at);
    if (!Number.isFinite(ms)) return false; // no confirmation stamp — never guessed into a week
    const d = etDateStrFromInstant(ms);
    return d >= ws && d <= we;
  }).length;
  // The share rate's denominator: tracked cancellations CANCELLED in the
  // current week (the §16 week anchor for the cancellations family). Only a
  // real denominator yields a rate — otherwise null ("—", never 0%).
  const cancellationsThisWeek = cancellationRows.filter((r) => {
    if (!r.cancelled_at) return false;
    const ms = Date.parse(r.cancelled_at);
    if (!Number.isFinite(ms)) return false;
    const d = etDateStrFromInstant(ms);
    return d >= ws && d <= we;
  }).length;
  const transfersRate = cancellationsThisWeek > 0 ? transfersThisWeek / cancellationsThisWeek : null;

  // Current-week due cohort ("as of now" R — UI spec §2: cards summarize the
  // current week's due cohort and all open queues).
  const cohort = outcomes.filter(
    (o) => o.eligible && o.contact_due_date >= ws && o.contact_due_date <= we && inRetentionDataScope(apptMs(o), dataStart),
  );
  const cohortIds = new Set(cohort.map((o) => o.appointment_id));

  const spokenCount = cohort.filter((o) => o.final_status === "verified_spoke_with").length;
  const unreachedRows = cohort.filter((o) => {
    if (!UNREACHED_STATUSES.has(o.final_status)) return false;
    const ms = apptMs(o);
    const windowOpen = ms != null && ms >= nowMs;
    return windowOpen || !o.any_answered; // §16 verbatim: open window OR closed with zero answered attempts
  });
  const windowOpenCount = unreachedRows.filter((o) => {
    const ms = apptMs(o);
    return ms != null && ms >= nowMs;
  }).length;

  // D10 proxy (owner-ratified): appointment passed + status still scheduled.
  // No-Shows range by APPOINTMENT date, not due date — due = appt − 7 means a
  // due-week-scoped no-show could never be nonzero (every due-week appointment
  // is still 7+ days out), and the §16 formula keys on appointment_datetime.
  const apptDateEtOf = (o: RetentionOutcomeRow): string | null => {
    const ms = apptMs(o);
    return ms == null ? null : etDateStrFromInstant(ms);
  };
  const noShowRows = outcomes.filter((o) => {
    if (!o.eligible) return false;
    if (!inRetentionDataScope(apptMs(o), dataStart)) return false; // owner directive 10/21 — display boundary
    const d = apptDateEtOf(o);
    if (d == null || d < ws || d > we) return false;
    const a = apptById.get(o.appointment_id);
    if (!a || a.cancelled) return false;
    if (!retention.qualifying_statuses.includes(a.status)) return false;
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) && ms < nowMs;
  });
  const noShowSpoken = noShowRows.filter((o) => o.final_status === "verified_spoke_with").length;

  const callsAttempted = attempts.filter((a) => a.appointment_id != null && cohortIds.has(a.appointment_id)).length;
  const complianceRatio = cohort.length > 0 ? spokenCount / cohort.length : null;
  const computedAtIso = outcomes.reduce<string | null>((acc, o) => (acc == null || o.computed_at > acc ? o.computed_at : acc), null);

  const cards: RetentionCard[] = [
    { key: "clients-due", label: "Clients Due", value: cohort.length, ratio: null, sub: `due this week · due = appt date − ${dueDays}`, attention: false },
    { key: "calls-attempted", label: "Calls Attempted", value: callsAttempted, ratio: null, sub: "distinct calls in due windows", attention: false },
    { key: "spoken-with", label: "Clients Spoken With", value: spokenCount, ratio: null, sub: `of ${cohort.length} due`, attention: false },
    {
      key: "unreached",
      label: "Still Unreached",
      value: unreachedRows.length,
      ratio: null,
      sub: `${windowOpenCount} window open · ${unreachedRows.length - windowOpenCount} closed`,
      attention: false,
      split: { open: windowOpenCount, missed: unreachedRows.length - windowOpenCount },
    },
    { key: "compliance", label: "Contact Compliance %", value: complianceRatio == null ? null : Math.round(complianceRatio * 1000) / 10, ratio: complianceRatio, sub: "spoke with ÷ due", attention: false },
    // Cancellations family — ret_cancellations has a writer (stage 4a). A
    // written-ledger 0 is a fact (never a fabricated 0); counts come from the
    // SAME §16 predicate the queue and drill use (inCancellationUniverse —
    // one source of truth). Ratios stay null until their denominators exist.
    {
      key: "active-cancellations",
      label: "Active Cancellations",
      value: cancellationRows.filter((r) => inCancellationUniverse(r, "active-cancellations")).length,
      ratio: null,
      sub: "awaiting outcome",
      attention: cancellationRows.some((r) => inCancellationUniverse(r, "active-cancellations")),
    },
    {
      key: "saves",
      label: "Saves",
      value: cancellationRows.filter((r) => inCancellationUniverse(r, "saves")).length,
      ratio: null,
      sub: "original appointment kept",
      attention: false,
    },
    {
      key: "reschedules",
      label: "Reschedules",
      value: cancellationRows.filter((r) => inCancellationUniverse(r, "reschedules")).length,
      ratio: null,
      sub: "rebooked within window",
      attention: false,
    },
    {
      // §16: (Saves + Reschedules) / count(eligible cancellations: internal
      // client resolved) — the eligible denominator IS the ledger (the engine
      // only writes rows with a resolved client; unlinked cancellations are
      // counted honestly by the engine and exception-queued). null ("—")
      // while no eligible rows exist — never a fabricated 0%/100%.
      key: "recovery",
      label: "Recovery Rate",
      value: cancellationRows.filter((r) => inCancellationUniverse(r, "recovery")).length,
      ratio:
        cancellationRows.length > 0
          ? cancellationRows.filter((r) => inCancellationUniverse(r, "recovery")).length / cancellationRows.length
          : null,
      sub: cancellationRows.length > 0 ? `of ${cancellationRows.length} tracked cancellations` : "recovered ÷ eligible",
      attention: false,
    },
    {
      key: "no-shows",
      label: "No-Shows",
      value: noShowRows.length,
      ratio: null,
      sub: `${noShowSpoken} spoken · ${noShowRows.length - noShowSpoken} not spoken`,
      attention: false,
      spokenSplit: { spoken: noShowSpoken, notSpoken: noShowRows.length - noShowSpoken },
    },
    { key: "match-exceptions", label: "Data Match Exceptions", value: exceptionsOpen, ratio: null, sub: exceptionsOpen > 0 ? "match unresolved" : "all clear", attention: exceptionsOpen > 0 },
    // Needs Review — the open evidence-conflict queue; pre-cutoff rows are
    // hidden from DISPLAY (owner directive 10/21) but stay stored.
    { key: "needs-review", label: "Needs Review", value: outcomes.filter((o) => o.final_status === "needs_review" && inRetentionDataScope(apptMs(o), dataStart)).length, ratio: null, sub: "", attention: false },
  ];
  // Needs Review card: attention accent + consequence sub when > 0 (computed
  // over the DISPLAY-scoped stored outcomes — an open queue, not a
  // week-scoped count; pre-cutoff rows hidden per owner directive 10/21).
  const needsReviewOpen = cards[11]!.value ?? 0;
  cards[11]!.attention = needsReviewOpen > 0;
  cards[11]!.sub = needsReviewOpen > 0 ? "evidence conflicts" : "all clear";

  return {
    todayEt,
    weekStartEt: ws,
    weekEndEt: we,
    dueDays,
    ownerName,
    computedAtIso,
    cards,
    exceptionsOpen,
    needsReviewOpen,
    transfersTotal: transferRows.length,
    transfersThisWeek,
    transfersRate,
  };
}

/** The Retention Owner of record for an ET date (plan §12: effective dates; never hard-coded). */
export function currentRetentionOwner(rows: RetentionOwnerHistoryRow[], todayEt: string): string | null {
  const active = rows
    .filter((r) => r.effective_start <= todayEt && (r.effective_end == null || r.effective_end >= todayEt))
    .sort((a, b) => (a.effective_start < b.effective_start ? -1 : 1));
  const cur = active[active.length - 1];
  if (!cur) return null;
  return cur.name ?? cur.initials ?? null;
}

// ---- Drill-down (one shared list driven by ?kpi= + filters; UI spec §3) ----

export type RetentionRange = "this-week" | "last-week" | "last-30" | "all";
export const RETENTION_RANGES: { value: RetentionRange; label: string }[] = [
  { value: "this-week", label: "This week" },
  { value: "last-week", label: "Last week" },
  { value: "last-30", label: "Last 30 days" },
  { value: "all", label: "All open" },
];

export const FINAL_STATUS_LABEL: Record<string, string> = {
  verified_spoke_with: "Verified Spoke With",
  voicemail: "Voicemail",
  no_answer: "No Answer",
  attempted_unclear: "Attempted — Outcome Unclear",
  needs_review: "Needs Review",
};

export const EXCEPTION_KIND_LABEL: Record<string, string> = {
  ambiguous_id: "Ambiguous ID",
  ambiguous_phone: "Ambiguous phone",
  ambiguous_email: "Ambiguous email",
  ambiguous_name: "Ambiguous name",
  name_only: "Name only",
  no_identity: "No identity",
};

/** Cancellation-outcome vocabulary (plan §11) — the ledger is unwritten, so the filter is ready but matches nothing yet. */
export const OUTCOME_FILTER_OPTIONS = [
  "saved_original",
  "rescheduled",
  "confirmed_cancellation",
  "unable_to_reach",
  "pending",
  "transferred",
  "other",
] as const;

// ---- §16 row-universe predicates (ONE source of truth: drill + queue) ----

/** Context the §16 predicates close over (the drill-down and the Needs Attention queue both supply it). */
export interface KpiUniverseCtx {
  nowMs: number;
  /** appointment_datetime as epoch ms (null when the appointment row is missing/unparseable). */
  apptMsOf: (o: RetentionOutcomeRow) => number | null;
  /** D10 no-show predicate — only the no-shows kpi consults it. */
  noShowRow?: (o: RetentionOutcomeRow) => boolean;
}

/**
 * Is this eligible outcome in the named kpi's §16 row universe? §16 VERBATIM —
 * shared by the drill-down and the Needs Attention queue so the two can never
 * drift (eligibility + range checks stay with the caller).
 */
export function inKpiUniverse(o: RetentionOutcomeRow, kpi: RetentionKpiKey, ctx: KpiUniverseCtx): boolean {
  switch (kpi) {
    case "clients-due":
      return true;
    case "calls-attempted":
      return o.attempts_count > 0;
    case "spoken-with":
      return o.final_status === "verified_spoke_with";
    case "unreached": {
      if (!UNREACHED_STATUSES.has(o.final_status)) return false;
      const ms = ctx.apptMsOf(o);
      return (ms != null && ms >= ctx.nowMs) || !o.any_answered;
    }
    case "compliance":
      return true; // the ratio's numerator + denominator rows
    case "no-shows":
      return ctx.noShowRow ? ctx.noShowRow(o) : false;
    case "needs-review":
      return o.final_status === "needs_review";
    case "active-cancellations":
    case "saves":
    case "reschedules":
    case "recovery":
      return false; // outcome rows never cover the cancellations family — ret_cancellations rows do (see below)
    default:
      return false;
  }
}

/** The §16 cancellations-family kpi keys — the ledger family (ret_cancellations). */
export type RetentionCancellationKpi = "active-cancellations" | "saves" | "reschedules" | "recovery";

/** The family keys as a list (drill + route defaults iterate over the ONE family definition). */
export const RETENTION_CANCELLATION_KPIS: readonly RetentionCancellationKpi[] = [
  "active-cancellations",
  "saves",
  "reschedules",
  "recovery",
];

/** Type guard: is this drill kpi one of the §16 ledger family (its rows come from ret_cancellations, not the appointment funnel)? */
export function isCancellationKpi(kpi: RetentionKpiKey): kpi is RetentionCancellationKpi {
  return (RETENTION_CANCELLATION_KPIS as readonly string[]).includes(kpi);
}

/**
 * Is this LEDGER row in the named cancellations-family kpi's §16 universe?
 * §16 VERBATIM over ret_cancellations — the ONE source of truth for the
 * family: the overview cards, the Needs Attention queue (and later the
 * drill-down's cancellation listing) all filter through this predicate so
 * they can never drift. The outcome-family counterpart is inKpiUniverse
 * above; cancelled appointments leave the contact funnel (compute skips
 * them), so a ledger appointment can never also be an outcome row.
 */
export function inCancellationUniverse(r: RetentionCancellationRow, kpi: RetentionCancellationKpi): boolean {
  switch (kpi) {
    case "active-cancellations":
      return r.outcome === "pending"; // the actionable queue — awaiting outcome
    case "saves":
      return r.outcome === "saved_original"; // the original appointment, kept
    case "reschedules":
      return r.outcome === "rescheduled"; // rebooked within the window
    case "recovery":
      return RECOVERED_OUTCOMES.has(r.outcome); // owner definition: saved_original ∪ rescheduled
  }
}

export interface RetentionDrillParams {
  kpi: RetentionKpiKey;
  range: RetentionRange;
  classification: string; // final_status filter or "all"
  outcome: string; // cancellation-outcome filter or "all"
  employee: string; // users.id / provider external id or "all"
  exc: "open" | "resolved" | "dismissed"; // match-exceptions queue segment
}

export interface RetentionAttemptView {
  attemptAt: string;
  employeeName: string;
  direction: string | null;
  status: string | null;
  durationSeconds: number | null;
  attemptClass: string;
  attribution: string;
}

export interface RetentionDrillRow {
  appointmentId: string;
  acuityId: string | null;
  internalClientId: string;
  clientName: string | null;
  apptIso: string | null;
  apptDateEt: string | null;
  apptTimeEt: string | null;
  cancelled: boolean;
  appointmentStatus: string | null;
  dueDate: string;
  contactName: string | null;
  contactPhoneLast4: string | null;
  /** The GHL contact of record (identity chain; §13). */
  ghlContactId: string | null;
  attemptsCount: number;
  attempts: RetentionAttemptView[];
  lastCallStatus: string | null;
  /** Always null until transcription ever exists (probe verdict 2026-10-19) — the column stays for the evidence hierarchy. */
  transcriptResult: null;
  /** Verbatim Acuity notes (full text; the table clamps, the expansion shows all). */
  notes: string | null;
  finalStatus: string;
  needsReviewReason: string | null;
  /** §11 cancellation-outcome words — null for appointment-funnel rows; ret_cancellations rows carry the ledger's vocabulary. */
  outcome: string | null;
  /** Ledger-row fields (§16 family only; null for appointment-funnel rows). */
  cancelledAt: string | null;
  recoveredAt: string | null;
  successorAppointmentId: string | null;
  /** D1 — last contact instant: outcome rows' stored last_attempt_at; ledger rows derive it from the SAME attempt scan the Needs Attention queue uses. Null renders "— none yet". */
  lastAttemptAt: string | null;
  matchMethod: string | null;
  contactMatchMethod: string | null;
  evidence: Record<string, unknown>;
}

export interface RetentionDrillData {
  kpi: RetentionKpiKey;
  kpiLabel: string;
  range: RetentionRange;
  rangeLabel: string;
  dueDays: string; // ET date bounds for the range ("all" → the compute lookback bounds)
  rangeStartEt: string | null;
  rangeEndEt: string | null;
  todayEt: string;
  ownerName: string | null;
  dueDaysSetting: number;
  rows: RetentionDrillRow[];
  /** Rows matching the kpi BEFORE the classification/outcome/employee filters — the header's exact-value chip. */
  matchedCount: number;
  employees: { id: string; name: string }[];
  emptyReason: string | null;
  /** Recovery Rate only — the §16 rate denominator the CARD divides by (every tracked cancellation in display scope), surfaced so the ratio is reconstructable on-page; null for the other kpis. */
  recoveryDenominator: number | null;
  /** match-exceptions mode payload (handleExceptionsQuery verbatim). */
  exceptions: {
    counts: { open: number; resolved: number; dismissed: number; total: number };
    rows: (DataMatchExceptionRow & { candidates_expanded: (InternalClientRow | null)[]; resolved_client: InternalClientRow | null })[];
  } | null;
  cancellationsEngineNote: string;
}

export async function retentionDrillData(
  store: Store,
  params: RetentionDrillParams,
  now: () => Date = () => new Date(),
): Promise<RetentionDrillData> {
  const nowMs = now().getTime();
  const todayEt = etDateStrFromInstant(nowMs);
  const ws = weekStart(todayEt);
  const settings = await store.getSettings();
  // CURRENT settings at call time (see retentionOverview).
  const retention = normalizeRetentionSettings(settings.retention ?? DEFAULT_RETENTION_SETTINGS);
  const dueDays = retention.due_days;
  const dataStart = retention.data_start_week_start; // the DISPLAY boundary, resolved at call time
  const ownerRows = await store.listRetentionOwnerHistory();
  const ownerName = currentRetentionOwner(ownerRows, todayEt);

  const rangeBounds = (range: RetentionRange): { start: string | null; end: string | null; label: string } => {
    switch (range) {
      case "this-week":
        return { start: ws, end: addDays(ws, 6), label: `Week of ${formatShort(ws)}–${formatShort(addDays(ws, 6))}` };
      case "last-week": {
        const lws = addDays(ws, -7);
        return { start: lws, end: addDays(ws, -1), label: `Week of ${formatShort(lws)}–${formatShort(addDays(ws, -1))}` };
      }
      case "last-30":
        return { start: addDays(todayEt, -29), end: todayEt, label: `Last 30 days (${formatShort(addDays(todayEt, -29))} – ${formatShort(todayEt)})` };
      case "all":
      default:
        return { start: null, end: null, label: "All stored outcomes" };
    }
  };
  const range = rangeBounds(params.range);

  // ---- match-exceptions mode: the shipped queue API verbatim (reuse mandate),
  // ---- narrowed to the display boundary (owner directive 10/21): rows whose
  // ---- triggering appointment/call is PROVABLY pre-cutoff are hidden from the
  // ---- workspace (stored rows untouched; undatable rows stay — nothing is
  // ---- guessed pre-tenure). Calling with no status returns ALL rows with the
  // ---- shipped candidate/resolved expansions; counts are re-derived from the
  // ---- scoped rows so the header chips can never drift from the table.
  if (params.kpi === "match-exceptions") {
    const { handleExceptionsQuery } = await import("./exceptions-api");
    const [res, appts] = await Promise.all([
      handleExceptionsQuery(store, { status: null }),
      store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(todayEt, -(retention.compute_lookback_days + dueDays + 2)))),
    ]);
    const body = res.body as {
      counts: { open: number; resolved: number; dismissed: number; total: number };
      exceptions: (DataMatchExceptionRow & { candidates_expanded: (InternalClientRow | null)[]; resolved_client: InternalClientRow | null })[];
    };
    const excAnchorMs = apptMsByAcuityIdOf(appts);
    const scoped = body.exceptions.filter((e) => inRetentionExceptionScope(e, excAnchorMs, dataStart));
    const scopedCounts = {
      open: scoped.filter((e) => e.status === "open").length,
      resolved: scoped.filter((e) => e.status === "resolved").length,
      dismissed: scoped.filter((e) => e.status === "dismissed").length,
      total: scoped.length,
    };
    const scopedRows = scoped.filter((e) => e.status === params.exc);
    return {
      kpi: params.kpi,
      kpiLabel: RETENTION_KPI_LABEL[params.kpi],
      range: params.range,
      rangeLabel: range.label,
      dueDays: `${formatShort(addDays(todayEt, -29))} – ${formatShort(todayEt)}`,
      rangeStartEt: range.start,
      rangeEndEt: range.end,
      todayEt,
      ownerName,
      dueDaysSetting: dueDays,
      rows: [],
      matchedCount: scopedCounts[params.exc],
      employees: [],
      emptyReason: params.exc === "open" ? "No Data Match Exceptions — every client matched on explicit ID, phone, or email." : null,
      exceptions: { counts: scopedCounts, rows: scopedRows },
      recoveryDenominator: null,
      cancellationsEngineNote: CANCELLATIONS_ENGINE_NOTE,
    };
  }

  // ---- cancellations-family mode (stage 4a follow-up) — the four §16 ledger
  // ---- kpis list the ret_cancellations rows that MAKE UP their card number:
  // ---- the SAME inCancellationUniverse predicate + display scope the cards
  // ---- and the queue count (ONE source of truth — no second derivation, no
  // ---- writes). Range narrows on the family's §16 event date: cancelled_at
  // ---- ET date for active-cancellations/saves/reschedules (the scorecard's
  // ---- week anchor for the family), recovered_at ET date for recovery (the
  // ---- D3 "recovered this week" anchor its queue link counts). A row whose
  // ---- anchor instant cannot be derived is excluded from narrowed ranges
  // ---- (nothing is guessed) and still shows in the "all" view, like on the
  // ---- cards. READ-ONLY: every read below is a bulk store read.
  if (isCancellationKpi(params.kpi)) {
    const kpi = params.kpi; // narrowed to the §16 family keys — stable inside the callbacks below
    const [cancellationRows, attempts, clients, links, appts, users] = await Promise.all([
      store.listRetentionCancellations(),
      store.listRetentionAttempts(),
      store.listInternalClients(),
      store.listClientMatchLinks(),
      store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(todayEt, -(retention.compute_lookback_days + dueDays + 2)))),
      store.getUsers(),
    ]);
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const userById = new Map(users.map((u) => [u.id, u]));
    const apptById = new Map(appts.map((a) => [a.id, a]));
    const linkByExternal = new Map(links.map((l) => [`${l.provider}:${l.entity}:${l.external_id}`, l]));

    const employeeName = (userId: string | null, externalId: string | null): string => {
      if (userId && userById.has(userId)) return userById.get(userId)!.name;
      if (externalId) return userById.get(externalId)?.name ?? `HL user ${externalId}`;
      return "—";
    };
    // Employee filter options: everyone in the attempt ledger, roster-
    // independent (same derivation as the appointment-anchored mode).
    const employeeIds = new Set<string>();
    for (const a of attempts) {
      if (a.employee_user_id) employeeIds.add(a.employee_user_id);
      else if (a.employee_external_id) employeeIds.add(a.employee_external_id);
    }
    const employees = [...employeeIds].map((id) => ({ id, name: employeeName(userById.has(id) ? id : null, userById.has(id) ? null : id) }));

    const attemptsByAppointment = new Map<string, RetentionAttemptRow[]>();
    for (const a of attempts) {
      if (!a.appointment_id) continue;
      const list = attemptsByAppointment.get(a.appointment_id) ?? [];
      list.push(a);
      attemptsByAppointment.set(a.appointment_id, list);
    }
    // D1 — the SAME lastAttemptAt derivation the queue's cancellation rows use
    // (the ledger has no stored stamp; "— none yet" is always a proven fact).
    const lastAttemptAtOf = (appointmentId: string): string | null => {
      let latest: RetentionAttemptRow | null = null;
      for (const a of attempts) {
        if (a.appointment_id !== appointmentId) continue;
        if (!latest || a.attempt_at > latest.attempt_at) latest = a;
      }
      return latest?.attempt_at ?? null;
    };
    const apptIdMs = (appointmentId: string): number | null => {
      const a = apptById.get(appointmentId);
      if (!a) return null;
      const ms = Date.parse(a.appointment_datetime);
      return Number.isFinite(ms) ? ms : null;
    };
    /** The §16 event instant this family kpi's range keys on (see branch header). */
    const anchorMsOf = (r: RetentionCancellationRow): number | null => {
      const iso = kpi === "recovery" ? r.recovered_at : r.cancelled_at;
      if (!iso) return null;
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? ms : null;
    };

    // The kpi's §16 ledger universe — the SAME predicate + display scope the
    // cards count (owner directive 10/21 boundary via inRetentionDataScope;
    // a row whose appointment instant cannot be derived is not provably in
    // scope and stays hidden — fail-honest, exactly like the cards).
    const universe = cancellationRows.filter(
      (r) => inRetentionDataScope(apptIdMs(r.appointment_id), dataStart) && inCancellationUniverse(r, kpi),
    );
    const base = universe.filter((r) => {
      if (range.start == null) return true;
      const ms = anchorMsOf(r);
      if (ms == null) return false; // unplaceable in a narrowed range — never guessed
      const d = etDateStrFromInstant(ms);
      return d >= range.start && d <= (range.end ?? "");
    });
    const matchedCount = base.length;

    // Secondary filters — the same three the appointment-anchored mode offers.
    const classification = params.classification && params.classification !== "all" ? params.classification : null;
    const filtered = base.filter((r) => {
      if (classification && r.final_contact_status !== classification) return false;
      if (params.outcome !== "all" && r.outcome !== params.outcome) return false;
      if (params.employee !== "all") {
        const list = attemptsByAppointment.get(r.appointment_id) ?? [];
        if (!list.some((a) => a.employee_user_id === params.employee || a.employee_external_id === params.employee)) return false;
      }
      return true;
    });

    const rows: RetentionDrillRow[] = filtered.map((r) => {
      const client = r.internal_client_id ? clientById.get(r.internal_client_id) ?? null : null;
      const appt = apptById.get(r.appointment_id) ?? null;
      const apptMs = appt ? Date.parse(appt.appointment_datetime) : NaN;
      const cancelledMs = r.cancelled_at ? Date.parse(r.cancelled_at) : NaN;
      const attemptsList = (attemptsByAppointment.get(r.appointment_id) ?? [])
        .slice()
        .sort((a, b) => (a.attempt_at < b.attempt_at ? -1 : 1))
        .map((a) => ({
          attemptAt: a.attempt_at,
          employeeName: employeeName(a.employee_user_id, a.employee_external_id),
          direction: a.direction,
          status: a.call_status,
          durationSeconds: a.duration_seconds,
          attemptClass: a.attempt_class,
          attribution: a.attribution,
        }));
      // The queue's defensive fallback for the acuity id (the engine only
      // writes resolved-client rows; a missing appointment row still leaves
      // the ledger's own evidence to anchor identity).
      const evAcuity = (r.notes as { acuity_appointment_id?: unknown } | null)?.acuity_appointment_id;
      const acuityId = appt?.acuity_appointment_id ?? (typeof evAcuity === "string" ? evAcuity : null);
      const apptLink = acuityId ? linkByExternal.get(`acuity:appointment:${acuityId}`) ?? null : null;
      const contactLink = client?.ghl_contact_external_id ? linkByExternal.get(`highlevel:contact:${client.ghl_contact_external_id}`) ?? null : null;
      return {
        appointmentId: r.appointment_id,
        acuityId,
        internalClientId: r.internal_client_id ?? "—",
        clientName: client?.display_name ?? null,
        apptIso: Number.isFinite(apptMs) ? new Date(apptMs).toISOString() : null,
        apptDateEt: Number.isFinite(apptMs) ? etDateStrFromInstant(apptMs) : null,
        apptTimeEt: Number.isFinite(apptMs)
          ? new Intl.DateTimeFormat("en-US", { timeZone: OPERATIONAL_TIMEZONE, hour: "numeric", minute: "2-digit" }).format(new Date(apptMs))
          : null,
        cancelled: true, // a ledger row IS a cancelled appointment (the engine only observes cancellations)
        appointmentStatus: appt?.status ?? null,
        // Renders as "cancelled <date>" (the write-once stamp, not a due date —
        // the appointment left the contact funnel, so no due date exists).
        dueDate: Number.isFinite(cancelledMs) ? etDateStrFromInstant(cancelledMs) : "",
        contactName: client?.display_name ?? null,
        contactPhoneLast4: client?.normalized_phone ? client.normalized_phone.slice(-4) : null,
        ghlContactId: client?.ghl_contact_external_id ?? null,
        attemptsCount: r.attempts_count, // the ledger's count — the SAME number the cards and queue carry
        attempts: attemptsList,
        lastCallStatus: attemptsList.length ? (attemptsList[attemptsList.length - 1]!.status ?? null) : null,
        transcriptResult: null,
        notes: appt?.raw && typeof (appt.raw as { notes?: unknown }).notes === "string" ? ((appt.raw as { notes: string }).notes as string) : null,
        finalStatus: r.final_contact_status ?? "none", // renders "—" when the cancelled session had no prior outcome
        needsReviewReason: null,
        outcome: r.outcome, // §11 outcome words — the ledger column fills at last
        cancelledAt: r.cancelled_at,
        recoveredAt: r.recovered_at,
        successorAppointmentId: r.successor_appointment_id,
        lastAttemptAt: lastAttemptAtOf(r.appointment_id),
        matchMethod: apptLink?.match_method ?? null,
        contactMatchMethod: contactLink?.match_method ?? null,
        evidence: r.notes ?? {}, // the engine's derivation evidence, verbatim
      };
    });
    rows.sort((a, b) => {
      const d = a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
      if (d !== 0) return -d; // most recent cancellation first (management reads today's work first)
      return (a.clientName ?? "").localeCompare(b.clientName ?? "");
    });

    // Recovery Rate honesty: this drill lists the §16 recovered rows (the
    // numerator); the CARD's rate divides them by every tracked cancellation
    // in display scope (range-independent — the card's own denominator).
    const recoveryDenominator =
      kpi === "recovery" ? cancellationRows.filter((r) => inRetentionDataScope(apptIdMs(r.appointment_id), dataStart)).length : null;

    return {
      kpi,
      kpiLabel: RETENTION_KPI_LABEL[kpi],
      range: params.range,
      rangeLabel: range.label,
      dueDays: range.start == null ? "All stored outcomes" : `${formatShort(range.start)} – ${formatShort(range.end!)}`,
      rangeStartEt: range.start,
      rangeEndEt: range.end,
      todayEt,
      ownerName,
      dueDaysSetting: dueDays,
      rows,
      matchedCount,
      employees,
      // The ledger HAS a writer — a written-ledger 0 is a fact, never "not
      // computed"; the route renders the family's honest empty state.
      emptyReason: null,
      recoveryDenominator,
      exceptions: null,
      cancellationsEngineNote: CANCELLATIONS_ENGINE_NOTE,
    };
  }

  // ---- appointment-anchored modes ----
  const [outcomes, attempts, clients, links, appts, users] = await Promise.all([
    store.listRetentionAppointmentOutcomes(),
    store.listRetentionAttempts(),
    store.listInternalClients(),
    store.listClientMatchLinks(),
    store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(todayEt, -(retention.compute_lookback_days + dueDays + 2)))),
    store.getUsers(),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const apptById = new Map(appts.map((a) => [a.id, a]));
  const linkByExternal = new Map(links.map((l) => [`${l.provider}:${l.entity}:${l.external_id}`, l]));

  const employeeName = (userId: string | null, externalId: string | null): string => {
    if (userId && userById.has(userId)) return userById.get(userId)!.name;
    if (externalId) return userById.get(externalId)?.name ?? `HL user ${externalId}`;
    return "—";
  };
  // Employee filter options: everyone seen in the attempt ledger, roster-
  // independent (departed reps keep their names via the users row).
  const employeeIds = new Set<string>();
  for (const a of attempts) {
    if (a.employee_user_id) employeeIds.add(a.employee_user_id);
    else if (a.employee_external_id) employeeIds.add(a.employee_external_id);
  }
  const employees = [...employeeIds].map((id) => ({ id, name: employeeName(userById.has(id) ? id : null, userById.has(id) ? null : id) }));

  const attemptsByAppointment = new Map<string, RetentionAttemptRow[]>();
  for (const a of attempts) {
    if (!a.appointment_id) continue;
    const list = attemptsByAppointment.get(a.appointment_id) ?? [];
    list.push(a);
    attemptsByAppointment.set(a.appointment_id, list);
  }

  const inRange = (o: RetentionOutcomeRow): boolean =>
    range.start == null || (o.contact_due_date >= range.start && o.contact_due_date <= (range.end ?? ""));

  /** No-Shows range by APPOINTMENT date (see the overview note) — the D10 no-show can only exist once the session has passed. */
  const apptDateEtOf = (o: RetentionOutcomeRow): string | null => {
    const a = apptById.get(o.appointment_id);
    if (!a) return null;
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) ? etDateStrFromInstant(ms) : null;
  };
  const inRangeByAppt = (o: RetentionOutcomeRow): boolean => {
    if (range.start == null) return true;
    const d = apptDateEtOf(o);
    return d != null && d >= range.start && d <= (range.end ?? "");
  };

  // The kpi's row universe (§16 verbatim), before the secondary filters.
  const apptMsOf = (o: RetentionOutcomeRow): number | null => {
    const a = apptById.get(o.appointment_id);
    if (!a) return null;
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) ? ms : null;
  };
  const noShowRow = (o: RetentionOutcomeRow): boolean => {
    const a = apptById.get(o.appointment_id);
    if (!a || a.cancelled) return false;
    if (!retention.qualifying_statuses.includes(a.status)) return false;
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) && ms < nowMs;
  };
  const base = outcomes.filter((o) => {
    if (!o.eligible) return false;
    if (!inRetentionDataScope(apptMsOf(o), dataStart)) return false; // owner directive 10/21 — display boundary (pre-cutoff rows stay stored, not shown)
    const rangeOk = params.kpi === "no-shows" ? inRangeByAppt(o) : inRange(o);
    if (!rangeOk) return false;
    return inKpiUniverse(o, params.kpi, { nowMs, apptMsOf, noShowRow });
  });
  const matchedCount = base.length;

  // Secondary filters (classification / outcome / employee).
  const classification = params.classification && params.classification !== "all" ? params.classification : null;
  const filtered = base.filter((o) => {
    if (classification && o.final_status !== classification) return false;
    if (params.outcome !== "all") return false; // outcome data lives in the unwritten cancellations ledger
    if (params.employee !== "all") {
      const list = attemptsByAppointment.get(o.appointment_id) ?? [];
      if (!list.some((a) => a.employee_user_id === params.employee || a.employee_external_id === params.employee)) return false;
    }
    return true;
  });

  const rows: RetentionDrillRow[] = filtered.map((o) => {
    const client = clientById.get(o.internal_client_id) ?? null;
    const appt = apptById.get(o.appointment_id) ?? null;
    const acuityId = (o.evidence as { acuity_appointment_id?: unknown }).acuity_appointment_id;
    const attemptsList = (attemptsByAppointment.get(o.appointment_id) ?? [])
      .slice()
      .sort((a, b) => (a.attempt_at < b.attempt_at ? -1 : 1))
      .map((a) => ({
        attemptAt: a.attempt_at,
        employeeName: employeeName(a.employee_user_id, a.employee_external_id),
        direction: a.direction,
        status: a.call_status,
        durationSeconds: a.duration_seconds,
        attemptClass: a.attempt_class,
        attribution: a.attribution,
      }));
    const apptLink = acuityId && typeof acuityId === "string" ? linkByExternal.get(`acuity:appointment:${acuityId}`) ?? null : null;
    const contactLink = client?.ghl_contact_external_id ? linkByExternal.get(`highlevel:contact:${client.ghl_contact_external_id}`) ?? null : null;
    const ms = appt ? Date.parse(appt.appointment_datetime) : NaN;
    return {
      appointmentId: o.appointment_id,
      acuityId: typeof acuityId === "string" ? acuityId : appt?.acuity_appointment_id ?? null,
      internalClientId: o.internal_client_id,
      clientName: client?.display_name ?? null,
      apptIso: appt?.appointment_datetime ?? null,
      apptDateEt: Number.isFinite(ms) ? etDateStrFromInstant(ms) : null,
      apptTimeEt: Number.isFinite(ms)
        ? new Intl.DateTimeFormat("en-US", { timeZone: OPERATIONAL_TIMEZONE, hour: "numeric", minute: "2-digit" }).format(new Date(ms))
        : null,
      cancelled: appt?.cancelled ?? false,
      appointmentStatus: appt?.status ?? ((o.evidence as { appointment_status?: unknown }).appointment_status as string | null) ?? null,
      dueDate: o.contact_due_date,
      contactName: client?.display_name ?? null,
      contactPhoneLast4: client?.normalized_phone ? client.normalized_phone.slice(-4) : null,
      ghlContactId: client?.ghl_contact_external_id ?? null,
      attemptsCount: o.attempts_count,
      attempts: attemptsList,
      lastCallStatus: attemptsList.length ? (attemptsList[attemptsList.length - 1]!.status ?? null) : null,
      transcriptResult: null,
      notes: appt?.raw && typeof (appt.raw as { notes?: unknown }).notes === "string" ? ((appt.raw as { notes: string }).notes as string) : null,
      finalStatus: o.final_status,
      needsReviewReason: o.needs_review_reason,
      outcome: null, // appointment-funnel rows carry no ledger outcome (cancelled appointments leave the contact funnel)
      cancelledAt: null,
      recoveredAt: null,
      successorAppointmentId: null,
      lastAttemptAt: o.last_attempt_at, // D1 — the outcome row's stored last-contact stamp
      matchMethod: apptLink?.match_method ?? null,
      contactMatchMethod: contactLink?.match_method ?? null,
      evidence: o.evidence,
    };
  });
  rows.sort((a, b) => {
    const d = (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0);
    if (d !== 0) return -d; // most recent due date first (management reads today's work first)
    return (a.clientName ?? "").localeCompare(b.clientName ?? "");
  });

  // The four §16 ledger kpis never reach this branch (their rows are
  // ret_cancellations rows, handled above) — no emptyReason here.
  const emptyReason = null;

  return {
    kpi: params.kpi,
    kpiLabel: RETENTION_KPI_LABEL[params.kpi],
    range: params.range,
    rangeLabel: range.label,
    dueDays: range.start == null ? "All stored outcomes" : `${formatShort(range.start)} – ${formatShort(range.end!)}`,
    rangeStartEt: range.start,
    rangeEndEt: range.end,
    todayEt,
    ownerName,
    dueDaysSetting: dueDays,
    rows,
    matchedCount,
    employees,
    emptyReason,
    recoveryDenominator: null,
    exceptions: null,
    cancellationsEngineNote: CANCELLATIONS_ENGINE_NOTE,
  };
}

function formatShort(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

// ---- Needs-Review signal grid (UI spec §5b — four honest cells) ----

export interface SignalCellData {
  label: string;
  value: string;
  /** Amber dot: this cell's evidence conflicts with the classification path. */
  conflict: boolean;
  /** Supporting-only label (the Duration cell is never the decider). */
  note?: string;
}

/**
 * The four signals behind a Needs Review verdict, read from the outcome row's
 * evidence jsonb. Conflict flags are DERIVED (never guessed):
 *  - GHL call status conflicts when an answered/answered-uncorroborated
 *    attempt exists but the final status is not Verified Spoke With.
 *  - Acuity notes conflict when a SWC marker exists but the call log did not
 *    produce a Verified verdict (D5: notes corroborate, never replace), or
 *    when an LVM marker sits on a Verified verdict.
 *  - Transcript never conflicts (always "—"); Duration is supporting-only.
 */
export function deriveSignalCells(outcome: {
  final_status: string;
  needs_review_reason: string | null;
  evidence: Record<string, unknown>;
}): SignalCellData[] {
  const ev = outcome.evidence as {
    attempts?: { call_status?: string | null; duration_seconds?: number | null; attempt_class?: string }[];
    note_evidence?: NoteEvidence;
    transcript_basis?: string | null;
  };
  const attempts = Array.isArray(ev.attempts) ? ev.attempts : [];
  const statuses = [...new Set(attempts.map((a) => a.call_status).filter((s): s is string => !!s))];
  const answered = attempts.some((a) => a.attempt_class === "answered" || a.attempt_class === "answered_uncorroborated");
  const callStatusCell: SignalCellData = {
    label: "GHL call status",
    value: attempts.length === 0 ? "0 attempts recorded" : `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}: ${statuses.join(", ") || "—"}`,
    conflict: answered && outcome.final_status !== "verified_spoke_with",
  };
  const transcriptCell: SignalCellData = {
    label: "Transcript",
    value: "— no transcripts in GHL payload",
    conflict: false,
    note: (ev.transcript_basis as string | undefined) ?? undefined,
  };
  const ne = ev.note_evidence;
  const noteLines: string[] = [];
  if (ne) {
    for (const m of [...(ne.spokeMarkers ?? []), ...(ne.voicemailMarkers ?? [])]) noteLines.push(m.raw);
    for (const p of ne.paraphraseSpoke ?? []) noteLines.push(`"…${p}…"`);
    for (const p of ne.paraphraseVoicemail ?? []) noteLines.push(`"…${p}…"`);
  }
  const notesCell: SignalCellData = {
    label: "Acuity notes",
    value: noteLines.length ? noteLines.join(" · ") : "— none recorded",
    conflict:
      (Boolean(ne && (ne.spokeMarkers?.length || ne.paraphraseSpoke?.length)) && outcome.final_status !== "verified_spoke_with") ||
      Boolean(ne && ne.voicemailMarkers?.length && outcome.final_status === "verified_spoke_with"),
  };
  const durations = attempts.map((a) => (a.duration_seconds == null ? "—" : `${a.duration_seconds}s`));
  const durationCell: SignalCellData = {
    label: "Duration",
    value: durations.length ? durations.join(" · ") : "—",
    conflict: false,
    note: "supporting only — never decides",
  };
  return [callStatusCell, transcriptCell, notesCell, durationCell];
}

// ---- CSV export (reps assigned-leads-grid precedent) ----

/** Columns mirror the desktop table (full verbatim notes, not the clamp). */
export function retentionDrillCsv(
  rows: RetentionDrillRow[],
  meta: { kpi: string; range: string; ownerName: string | null; dueDaysSetting: number },
): string {
  const esc = (v: string | null | undefined): string => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    "client",
    "appointment_et",
    "contact_due_date",
    "ghl_contact",
    "call_attempts",
    "last_call_status",
    "transcript_result",
    "acuity_notes",
    "final_contact_classification",
    "appointment_outcome",
  ];
  const lines = [
    `# retention ${meta.kpi} · range=${meta.range} · retention_owner=${meta.ownerName ?? "—"} · due_days=${meta.dueDaysSetting} · timezone=America/New_York`,
    head.join(","),
    ...rows.map((r) =>
      [
        r.clientName,
        r.apptIso ? `${r.apptDateEt} ${r.apptTimeEt ?? ""}`.trim() : null,
        // Ledger rows have no contact due date (the appointment left the
        // funnel) — the cell says what the date actually is, never a mislabel.
        r.outcome != null ? (r.dueDate ? `cancelled ${r.dueDate}` : "cancelled —") : r.dueDate,
        r.contactName ? `${r.contactName} · ··${r.contactPhoneLast4 ?? "—"}` : null,
        String(r.attemptsCount),
        r.lastCallStatus,
        r.transcriptResult ?? "—",
        r.notes,
        FINAL_STATUS_LABEL[r.finalStatus] ?? r.finalStatus,
        r.outcome ?? "—",
      ]
        .map(esc)
        .join(","),
    ),
  ];
  return lines.join("\n") + "\n";
}

// ---- NEEDS ATTENTION queue (owner restructure directive 2026-10-20, point 1) ----

/** Queue segments — proven engine families only; the cancellation slot stays empty until that stage writes its ledger. */
export type RetentionQueueSegment = "call-due" | "unreached" | "window-missed" | "needs-review" | "cancellation" | "transfer";

export const QUEUE_SEGMENT_LABEL: Record<RetentionQueueSegment, string> = {
  "call-due": "Excitement call due",
  unreached: "Still unreached",
  "window-missed": "Missed call window",
  "needs-review": "Needs review",
  cancellation: "Cancellation — awaiting outcome",
  transfer: "Transfer — client moved calendars",
};

export interface RetentionQueueRow {
  segment: RetentionQueueSegment;
  appointmentId: string;
  acuityId: string | null;
  internalClientId: string;
  clientName: string | null;
  apptIso: string | null;
  apptDateEt: string | null;
  apptTimeEt: string | null;
  dueDate: string;
  attemptsCount: number;
  lastCallStatus: string | null;
  finalStatus: string;
  /** Human status for the queue's Status column (never the raw enum). */
  statusLabel: string;
  /** The queue's Action cell — its verb; the row links to the drill pre-filtered. Transfers rows carry NO drill home yet (no drill mode exists), so the Action cell renders — rather than a dishonest link. */
  actionLabel: string;
  /** null = no drill-down exists for this segment (transfers, stage 5) — the route renders the Action cell as an honest —, never a link to the wrong list. */
  drillKpi: RetentionKpiKey | null;
  /** D1 — last contact instant (outcome last_attempt_at; ledger rows derive it from the same attempt ledger). Null renders "— none yet". */
  lastAttemptAt: string | null;
  /** D2 — when the call window closes (appointment instant; call-due / unreached-open only; derived at load). */
  windowCloses: string | null;
  /** D2 — window closes TODAY (ET), derived at load; drives the priority chip's caution dot. */
  windowClosing: boolean;
  /** D6 — the owner's urgency rank; the loader sorts by it. */
  priority: RetentionPriority;
}

/** D6 — the owner's urgency ladder (spec §5.3): 1 save now / 2 call / 4 salvage / 5 records. Ranks 3 (no-show follow-up) and reschedule-pending are RESERVED until their stages ship. */
export type RetentionPriority = 1 | 2 | 4 | 5;

export const RETENTION_PRIORITY_LABEL: Record<RetentionPriority, string> = {
  1: "Save now",
  2: "Call",
  4: "Salvage",
  5: "Records",
};

/** Segment -> urgency rank (reserved ranks absent). Transfers ride the
 * Records rank (5): a standing fact for management awareness, never open
 * client work — the client already moved calendars; nothing is saved or
 * called from here (owner §16: transfers are excluded from owner compliance). */
const QUEUE_PRIORITY: Record<RetentionQueueSegment, RetentionPriority> = {
  cancellation: 1,
  "call-due": 2,
  unreached: 2,
  "window-missed": 4,
  "needs-review": 5,
  transfer: 5,
};

export interface RetentionQueueData {
  todayEt: string;
  weekStartEt: string;
  weekEndEt: string;
  dueDays: number;
  ownerName: string | null;
  rows: RetentionQueueRow[];
  counts: {
    callDue: number;
    unreached: number;
    windowMissed: number;
    needsReview: number;
    /** The §16 Active-Cancellations universe over the written ledger (stage 4a) — a real 0 is a fact. */
    cancellations: number;
    /** The stage-5 transfers ledger, display-scoped on the ORIGINAL appointment — every standing transfer row. */
    transfers: number;
  };
  /** D3 — ledger rows via inCancellationUniverse(r, "recovery") with recovered_at in the current Mon–Sun ET week. Derived only; the ledger stays write-once. */
  cancellationsRecoveredThisWeek: number;
  cancellationsEngineNote: string;
}

/**
 * The client-level work queue under the TODAY row (owner restructure point 1):
 * everything the engine can PROVE needs action today, drawn from the drill-
 * downs' own row universes via inKpiUniverse (ONE source of truth — the queue
 * never re-derives §16 math):
 *   call-due       — current due-week cohort, window still open, not spoken
 *                    with and not needs-review → "Call".
 *   unreached      — §16 Still-Unreached universe, window still open, NOT
 *                    already a call-due row → "Call again".
 *   window-missed  — §16 Still-Unreached universe, window closed (session
 *                    passed with zero answered attempts) → "Review".
 *   needs-review   — the evidence-conflict queue (all stored outcomes) → "Open".
 *   cancellation    — the §16 Active-Cancellations universe over the WRITTEN
 *                     ledger (stage 4a), via inCancellationUniverse — the SAME
 *                     predicate the Active Cancellations card counts (one
 *                     source of truth; cancelled appointments leave the
 *                     contact funnel, so these rows can never also be
 *                     call-due/unreached/needs-review rows) → "Save".
 *   transfer        — the WRITTEN transfers ledger (stage 5), display-scoped
 *                     on the ORIGINAL appointment's instant (owner directive
 *                     10/21): a standing fact for awareness, never open work
 *                     — the client already moved calendars, so the Action cell
 *                     is an honest "—" (no drill home exists; no link to the
 *                     wrong list). The pool is same-client by construction and
 *                     a transferred original's cancellations outcome is
 *                     "rescheduled", never "pending", so it can never also be
 *                     a cancellation row — disjoint by the ledgers' own rules.
 * Disjoint by construction: call-due ids are removed from unreached-open, and
 * a row is never in two segments.
 *
 * ORDER = the owner's urgency sort (UX spec §5.3, replaces the old segment-
 * block order): 1 cancellation (save now) · 2 call-due then unreached-open
 * (soonest appointment first; window-closing rows flagged) · 4 window-missed
 * (most-recently-missed first — freshest salvage on top) · 5 needs-review.
 * Ranks 3 (no-show follow-up) and reschedule-pending slot in when their
 * stages land. Every row carries its rank (row.priority) so the page renders
 * the Priority column from the SAME derivation it sorts by.
 */
export async function retentionNeedsAttention(store: Store, now: () => Date = () => new Date()): Promise<RetentionQueueData> {
  const nowMs = now().getTime();
  const todayEt = etDateStrFromInstant(nowMs);
  const ws = weekStart(todayEt);
  const we = addDays(ws, 6);
  const settings = await store.getSettings();
  // CURRENT settings at call time (see retentionOverview).
  const retention = normalizeRetentionSettings(settings.retention ?? DEFAULT_RETENTION_SETTINGS);
  const dueDays = retention.due_days;
  const dataStart = retention.data_start_week_start; // the DISPLAY boundary, resolved at call time
  const [outcomes, attempts, clients, appts, ownerRows, cancellationRows, transferRows] = await Promise.all([
    store.listRetentionAppointmentOutcomes(),
    store.listRetentionAttempts(),
    store.listInternalClients(),
    store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(todayEt, -(retention.compute_lookback_days + dueDays + 2)))),
    store.listRetentionOwnerHistory(),
    store.listRetentionCancellations(),
    store.listRetentionTransfers(),
  ]);
  const ownerName = currentRetentionOwner(ownerRows, todayEt);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const apptById = new Map(appts.map((a) => [a.id, a]));
  const apptIdMs = (appointmentId: string): number | null => {
    const a = apptById.get(appointmentId);
    if (!a) return null;
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) ? ms : null;
  };
  const apptMsOf = (o: RetentionOutcomeRow): number | null => apptIdMs(o.appointment_id);
  const ctx: KpiUniverseCtx = { nowMs, apptMsOf };

  // OWNER DIRECTIVE 10/21 — every queue segment is DISPLAY-scoped: no
  // pre-cutoff appointment may surface as a chip count or a row. Stored rows
  // stay untouched (the writers keep observing everything).

  const lastCallStatus = (appointmentId: string): string | null => {
    let latest: RetentionAttemptRow | null = null;
    for (const a of attempts) {
      if (a.appointment_id !== appointmentId) continue;
      if (!latest || a.attempt_at > latest.attempt_at) latest = a;
    }
    return latest?.call_status ?? null;
  };
  // D1 — the same scan, surfacing WHEN the last contact happened (the outcome
  // rows carry it as last_attempt_at; ledger rows derive it from the SAME
  // attempt ledger so "— none yet" is always a proven fact, never a gap).
  const lastAttemptAtOf = (appointmentId: string): string | null => {
    let latest: RetentionAttemptRow | null = null;
    for (const a of attempts) {
      if (a.appointment_id !== appointmentId) continue;
      if (!latest || a.attempt_at > latest.attempt_at) latest = a;
    }
    return latest?.attempt_at ?? null;
  };

  const shape = (o: RetentionOutcomeRow, segment: RetentionQueueSegment, statusLabel: string, actionLabel: string, drillKpi: RetentionKpiKey): RetentionQueueRow => {
    const client = clientById.get(o.internal_client_id) ?? null;
    const ms = apptMsOf(o);
    const evAcuity = (o.evidence as { acuity_appointment_id?: unknown }).acuity_appointment_id;
    // D2 — the window-closes instant is DERIVED AT LOAD (pure, from the
    // appointment row), never from a client clock at render time.
    const windowCloses = segment === "call-due" || segment === "unreached" ? (ms == null ? null : new Date(ms).toISOString()) : null;
    return {
      segment,
      priority: QUEUE_PRIORITY[segment],
      windowCloses,
      windowClosing: windowCloses != null && ms != null && etDateStrFromInstant(ms) === todayEt,
      lastAttemptAt: o.last_attempt_at,
      appointmentId: o.appointment_id,
      acuityId: typeof evAcuity === "string" ? evAcuity : apptById.get(o.appointment_id)?.acuity_appointment_id ?? null,
      internalClientId: o.internal_client_id,
      clientName: client?.display_name ?? null,
      apptIso: ms == null ? null : new Date(ms).toISOString(),
      apptDateEt: ms == null ? null : etDateStrFromInstant(ms),
      apptTimeEt:
        ms == null
          ? null
          : new Intl.DateTimeFormat("en-US", { timeZone: OPERATIONAL_TIMEZONE, hour: "numeric", minute: "2-digit" }).format(new Date(ms)),
      dueDate: o.contact_due_date,
      attemptsCount: o.attempts_count,
      lastCallStatus: lastCallStatus(o.appointment_id),
      finalStatus: o.final_status,
      statusLabel,
      actionLabel,
      drillKpi,
    };
  };

  // Segment 1 — excitement call due: the current due week's open-window
  // cohort minus spoken-with and needs-review (those have their own homes).
  const callDue = outcomes.filter((o) => {
    if (!o.eligible) return false;
    if (!inRetentionDataScope(apptMsOf(o), dataStart)) return false; // owner directive 10/21 — display boundary
    if (o.contact_due_date < ws || o.contact_due_date > we) return false;
    if (o.final_status === "verified_spoke_with" || o.final_status === "needs_review") return false;
    const ms = apptMsOf(o);
    return ms != null && ms >= nowMs;
  });
  const callDueIds = new Set(callDue.map((o) => o.appointment_id));

  // §16 Still-Unreached universe over ALL stored outcomes (the open queue,
  // not a week slice) — same predicate the drill's unreached kpi uses;
  // pre-cutoff rows hidden from DISPLAY (owner directive 10/21).
  const unreachedRows = outcomes.filter((o) => o.eligible && inRetentionDataScope(apptMsOf(o), dataStart) && inKpiUniverse(o, "unreached", ctx));
  const unreachedOpen = unreachedRows.filter((o) => {
    const ms = apptMsOf(o);
    return ms != null && ms >= nowMs && !callDueIds.has(o.appointment_id);
  });
  const windowMissed = unreachedRows.filter((o) => {
    const ms = apptMsOf(o);
    return ms == null || ms < nowMs;
  });

  // Needs review — ALL stored outcomes in DISPLAY scope (the open queue, like
  // its card); pre-cutoff rows stay stored, not shown (owner directive 10/21).
  const needsReview = outcomes.filter((o) => o.final_status === "needs_review" && inRetentionDataScope(apptMsOf(o), dataStart));

  // Cancellations — the §16 Active-Cancellations universe over the WRITTEN
  // ledger (stage 4a), through inCancellationUniverse: the SAME predicate the
  // Active Cancellations card counts. Pending = the actionable save work;
  // recovered/confirmed/unable rows have outcomes and are not queue work.
  // The engine only writes resolved-client rows (unlinked ones are exception-
  // queued); the null-client guard is defensive honesty, never a drop.
  const cancellations = cancellationRows.filter(
    (r) =>
      r.internal_client_id != null &&
      inRetentionDataScope(apptIdMs(r.appointment_id), dataStart) && // owner directive 10/21 — pre-cutoff cancellations stay stored, not shown
      inCancellationUniverse(r, "active-cancellations"),
  );
  const cancellationQueueRow = (r: RetentionCancellationRow): RetentionQueueRow => {
    const client = clientById.get(r.internal_client_id!) ?? null;
    const appt = apptById.get(r.appointment_id) ?? null;
    const ms = appt ? Date.parse(appt.appointment_datetime) : NaN;
    const cancelledMs = r.cancelled_at ? Date.parse(r.cancelled_at) : NaN;
    const evAcuity = (r.notes as { acuity_appointment_id?: unknown } | null)?.acuity_appointment_id;
    return {
      segment: "cancellation",
      priority: QUEUE_PRIORITY.cancellation,
      lastAttemptAt: lastAttemptAtOf(r.appointment_id),
      windowCloses: null, // the ledger tracks the reschedule window; the appointment cell renders "cancelled <date>"
      windowClosing: false,
      appointmentId: r.appointment_id,
      acuityId: appt?.acuity_appointment_id ?? (typeof evAcuity === "string" ? evAcuity : null),
      internalClientId: r.internal_client_id!,
      clientName: client?.display_name ?? null,
      apptIso: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      apptDateEt: Number.isFinite(ms) ? etDateStrFromInstant(ms) : null,
      apptTimeEt: Number.isFinite(ms)
        ? new Intl.DateTimeFormat("en-US", { timeZone: OPERATIONAL_TIMEZONE, hour: "numeric", minute: "2-digit" }).format(new Date(ms))
        : null,
      // The sub-label under the appointment renders "cancelled <date>" for
      // this segment (route) — the write-once confirmation stamp, not a due date.
      dueDate: Number.isFinite(cancelledMs) ? etDateStrFromInstant(cancelledMs) : "",
      attemptsCount: r.attempts_count,
      lastCallStatus: lastCallStatus(r.appointment_id),
      finalStatus: r.final_contact_status ?? "none",
      statusLabel: "Awaiting outcome",
      actionLabel: "Save",
      drillKpi: "active-cancellations",
    };
  };

  // Transfers — the WRITTEN stage-5 ledger (ret_transfers), display-scoped on
  // the ORIGINAL appointment's instant (owner directive 10/21; the engine's
  // display_note). The null-client guard is defensive honesty (the engine only
  // writes resolved-client rows — unlinked originals are exception-queued).
  // A transfer is a standing fact, NOT open work: the client already moved
  // calendars, so priority 5 (Records), statusLabel "Transferred", and the
  // Action cell is an honest "—" via drillKpi null (no drill home exists —
  // a link to the wrong list would be a fabrication; the owner's §16 ruling
  // keeps transfers OUT of owner compliance).
  const transfers = transferRows.filter(
    (r) =>
      r.internal_client_id != null &&
      inRetentionDataScope(apptIdMs(r.appointment_id), dataStart), // owner directive 10/21 — pre-cutoff transfers stay stored, not shown
  );
  const transferQueueRow = (r: RetentionTransferRow): RetentionQueueRow => {
    const client = clientById.get(r.internal_client_id!) ?? null;
    const appt = apptById.get(r.appointment_id) ?? null;
    const ms = appt ? Date.parse(appt.appointment_datetime) : NaN;
    const detectedMs = Date.parse(r.detected_at);
    const evAcuity = (r.notes as { acuity_appointment_id?: unknown } | null)?.acuity_appointment_id;
    return {
      segment: "transfer",
      priority: QUEUE_PRIORITY.transfer,
      lastAttemptAt: lastAttemptAtOf(r.appointment_id),
      windowCloses: null, // the transfer window is closed by definition (the client already rebooked)
      windowClosing: false,
      appointmentId: r.appointment_id,
      acuityId: appt?.acuity_appointment_id ?? (typeof evAcuity === "string" ? evAcuity : null),
      internalClientId: r.internal_client_id!,
      clientName: client?.display_name ?? null,
      // The ORIGINAL booking's session — the row is attributed to the original
      // booker's client series (the original-booker exception).
      apptIso: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      apptDateEt: Number.isFinite(ms) ? etDateStrFromInstant(ms) : null,
      apptTimeEt: Number.isFinite(ms)
        ? new Intl.DateTimeFormat("en-US", { timeZone: OPERATIONAL_TIMEZONE, hour: "numeric", minute: "2-digit" }).format(new Date(ms))
        : null,
      // The sub-label under the appointment renders "transferred <date>" for
      // this segment (route) — the write-once confirmation stamp, not a due date.
      dueDate: Number.isFinite(detectedMs) ? etDateStrFromInstant(detectedMs) : "",
      attemptsCount: attempts.reduce((n, a) => (a.appointment_id === r.appointment_id ? n + 1 : n), 0),
      lastCallStatus: lastCallStatus(r.appointment_id),
      finalStatus: "none", // the transfers ledger carries no final-contact classification; statusLabel speaks instead
      statusLabel: "Transferred",
      actionLabel: "",
      drillKpi: null,
    };
  };

  const rows: RetentionQueueRow[] = [
    ...callDue.map((o) =>
      shape(
        o,
        "call-due",
        o.attempts_count === 0 ? "No attempt yet" : FINAL_STATUS_LABEL[o.final_status] ?? o.final_status,
        "Call",
        "clients-due",
      ),
    ),
    ...unreachedOpen.map((o) => shape(o, "unreached", "Unreached", "Call again", "unreached")),
    ...windowMissed.map((o) => shape(o, "window-missed", "Window missed", "Review", "unreached")),
    ...needsReview.map((o) => shape(o, "needs-review", "Evidence conflict", "Open", "needs-review")),
    ...cancellations.map(cancellationQueueRow),
    ...transfers.map(transferQueueRow),
  ];
  const byApptAsc = (a: RetentionQueueRow, b: RetentionQueueRow): number => {
    if (a.apptIso == null || b.apptIso == null) return a.apptIso == null ? 1 : -1;
    return a.apptIso < b.apptIso ? -1 : a.apptIso > b.apptIso ? 1 : 0;
  };
  // Equal-rank tiebreak inside rank 2: call-due before unreached at the same
  // instant (the newer work first), then client name for full determinism.
  const SEGMENT_TIEBREAK: Record<RetentionQueueSegment, number> = {
    cancellation: 0,
    "call-due": 0,
    unreached: 1,
    "window-missed": 0,
    "needs-review": 0,
    transfer: 0,
  };
  // D6 — the owner's urgency sort: 1 cancellation · 2 call-due then
  // unreached-open (soonest appointment first) · 4 window-missed (most
  // recently missed first) · 5 needs-review then transfers (both Records-rank
  // standing facts; soonest appointment first). Ranks 3/4-reschedule slot in
  // with their pipeline stages (nothing renders for them today).
  rows.sort((a, b) => {
    const pr = a.priority - b.priority;
    if (pr !== 0) return pr;
    if (a.segment === "window-missed" && b.segment === "window-missed") {
      // most recently missed first — the freshest salvage opportunity on top
      if (a.apptIso == null || b.apptIso == null) return a.apptIso == null ? 1 : -1;
      return a.apptIso > b.apptIso ? -1 : a.apptIso < b.apptIso ? 1 : 0;
    }
    const appt = byApptAsc(a, b);
    if (appt !== 0) return appt;
    const tie = SEGMENT_TIEBREAK[a.segment] - SEGMENT_TIEBREAK[b.segment];
    if (tie !== 0) return tie;
    return (a.clientName ?? "").localeCompare(b.clientName ?? "");
  });

  // D3 — recovered-this-week count, derived ONLY (no writes): recovered rows
  // of the written ledger whose recovered_at lands in the current Mon–Sun ET
  // week AND whose cancelled appointment is in DISPLAY scope (owner directive
  // 10/21). The SAME §16 predicate the Recovery card counts.
  const recoveredThisWeek = cancellationRows.filter((r) => {
    if (!inRetentionDataScope(apptIdMs(r.appointment_id), dataStart)) return false; // owner directive 10/21 — display boundary
    if (!inCancellationUniverse(r, "recovery") || r.recovered_at == null) return false;
    const ms = Date.parse(r.recovered_at);
    if (!Number.isFinite(ms)) return false;
    const d = etDateStrFromInstant(ms);
    return d >= ws && d <= we;
  }).length;

  return {
    todayEt,
    weekStartEt: ws,
    weekEndEt: we,
    dueDays,
    ownerName,
    rows,
    counts: {
      callDue: callDue.length,
      unreached: unreachedOpen.length,
      windowMissed: windowMissed.length,
      needsReview: needsReview.length,
      cancellations: cancellations.length,
      transfers: transfers.length,
    },
    cancellationsRecoveredThisWeek: recoveredThisWeek,
    cancellationsEngineNote: CANCELLATIONS_ENGINE_NOTE,
  };
}
