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
import type { AttributionRow, CallRow } from "./metrics/compute";
import {
  addDays,
  dateRange,
  dailyReportAnchorDate,
  etDateStrFromInstant,
  etDayEndUtc,
  etDayStartUtc,
  etRangeBounds,
  etNowMinutes,
  etToday,
  formatDateHuman,
  formatDateHumanFull,
  isHistoricalWeek,
  isRangeMode,
  isWorkday,
  mondaysInRange,
  recentMondays,
  repOperatingState,
  resolveRange,
  weekStart,
  weekday,
  weekdayName,
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
  isBookingWin,
  materializeRecurringBlocks,
  pickupRateByDay,
  repRangeSummaries,
  resolveRepGoal,
  totalLeadConversionWeek,
} from "./metrics/compute";
import { anchorDayPhrase, big3Incomplete, buildDailyReportEmail, buildDailyReportSlack, buildDailyReportText } from "./metrics/report-text";
import { isFormSourceSheet } from "../components/lead-sources";
import { derivePaymentState } from "./payments";
import { appointmentInScope, computeDayAvailability, type DayAvailability } from "./metrics/availability";
import {
  buildWeeklyRepRows,
  celebrateDefaultLine,
  conversionRate,
  FUNNEL_SERIES_WEEKS,
  goalVsActual,
  lastCompletedWeekStart,
  monthKeyOf,
  monthStartDate,
  recentCompletedWeekStarts,
  splitChannelLeads,
  splitLeadsByType,
  splitWinOwnership,
  splitWinsByChannel,
  splitWinsBySessionType,
  weeklyDayByRepGrid,
  winsByDate,
  ALLIANCE_PIPELINE_ID,
  AUCTION_PIPELINE_ID,
  type WeekFunnelRow,
  type WeeklyDayByRepGrid,
  type WeeklyRepRow,
} from "./metrics/weekly";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "./metrics/weekly-report-text";
import {
  bestWorstSourceLines,
  buildRepCohortSourcePerformance,
  buildSourcePerformanceTable,
  computeAssignedCohortProduced,
  computeLeadCohortOutcomes,
  computeWeeklyProduction,
  crossSourceOverlap,
  resolveBookingSources,
  COHORT_WIN_LOOKBACK_DAYS,
  SOURCE_JOIN_LOOKBACK_DAYS,
  weekCohortFunnelRows,
  type CrossSourceOverlap,
  type LeadCohortSourceRow,
  type SourceBucket,
  type SourcePerformanceTable,
} from "./metrics/source-attribution";
import { deriveWeeklyHoles, type DayHoleDetail } from "./commission/derive";
import { kickAvailabilityTopUp } from "./sync/availability-feed";
import { buildAvailabilityView } from "./availability-view";
import {
  availabilityFilterOptions,
  composeAvailabilitySync,
  fourteenDayWindowLabel,
  type AvailabilityFilterOptions,
  type AvailabilitySyncPanel,
} from "./availability-view";
import { deriveDatesToPush, pushRangeLabel, type AvailabilityPushRow } from "./availability-push";
import { availabilityPushCopy, type AvailabilityCopyDay } from "../components/availability-copy";
// The args-lost honesty marker lives in the client-safe flow module (the
// availability route reads it from payload warnings to distrust a loader
// payload and self-heal) — imported here so the two can never drift.
import { AVAILABILITY_ARGS_LOST_WARNING } from "../components/availability-flow";
// Re-exported: the wiring tests assert byte-identity with the client marker.
export { AVAILABILITY_ARGS_LOST_WARNING };
import { buildAssignedLeadsByDay, type AssignedByDayGrid } from "./metrics/assigned-by-day";
import { applyAttributionEligibility, applyRosterEligibility, buildReportingEligibility, buildRosterEligibility, historicalRepIds, reportingRepUsers } from "./roster";
import { buildCallOwnershipBuckets } from "../components/reps-views";
import { serializableConnections, syncStaleWarnings, type PageMeta, type RepsSearchParams, type RepStripRow, type TeamSearchParams } from "./queries";
import { withHeartbeatWarning } from "./heartbeat-freshness"; // Reliability 2b/3 banner clause

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
  /** Injected ET wall-clock (minutes since midnight) for deterministic tests — dailyReportPageData's anchor rule uses it. */
  etNowMinutes?: number;
  /**
   * AVAILABILITY REBUILD PR-2: the range-view request (raw search strings;
   * normalized server-side). Absent → the legacy 7-day payload (its contract
   * tests); the route always passes one (default view = month of today).
   */
  view?: AvailabilityViewRawSearch;
  /**
   * 2026-10-07 triage: the handler recovered args lost in transit to the
   * route's own default (view=month). The payload names it in a warning —
   * the owner is never shown a silently substituted view.
   */
  viewArgsLost?: boolean;
}

export async function repsPageData(data?: RepsSearchParams, deps?: PageDeps) {
    const today = deps?.today ?? etToday();
    // OWNER RULING 10/29 (WRONG-3): the payload's ET wall-clock — the Coaching
    // Focus weekly-pace expectation follows the 18:30 ET day-state with it.
    const etMinutes = deps?.etNowMinutes ?? etNowMinutes();
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

    // ASSIGNED LEADS BY DAY (owner directive 2026-10-01): this section carries
    // its OWN Mon–Sun week, independent of the page's range filter — ?week=
    // accepts any date in the week and is normalized to its Monday; absent or
    // malformed falls back to the last COMPLETED week (the weekly-page rule),
    // current week included when requested.
    const weekParam = data?.week && /^\d{4}-\d{2}-\d{2}$/.test(data.week) ? data.week : null;
    const assignedMon = weekParam ? weekStart(weekParam) : lastCompletedWeekStart(today);
    const assignedSun = addDays(assignedMon, 6);

    const [users, callsRaw, apptsRaw, attributions, leads, lookBackCalls, allUsers, assignedWeekLeads, channelOpps, winsJoinRaw, leadsJoin] = await Promise.all([
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
      // ASSIGNED LEADS BY DAY: sheet leads for the section's OWN week (work-date
      // cohort — the store fetch scopes the week; the builder re-filters) …
      store.getLeadsByWorkDates(dateRange(assignedMon, assignedSun)),
      // … and the channel opportunities (owner-verified pipeline ids; the
      // builder buckets by ET created date exactly like splitChannelLeads).
      store.getOpportunitiesByPipelines([ALLIANCE_PIPELINE_ID, AUCTION_PIPELINE_ID]),
      // PER-SOURCE BOOKING ATTRIBUTION (owner directive 10/27, Step 3): wins
      // with client identity for the join + candidate leads 90 days back (the
      // documented lookback). READ-ONLY.
      // Widened to today + COHORT_WIN_LOOKBACK_DAYS for the rep cards'
      // cohort-to-date numerator (see computeAssignedCohortProduced) — the
      // booking-period audit slice below is unchanged.
      store.getWinsWithClientsBetween(addDays(range.start, -COHORT_WIN_LOOKBACK_DAYS), today),
      store.getLeadsJoinRange(addDays(range.start, -SOURCE_JOIN_LOOKBACK_DAYS), range.end),
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
    // HISTORICAL REPS (owner directive 2026-10-20): REPORTING eligibility is
    // ACTIVE ROSTER ∪ HISTORICAL REPS — a departed rep's calls/bookings stay
    // in the per-rep summaries and team totals while is_active stays false.
    // Mappings keep the buildRosterEligibility rule (active-rep targets only),
    // so a mapping pointing at a historical rep stays inert. Empty list ⇒
    // deep-identical to the previous buildRosterEligibility(allUsers) call.
    const eligibility = buildReportingEligibility(allUsers, settings);
    const historicalIds = historicalRepIds(allUsers, settings.historical_reps ?? []);
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

    // The REPORTING rep list: active roster ∪ historical reps (see above).
    // reportingRepUsers returns the SAME rows/order as the previous
    // users.map(...) when historical_reps is empty.
    const reps = reportingRepUsers(allUsers, settings.historical_reps ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      call_start_date: u.call_start_date,
    }));

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

    // ASSIGNED LEADS BY DAY grid (owner directive 2026-10-01) — pure builder
    // over the two verified sources; no new math (module doc: assigned-by-day).
    const assignedByDay: AssignedByDayGrid = buildAssignedLeadsByDay({
      leads: assignedWeekLeads,
      opps: channelOpps,
      rosterReps: reps.map((r) => ({ id: r.id, name: r.name })),
      nameById: new Map(allUsers.map((u) => [u.id, u.name])),
      mon: assignedMon,
      sun: assignedSun,
    });

    // PER-SOURCE BOOKING ATTRIBUTION (owner directive 2026-10-27, Step 3):
    // which sources a rep's ATTRIBUTED bookings came from — bookings counted
    // ONLY through the attribution verdict (bookingsByRep semantics; manual
    // overrides are rep bookings, no-rep wins never a rep row — rev-13), the
    // source from the contact's NEAREST sheet lead. Conversion denominators =
    // the range's assigned leads per source (this page's work-date cohort),
    // form sources EXCLUDED per the standing owner rule (form-source leads
    // are team totals, never rep metrics) — their conversion renders "—".
    const winsJoin = filterApptsInWinBucketRange(winsJoinRaw, range.start, range.end).filter((a) =>
      isBookingWin(a) && appointmentInScope(a, settings.acuity),
    );
    const byWinSource = resolveBookingSources(winsJoin, leadsJoin);
    // REP-CARD COHORT SCOPING (owner directive 2026-10-27, part 2, AMENDED by
    // the work-date alignment directive): Assigned Leads stays the work-date
    // cohort (UNCHANGED denominator: assigned rows only, form sheets
    // excluded — owner rule: form-source leads are team totals, never rep
    // metrics); Bookings is now the COHORT-TO-DATE numerator — DISTINCT
    // assigned cohort leads that produced ≥1 qualifying paid booking EVER,
    // credited by LEAD ASSIGNMENT (whichever rep or channel later worked the
    // booking). Verdict-based prior/later/no-link/form wins stay in the
    // card's collapsed detail so nothing is hidden.
    const assignedCohortLeads = leads.filter((l) => l.assigned_rep_id && !isFormSourceSheet(l.source_sheet));
    // The produced sets ride the same getLeadsJoinRange projection
    // (work_date + assigned_rep_id + identity columns). Wins through today
    // (fetch widened above); causality inside the shared machinery.
    const winsCohortReps = filterApptsInWinBucketRange(winsJoinRaw, addDays(range.start, -COHORT_WIN_LOOKBACK_DAYS), today).filter(
      (a) => isBookingWin(a) && appointmentInScope(a, settings.acuity),
    );
    const wdCohortJoinRows = leadsJoin.filter((l) => l.work_date != null && l.work_date >= range.start && l.work_date <= range.end);
    const repProduced = computeAssignedCohortProduced(wdCohortJoinRows, winsCohortReps, { start: range.start, end: range.end });
    const buildRepSourcePerformanceInput = (id: string | null) =>
      buildRepCohortSourcePerformance({
        repId: id,
        wins: winsJoin,
        attributions: attributionsEligible,
        byWinSource,
        assignedCohortLeads,
        period: { start: range.start, end: range.end },
        cohortProducedLeadIds: (id ? repProduced.producedByRep.get(id) : undefined) ?? new Map(),
        cohortProducedInPeriodLeadIds: (id ? repProduced.producedInPeriodByRep.get(id) : undefined) ?? new Map(),
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
    // OWNER RULING 10/29 (WRONG-2): the team-share goal divisor is the ACTIVE
    // PRODUCTION ROSTER on current periods — the same count Today and the Team
    // page use (departed reps never dilute the share). HISTORICAL periods: no
    // per-period roster snapshot exists (settings.active_roster is current
    // state only), so the divisor falls back to the roster of reps who
    // actually PARTICIPATED in the period (≥1 qualifying win or call in
    // range). Departed participants keep displaying and keep counting toward
    // the share they worked under — never erased, and never every-rep-ever.
    const currentPeriod = range.end >= today;
    const participatedRepCount = reps.filter((r) => {
      const ps = summaries.get(r.id);
      return !!ps && (ps.totalBookings > 0 || ps.totalCalls > 0);
    }).length;
    const repCountForGoal = currentPeriod ? users.length : participatedRepCount;
    const goal = rep
      ? resolveRepGoal({
          weeks,
          repGoalsByWeek,
          teamGoalByWeek,
          repCount: repCountForGoal,
        })
      : null;
    const detail = rep && metrics ? buildRepDetail({ rep, metrics, goal, weeks }) : null;
    const comparisons = metrics ? compareWithTeam(metrics, teamAverages) : [];
    const repSourcePerformance = {
      ...buildRepSourcePerformanceInput(rep?.id ?? null),
      repName: rep?.name ?? null,
      note:
        "Bookings = COHORT-TO-DATE produced (work-date alignment): the DISTINCT leads assigned to this rep from that source during the selected period that have produced a qualifying paid booking, counted to date and credited by LEAD ASSIGNMENT (whichever rep or channel later worked the booking — the attribution verdict is not part of this numerator). Assigned Leads = the same work-date assigned cohort (unchanged denominator); Conv % = produced ÷ assigned. The card's Attribution detail below distinguishes produced-in-period vs produced-later and keeps the verdict-based audit (prior-period, later-period, truly-unattributed, team-level form-source wins) so nothing is hidden. Form-source rows show no rep numbers by the owner's rule (form-source leads are team totals, never rep metrics): their volume and conversion live on the Weekly tab, so their cohort here is empty (Bookings 0, Assigned —).",
    };

    // missing-data warnings — never render a plausible number for absent data.
    // A "Not Yet Active" rep (call_start_date in the future) EXPECTS zero
    // calls: no zero-activity warning, ever (owner spec).
    // Reliability 2b/3: + the shared heartbeat staleness clause.
    const warnings: string[] = await withHeartbeatWarning([...syncStaleWarnings(await store.getConnections())]);
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
      // OWNER RULING 10/29 (WRONG-3): presentation clock for the coaching
      // pace expectation (18:30 ET day-state; null-safe for legacy callers).
      etNowMinutes: etMinutes,
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
          // PAST marker (owner directive: nobody reads her as a current booker).
          // Requires is_active=false too — an ACTIVE rep listed in
          // historical_reps by mistake is never rendered as "past".
          historical: historicalIds.has(r.id) && !r.is_active,
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
      assignedByDay,
      repSourcePerformance,
      assignedWeek: {
        mon: assignedMon,
        sun: assignedSun,
        // picker options: current operating week first, ~3 months back — covers
        // the entire synced Sheets window (2026-08-24+); any other week remains
        // reachable by URL (?week=<date>).
        mondays: recentMondays(today, 12),
      },
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
      // OWNER 18:30 RULE: pace days-left excludes today at/after 18:30 ET.
      etNowMinutes: etNowMinutes(),
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

    // OWNER RULING 10/29 (WRONG-2): the team-share goal divisor is the ACTIVE
    // PRODUCTION ROSTER on current periods (Today and the Reps page now agree;
    // departed reps never dilute the share). HISTORICAL periods: no per-period
    // roster snapshot exists, so the divisor falls back to the roster of reps
    // who actually PARTICIPATED in the period (≥1 qualifying win or call in
    // range) — the documented owner fallback; never every-rep-ever.
    const currentPeriod = range.end >= today;
    const participatedRepCount = reps.filter((r) => {
      const ps = summaries.get(r.id);
      return !!ps && (ps.totalBookings > 0 || ps.totalCalls > 0);
    }).length;
    const repCountForGoal = currentPeriod ? reps.length : participatedRepCount;

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
          goal: resolveRepGoal({ weeks, repGoalsByWeek, teamGoalByWeek, repCount: repCountForGoal }),
          operatingState: repOperatingState(r.call_start_date, today),
          callStartDate: r.call_start_date ?? null,
        };
      })
      .sort((a, b) => b.totalBookings - a.totalBookings || b.callsOverThreshold - a.callsOverThreshold);

    // missing-data warnings — never render a plausible number for absent data
    // Reliability 2b/3: + the shared heartbeat staleness clause.
    const warnings: string[] = await withHeartbeatWarning([...syncStaleWarnings(await store.getConnections())]);
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
      // OWNER REQUEST 9/30 (✕ dismiss): exclude pending_dismissed_at rows at
      // the query layer — a dismissed appointment leaves the pending list
      // PERMANENTLY (the dismissal is owner-controlled state the sync never
      // touches). Only this fetch passes the flag: wins/metrics read the
      // separate win-bucket selectors and the attribution tick + unattributed
      // queue use the default, so dismissed appointments stay in the engine.
      store.getAppointmentsWithClientsSince(etDayStartUtc(addDays(today, -30)), { excludePendingDismissed: true }),
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
    // OWNER RULING 10/29 (WRONG-1): the team Assigned Lead Conversion
    // denominator counts assigned leads credited to ACTIVE reps only — the
    // same rule the Team page applies (departed reps' rows stay in the DB,
    // never in team rollups).
    activeRepIds: new Set(todayReps.map((r) => r.id)),
    // OWNER 18:30 RULE: pace days-left excludes today at/after 18:30 ET.
    etNowMinutes: etNowMinutes(),
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
    staleWarnings: await withHeartbeatWarning(syncStaleWarnings(connections)),
    cohortNote: `Today's cohort = leads logged (sheet date) on ${metrics.leadCohortSourceDates.join(", ")} · Family · Animalia · Fairyland sheets + 4 Forms Data tabs (Auction certificates, Google Ads, Alliance certificates, Website applications) — worked today under work-date logic`,
  };
}

/** DAILY REPORT page — anchor-day performance + current week progress. */
export async function dailyReportPageData(deps?: PageDeps) {
  const today = deps?.today ?? etToday();
  const etMinutes = deps?.etNowMinutes ?? etNowMinutes();
  // OWNER ANCHOR RULE (dailyReportAnchorDate): performance figures cover the
  // most recent COMPLETE operating day — today after 18:30 ET, else the most
  // recent prior workday (Mon→Fri, Tue–Fri→yesterday, Sat/Sun→Fri).
  const anchorDate = dailyReportAnchorDate(today, etMinutes);
  // PERF: meta + settings run inside the main batch (were sequential before it).
  const metaPromise: Promise<PageMeta> = deps?.store
    ? Promise.resolve({ mode: "memory", dbReason: null, today, demoSeeded: false })
    : loadPageMeta();
  const store = deps?.store ?? (await getStore());

  const ws = weekStart(today);

  const todayStart = etDayStartUtc(today);
  const anchorStart = etDayStartUtc(anchorDate);
  const weekStartUtc = etDayStartUtc(ws);
  // The join pool (conversation conversion) and the lead cohorts must cover the
  // anchor day even when it falls in the PREVIOUS week (Monday morning →
  // Friday) — widen the fetch floors, never the filters downstream.
  const poolStartUtc = anchorStart < weekStartUtc ? anchorStart : weekStartUtc;
  const workDatesFrom = anchorDate < ws ? anchorDate : ws;

  const [meta, settings, callsAnchorDay, apptsAnchorDay, apptsWtd, callsForAttribution, leads, teamGoal, priorities, leadAdjustments] =
    await Promise.all([
      metaPromise,
      store.getSettings(),
      // roster-eligible calls STARTED on the anchor day (conversation conversion)
      store.getCallsBetween(anchorStart, etDayEndUtc(anchorDate)),
      // REV 12 WIN BUCKET + owner anchor: anchor-day/WTD = BOOKING WINS by
      // deposit date (booking_win_business_date); not-yet-derived rows fall
      // back to created.
      store.getAppointmentsByWinBusinessDateBetween(anchorDate, anchorDate),
      store.getAppointmentsByWinBusinessDateBetween(ws, today),
      store.getAllCallsSince(poolStartUtc),
      // all leads worked from the anchor week-floor through today — covers the
      // anchor-day cohort (e.g. Friday's, for Monday mornings) and today's
      store.getLeadsByWorkDates(dateRange(workDatesFrom, today)),
      store.getTeamGoal(ws),
      store.getDailyPriorities(today),
      store.getLeadCountAdjustments(dateRange(workDatesFrom, addDays(ws, 6))),
    ]);

  const scope = settings.acuity;
  // Scope BEFORE any booking computation (owner directive — see apptsInScope).
  const apptsAnchorDayScoped = apptsInScope(apptsAnchorDay, scope);
  const apptsWtdScoped = apptsInScope(apptsWtd, scope);
  // ROSTER ELIGIBILITY (mapping-aware): report call metrics cover roster reps
  // + mapped HL users only, computed at query time (source rows untouched).
  const rosterUsers = await store.getUsers();
  const eligibility = buildRosterEligibility(rosterUsers, settings.rep_mappings ?? []);
  const rosterCallsAnchorDay = applyRosterEligibility(callsAnchorDay, eligibility);
  const rosterCallsForAttribution = applyRosterEligibility(callsForAttribution, eligibility);
  const attributionsEligible = applyAttributionEligibility(
    await store.getAttributions(),
    rosterCallsForAttribution,
    eligibility,
  );
  const metrics = buildDailyReportMetrics({
    reportDate: today,
    callsAnchorDay: rosterCallsAnchorDay,
    apptsCreatedAnchorDay: apptsAnchorDayScoped,
    apptsCreatedWtd: apptsWtdScoped,
    // OWNER DIRECTIVE 10/30 (post-#126 fix): the week lines (Bookings WTD /
    // Left / % of goal / Total Lead Conversion — Week numerator) consume the
    // canonical QUALIFYING WTD chain inside buildDailyReportMetrics — the
    // SAME deposit-date count the Today strip shows (pending payments and
    // cancelled-after-payment rows never count). No weekProduction input:
    // the created-Mon–Sun gross stays the WEEKLY hero's display only.
    allCallsForWeek: rosterCallsForAttribution,
    attributions: attributionsEligible,
    leadsAllRecent: leads,
    leadCountAdjustments: leadAdjustments,
    teamBookingGoal: teamGoal?.booking_goal ?? 79,
    weeklyLeadBudget: teamGoal?.lead_budget ?? 700,
    thresholdSeconds: settings.meaningful_call_threshold_seconds,
    // OWNER RULING 10/29 (WRONG-1): anchor-day Assigned Lead Conversion counts
    // assigned leads credited to ACTIVE reps only (Team-page rule).
    activeRepIds: new Set(rosterUsers.map((u) => u.id)),
    // OWNER 18:30 RULE: pace days-left excludes today at/after 18:30 ET, and
    // the performance anchor follows the same cutoff.
    etNowMinutes: etMinutes,
  });
  const saved = priorities ?? { date: today, priority1: null, priority2: null, priority3: null, updated_at: null };
  // Missing-data warnings — never render a plausible number for absent data.
  // The banners name the ACTUAL day the figures cover (owner directive): the
  // phrase is "yesterday" only when the anchor really is the calendar prior
  // day; on a Monday-morning report it names Friday, after EOD it says today.
  const anchorPhrase = anchorDayPhrase(anchorDate, today);
  const warnings: string[] = [];
  // OWNER DIRECTIVE 10/30: the warnings follow the REPLACED lines — the
  // total-lead conversion lines are the report's conversion figures now.
  if (metrics.totalLeadConversionYesterday == null)
    warnings.push(`No leads worked ${anchorPhrase} — Total Lead Conversion — Yesterday is unavailable.`);
  if (metrics.totalLeadConversionWeek == null)
    warnings.push("No leads in this week's cohort yet — Total Lead Conversion — Week is unavailable.");
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
    warnings: await withHeartbeatWarning([...syncStaleWarnings(await store.getConnections()), ...warnings]),
    reportText,
    emailText: buildDailyReportEmail(metrics, saved),
    slackText: buildDailyReportSlack(metrics, saved),
    cohortNote: `Today's cohort = leads logged (sheet date) on ${metrics.leadCohortSourceDates.join(", ")} · Family · Animalia · Fairyland sheets + 4 Forms Data tabs (Auction certificates, Google Ads, Alliance certificates, Website applications) — worked today under work-date logic`,
  };
}

// ---------- AVAILABILITY PAGE (merged-build playbook Phase 1 payload contract) ----------

/** Public contract name for one day of the availability payload. */
export type AvailabilityDay = DayAvailability;

/** Public contract name for the wave-2 holes adjacency map (per displayed date). */
export type { DayHoleDetail };

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

  // ---- AVAILABILITY REBUILD PR-2: range views (Month default / 14-Day / Day) ----
  // A view request swaps the legacy 7-day strip payload for the range-view
  // payload (the route always sends one — default = month of today; the
  // contract tests don't, so the legacy path below stays byte-identical).
  const viewRequest = normalizeAvailabilityView(deps?.view, today);
  if (viewRequest) {
    // PR-3 §3/§4: the filter options come from the CACHED catalog (written by
    // every feed run), the sync panel from the feed's run rows + the
    // unresolved discrepancy list — all cache reads, no API calls.
    const [view, connections, catalog, feedRuns, discrepancies] = await Promise.all([
      buildAvailabilityView({ store, today, settings, rules, recurring, request: viewRequest }),
      store.getConnections(),
      store.getAvailabilityCatalog(),
      store.getAvailabilitySyncRuns(10),
      store.getAvailabilityDiscrepancies({ unresolvedOnly: true, limit: 200 }),
    ]);
    const { connection, warnings } = availabilityConnectionState(connections);
    if (deps?.viewArgsLost) {
      warnings.push(AVAILABILITY_ARGS_LOST_WARNING);
    }
    // PR-1's designed page-loader top-up: read the cache NOW, kick ONE bounded
    // background run for what the visible range is missing — never awaited
    // (SSR stays fast; the next load or tick sees fresh cache), and a no-op
    // under test/demo (no client resolves there). A range with no future dates
    // never triggers calls (the feed has no past availability worth caching).
    if (view.dates.some((d) => d >= today)) {
      kickAvailabilityTopUp({ dates: view.dates }, { store });
    }
    // §10 copy targets: ONE extra cache-read build of the rolling 14-day
    // window (today..today+13) backs Today / Next 7 / Next 14 / the
    // specific-date picker in EVERY view — a visible month alone cannot answer
    // a window that crosses its edge. Skipped when the request already IS
    // that window (the 14-Day view's own build is reused).
    const isCopyBase = viewRequest.kind === "days" && viewRequest.from === today;
    const copyView = isCopyBase
      ? view
      : await buildAvailabilityView({
          store,
          today,
          settings,
          rules,
          recurring,
          request: {
            kind: "days",
            month: "",
            from: today,
            to: addDays(today, AVAILABILITY_DAYS_VIEW_WINDOW - 1),
            date: "",
            filters: viewRequest.filters,
          },
        });
    const copyDays = copyView.days.map(toCopyDay);
    const copyByDate: Record<string, string> = {};
    for (const d of copyDays) copyByDate[d.date] = availabilityPushCopy([d]);
    // §7 push rows derive ONCE off the view payload's days — the pageView
    // field AND the copy target read the same rows (deriveDatesToPush is
    // pure, but two calls would invite drift; the copy mapper reshapes,
    // never re-sorts).
    const pushRows = deriveDatesToPush(view.days, today);
    const pageView: AvailabilityPageView = {
      ...view,
      filterOptions: availabilityFilterOptions(catalog),
      sync: composeAvailabilitySync({
        connection,
        feedRuns,
        discrepancies,
        coverageHorizonDate: view.coverage.horizonDate,
        noFeedData: view.coverage.noFeedData,
      }),
      datesToPush: pushRows,
      pushRangeLabel: pushRangeLabel(
        { kind: viewRequest.kind, label: view.label },
        fourteenDayWindowLabel(today),
      ),
      copy: {
        today: copyByDate[today] ?? availabilityPushCopy([]),
        next7: availabilityPushCopy(copyDays.filter((d) => d.date >= today && d.date < addDays(today, 7))),
        next14: availabilityPushCopy(copyDays),
        datesToPush: availabilityPushCopy(
          pushRows.map((r) => ({
            date: r.date,
            openCount: r.openings,
            holes: r.holes,
            capacity: r.capacity,
            booked: r.booked,
            utilization: r.utilization,
          })),
        ),
        day: viewRequest.kind === "day" ? availabilityPushCopy(view.days.map(toCopyDay)) : null,
        copyDates: copyDays.map((d) => d.date),
        byDate: copyByDate,
      },
    };
    return {
      meta,
      today,
      connection,
      days: [] as AvailabilityDay[],
      holesByDate: {} as Record<string, DayHoleDetail>,
      filters: { calendars: settings.acuity.calendars_included, types: settings.acuity.types_included },
      warnings: [...warnings, ...view.warnings],
      view: pageView,
    };
  }

  const dayDates = Array.from({ length: 7 }, (_, off) => addDays(today, off));
  // Wave-2 holes adjacency input: the raw per-day overlap rows, kept before
  // the availability engine scopes them (the holes derivation consumes the
  // UNscoped superset — exactly what the Weekly report feeds deriveWeeklyHoles).
  const apptRowsByDate = new Map<string, AppointmentRow[]>();
  // PERF: the 7 per-day engine runs and the Acuity connection read share one wave.
  const [days, connections]: [DayAvailability[], Awaited<ReturnType<Store["getConnections"]>>] = await Promise.all([
    Promise.all(
      dayDates.map(async (date) => {
      const [appointments, blockedRaw] = await Promise.all([
        store.getAppointmentsOverlapping(etDayStartUtc(date), etDayEndUtc(date)),
        store.getBlockedTimesBetween(etDayStartUtc(date), etDayEndUtc(date)),
      ]);
      apptRowsByDate.set(date, appointments);
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

  // ---- OWNER HOLES ADJACENCY (wave 2) ----
  // Per-day holes for the 7 displayed dates, derived by the SAME
  // deriveWeeklyHoles the Weekly report + copied CC Report use (#34) — one
  // derivation, no second engine, no redefined arithmetic. The per-day
  // overlap fetches above are exactly the superset the derivation consumes
  // (getAppointmentsOverlapping per ET day); the union is deduped by row id
  // (one appointment can touch two adjacent ET days) and each covered Mon–Sun
  // week runs once. ONLY per-day details for the displayed dates are exposed:
  // every displayed date's own overlap fetch is complete, so its per-day
  // holes are real — a week whose coverage is partial never exposes its
  // AGGREGATE here (that would fabricate against the Weekly page's number).
  const weeksCovered = [...new Set(dayDates.map((d) => weekStart(d)))].sort();
  const unionById = new Map<string, AppointmentRow>();
  for (const rows of apptRowsByDate.values()) for (const a of rows) unionById.set(a.id, a);
  const sessionAppts = [...unionById.values()];
  const holesByDate: Record<string, DayHoleDetail> = {};
  for (const mon of weeksCovered) {
    const w = deriveWeeklyHoles({ weekStart: mon, sessionAppts });
    for (const d of w.days) if (dayDates.includes(d.date)) holesByDate[d.date] = d;
  }

  return {
    meta,
    today,
    connection,
    days,
    holesByDate,
    filters: { calendars: settings.acuity.calendars_included, types: settings.acuity.types_included },
    warnings,
  };
}

// ---------- AVAILABILITY REBUILD PR-2: range views (Month default / 14-Day / Day) ----------
// Blueprint: /home/team/shared/design/availability-rebuild-investigation.md §6
// PR-2 + owner directive §2–§4, §6, §8–§9. One builder, three view kinds, ONE
// availability engine (computeDayAvailability) for every count, ONE hole
// derivation (deriveAvailabilityHoles in availability-feed.ts — the PR-2
// placeholder is the current rule; PR-3 swaps the owner's pick by editing only
// that body), and the PR-1 feed cache as the ONLY Acuity source (the loader
// never awaits API calls — it reads the cache and kicks a bounded top-up).

/** Raw search fields the availability route passes through (normalized below). */
export interface AvailabilityViewRawSearch {
  view?: string;
  month?: string;
  from?: string;
  to?: string;
  date?: string;
  /** PR-3 §3 page-level filters (comma-separated): calendar IDs, appointment-type NAMES, status tokens. */
  cal?: string;
  type?: string;
  st?: string;
}

export type AvailabilityViewKind = "month" | "days" | "day";

/** The 14-Day view's rolling window length. */
export const AVAILABILITY_DAYS_VIEW_WINDOW = 14;

/**
 * PR-3 §3 — the availability page's own filters. They NARROW the Settings
 * scope server-side (through the existing appointmentInScope machinery —
 * page-level can never widen past Settings); empty = everything in scope.
 * Status toggles filter the Day view's slot LIST only (counts stay whole-day).
 */
export interface AvailabilityPageFilters {
  /** Calendar IDs (the machinery matches id or name). */
  calendars: string[];
  /** Appointment type NAMES (the machinery compares appointment_type). */
  types: string[];
  /** Slot-list tokens: booked | open | holes | cancelled | blocked. */
  statuses: string[];
}

export const AVAILABILITY_STATUS_TOKENS = ["booked", "open", "holes", "cancelled", "blocked"] as const;

export interface AvailabilityViewRequest {
  kind: AvailabilityViewKind;
  /** kind=month → the visible month "YYYY-MM"; "" otherwise. */
  month: string;
  /** kind=days → window start (the end is start + window − 1). */
  from: string;
  to: string;
  /** kind=day → the single date. */
  date: string;
  /** The page-level filters (empty = everything in scope). */
  filters: AvailabilityPageFilters;
}

const AVAIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AVAIL_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Normalize the raw search into a view request — PURE. Invalid/absent fields
 * fall back to honest defaults (month of today / today), never an error page.
 * Filter lists are comma-separated; unknown status tokens are dropped (a
 * typo'd token must not silently empty the slot list — dropping it narrows
 * less, which is the honest direction); calendar/type values pass through
 * as-is (an unmatched value honestly yields an empty in-scope set).
 * `null` = no view requested (the legacy 7-day payload contract keeps running
 * for anything that does not opt in).
 */
export function normalizeAvailabilityView(
  raw: AvailabilityViewRawSearch | undefined,
  today: string,
): AvailabilityViewRequest | null {
  if (
    !raw ||
    (raw.view == null && raw.month == null && raw.from == null && raw.to == null && raw.date == null && raw.cal == null && raw.type == null && raw.st == null)
  ) {
    return null;
  }
  const csv = (v: string | undefined): string[] =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  const validStatuses = csv(raw.st).filter((s) => (AVAILABILITY_STATUS_TOKENS as readonly string[]).includes(s));
  const filters: AvailabilityPageFilters = { calendars: csv(raw.cal), types: csv(raw.type), statuses: validStatuses };
  const validDate = (v: string | undefined) => (v && AVAIL_DATE_RE.test(v) ? v : null);
  const validMonth = (v: string | undefined) => (v && AVAIL_MONTH_RE.test(v) ? v : null);
  if (raw.view === "day") {
    return { kind: "day", month: "", from: "", to: "", date: validDate(raw.date) ?? today, filters };
  }
  if (raw.view === "days") {
    const from = validDate(raw.from) ?? today;
    return { kind: "days", month: "", from, to: addDays(from, AVAILABILITY_DAYS_VIEW_WINDOW - 1), date: "", filters };
  }
  return { kind: "month", month: validMonth(raw.month) ?? monthKeyOf(today), from: "", to: "", date: "", filters };
}

/** The ET dates a view request displays (month → its calendar dates; days → the window; day → itself). PURE. */
export { availabilityViewDates } from "./availability-view";

/** How one day's OPEN numbers were produced — the honesty state the views render. */
export type AvailabilityAcuityState =
  | "feed" // Acuity-authoritative inside the coverage horizon (feed ∖ booked)
  | "estimated" // past the horizon / sweep snapshot — grid − booked arithmetic, labeled
  | "past" // before today: booked-truth territory, the engine numbers are what happened
  | "none"; // the month has no cached sweep yet — Open renders "—" (never a bare 0)

export interface AvailabilityRangeDay {
  date: string;
  totalCapacity: number;
  /** DISTINCT engine-booked slots (doubles collapse — the calendar-fill accuracy item). */
  booked: number;
  /** The displayed open count: feed-authoritative, engine-estimated, real 0 when feed-closed — null when no coverage. */
  openCount: number | null;
  /** The engine's open slot labels (the studio-schedule estimate / past-truth set). */
  openSlotTimes: string[];
  utilization: number | null;
  blockedCount: number;
  /** deriveAvailabilityHoles — the ONE hole derivation (current rule placeholder). */
  holes: number;
  acuity: AvailabilityAcuityState;
  /** Feed open ∖ booked (HH:mm sorted) when the feed answers with times; null otherwise. */
  feedOpenTimes: string[] | null;
  /** The month index marks the date open but the per-date times are not probed yet. */
  feedPending: boolean;
  /** This day sits past the coverage horizon (the month's "Beyond Acuity booking horizon" label). */
  beyondHorizon: boolean;
}

export interface AvailabilityRangeSummary {
  capacity: number;
  booked: number;
  /** Sum over days with a known open count; the UI renders "—" when openKnown is false. */
  open: number;
  holes: number;
  utilization: number | null;
  /** false when at least one visible day has no Acuity coverage — Open renders "—" honestly. */
  openKnown: boolean;
}

/**
 * Per-slot availability state (Day view). CANCELLED renders struck-through on
 * the slot's row; CLOSED = a feed-observed closed day's empty slots (PR-3 §5
 * polish — chips agree with the day's real 0 open).
 */
export type AvailabilitySlotStatus = "booked" | "booked-pending" | "open" | "blocked" | "cancelled" | "closed";

export interface AvailabilitySlotAppointment {
  id: string;
  clientName: string | null;
  appointmentType: string;
  calendarName: string | null;
  cancelled: boolean;
  cancelledAt: string | null;
  paymentState: string | null;
  durationMinutes: number | null;
}

export interface AvailabilitySlotView {
  /** "09:00" (HH:mm ET — the feed's shape) for grid slots; off-grid feed times keep their own. */
  time: string;
  /** "9:00 AM" — the engine's slot label shape. */
  label: string;
  status: AvailabilitySlotStatus;
  /** The hole definition counts this slot (OPEN·HOLE — the §9 token). */
  isHole: boolean;
  /** Open/hole derived from the studio schedule rather than the feed. */
  estimated: boolean;
  /** "Unexplained — not offered by Acuity (candidate block)" etc.; null when plain. */
  reason: string | null;
  /** Gray "unexplained" rendering (inferred candidate block — never claimed as a real block). */
  unexplained: boolean;
  /** A dashboard/recurring block or the turnover buffer occupies the slot's interval. */
  blocked: boolean;
  /** Active (non-cancelled, in-scope) appointments whose session overlaps the slot, chronological. */
  appointments: AvailabilitySlotAppointment[];
  /** Cancelled rows whose session overlaps the slot — struck-through, Day view only. */
  cancelledAppointments: AvailabilitySlotAppointment[];
  /** activeCount − 1 — the "+n" badge (distinct-slot counting). */
  extraCount: number;
  /** A feed-offered time outside the generated grid (extra row after the grid, Day view). */
  offGrid: boolean;
}

export interface AvailabilityCoverageView {
  /** Last date any calendar still offered slots (null = the feed has no cached data at all). */
  horizonDate: string | null;
  months: Array<{ month: string; calendarCount: number; offeredDates: number; fetchedAt: string | null }>;
  /** Months with a cached sweep (the feed answered them, [] included). */
  coveredMonths: string[];
  /** NOTHING is cached (feed never ran / demo) — engine output renders everywhere (existing behavior). */
  noFeedData: boolean;
}

export interface AvailabilityViewPayload {
  kind: AvailabilityViewKind;
  month: string;
  from: string;
  to: string;
  date: string;
  /** "October 2026" / "Oct 6 – Oct 19, 2026" / "Tuesday, October 13, 2026" — the summary heading. */
  label: string;
  dates: string[];
  days: AvailabilityRangeDay[];
  summary: AvailabilityRangeSummary;
  /** Day view only: the chronological slot list (grid slots + off-grid feed times). */
  slots: AvailabilitySlotView[] | null;
  /** Day view only: active in-scope appointments on the date outside every generated slot. */
  offGridAppointments: AvailabilitySlotAppointment[];
  coverage: AvailabilityCoverageView;
  /** The "Beyond Acuity booking horizon — estimated" month label. */
  beyondHorizon: boolean;
  /** Any visible day lacks a cached sweep (Open renders "—" for those days). */
  hasUncoveredDays: boolean;
  /** Range-level honesty lines (the page banner appends them). */
  warnings: string[];
}

/**
 * The availability page's FULL view payload (PR-3): the range view plus the
 * Dates-to-Push rows, the filter options and the sync panel — everything the
 * rebuilt route renders, all from cache reads + the ONE engine.
 */
export type AvailabilityPageView = AvailabilityViewPayload & {
  /** §7 Dates to Push — priority-sorted (holes → openings → utilization → date). */
  datesToPush: AvailabilityPushRow[];
  /** Which range the push list covers ("visible month October 2026" / "the 14-day window …"). */
  pushRangeLabel: string;
  /** §11 filter options from the CACHED /calendars + /appointment-types catalog. */
  filterOptions: AvailabilityFilterOptions;
  /** §1 sync visibility: both sync rows, coverage horizon, discrepancy list. */
  sync: AvailabilitySyncPanel;
  /** §10 copy targets — frozen block texts + the per-date map backing the specific-date picker. */
  copy: {
    today: string;
    next7: string;
    next14: string;
    datesToPush: string;
    /** Day view only — the visible day's own block; null elsewhere. */
    day: string | null;
    /** ET dates the specific-date picker can copy (today … today+13). */
    copyDates: string[];
    byDate: Record<string, string>;
  };
};

/** The view day's honest displayed numbers, in the copy formatters' shape. */
function toCopyDay(d: AvailabilityRangeDay): AvailabilityCopyDay {
  return { date: d.date, openCount: d.openCount, holes: d.holes, capacity: d.totalCapacity, booked: d.booked, utilization: d.utilization };
}

/** Acuity connection state + the stale/disconnected honesty lines (mirrors the legacy path exactly). */
function availabilityConnectionState(connections: Awaited<ReturnType<Store["getConnections"]>>): {
  connection: AvailabilityConnection;
  warnings: string[];
} {
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
  const warnings: string[] = syncStaleWarnings(connections).filter((w) => w.startsWith("Acuity"));
  if (stale) {
    warnings.push(
      `Availability may be outdated — last successful Acuity sync was ${Math.max(1, Math.round((Date.now() - lastMs) / 60_000))} minutes ago.`,
    );
  }
  if (connection.mode === "disconnected") {
    warnings.push("Acuity connection required — availability stays unavailable (no invented slots) until Acuity connects.");
  }
  return { connection, warnings };
}

// ---------- WEEKLY REPORT (owner directive 2026-09-29: the Monday leadership
// report as one page instead of hand-pulled SQL) ----------

/** One calendar-fill bucket (a Mon–Sun week) of the weekly report. */
export interface WeeklyCalendarBucket {
  label: string;
  start: string;
  end: string;
  /**
   * Raw non-cancelled in-scope SESSIONS whose session date falls in the bucket
   * — the appointment count, kept for transparency. The FILL number is
   * `slotsOccupied` (owner report 2026-10-06 "CALENDAR-FILL ACCURACY": 65
   * sessions sat on only 61 distinct slots — a double-booked slot fills ONE
   * slot; the sessions figure carries the excess so nothing is hidden).
   */
  appointments: number;
  /**
   * DISTINCT engine-grid slots the bucket's sessions occupy (owner directive:
   * calendar fill counts DISTINCT SLOTS occupied — a double-booked slot
   * counts once toward booked/capacity-fill, its extra sessions stay visible
   * in the sessions figure). ONE engine: computeDayAvailability per ET date,
   * `booked` summed over the bucket's 7 days. Same basis as the Availability
   * page's booked counts. RULING 9 (owner ruling 10/11): pending_payment
   * sessions do NOT occupy — a pending-only slot counts OPEN here (the
   * pending session stays visible in the raw appointments figure).
   */
  slotsOccupied: number;
  /** Slots the studio schedule config offers across the bucket's 7 days (derived, never hardcoded). */
  capacity: number;
  /**
   * OWNER HOLES (RULING 8, owner ruling 10/11): empty booking slots = derived
   * capacity (10/day, 9 Tue — the commission engine's schedule) − DISTINCT
   * on-grid slots occupied per ET day (cancelled excluded; a double-booked
   * slot fills one slot), within the same Mon–Sun working week — with the
   * per-day breakdown. The holes object keeps `booked` = the RAW session
   * count so overbooking stays visible alongside. Derived by the SAME
   * deriveWeeklyHoles the copied report uses. Null →
   * "—" (holes not defined for the bucket — never a fabricated number).
   */
  holes: { capacity: number; booked: number; holes: number; days: DayHoleDetail[] } | null;
}

/** The weekly report payload contract (route + tests consume this). */
export interface WeeklyPageData {
  meta: PageMeta;
  today: string;
  week: { start: string; end: string; caption: string };
  /** Current ET calendar month of the MTD bucket — key 'YYYY-MM', start..end ET dates. */
  month: { key: string; start: string; end: string };
  /** Last week's booking wins vs the stored weekly team goal. */
  bookings: {
    total: number;
    family: number;
    animalia: number;
    goal: number;
    /** "X/Goal (±N)" presentation string. */
    goalLine: string;
    daily: { date: string; count: number }[];
    repRows: WeeklyRepRow[];
    /** Wins with no attribution rep — team total only, NEVER a rep row (rev-13). */
    unattributed: number;
    /**
     * PER-DAY × PER-REP wins grid (owner request 2026-10-19): same wins, same
     * win-bucket dates as `daily`, same attribution join as `repRows` —
     * dashboard-only (never in the copied CC Report text).
     */
    dayByRep: WeeklyDayByRepGrid;
    /**
     * THE PRODUCTION BLOCK (owner Final Booking Logic 10/28, audit-79v84) —
     * the hero's four-number view: gross = qualifying (paid-deposit) bookings
     * ORIGINALLY CREATED in the Mon–Sun report week, identity-deduped per
     * client (cancel-and-rebook counted once), CANCELLATIONS INCLUDED —
     * Oct 19–25 = 84 (audit-exact). cancellations = true cancellations among
     * that gross (cancelled produced members with NO active paid sibling) —
     * Oct 19–25 = 5. net = gross − cancellations — Oct 19–25 = 79. Credit is
     * permanently tied to the original creation business date: reschedules
     * never move a booking between weeks and never count as cancellations.
     * Computed from the SAME getWinsWithClientsBetween fetch — no new store
     * query. `total` above stays the paid-AND-ACTIVE wins count that repRows,
     * daily, dayByRep reconcile to — the rep-level detail is the protected
     * attribution basis, labeled as such in the UI.
     */
    production: { gross: number; cancellations: number; net: number };
    /** Session-type mix of the GROSS produced rows (sums to production.gross). */
    grossMix: { family: number; animalia: number; fairyland: number };
    /** Wins with no attribution rep INSIDE the gross — team total only, never a rep row. */
    grossUnattributed: number;
  };
  /**
   * Previous week's Alliance/Auction/Website split (owner CC Report template).
   * Bookings count from Acuity type names; WEBSITE is always null — no
   * "Website" booking type exists in Acuity, so no bucket is invented. LEADS:
   * Alliance/Auction are synced from GHL opportunities (owner-verified
   * 2026-09-29 — the channels' pipelines); website has no synced source and
   * stays null — never a fabricated number.
   */
  channels: { alliance: number; auction: number; website: number | null };
  /** Alliance/Auction LEADS of the report week (GHL opportunities, created-date ET bucketing); website null. */
  channelLeads: { alliance: number; auction: number; website: number | null };
  /**
   * SECONDARY CHANNEL PANEL (owner directive 2026-10-28): paid bookings of the
   * report week attributed to each Forms-Data channel source by the SOURCE
   * ATTRIBUTION chain (nearest-lead-to-booking-creation, booking-period basis
   * — current-, prior- AND later-period matches keep their resolved source, so
   * each figure = bookings + priorBookings + laterBookings of that source's
   * audit-table row). Sums the EXISTING audit table — the attribution engine
   * is never re-derived. A channel with no attributed wins is an honest 0
   * (dashes are reserved for "not computable", which this never is).
   */
  channelAttribution: { alliance: number; auction: number; website: number };
  /** Assigned-lead conversion: numerator = rep-attributed wins, denominator = source-dated assigned leads. */
  conversion: {
    overall: number | null;
    family: number | null;
    animalia: number | null;
    fairyland: number | null;
    numerator: { overall: number; family: number; animalia: number; fairyland: number };
    denominator: { overall: number; family: number; animalia: number; fairyland: number };
  };
  /** Sheet leads by source_date in the week. */
    leads: {
      family: number; animalia: number; fairyland: number;
      auction_register_certificate: number; google_ads_leads: number;
      alliance_activate_certificate: number; website_applications: number;
      total: number;
    };
  /** Month-to-date paid wins (current ET calendar month through today). */
  mtd: {
    total: number;
    repRows: WeeklyRepRow[];
    unattributed: number;
    /** Rep with the most MTD wins; null when no rep has any. */
    topPerformer: { repId: string; repName: string; total: number } | null;
    /** Stored monthly goal for THIS month's exact key; null = none stored (months never inherit). */
    goal: number | null;
    /** "X/Goal (±N)" — goalVsActual(total, goal); "X/—" when no goal is stored. */
    goalLine: string;
    /**
     * GROSS MTD (owner Final Booking Logic 10/28 — one production basis with
     * the weekly hero): qualifying paid bookings ORIGINALLY CREATED in the
     * month through today, identity-deduped, cancellations INCLUDED.
     * cancellations/net are the same true-cancellation split.
     */
    gross: number;
    cancellations: number;
    net: number;
    /**
     * REV-97 GOAL BASIS (owner directive 10/30, codified): the MTD goal
     * comparison is the QUALIFYING month-to-date count — the deposit-date
     * isBookingWin chain (winsMtd, the same qualification rules as Today's
     * WTD over the month window) — NEVER gross. Historical field name kept
     * for payload compatibility; by construction it now equals `goalLine`
     * above. The gross MTD figure remains displayed as production reporting
     * (`gross`), never goal-driving.
     */
    grossGoalLine: string;
  };
  calendar: {
    thisWeek: WeeklyCalendarBucket;
    nextWeek: WeeklyCalendarBucket;
    /** Sessions beyond next week — visible, never silently dropped. */
    beyond: number;
    /** First future ET date with zero non-cancelled appointments (and an open studio); null when none within the horizon. */
    firstFullyOpenDay: string | null;
  };
  /** CC Report narrative: stored notes for THIS report week + the computed Celebrate default + the assembled copy text. */
  report: {
    notes: Record<string, string>;
    /** "Name — N paid bookings" (last week's top performer) — prefill for Celebrate, still editable. */
    celebrateDefault: string | null;
    /** The full CC Report text COPY REPORT emits (owner's template order). */
    reportText: string;
    /**
     * FORMER CC Report "LEAD SOURCE PERFORMANCE" section input (owner directive
     * 2026-10-27). The owner then ordered the section ERASED from the copied
     * report text (2026-10-28) — buildWeeklyCcReportText no longer accepts or
     * renders any of it. The object survives here ONLY as the Weekly tab's
     * collapsed Attribution detail input (best/worst lines read it); the report
     * text carries nothing from it.
     */
    sourcePerformance: ReportSourcePerformance;
  };
  /**
   * BOOKINGS FROM LEADS (owner funnel, 2026-09-29): ALL paid bookings of the
   * report week ÷ ALL sheet leads (source_date in week) — the overall funnel
   * rate, NOT strict attribution (online bookings, repeat clients and
   * Alliance/Auction members never appear in the sheets).
   */
  funnel: { wins: number; leads: number; pct: number | null; produced: number };
  /** The same funnel for the last 5 COMPLETED Mon–Sun weeks, oldest first — never the in-progress week. */
  funnelSeries: WeekFunnelRow[];
  /**
   * PER-SOURCE BOOKING ATTRIBUTION + CONVERSION (owner directive 2026-10-27,
   * Steps 3–5). table = booking-period flavor (b): the week's in-scope wins by
   * the source of the contact's NEAREST sheet lead vs the week's source_date
   * lead cohort (splitLeadsByType-identical counts), conv = bookings ÷ leads.
   * cohort = lead-cohort flavor (a): of the week's leads per source, how many
   * produced a booking won through today (creation on/after the lead's sheet
   * date). overlap = cross-source duplicate magnitude (report note only —
   * NEVER a dedupe). Both flavors labeled wherever rendered.
   */
  sourcePerformance: {
    table: SourcePerformanceTable;
    cohort: LeadCohortSourceRow[];
    overlap: CrossSourceOverlap;
    /** Candidate-lead lookback (days before the week) the join window fetched. */
    lookbackDays: number;
  };
  warnings: string[];
}

/**
 * Shape of the former CC Report LEAD SOURCE PERFORMANCE input (owner directive
 * 2026-10-27). ERASED from the report text by the owner's 2026-10-28 directive
 * — WeeklyCcReportInput no longer carries the field. The object is still built
 * and exposed as data.report.sourcePerformance: the Weekly tab's collapsed
 * Attribution detail (best/worst source lines) is its only remaining reader.
 */
export interface ReportSourcePerformance {
  rows: {
    source: string;
    label: string;
    leads: number;
    bookings: number;
    priorBookings: number;
    laterBookings: number;
    conv: number | null;
  }[];
  totalLeads: number;
  totalBookings: number;
  totalConv: number | null;
  totalCurrentBookings: number;
  totalPriorBookings: number;
  totalLaterBookings: number;
  trulyUnattributedBookings: number;
  sourceResolvedBookings: number;
  coverage: number | null;
  best: string | null;
  worst: string | null;
  overlapNote: string | null;
}

/** Horizon (days) for the "first fully open day" scan — bounded, never infinite. */
export const FIRST_OPEN_DAY_HORIZON_DAYS = 120;

/**
 * WEEKLY REPORT payload — LAST WEEK (most recent completed Mon–Sun, ET) and
 * MONTH TO DATE. Read-only presentation over the same store primitives and
 * the same win/attribution/scope rules as every other page:
 *  - Booking wins bucket on booking_win_business_date (deposit-received ET
 *    date) — the rev-12 model; not-yet-derived paid rows fall back to created
 *    date via the metrics-layer filter, exactly like Today/Team/Reps.
 *  - Only in-scope Acuity appointments feed numbers (appointmentInScope, one
 *    getSettings() read).
 *  - Attribution join booking_attributions → users: manual overrides ARE rep
 *    bookings; no-attribution wins are the online/unattributed line (team
 *    total only, rev-13 rule).
 *  - Conversion denominator = leads with an assigned rep whose SOURCE_DATE
 *    falls in the week (owner's definition; labeled in the UI InfoTip).
 *  - Calendar fill derives slots/day from the live studio schedule config via
 *    the ONE availability engine (computeDayAvailability — never hardcoded).
 * Same PageDeps seam as every builder: tests inject MemoryStore + pinned
 * `today`; the createServerFn loader passes nothing.
 */
export async function weeklyPageData(deps?: PageDeps): Promise<WeeklyPageData> {
  const today = deps?.today ?? etToday();
  const metaPromise: Promise<PageMeta> = deps?.store
    ? Promise.resolve({ mode: "memory", dbReason: null, today, demoSeeded: false })
    : loadPageMeta();
  const store = deps?.store ?? (await getStore());

  const lwMon = lastCompletedWeekStart(today);
  const lwSun = addDays(lwMon, 6);
  const thisMon = weekStart(today);
  const nextMon = addDays(thisMon, 7);
  const nextSun = addDays(thisMon, 13);
  const monthStart = monthStartDate(today);
  const monthKey = monthKeyOf(today);
  // BOOKINGS FROM LEADS series floor: the Monday of the oldest week in the
  // recent-completed-weeks strip (report week included — one fetch serves both).
  const seriesMon = addDays(lwMon, -7 * (FUNNEL_SERIES_WEEKS - 1));

  const [meta, settings, winsWindowRaw, winsMtdRaw, attributions, rosterUsers, allUsers, leadsSeries, teamGoal, futureAppts, storedRules, connections, monthlyGoalRow, reportNotesRow, reportWeekSessions, channelLeadOpps, winsJoinRaw, leadsJoin, leadsCohort, reportWeekCalls] =
    await Promise.all([
      metaPromise,
      store.getSettings(),
      // REV 12 WIN BUCKET: wins count on booking_win_business_date; the
      // superset query + metrics filter below is the exact Today/Team pattern.
      // Window WIDENED to the funnel series (read-only, same superset shape) —
      // sub-window filtering below reproduces the narrow fetch exactly.
      store.getAppointmentsByWinBusinessDateBetween(seriesMon, lwSun),
      store.getAppointmentsByWinBusinessDateBetween(monthStart, today),
      store.getAttributions(),
      store.getUsers(),
      // ALL users — attribution rep_ids resolve names even off-roster.
      store.getAllUsers(),
      // BOOKING-PERIOD AUDIT slice only now (source_date, unchanged
      // semantics): the funnel no longer uses source-date leads.
      store.getLeadsBySourceDates(dateRange(lwMon, lwSun)),
      store.getTeamGoal(lwMon),
      // calendar fill: every session from this week's Monday onward (this
      // week + next week + beyond — nothing silently dropped)
      store.getAllAppointmentsSince(etDayStartUtc(thisMon)),
      store.getAvailabilityRules(),
      store.getConnections(),
      // MONTHLY BOOKING GOAL: resolved by THIS month's exact 'YYYY-MM' key —
      // months never inherit each other (October never shows September's 316).
      store.getMonthlyGoal(monthKey),
      // CC Report narrative for THIS report week (Big-3 pattern at week grain).
      store.getWeeklyReportNotes(lwMon),
      // OWNER HOLES (owner definition 2026-09-30) for the REPORT week: the
      // week's SESSION appointments — the same overlapping-window superset the
      // commission close job derives slot state from. Needed because
      // futureAppts (fetched from thisMon onward) never covers the completed
      // report week; the derivation excludes cancelled rows itself.
      store.getAppointmentsOverlapping(etDayStartUtc(lwMon), etDayEndUtc(lwSun)),
      // ALLIANCE/AUCTION LEADS (owner-verified 2026-09-29): GHL opportunities
      // on the channels' pipelines; ET created-date bucketing slices the week.
      store.getOpportunitiesByPipelines([ALLIANCE_PIPELINE_ID, AUCTION_PIPELINE_ID]),
      // PER-SOURCE BOOKING ATTRIBUTION (owner directive 10/27, Steps 3–5):
      // wins with client identity from the report week THROUGH TODAY (serves
      // both conversion flavors) + candidate leads 90 days back (the
      // documented lookback the nearest-rule selects within). READ-ONLY.
      // COHORT-TO-DATE WINS (work-date alignment): the join fetch is widened
      // past the series floor by COHORT_WIN_LOOKBACK_DAYS so EVERY possibly
      // causal win is present (a work-date cohort's source dates start up to
      // 3 days before its Monday; the causality guard inside the shared
      // cohort-outcomes machinery does the real filtering). The booking-period
      // audit table still slices [lwMon..lwSun] out of the same rows below.
      store.getWinsWithClientsBetween(addDays(seriesMon, -COHORT_WIN_LOOKBACK_DAYS), today),
      store.getLeadsJoinRange(addDays(lwMon, -SOURCE_JOIN_LOOKBACK_DAYS), lwSun),
      // WORK-DATE COHORT (owner directive, work-date alignment): the report
      // week's leads by WORK_DATE — the same cohort Team trends, the Reps
      // page, Today and the Daily Report already use. One weekly lead
      // definition everywhere (week labeled Mon 10/19 ⇒ work_date 10/19–10/25
      // ⇒ sheet dates Fri 10/16–Thu 10/22).
      store.getLeadsByWorkDates(dateRange(seriesMon, lwSun)),
      // PICKUP RATE BY DAY (owner decision 10/30 — FINAL): the report week's
      // calls — the EXISTING ET day-window convention (calls STARTED on the
      // ET day), Mon 00:00 ET through Sun 23:59 ET of the report week. Day
      // membership is re-derived from started_at downstream (pickupRateForDay).
      store.getCallsBetween(etDayStartUtc(lwMon), etDayEndUtc(lwSun)),
    ]);

  const scope = settings.acuity;
  const winsLw = filterApptsInWinBucketRange(winsWindowRaw, lwMon, lwSun).filter(
    (a) => isBookingWin(a) && appointmentInScope(a, scope),
  );
  const winsMtd = filterApptsInWinBucketRange(winsMtdRaw, monthStart, today).filter(
    (a) => isBookingWin(a) && appointmentInScope(a, scope),
  );
  // Report week's sheet leads (the series fetch covers more weeks — slice it).
  // WORK-DATE COHORT slice (alignment): work_date in [lwMon..lwSun] — NOT the
  // sheet-date window. Feeds the Leads panel/composition, the funnel and the
  // report's lead counts; the booking-period audit table keeps its own
  // source-date slice below (unchanged semantics).
  const leadsWeek = leadsCohort.filter((l) => l.work_date >= lwMon && l.work_date <= lwSun);
  // The WORK-DATE cohort in join-row form (identity columns for the shared
  // produced-lead machinery). Same rows as leadsWeek — the weekly-page test
  // pins the id-set equality of the two slices.
  const cohortJoinWeek = leadsJoin.filter((l) => l.work_date != null && l.work_date >= lwMon && l.work_date <= lwSun);
  // COHORT-TO-DATE WINS through today (the fetch reaches past the series
  // floor; causality is enforced inside the machinery, so a booking made
  // weeks later credits the ORIGINAL cohort — never a later week's).
  const winsCohort = filterApptsInWinBucketRange(winsJoinRaw, addDays(seriesMon, -COHORT_WIN_LOOKBACK_DAYS), today).filter(
    (a) => isBookingWin(a) && appointmentInScope(a, scope),
  );
  // THE PRODUCTION BLOCK (owner Final Booking Logic 10/28, audit-79v84): the
  // SAME getWinsWithClientsBetween fetch (no new store query), sliced by ET
  // CREATION date inside the window — gross = paid deposit, identity-deduped
  // per client, cancellations INCLUDED; cancellations = TRUE cancellations
  // among the gross (no active paid sibling); net = gross − cancellations.
  // Oct 19–25 pins 84 / 5 / 79. The MTD tracker reuses the SAME fetch for
  // gross month-to-date: the fetch floor (seriesMon − COHORT_WIN_LOOKBACK_DAYS,
  // ≤ today − 48) always sits more than a month back (monthStart ≥ today − 30),
  // and a row's win-bucket date is never earlier than its creation date —
  // every created-in-month row is inside the fetch. ONE production basis
  // page-wide (hero + MTD gross); the win/funnel/cohort chains stay untouched.
  const productionWeek = computeWeeklyProduction(winsJoinRaw, lwMon, lwSun, scope);
  const productionMtd = computeWeeklyProduction(winsJoinRaw, monthStart, today, scope);
  // The hero's Booking Mix renders the GROSS basis (one production basis in
  // the hero section): session-type split + the unattributed-inside count of
  // the produced rows (same attribution join as every ownership split).
  const grossSplit = splitWinsBySessionType(productionWeek.rows);
  const grossOwnership = splitWinOwnership(productionWeek.rows, attributions);
  // PRIMARY per-source table (owner directive, work-date alignment): the
  // work-date cohort through computeLeadCohortOutcomes — Leads Received =
  // cohort leads per source; Bookings = DISTINCT cohort leads that produced
  // a qualifying paid booking AT ANY TIME; Conversion % = produced ÷ leads.
  const sourceCohort = computeLeadCohortOutcomes(cohortJoinWeek, winsCohort);
  const cohortTotalRow = sourceCohort.find((r) => r.source === "total") ?? null;

  const nameById = new Map(allUsers.map((u) => [u.id, u.name]));
  // HISTORICAL REPS (owner directive 2026-10-20): the Weekly report's rep rows
  // cover ACTIVE ROSTER ∪ HISTORICAL REPS, so a departed rep's attributed wins
  // keep their row (and future weeks reproduce pre-removal output exactly).
  // Empty historical_reps ⇒ identical rosterIds (bit-identical to today).
  const rosterIds = [...rosterUsers.map((u) => u.id), ...historicalRepIds(allUsers, settings.historical_reps ?? [])];

  // ---- LAST WEEK: bookings ----
  const lwDates = dateRange(lwMon, lwSun);
  const dailyMap = winsByDate(winsLw, lwDates);
  const lwSplit = splitWinsBySessionType(winsLw);
  const lwOwnership = splitWinOwnership(winsLw, attributions);
  const lwRepRows = buildWeeklyRepRows(lwOwnership.repCounts, nameById, rosterIds);
  // PER-DAY × PER-REP grid (owner request 2026-10-19): the SAME winsLw set,
  // bucketed per booking_win_business_date × attribution rep — the daily
  // strip (team row) and the by-rep table (row totals) must reconcile with it.
  const lwDayByRep = weeklyDayByRepGrid(winsLw, attributions, lwDates, lwRepRows);
  const weeklyGoal = teamGoal?.booking_goal ?? 79; // the app-wide team-goal default (Today/Daily Report convention)

  // ---- LAST WEEK: assigned-lead conversion (source-dated denominators) ----
  // FORM-WORKBOOK SOURCES (owner directive 2026-10-27): form leads are TEAM
  // totals, never rep metrics — excluded from the assigned-lead conversion
  // denominators exactly as the assigned-by-day grid excludes them from rep
  // cells, so the section's 'Family + Animalia + Fairyland' label matches
  // what the denominator counts. The four form sources have assigned_rep_id
  // null in practice (the workbook has no rep column) — no live number moves.
  // WORK-DATE COHORT denominators (alignment): assigned rows of the week's
  // work-date cohort (form sheets excluded — owner rule: form leads are team
  // totals, never rep metrics). Same cohort definition as the Reps page.
  const assigned = leadsWeek.filter((l) => l.assigned_rep_id != null && !isFormSourceSheet(l.source_sheet));
  // COHORT-TO-DATE assigned conversion: bookings produced by these leads AT
  // ANY TIME (shared produced-lead machinery), credited by lead assignment —
  // numerator and denominator are the same cohort.
  const assignedCohortOutcomes = computeLeadCohortOutcomes(assigned, winsCohort);
  const assignedTotal = assignedCohortOutcomes.find((r) => r.source === "total") ?? { leads: assigned.length, bookedLeads: 0 };
  const genreOutcome = (b: SourceBucket) => assignedCohortOutcomes.find((r) => r.source === b) ?? { leads: 0, bookedLeads: 0 };
  const assignedFamOutcome = genreOutcome("family");
  const assignedAniOutcome = genreOutcome("animalia");
  const assignedFaiOutcome = genreOutcome("fairyland");
  // TAB <-> REPORT DIGIT IDENTITY (work-date alignment): ONE conversion object
  // feeds BOTH the CC report's "Conversion of Assigned Leads" line and the
  // returned payload's conversion block — they can never disagree.
  const assignedConversion = {
    overall: conversionRate(assignedTotal.bookedLeads, assignedTotal.leads),
    family: conversionRate(assignedFamOutcome.bookedLeads, assignedFamOutcome.leads),
    animalia: conversionRate(assignedAniOutcome.bookedLeads, assignedAniOutcome.leads),
    fairyland: conversionRate(assignedFaiOutcome.bookedLeads, assignedFaiOutcome.leads),
    numerator: {
      overall: assignedTotal.bookedLeads,
      family: assignedFamOutcome.bookedLeads,
      animalia: assignedAniOutcome.bookedLeads,
      fairyland: assignedFaiOutcome.bookedLeads,
    },
    denominator: {
      overall: assignedTotal.leads,
      family: assignedFamOutcome.leads,
      animalia: assignedAniOutcome.leads,
      fairyland: assignedFaiOutcome.leads,
    },
  };
  // TOTAL LEAD CONVERSION — WEEK (owner directive 10/30, post-#126 fix): the
  // CC report's headline is the ONE shared weekly conversion — the week's
  // QUALIFYING bookings ÷ the week's TOTAL leads (work-date cohort, all
  // seven sources). The numerator is the SAME deposit-week wins chain this
  // report's goal logic already uses (winsLw → bookingsWeek.total) — the
  // same Booking-Win qualification and cutoff the Daily Report's "Bookings
  // WTD" covers for its week — NOT the hero's created-Mon–Sun gross (that
  // counts cancellations; the hero stays exactly as shipped). Parity suite
  // pins digit identity with the Daily Report; NEVER an average of daily or
  // rep rates. The by-source rates keep the tab's primary-table machinery
  // (sourceCohort) over the FULL cohort — the assigned-only subset leaves
  // the REPORT (the Weekly tab's Conversion Efficiency panel and
  // payload.conversion keep assigned-lead conversion untouched).
  const cohortConv = (b: SourceBucket) => sourceCohort.find((r) => r.source === b)?.conv ?? null;
  const leadsWeekSummary = splitLeadsByType(leadsWeek);
  const weekConversion = {
    rate: totalLeadConversionWeek(winsLw.length, leadsWeekSummary.total),
    family: cohortConv("family"),
    animalia: cohortConv("animalia"),
    fairyland: cohortConv("fairyland"),
  };

  // ---- MTD ----
  const mtdOwnership = splitWinOwnership(winsMtd, attributions);
  const mtdRepRows = buildWeeklyRepRows(mtdOwnership.repCounts, nameById, rosterIds);
  const top = mtdRepRows.find((r) => r.total > 0) ?? null; // rows sort largest-first
  // MONTHLY BOOKING GOAL (owner-approved 2026-09-29): stored per exact
  // 'YYYY-MM' month key (Settings) — null when none is stored for THIS month,
  // and months never inherit (the UI renders "—" until a goal exists).
  const monthlyGoal: number | null = monthlyGoalRow?.goal ?? null;

  // ---- CC REPORT extras ----
  // Alliance/Auction bookings counted from the same in-scope win set as every
  // other last-week figure; website stays null (no such Acuity type).
  const channels = { ...splitWinsByChannel(winsLw), website: null as number | null };
  // Alliance/Auction LEADS of the report week — GHL opportunities on the
  // channels' pipelines, bucketed by ET created date (owner-verified source).
  // Website has no synced lead source → null, never invented.
  const channelLeads = splitChannelLeads(channelLeadOpps, lwMon, lwSun);

  // ---- BOOKINGS FROM LEADS (owner funnel, 2026-09-29) ----
  // Overall funnel rate: ALL paid bookings of a week ÷ ALL sheet leads of the
  // same week (source_date, Family + Animalia sheets) — no rep filter and no
  // attribution filter, so online/unattributed bookings count too. That is the
  // owner's funnel view, not a strict lead→booking attribution (some bookings
  // never appear in the sheets). Recent-weeks strip = the last 5 COMPLETED
  // Mon–Sun weeks, oldest first — the in-progress week is excluded by
  // construction (its % would be meaningless mid-week). Weeks with zero sheet
  // leads carry pct null → the UI renders "—" (Sheets data begins 2026-08-24).
  const seriesStarts = recentCompletedWeekStarts(today, FUNNEL_SERIES_WEEKS);
  // FUNNEL (work-date alignment): Leads = the week's work-date cohort;
  // Bookings-from-Leads % = cohort-to-date produced ÷ cohort leads (the SAME
  // numbers as the primary table's Total row). The OPERATIONAL "Bookings
  // (Week) vs goal" tracker (deposit-week wins) stays exactly as it was.
  const funnelSeries = weekCohortFunnelRows(seriesStarts, leadsJoin, winsCohort);
  const funnel = {
    wins: winsLw.length, // operational deposit-week wins (goal tracker) — unchanged
    leads: cohortJoinWeek.length, // the work-date cohort (same rows as leadsWeek)
    pct: cohortTotalRow ? conversionRate(cohortTotalRow.bookedLeads, cohortTotalRow.leads) : null,
    produced: cohortTotalRow?.bookedLeads ?? 0, // cohort-to-date produced — the pct numerator
  };
  // Celebrate prefill: LAST WEEK's top performer (the report is about the
  // week) — stored note overrides it in the narrative editor.
  const lwTop = lwRepRows.find((r) => r.total > 0) ?? null;
  const celebrateDefault = celebrateDefaultLine(lwTop ? { repName: lwTop.rep_name, total: lwTop.total } : null);

  // ---- PER-SOURCE BOOKING ATTRIBUTION + CONVERSION (owner directive 10/27, Steps 3–5) ----
  // Booking-period flavor (b): the report week's in-scope wins by the source
  // of the contact's NEAREST sheet lead vs the week's source_date lead cohort
  // (splitLeadsByType-identical counts — genre numbers byte-identical).
  // Lead-cohort flavor (a): of the week's leads per source, how many produced
  // a booking won through today (creation on/after the lead's sheet date —
  // causality guard). A win with no lead link = Unattributed (never invented).
  const winsJoin = filterApptsInWinBucketRange(winsJoinRaw, lwMon, lwSun).filter(
    (a) => isBookingWin(a) && appointmentInScope(a, scope),
  );
  const byWinSource = resolveBookingSources(winsJoin, leadsJoin);
  // THREE-CATEGORY SEMANTICS (owner directive 10/27, post-validation): the
  // report week [lwMon, lwSun] is the period — current-period matches feed
  // the conversion numerators; prior-period matches keep their resolved
  // source (never Unattributed); only no-link wins are Truly Unattributed.
  // BOOKING-PERIOD AUDIT TABLE (collapsed Attribution detail — UNTOUCHED
  // data): wins won IN the week by the nearest lead's source, against the
  // week's SOURCE-DATE cohort — the exact input it always had, so the
  // three-category audit (current/prior/no-link/coverage) stays byte-stable.
  const leadsSdAudit = leadsSeries.filter((l) => l.source_date >= lwMon && l.source_date <= lwSun);
  const sourceTable = buildSourcePerformanceTable(leadsSdAudit, winsJoin, byWinSource, { start: lwMon, end: lwSun });
  const sourceBestWorst = bestWorstSourceLines(sourceTable.rows);
  const sourceOverlap = crossSourceOverlap(leadsJoin, SOURCE_JOIN_LOOKBACK_DAYS);
  // SECONDARY CHANNEL PANEL (owner directive 2026-10-28): per-channel paid
  // bookings from the SOURCE ATTRIBUTION chain — the SUM of the audit table's
  // three per-source categories (current + prior + later; a matched lead keeps
  // its resolved source in every category). NO re-derivation: read straight
  // off sourceTable.rows. A channel with no row / no attributed wins is an
  // honest 0 (the panel renders numbers, never "—").
  const attributedForBucket = (b: SourceBucket): number => {
    const r = sourceTable.rows.find((x) => x.source === b);
    return r == null ? 0 : r.bookings + r.priorBookings + r.laterBookings;
  };
  const channelAttribution: WeeklyPageData["channelAttribution"] = {
    alliance: attributedForBucket("alliance_activate_certificate"),
    auction: attributedForBucket("auction_register_certificate"),
    website: attributedForBucket("website_applications"),
  };

  // ---- CALENDAR FILL ----
  // studio hours: availability_rules is the runtime mirror; fall back to the
  // settings rules when the mirror is empty (same rule as Availability).
  const rules = storedRules.length > 0 ? storedRules : settings.studio.hours;
  // Capacity per ET date comes from the ONE availability engine with no
  // appointments/blocked — pure schedule config (blocks × slots). Capacity
  // depends only on the weekday, so it is computed once per weekday.
  const capacityByWeekday = new Map<number, number>();
  const capacityFor = (date: string): number => {
    const wd = weekday(date);
    let cap = capacityByWeekday.get(wd);
    if (cap == null) {
      cap = computeDayAvailability({
        date,
        rules,
        blocked: [],
        appointments: [],
        slotIntervalMin: settings.studio.slot_interval_min,
        durationMin: settings.studio.appointment_duration_min,
        paddingMin: settings.studio.padding_min,
      }).totalCapacity;
      capacityByWeekday.set(wd, cap);
    }
    return cap;
  };

  const apptsByDate = new Map<string, number>();
  const apptRowsByDate = new Map<string, AppointmentRow[]>();
  let beyond = 0;
  let thisWeekCount = 0;
  let nextWeekCount = 0;
  for (const a of futureAppts) {
    // non-cancelled + in-scope — the same population the availability engine counts
    if (a.cancelled || a.status === "cancelled" || !appointmentInScope(a, scope)) continue;
    const ms = Date.parse(a.appointment_datetime);
    if (!Number.isFinite(ms)) continue; // unparsable session time — never guessed
    const d = etDateStrFromInstant(ms);
    apptsByDate.set(d, (apptsByDate.get(d) ?? 0) + 1);
    const rows = apptRowsByDate.get(d);
    if (rows) rows.push(a);
    else apptRowsByDate.set(d, [a]);
    if (d >= thisMon && d < nextMon) thisWeekCount += 1;
    else if (d >= nextMon && d <= nextSun) nextWeekCount += 1;
    else beyond += 1; // d > nextSun (fetch floor is thisMon, so never earlier)
  }
  const weekCapacity = (mon: string) => dateRange(mon, addDays(mon, 6)).reduce((s, d) => s + capacityFor(d), 0);

  // DISTINCT-SLOT OCCUPANCY (owner report 2026-10-06 "CALENDAR-FILL ACCURACY"):
  // the fill number counts DISTINCT engine-grid slots occupied — a
  // double-booked slot fills ONE slot (the raw session count above carries the
  // excess), so fill can never exceed capacity. ONE engine:
  // computeDayAvailability per ET date with that date's sessions — its
  // `booked` is exactly distinct occupied slots on the SAME schedule basis as
  // capacityFor above (blocked: [] on both sides — a blocked-but-booked slot
  // is still occupied; blocks shape OPEN times, not fill). RULING 9 (owner
  // 10/11): pending_payment sessions do NOT occupy — the client most likely
  // won't pay and the agents take them off the schedule — so pending-only
  // slots count OPEN here (the Availability page keeps rendering them
  // BOOKED-PENDING as an honest label; the raw session counts stay visible).
  const occupiedByDate = new Map<string, number>();
  const occupiedFor = (date: string): number => {
    const memo = occupiedByDate.get(date);
    if (memo != null) return memo;
    const rows = apptRowsByDate.get(date) ?? [];
    // RULING 9 (owner 10/11): pending_payment sessions do not occupy a slot.
    const occRows = rows.filter((r) => r.payment_state !== "pending_payment");
    const occupied =
      occRows.length === 0
        ? 0
        : computeDayAvailability({
            date,
            rules,
            blocked: [],
            appointments: occRows,
            slotIntervalMin: settings.studio.slot_interval_min,
            durationMin: settings.studio.appointment_duration_min,
            paddingMin: settings.studio.padding_min,
          }).booked;
    occupiedByDate.set(date, occupied);
    return occupied;
  };
  const weekSlotsOccupied = (mon: string) => dateRange(mon, addDays(mon, 6)).reduce((s, d) => s + occupiedFor(d), 0);

  // first future date with zero appointments (and an open studio) — the scan
  // includes sessions beyond next week, so nothing future is excluded
  let firstFullyOpenDay: string | null = null;
  for (let i = 0; i < FIRST_OPEN_DAY_HORIZON_DAYS; i++) {
    const d = addDays(today, i);
    if ((apptsByDate.get(d) ?? 0) === 0 && capacityFor(d) > 0) {
      firstFullyOpenDay = d;
      break;
    }
  }

  // ---- OWNER HOLES (owner definition 2026-09-30) ----
  // Empty booking slots = derived capacity (10/day, 9 Tue) − booked sessions
  // per ET day, summed Mon–Sun. ONE derivation (deriveWeeklyHoles) over the
  // commission engine's slot helpers — no second engine. For a week whose
  // derived capacity is 0 the holes are undefined → null ("—" in the UI,
  // the legacy blank placeholder in the copied report — never invented).
  const holesFor = (mon: string, sessions: AppointmentRow[]) => {
    const w = deriveWeeklyHoles({ weekStart: mon, sessionAppts: sessions });
    return w.capacity > 0 ? { capacity: w.capacity, booked: w.booked, holes: w.holes, days: w.days } : null;
  };
  const reportWeekHoles = holesFor(lwMon, reportWeekSessions);
  const thisWeekHoles = holesFor(thisMon, futureAppts);
  const nextWeekHoles = holesFor(nextMon, futureAppts);

  // ---- warnings (honest states, never invented data) ----
  // Reliability 2b/3: + the shared heartbeat staleness clause.
  const warnings: string[] = await withHeartbeatWarning([...syncStaleWarnings(connections)]);
  if (!teamGoal)
    warnings.push(`No team booking goal stored for the week of ${formatDateHuman(lwMon)} — the ${weeklyGoal} default is shown.`);
  if (winsLw.length === 0)
    warnings.push(`No paid bookings recorded ${formatDateHuman(lwMon)} – ${formatDateHuman(lwSun)} — check the Acuity sync.`);
  if (leadsWeek.length === 0)
    warnings.push(`No sheet leads with source dates ${formatDateHuman(lwMon)} – ${formatDateHuman(lwSun)} — check the Google Sheets sync.`);

  const calendar: WeeklyPageData["calendar"] = {
    thisWeek: {
      label: "This week",
      start: thisMon,
      end: addDays(thisMon, 6),
      appointments: thisWeekCount,
      slotsOccupied: weekSlotsOccupied(thisMon),
      capacity: weekCapacity(thisMon),
      holes: thisWeekHoles,
    },
    nextWeek: {
      label: "Next week",
      start: nextMon,
      end: nextSun,
      appointments: nextWeekCount,
      slotsOccupied: weekSlotsOccupied(nextMon),
      capacity: weekCapacity(nextMon),
      holes: nextWeekHoles,
    },
    beyond,
    firstFullyOpenDay,
  };

  const reportNotes = reportNotesRow?.notes ?? {};
  // FORMER report section input (owner directive 2026-10-27; ERASED from the
  // report text 2026-10-28 — buildWeeklyCcReportText no longer takes it).
  // Still built and exposed on data.report.sourcePerformance: the Weekly tab's
  // collapsed Attribution detail reads best/worst from it. Work-date cohort
  // lines from the Weekly tab's primary table; audit aggregates from the
  // UNTOUCHED booking-period audit table.
  const reportSourcePerformance: ReportSourcePerformance = {
    rows: sourceCohort
      .filter((r) => r.source !== "total")
      .map((r) => ({
        source: r.source as string,
        label: r.label,
        leads: r.leads,
        bookings: r.bookedLeads,
        priorBookings: 0,
        laterBookings: 0,
        conv: r.conv,
      })),
    totalLeads: cohortTotalRow?.leads ?? 0,
    totalBookings: sourceTable.totalBookings,
    totalConv: cohortTotalRow?.conv ?? null,
    totalCurrentBookings: cohortTotalRow?.bookedLeads ?? 0,
    totalPriorBookings: sourceTable.totalPriorBookings,
    totalLaterBookings: sourceTable.totalLaterBookings,
    trulyUnattributedBookings: sourceTable.trulyUnattributedBookings,
    sourceResolvedBookings: sourceTable.sourceResolvedBookings,
    coverage: sourceTable.coverage,
    best: sourceBestWorst.best,
    worst: sourceBestWorst.worst,
    overlapNote: sourceOverlap.note,
  };
  // PICKUP RATE BY DAY (owner directive 10/30 evening — OFFICIAL formula):
  // REPORTING-eligible calls of the REPORT week — the active roster ∪ the
  // HISTORICAL reps (buildReportingEligibility), the SAME eligibility every
  // other Weekly call figure uses — so a departed rep's calls keep their
  // historical place in the report and the CC Report text stays
  // byte-identical before/after a departure (historical-reps doctrine (c)).
  // Each occurred Mon–Fri day is rated individually by the ONE shared
  // function (pickupRateByDay → pickupRateForDay) as (Calls Over 2 Min +
  // Calls Under 2 Min) ÷ Total Calls, at
  // settings.meaningful_call_threshold_seconds — the SAME threshold every
  // "Calls Over 2 Min" surface uses, so the report's per-day figures
  // recompute exactly from the Call Log's three fields. Only days that have
  // occurred are passed — the report week is a completed week, so that is all
  // five workdays; the d <= today guard keeps the rule honest even if the
  // week basis ever changes. Weekend rows and future days are never passed; a
  // day with no calls rates null → "—". NO weekly average is computed
  // anywhere.
  const weekCallsEligibility = buildReportingEligibility(allUsers, settings);
  const rosterWeekCalls = applyRosterEligibility(reportWeekCalls, weekCallsEligibility);
  const pickupByDay = pickupRateByDay(
    rosterWeekCalls,
    dateRange(lwMon, lwSun).filter((d) => isWorkday(d) && d <= today),
    settings.meaningful_call_threshold_seconds,
  ).map((r) => ({ date: r.date, label: weekdayName(r.date), rate: r.rate }));
  const reportText = buildWeeklyCcReportText({
    week: { start: lwMon, end: lwSun },
    monthKey,
    bookingsWeek: { total: winsLw.length, goal: weeklyGoal },
    bookingsMonth: { total: winsMtd.length, goal: monthlyGoal },
    // THE PRODUCTION BLOCK — the SAME production figures the payload's hero
    // renders (tab <-> report digit identity): Gross / Cancellations / Net for
    // the week + gross MTD. REV-97 (owner 10/30): the ±goal comparisons ride
    // the QUALIFYING chains (bookingsWeek/bookingsMonth — the same winsLw/
    // winsMtd the goal tracker and conversion headline use), NEVER these gross
    // figures — they stay displayed as historical production reporting only.
    // The standalone Bookings Produced line is superseded —
    // gross IS the produced figure, now the hero.
    productionWeek: {
      gross: productionWeek.gross,
      cancellations: productionWeek.cancellations,
      net: productionWeek.net,
      goal: weeklyGoal,
    },
    productionMonth: { gross: productionMtd.gross, goal: monthlyGoal },
    channels,
    channelLeads,
    leads: leadsWeekSummary,
    // sourcePerformance: REMOVED from the report input — the owner erased the
    // LEAD SOURCE PERFORMANCE section from the CC Report (2026-10-28); the
    // object lives on as data.report.sourcePerformance (Attribution detail).
    // OWNER DIRECTIVE 10/30 (post-#126 fix): the report's conversion is the
    // TOTAL-lead headline — ONE shared function (totalLeadConversionWeek)
    // over the QUALIFYING week bookings (winsLw, the goal-tracker chain) +
    // the week's total work-date leads, digit-identical to the Daily
    // Report's week line. The assigned-only object stays on the
    // payload for the Weekly tab's Conversion Efficiency panel only.
    weekConversion,
    // PICKUP RATE BY DAY (owner decision 10/30 — FINAL): per-day Mon–Fri rows.
    pickupByDay,
    funnel,
    calendar,
    // OWNER HOLES of the report week (9/30) — fills the "Holes" placeholder
    // line in the copied CC Report (null keeps the legacy blank line).
    holes: reportWeekHoles?.holes ?? null,
    notes: reportNotes,
    celebrateDefault,
  });

  return {
    meta,
    today,
    week: {
      start: lwMon,
      end: lwSun,
      caption: `${formatDateHuman(lwMon)} – ${formatDateHuman(lwSun)} · Last Week`,
    },
    month: { key: monthKey, start: monthStart, end: today },
    bookings: {
      total: winsLw.length,
      family: lwSplit.family,
      animalia: lwSplit.animalia,
      fairyland: lwSplit.fairyland,
      goal: weeklyGoal,
      goalLine: goalVsActual(winsLw.length, weeklyGoal),
      daily: lwDates.map((d) => ({ date: d, count: dailyMap.get(d) ?? 0 })),
      repRows: lwRepRows,
      dayByRep: lwDayByRep,
      production: { gross: productionWeek.gross, cancellations: productionWeek.cancellations, net: productionWeek.net },
      grossMix: grossSplit,
      grossUnattributed: grossOwnership.unattributed,
      unattributed: lwOwnership.unattributed,
    },
    channels,
    channelLeads,
    channelAttribution,
    conversion: assignedConversion,
    leads: splitLeadsByType(leadsWeek),
    funnel,
    funnelSeries,
    sourcePerformance: {
      table: sourceTable,
      cohort: sourceCohort,
      overlap: sourceOverlap,
      lookbackDays: SOURCE_JOIN_LOOKBACK_DAYS,
    },
    mtd: {
      total: winsMtd.length,
      repRows: mtdRepRows,
      unattributed: mtdOwnership.unattributed,
      topPerformer: top ? { repId: top.rep_id, repName: top.rep_name, total: top.total } : null,
      goal: monthlyGoal,
      goalLine: goalVsActual(winsMtd.length, monthlyGoal),
      gross: productionMtd.gross,
      cancellations: productionMtd.cancellations,
      net: productionMtd.net,
      // REV-97 (owner 10/30): the goal comparison is the QUALIFYING MTD count
      // (winsMtd — the deposit-date isBookingWin chain) vs the monthly goal,
      // never the gross; equals goalLine above by construction. The gross MTD
      // figure stays displayed as production reporting only.
      grossGoalLine: goalVsActual(winsMtd.length, monthlyGoal),
    },
    calendar,
    report: {
      notes: reportNotes,
      celebrateDefault,
      reportText,
      /** The Lead Source Performance section input reportText was built with. */
      sourcePerformance: reportSourcePerformance,
    },
    warnings,
  };
}

// ---------- COMMISSION CENTER + §26 VALIDATION (Phase B — presentation-only loaders) ----------
//
// These builders read STORED commission rows (Phase A schema) and run the pure
// engine for the §3.5 estimated band and the §26 fresh recompute — NO new
// calculation logic, no manual counts (spec §Q). The createServerFn wrappers
// live in queries.ts; tests inject a MemoryStore through the PageDeps seam.

import {
  commissionEmployeeOf,
  computeWeeklyCommissions,
  tierHeldForWeek,
} from "./commission/derive";
import type { CommissionEmployeeInput } from "./commission/engine";
import { estimatedWeekView, type EstimatedWeekView } from "../components/commission-views";
import type { CommissionWeeklyRow } from "./store/types";

/** §3.5 band payload: the in-progress week's pure-engine estimate (or null on loader error). */
export interface CommissionEstimatedWeek {
  weekStart: string;
  /** null = the in-progress computation is unavailable — the band renders "—" honestly. */
  view: EstimatedWeekView | null;
  error: string | null;
}

export async function estimatedCommissionWeek(
  store: Store,
  users: Awaited<ReturnType<Store["getUsers"]>>,
  today: string,
  opts?: { attributions?: Awaited<ReturnType<Store["getAttributions"]>> },
): Promise<CommissionEstimatedWeek> {
  try {
    const ws = weekStart(today);
    const weekEnd = addDays(ws, 6);
    const [wins, sessions, attributions] = await Promise.all([
      store.getAppointmentsByWinBusinessDateBetween(ws, weekEnd),
      store.getAppointmentsOverlapping(etDayStartUtc(ws), etDayEndUtc(weekEnd)),
      opts?.attributions ? Promise.resolve(opts.attributions) : store.getAttributions(),
    ]);
    const employees = users
      .map(commissionEmployeeOf)
      .filter((e): e is CommissionEmployeeInput => e !== null)
      .map((e) => tierHeldForWeek(e, ws, weekEnd))
      .filter((e): e is CommissionEmployeeInput => e !== null);
    const computation = computeWeeklyCommissions({
      weekStart: ws,
      wins,
      attributions,
      sessionAppts: sessions,
      employees,
    });
    return { weekStart: ws, view: estimatedWeekView(computation), error: null };
  } catch (e) {
    return {
      weekStart: weekStart(today),
      view: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------- §26 VALIDATION payload ----------

export interface CancelledWinFlag {
  appointmentId: string;
  acuityAppointmentId: string;
  clientName: string | null;
  appointmentType: string | null;
  /** ET deposit date the win was counted on (booking_win_business_date). */
  winDate: string;
  /** ET session date of the (now cancelled) appointment. */
  sessionDate: string;
  /** Monday ET week the win was counted in. */
  weekStart: string;
  weekEnd: string;
  /** True when stored commission records exist for that week — counted in stored data; corrections only via the audited reason-required manual path on the owner's direction. */
  weekClosed: boolean;
  /** Attributed rep at flag time (may be null — unattributed never paid). */
  repName: string | null;
  /** When the sync confirmed the cancellation (write-once stamp). */
  confirmedAt: string | null;
}

/**
 * CANCELLATION FLAG LIST (owner report 2026-10-06): the report-only surface
 * for Booking Wins that the sync has since confirmed cancelled. Pure: given
 * the cancelled win rows + the set of weeks that HAVE stored commission
 * records, classifies each flag closed (counted in stored data — never
 * rewritten; corrections via the audited manual path only on the owner's
 * direction) vs open (the live week — the exclusion simply applies at the
 * Sunday close). No number is rewritten here; the list exists so the owner
 * can reconcile stored totals against current truth.
 */
export function buildCancelledWinFlags(
  rows: (AppointmentRow & { acuity_appointment_id: string | null; client_name: string | null })[],
  closedWeekStarts: ReadonlySet<string>,
  repNameFor: (appointmentId: string) => string | null,
): CancelledWinFlag[] {
  return rows
    .filter((a) => !!a.booking_win_business_date && !!a.acuity_appointment_id)
    .map((a) => {
      const winDate = a.booking_win_business_date as string;
      const ws = weekStart(winDate);
      return {
        appointmentId: a.id,
        acuityAppointmentId: a.acuity_appointment_id as string,
        clientName: a.client_name ?? null,
        appointmentType: a.appointment_type ?? null,
        winDate,
        sessionDate: etDateStrFromInstant(Date.parse(a.appointment_datetime)),
        weekStart: ws,
        weekEnd: etDateStrFromInstant(Date.parse(`${ws}T12:00:00-04:00`) + 6 * 86_400_000),
        weekClosed: closedWeekStarts.has(ws),
        repName: repNameFor(a.id),
        confirmedAt: a.cancelled_at ?? null,
      };
    })
    .sort((x, y) => (x.weekStart + x.winDate).localeCompare(y.weekStart + y.winDate));
}

/**
 * QA PHASE 3 — S26 DIVERGENCE SPLIT (display-only; w1-recompute-anomaly 2026-10-08
 * section 5): among the counted bookings of the STORED weekly records, classifies
 * the ones whose attribution row was re-derived AFTER the record closed
 * (rep NULL, manual=false, updated_at > calc_date — the tick-wipe fingerprint)
 * AND whose in-window active-roster call still exists in `calls` (source
 * evidence intact). These render as the "Attribution evidence restored —
 * source intact" bucket with rewritten-at beside calc_date so the wipe is
 * dated. Everything else stays in the plain field-level delta list — manual
 * rows (they survive ticks), still-attributed rows, cancelled rows (those live
 * in the cancellation flag list), rows with no recorded rewrite time, and
 * bookings whose call evidence is genuinely absent. Never silently whitewashed.
 */
export interface DriftedWinFlag {
  appointmentId: string;
  clientName: string | null;
  appointmentType: string | null;
  winDate: string;
  weekStart: string;
  weekEnd: string;
  /** Name snapshot from the stored record (records stay readable). */
  repName: string | null;
  /** attribution row's updated_at — the instant the verdict was re-derived. */
  rewrittenAt: string;
  /** The weekly record's calc_date — shown beside rewrittenAt so the wipe is dated. */
  calcDate: string;
  /** ET date the booking was made on (created_business_date) — the evidence-window anchor. */
  createdDate: string | null;
}

export function buildAttributionDriftFlags(
  stored: CommissionWeeklyRow[],
  apptsById: ReadonlyMap<string, AppointmentRow>,
  attributions: AttributionRow[],
  calls: ReadonlyArray<Pick<CallRow, "rep_id" | "started_at">>,
  activeRepIds: ReadonlySet<string>,
): DriftedWinFlag[] {
  const attrByAppt = new Map(attributions.map((a) => [a.appointment_id, a]));
  // ET business dates carrying at least one active-roster call in the source.
  const callEtDates = new Set<string>();
  for (const c of calls) {
    if (!c.rep_id || !activeRepIds.has(c.rep_id)) continue;
    const t = Date.parse(c.started_at);
    if (Number.isFinite(t)) callEtDates.add(etDateStrFromInstant(t));
  }
  const out: DriftedWinFlag[] = [];
  for (const rec of stored) {
    for (const cb of rec.counted_bookings) {
      if (cb.manual) continue; // manual owner assignments survive ticks and agree
      const appt = apptsById.get(cb.id);
      if (!appt || appt.cancelled_at) continue; // cancellations live in the cancelled flag list
      const attr = attrByAppt.get(cb.id);
      if (!attr || attr.rep_id != null || attr.manual_override) continue; // still attributed — not a wipe
      if (!attr.updated_at) continue; // unknown rewrite time — never claimed as drift
      if (Date.parse(attr.updated_at) <= Date.parse(rec.calc_date)) continue; // written at/before close
      const created = appt.created_business_date ?? null;
      // source-intact check: an active-roster call in the s1 window (created - 1 .. created ET)
      if (!created || (!callEtDates.has(created) && !callEtDates.has(addDays(created, -1)))) continue;
      out.push({
        appointmentId: cb.id,
        clientName: cb.client_name ?? null,
        appointmentType: cb.appointment_type ?? null,
        winDate: cb.win_date,
        weekStart: rec.week_start,
        weekEnd: rec.week_end,
        repName: rec.rep_name,
        rewrittenAt: attr.updated_at,
        calcDate: rec.calc_date,
        createdDate: created,
      });
    }
  }
  return out.sort((x, y) => (x.weekStart + x.winDate).localeCompare(y.weekStart + y.winDate));
}
