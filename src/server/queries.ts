/**
 * Page-facing data layer. Every page gets its numbers from these server
 * functions, which load raw rows and hand them to the metrics layer — no page
 * computes its own numbers.
 *
 * IMPORT DISCIPLINE: `vite build` does NOT type-check. A name used here but
 * never imported compiles cleanly and only throws `ReferenceError` when the
 * loader runs on the published server (dev and `bun test` never execute every
 * loader, so it hides). See src/server/__tests__/typecheck.test.ts — it fails
 * on any "Cannot find name" (TS2304-class) error. If you reference a helper,
 * import it from its module (date-logic/metrics/compute) in the same commit.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  addDays,
  dateRange,
  etDayEndUtc,
  etDayStartUtc,
  etRangeBounds,
  etToday,
  formatDateHuman,
  formatDateHumanFull,
  isHistoricalWeek,
  isRangeMode,
  mondaysInRange,
  OPERATIONAL_TIMEZONE,
  repOperatingState,
  resolveRange,
  weekStart,
  type RangeMode,
} from "./date-logic";
import {
  type RepGoalInfo,
  appointmentPaymentStateOf,
  bookingAttributionSplit,
  buildTeamRangeMetrics,
  buildTeamTrends,
  buildUnattributedQueue,
  repRangeSummaries,
  resolveRepGoal,
} from "./metrics/compute";
import { getStore } from "./store";
import { withDbRetry } from "./store/pg-retry";
import type { Store } from "./store/types";
import { availabilityPageData, type AvailabilityViewRawSearch, commissionPageData, commissionValidationPageData, dailyReportPageData, repsPageData, teamPageData, todayPageData, weeklyPageData } from "./page-data";
import { resolveAvailabilityViewArgs } from "./availability-wiring";
import { getRequest } from "@tanstack/react-start/server";
import { matchAppointmentsToCalls } from "./metrics/attribution";
import { appointmentInScope } from "./metrics/availability";
import { WEEKLY_CC_SECTIONS, addMonthsKey, monthKeyLabel, monthKeyOf } from "./metrics/weekly";
import {
  applyAttributionEligibility,
  applyRosterEligibility,
  buildRosterEligibility,
} from "./roster";
import { buildCallOwnershipBuckets } from "~/components/reps-views";
import { ensureDemoData } from "./sync/run";
import type { AuditOkBody } from "./audit-api";
import { isSheetMappingMode } from "./sync/sheets-mapping";
import { normalizeRepMappings, SETTINGS_OWNER_ACTOR, type AppSettings, type RepMapping } from "./store/types";
import { applyCommissionCorrection, assignCommissionWeeks, submitCommissionCycle, transitionCommissionCycle, unassignCommissionWeeks, type CommissionCycleStatus, type CorrectionKind } from "./commission/lifecycle";

export interface PageMeta {
  mode: "postgres" | "memory";
  dbReason: string | null;
  today: string;
  demoSeeded: boolean;
}

async function loadPageMeta(): Promise<PageMeta> {
  const seeded = await ensureDemoData();
  const { getDbStatus } = await import("./store");
  const status = getDbStatus();
  return { mode: seeded.mode, dbReason: status.ok ? null : status.reason, today: etToday(), demoSeeded: seeded.seeded };
}

/** TODAY page — payload built in page-data.ts todayPageData (PageDeps test seam). */
export const getTodayData = createServerFn().handler(() => withDbRetry(() => todayPageData()));

/** SETTINGS page data — every editable surface loads its rows here. */
export const getSettingsData = createServerFn().handler(() => withDbRetry(async () => {
  const store = await getStore();
  const today = etToday();
  const ws = weekStart(today);
  // PERF: meta (demo-seed guard) + settings were two sequential round trips
  // before the batch; both are independent of it — run them INSIDE the batch.
  const metaPromise: Promise<PageMeta> = loadPageMeta();
  const settingsPromise = store.getSettings();

  // Week-list editor window: two past weeks, current, six future.
  const editorWeeks = Array.from({ length: 9 }, (_, i) => addDays(weekStart(today), 7 * (i - 2)));
  const week = dateRange(ws, addDays(ws, 6));

  const [meta, settings, teamGoals, connections, runs, overrides, users, repGoalsByWeekRows, leadAdjustments, weekLeads, apptsWindow, callsWindow, contacts, attributions, blockedWindow, allUsers, monthlyGoalCurrent, monthlyGoalNext] =
    await Promise.all([
      metaPromise,
      settingsPromise,
      store.getTeamGoals(),
      store.getConnections(),
      store.getSyncRuns(12),
      store.getManualOverrides(40),
      store.getUsers(),
      Promise.all(editorWeeks.map((w) => store.getRepGoals(w))),
      store.getLeadCountAdjustments(week),
      store.getLeadsByWorkDates(dateRange(addDays(today, -7), today)),
      store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
      store.getAllCallsSince(etDayStartUtc(addDays(today, -30))),
      // PERF: identity slice only (id/phone/email/assigned_rep_id) — the full
      // 18-column getContacts() materialized ~116k rows (~1s remote transfer)
      // for consumers that read exactly these four fields.
      store.getContactIdentityRows(),
      store.getAttributions(),
      store.getBlockedTimesBetween(etDayStartUtc(addDays(today, -7)), etDayEndUtc(addDays(today, 30))),
      // ALL users (roster + non-roster) — the Roster Mapping panel lists the
      // non-roster HighLevel users actually seen in calls.
      store.getAllUsers(),
      // MONTHLY BOOKING GOAL editor rows: THIS month + next, exact 'YYYY-MM'
      // keys — a month never inherits another month's goal.
      store.getMonthlyGoal(monthKeyOf(today)),
      store.getMonthlyGoal(addMonthsKey(monthKeyOf(today), 1)),
    ]);

  const repGoalsByWeek: Record<string, { rep_id: string; goal: number }[]> = {};
  editorWeeks.forEach((w, i) => {
    repGoalsByWeek[w] = repGoalsByWeekRows[i].map((g) => ({ rep_id: g.rep_id, goal: g.goal }));
  });
  const goalByWeek = new Map(teamGoals.map((g) => [g.week_start, g]));

  // Unattributed bookings queue — composed via the metrics layer, never guessed.
  // OWNER DIRECTIVE: only in-scope Acuity calendars/types feed the queue (the
  // same appointmentInScope rule every booking-feeding read applies — Zoom
  // bookings never enter attribution), and the SAME pure engine run supplies
  // each row's honest unattributed reason.
  const scopedAppts = apptsWindow.filter((a) => appointmentInScope(a, settings.acuity));
  const engineMatches = matchAppointmentsToCalls(
    scopedAppts,
    callsWindow,
    contacts.map((c) => ({ id: c.id, phone: c.phone, email: c.email })),
    {
      meeting_threshold_seconds: settings.meaningful_call_threshold_seconds,
      attribution_window_hours: settings.attribution_window_hours,
      rep_mappings: settings.rep_mappings,
    },
    { today, users: allUsers.map((u) => ({ id: u.id, is_active: u.is_active })) },
  );
  const unattributed = buildUnattributedQueue({
    appointments: scopedAppts,
    attributions,
    calls: callsWindow,
    contacts: contacts.map((c) => ({ id: c.id, phone: c.phone, email: c.email, assigned_rep_id: c.assigned_rep_id })),
    thresholdSeconds: settings.meaningful_call_threshold_seconds,
    matches: engineMatches,
  });

  // THREE-WAY ATTRIBUTION SPLIT (owner directive 2026-09-27, S5b) — read off
  // the STORED attribution states over the same in-scope booking set the
  // engine evaluated: Total = Attributed + Ambiguous + Unattributed (+ any
  // booking without a verdict row, surfaced separately). Ambiguous is its own
  // state here — never folded into Unattributed.
  const attributionSplit = bookingAttributionSplit(scopedAppts, attributions);

  // Observed per-date lead counts (before adjustments) for the count editor.
  const observedCounts = week.flatMap((d) => {
    return (["family", "animalia"] as const).map((sheet) => {
      const observed = weekLeads.filter((l) => l.work_date === d && l.source_sheet === sheet).length;
      const prior = leadAdjustments.find((a) => a.work_date === d && a.sheet === sheet);
      return { date: d, sheet, observed, adjustedDelta: prior ? prior.delta : null };
    });
  });

  // Roster Mapping panel: non-roster HighLevel users seen in the last 30 days
  // of calls, with call counts (calls carry the RAW HL user id — immutable).
  const activeIds = new Set(users.map((u) => u.id));
  const callsByExternalId = new Map<string, number>();
  for (const c of callsWindow) {
    const ext = c.provider_rep_external_id;
    if (!ext) continue;
    callsByExternalId.set(ext, (callsByExternalId.get(ext) ?? 0) + 1);
  }
  const nonRosterUsers = allUsers
    .filter((u) => !u.is_active && !activeIds.has(u.id))
    .map((u) => ({
      externalId: u.external_id,
      name: u.name,
      callCount: callsByExternalId.get(u.external_id) ?? 0,
      mappedTo: (settings.rep_mappings ?? []).find((m) => m.external_user_id === u.external_id)?.rep_id ?? null,
    }))
    .sort((a, b) => b.callCount - a.callCount || a.name.localeCompare(b.name));

  const { isPassphraseConfigured } = await import("./auth");
  return {
    meta,
    settings,
    passphraseConfigured: isPassphraseConfigured(),
    weekStart: ws,
    today,
    monthlyGoals: [monthlyGoalCurrent, monthlyGoalNext].map((row, i) => ({
      month: addMonthsKey(monthKeyOf(today), i),
      label: monthKeyLabel(addMonthsKey(monthKeyOf(today), i)),
      isCurrent: i === 0,
      goal: row?.goal ?? null,
    })),
    editorWeeks: editorWeeks.map((w) => ({
      weekStart: w,
      isCurrent: w === ws,
      label: `${formatDateHuman(w)} – ${formatDateHuman(addDays(w, 6))}`,
      goal: goalByWeek.get(w)?.booking_goal ?? null,
      leadBudget: goalByWeek.get(w)?.lead_budget ?? null,
    })),
    users: users.map((u) => ({ id: u.id, name: u.name, call_start_date: u.call_start_date })),
    repCount: users.length,
    repGoalsByWeek,
    repMappings: settings.rep_mappings ?? [],
    nonRosterUsers,
    connections: serializableConnections(connections),
    syncRuns: runs,
    overrides,
    unattributed,
    attributionSplit,
    observedCounts,
    leadAdjustments,
    // lead work-date editor: recent cohort rows with ids (work-date + origin)
    recentLeads: weekLeads
      .slice(0, 200)
      .map((l) => ({ id: l.id, lead_type: l.lead_type, source_sheet: l.source_sheet, source_date: l.source_date, work_date: l.work_date }))
      .sort((a, b) => (a.work_date < b.work_date ? 1 : a.work_date > b.work_date ? -1 : 0)),
    blockedTimes: blockedWindow,
    staleWarnings: syncStaleWarnings(connections),
  };
}));

/** integration_connections in a fully serializable shape (config → note string). */
export function serializableConnections(connections: { provider: string; status: string; is_demo: boolean; last_sync_at: string | null; last_successful_sync_at: string | null; last_error: string | null; config: Record<string, unknown> }[]) {
  return connections.map((c) => ({
    provider: c.provider,
    status: c.status,
    is_demo: c.is_demo,
    last_sync_at: c.last_sync_at,
    last_successful_sync_at: c.last_successful_sync_at,
    last_error: c.last_error,
    configNote: typeof c.config?.note === "string" ? c.config.note : "",
  }));
}

/** Human-readable stale-data warnings from integration_connections — shared by every page. */
export function syncStaleWarnings(connections: { provider: string; status: string; last_successful_sync_at: string | null; last_error?: string | null; config?: Record<string, unknown> | null }[]): string[] {
  const out: string[] = [];
  const LABELS: Record<string, string> = { highlevel: "HighLevel", acuity: "Acuity", google_sheets: "Google Sheets" };
  for (const c of connections) {
    if (!["highlevel", "acuity", "google_sheets"].includes(c.provider)) continue;
    const label = LABELS[c.provider] ?? c.provider;
    if (c.status === "error") out.push(`${label} reported a sync error — its numbers may be incomplete; check the Sync Center in Settings.`);
    else if (c.status === "connected" && c.last_error) out.push(`${label} synced partially — some sheets/sources failed (see Settings → Sync Center); its numbers may be incomplete.`);
    else if (!c.last_successful_sync_at) out.push(`${label} has never synced successfully — run SYNC NOW in Settings.`);
    // S4 contacts-reconciliation tripwire (every-tick meta.total vs DB count):
    // warn ONLY on a real measured drift — written by the scheduler tick into
    // the connection config (warn=true ⇒ the numbers below are measured).
    if (c.provider === "highlevel" && c.status === "connected") {
      const recon = (c.config?.contactsReconciliation ?? null) as { warn?: boolean; sourceTotal?: number | null; dbCount?: number | null } | null;
      if (recon?.warn === true) {
        out.push(`Contact coverage: HighLevel reports ${recon.sourceTotal ?? "?"} contacts, dashboard holds ${recon.dbCount ?? "?"} — run SYNC NOW in Settings to catch up.`);
      }
    }
  }
  return out;
}

const PROVIDER_DATA_LABELS: Record<string, string> = {
  highlevel: "HighLevel calls",
  acuity: "Acuity bookings",
  google_sheets: "Google Sheets leads",
};

/**
 * Provider-aware honesty line for the Today banner: which data is live,
 * live-but-degraded (real data, transient sync error), or demo, e.g.
 * "Live: Google Sheets leads · Live — last sync error, numbers as of 14:42 ET,
 * retrying: HighLevel calls · Demo: Acuity bookings". Null when nothing has
 * synced yet (other banner clauses cover it).
 *
 * Buckets on is_demo, NEVER on status: real data whose sync hit a transient
 * error (status error/pending, is_demo=false) is still live store data —
 * labeling it "Demo" is false and alarms the owner. The per-provider error
 * detail stays in syncStaleWarnings; this line stays one short clause.
 */
export function demoAwarenessLine(connections: { provider: string; status: string; is_demo: boolean; last_successful_sync_at?: string | null }[]): string | null {
  const live: string[] = [];
  const demo: string[] = [];
  const degraded: string[] = [];
  for (const c of connections) {
    const label = PROVIDER_DATA_LABELS[c.provider];
    if (!label) continue;
    if (c.is_demo) demo.push(label);
    else if (c.status === "connected") live.push(label);
    else degraded.push(label);
  }
  if (live.length === 0 && demo.length === 0 && degraded.length === 0) return null;
  // Degraded = real (is_demo=false) data whose last sync attempt failed. The
  // banner dates the numbers by the last SUCCESSFUL sync so the owner can
  // trust what they are reading; no timestamp means no successful sync ever,
  // so "pending" is the only honest word.
  const byLabel = new Map(connections.map((c) => [PROVIDER_DATA_LABELS[c.provider], c] as const));
  const degradedClause = (label: string): string => {
    const raw = byLabel.get(label)?.last_successful_sync_at;
    const ms = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ms)) return `Live — last sync incomplete, numbers pending: ${label}`;
    const clock = new Intl.DateTimeFormat("en-US", {
      timeZone: OPERATIONAL_TIMEZONE,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
    return `Live — last sync error, numbers as of ${clock} ET, retrying: ${label}`;
  };
  if (degraded.length === 0) {
    if (live.length === 0) return `Demo data: ${demo.join(", ")} — live integrations pending`;
    if (demo.length === 0) return `Live: ${live.join(", ")}`;
    return `Live: ${live.join(", ")} · Demo: ${demo.join(", ")}`;
  }
  const parts: string[] = [];
  if (live.length) parts.push(`Live: ${live.join(", ")}`);
  parts.push(...degraded.map(degradedClause));
  if (demo.length) parts.push(`Demo: ${demo.join(", ")}`);
  return parts.join(" · ");
}

/** Save core operational settings (threshold + attribution window). */
export const saveSettings = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { thresholdSeconds?: number; windowHours?: number })
  .handler(async ({ data }) => {
    const store = await getStore();
    const patch: Partial<AppSettings> = {};
    if (typeof data.thresholdSeconds === "number" && data.thresholdSeconds > 0) patch.meaningful_call_threshold_seconds = Math.floor(data.thresholdSeconds);
    if (typeof data.windowHours === "number" && data.windowHours > 0) patch.attribution_window_hours = data.windowHours;
    if (Object.keys(patch).length) await store.saveSettings(patch);
    return { ok: true };
  });

/** Save one week's team booking goal + lead budget, with an audit row per changed field. */
export const saveWeekGoal = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { weekStart: string; bookingGoal: number; leadBudget: number })
  .handler(async ({ data }) => {
    const store = await getStore();
    const weekStart = String(data.weekStart);
    const bookingGoal = Math.max(0, Math.floor(Number(data.bookingGoal) || 0));
    const leadBudget = Math.max(0, Math.floor(Number(data.leadBudget) || 0));
    const prev = await store.getTeamGoal(weekStart);
    await store.upsertTeamGoal({ week_start: weekStart, booking_goal: bookingGoal, lead_budget: leadBudget });
    const changes: [string, string, string][] = [];
    if ((prev?.booking_goal ?? null) !== bookingGoal) {
      changes.push(["booking_goal", String(prev?.booking_goal ?? "unset"), String(bookingGoal)]);
    }
    if ((prev?.lead_budget ?? null) !== leadBudget) {
      changes.push(["lead_budget", String(prev?.lead_budget ?? "unset"), String(leadBudget)]);
    }
    for (const [field, previous, next] of changes) {
      await store.insertManualOverride({
        entity_type: "team_goal",
        entity_id: weekStart,
        field,
        previous_value: previous,
        new_value: next,
        changed_by: "christopher",
      });
    }
    return { ok: true, changed: changes.length };
  });

/**
 * OWNER ROSTER MAPPINGS (design/data-terminology.md): map a non-roster
 * HighLevel user to a CC rep. From then on ALL historical calls under that HL
 * user id are eligible AT QUERY TIME for the rep's performance and CC team
 * totals — source records are never rewritten (eligibility, not mutation).
 * Replaces the whole mapping list; entries pointing outside the active roster
 * are inert (filtered by buildRosterEligibility).
 */
export const saveRepMappings = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { mappings: RepMapping[] })
  .handler(async ({ data }) => {
    const store = await getStore();
    const settings = await store.getSettings();
    const mappings = normalizeRepMappings(data?.mappings ?? []);
    const prev = settings.rep_mappings ?? [];
    await store.saveSettings({ rep_mappings: mappings });
    // audit trail: every added/removed HL user id, never the raw call data
    const prevKeys = new Set(prev.map((m) => m.external_user_id));
    const nextKeys = new Set(mappings.map((m) => m.external_user_id));
    const repName = new Map((await store.getUsers()).map((u) => [u.id, u.name]));
    for (const m of mappings) {
      if (!prevKeys.has(m.external_user_id)) {
        await store.insertManualOverride({
          entity_type: "rep_mapping",
          entity_id: m.external_user_id,
          field: "mapped_rep",
          previous_value: null,
          new_value: repName.get(m.rep_id) ?? m.rep_id,
          changed_by: "christopher",
        });
      }
    }
    for (const p of prev) {
      if (!nextKeys.has(p.external_user_id)) {
        await store.insertManualOverride({
          entity_type: "rep_mapping",
          entity_id: p.external_user_id,
          field: "mapped_rep",
          previous_value: repName.get(p.rep_id) ?? p.rep_id,
          new_value: "removed",
          changed_by: "christopher",
        });
      }
    }
    return { ok: true, count: mappings.length };
  });

/** Rep activation dates (call_start_date) — Settings editor, audited per rep. */
export const saveRepStartDates = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { entries: { repId: string; date: string | null }[] })
  .handler(async ({ data }) => {
    const store = await getStore();
    const repName = new Map((await store.getUsers()).map((u) => [u.id, u.name]));
    for (const e of data?.entries ?? []) {
      const repId = String(e.repId);
      const raw = e.date == null || String(e.date).trim() === "" ? null : String(e.date);
      if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`Invalid date for ${repName.get(repId) ?? repId} — expected YYYY-MM-DD`);
      const all = await store.getAllUsers();
      const previous = all.find((u) => u.id === repId)?.call_start_date ?? null;
      if ((previous ?? null) === raw) continue;
      await store.setUserCallStartDate(repId, raw);
      await store.insertManualOverride({
        entity_type: "rep_call_start_date",
        entity_id: repId,
        field: `call_start_date:${repName.get(repId) ?? repId}`,
        previous_value: previous ?? "unset",
        new_value: raw ?? "unset",
        changed_by: "christopher",
      });
    }
    return { ok: true };
  });

/**
 * Per-rep goals for one week. goal <= 0 (or null) = unset → the row is deleted
 * so the team-share fallback is authoritative again.
 */
export const saveRepGoals = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { weekStart: string; goals: { repId: string; goal: number | null }[] })
  .handler(async ({ data }) => {
    const store = await getStore();
    const weekStart = String(data.weekStart);
    const prevRows = new Map((await store.getRepGoals(weekStart)).map((g) => [g.rep_id, g.goal]));
    const toUpsert: { rep_id: string; week_start: string; goal: number }[] = [];
    const toDelete: string[] = [];
    const audits: { entityId: string; field: string; previous: string; next: string }[] = [];
    const repName = new Map((await store.getUsers()).map((u) => [u.id, u.name]));
    for (const g of data.goals ?? []) {
      const repId = String(g.repId);
      const goal = g.goal == null ? 0 : Math.floor(Number(g.goal));
      const prev = prevRows.get(repId);
      if (goal > 0) {
        toUpsert.push({ rep_id: repId, week_start: weekStart, goal });
        if ((prev ?? null) !== goal) {
          audits.push({ entityId: repId, field: `rep_goal:${repName.get(repId) ?? repId}`, previous: prev != null ? String(prev) : "unset (team share)", next: String(goal) });
        }
      } else {
        toDelete.push(repId);
        if (prev != null) {
          audits.push({ entityId: repId, field: `rep_goal:${repName.get(repId) ?? repId}`, previous: String(prev), next: "unset (team share)" });
        }
      }
    }
    if (toUpsert.length) await store.upsertRepGoals(toUpsert);
    for (const repId of toDelete) await store.deleteRepGoal(repId, weekStart);
    for (const a of audits) {
      await store.insertManualOverride({
        entity_type: "rep_goal",
        entity_id: a.entityId,
        field: a.field,
        previous_value: a.previous,
        new_value: a.next,
        changed_by: "christopher",
      });
    }
    return { ok: true };
  });

/**
 * Per-MONTH booking goals (owner-approved 2026-09-29). goal <= 0 (or null) =
 * unset → the row is deleted so the month honestly renders "—" (months never
 * inherit: October does not fall back to September's goal). Audit row per
 * changed month, saveWeekGoal convention.
 */
export const saveMonthlyGoals = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { goals: { month: string; goal: number | null }[] })
  .handler(async ({ data }) => {
    const store = await getStore();
    const audits: { entityId: string; previous: string; next: string }[] = [];
    for (const g of data.goals ?? []) {
      const month = String(g.month);
      const goal = g.goal == null ? 0 : Math.floor(Number(g.goal));
      if (!/^\d{4}-\d{2}$/.test(month)) continue; // never write a malformed month key
      const prev = await store.getMonthlyGoal(month);
      const prevGoal = prev?.goal ?? null;
      if (goal > 0) {
        if (prevGoal !== goal) {
          await store.upsertMonthlyGoal({ month, goal });
          audits.push({ entityId: month, previous: prevGoal != null ? String(prevGoal) : "unset", next: String(goal) });
        }
      } else if (prev) {
        await store.deleteMonthlyGoal(month);
        audits.push({ entityId: month, previous: String(prevGoal), next: "unset" });
      }
    }
    for (const a of audits) {
      await store.insertManualOverride({
        entity_type: "monthly_goal",
        entity_id: a.entityId,
        field: "monthly_booking_goal",
        previous_value: a.previous,
        new_value: a.next,
        changed_by: "christopher",
      });
    }
    return { ok: true, changed: audits.length };
  });

/**
 * Save the CC Report narrative for ONE report week (week_start Monday key) —
 * the Big-3 save pattern at week grain: trim, empty → unset (row field
 * removed), audit row per CHANGED section. Section keys are the stable
 * WEEKLY_CC_SECTIONS ids; unknown keys are ignored so a stale client cannot
 * inject arbitrary jsonb fields.
 */
export const saveWeeklyReportNotes = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { weekStart: string; notes: Record<string, string | null> })
  .handler(async ({ data }) => {
    const store = await getStore();
    const weekStart = String(data.weekStart);
    const knownKeys = new Set(WEEKLY_CC_SECTIONS.map((s) => s.key));
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(data.notes ?? {})) {
      if (!knownKeys.has(key)) continue;
      const text = (value ?? "").trim();
      if (text) clean[key] = text;
    }
    const prevRow = await store.getWeeklyReportNotes(weekStart);
    const prev = prevRow?.notes ?? {};
    await store.upsertWeeklyReportNotes({ week_start: weekStart, notes: clean });
    for (const section of WEEKLY_CC_SECTIONS) {
      const before = prev[section.key] ?? "";
      const after = clean[section.key] ?? "";
      if (before !== after) {
        await store.insertManualOverride({
          entity_type: "weekly_report_notes",
          entity_id: weekStart,
          field: section.key,
          previous_value: before,
          new_value: after,
          changed_by: "christopher",
        });
      }
    }
    return { ok: true };
  });

/** Sheet column mapping (persisted to app_settings). */
export const saveSheetMapping = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { sheet: "family" | "animalia"; columns: Record<string, string>; mode?: string })
  .handler(async ({ data }) => {
    const store = await getStore();
    const sheet = data.sheet === "animalia" ? "animalia" : "family";
    const settings = await store.getSettings();
    const columns: Record<string, string> = { ...settings.sheets[sheet].columns, ...data.columns };
    const mode = isSheetMappingMode(data.mode) ? data.mode : settings.sheets[sheet].mode;
    // Owner-driven Settings save → the write is owner-labeled, so a mode the
    // owner picks is honored; the store audits any mode change (old → new,
    // this actor) — consistent with saveWeekGoal/saveRepMappings.
    await store.saveSettings({ sheets: { ...settings.sheets, [sheet]: { ...settings.sheets[sheet], columns, mode } } }, SETTINGS_OWNER_ACTOR);
    return { ok: true, columns, mode };
  });

/**
 * "Test mapping" — fetches a REAL sample row from the sheet live (Sheets API)
 * and runs it through the exact parse a live sync uses; nothing persisted.
 * Falls back to the demo sample (clearly labeled) when the Sheets API isn't
 * reachable yet — the actionable live error is returned either way.
 */
export const testSheetMapping = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { sheet: "family" | "animalia"; columns: Record<string, string>; mode?: string })
  .handler(async ({ data }) => {
    const { applySheetMapping, sampleSheetRow } = await import("./sync/adapters");
    const { parseSheetDate } = await import("./sync/sheets-mapping");
    const { fetchSheetSampleLive } = await import("./sync/sheets-live");
    const { getWorkDate } = await import("./date-logic");
    const sheet = data.sheet === "animalia" ? "animalia" : "family";
    const store = await getStore();
    const settings = await store.getSettings();
    const mode = isSheetMappingMode(data.mode) ? data.mode : settings.sheets[sheet].mode;
    let sample: { header: string[]; rows: string[][]; tab?: string; notice?: string | null };
    let source: "live" | "demo-fallback" = "demo-fallback";
    let liveError: string | null = null;
    try {
      sample = await fetchSheetSampleLive(settings.sheets[sheet].sheet_id);
      source = "live";
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e);
      sample = sampleSheetRow(sheet);
    }
    const row = sample.rows[0] ?? [];
    const result = applySheetMapping(row, data.columns ?? {}, mode);
    // show the work-date consequence of the parsed source_date (SPEC lead logic)
    const sourceDate = result.parsed.source_date ? parseSheetDate(result.parsed.source_date) : null;
    const workDate = sourceDate ? getWorkDate(sourceDate) : null;
    return { sample, result, workDate, sourceDate, source, liveError, mode };
  });

/** Acuity calendars / appointment types counted toward CC reporting. */
export const saveAcuityScope = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { calendars: string[]; types: string[] })
  .handler(async ({ data }) => {
    const store = await getStore();
    await store.saveSettings({
      acuity: { calendars_included: data.calendars ?? [], types_included: data.types ?? [] },
    });
    return { ok: true };
  });

/** Studio slot rules + weekly hours (mirrored into availability_rules). */
export const saveStudioRules = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as {
    durationMin?: number;
    slotIntervalMin?: number;
    paddingMin?: number;
    hours?: { weekday: number; open_time: string; close_time: string; active: boolean }[];
  })
  .handler(async ({ data }) => {
    const store = await getStore();
    const settings = await store.getSettings();
    const studio = { ...settings.studio };
    if (typeof data.durationMin === "number" && data.durationMin > 0) studio.appointment_duration_min = Math.floor(data.durationMin);
    if (typeof data.slotIntervalMin === "number" && data.slotIntervalMin > 0) studio.slot_interval_min = Math.floor(data.slotIntervalMin);
    if (typeof data.paddingMin === "number" && data.paddingMin >= 0) studio.padding_min = Math.floor(data.paddingMin);
    if (data.hours) studio.hours = data.hours;
    await store.saveSettings({ studio });
    if (data.hours) await store.upsertAvailabilityRules(data.hours);
    return { ok: true };
  });

/** Weekly recurring blocked-time pattern (Settings CRUD). */
export const saveRecurringBlocks = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as {
    blocks: { id: string; weekday: number; start_time: string; end_time: string; reason: string | null; active: boolean }[];
  })
  .handler(async ({ data }) => {
    const store = await getStore();
    const settings = await store.getSettings();
    await store.saveSettings({
      studio: { ...settings.studio, recurring_blocks: (data.blocks ?? []).map((b) => ({ ...b, reason: b.reason || null })) },
    });
    return { ok: true };
  });

/** One-off blocked time (manual availability block) with audit trail. */
export const addBlockedTime = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { date: string; startHHMM: string; endHHMM: string; reason?: string })
  .handler(async ({ data }) => {
    const store = await getStore();
    const toMin = (hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      return h * 60 + m;
    };
    const base = new Date(etDayStartUtc(data.date)).getTime();
    const startAt = new Date(base + toMin(data.startHHMM) * 60_000).toISOString();
    const endAt = new Date(base + toMin(data.endHHMM) * 60_000).toISOString();
    if (endAt <= startAt) throw new Error("Block end must be after start");
    const row = await store.insertBlockedTime({ start_at: startAt, end_at: endAt, reason: data.reason?.trim() || null });
    await store.insertManualOverride({
      entity_type: "blocked_time",
      entity_id: row.id,
      field: "block",
      previous_value: null,
      new_value: `${data.date} ${data.startHHMM}–${data.endHHMM}${data.reason ? ` (${data.reason.trim()})` : ""}`,
      changed_by: "christopher",
    });
    return { ok: true, block: row };
  });

export const removeBlockedTime = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { id: string; label?: string })
  .handler(async ({ data }) => {
    const store = await getStore();
    await store.deleteBlockedTime(String(data.id));
    await store.insertManualOverride({
      entity_type: "blocked_time",
      entity_id: String(data.id),
      field: "block",
      previous_value: data.label ?? String(data.id),
      new_value: "deleted",
      changed_by: "christopher",
    });
    return { ok: true };
  });
/**
 * PENDING PAYMENT DISMISSAL (owner request 2026-09-30: "for the pending
 * payments on todays tab i want to be able to exit out of them, can you put a
 * x exit to them to delete from that list as i see fit"). POST endpoint that
 * marks ONE pending payment dismissed — it disappears from the Today page's
 * Pending Payments list IMMEDIATELY and PERMANENTLY (survives syncs: the
 * dismissal is owner-controlled state the Acuity sync's upsert never touches).
 * The appointment row itself is NEVER deleted — Acuity is the source of truth
 * and the sync would re-create it.
 *
 * Guards:
 *  - only PENDING payments are dismissible: a PAID booking (Booking Win) is
 *    rejected here, and a prior dismissal never affects a win — if the deposit
 *    arrives later the appointment still counts as a Booking Win everywhere;
 *  - an audit row (manual_override) records the dismissal with the
 *    appointment id ("pending payment dismissed by owner").
 */
export interface DismissPendingPaymentInput {
  appointmentId: string;
}
/** Core of the dismissPendingPayment server fn (test seam — no TanStack runtime). */
export async function dismissPendingPaymentCore(store: Store, input: DismissPendingPaymentInput): Promise<{ ok: true }> {
  const appointmentId = String(input.appointmentId);
  // The Today page's pending window: the same selector the pending list reads
  // (unpaid bookings, created OR session inside the last 30 days) — read
  // WITHOUT the exclusion so an already-dismissed id resolves honestly.
  const windowStart = etDayStartUtc(addDays(etToday(), -30));
  const appt = (await store.getAppointmentsWithClientsSince(windowStart)).find((a) => a.id === appointmentId);
  if (!appt) throw new Error("Appointment not found in the pending payments window");
  const state = appointmentPaymentStateOf(appt);
  if (state !== "pending_payment") {
    throw new Error(`Only pending payments can be dismissed — this appointment's payment state is "${state}"`);
  }
  await store.dismissPendingPayment(appointmentId);
  await store.insertManualOverride({
    entity_type: "appointment",
    entity_id: appointmentId,
    field: "pending_payment",
    previous_value: "pending",
    new_value: "pending payment dismissed by owner",
    changed_by: "christopher",
  });
  return { ok: true };
}
export const dismissPendingPayment = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { appointmentId: string })
  .handler(async ({ data }) =>
    dismissPendingPaymentCore(await getStore(), { appointmentId: String(data.appointmentId) }),
  );

/**
 * MANUAL ATTRIBUTION (owner spec: the Unattributed queue is manually
 * assignable — never silently guessed). Writes a manual override the
 * attribution tick RESPECTS: manual rows are never overwritten by re-runs
 * (manual wins; store upserts skip manual_override rows).
 *
 * Guards:
 *  - only ACTIVE ROSTER reps are assignable (a mapping target or a
 *    deactivated user is rejected — manual assignments can never put a
 *    booking on someone who is not on the CC team);
 *  - the call, when supplied, may be the internal id (the queue's candidate
 *    calls) or the HighLevel external call id (resolved to internal).
 *
 * The editor note lands in the audit trail; unassign deletes the derived row
 * so the next attribution tick recomputes the appointment from raw rows.
 */
export interface AssignAttributionInput {
  appointmentId: string;
  /** Internal rep id — MUST be an active roster rep. */
  repId?: string;
  /** Qualifying call: internal id (queue candidates) or HL external call id. */
  callId?: string | null;
  callExternalId?: string | null;
  note?: string;
}

/** Core of the assignAttribution server fn (test seam — no TanStack runtime). */
export async function assignAttributionCore(store: Store, input: AssignAttributionInput): Promise<{ ok: true }> {
  const appointmentId = String(input.appointmentId);
  const repId = String(input.repId ?? "");
  const rep = (await store.getUsers()).find((u) => u.id === repId && u.is_active);
  if (!rep) throw new Error("Only active roster reps can be assigned");
  let callId = input.callId ? String(input.callId) : null;
  if (!callId && input.callExternalId) {
    const since = etDayStartUtc(addDays(etToday(), -(30 + 7)));
    callId =
      (await store.getAllCallsSince(since)).find((c) => c.external_call_id === String(input.callExternalId))?.id ??
      null;
  }
  const prev = (await store.getAttributions()).find((a) => a.appointment_id === appointmentId);
  await store.setManualAttribution({
    id: prev?.id ?? "",
    appointment_id: appointmentId,
    call_id: callId ?? prev?.call_id ?? null,
    rep_id: repId,
    method: "manual",
    confidence: 1,
    manual_override: true,
  });
  await store.insertManualOverride({
    entity_type: "booking_attribution",
    entity_id: appointmentId,
    field: "rep",
    previous_value: prev?.rep_id ?? "unattributed",
    new_value: rep.name,
    changed_by: "christopher",
  });
  const note = input.note?.trim();
  if (note) {
    await store.insertManualOverride({
      entity_type: "booking_attribution",
      entity_id: appointmentId,
      field: "note",
      previous_value: null,
      new_value: note.slice(0, 500),
      changed_by: "christopher",
    });
  }
  return { ok: true };
}

/** Core of the unassignAttribution server fn (test seam). */
export async function unassignAttributionCore(store: Store, appointmentId: string): Promise<{ ok: true }> {
  const prev = (await store.getAttributions()).find((a) => a.appointment_id === appointmentId);
  await store.deleteAttribution(appointmentId);
  await store.insertManualOverride({
    entity_type: "booking_attribution",
    entity_id: appointmentId,
    field: "rep",
    previous_value: prev?.rep_id ?? "unattributed",
    new_value: "unassigned",
    changed_by: "christopher",
  });
  return { ok: true };
}

/** Manual booking attribution from the unattributed queue (roster-guarded). */
export const assignAttribution = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as AssignAttributionInput)
  .handler(async ({ data }) => assignAttributionCore(await getStore(), data));

/** Remove a manual attribution — the appointment returns to the engine's control. */
export const unassignAttribution = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { appointmentId: string })
  .handler(async ({ data }) => unassignAttributionCore(await getStore(), String(data.appointmentId)));

/** Manual lead work-date correction. */
export const setLeadWorkDate = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { leadId: string; workDate: string; previousWorkDate?: string; reason?: string })
  .handler(async ({ data }) => {
    const store = await getStore();
    const leadId = String(data.leadId);
    const workDate = String(data.workDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new Error("Work date must be YYYY-MM-DD");
    // Previous value: client-supplied (the row the editor loaded), else a ±2-week lookup.
    let previous = data.previousWorkDate ?? null;
    if (!previous) {
      const window = Array.from({ length: 29 }, (_, i) => addDays(workDate, i - 14));
      previous = (await store.getLeadsByWorkDates(window)).find((l) => l.id === leadId)?.work_date ?? null;
    }
    await store.updateLeadWorkDate(leadId, workDate);
    await store.insertManualOverride({
      entity_type: "lead",
      entity_id: leadId,
      field: "work_date",
      previous_value: previous ?? "unknown",
      new_value: workDate,
      changed_by: "christopher",
    });
    return { ok: true, previous };
  });

/** Manual lead-count correction for one date + sheet (delta vs the synced rows). */
export const setLeadCount = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { date: string; sheet: string; count: number; reason?: string })
  .handler(async ({ data }) => {
    const store = await getStore();
    const date = String(data.date);
    const sheet = data.sheet === "animalia" ? "animalia" : "family";
    const count = Math.max(0, Math.floor(Number(data.count) || 0));
    const ws = weekStart(date);
    const leads = await store.getLeadsByWorkDates(dateRange(ws, addDays(ws, 6)));
    const observed = leads.filter((l) => l.work_date === date && l.source_sheet === sheet).length;
    const prior = (await store.getLeadCountAdjustments([date])).find((a) => a.sheet === sheet);
    const delta = count - observed;
    await store.upsertLeadCountAdjustment({ work_date: date, sheet, delta, reason: data.reason?.trim() || null });
    await store.insertManualOverride({
      entity_type: "lead_count",
      entity_id: `${date}:${sheet}`,
      field: "count",
      previous_value: prior ? `${observed + prior.delta} (adjustment ${prior.delta >= 0 ? "+" : ""}${prior.delta})` : `${observed} (synced)`,
      new_value: `${count} (adjustment ${delta >= 0 ? "+" : ""}${delta})`,
      changed_by: "christopher",
    });
    return { ok: true, observed, delta };
  });

/** Manual SYNC NOW (re-runs demo seed; later: live providers). */
export const syncNow = createServerFn({ method: "POST" }).handler(async () => {
  const { runDemoSync } = await import("./sync/run");
  const result = await runDemoSync();
  return result;
});

// ---------- Freshness (shell header, all pages) ----------
export interface FreshnessData {
  highlevel: {
    status: string;
    isDemo: boolean;
    lastSyncAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  };
  running: boolean;
  runningStartedAt: string | null;
  intervalSeconds: number;
  serverNow: string;
  /**
   * Harmonization Wave 1: nav count badges (shell, all pages). Factual record
   * counts from the SAME stores the sections render — a zero or absent count
   * hides its badge (a badge is never faked). Presentation support only.
   */
  navCounts?: {
    /** Performance — active (issued) PIPs. */
    activePips: number;
    /** Commissions — cycles sitting in Ready for Review (manager attention). */
    commissionsAwaitingReview: number;
  };
}

/** Connection freshness for the shell's "Last synced Xm ago" indicator. */
export const getFreshnessData = createServerFn().handler((): Promise<FreshnessData> => withDbRetry(async (): Promise<FreshnessData> => {
  const { readSchedulerIntervalSeconds } = await import("./sync/scheduler");
  const store = await getStore();
  const [connections, running, settings] = await Promise.all([store.getConnections(), store.getRunningSyncRun("highlevel"), store.getSettings()]);
  const hl = connections.find((c) => c.provider === "highlevel") ?? null;
  // Nav count badges (Wave 1): active PIPs for the Performance pill, cycles in
  // Ready for Review for the Commissions pill. Read-only + guarded — any store
  // failure just hides the badges, it never blocks a page render.
  let navCounts: FreshnessData["navCounts"];
  try {
    const [issuedPips, cycles] = await Promise.all([store.listPips("issued"), store.getCommissionCycles()]);
    navCounts = {
      activePips: issuedPips.length,
      commissionsAwaitingReview: cycles.filter((c) => c.status === "ready_for_review").length,
    };
  } catch {
    navCounts = undefined;
  }
  return {
    highlevel: {
      status: hl?.status ?? "unknown",
      isDemo: hl?.is_demo ?? true,
      lastSyncAt: hl?.last_sync_at ?? null,
      lastSuccessAt: hl?.last_successful_sync_at ?? null,
      lastError: hl?.last_error ?? null,
    },
    running: !!running,
    runningStartedAt: running?.started_at ?? null,
    intervalSeconds: readSchedulerIntervalSeconds(settings.highlevel_sync_interval_seconds),
    serverNow: new Date().toISOString(),
    navCounts,
  };
}));

/**
 * Shell REFRESH button — runs the same background tick (incremental HighLevel
 * sync, skip while another run is in progress) and returns fresh timestamps.
 */
export const refreshNow = createServerFn({ method: "POST" }).handler(async () => {
  const { schedulerTick } = await import("./sync/scheduler");
  const tick = await schedulerTick({ trigger: "manual" });
  const store = await getStore();
  const [connections, running] = await Promise.all([store.getConnections(), store.getRunningSyncRun("highlevel")]);
  const hl = connections.find((c) => c.provider === "highlevel") ?? null;
  return {
    tick,
    lastSyncAt: hl?.last_sync_at ?? null,
    lastSuccessAt: hl?.last_successful_sync_at ?? null,
    lastError: hl?.last_error ?? null,
    running: !!running,
    serverNow: new Date().toISOString(),
  };
});

/** Save the background-sync interval (Settings; clamped 30–3600s, default 90). */
export const saveSyncInterval = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { intervalSeconds: number })
  .handler(async ({ data }) => {
    const { readSchedulerIntervalSeconds } = await import("./sync/scheduler");
    const store = await getStore();
    const intervalSeconds = readSchedulerIntervalSeconds(data.intervalSeconds);
    await store.saveSettings({ highlevel_sync_interval_seconds: intervalSeconds });
    return { ok: true, intervalSeconds };
  });

/** DAILY REPORT page — payload built in page-data.ts dailyReportPageData (PageDeps test seam). */
export const getDailyReportData = createServerFn().handler(() => withDbRetry(() => dailyReportPageData()));

/** Save the Big 3 priorities for TODAY's report date (America/New_York). */
export const saveDailyPriorities = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { p1?: string; p2?: string; p3?: string })
  .handler(async ({ data }) => {
    const store = await getStore();
    const date = etToday();
    const prev = await store.getDailyPriorities(date);
    await store.upsertDailyPriorities({
      date,
      priority1: data.p1?.trim() || null,
      priority2: data.p2?.trim() || null,
      priority3: data.p3?.trim() || null,
      updated_at: new Date().toISOString(),
    });
    // audit trail per SPEC (manual corrections)
    for (const [field, val] of [
      ["priority1", data.p1?.trim() || null],
      ["priority2", data.p2?.trim() || null],
      ["priority3", data.p3?.trim() || null],
    ] as const) {
      const before = field === "priority1" ? prev?.priority1 : field === "priority2" ? prev?.priority2 : prev?.priority3;
      if ((before ?? null) !== (val ?? null)) {
        await store.insertManualOverride({
          entity_type: "daily_priorities",
          entity_id: date,
          field,
          previous_value: before ?? null,
          new_value: val ?? "",
          changed_by: "christopher",
        });
      }
    }
    return { ok: true };
  });

/** REPS page — individual rep performance with date filters + team comparison. */
export interface RepsSearchParams {
  rep?: string;
  range?: string;
  from?: string;
  to?: string;
  /** ASSIGNED LEADS BY DAY week anchor (any date in the week; normalized to its Monday). Absent = last completed week. */
  week?: string;
}

export const getRepsData = createServerFn()
  .validator((input: unknown) => (input ?? {}) as RepsSearchParams)
  .handler(({ data }) => withDbRetry(() => repsPageData(data)));

/**
 * Plain (non-server-fn) payload builder for the Reps page — the loader
 * delegates here. Exported so tests can exercise the REAL loader-level range
 * resolution (whole-page atomic context) without the TanStack Start runtime.
 */
/** AUDIT page — read-only DB call rows for one rep × one ET day (audit-api). */
export interface AuditSearchParams {
  rep?: string;
  date?: string;
}
export interface AuditPicker {
  /** Active-roster reps (label + internal id) for the rep picker. */
  reps: { id: string; name: string }[];
  allLabel: string;
  /** Exact owner terminology (design/data-terminology.md). */
  nonRosterLabel: string;
  unattributedLabel: string;
  /** Legacy alias kept working for old links. */
  unassignedLabel: string;
}
export interface AuditPageData {
  error: string | null;
  payload: AuditOkBody | null;
  picker: AuditPicker | null;
  today: string | null;
}
export const getAuditData = createServerFn()
  .validator((input: unknown) => (input ?? {}) as AuditSearchParams)
  .handler(async ({ data }): Promise<AuditPageData> => {
    const today = etToday();
    // LAZY import: keeps the audit orchestration (and its store graph) out of
    // the client bundle — handler bodies are stripped client-side, so a static
    // import here would retain the module in the browser graph.
    const { handleAuditQuery, LABEL_NON_ROSTER, LABEL_UNATTRIBUTED } = await import("./audit-api");
    const res = await handleAuditQuery({ rep: data?.rep ?? "all", date: data?.date ?? null });
    if (res.status !== 200) {
      return { error: (res.body as { error: string }).error, payload: null, picker: null, today };
    }
    const store = await getStore();
    const reps = (await store.getUsers()).map((u) => ({ id: u.id, name: u.name }));
    return {
      error: null,
      payload: res.body as AuditOkBody,
      picker: {
        reps,
        allLabel: `All calls (${reps.length} roster reps + non-roster + unattributed)`,
        nonRosterLabel: LABEL_NON_ROSTER,
        unattributedLabel: LABEL_UNATTRIBUTED,
        unassignedLabel: "Unassigned (legacy — both buckets)",
      },
      today,
    };
  });

/** TEAM page — team aggregates + trends for a date range, all via the metrics layer. */
export interface TeamSearchParams {
  range?: string;
  from?: string;
  to?: string;
}

export interface RepStripRow {
  id: string;
  name: string;
  totalBookings: number;
  callsOverThreshold: number;
  conversationConversion: number | null;
  /** Range call total — carried from the same repRangeSummaries pass (no new math). */
  totalCalls: number;
  /** Range average call length in seconds — from repRangeSummaries (null with no calls). */
  avgCallDurationSeconds: number | null;
  /** Booking goal over the payload range — resolveRepGoal (rep goal or team share); null = no range. */
  goal: RepGoalInfo | null;
  /** "not-yet-active" reps show only the Not Yet Active chip; attention rules skip them. */
  operatingState: "active" | "not-yet-active";
  callStartDate: string | null;
}

export const getTeamData = createServerFn()
  .validator((input: unknown) => (input ?? {}) as TeamSearchParams)
  .handler(({ data }) => withDbRetry(() => teamPageData(data)));

/**
 * The current request's URL (server-only, h3 event storage) — null outside a
 * request context (tests/demo), never throws. During an SSR page load the
 * availability handler's start context holds the PAGE request, whose URL query
 * is the raw search the route's validateSearch saw; see availability-wiring.ts.
 */
function currentRequestUrl(): string | null {
  try {
    return getRequest().url;
  } catch {
    return null;
  }
}

/**
 * AVAILABILITY page — engine + Acuity connection + scope filters (playbook contract).
 *
 * METHOD = POST (2026-10-07 triage, live-instrumented): TanStack Start 1.158
 * drops a GET serverfn's payload in BOTH transports — the SSR in-process chain
 * AND the client-navigation RPC (the handler then sees data={} with the request
 * context either holding the PAGE request during SSR, or the _serverFn endpoint
 * request during client nav — never a recoverable search). The POST transport
 * delivers the payload in both (the refreshAvailabilityFeed POST demonstrably
 * runs server-side from the browser). The page-URL fallback in
 * availabilityViewArgsFrom stays as belt-and-suspenders for any transport that
 * drops a POST body too (SSR page loads carry the search in their URL).
 */
export const getAvailabilityData = createServerFn({ method: "POST" })
  .validator((input?: AvailabilityViewRawSearch) => input ?? {})
  .handler(({ data }) => {
    const { args, argsLost } = resolveAvailabilityViewArgs(data, currentRequestUrl());
    return withDbRetry(() => availabilityPageData({ view: args, viewArgsLost: argsLost }));
  });

/**
 * PR-3 §4 MANUAL REFRESH (the sync panel's Refresh control): re-probe the
 * visible range NOW via PR-1's refreshAvailabilityRange (awaited, unthrottled,
 * bounded by AVAILABILITY_REFRESH_TIMES_CAP). Demo/test resolves
 * { outcome: "skipped", reason: "no-credentials" } — never calls.
 */
export const refreshAvailabilityFeed = createServerFn({ method: "POST" })
  .validator((input: { dates: string[] }) => input)
  .handler(async ({ data }) => {
    const res = await withDbRetry(() => refreshAvailabilityRange({ dates: data.dates }));
    return {
      outcome: res.outcome,
      reason: res.reason ?? null,
      callsMade: res.callsMade ?? null,
      datesProbed: res.datesProbed ?? null,
      error: res.error ?? null,
    };
  });
/** WEEKLY REPORT page — last completed week + MTD (page-data.ts weeklyPageData, PageDeps test seam). */
export const getWeeklyData = createServerFn().handler(() => withDbRetry(() => weeklyPageData()));

/** COMMISSION CENTER page — stored cycles + weekly records + §3.5 estimate (page-data.ts, PageDeps test seam). */
export const getCommissionData = createServerFn().handler(() => withDbRetry(() => commissionPageData()));
/** §26 VALIDATION page — fresh recompute vs stored records (READ-ONLY, page-data.ts). */
export const getCommissionValidationData = createServerFn().handler(() => withDbRetry(() => commissionValidationPageData()));

// ==================== COMMISSION PHASE C — manager actions (§N/§O/§19/§S) ====================
// Every action runs behind the global passphrase gate (the manager surface) and
// lands an audited adjustment row (who/what/old→new/reason/when). No auto-
// submission exists anywhere — submission is this one explicit call.

export interface AdvanceCycleInput {
  cycleId: string;
  to: CommissionCycleStatus;
  /** Optional manager note — becomes the audit reason (default text otherwise). */
  note?: string;
  /** Optional actor label for the audit trail (shared-gate app; default "manager"). */
  actor?: string;
}
/** Advance the approval workflow ONE legal step (in_progress → ready_for_review → approved). */
export const advanceCommissionCycle = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as AdvanceCycleInput)
  .handler(async ({ data }) => {
    if (data.to === "submitted") {
      throw new Error("Use the explicit submit action — submission is never a routine status advance.");
    }
    return transitionCommissionCycle(await getStore(), {
      cycleId: String(data.cycleId),
      to: data.to,
      actor: (data.actor ?? "manager").trim() || "manager",
      note: data.note,
    });
  });

/** SUBMIT an approved cycle — freezes every stored number forever (spec §19). */
export const submitCommissionCycleFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { cycleId: string; actor?: string })
  .handler(async ({ data }) => {
    return submitCommissionCycle(await getStore(), {
      cycleId: String(data.cycleId),
      actor: (data.actor ?? "manager").trim() || "manager",
    });
  });

/** Pull completed unassigned weeks INTO a live cycle (RULING 4 pre-approval, audited). */
export const assignCommissionWeeksFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { cycleId: string; weekStarts: string[]; actor?: string; note?: string })
  .handler(async ({ data }) => {
    return assignCommissionWeeks(await getStore(), {
      cycleId: String(data.cycleId),
      weekStarts: (data.weekStarts ?? []).map(String),
      actor: (data.actor ?? "manager").trim() || "manager",
      note: data.note,
    });
  });

/** Pull weeks OUT of a live cycle (§S: current cycle → unassigned, audited). */
export const unassignCommissionWeeksFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { cycleId: string; weekStarts: string[]; actor?: string; note?: string })
  .handler(async ({ data }) => {
    return unassignCommissionWeeks(await getStore(), {
      cycleId: String(data.cycleId),
      weekStarts: (data.weekStarts ?? []).map(String),
      actor: (data.actor ?? "manager").trim() || "manager",
      note: data.note,
    });
  });

export interface CommissionCorrectionInput {
  cycleId: string | null;
  userId: string;
  weekStart: string;
  kind: CorrectionKind;
  deltaDollars?: number;
  appointmentId?: string;
  holeCount?: number;
  /** REQUIRED — rejected without it (lifecycle + store both enforce). */
  reason: string;
  actor?: string;
}
/** §O/§20: apply ONE reason-required, fully audited correction to a stored weekly record. */
export const applyCommissionCorrectionFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as CommissionCorrectionInput)
  .handler(async ({ data }) => {
    return applyCommissionCorrection(await getStore(), {
      cycleId: data.cycleId == null ? null : String(data.cycleId),
      userId: String(data.userId),
      weekStart: String(data.weekStart),
      kind: data.kind,
      deltaDollars: data.deltaDollars == null ? undefined : Number(data.deltaDollars),
      appointmentId: data.appointmentId == null ? undefined : String(data.appointmentId),
      holeCount: data.holeCount == null ? undefined : Number(data.holeCount),
      reason: String(data.reason ?? ""),
      actor: (data.actor ?? "manager").trim() || "manager",
    });
  });
