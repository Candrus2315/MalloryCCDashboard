/**
 * REPS + TEAM PAGE payload builders — moved verbatim from page-data.ts
 * (docs/DECOMPOSITION-PLAN.md step 3). page-data.ts re-exports this
 * module; import paths and the public surface are unchanged.
 */
import { getStore } from "../store";


import { addDays, dateRange, etDayStartUtc, etRangeBounds, etNowMinutes, etToday, formatDateHumanFull, isHistoricalWeek, isRangeMode, mondaysInRange, recentMondays, repOperatingState, resolveRange, weekStart, type RangeMode } from "../date-logic";
import { buildTeamAverages, buildTeamRangeMetrics, buildTeamTrends, buildRepDetail, bookingAttributionSplit, compareWithTeam, filterApptsInWinBucketRange, filterCallsInEtRange, isBookingWin, repRangeSummaries, resolveRepGoal } from "../metrics/compute";
import { loadCallKpiRows, applyTeamCallScope, summarizeCallRecordKpis, callsPerBooking } from "../metrics/call-records";

import { isFormSourceSheet } from "../../components/lead-sources";

import { appointmentInScope } from "../metrics/availability";
import { lastCompletedWeekStart, ALLIANCE_PIPELINE_ID, AUCTION_PIPELINE_ID } from "../metrics/weekly";

import { buildRepCohortSourcePerformance, computeAssignedCohortProduced, resolveBookingSources, COHORT_WIN_LOOKBACK_DAYS, SOURCE_JOIN_LOOKBACK_DAYS } from "../metrics/source-attribution";






import { buildAssignedLeadsByDay, type AssignedByDayGrid } from "../metrics/assigned-by-day";
import { applyAttributionEligibility, applyRosterEligibility, buildReportingEligibility, buildRosterEligibility, historicalRepIds, reportingRepUsers } from "../roster";
import { buildCallOwnershipBuckets } from "../../components/reps-views";
import { syncStaleWarnings, type PageMeta, type RepsSearchParams, type RepStripRow, type TeamSearchParams } from "../queries";
import { withHeartbeatWarning } from "../heartbeat-freshness"; // Reliability 2b/3 banner clause
import { loadPageMeta, type PageDeps } from "./shared";

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
      // W3 CALL-KPI SOURCE (owner directive 2026-11-04): rep call KPIs read
      // hl_call_records (TYPE_CALL, rep via users.external_id) — the Nov-1
      // legacy slice rides along inside loadCallKpiRows. Attribution joins
      // below keep the legacy `calls` fetch (booking logic untouched).
      (async () => loadCallKpiRows({ store, users: await store.getAllUsers(), startUtc, endUtc }))(),
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
    // users.map(...) when historical_reps is empty. is_active rides along so
    // the repList picker below can enforce the active-roster-only rule.
    const reps = reportingRepUsers(allUsers, settings.historical_reps ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      call_start_date: u.call_start_date,
      is_active: u.is_active,
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
    const assignedGrid = buildAssignedLeadsByDay({
      leads: assignedWeekLeads,
      opps: channelOpps,
      rosterReps: reps.map((r) => ({ id: r.id, name: r.name })),
      nameById: new Map(allUsers.map((u) => [u.id, u.name])),
      mon: assignedMon,
      sun: assignedSun,
    });
    // OWNER DIRECTIVE 2026-11-02 (erase follow-up): inactive users' NAMES must
    // never reach the browser — the Other Lead Owners group previously revealed
    // departed/inactive owners row by row (Jennifer Stitt, Amy Clark, …). Rows
    // for is_active=false users are dropped HERE, at payload level; the group
    // header recomputes from the remaining rows on the client and renders no
    // group at all when none remain. CRITICAL: only the NAME rows disappear —
    // dayTotals/weekTotal above stay the builder's full-grid rollup over ALL
    // assigned leads (non-roster owners' leads included), so the Team Total
    // row is unchanged by the drop. Dropped owners' per-owner rows also leave
    // the client CSV export (names out of the browser entirely).
    const inactiveUserIds = new Set(allUsers.filter((u) => !u.is_active).map((u) => u.id));
    const assignedByDay: AssignedByDayGrid = {
      ...assignedGrid,
      rows: assignedGrid.rows.filter((r) => !inactiveUserIds.has(r.rep_id)),
    };

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
    // OWNER DOCTRINE 10/30 (not-yet-active reps): current periods count only
    // GOAL-ELIGIBLE reps in the team-share divisor — a rep whose
    // call_start_date is after the report date never dilutes the remaining
    // reps' slices. The selected pending rep's own goal is suppressed by
    // resolveRepGoal's repActive below (owner-set rows render again on the
    // start date — stored rows are never altered).
    const goalEligibleCount = users.filter(
      (u) => repOperatingState(u.call_start_date, today) === "active",
    ).length;
    const repCountForGoal = currentPeriod ? goalEligibleCount : participatedRepCount;
    const goal = rep
      ? resolveRepGoal({
          weeks,
          repGoalsByWeek,
          teamGoalByWeek,
          repCount: repCountForGoal,
          // OWNER DOCTRINE 10/30: zero/"not-active" until the start date.
          repActive: selectedOperatingState === "active",
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

    // W3 KPI SET (owner directive 11/4): the selected rep's call-record KPIs —
    // computed from the SAME roster-scoped rows the summaries used, so the
    // block can never disagree with the Total Calls / Over-2-Min cells above.
    const selectedRows = rep ? rosterCalls.filter((c) => c.rep_id === rep.id) : [];
    const selectedCallKpis = summarizeCallRecordKpis(selectedRows);
    const selectedCallsPerBooking = callsPerBooking(
      selectedCallKpis.total,
      rep ? summaries.get(rep.id)?.totalBookings ?? 0 : 0,
    );

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
      // W3 KPI SET (owner directive 11/4): the selected rep's HL call-record
      // KPIs (null when no rep is selected) + calls per qualifying booking.
      selectedCallKpis,
      selectedCallsPerBooking,
      // OWNER DIRECTIVE (2026-11-02): the rep picker lists ONLY the active
      // roster — inactive/departed users are never selectable in the UI. This
      // supersedes the 2026-10-20 presentation of departed reps in the picker
      // (their historical rows stay in the DB and keep feeding reporting
      // eligibility, team totals and the Weekly surface; the detail branch for
      // a directly-linked inactive rep id stays harmless but unreachable from
      // this list). Requires is_active=false for the past marker too — an
      // ACTIVE rep listed in historical_reps by mistake is never "past".
      repList: reps
        .filter((r) => r.is_active)
        .map((r) => {
          const s = summaries.get(r.id);
          return {
            id: r.id,
            name: r.name,
            totalBookings: s?.totalBookings ?? 0,
            totalCalls: s?.totalCalls ?? 0,
            callsOverThreshold: s?.callsOverThreshold ?? 0,
            isSelected: r.id === rep?.id,
            historical: historicalIds.has(r.id) && !r.is_active,
            operatingState: repOperatingState(r.call_start_date, today),
            callStartDate: r.call_start_date ?? null,
          };
        }),
      detail,
      selectedOperatingState,
      teamAverages,
      comparisons,
      // OWNER DIRECTIVE (2026-11-02): the "Non Roster Calls" section is erased
      // from the UI — the payload no longer carries the nonRoster rollup (the
      // underlying call rows are untouched; the unattributed bucket stays).
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
      // W3 CALL-KPI SOURCE: team call metrics read hl_call_records (TYPE_CALL
      // only, null-user team bucket kept by applyTeamCallScope below) — the
      // look-back fetch above stays on the legacy `calls` table (attribution).
      (async () => loadCallKpiRows({ store, users: await store.getAllUsers(), startUtc, endUtc }))(),
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
    // TEAM CALL SCOPE (owner directive 11/4): team call totals ALSO count the
    // null-user inbound bucket (HL userId NULL) — roster-rep rows plus
    // unclaimed team-level rows; a known non-roster user's rows still drop.
    const teamCalls = applyTeamCallScope(calls, eligibility);
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
      calls: teamCalls,
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
      calls: teamCalls,
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
    // OWNER DOCTRINE 10/30 (not-yet-active reps): current periods count only
    // GOAL-ELIGIBLE reps in the team-share divisor — a rep whose
    // call_start_date is after the report date never dilutes the remaining
    // reps' slices (their own row is zeroed by resolveRepGoal's repActive
    // below). HISTORICAL periods keep the participated fallback untouched.
    const goalEligibleCount = reps.filter(
      (r) => repOperatingState(r.call_start_date, today) === "active",
    ).length;
    const repCountForGoal = currentPeriod ? goalEligibleCount : participatedRepCount;

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
          goal: resolveRepGoal({
            weeks,
            repGoalsByWeek,
            teamGoalByWeek,
            repCount: repCountForGoal,
            repActive: repOperatingState(r.call_start_date, today) === "active",
          }),
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

    // W3 KPI SET (owner directive 11/4): the team call-record KPIs over the
    // SAME team-scoped rows the metrics above used (null-user inbound bucket
    // included, IVR excluded).
    const teamCallKpis = summarizeCallRecordKpis(teamCalls);

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
      // W3 KPI SET (owner directive 11/4): the team's HL call-record KPI block.
      callKpis: teamCallKpis,
      metrics,
      trends,
      bookingSplit,
      repRows,
      warnings,
      teamGoalDefault: teamGoalByWeek.get(weeks[0]) ?? 79,
    };
}
