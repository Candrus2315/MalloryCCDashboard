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
import type { AppSettings, AppointmentRow, Store } from "./store/types";
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
  buildTodayMetrics,
  buildDailyReportMetrics,
  bookingAttributionSplit,
  compareWithTeam,
  computeOpenSlots,
  filterApptsInWinBucketRange,
  filterCallsInEtRange,
  appointmentPaymentStateOf,
  materializeRecurringBlocks,
  repRangeSummaries,
  resolveRepGoal,
} from "./metrics/compute";
import { big3Incomplete, buildDailyReportEmail, buildDailyReportSlack, buildDailyReportText } from "./metrics/report-text";
import { derivePaymentState } from "./payments";
import { appointmentInScope, computeDayAvailability, type DayAvailability } from "./metrics/availability";
import { applyAttributionEligibility, applyRosterEligibility, buildRosterEligibility } from "./roster";
import { buildCallOwnershipBuckets } from "../components/reps-views";
import { serializableConnections, syncStaleWarnings, type PageMeta, type RepsSearchParams, type RepStripRow, type TeamSearchParams } from "./queries";

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
      // REV 12 WIN BUCKET: wins count on booking_win_business_date (the ET
      // date the deposit was received); the superset query also returns
      // not-yet-derived rows by created date for the metrics fallback.
      store.getAppointmentsByWinBusinessDateBetween(range.start, range.end),
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
    const appts = filterApptsInWinBucketRange(apptsRaw, range.start, range.end).filter((a) =>
      // OWNER DIRECTIVE (2026-09-26): only in-scope Acuity calendars/types may
      // feed ANY booking number — the same appointmentInScope rule the
      // availability engine applies, from the SAME getSettings() read.
      // Empty scope list = everything counts. Applied before every metric.
      appointmentInScope(a, settings.acuity),
    );

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

    const [users, callsRaw, apptsRaw, attributions, leads, lookBackCalls, teamGoalRows, repGoalRows] = await Promise.all([
      store.getUsers(),
      store.getCallsBetween(startUtc, endUtc),
      // REV 12 WIN BUCKET: wins count on booking_win_business_date (the ET
      // date the deposit was received); the superset query also returns
      // not-yet-derived rows by created date for the metrics fallback.
      store.getAppointmentsByWinBusinessDateBetween(range.start, range.end),
      store.getAttributions(),
      store.getLeadsByWorkDates(dateRange(range.start, range.end)),
      // look-back before the range so attribution joins can reach the call
      // that produced a booking created just inside the range
      store.getAllCallsSince(
        etDayStartUtc(addDays(range.start, -Math.ceil(settings.attribution_window_hours / 24) - 1)),
      ),
      Promise.all(weeks.map((w) => store.getTeamGoal(w))),
      // per-rep booking goals per covered week (RepStripRow.goal via resolveRepGoal)
      Promise.all(weeks.map((w) => store.getRepGoals(w))),
    ]);

    // re-apply the ET bounds as a pure guard (same semantics as the SQL bounds)
    const calls = filterCallsInEtRange(callsRaw, range.start, range.end);
    const appts = filterApptsInWinBucketRange(apptsRaw, range.start, range.end).filter((a) =>
      // OWNER DIRECTIVE (2026-09-26): same scope rule as the availability
      // engine (appointmentInScope, settings.acuity from THIS builder's one
      // getSettings() read) — out-of-scope appointments never feed numbers.
      appointmentInScope(a, settings.acuity),
    );

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

    // THREE-WAY ATTRIBUTION SPLIT (owner directive 2026-09-27, S5b) — the
    // stored attribution states over this range's in-scope bookings, through
    // the ONE metrics-layer classifier: Total = Attributed + Ambiguous +
    // Unattributed (+ `withoutVerdict` surfaced separately when a booking has
    // no stored verdict yet — e.g. older than the recompute window). Ambiguous
    // is its OWN state here — never folded into Unattributed.
    const bookingSplit = bookingAttributionSplit(appts, attributionsEligible);

    const repRows: RepStripRow[] = reps
      .map((r) => {
        const s = summaries.get(r.id);
        // E-strip (merged-build playbook): per-rep range goal through the SAME
        // resolveRepGoal the Reps table uses — rep goal when set, team-share
        // otherwise; null never invented. totalCalls / avgCallDurationSeconds
        // are carried from the same repRangeSummaries pass (no new math).
        const repGoalsByWeek = new Map<string, number>();
        for (const rows of repGoalRows) {
          for (const g of rows) if (g.rep_id === r.id) repGoalsByWeek.set(g.week_start, g.goal);
        }
        return {
          id: r.id,
          name: r.name,
          totalBookings: s?.totalBookings ?? 0,
          callsOverThreshold: s?.callsOverThreshold ?? 0,
          conversationConversion: s?.conversationConversion ?? null,
          totalCalls: s?.totalCalls ?? 0,
          avgCallDurationSeconds: s?.avgCallDurationSeconds ?? null,
          goal: resolveRepGoal({ weeks, repGoalsByWeek, teamGoalByWeek, repCount: reps.length }),
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
      bookingSplit,
      repRows,
      warnings,
      teamGoalDefault: teamGoalByWeek.get(weeks[0]) ?? 79,
    };
}

// ---------- TODAY + DAILY REPORT (bodies moved from queries.ts so EVERY page
// builder is testable through the same PageDeps seam — routes import the
// createServerFn wrappers from queries.ts, tests import these directly) ----------

/** Open-slot horizon for the Today page: today + the next 6 days (spec §7.1). */
const SLOT_DAY_OFFSETS = [0, 1, 2, 3, 4, 5, 6] as const;

function daysSinceMonday(today: string): number {
  const ws = weekStart(today);
  const [y1, m1, d1] = ws.split("-").map(Number);
  const [y2, m2, d2] = today.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * OWNER DIRECTIVE (2026-09-26, out-of-scope bookings must not count): an
 * appointment feeds a booking number only when it passes appointmentInScope —
 * the availability engine's ONE scope rule — fed from the SAME getSettings()
 * read as every other number. Empty scope list = everything counts (Settings
 * copy). Demo appointments carry calendar names that match nothing in a set
 * scope: they count only when the scope is empty. Tests must set the scope
 * explicitly ([] = everything); demo data is never special-cased here.
 */
function apptsInScope(appts: AppointmentRow[], scope: AppSettings["acuity"]): AppointmentRow[] {
  return appts.filter((a) => appointmentInScope(a, scope));
}

/** TODAY page payload — everything computed via buildTodayMetrics. */
export async function todayPageData(deps?: PageDeps) {
  const today = deps?.today ?? etToday();
  // PERF: meta (demo-seed guard) + settings + connections are independent of
  // the main batch — they run inside it instead of sequentially before/after.
  const metaPromise: Promise<PageMeta> = deps?.store
    ? Promise.resolve({ mode: "memory", dbReason: null, today, demoSeeded: false })
    : loadPageMeta();
  const store = deps?.store ?? (await getStore());

  const yesterday = addDays(today, -1);
  const ws = weekStart(today);

  const todayStart = etDayStartUtc(today);
  const todayEnd = etDayEndUtc(today);
  const yesterdayStart = etDayStartUtc(yesterday);
  const weekStartUtc = etDayStartUtc(ws);

  const [meta, settings, callsToday, callsWtd, callsForAttribution, apptsToday, apptsYesterday, apptsWtd, rules, leads, teamGoal, repGoals, users, attributions, leadAdjustments, pendingWindow, connections, slotDayResults] =
    await Promise.all([
      metaPromise,
      store.getSettings(),
      store.getCallsBetween(todayStart, todayEnd),
      store.getCallsBetween(weekStartUtc, todayEnd),
      store.getAllCallsSince(weekStartUtc),
      // REV 12 WIN BUCKET: today/yesterday/WTD bookings = BOOKING WINS whose
      // booking_win_business_date (the ET date the deposit was received) falls
      // in the bucket; not-yet-derived rows fall back to created date.
      store.getAppointmentsByWinBusinessDateBetween(today, today),
      store.getAppointmentsByWinBusinessDateBetween(yesterday, yesterday),
      store.getAppointmentsByWinBusinessDateBetween(ws, today),
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
      // PENDING PAYMENTS drill-down window (rev 12): unpaid bookings in the
      // last 30 days (created OR session inside) — visible, never counted.
      store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30))),
      // PERF: one connections read feeds BOTH the banner lines (was two
      // sequential getConnections() round trips at the end of the builder).
      // POSITIONAL CONTRACT: keep this array in the same order as the
      // destructuring above — slotDayResults is itself a Promise.all, so a
      // mis-ordered entry silently swaps whole result sets (that is exactly
      // the bug this PERF pass shipped: connections read last in the array but
      // bound before slotDayResults, feeding connection rows into the
      // open-slot engine).
      store.getConnections(),
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

  const scope = settings.acuity;

  // Scope BEFORE any booking computation (owner directive — see apptsInScope).
  // The availability open slots below scope themselves inside computeDayAvailability.
  const apptsTodayScoped = apptsInScope(apptsToday, scope);
  const apptsYesterdayScoped = apptsInScope(apptsYesterday, scope);
  const apptsWtdScoped = apptsInScope(apptsWtd, scope);

  const teamBookingGoal = teamGoal?.booking_goal ?? 79;
  const weeklyLeadBudget = teamGoal?.lead_budget ?? 700;

  // ROSTER ELIGIBILITY (mapping-aware): active-roster users + owner roster
  // mappings (Settings). Calls pass when their rep is a roster member OR their
  // raw HL user id is mapped to one — computed at QUERY TIME; source rows are
  // never rewritten. With no mappings this is exactly the verified roster
  // filter. Non-roster/unattributed calls stay in the DB and stay visible in
  // the Reps-page ownership buckets — never merged into roster/team totals.
  const eligibility = buildRosterEligibility(users, settings.rep_mappings ?? []);
  const rosterCallsToday = applyRosterEligibility(callsToday, eligibility);
  const rosterCallsWtd = applyRosterEligibility(callsWtd, eligibility);
  const rosterCallsForAttribution = applyRosterEligibility(callsForAttribution, eligibility);
  // Bookings inherit the same query-time eligibility (a mapped user's
  // historical bookings flow to their mapped rep via the underlying call).
  const attributionsEligible = applyAttributionEligibility(attributions, rosterCallsForAttribution, eligibility);

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

  // GOAL RESOLUTION (owner binding directive 2026-09-27): Today resolves every
  // rep's weekly goal through the SAME resolveRepGoal the Reps page uses —
  // rep goal when set (>0), else that week's team goal shared evenly across
  // the active roster (default 79 when no team-goal row exists). Identical
  // inputs to the Reps path: weeks=[ws], repGoalsByWeek from store.getRepGoals,
  // teamGoalByWeek from store.getTeamGoal, repCount = active users length.
  // No new goal table/field/default — one helper, one source of truth, so
  // Today and Reps can never disagree for the same rep+week.
  const todayReps = users.map((u) => ({ id: u.id, name: u.name, call_start_date: u.call_start_date }));
  const teamGoalByWeek = new Map<string, number>();
  if (teamGoal) teamGoalByWeek.set(teamGoal.week_start, teamGoal.booking_goal);
  const resolvedRepGoals = todayReps.map((r) => {
    const repGoalsByWeek = new Map<string, number>();
    for (const g of repGoals) if (g.rep_id === r.id) repGoalsByWeek.set(g.week_start, g.goal);
    const resolved = resolveRepGoal({ weeks: [ws], repGoalsByWeek, teamGoalByWeek, repCount: todayReps.length });
    return {
      rep_id: r.id,
      week_start: ws,
      goal: resolved?.value ?? 0,
      goal_basis: resolved?.basis ?? null,
      goal_note: resolved?.note ?? null,
    };
  });
  const metrics = buildTodayMetrics({
    reportDate: today,
    calls: rosterCallsToday,
    apptsCreatedToday: apptsTodayScoped,
    apptsCreatedYesterday: apptsYesterdayScoped,
    apptsCreatedWtd: apptsWtdScoped,
    callsWtd: rosterCallsWtd,
    allCallsForWeek: rosterCallsForAttribution,
    attributions: attributionsEligible,
    leadsAllRecent: leads,
    leadCountAdjustments: leadAdjustments,
    teamBookingGoal,
    weeklyLeadBudget,
    thresholdSeconds: settings.meaningful_call_threshold_seconds,
    openSlotsByDay,
    reps: todayReps,
    repGoals: resolvedRepGoals,
  });

  // PENDING PAYMENTS drill-down (owner directive, rev 12): unpaid bookings
  // (derived payment state "pending_payment") are VISIBLE but NEVER count.
  // Amount is informational (raw priceSold ?? price — the amount due); rep is
  // the stored attribution (manual overrides included) — never a guess.
  const repNameById = new Map(users.map((u) => [u.id, u.name]));
  const attrByAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  const pendingPayments = pendingWindow
    .filter(
      (a) =>
        // unpaid appointment — pending only when it is a real booking (non-cancelled)
        !a.cancelled && a.status !== "cancelled" && appointmentPaymentStateOf(a) === "pending_payment",
    )
    .map((a) => {
      const d = derivePaymentState(a.raw);
      const amount = d.priceSold ?? d.price;
      const attr = attrByAppt.get(a.id);
      return {
        appointment_id: a.id,
        acuity_appointment_id: a.acuity_appointment_id ?? null,
        client_name: a.client_name ?? null,
        appointment_type: a.appointment_type,
        amount,
        amountPaid: d.amountPaid,
        rep_id: attr?.rep_id ?? null,
        rep_name: attr?.rep_id ? repNameById.get(attr.rep_id) ?? null : null,
        created_business_date: a.created_business_date ?? null,
        created_at: a.created_at,
        appointment_datetime: a.appointment_datetime,
      };
    })
    .sort((x, y) => (x.created_at < y.created_at ? 1 : -1));

  return {
    meta,
    settings,
    metrics,
    pendingPayments,
    connections: serializableConnections(connections),
    staleWarnings: syncStaleWarnings(connections),
    cohortNote: `Today's cohort = leads received on ${metrics.leadCohortSourceDates.join(", ")}`,
  };
}

/** DAILY REPORT page — yesterday's performance + current week progress. */
export async function dailyReportPageData(deps?: PageDeps) {
  const today = deps?.today ?? etToday();
  // PERF: meta + settings run inside the main batch (were sequential before it).
  const metaPromise: Promise<PageMeta> = deps?.store
    ? Promise.resolve({ mode: "memory", dbReason: null, today, demoSeeded: false })
    : loadPageMeta();
  const store = deps?.store ?? (await getStore());

  const yesterday = addDays(today, -1);
  const ws = weekStart(today);

  const todayStart = etDayStartUtc(today);
  const todayEnd = etDayEndUtc(today);
  const yesterdayStart = etDayStartUtc(yesterday);
  const weekStartUtc = etDayStartUtc(ws);

  const [meta, settings, callsYesterday, apptsYesterday, apptsWtd, callsForAttribution, leads, teamGoal, priorities, leadAdjustments] =
    await Promise.all([
      metaPromise,
      store.getSettings(),
      store.getCallsBetween(yesterdayStart, todayStart),
      // REV 12 WIN BUCKET: yesterday/WTD = BOOKING WINS by deposit date
      // (booking_win_business_date); not-yet-derived rows fall back to created.
      store.getAppointmentsByWinBusinessDateBetween(yesterday, yesterday),
      store.getAppointmentsByWinBusinessDateBetween(ws, today),
      store.getAllCallsSince(weekStartUtc),
      // all leads worked this week so far (work_date Mon..today) — covers both
      // today's cohort and yesterday's for the conversion denominators
      store.getLeadsByWorkDates(dateRange(ws, today)),
      store.getTeamGoal(ws),
      store.getDailyPriorities(today),
      store.getLeadCountAdjustments(dateRange(ws, addDays(ws, 6))),
    ]);

  const scope = settings.acuity;
  // Scope BEFORE any booking computation (owner directive — see apptsInScope).
  const apptsYesterdayScoped = apptsInScope(apptsYesterday, scope);
  const apptsWtdScoped = apptsInScope(apptsWtd, scope);

  // ROSTER ELIGIBILITY (mapping-aware): report call metrics cover roster reps
  // + mapped HL users only, computed at query time (source rows untouched).
  const rosterUsers = await store.getUsers();
  const eligibility = buildRosterEligibility(rosterUsers, settings.rep_mappings ?? []);
  const rosterCallsYesterday = applyRosterEligibility(callsYesterday, eligibility);
  const rosterCallsForAttribution = applyRosterEligibility(callsForAttribution, eligibility);
  const attributionsEligible = applyAttributionEligibility(
    await store.getAttributions(),
    rosterCallsForAttribution,
    eligibility,
  );
  const metrics = buildDailyReportMetrics({
    reportDate: today,
    callsYesterday: rosterCallsYesterday,
    apptsCreatedYesterday: apptsYesterdayScoped,
    apptsCreatedWtd: apptsWtdScoped,
    allCallsForWeek: rosterCallsForAttribution,
    attributions: attributionsEligible,
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
}

// ---------- AVAILABILITY PAGE (merged-build playbook Phase 1 payload contract) ----------

/** Public contract name for one day of the availability payload. */
export type AvailabilityDay = DayAvailability;

/** Acuity freshness for the availability header (honest states only). */
export interface AvailabilityConnection {
  connected: boolean;
  /** "live" = Acuity API data; "demo" = the labeled demo dataset; "disconnected" = no usable connection. */
  mode: "live" | "demo" | "disconnected";
  lastSyncAt: string | null; // last SUCCESSFUL sync (ISO)
  stale: boolean;
}

/** Data older than this warns "Availability may be outdated" (near-real-time is the goal). */
export const ACUITY_STALE_AFTER_MS = 30 * 60_000;

/**
 * Availability payload — the next 7 operational days (ET) through the ONE
 * availability engine, plus the Acuity connection state and the Settings
 * scope filters. Same PageDeps seam as the other builders: tests inject a
 * MemoryStore + pinned `today`; the loader passes nothing.
 */
export async function availabilityPageData(deps?: PageDeps) {
  const today = deps?.today ?? etToday();
  // PERF: meta + settings + the rules mirror all independent — one parallel wave.
  const metaPromise: Promise<PageMeta> = deps?.store
    ? Promise.resolve({ mode: "memory", dbReason: null, today, demoSeeded: false })
    : loadPageMeta();
  const store = deps?.store ?? (await getStore());

  const [meta, settings, storedRules] = await Promise.all([
    metaPromise,
    store.getSettings(),
    store.getAvailabilityRules(),
  ]);

  // studio hours: availability_rules is the runtime mirror; fall back to the
  // settings rules when the mirror is empty (fresh store/tests) — never invent
  const rules = storedRules.length > 0 ? storedRules : settings.studio.hours;
  const recurring = settings.studio.recurring_blocks ?? [];

  const dayDates = Array.from({ length: 7 }, (_, off) => addDays(today, off));
  // PERF: the 7 per-day engine runs and the Acuity connection read share one wave.
  const [days, connections]: [DayAvailability[], Awaited<ReturnType<Store["getConnections"]>>] = await Promise.all([
    Promise.all(
      dayDates.map(async (date) => {
      const [appointments, blockedRaw] = await Promise.all([
        store.getAppointmentsOverlapping(etDayStartUtc(date), etDayEndUtc(date)),
        store.getBlockedTimesBetween(etDayStartUtc(date), etDayEndUtc(date)),
      ]);
      return computeDayAvailability({
        date,
        rules,
        blocked: [...blockedRaw, ...materializeRecurringBlocks(date, recurring)],
        appointments,
        slotIntervalMin: settings.studio.slot_interval_min,
        durationMin: settings.studio.appointment_duration_min,
        paddingMin: settings.studio.padding_min,
        scope: settings.acuity,
      });
    }),
    ),
    store.getConnections(),
  ]);
  const row = connections.find((c) => c.provider === "acuity") ?? null;
  const lastSuccess = row?.last_successful_sync_at ?? null;
  const lastMs = lastSuccess ? Date.parse(lastSuccess) : NaN;
  const stale =
    row?.status === "connected" && Number.isFinite(lastMs) && Date.now() - lastMs > ACUITY_STALE_AFTER_MS;
  const connection: AvailabilityConnection = {
    connected: row?.status === "connected" ?? false,
    mode: row && row.is_demo ? "demo" : row?.status === "connected" ? "live" : "disconnected",
    lastSyncAt: lastSuccess,
    stale,
  };

  // honesty warnings — acuity-only slice of the shared stale warnings, plus
  // the explicit stale/outdated and disconnected lines the spec requires
  const warnings: string[] = syncStaleWarnings(connections).filter((w) => w.startsWith("Acuity"));
  if (stale) {
    warnings.push(
      `Availability may be outdated — last successful Acuity sync was ${Math.max(1, Math.round((Date.now() - lastMs) / 60_000))} minutes ago.`,
    );
  }
  if (connection.mode === "disconnected") {
    warnings.push("Acuity connection required — availability stays unavailable (no invented slots) until Acuity connects.");
  }

  return {
    meta,
    today,
    connection,
    days,
    filters: { calendars: settings.acuity.calendars_included, types: settings.acuity.types_included },
    warnings,
  };
}
