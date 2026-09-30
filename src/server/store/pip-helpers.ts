/**
 * PIP GUARD + SHAPE HELPERS — shared by MemoryStore and PgStore so BOTH
 * implementations enforce the identical status model (the PR #18/#19 lesson:
 * store semantics must never live in only one implementation).
 *
 * STATUS MODEL (owner directive 9/30 — deterministic, manager-driven):
 *   draft     → document fully editable
 *   issued    → document FROZEN (evidence snapshot written once at issue);
 *               only check-ins are appended afterwards
 *   completed → fully immutable
 *   cancelled → fully immutable
 * Transitions: draft→issued, issued→completed, issued→cancelled. Nothing
 * auto-transitions; every transition is an explicit manager action.
 */
import type { PipCreateInput, PipDraftPatch, PipEventType, PipRow } from "./types";
import { normalizePipActionList } from "./types";

/** Fields a manager may edit while a PIP is a draft (the issued document is frozen). */
export const PIP_EDITABLE_FIELDS = [
  "rep_id",
  "title",
  "goal_text",
  "weekly_goal_min",
  "hard_weekly_minimum",
  "review_start_date",
  "review_end_date",
  "pip_start_date",
  "pip_end_date",
  "manager_observations",
  "action_plan",
  "personal_development_actions",
  "professional_development_actions",
] as const;

/** Guard: ET calendar dates are stored as YYYY-MM-DD text (or NULL). */
export function pipDateString(v: unknown, field: string): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`PIP ${field} must be a YYYY-MM-DD calendar date (got "${s}")`);
  }
  return s;
}

/** Guard: non-empty text (titles, goal text, conclusions, reasons). */
export function pipRequiredText(v: unknown, field: string, maxLen = 5000): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new Error(`PIP ${field} is required`);
  if (s.length > maxLen) throw new Error(`PIP ${field} exceeds ${maxLen} characters`);
  return s;
}

export function pipOptionalText(v: unknown, maxLen = 20000): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > maxLen) throw new Error(`PIP text exceeds ${maxLen} characters`);
  return s;
}

export function pipOptionalInt(v: unknown, field: string): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`PIP ${field} must be a non-negative integer (got "${String(v)}")`);
  }
  return n;
}

/** Build a full PIP row for creation — status is ALWAYS born 'draft'. */
export function buildPipRow(input: PipCreateInput, id: string, nowIso: string): PipRow {
  const repId = pipRequiredText(input.rep_id, "rep_id", 100);
  const title = pipRequiredText(input.title, "title", 300);
  return {
    id,
    rep_id: repId,
    title,
    status: "draft",
    goal_text: pipOptionalText(input.goal_text ?? null),
    weekly_goal_min: pipOptionalInt(input.weekly_goal_min ?? null, "weekly_goal_min"),
    hard_weekly_minimum: input.hard_weekly_minimum === true,
    review_start_date: pipDateString(input.review_start_date ?? null, "review_start_date"),
    review_end_date: pipDateString(input.review_end_date ?? null, "review_end_date"),
    pip_start_date: pipDateString(input.pip_start_date ?? null, "pip_start_date"),
    pip_end_date: pipDateString(input.pip_end_date ?? null, "pip_end_date"),
    manager_observations: pipOptionalText(input.manager_observations ?? null),
    action_plan: normalizePipActionList(input.action_plan ?? []),
    personal_development_actions: normalizePipActionList(input.personal_development_actions ?? []),
    professional_development_actions: normalizePipActionList(input.professional_development_actions ?? []),
    conclusion_category: null,
    conclusion_notes: null,
    issued_at: null,
    issued_by: null,
    completed_at: null,
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason: null,
    employee_visible: false,
    current_version: 1,
    employee_acked_at: null,
    employee_acked_by: null,
    manager_acked_at: null,
    manager_acked_by: null,
    created_by: input.created_by ? String(input.created_by).trim() || null : null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

export interface PipDraftPatchResult {
  next: PipRow;
  /** Names of document fields actually changed (audit trail). */
  changed: string[];
  /** Previous manager_observations when that field changed (before/after audit). */
  observationsBefore: string | null;
}

/**
 * Apply a draft patch onto a draft row. Only PIP_EDITABLE_FIELDS apply; the
 * status/issue/conclusion/ack/version columns are NOT patchable through this
 * path (their own transition methods own them — and only from the exact
 * allowed prior status).
 */
export function applyPipDraftPatch(row: PipRow, patch: PipDraftPatch): PipDraftPatchResult {
  if (row.status !== "draft") {
    throw new Error(
      `Only DRAFT PIPs are editable — this PIP is "${row.status}" (the issued document is frozen; use check-ins or a later-phase amendment)`,
    );
  }
  const next: PipRow = { ...row };
  const changed: string[] = [];
  const bump = (field: (typeof PIP_EDITABLE_FIELDS)[number], value: unknown) => {
    const before = JSON.stringify((row as Record<string, unknown>)[field] ?? null);
    const after = JSON.stringify(value ?? null);
    if (before !== after) changed.push(field);
    (next as Record<string, unknown>)[field] = value;
  };

  if (patch.rep_id !== undefined) bump("rep_id", pipRequiredText(patch.rep_id, "rep_id", 100));
  if (patch.title !== undefined) bump("title", pipRequiredText(patch.title, "title", 300));
  if (patch.goal_text !== undefined) bump("goal_text", pipOptionalText(patch.goal_text));
  if (patch.weekly_goal_min !== undefined) bump("weekly_goal_min", pipOptionalInt(patch.weekly_goal_min, "weekly_goal_min"));
  if (patch.hard_weekly_minimum !== undefined) bump("hard_weekly_minimum", patch.hard_weekly_minimum === true);
  if (patch.review_start_date !== undefined) bump("review_start_date", pipDateString(patch.review_start_date, "review_start_date"));
  if (patch.review_end_date !== undefined) bump("review_end_date", pipDateString(patch.review_end_date, "review_end_date"));
  if (patch.pip_start_date !== undefined) bump("pip_start_date", pipDateString(patch.pip_start_date, "pip_start_date"));
  if (patch.pip_end_date !== undefined) bump("pip_end_date", pipDateString(patch.pip_end_date, "pip_end_date"));
  if (patch.manager_observations !== undefined) bump("manager_observations", pipOptionalText(patch.manager_observations));
  if (patch.action_plan !== undefined) bump("action_plan", normalizePipActionList(patch.action_plan));
  if (patch.personal_development_actions !== undefined)
    bump("personal_development_actions", normalizePipActionList(patch.personal_development_actions));
  if (patch.professional_development_actions !== undefined)
    bump("professional_development_actions", normalizePipActionList(patch.professional_development_actions));

  const observationsBefore = changed.includes("manager_observations") ? row.manager_observations : null;
  return { next, changed, observationsBefore };
}

/** draft → issued requirements: goal text + start/end dates (owner rule). */
export function assertIssueRequirements(row: PipRow): void {
  if (row.status !== "draft") {
    throw new Error(`Only DRAFT PIPs can be issued — this PIP is "${row.status}"`);
  }
  if (!row.goal_text || !row.goal_text.trim()) throw new Error("A PIP cannot be issued without goal_text");
  if (!row.pip_start_date) throw new Error("A PIP cannot be issued without pip_start_date");
  if (!row.pip_end_date) throw new Error("A PIP cannot be issued without pip_end_date");
  if (row.pip_end_date < row.pip_start_date) {
    throw new Error(`PIP pip_end_date (${row.pip_end_date}) cannot precede pip_start_date (${row.pip_start_date})`);
  }
}

/** issued → completed requirements: manager's conclusion category + notes. */
export function assertCompleteRequirements(row: PipRow, conclusionCategory: unknown, conclusionNotes: unknown): { category: string; notes: string } {
  if (row.status !== "issued") {
    throw new Error(`Only ISSUED PIPs can be completed — this PIP is "${row.status}"`);
  }
  const category = pipRequiredText(conclusionCategory, "conclusion_category", 120);
  const notes = pipRequiredText(conclusionNotes, "conclusion_notes", 20000);
  return { category, notes };
}

/** issued → cancelled requirements: a recorded reason (why the PIP ended without completion). */
export function assertCancelRequirements(row: PipRow, reason: unknown): string {
  if (row.status !== "issued") {
    throw new Error(`Only ISSUED PIPs can be cancelled — this PIP is "${row.status}"`);
  }
  return pipRequiredText(reason, "cancellation_reason", 20000);
}

/** Check-ins are append-only and only exist while the review is LIVE (issued). */
export function assertCheckinAllowed(row: PipRow): void {
  if (row.status !== "issued") {
    throw new Error(`Check-ins are only allowed on ISSUED PIPs — this PIP is "${row.status}"`);
  }
}

/** Audit-truncation: keep before/after values readable in the log. */
export function pipAuditValue(v: string | null | undefined, max = 200): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * The compact manual_overrides mirror written for EVERY pip event, so the
 * existing Settings → Audit page shows PIP actions too (the typed event log
 * in pip_event_log remains the module's primary audit trail).
 */
export function pipEventToManualOverride(
  event: PipEventType,
  ctx: { entityId: string; field: string | null; previousValue: string | null; newValue: string | null; actor: string | null },
): { entity_type: string; entity_id: string; field: string; previous_value: string | null; new_value: string; changed_by: string } {
  return {
    entity_type: event.startsWith("pip_template") ? "pip_template" : "pip",
    entity_id: ctx.entityId,
    field: ctx.field ?? event,
    previous_value: ctx.previousValue ?? "—",
    new_value: ctx.newValue ?? "—",
    changed_by: ctx.actor || "christopher",
  };
}
