/**
 * PERFORMANCE MANAGEMENT server functions (PIP module, Phase 1 — owner
 * directive 9/30). Mirrors the queries.ts conventions: a pure Core function
 * taking the Store (test seam, no TanStack runtime) + a thin createServerFn
 * wrapper. NOTHING here computes performance or auto-decides anything — the
 * system stores and displays; the manager decides everything (no AI, no
 * auto-created PIPs, no recommendations, no system conclusions).
 *
 * AUTH: every server function in this app runs behind the global passphrase
 * gate (src/start.ts request middleware → resolveGate: serverFn RPC gets 401
 * without a valid session). PIP data additionally appears ONLY on the
 * /performance* pages and these functions — never on leaderboards, team
 * comparisons, or rep surfaces.
 */
import { createServerFn } from "@tanstack/react-start";
import { getStore } from "./store";
import type { Store } from "./store/types";
import type {
  PipActionItem,
  PipCheckinRow,
  PipEventRow,
  PipEventType,
  PipEvidenceSnapshotRow,
  PipRow,
  PipStatus,
  PipTemplateRow,
} from "./store/types";
import { pipEvidenceCore, type PipEvidence } from "./pip-evidence";
import { statementsFromEvidence } from "./pip-statements";
import { addDays, etDayStartUtc, etToday, weekStart } from "./date-logic";
import { bookingsByRep, filterApptsInWinBucketRange } from "./metrics/compute";
import { appointmentInScope } from "./metrics/availability";
import { applyAttributionEligibility, applyRosterEligibility, buildRosterEligibility } from "./roster";
import {
  pipAttentionSeed,
  pipCheckinState,
  pipDaysUntil,
  pipEndingSoon,
  pipKpiCounts,
  pipReviewWeekIndex,
  pipWindowOverdue,
  type PipAttentionSeed,
  type PipKpiCounts,
} from "./pip-landing";
import { syncStaleWarnings } from "./queries";

// ---------- shared view shapes ----------

export interface PipListItem extends PipRow {
  rep_name: string | null;
}

async function withRepNames(store: Store, pips: PipRow[]): Promise<PipListItem[]> {
  const users = await store.getAllUsers();
  const byId = new Map(users.map((u) => [u.id, u]));
  return pips.map((p) => ({ ...p, rep_name: p.rep_id ? byId.get(p.rep_id)?.name ?? null : null }));
}

// ---------- reads ----------

/** List PIPs (optionally one status) with rep names — the manager list views. */
export async function listPipsCore(store: Store, status?: PipStatus | null): Promise<PipListItem[]> {
  return withRepNames(store, await store.listPips(status ?? null));
}

/**
 * Command-center landing row (refinement spec §1–§2): rule-based date math +
 * counts ONLY. No scoring, no lifecycle change — every field is derived from
 * stored dates (America/New_York) via pip-landing.ts.
 */
export interface PipLandingItem extends PipListItem {
  /** Signed days from today (ET) to pip_end_date; negative = past end. */
  days_left: number | null;
  ending_soon: boolean;
  window_overdue: boolean;
  next_checkin_date: string | null;
  checkin_count: number;
  /** "check-in {n} of {m}" — m from the manager's own cadence entry; null when unset. */
  checkin_expected_total: number | null;
  checkin_overdue: boolean;
  checkin_unscheduled: boolean;
  /** Paid wins THIS WEEK for the rep (in-progress week) — null when the PIP has no rep. */
  this_week_wins: number | null;
  // ---- PHASE 3 workspace fields (all server-derived, never client-approximated) ----
  /** 1-based index of today's Mon–Sun week inside the review window (null when outside / no window). */
  review_week_index: number | null;
  /** Mondays the review window covers — the SAME list the weekly goal-met table renders. */
  review_weeks_total: number | null;
  /**
   * Completed review weeks whose actual fell below the PIP's weekly minimum,
   * through pipEvidenceCore (the ONE evidence engine; hard per-week rule,
   * never averaged). Null ONLY when not evaluable (no rep / review window /
   * minimum) — 0 means evaluated with no missed week, never "unknown".
   */
  weeks_missed: number | null;
  /** True while the ISSUED PIP has no acknowledgment recorded (manager_acked_at null). */
  ack_awaiting: boolean;
  attention: PipAttentionSeed | null;
}

export interface PipLandingPayload {
  pips: PipLandingItem[];
  today: string;
  week_start: string;
  kpis: PipKpiCounts;
  mode: "postgres" | "memory";
  warnings: string[];
}

/**
 * PHASE 4 — per-PIP evidence summary for history/landing surfaces: weeks_met /
 * weeks_completed / weeks_missed, derived ONLY through pipEvidenceCore (the
 * ONE evidence engine — its per-week `met` flags are the hard-minimum
 * evaluation; nothing is recomputed or averaged here). Null ONLY when not
 * evaluable (no rep / review window / minimum, or structurally unusable
 * dates): callers render an honest "—" rather than a silent 0.
 */
export interface PipEvidenceSummary {
  weeks_met: number;
  weeks_completed: number;
  weeks_missed: number;
}

async function pipEvidenceSummary(store: Store, pip: PipRow, today: string): Promise<PipEvidenceSummary | null> {
  if (!pip.rep_id || !pip.review_start_date || !pip.review_end_date || pip.weekly_goal_min == null) return null;
  try {
    const evidence = await pipEvidenceCore(store, {
      repId: pip.rep_id,
      reviewStart: pip.review_start_date,
      reviewEnd: pip.review_end_date,
      weeklyGoalMin: pip.weekly_goal_min,
      hardWeeklyMinimum: pip.hard_weekly_minimum,
      today,
    });
    return {
      weeks_met: evidence.weeks_goal_met,
      weeks_completed: evidence.weeks_completed,
      weeks_missed: evidence.weekly.filter((w) => w.met === false).length,
    };
  } catch {
    return null; // structurally unusable inputs degrade honestly — never a fake 0
  }
}

/**
 * Landing derivation: completed review weeks below the weekly minimum. Same
 * evidence-engine path as the per-rep history summary — one engine, two views.
 */
async function pipWeeksMissed(store: Store, pip: PipRow, today: string): Promise<number | null> {
  return (await pipEvidenceSummary(store, pip, today))?.weeks_missed ?? null;
}

/**
 * All PIPs + the landing derivations, in one server read. The current-week
 * win count per rep comes through the EXACT chain the pages use (win-bucket
 * selector → scope → eligibility → bookingsByRep) — no second calculation.
 * Phase 3: the attention-queue's "weekly minimums missed" and "awaiting
 * acknowledgment" signals are derived HERE (server data layer) — the missed
 * count through pipEvidenceCore per issued PIP, the acknowledgment state from
 * the row's own ack columns.
 */
export async function performanceLandingCore(store: Store, opts?: { today?: string }): Promise<PipLandingPayload> {
  const today = opts?.today ?? etToday();
  const [pips, settings, allUsers, connections] = await Promise.all([
    listPipsCore(store, null),
    store.getSettings(),
    store.getAllUsers(),
    store.getConnections(),
  ]);
  const issued = pips.filter((p) => p.status === "issued");
  const checkinsByPip = new Map<string, PipCheckinRow[]>();
  const weeksMissedByPip = new Map<string, number | null>();
  await Promise.all(
    issued.map(async (p) => {
      checkinsByPip.set(p.id, await store.getPipCheckins(p.id));
      weeksMissedByPip.set(p.id, await pipWeeksMissed(store, p, today));
    }),
  );

  // THIS WEEK's paid wins per rep — same chain as repsPageData for the
  // current-week window (in-progress week: Monday → today).
  const ws = weekStart(today);
  const [apptsRaw, attributions, lookBackCalls] = await Promise.all([
    store.getAppointmentsByWinBusinessDateBetween(ws, today),
    store.getAttributions(),
    store.getAllCallsSince(etDayStartUtc(addDays(ws, -Math.ceil(settings.attribution_window_hours / 24) - 1))),
  ]);
  const eligibility = buildRosterEligibility(allUsers, settings.rep_mappings ?? []);
  const rosterLookBackCalls = applyRosterEligibility(lookBackCalls, eligibility);
  const attributionsEligible = applyAttributionEligibility(attributions, rosterLookBackCalls, eligibility);
  const weekAppts = filterApptsInWinBucketRange(apptsRaw, ws, today).filter((a) => appointmentInScope(a, settings.acuity));
  const winsByRep = bookingsByRep(weekAppts, attributionsEligible);

  const landing: PipLandingItem[] = pips.map((p) => {
    const daysLeft = pipDaysUntil(p.pip_end_date, today);
    const cs = pipCheckinState(p, checkinsByPip.get(p.id) ?? [], today);
    const weeksMissed = weeksMissedByPip.get(p.id) ?? null;
    const weekIdx =
      p.review_start_date && p.review_end_date
        ? pipReviewWeekIndex(p.review_start_date, p.review_end_date, today)
        : null;
    const ackAwaiting = p.status === "issued" && p.manager_acked_at == null;
    return {
      ...p,
      days_left: daysLeft,
      ending_soon: p.status === "issued" && pipEndingSoon(daysLeft),
      window_overdue: p.status === "issued" && pipWindowOverdue(daysLeft),
      next_checkin_date: cs.next_checkin_date,
      checkin_count: cs.count,
      checkin_expected_total: cs.expected_total,
      checkin_overdue: p.status === "issued" && cs.overdue,
      checkin_unscheduled: p.status === "issued" && cs.unscheduled,
      this_week_wins: p.rep_id ? (winsByRep.get(p.rep_id) ?? 0) : null,
      review_week_index: weekIdx?.index ?? null,
      review_weeks_total: weekIdx?.total ?? null,
      weeks_missed: weeksMissed,
      ack_awaiting: ackAwaiting,
      attention: pipAttentionSeed(p, p.rep_name, daysLeft, cs, {
        awaiting_ack: ackAwaiting,
        weeks_missed: weeksMissed ?? 0,
      }),
    };
  });

  return {
    pips: landing,
    today,
    week_start: ws,
    kpis: pipKpiCounts(landing),
    mode: store.mode,
    warnings: syncStaleWarnings(connections),
  };
}

export interface PipDetail {
  pip: PipListItem;
  checkins: PipCheckinRow[];
  snapshots: Pick<PipEvidenceSnapshotRow, "id" | "version" | "created_by" | "created_at">[];
  events: PipEventView[];
}

/**
 * Serializable event view for server-fn boundaries. The raw store row's
 * `details: Record<string, unknown> | null` fails TanStack Start's
 * serializable-return validation, which collapses the WHOLE typed payload to
 * `{}` at the call site (the wizard's TS2339 wall). Details are normalized to
 * plain string values here — a presentation boundary, not a store change:
 * unknown-typed values JSON-stringify exactly as the audit JSONB stores them.
 */
export interface PipEventView {
  id: string;
  pip_id: string | null;
  template_id: string | null;
  event_type: PipEventType;
  actor: string | null;
  field: string | null;
  previous_value: string | null;
  new_value: string | null;
  details: Record<string, string> | null;
  created_at: string;
}

/** Raw audit JSONB values → plain strings (strings pass through; others JSON-stringify). */
export function normalizeEventDetails(raw: Record<string, unknown> | null): Record<string, string> | null {
  if (!raw) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function pipEventView(e: PipEventRow): PipEventView {
  return {
    id: e.id,
    pip_id: e.pip_id,
    template_id: e.template_id,
    event_type: e.event_type,
    actor: e.actor,
    field: e.field,
    previous_value: e.previous_value,
    new_value: e.new_value,
    details: normalizeEventDetails(e.details),
    created_at: e.created_at,
  };
}

/** Full manager detail for one PIP: row + check-ins + snapshot index + event log. */
export async function getPipDetailCore(store: Store, id: string): Promise<PipDetail | null> {
  const pip = await store.getPip(id);
  if (!pip) return null;
  const [withName] = await withRepNames(store, [pip]);
  const [checkins, snapshots, events] = await Promise.all([
    store.getPipCheckins(id),
    store.getPipEvidenceSnapshots(id),
    store.getPipEvents({ pipId: id, limit: 200 }),
  ]);
  return {
    pip: withName,
    checkins,
    snapshots: snapshots.map((s) => ({ id: s.id, version: s.version, created_by: s.created_by, created_at: s.created_at })),
    events: events.map(pipEventView),
  };
}

/**
 * HISTORY SEGMENT (refinement spec §5): the full event ledger with SUBJECTS
 * RESOLVED TO NAMES — employee name + PIP title for PIP events, template name
 * for template events. Raw IDs never render as a subject/employee anywhere.
 * Read-only join over store lists; history itself is never modified.
 */
export interface PipHistorySubject {
  employee: string | null;
  title: string | null;
}

export interface PipHistoryPayload {
  events: PipEventView[];
  /** pip_id → employee + PIP title (resolved from the pips table). */
  pipSubjects: [string, PipHistorySubject][];
  /** template_id → template name (resolved from the templates table). */
  templateNames: [string, string][];
}

export async function getPerformanceHistoryCore(store: Store): Promise<PipHistoryPayload> {
  const [events, pips, templates] = await Promise.all([
    store.getPipEvents({ limit: 300 }),
    withRepNames(store, await store.listPips(null)),
    store.listPipTemplates(),
  ]);
  const pipSubjects = new Map<string, PipHistorySubject>(
    pips.map((p) => [p.id, { employee: p.rep_name, title: p.title }]),
  );
  const templateNames = new Map<string, string>(templates.map((t) => [t.id, t.name]));
  return {
    events: events.map(pipEventView),
    pipSubjects: Array.from(pipSubjects.entries()),
    templateNames: Array.from(templateNames.entries()),
  };
}

// ---------- per-rep performance history (Phase 4) ----------

/**
 * One PIP in an employee's stitched history: the row itself + the weekly
 * goal-met summary from pipEvidenceCore (the ONE evidence engine — the SAME
 * records the workspace's weekly table renders; hard per-week minimums,
 * never averaged). Null summary = not evaluable (no review window / minimum)
 * or a live-data read failure — honest "—", never a fake 0.
 */
export interface PipRepHistoryItem extends PipListItem {
  weeks_met: number | null;
  weeks_completed: number | null;
  weeks_missed: number | null;
}

/** One employee's full PIP history: completed + cancelled + active (+ drafts), newest first. */
export interface PipRepHistory {
  rep_id: string;
  rep_name: string | null;
  pips: PipRepHistoryItem[];
}

export interface PipRepHistoriesPayload {
  /** One entry per employee who has at least one assigned PIP; rep name ascending. */
  reps: PipRepHistory[];
}

/**
 * PER-REP PERFORMANCE HISTORY (Phase 4): stitches each employee's PIP records
 * across every lifecycle state with their weekly goal-met summaries. Same data
 * sources only — the pips table for the records, pipEvidenceCore for the
 * weekly numbers (the exact function the issue snapshot freezes and the
 * workspace table renders). No second engine, no new inputs, no scoring.
 */
export async function getPipRepHistoriesCore(store: Store, opts?: { today?: string }): Promise<PipRepHistoriesPayload> {
  const today = opts?.today ?? etToday();
  const pips = await withRepNames(store, await store.listPips(null));
  const summaries = new Map<string, PipEvidenceSummary | null>();
  await Promise.all(
    pips.map(async (p) => {
      if (!p.rep_id) return; // unassigned drafts have no employee history
      summaries.set(p.id, await pipEvidenceSummary(store, p, today));
    }),
  );
  const byRep = new Map<string, PipRepHistoryItem[]>();
  for (const p of pips) {
    if (!p.rep_id) continue;
    const s = summaries.get(p.id) ?? null;
    const item: PipRepHistoryItem = {
      ...p,
      weeks_met: s?.weeks_met ?? null,
      weeks_completed: s?.weeks_completed ?? null,
      weeks_missed: s?.weeks_missed ?? null,
    };
    const list = byRep.get(p.rep_id);
    if (list) list.push(item);
    else byRep.set(p.rep_id, [item]);
  }
  const reps: PipRepHistory[] = [...byRep.entries()].map(([rep_id, items]) => ({
    rep_id,
    rep_name: items[0]?.rep_name ?? null,
    pips: [...items].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  }));
  reps.sort((a, b) => (a.rep_name ?? "").localeCompare(b.rep_name ?? ""));
  return { reps };
}

// ---------- writes (manager actions; guards live in the stores) ----------

export interface CreatePipDraftInput {
  repId: string;
  title: string;
  goalText?: string | null;
  weeklyGoalMin?: number | null;
  hardWeeklyMinimum?: boolean;
  reviewStartDate?: string | null;
  reviewEndDate?: string | null;
  pipStartDate?: string | null;
  pipEndDate?: string | null;
  managerObservations?: string | null;
  actionPlan?: PipActionItem[];
  personalDevelopmentActions?: PipActionItem[];
  professionalDevelopmentActions?: PipActionItem[];
  checkinCadenceDays?: number | null;
  /** Provenance: the template the draft was created from (UI applies its defaults). */
  templateId?: string | null;
  actor?: string;
}

export async function createPipDraftCore(store: Store, input: CreatePipDraftInput): Promise<PipRow> {
  const repId = String(input.repId ?? "").trim();
  if (!repId) throw new Error("Pick a rep for the PIP");
  const rep = (await store.getAllUsers()).find((u) => u.id === repId);
  if (!rep) throw new Error("Unknown rep — pick a rep from this database");
  // Template provenance + defaults: the UI applies defaults into its form; the
  // API ALSO fills any field the caller left unset from the template, so an
  // API caller creating a draft from a template gets the same content.
  let template: PipTemplateRow | null = null;
  const templateId = String(input.templateId ?? "").trim() || null;
  if (templateId) {
    template = await store.getPipTemplate(templateId);
    if (!template) throw new Error("Unknown template — pick a template from this database");
  }
  const pick = (explicit: unknown, def: unknown) => (explicit !== undefined ? explicit : (def ?? null));
  return store.createPip({
    rep_id: repId,
    title: String(input.title ?? ""),
    goal_text: pick(input.goalText, template?.default_goal_text) as string | null,
    weekly_goal_min: input.weeklyGoalMin ?? null,
    hard_weekly_minimum: input.hardWeeklyMinimum === true,
    review_start_date: input.reviewStartDate ?? null,
    review_end_date: input.reviewEndDate ?? null,
    pip_start_date: input.pipStartDate ?? null,
    pip_end_date: input.pipEndDate ?? null,
    manager_observations: input.managerObservations ?? null,
    action_plan: (input.actionPlan ?? template?.default_action_plan ?? []) as PipActionItem[],
    personal_development_actions: (input.personalDevelopmentActions ??
      template?.default_personal ??
      []) as PipActionItem[],
    professional_development_actions: (input.professionalDevelopmentActions ??
      template?.default_professional ??
      []) as PipActionItem[],
    checkin_cadence_days: pick(input.checkinCadenceDays, template?.default_checkin_cadence_days) as number | null,
    template_id: templateId,
    template_version: template?.version ?? null,
    created_by: input.actor || "christopher",
  });
}

export interface UpdatePipDraftInput extends Partial<Omit<CreatePipDraftInput, "repId" | "actor">> {
  pipId: string;
  repId?: string;
  actor?: string;
}

export async function updatePipDraftCore(store: Store, input: UpdatePipDraftInput): Promise<PipRow> {
  return store.updatePipDraft(String(input.pipId), {
    ...(input.repId !== undefined ? { rep_id: String(input.repId) } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.goalText !== undefined ? { goal_text: input.goalText } : {}),
    ...(input.weeklyGoalMin !== undefined ? { weekly_goal_min: input.weeklyGoalMin } : {}),
    ...(input.hardWeeklyMinimum !== undefined ? { hard_weekly_minimum: input.hardWeeklyMinimum } : {}),
    ...(input.reviewStartDate !== undefined ? { review_start_date: input.reviewStartDate } : {}),
    ...(input.reviewEndDate !== undefined ? { review_end_date: input.reviewEndDate } : {}),
    ...(input.pipStartDate !== undefined ? { pip_start_date: input.pipStartDate } : {}),
    ...(input.pipEndDate !== undefined ? { pip_end_date: input.pipEndDate } : {}),
    ...(input.managerObservations !== undefined ? { manager_observations: input.managerObservations } : {}),
    ...(input.actionPlan !== undefined ? { action_plan: input.actionPlan } : {}),
    ...(input.personalDevelopmentActions !== undefined ? { personal_development_actions: input.personalDevelopmentActions } : {}),
    ...(input.professionalDevelopmentActions !== undefined ? { professional_development_actions: input.professionalDevelopmentActions } : {}),
    ...(input.checkinCadenceDays !== undefined ? { checkin_cadence_days: input.checkinCadenceDays } : {}),
    actor: input.actor || "christopher",
  });
}

/**
 * draft → issued (explicit manager action; writes the frozen v1 evidence
 * snapshot). Phase 2: the snapshot now captures the FULL document — employee
 * as of issue, the pip row as it stood, the computed evidence (weekly rows,
 * goal provenance), the generated factual statements verbatim, and the
 * template provenance. Evidence computation happens BEFORE the store's
 * transactional flip; the store stamps captured_at/captured_by.
 */
export async function issuePipCore(store: Store, input: { pipId: string; actor?: string }): Promise<PipRow> {
  const pip = await store.getPip(String(input.pipId));
  if (!pip) throw new Error(`PIP not found: ${input.pipId}`);
  const extras: Record<string, unknown> = {};
  if (pip.review_start_date && pip.review_end_date) {
    const evidence = await pipEvidenceCore(store, {
      repId: pip.rep_id ?? "",
      reviewStart: pip.review_start_date,
      reviewEnd: pip.review_end_date,
      weeklyGoalMin: pip.weekly_goal_min,
      hardWeeklyMinimum: pip.hard_weekly_minimum,
    });
    extras.evidence = evidence;
    extras.statements = statementsFromEvidence(evidence);
  } else {
    extras.evidence = null;
    extras.statements = [];
    extras.evidence_note = "No review period was set at issue — the frozen snapshot carries no weekly evidence.";
  }
  const rep = pip.rep_id ? (await store.getAllUsers()).find((u) => u.id === pip.rep_id) : null;
  extras.employee = rep
    ? { id: rep.id, name: rep.name, email: rep.email ?? null, call_start_date: rep.call_start_date ?? null }
    : null;
  extras.template = pip.template_id
    ? { id: pip.template_id, version: pip.template_version ?? null, name: null }
    : null;
  if (pip.template_id) {
    const t = await store.getPipTemplate(pip.template_id);
    if (t) extras.template = { id: t.id, version: pip.template_version ?? t.version, name: t.name };
  }
  return store.issuePip(String(input.pipId), { issuedBy: input.actor || "christopher", snapshotExtras: extras });
}

/** issued → completed (explicit manager action; requires conclusion category + notes). */
export async function completePipCore(
  store: Store,
  input: { pipId: string; conclusionCategory: string; conclusionNotes: string; actor?: string },
): Promise<PipRow> {
  return store.completePip(String(input.pipId), {
    conclusionCategory: String(input.conclusionCategory ?? ""),
    conclusionNotes: String(input.conclusionNotes ?? ""),
    actor: input.actor || "christopher",
  });
}

/** issued → cancelled (explicit manager action; requires a reason). */
export async function cancelPipCore(store: Store, input: { pipId: string; reason: string; actor?: string }): Promise<PipRow> {
  return store.cancelPip(String(input.pipId), { cancelledBy: input.actor || "christopher", reason: String(input.reason ?? "") });
}

/**
 * PHASE 4 — record the manager acknowledgment (no employee logins — the
 * manager records it during the acknowledgment meeting, owner directive
 * 9/30). Audited who/when via the store's pip_ack_recorded event + mirror;
 * the EXISTING ack_awaiting derivation clears as a pure consequence (stamped
 * column) — no second derivation path exists or is added.
 */
export async function recordPipAckCore(store: Store, input: { pipId: string; actor?: string }): Promise<PipRow> {
  return store.recordPipAck(String(input.pipId), { ackedBy: input.actor || "christopher" });
}

export interface AddCheckinInput {
  pipId: string;
  checkinDate: string;
  managerName?: string | null;
  employeeName?: string | null;
  currentPerformance?: string | null;
  topicsDiscussed?: string | null;
  coachingProvided?: string | null;
  employeeComments?: string | null;
  managerNotes?: string | null;
  nextActions?: string | null;
  nextCheckinDate?: string | null;
}

export async function addPipCheckinCore(store: Store, input: AddCheckinInput): Promise<PipCheckinRow> {
  return store.addPipCheckin({
    pip_id: String(input.pipId),
    checkin_date: String(input.checkinDate ?? ""),
    manager_name: input.managerName ?? null,
    employee_name: input.employeeName ?? null,
    current_performance: input.currentPerformance ?? null,
    topics_discussed: input.topicsDiscussed ?? null,
    coaching_provided: input.coachingProvided ?? null,
    employee_comments: input.employeeComments ?? null,
    manager_notes: input.managerNotes ?? null,
    next_actions: input.nextActions ?? null,
    next_checkin_date: input.nextCheckinDate ?? null,
  });
}

// ---------- templates ----------

export interface PipTemplateInput {
  name: string;
  category?: string | null;
  defaultGoalText?: string | null;
  defaultCheckinCadenceDays?: number | null;
  defaultDurationWeeks?: number | null;
  actor?: string;
}

export async function createPipTemplateCore(store: Store, input: PipTemplateInput): Promise<PipTemplateRow> {
  return store.createPipTemplate({
    name: String(input.name ?? ""),
    category: input.category ?? null,
    default_goal_text: input.defaultGoalText ?? null,
    default_checkin_cadence_days: input.defaultCheckinCadenceDays ?? null,
    default_duration_weeks: input.defaultDurationWeeks ?? null,
    created_by: input.actor || "christopher",
  });
}

export async function updatePipTemplateCore(store: Store, input: PipTemplateInput & { templateId: string }): Promise<PipTemplateRow> {
  return store.updatePipTemplate(String(input.templateId), {
    name: input.name,
    category: input.category,
    default_goal_text: input.defaultGoalText,
    default_checkin_cadence_days: input.defaultCheckinCadenceDays,
    default_duration_weeks: input.defaultDurationWeeks,
    actor: input.actor || "christopher",
  });
}

export async function deletePipTemplateCore(store: Store, templateId: string): Promise<void> {
  await store.deletePipTemplate(String(templateId));
}

export async function listPipTemplatesCore(store: Store): Promise<PipTemplateRow[]> {
  return store.listPipTemplates();
}

// ---------- TanStack Start wrappers (auto-gated by the start.ts middleware) ----------

/** Active roster reps for manager pickers (draft creation). */
export async function listRosterRepsCore(store: Store): Promise<{ id: string; name: string }[]> {
  const users = await store.getUsers();
  return users.map((u) => ({ id: u.id, name: u.name }));
}

export const getRosterReps = createServerFn().handler(async (): Promise<{ reps: { id: string; name: string }[] }> => {
  const store = await getStore();
  return { reps: await listRosterRepsCore(store) };
});

export const getPerformanceList = createServerFn()
  .validator((input: unknown) => (input ?? {}) as { status?: string })
  .handler(async (): Promise<PipLandingPayload> => performanceLandingCore(await getStore()));

export const getPipDetail = createServerFn()
  .validator((input: unknown) => input as { pipId: string })
  .handler(async ({ data }): Promise<PipDetail | null> => getPipDetailCore(await getStore(), String(data.pipId)));

export const getPerformanceHistory = createServerFn().handler(async (): Promise<PipHistoryPayload> =>
  getPerformanceHistoryCore(await getStore()),
);

/** Per-employee stitched PIP histories + weekly goal-met summaries (History segment "Employees" view). */
export const getPipRepHistories = createServerFn().handler(async (): Promise<PipRepHistoriesPayload> =>
  getPipRepHistoriesCore(await getStore()),
);

export const listPipTemplates = createServerFn().handler(async (): Promise<{ templates: PipTemplateRow[] }> => {
  const store = await getStore();
  return { templates: await store.listPipTemplates() };
});

/** Factual "In use" counts per template (issued/completed/cancelled PIPs). */
export const getPipTemplateUsage = createServerFn().handler(async (): Promise<{ usage: [string, number][] }> => {
  const store = await getStore();
  return { usage: Array.from((await store.getPipTemplateUsage()).entries()) };
});

/** Templates segment load (refinement spec §4): cards + in-use counts in one roundtrip. */
export const listPipTemplatesWithUsage = createServerFn().handler(
  async (): Promise<{ templates: PipTemplateRow[]; usage: [string, number][] }> => {
    const store = await getStore();
    const [templates, usage] = await Promise.all([store.listPipTemplates(), store.getPipTemplateUsage()]);
    return { templates, usage: Array.from(usage.entries()) };
  },
);

/**
 * LIVE evidence for a draft (the creation workflow renders it as the manager
 * edits rep + review period + goal). Deterministic: the same pipEvidenceCore
 * the issue path freezes — a draft's live evidence and its issued snapshot
 * come from ONE function.
 */
export const getPipEvidence = createServerFn()
  .validator((input: unknown) => input as { repId: string; reviewStart: string; reviewEnd: string; weeklyGoalMin: number | null; hardWeeklyMinimum?: boolean })
  .handler(async ({ data }): Promise<{ evidence: PipEvidence; statements: { key: string; text: string }[] }> => {
    const store = await getStore();
    const evidence = await pipEvidenceCore(store, {
      repId: String(data.repId),
      reviewStart: String(data.reviewStart),
      reviewEnd: String(data.reviewEnd),
      weeklyGoalMin: data.weeklyGoalMin == null ? null : Number(data.weeklyGoalMin),
      hardWeeklyMinimum: data.hardWeeklyMinimum === true,
    });
    return { evidence, statements: statementsFromEvidence(evidence) };
  });

export const createPipDraft = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as CreatePipDraftInput)
  .handler(async ({ data }) => createPipDraftCore(await getStore(), data));

export const updatePipDraft = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as UpdatePipDraftInput)
  .handler(async ({ data }) => updatePipDraftCore(await getStore(), data));

export const issuePip = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { pipId: string; actor?: string })
  .handler(async ({ data }) => issuePipCore(await getStore(), data));

export const completePip = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { pipId: string; conclusionCategory: string; conclusionNotes: string; actor?: string })
  .handler(async ({ data }) => completePipCore(await getStore(), data));

export const cancelPip = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { pipId: string; reason: string; actor?: string })
  .handler(async ({ data }) => cancelPipCore(await getStore(), data));

/** PHASE 4: record the manager acknowledgment (audited; clears the derived ack-pending state). */
export const recordPipAck = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { pipId: string; actor?: string })
  .handler(async ({ data }) => recordPipAckCore(await getStore(), data));

export const addPipCheckin = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as AddCheckinInput)
  .handler(async ({ data }) => addPipCheckinCore(await getStore(), data));

export const createPipTemplate = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as PipTemplateInput)
  .handler(async ({ data }) => createPipTemplateCore(await getStore(), data));

export const updatePipTemplate = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as PipTemplateInput & { templateId: string })
  .handler(async ({ data }) => updatePipTemplateCore(await getStore(), data));

export const deletePipTemplate = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { templateId: string })
  .handler(async ({ data }) => deletePipTemplateCore(await getStore(), String(data.templateId)));
