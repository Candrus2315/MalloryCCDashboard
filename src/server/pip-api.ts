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
  PipEvidenceSnapshotRow,
  PipRow,
  PipStatus,
  PipTemplateRow,
} from "./store/types";
import { isPipStatus } from "./store/types";

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

export interface PipDetail {
  pip: PipListItem;
  checkins: PipCheckinRow[];
  snapshots: Pick<PipEvidenceSnapshotRow, "id" | "version" | "created_by" | "created_at">[];
  events: PipEventRow[];
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
    events,
  };
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
  actor?: string;
}

export async function createPipDraftCore(store: Store, input: CreatePipDraftInput): Promise<PipRow> {
  const repId = String(input.repId ?? "").trim();
  if (!repId) throw new Error("Pick a rep for the PIP");
  const rep = (await store.getAllUsers()).find((u) => u.id === repId);
  if (!rep) throw new Error("Unknown rep — pick a rep from this database");
  return store.createPip({
    rep_id: repId,
    title: String(input.title ?? ""),
    goal_text: input.goalText ?? null,
    weekly_goal_min: input.weeklyGoalMin ?? null,
    hard_weekly_minimum: input.hardWeeklyMinimum === true,
    review_start_date: input.reviewStartDate ?? null,
    review_end_date: input.reviewEndDate ?? null,
    pip_start_date: input.pipStartDate ?? null,
    pip_end_date: input.pipEndDate ?? null,
    manager_observations: input.managerObservations ?? null,
    action_plan: input.actionPlan ?? [],
    personal_development_actions: input.personalDevelopmentActions ?? [],
    professional_development_actions: input.professionalDevelopmentActions ?? [],
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
    actor: input.actor || "christopher",
  });
}

/** draft → issued (explicit manager action; writes the frozen v1 evidence snapshot). */
export async function issuePipCore(store: Store, input: { pipId: string; actor?: string }): Promise<PipRow> {
  return store.issuePip(String(input.pipId), { issuedBy: input.actor || "christopher" });
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
  .handler(async ({ data }): Promise<{ pips: PipListItem[] }> => {
    const store = await getStore();
    const status = data.status && isPipStatus(data.status) ? (data.status as PipStatus) : null;
    return { pips: await listPipsCore(store, status) };
  });

export const getPipDetail = createServerFn()
  .validator((input: unknown) => input as { pipId: string })
  .handler(async ({ data }): Promise<PipDetail | null> => getPipDetailCore(await getStore(), String(data.pipId)));

export const getPerformanceEvents = createServerFn()
  .validator((input: unknown) => (input ?? {}) as { limit?: number })
  .handler(async ({ data }): Promise<{ events: PipEventRow[] }> => {
    const store = await getStore();
    return { events: await store.getPipEvents({ limit: data?.limit ?? 300 }) };
  });

export const listPipTemplates = createServerFn().handler(async (): Promise<{ templates: PipTemplateRow[] }> => {
  const store = await getStore();
  return { templates: await store.listPipTemplates() };
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
