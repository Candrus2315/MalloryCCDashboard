/**
 * PAGE-DATA BUILDERS (server-only module).
 *
 * repsPageData / teamPageData live here — NOT in queries.ts — because a
 * createServerFn module must export only server-fn stubs for the TanStack
 * client transform: plain exports left in queries.ts pulled the postgres
 * chain into the vite client bundle (build error: "performance" is not
 * exported by __vite-browser-external). Routes import the createServerFn
 * wrappers from queries.ts; tests and scripts import these builders
 * directly (with the PageDeps seam: inject a MemoryStore + pinned clock —
 * never getStore() from tests, never the Start runtime).
 */
import { getStore } from "./store";
import type { Store } from "./store/types";
import {
  addDays,
  dateRange,
  etDayStartUtc,
  etRangeBounds,
  etToday,
  formatDateHuman,
  formatDateHumanFull,
  isHistoricalWeek,
  isRangeMode,
  mondaysInRange,
  repOperatingState,
  resolveRange,
  weekStart,
  type RangeMode,
} from "./date-logic";
import {
  buildTeamAverages,
  buildTeamRangeMetrics,
  buildTeamTrends,
  buildRepDetail,
  compareWithTeam,
  filterApptsCreatedInEtRange,
  filterCallsInEtRange,
  repRangeSummaries,
  resolveRepGoal,
} from "./metrics/compute";
import { applyAttributionEligibility, applyRosterEligibility, buildRosterEligibility } from "./roster";
import { buildCallOwnershipBuckets } from "../components/reps-views";
import { syncStaleWarnings, type PageMeta, type RepsSearchParams, type RepStripRow, type TeamSearchParams } from "./queries";

async function loadPageMeta(): Promise<PageMeta> {
  const seeded = await import("./sync/run").then((m) => m.ensureDemoData());
  const { getDbStatus } = await import("./store");
  const status = getDbStatus();
  return { mode: seeded.mode, dbReason: status.ok ? null : status.reason, today: etToday(), demoSeeded: seeded.seeded };
}

/**
 * DI seam for tests (pure-layer view compos): when `store` is injected the
 * builders never touch getStore()/loadPageMeta() (which could reach live
 * Postgres or seed demo data); `today` pins the clock so week-cadence
 * behavior (Fri → weekend → Mon 12AM ET → Tue) is deterministic. The
 * createServerFn loaders pass nothing and behave exactly as before.
 */
export interface PageDeps {
  store?: Store;
  today?: string;
}

export async function repsPageData(data?: RepsSearchParams, deps?: PageDeps) {
    const today = deps?.today ?? etToday();
    const meta: PageMeta = deps?.store
      ? { mode: "memory", dbReason: null, today, demoSeeded: false }
      : await loadPageMeta();
    const store = deps?.store ?? (await getStore());
    const settings = await store.getSettings();

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

    // ROSTER ELIGIBILITY (mapping-aware): reps and team averages cover active
    // roster users PLUS calls whose raw HL user id is mapped to a roster rep —
    // eligibility is computed from the mapping at QUERY TIME; source records
    // stay immutable. With no mappings this is the verified roster filter.
    const thresholdSeconds = settings.meaningful_call_threshold_seconds;
    const eligibility = buildRosterEligibility(allUsers, settings.rep_mappings ?? []);
    const rosterCalls = applyRosterEligibility(calls, eligibility);
    const rosterLookBackCalls = applyRosterEligibility(lookBackCalls, eligibility);
    // Bookings inherit query-time eligibility via the underlying call.
    const attributionsEligible = applyAttributionEligibility(attributions, rosterLookBackCalls, eligibility);

    // CALL-OWNERSHIP BUCKETS (design/data-terminology.md — three, mutually
    // exclusive): roster calls feed the metrics; the complement splits into
    // "Non Roster Calls" (KNOWN HL user outside the roster) and "Unattributed"
    // (no determinable owner). Both are visible below and excluded from every
    // roster/team total; mapped users leave the non-roster bucket at query time.
    const userById = new Map(allUsers.map((u) => [u.id, { name: u.name, external_id: u.external_id }]));
    const buckets = buildCallOwnershipBuckets({
      calls,
      activeRepIds: eligibility.activeIds,
      mappedExternalIds: new Set(eligibility.mapping.keys()),
      userById,
      thresholdSeconds,
    });

    const reps = users.map((u) => ({ id: u.id, name: u.name, call_start_date: u.call_start_date }));

    const summaries = repRangeSummaries({
      reps,
      calls: rosterCalls,
      appts,
      attributions: attributionsEligible,
      allCallsForJoin: rosterLookBackCalls,
      leads,
      workStart: range.start,
      workEnd: range.end,
      thresholdSeconds,
    });

    // selected rep: requested id when present in the active list, else first
    const requestedId = data?.rep;
    const rep = reps.find((r) => r.id === requestedId) ?? reps[0];
    const selectedOperatingState: "active" | "not-yet-active" = rep
      ? repOperatingState(rep.call_start_date, today)
      : "active";

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

    // missing-data warnings — never render a plausible number for absent data.
    // A "Not Yet Active" rep (call_start_date in the future) EXPECTS zero
    // calls: no zero-activity warning, ever (owner spec).
    const warnings: string[] = [...syncStaleWarnings(await store.getConnections())];
    if (range.warning) warnings.push(range.warning);
    if (!rep) warnings.push("No active reps found — sync HighLevel users to populate this page.");
    if (rep && metrics && selectedOperatingState !== "not-yet-active") {
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
      range: {
        mode: range.mode,
        label: range.label,
        start: range.start,
        end: range.end,
        caption,
        toDate: range.toDate,
        // live-state for the header indicator: only a "Week of…" anchored
        // before the current Monday is historical (isHistoricalWeek)
        isCurrentWeek: !isHistoricalWeek(range.mode, range.start, today),
      },
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
          operatingState: repOperatingState(r.call_start_date, today),
          callStartDate: r.call_start_date ?? null,
        };
      }),
      detail,
      selectedOperatingState,
      teamAverages,
      comparisons,
      nonRoster: buckets.nonRoster,
      unattributed: buckets.unattributed,
      warnings,
      teamGoalDefault: teamGoalByWeek.get(weeks[0]) ?? 79,
    };
}

/**
 * Plain (non-server-fn) payload builder for the Team page — the loader
 * delegates here. Exported so tests can assert the WHOLE-PAGE ATOMIC CONTEXT
 * (spec §HISTORICAL WEEK SELECTOR): the one resolved range drives reps, team
 * metrics, goal, leads, and trends together, without the Start runtime.
 */

export async function teamPageData(data?: TeamSearchParams, deps?: PageDeps) {
    const today = deps?.today ?? etToday();
    const meta: PageMeta = deps?.store
      ? { mode: "memory", dbReason: null, today, demoSeeded: false }
      : await loadPageMeta();
    const store = deps?.store ?? (await getStore());
    const settings = await store.getSettings();

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

    // ROSTER ELIGIBILITY (mapping-aware): rep strip + team rollups cover
    // active roster users PLUS calls whose raw HL user id is mapped — query
    // time only, source rows immutable. Empty mapping = the verified filter.
    const eligibility = buildRosterEligibility(users, settings.rep_mappings ?? []);
    const rosterCalls = applyRosterEligibility(calls, eligibility);
    const rosterLookBackCalls = applyRosterEligibility(lookBackCalls, eligibility);
    const attributionsEligible = applyAttributionEligibility(attributions, rosterLookBackCalls, eligibility);

    const reps = users.map((u) => ({ id: u.id, name: u.name, call_start_date: u.call_start_date }));
    const thresholdSeconds = settings.meaningful_call_threshold_seconds;

    // one summaries pass feeds both the per-rep strip and (nothing else here —
    // team totals come from buildTeamRangeMetrics on the same filtered rows)
    const summaries = repRangeSummaries({
      reps,
      calls: rosterCalls,
      appts,
      attributions: attributionsEligible,
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
      attributions: attributionsEligible,
      allCallsForJoin: rosterLookBackCalls,
      leads,
      workStart: range.start,
      workEnd: range.end,
      weeks,
      teamGoalByWeek,
      today,
      thresholdSeconds,
      activeRepIds: eligibility.activeIds,
    });

    const trends = buildTeamTrends({
      calls: rosterCalls,
      appts,
      attributions: attributionsEligible,
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
          operatingState: repOperatingState(r.call_start_date, today),
          callStartDate: r.call_start_date ?? null,
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
      range: {
        mode: range.mode,
        label: range.label,
        start: range.start,
        end: range.end,
        caption,
        toDate: range.toDate,
        // live-state for the header indicator (see repsPageData)
        isCurrentWeek: !isHistoricalWeek(range.mode, range.start, today),
      },
      thresholdSeconds,
      metrics,
      trends,
      repRows,
      warnings,
      teamGoalDefault: teamGoalByWeek.get(weeks[0]) ?? 79,
    };
}
