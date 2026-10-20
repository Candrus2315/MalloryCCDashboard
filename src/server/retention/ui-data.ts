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
 *    ret_cancellations — a ledger NO stage writes yet. They render null ("—"),
 *    never 0: an empty unwritten table is "not computed", not a fact.
 *  - Transfers (no 13th card; scorecard row + InfoTip) come from
 *    ret_transfers — same treatment.
 *  - The Weekly Scorecard is NOT computed here (separate later delegation);
 *    the page renders its EmptyState until storage exists.
 *
 * Production volumes are tiny (the 7-day excitement cohort — 239 outcomes /
 * 139 attempts live-fire), so reads are the store's bulk reads and the
 * aggregation is in-memory, matching the retention store's own doctrine.
 */
import type { Store, RetentionOutcomeRow, RetentionAttemptRow, RetentionOwnerHistoryRow } from "../store/types";
import type { DataMatchExceptionRow, InternalClientRow } from "../store/types";
import { addDays, etDateStrFromInstant, etDayStartUtc, weekStart, OPERATIONAL_TIMEZONE } from "../date-logic";
import type { NoteEvidence } from "./classify";

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
  "The cancellations ledger (ret_cancellations) has no writer yet — the cancellations compute lands in a later stage. These cards render an honest — (not computed), never 0.";

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
}

export async function retentionOverview(store: Store, now: () => Date = () => new Date()): Promise<RetentionOverviewData> {
  const nowMs = now().getTime();
  const todayEt = etDateStrFromInstant(nowMs);
  const ws = weekStart(todayEt);
  const we = addDays(ws, 6);
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
  const [outcomes, attempts, exceptionsOpen, ownerRows] = await Promise.all([
    store.listRetentionAppointmentOutcomes(),
    store.listRetentionAttempts(),
    store.countDataMatchExceptions("open"),
    store.listRetentionOwnerHistory(),
  ]);
  const ownerName = currentRetentionOwner(ownerRows, todayEt);

  // Current-week due cohort ("as of now" R — UI spec §2: cards summarize the
  // current week's due cohort and all open queues).
  const cohort = outcomes.filter((o) => o.eligible && o.contact_due_date >= ws && o.contact_due_date <= we);
  const cohortIds = new Set(cohort.map((o) => o.appointment_id));

  // Appointment rows: needed for the D10 no-show proxy + the still-open window
  // test (both read appointment_datetime / CURRENT status). Same fetch floor
  // the compute uses, so every stored outcome's appointment is covered.
  const floorIso = etDayStartUtc(addDays(todayEt, -(retention.compute_lookback_days + dueDays + 2)));
  const appts = await store.getAppointmentsWithClientsSince(floorIso);
  const apptById = new Map(appts.map((a) => [a.id, a]));
  const apptMs = (o: RetentionOutcomeRow): number | null => {
    const a = apptById.get(o.appointment_id);
    if (!a) return null;
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) ? ms : null;
  };

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
    // Cancellations family: the ledger has no writer yet — null ("—"), never 0.
    { key: "active-cancellations", label: "Active Cancellations", value: null, ratio: null, sub: "awaiting outcome", attention: false },
    { key: "saves", label: "Saves", value: null, ratio: null, sub: "original appointment kept", attention: false },
    { key: "reschedules", label: "Reschedules", value: null, ratio: null, sub: "rebooked within window", attention: false },
    { key: "recovery", label: "Recovery Rate", value: null, ratio: null, sub: "recovered ÷ eligible", attention: false },
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
    { key: "needs-review", label: "Needs Review", value: outcomes.filter((o) => o.final_status === "needs_review").length, ratio: null, sub: "", attention: false },
  ];
  // Needs Review card: attention accent + consequence sub when > 0 (computed
  // over ALL stored outcomes — an open queue, not a week-scoped count).
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
      return false; // cancellations ledger unwritten — honest empty
    default:
      return false;
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
  /** Cancellation-outcome words — null while the cancellations ledger is unwritten. */
  outcome: null;
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

  // ---- match-exceptions mode: the shipped queue API verbatim (reuse mandate) ----
  if (params.kpi === "match-exceptions") {
    const { handleExceptionsQuery } = await import("./exceptions-api");
    const res = await handleExceptionsQuery(store, { status: params.exc });
    const body = res.body as {
      counts: { open: number; resolved: number; dismissed: number; total: number };
      exceptions: (DataMatchExceptionRow & { candidates_expanded: (InternalClientRow | null)[]; resolved_client: InternalClientRow | null })[];
    };
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
      matchedCount: body.counts[params.exc],
      employees: [],
      emptyReason: params.exc === "open" ? "No Data Match Exceptions — every client matched on explicit ID, phone, or email." : null,
      exceptions: { counts: body.counts, rows: body.exceptions },
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
      outcome: null,
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

  const emptyReason =
    params.kpi === "active-cancellations" || params.kpi === "saves" || params.kpi === "reschedules" || params.kpi === "recovery"
      ? CANCELLATIONS_ENGINE_NOTE
      : null;

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
        r.dueDate,
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
export type RetentionQueueSegment = "call-due" | "unreached" | "window-missed" | "needs-review" | "cancellation";

export const QUEUE_SEGMENT_LABEL: Record<Exclude<RetentionQueueSegment, "cancellation">, string> = {
  "call-due": "Excitement call due",
  unreached: "Still unreached",
  "window-missed": "Missed call window",
  "needs-review": "Needs review",
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
  /** The queue's Action cell — its verb; the row links to the drill pre-filtered. */
  actionLabel: string;
  drillKpi: RetentionKpiKey;
}

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
    /** Always null until the cancellations stage writes its ledger (honest "—", never 0). */
    cancellations: null;
  };
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
 *   cancellation    — SLOT ONLY: ret_cancellations has no writer yet; zero
 *                    rows by construction (CANCELLATIONS_ENGINE_NOTE) — the
 *                    page renders nothing rather than fake a row.
 * Disjoint by construction: call-due ids are removed from unreached-open, and
 * a row is never in two segments. Call-due/unreached/needs-review sort soonest
 * appointment first; missed windows sort most-recently-missed first (freshest
 * salvage opportunity on top).
 */
export async function retentionNeedsAttention(store: Store, now: () => Date = () => new Date()): Promise<RetentionQueueData> {
  const nowMs = now().getTime();
  const todayEt = etDateStrFromInstant(nowMs);
  const ws = weekStart(todayEt);
  const we = addDays(ws, 6);
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
  const [outcomes, attempts, clients, appts, ownerRows] = await Promise.all([
    store.listRetentionAppointmentOutcomes(),
    store.listRetentionAttempts(),
    store.listInternalClients(),
    store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(todayEt, -(retention.compute_lookback_days + dueDays + 2)))),
    store.listRetentionOwnerHistory(),
  ]);
  const ownerName = currentRetentionOwner(ownerRows, todayEt);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const apptById = new Map(appts.map((a) => [a.id, a]));
  const apptMsOf = (o: RetentionOutcomeRow): number | null => {
    const a = apptById.get(o.appointment_id);
    if (!a) return null;
    const ms = Date.parse(a.appointment_datetime);
    return Number.isFinite(ms) ? ms : null;
  };
  const ctx: KpiUniverseCtx = { nowMs, apptMsOf };

  const lastCallStatus = (appointmentId: string): string | null => {
    let latest: RetentionAttemptRow | null = null;
    for (const a of attempts) {
      if (a.appointment_id !== appointmentId) continue;
      if (!latest || a.attempt_at > latest.attempt_at) latest = a;
    }
    return latest?.call_status ?? null;
  };

  const shape = (o: RetentionOutcomeRow, segment: RetentionQueueSegment, statusLabel: string, actionLabel: string, drillKpi: RetentionKpiKey): RetentionQueueRow => {
    const client = clientById.get(o.internal_client_id) ?? null;
    const ms = apptMsOf(o);
    const evAcuity = (o.evidence as { acuity_appointment_id?: unknown }).acuity_appointment_id;
    return {
      segment,
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
    if (o.contact_due_date < ws || o.contact_due_date > we) return false;
    if (o.final_status === "verified_spoke_with" || o.final_status === "needs_review") return false;
    const ms = apptMsOf(o);
    return ms != null && ms >= nowMs;
  });
  const callDueIds = new Set(callDue.map((o) => o.appointment_id));

  // §16 Still-Unreached universe over ALL stored outcomes (the open queue,
  // not a week slice) — same predicate the drill's unreached kpi uses.
  const unreachedRows = outcomes.filter((o) => o.eligible && inKpiUniverse(o, "unreached", ctx));
  const unreachedOpen = unreachedRows.filter((o) => {
    const ms = apptMsOf(o);
    return ms != null && ms >= nowMs && !callDueIds.has(o.appointment_id);
  });
  const windowMissed = unreachedRows.filter((o) => {
    const ms = apptMsOf(o);
    return ms == null || ms < nowMs;
  });

  // Needs review — ALL stored outcomes (the open queue, like its card).
  const needsReview = outcomes.filter((o) => o.final_status === "needs_review");

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
  ];
  const segmentOrder: Record<RetentionQueueSegment, number> = { "call-due": 0, unreached: 1, "window-missed": 2, "needs-review": 3, cancellation: 4 };
  const byApptAsc = (a: RetentionQueueRow, b: RetentionQueueRow): number => {
    if (a.apptIso == null || b.apptIso == null) return a.apptIso == null ? 1 : -1;
    return a.apptIso < b.apptIso ? -1 : a.apptIso > b.apptIso ? 1 : 0;
  };
  rows.sort((a, b) => {
    const seg = segmentOrder[a.segment] - segmentOrder[b.segment];
    if (seg !== 0) return seg;
    if (a.segment === "window-missed") {
      // most recently missed first — the freshest salvage opportunity on top
      if (a.apptIso == null || b.apptIso == null) return a.apptIso == null ? 1 : -1;
      return a.apptIso > b.apptIso ? -1 : a.apptIso < b.apptIso ? 1 : 0;
    }
    return byApptAsc(a, b);
  });

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
      cancellations: null,
    },
    cancellationsEngineNote: CANCELLATIONS_ENGINE_NOTE,
  };
}
