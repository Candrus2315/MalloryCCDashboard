/**
 * WEEKLY REPORT page payload builder — moved verbatim from page-data.ts
 * (docs/DECOMPOSITION-PLAN.md step 3). page-data.ts re-exports this
 * module; import paths and the public surface are unchanged.
 */
import { getStore } from "../store";
import type { AppointmentRow } from "../store/types";

import { addDays, dateRange, etDateStrFromInstant, etDayEndUtc, etDayStartUtc, etToday, formatDateHuman, isWorkday, weekStart, weekday, weekdayName } from "../date-logic";
import { countOnlineBookings, filterApptsInWinBucketRange, isBookingWin, pickupRateByDay, totalLeadConversionWeek } from "../metrics/compute";

import { isFormSourceSheet } from "../../components/lead-sources";

import { appointmentInScope, computeDayAvailability } from "../metrics/availability";
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
} from "../metrics/weekly";
import { buildWeeklyCcReportText } from "../metrics/weekly-report-text";
import { bestWorstSourceLines, buildSourcePerformanceTable, computeLeadCohortOutcomes, computeWeeklyProduction, crossSourceOverlap, resolveBookingSources, COHORT_WIN_LOOKBACK_DAYS, SOURCE_JOIN_LOOKBACK_DAYS, weekCohortFunnelRows, type CrossSourceOverlap, type LeadCohortSourceRow, type SourceBucket, type SourcePerformanceTable } from "../metrics/source-attribution";
import { deriveWeeklyHoles, type DayHoleDetail } from "../commission/derive";






import { buildReportingEligibility, historicalRepIds } from "../roster";
import { loadCallKpiRows, applyTeamCallScope } from "../metrics/call-records";

import { syncStaleWarnings, type PageMeta } from "../queries";
import { withHeartbeatWarning } from "../heartbeat-freshness"; // Reliability 2b/3 banner clause
import { loadPageMeta, type PageDeps } from "./shared";

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
      // call figures — W3 CALL-KPI SOURCE (owner directive 11/4): read
      // hl_call_records (TYPE_CALL only, rep via users.external_id; the Nov-1
      // legacy slice rides along inside loadCallKpiRows). Day membership is
      // re-derived downstream (pickupRateForDay) from the ET started_at.
      (async () => loadCallKpiRows({ store, users: await store.getAllUsers(), startUtc: etDayStartUtc(lwMon), endUtc: etDayEndUtc(lwSun) }))(),
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
  // ONLINE BOOKINGS of the report week (owner directive 2026-11-04): the SAME
  // qualifying winsLw chain the Bookings (Week) line counts, intersected with
  // the stored creator-rule verdicts (reason_code "online-booking") — TEAM-ONLY
  // credit. Feeds the report's "of which Online Bookings: N" count line only;
  // the weekly four and the goal math never read it.
  const onlineBookingsWeek = countOnlineBookings(winsLw, attributions);
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
  // TEAM CALL SCOPE (owner directive 11/4): the CC Report's call lines are
  // TEAM figures — roster-rep rows PLUS the null-user inbound bucket (HL
  // userId NULL); a known non-roster user's rows still drop.
  const rosterWeekCalls = applyTeamCallScope(reportWeekCalls, weekCallsEligibility);
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
    // ONLINE BOOKINGS of the report week (owner directive 2026-11-04): the
    // "of which Online Bookings: N" count line under the Bookings (Week) line —
    // the SAME winsLw chain, stored creator-rule verdicts only. Additive line:
    // the weekly four and the goal math are untouched.
    onlineBookingsWeek,
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
      // ONLINE BOOKINGS (owner directive 2026-11-04): the exact input the
      // reportText was built with — the "of which Online Bookings: N" line —
      // exposed so comparisons can reproduce the loader's inputs.
      onlineBookingsWeek,
    },
    warnings,
  };
}
