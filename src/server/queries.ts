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
  isRangeMode,
  mondaysInRange,
  resolveRange,
  weekStart,
  type RangeMode,
} from "./date-logic";
import {
  buildDailyReportMetrics,
  buildRepDetail,
  buildTeamAverages,
  buildTeamRangeMetrics,
  buildTeamTrends,
  compareWithTeam,
  computeOpenSlots,
  buildTodayMetrics,
  buildUnattributedQueue,
  filterApptsCreatedInEtRange,
  filterCallsInEtRange,
  materializeRecurringBlocks,
  repRangeSummaries,
  resolveRepGoal,
} from "./metrics/compute";
import {
  big3Incomplete,
  buildDailyReportEmail,
  buildDailyReportSlack,
  buildDailyReportText,
} from "./metrics/report-text";
import { getStore } from "./store";
import { keepRosterRepCalls } from "./roster";
import { buildUnassignedRollup } from "~/components/reps-views";
import { AUDIT_ALL, AUDIT_UNASSIGNED, handleAuditQuery, type AuditOkBody } from "./audit-api";
import { ensureDemoData } from "./sync/run";
import { isSheetMappingMode } from "./sync/sheets-mapping";
import type { AppSettings } from "./store/types";

/** Open-slot horizon for the Today page: today + the next 6 days (spec §7.1). */
const SLOT_DAY_OFFSETS = [0, 1, 2, 3, 4, 5, 6] as const;

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

/** TODAY page — everything computed via buildTodayMetrics. */
export const getTodayData = createServerFn().handler(async () => {
  const meta = await loadPageMeta();
  const store = await getStore();

  const today = etToday();
  const yesterday = addDays(today, -1);
  const ws = weekStart(today);

  const settings = await store.getSettings();
  const todayStart = etDayStartUtc(today);
  const todayEnd = etDayEndUtc(today);
  const yesterdayStart = etDayStartUtc(yesterday);
  const weekStartUtc = etDayStartUtc(ws);

  const [callsToday, callsWtd, callsForAttribution, apptsToday, apptsYesterday, apptsWtd, rules, leads, teamGoal, repGoals, users, attributions, leadAdjustments, slotDayResults] =
    await Promise.all([
      store.getCallsBetween(todayStart, todayEnd),
      store.getCallsBetween(weekStartUtc, todayEnd),
      store.getAllCallsSince(weekStartUtc),
      store.getAppointmentsCreatedBetween(todayStart, todayEnd),
      store.getAppointmentsCreatedBetween(yesterdayStart, todayStart),
      store.getAppointmentsCreatedBetween(weekStartUtc, todayEnd),
      store.getAvailabilityRules(),
      // leads worked this week so far: cohorts for each day Mon..today (work_date)
      store.getLeadsByWorkDates(
        Array.from({ length: daysSinceMonday(today) + 1 }, (_, i) => addDays(ws, i)),
      ),
      store.getTeamGoal(ws),
      store.getRepGoals(ws),
      store.getUsers(),
      store.getAttributions(),
      // manual lead-count corrections for the operational week (metrics applies them)
      store.getLeadCountAdjustments(dateRange(ws, addDays(ws, 6))),
      // Spec §7.1: open slots for today + the next 6 days — per-day store
      // queries (appointments overlapping + blocked times), no new methods.
      Promise.all(
        SLOT_DAY_OFFSETS.flatMap((off) => {
          const d = addDays(today, off);
          return [
            store.getAppointmentsOverlapping(etDayStartUtc(d), etDayEndUtc(d)),
            store.getBlockedTimesBetween(etDayStartUtc(d), etDayEndUtc(d)),
          ];
        }),
      ),
    ]);

  const teamBookingGoal = teamGoal?.booking_goal ?? 79;
  const weeklyLeadBudget = teamGoal?.lead_budget ?? 700;

  // ROSTER: users are active-roster only (store filters is_active); team call
  // metrics must likewise never see non-roster users' calls. Raw rows stay in
  // the DB — this filter is per-surface, applied before the metrics layer.
  const rosterIds = new Set(users.map((u) => u.id));
  const rosterCallsToday = keepRosterRepCalls(callsToday, rosterIds);
  const rosterCallsWtd = keepRosterRepCalls(callsWtd, rosterIds);
  const rosterCallsForAttribution = keepRosterRepCalls(callsForAttribution, rosterIds);

  // concrete blocks (Acuity/manual) PLUS the weekly recurring pattern,
  // materialized per queried day — the open-slot engine stays date-agnostic
  const recurring = settings.studio.recurring_blocks ?? [];

  const openSlotsByDay = SLOT_DAY_OFFSETS.map((off, i) => {
    const date = addDays(today, off);
    const appointments = slotDayResults[i * 2];
    const blockedRaw = slotDayResults[i * 2 + 1];
    return {
      date,
      slots: computeOpenSlots({
        date,
        rules,
        blocked: [...blockedRaw, ...materializeRecurringBlocks(date, recurring)],
        appointments,
        slotIntervalMin: settings.studio.slot_interval_min,
        durationMin: settings.studio.appointment_duration_min,
        paddingMin: settings.studio.padding_min,
      }),
    };
  });

  const metrics = buildTodayMetrics({
    reportDate: today,
    calls: rosterCallsToday,
    apptsCreatedToday: apptsToday,
    apptsCreatedYesterday: apptsYesterday,
    apptsCreatedWtd: apptsWtd,
    callsWtd: rosterCallsWtd,
    allCallsForWeek: rosterCallsForAttribution,
    attributions,
    leadsAllRecent: leads,
    leadCountAdjustments: leadAdjustments,
    teamBookingGoal,
    weeklyLeadBudget,
    thresholdSeconds: settings.meaningful_call_threshold_seconds,
    openSlotsByDay,
    reps: users.map((u) => ({ id: u.id, name: u.name })),
    repGoals: repGoals.map((g) => ({ rep_id: g.rep_id, week_start: g.week_start, goal: g.goal })),
  });

  return {
    meta,
    settings,
    metrics,
    connections: serializableConnections(await store.getConnections()),
    staleWarnings: syncStaleWarnings(await store.getConnections()),
    cohortNote: `Today's cohort = leads received on ${metrics.leadCohortSourceDates.join(", ")}`,
  };
});

function daysSinceMonday(today: string): number {
  const ws = weekStart(today);
  const [y1, m1, d1] = ws.split("-").map(Number);
  const [y2, m2, d2] = today.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** SETTINGS page data — every editable surface loads its rows here. */
export const getSettingsData = createServerFn().handler(async () => {
  const meta = await loadPageMeta();
  const store = await getStore();
  const settings = await store.getSettings();
  const today = etToday();
  const ws = weekStart(today);

  // Week-list editor window: two past weeks, current, six future.
  const editorWeeks = Array.from({ length: 9 }, (_, i) => addDays(weekStart(today), 7 * (i - 2)));
  const week = dateRange(ws, addDays(ws, 6));

  const [teamGoals, connections, runs, overrides, users, repGoalsByWeekRows, leadAdjustments, weekLeads, apptsWindow, callsWindow, contacts, attributions, blockedWindow] =
    await Promise.all([
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
      store.getContacts(),
      store.getAttributions(),
      store.getBlockedTimesBetween(etDayStartUtc(addDays(today, -7)), etDayEndUtc(addDays(today, 30))),
    ]);

  const repGoalsByWeek: Record<string, { rep_id: string; goal: number }[]> = {};
  editorWeeks.forEach((w, i) => {
    repGoalsByWeek[w] = repGoalsByWeekRows[i].map((g) => ({ rep_id: g.rep_id, goal: g.goal }));
  });
  const goalByWeek = new Map(teamGoals.map((g) => [g.week_start, g]));

  // Unattributed bookings queue — composed via the metrics layer, never guessed.
  const unattributed = buildUnattributedQueue({
    appointments: apptsWindow,
    attributions,
    calls: callsWindow,
    contacts: contacts.map((c) => ({ id: c.id, phone: c.phone, email: c.email, assigned_rep_id: c.assigned_rep_id })),
    thresholdSeconds: settings.meaningful_call_threshold_seconds,
    windowHours: settings.attribution_window_hours,
  });

  // Observed per-date lead counts (before adjustments) for the count editor.
  const observedCounts = week.flatMap((d) => {
    return (["family", "animalia"] as const).map((sheet) => {
      const observed = weekLeads.filter((l) => l.work_date === d && l.source_sheet === sheet).length;
      const prior = leadAdjustments.find((a) => a.work_date === d && a.sheet === sheet);
      return { date: d, sheet, observed, adjustedDelta: prior ? prior.delta : null };
    });
  });

  const { isPassphraseConfigured } = await import("./auth");
  return {
    meta,
    settings,
    passphraseConfigured: isPassphraseConfigured(),
    weekStart: ws,
    today,
    editorWeeks: editorWeeks.map((w) => ({
      weekStart: w,
      isCurrent: w === ws,
      label: `${formatDateHuman(w)} – ${formatDateHuman(addDays(w, 6))}`,
      goal: goalByWeek.get(w)?.booking_goal ?? null,
      leadBudget: goalByWeek.get(w)?.lead_budget ?? null,
    })),
    users: users.map((u) => ({ id: u.id, name: u.name })),
    repCount: users.length,
    repGoalsByWeek,
    connections: serializableConnections(connections),
    syncRuns: runs,
    overrides,
    unattributed,
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
});

/** integration_connections in a fully serializable shape (config → note string). */
function serializableConnections(connections: { provider: string; status: string; is_demo: boolean; last_sync_at: string | null; last_successful_sync_at: string | null; last_error: string | null; config: Record<string, unknown> }[]) {
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
export function syncStaleWarnings(connections: { provider: string; status: string; last_successful_sync_at: string | null; last_error?: string | null }[]): string[] {
  const out: string[] = [];
  const LABELS: Record<string, string> = { highlevel: "HighLevel", acuity: "Acuity", google_sheets: "Google Sheets" };
  for (const c of connections) {
    if (!["highlevel", "acuity", "google_sheets"].includes(c.provider)) continue;
    const label = LABELS[c.provider] ?? c.provider;
    if (c.status === "error") out.push(`${label} reported a sync error — its numbers may be incomplete; check the Sync Center in Settings.`);
    else if (c.status === "connected" && c.last_error) out.push(`${label} synced partially — some sheets/sources failed (see Settings → Sync Center); its numbers may be incomplete.`);
    else if (!c.last_successful_sync_at) out.push(`${label} has never synced successfully — run SYNC NOW in Settings.`);
  }
  return out;
}

const PROVIDER_DATA_LABELS: Record<string, string> = {
  highlevel: "HighLevel calls",
  acuity: "Acuity bookings",
  google_sheets: "Google Sheets leads",
};

/**
 * Provider-aware honesty line for the Today banner: which data is live vs
 * demo, e.g. "Live: Google Sheets leads · Demo: HighLevel calls, Acuity
 * bookings". Null when nothing has synced yet (other banner clauses cover it).
 */
export function demoAwarenessLine(connections: { provider: string; status: string; is_demo: boolean }[]): string | null {
  const live: string[] = [];
  const demo: string[] = [];
  for (const c of connections) {
    const label = PROVIDER_DATA_LABELS[c.provider];
    if (!label) continue;
    if (!c.is_demo && c.status === "connected") live.push(label);
    else demo.push(label);
  }
  if (live.length === 0 && demo.length === 0) return null;
  if (live.length === 0) return `Demo data: ${demo.join(", ")} — live integrations pending`;
  if (demo.length === 0) return `Live: ${live.join(", ")}`;
  return `Live: ${live.join(", ")} · Demo: ${demo.join(", ")}`;
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

/** Sheet column mapping (persisted to app_settings). */
export const saveSheetMapping = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { sheet: "family" | "animalia"; columns: Record<string, string>; mode?: string })
  .handler(async ({ data }) => {
    const store = await getStore();
    const sheet = data.sheet === "animalia" ? "animalia" : "family";
    const settings = await store.getSettings();
    const columns: Record<string, string> = { ...settings.sheets[sheet].columns, ...data.columns };
    const mode = isSheetMappingMode(data.mode) ? data.mode : settings.sheets[sheet].mode;
    await store.saveSettings({ sheets: { ...settings.sheets, [sheet]: { ...settings.sheets[sheet], columns, mode } } });
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

/** Manual booking attribution from the unattributed queue. */
export const assignBooking = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { appointmentId: string; repId: string; callId?: string | null })
  .handler(async ({ data }) => {
    const store = await getStore();
    const appointmentId = String(data.appointmentId);
    const repId = String(data.repId);
    const prev = (await store.getAttributions()).find((a) => a.appointment_id === appointmentId);
    await store.setManualAttribution({
      id: prev?.id ?? "",
      appointment_id: appointmentId,
      call_id: data.callId ? String(data.callId) : (prev?.call_id ?? null),
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
      new_value: repId,
      changed_by: "christopher",
    });
    return { ok: true };
  });

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
}

/** Connection freshness for the shell's "Last synced Xm ago" indicator. */
export const getFreshnessData = createServerFn().handler(async (): Promise<FreshnessData> => {
  const { readSchedulerIntervalSeconds } = await import("./sync/scheduler");
  const store = await getStore();
  const [connections, running, settings] = await Promise.all([store.getConnections(), store.getRunningSyncRun("highlevel"), store.getSettings()]);
  const hl = connections.find((c) => c.provider === "highlevel") ?? null;
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
  };
});

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

/** DAILY REPORT page — yesterday's performance + current week progress. */
export const getDailyReportData = createServerFn().handler(async () => {
  const meta = await loadPageMeta();
  const store = await getStore();

  const today = etToday();
  const yesterday = addDays(today, -1);
  const ws = weekStart(today);

  const settings = await store.getSettings();
  const todayStart = etDayStartUtc(today);
  const todayEnd = etDayEndUtc(today);
  const yesterdayStart = etDayStartUtc(yesterday);
  const weekStartUtc = etDayStartUtc(ws);

  const [callsYesterday, apptsYesterday, apptsWtd, callsForAttribution, leads, teamGoal, priorities, leadAdjustments] =
    await Promise.all([
      store.getCallsBetween(yesterdayStart, todayStart),
      store.getAppointmentsCreatedBetween(yesterdayStart, todayStart),
      store.getAppointmentsCreatedBetween(weekStartUtc, todayEnd),
      store.getAllCallsSince(weekStartUtc),
      // all leads worked this week so far (work_date Mon..today) — covers both
      // today's cohort and yesterday's for the conversion denominators
      store.getLeadsByWorkDates(dateRange(ws, today)),
      store.getTeamGoal(ws),
      store.getDailyPriorities(today),
      store.getLeadCountAdjustments(dateRange(ws, addDays(ws, 6))),
    ]);

  // ROSTER: report call metrics cover active-roster users only (raw rows stay
  // in the DB; team-level numbers reflect only the CC team).
  const rosterUsers = await store.getUsers();
  const rosterIds = new Set(rosterUsers.map((u) => u.id));
  const rosterCallsYesterday = keepRosterRepCalls(callsYesterday, rosterIds);
  const rosterCallsForAttribution = keepRosterRepCalls(callsForAttribution, rosterIds);

  const metrics = buildDailyReportMetrics({
    reportDate: today,
    callsYesterday: rosterCallsYesterday,
    apptsCreatedYesterday: apptsYesterday,
    apptsCreatedWtd: apptsWtd,
    allCallsForWeek: rosterCallsForAttribution,
    attributions: await store.getAttributions(),
    leadsAllRecent: leads,
    leadCountAdjustments: leadAdjustments,
    teamBookingGoal: teamGoal?.booking_goal ?? 79,
    weeklyLeadBudget: teamGoal?.lead_budget ?? 700,
    thresholdSeconds: settings.meaningful_call_threshold_seconds,
  });

  const saved = priorities ?? { date: today, priority1: null, priority2: null, priority3: null, updated_at: null };

  // Missing-data warnings — never render a plausible number for absent data.
  const warnings: string[] = [];
  if (metrics.conversationConversion == null)
    warnings.push("No qualifying calls recorded yesterday — Conversation Conversion is unavailable.");
  if (metrics.assignedLeadConversion == null)
    warnings.push("No leads worked yesterday — Assigned Lead Conversion is unavailable.");
  if (metrics.goalAchievement == null)
    warnings.push("Weekly booking goal is 0 — Goal Achievement is unavailable.");
  if (metrics.leadsToday === 0 && metrics.weeklyLeads === 0)
    warnings.push("No leads in this week's cohort yet — run SYNC NOW or check the Google Sheets connection.");
  if (big3Incomplete(saved))
    warnings.push("Big 3 not fully set for today — fill the three priorities below before copying the report.");

  const reportText = buildDailyReportText(metrics, saved);
  return {
    meta,
    metrics,
    priorities: saved,
    warnings: [...syncStaleWarnings(await store.getConnections()), ...warnings],
    reportText,
    emailText: buildDailyReportEmail(metrics, saved),
    slackText: buildDailyReportSlack(metrics, saved),
    cohortNote: `Today's cohort = leads received on ${metrics.leadCohortSourceDates.join(", ")} (work-date logic)`,
  };
});

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
}

export const getRepsData = createServerFn()
  .validator((input: unknown) => (input ?? {}) as RepsSearchParams)
  .handler(async ({ data }) => {
    const meta = await loadPageMeta();
    const store = await getStore();
    const settings = await store.getSettings();
    const today = etToday();

    // resolve the ET date range (invalid custom falls back to Today + warning)
    const mode: RangeMode = isRangeMode(data?.range) ? data.range : "today";
    const range = resolveRange(mode, today, data?.from, data?.to);
    const { startUtc, endUtc } = etRangeBounds(range.start, range.end);
    const weeks = mondaysInRange(range.start, range.end);

    const [users, callsRaw, apptsRaw, attributions, leads, lookBackCalls, allUsers] = await Promise.all([
      store.getUsers(),
      store.getCallsBetween(startUtc, endUtc),
      store.getAppointmentsCreatedBetween(startUtc, endUtc),
      store.getAttributions(),
      store.getLeadsByWorkDates(dateRange(range.start, range.end)),
      // look-back before the range so attribution joins can reach the call
      // that produced a booking created just inside the range
      store.getAllCallsSince(
        etDayStartUtc(addDays(range.start, -Math.ceil(settings.attribution_window_hours / 24) - 1)),
      ),
      // ALL users (roster or not) — names the Unassigned rollup below
      store.getAllUsers(),
    ]);
    const repGoalRows = await Promise.all(weeks.map((w) => store.getRepGoals(w)));
    const teamGoalRows = await Promise.all(weeks.map((w) => store.getTeamGoal(w)));

    // re-apply the ET bounds as a pure guard (same semantics as the SQL bounds)
    const calls = filterCallsInEtRange(callsRaw, range.start, range.end);
    const appts = filterApptsCreatedInEtRange(apptsRaw, range.start, range.end);

    // ROSTER: reps and team averages cover active-roster users only; calls
    // from roster-excluded users stay in the DB but leave this page's math.
    const rosterIds = new Set(users.map((u) => u.id));
    const rosterCalls = keepRosterRepCalls(calls, rosterIds);
    const rosterLookBackCalls = keepRosterRepCalls(lookBackCalls, rosterIds);

    // UNASSIGNED (visible, never merged): non-roster HighLevel users' calls in
    // the SAME window over the SAME call rows — the exact complement of the
    // roster-kept set. Pure rollup in reps-views; displayed under the roster
    // list on the Reps page and excluded from every roster/team total.
    const userById = new Map(allUsers.map((u) => [u.id, { name: u.name, external_id: u.external_id }]));
    const unassigned = buildUnassignedRollup({
      calls,
      activeRepIds: rosterIds,
      userById,
      thresholdSeconds: settings.meaningful_call_threshold_seconds,
    });

    const reps = users.map((u) => ({ id: u.id, name: u.name }));
    const thresholdSeconds = settings.meaningful_call_threshold_seconds;

    const summaries = repRangeSummaries({
      reps,
      calls: rosterCalls,
      appts,
      attributions,
      allCallsForJoin: rosterLookBackCalls,
      leads,
      workStart: range.start,
      workEnd: range.end,
      thresholdSeconds,
    });

    // selected rep: requested id when present in the active list, else first
    const requestedId = data?.rep;
    const rep = reps.find((r) => r.id === requestedId) ?? reps[0];

    const repGoalsByWeek = new Map<string, number>();
    for (const rows of repGoalRows) {
      for (const g of rows) if (g.rep_id === rep?.id) repGoalsByWeek.set(g.week_start, g.goal);
    }
    const teamGoalByWeek = new Map<string, number>();
    for (const t of teamGoalRows) if (t) teamGoalByWeek.set(t.week_start, t.booking_goal);

    const metrics = rep ? summaries.get(rep.id) : undefined;
    const others = reps.filter((r) => r.id !== rep?.id).map((r) => summaries.get(r.id)!);
    const teamAverages = buildTeamAverages({ others });
    const goal = rep
      ? resolveRepGoal({
          weeks,
          repGoalsByWeek,
          teamGoalByWeek,
          repCount: reps.length,
        })
      : null;
    const detail = rep && metrics ? buildRepDetail({ rep, metrics, goal, weeks }) : null;
    const comparisons = metrics ? compareWithTeam(metrics, teamAverages) : [];

    // missing-data warnings — never render a plausible number for absent data
    const warnings: string[] = [...syncStaleWarnings(await store.getConnections())];
    if (range.warning) warnings.push(range.warning);
    if (!rep) warnings.push("No active reps found — sync HighLevel users to populate this page.");
    if (rep && metrics) {
      if (metrics.totalCalls === 0 && metrics.totalBookings === 0 && metrics.assignedLeads === 0) {
        warnings.push(`No activity recorded for ${rep.name} in this range — run SYNC NOW or widen the range.`);
      }
      if (metrics.conversationConversion == null && metrics.callsOverThreshold === 0 && metrics.totalCalls > 0) {
        warnings.push(`No calls over the ${thresholdSeconds}s threshold for ${rep.name} in this range — Conversation Conversion is unavailable.`);
      }
      if (metrics.assignedLeadConversion == null && metrics.assignedLeads === 0 && metrics.totalBookings > 0) {
        warnings.push(`No assigned leads worked for ${rep.name} in this range — Assigned Lead Conversion is unavailable.`);
      }
    }
    if (!goal) warnings.push("No booking goal resolvable for this range (no reps or weeks) — goal metrics are unavailable.");

    const singleDay = range.start === range.end;
    const caption = singleDay
      ? `${formatDateHumanFull(range.start)} · ${range.label}`
      : `${formatDateHumanFull(range.start)} – ${formatDateHumanFull(range.end)} · ${range.label}`;

    return {
      meta,
      today,
      range: { mode: range.mode, label: range.label, start: range.start, end: range.end, caption, toDate: range.toDate },
      thresholdSeconds,
      repList: reps.map((r) => {
        const s = summaries.get(r.id);
        return {
          id: r.id,
          name: r.name,
          totalBookings: s?.totalBookings ?? 0,
          totalCalls: s?.totalCalls ?? 0,
          callsOverThreshold: s?.callsOverThreshold ?? 0,
          isSelected: r.id === rep?.id,
        };
      }),
      detail,
      teamAverages,
      comparisons,
      unassigned,
      warnings,
      teamGoalDefault: teamGoalByWeek.get(weeks[0]) ?? 79,
    };
  });

/** AUDIT page — read-only DB call rows for one rep × one ET day (audit-api). */
export interface AuditSearchParams {
  rep?: string;
  date?: string;
}
export interface AuditPicker {
  /** Active-roster reps (label + internal id) for the rep picker. */
  reps: { id: string; name: string }[];
  allLabel: string;
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
    const res = await handleAuditQuery({ rep: data?.rep ?? AUDIT_ALL, date: data?.date ?? null });
    if (res.status !== 200) {
      return { error: (res.body as { error: string }).error, payload: null, picker: null, today };
    }
    const store = await getStore();
    const reps = (await store.getUsers()).map((u) => ({ id: u.id, name: u.name }));
    return {
      error: null,
      payload: res.body,
      picker: {
        reps,
        allLabel: `All calls (${reps.length} roster reps + unassigned)`,
        unassignedLabel: "Unassigned — non-roster HL users",
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
}

export const getTeamData = createServerFn()
  .validator((input: unknown) => (input ?? {}) as TeamSearchParams)
  .handler(async ({ data }) => {
    const meta = await loadPageMeta();
    const store = await getStore();
    const settings = await store.getSettings();
    const today = etToday();

    // resolve the ET date range (invalid custom falls back with a warning).
    // Default THIS WEEK: the Team page leads with trends, and a one-day range
    // would render single-point charts; WTD matches the rest of the app.
    const mode: RangeMode = isRangeMode(data?.range) ? data.range : "this-week";
    const range = resolveRange(mode, today, data?.from, data?.to);
    const { startUtc, endUtc } = etRangeBounds(range.start, range.end);
    const weeks = mondaysInRange(range.start, range.end);

    const [users, callsRaw, apptsRaw, attributions, leads, lookBackCalls, teamGoalRows] = await Promise.all([
      store.getUsers(),
      store.getCallsBetween(startUtc, endUtc),
      store.getAppointmentsCreatedBetween(startUtc, endUtc),
      store.getAttributions(),
      store.getLeadsByWorkDates(dateRange(range.start, range.end)),
      // look-back before the range so attribution joins can reach the call
      // that produced a booking created just inside the range
      store.getAllCallsSince(
        etDayStartUtc(addDays(range.start, -Math.ceil(settings.attribution_window_hours / 24) - 1)),
      ),
      Promise.all(weeks.map((w) => store.getTeamGoal(w))),
    ]);

    // re-apply the ET bounds as a pure guard (same semantics as the SQL bounds)
    const calls = filterCallsInEtRange(callsRaw, range.start, range.end);
    const appts = filterApptsCreatedInEtRange(apptsRaw, range.start, range.end);

    // ROSTER: rep strip + team rollups cover active-roster users only; calls
    // from roster-excluded users stay in the DB but leave the team math.
    const rosterIds = new Set(users.map((u) => u.id));
    const rosterCalls = keepRosterRepCalls(calls, rosterIds);
    const rosterLookBackCalls = keepRosterRepCalls(lookBackCalls, rosterIds);

    const reps = users.map((u) => ({ id: u.id, name: u.name }));
    const thresholdSeconds = settings.meaningful_call_threshold_seconds;

    // one summaries pass feeds both the per-rep strip and (nothing else here —
    // team totals come from buildTeamRangeMetrics on the same filtered rows)
    const summaries = repRangeSummaries({
      reps,
      calls: rosterCalls,
      appts,
      attributions,
      allCallsForJoin: rosterLookBackCalls,
      leads,
      workStart: range.start,
      workEnd: range.end,
      thresholdSeconds,
    });

    const teamGoalByWeek = new Map<string, number>();
    const leadBudgetByWeek = new Map<string, number>();
    for (const t of teamGoalRows) {
      if (!t) continue;
      teamGoalByWeek.set(t.week_start, t.booking_goal);
      leadBudgetByWeek.set(t.week_start, t.lead_budget);
    }

    const metrics = buildTeamRangeMetrics({
      calls: rosterCalls,
      appts,
      attributions,
      allCallsForJoin: rosterLookBackCalls,
      leads,
      workStart: range.start,
      workEnd: range.end,
      weeks,
      teamGoalByWeek,
      today,
      thresholdSeconds,
      activeRepIds: rosterIds,
    });

    const trends = buildTeamTrends({
      calls: rosterCalls,
      appts,
      attributions,
      allCallsForJoin: rosterLookBackCalls,
      leads,
      leadCountAdjustments: await store.getLeadCountAdjustments(dateRange(range.start, range.end)),
      start: range.start,
      end: range.end,
      weeklyBudgetByWeek: leadBudgetByWeek,
      thresholdSeconds,
    });

    const repRows: RepStripRow[] = reps
      .map((r) => {
        const s = summaries.get(r.id);
        return {
          id: r.id,
          name: r.name,
          totalBookings: s?.totalBookings ?? 0,
          callsOverThreshold: s?.callsOverThreshold ?? 0,
          conversationConversion: s?.conversationConversion ?? null,
        };
      })
      .sort((a, b) => b.totalBookings - a.totalBookings || b.callsOverThreshold - a.callsOverThreshold);

    // missing-data warnings — never render a plausible number for absent data
    const warnings: string[] = [...syncStaleWarnings(await store.getConnections())];
    if (range.warning) warnings.push(range.warning);
    if (reps.length === 0) warnings.push("No active reps found — sync HighLevel users to populate this page.");
    if (metrics.totalCalls === 0 && metrics.totalBookings === 0 && metrics.assignedLeads === 0 && trends.points.every((p) => p.leads === 0)) {
      warnings.push(`No team activity recorded ${range.start === range.end ? "on" : "in"} this range — run SYNC NOW or widen the range.`);
    }
    if (metrics.callsOverThreshold === 0 && metrics.totalCalls > 0) {
      warnings.push(`No calls over the ${thresholdSeconds}s threshold in this range — Conversation Conversion is unavailable.`);
    }
    if (metrics.assignedLeads === 0 && metrics.totalBookings > 0) {
      warnings.push("No assigned leads worked in this range — Assigned Lead Conversion is unavailable.");
    }
    if (metrics.goal.value === 0) warnings.push("Team booking goal is 0 — Goal Achievement and pace are unavailable.");

    const singleDay = range.start === range.end;
    const caption = singleDay
      ? `${formatDateHumanFull(range.start)} · ${range.label}`
      : `${formatDateHumanFull(range.start)} – ${formatDateHumanFull(range.end)} · ${range.label}`;

    return {
      meta,
      today,
      range: { mode: range.mode, label: range.label, start: range.start, end: range.end, caption, toDate: range.toDate },
      thresholdSeconds,
      metrics,
      trends,
      repRows,
      warnings,
      teamGoalDefault: teamGoalByWeek.get(weeks[0]) ?? 79,
    };
  });
