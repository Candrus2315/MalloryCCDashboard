/**
 * TODAY + DAILY REPORT page payload builders — moved verbatim from page-data.ts
 * (docs/DECOMPOSITION-PLAN.md step 3). page-data.ts re-exports this
 * module; import paths and the public surface are unchanged.
 */
import { getStore } from "../store";
import type { AppSettings, AppointmentRow } from "../store/types";

import { addDays, dateRange, dailyReportAnchorDate, etDateStrFromInstant, etDayEndUtc, etDayStartUtc, etNowMinutes, etToday, formatDateHuman, repOperatingState, weekStart } from "../date-logic";
import { buildTodayMetrics, buildDailyReportMetrics, computeOpenSlots, filterApptsInWinBucketRange, appointmentPaymentStateOf, isBookingWin, bookingWinBusinessDateOf, onlineBookingWins, materializeRecurringBlocks, resolveRepGoal } from "../metrics/compute";
import { anchorDayPhrase, big3Incomplete, buildDailyReportEmail, buildDailyReportSlack, buildDailyReportText } from "../metrics/report-text";

import { derivePaymentState } from "../payments";
import { appointmentInScope } from "../metrics/availability";
import { lastCompletedWeekStart, splitLeadsByType } from "../metrics/weekly";









import { applyAttributionEligibility, applyRosterEligibility, buildRosterEligibility } from "../roster";

import { serializableConnections, syncStaleWarnings, type PageMeta } from "../queries";
import { withHeartbeatWarning } from "../heartbeat-freshness"; // Reliability 2b/3 banner clause
import { loadPageMeta, type PageDeps } from "./shared";

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
  const weekStartUtc = etDayStartUtc(ws);

  const [meta, settings, callsToday, callsWtd, callsForAttribution, apptsToday, apptsYesterday, apptsWtd, rules, leads, teamGoal, repGoals, users, attributions, leadAdjustments, pendingWindow, connections, slotDayResults, onlineWindowRaw] =
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
      // ONLINE BOOKINGS window (owner directive 2026-11-04): the win-bucket
      // fetch for the CURRENT week + the PREVIOUS week — the Online Bookings
      // section's list window. Appended LAST (the destructure above is
      // positional — the mis-order bug this PERF pass shipped is documented
      // on the connections entry); sliced + qualified downstream like every
      // win chain.
      store.getAppointmentsByWinBusinessDateBetween(addDays(ws, -7), today),
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
  // OWNER DOCTRINE 10/30 (not-yet-active reps): the team-share divisor counts
  // GOAL-ELIGIBLE reps only (call_start_date null or <= today — the
  // repOperatingState boundary) so a pending rep never dilutes the remaining
  // reps' slices, and the pending rep's OWN resolution is suppressed to
  // zero/"not-active" (owner-set rep_goals rows render again untouched on the
  // start date). Computed fresh from this request's users read — no caching,
  // no manual flip.
  const goalEligibleCount = todayReps.filter(
    (r) => repOperatingState(r.call_start_date, today) === "active",
  ).length;
  const resolvedRepGoals = todayReps.map((r) => {
    const repGoalsByWeek = new Map<string, number>();
    for (const g of repGoals) if (g.rep_id === r.id) repGoalsByWeek.set(g.week_start, g.goal);
    const resolved = resolveRepGoal({
      weeks: [ws],
      repGoalsByWeek,
      teamGoalByWeek,
      repCount: goalEligibleCount,
      repActive: repOperatingState(r.call_start_date, today) === "active",
    });
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
        // CREATION-SOURCE RULE (owner directive 2026-11-04): the queue rows
        // carry the verdict's reason_code so the surface can label a PROVEN
        // client-created booking "Online Booking" instead of "Unattributed".
        reason_code: attr?.reason_code ?? null,
        created_business_date: a.created_business_date ?? null,
        created_at: a.created_at,
        appointment_datetime: a.appointment_datetime,
      };
    })
    .sort((x, y) => (x.created_at < y.created_at ? 1 : -1));

  // ONLINE BOOKINGS section (owner directive 2026-11-04): designated
  // client-created bookings (creator rule, reason_code "online-booking", rep
  // NULL) that are QUALIFYING wins — win-bucket slice + isBookingWin + scope,
  // the SAME chain every team total counts — with the booking's business date
  // in the CURRENT week + the PREVIOUS week. Computed fresh from the store on
  // every request (SSR), so a designation, a deposit, or a cancellation is
  // reflected on the next load. Additive payload only: no existing figure
  // reads this array; rep math, goal math and conversions are untouched.
  const onlineBookings = onlineBookingWins(
    filterApptsInWinBucketRange(onlineWindowRaw, addDays(ws, -7), today).filter((a) => appointmentInScope(a, scope)),
    attributions,
  )
    .map((a) => ({
      appointment_id: a.id,
      acuity_appointment_id: a.acuity_appointment_id ?? null,
      client_name: a.client_name ?? null,
      appointment_type: a.appointment_type,
      // Booked = the ET business date the booking counts on (the deposit-date
      // win-bucket key, first-seen fallback included — bookingWinBusinessDateOf).
      booked_date: bookingWinBusinessDateOf(a),
      session_datetime: a.appointment_datetime,
      // Session = the appointment's ET calendar date (date-only display).
      session_date: Number.isFinite(Date.parse(a.appointment_datetime))
        ? etDateStrFromInstant(Date.parse(a.appointment_datetime))
        : null,
      created_at: a.created_at,
    }))
    .sort((x, y) => {
      const byDate = (y.booked_date ?? "").localeCompare(x.booked_date ?? "");
      if (byDate !== 0) return byDate;
      return x.created_at < y.created_at ? 1 : -1;
    });

  return {
    meta,
    settings,
    metrics,
    pendingPayments,
    onlineBookings,
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
  // OWNER DECISION 11/2 (LAST COMPLETED WEEK): the week-conversion line shows
  // the COMPLETED Mon–Sun week — the Weekly CC Report headline's EXACT pairing
  // — not the week to date. The WTD figure collapsed every Monday morning:
  // the weekend fold loads Fri–Sun leads into Monday's cohort (live 11/2:
  // 320 leads) while weekend deposits sit in last week's window (1 win) → a
  // meaningless 0.3%. Same week selection the Weekly CC Report uses
  // (lastCompletedWeekStart); the pair is computed on the SAME chains below.
  const lwMon = lastCompletedWeekStart(today);
  const lwSun = addDays(lwMon, 6);

  const anchorStart = etDayStartUtc(anchorDate);
  const weekStartUtc = etDayStartUtc(ws);
  // The join pool (conversation conversion) and the lead cohorts must cover the
  // anchor day even when it falls in the PREVIOUS week (Monday morning →
  // Friday) — widen the fetch floors, never the filters downstream.
  const poolStartUtc = anchorStart < weekStartUtc ? anchorStart : weekStartUtc;
  const workDatesFrom = anchorDate < ws ? anchorDate : ws;

  const [meta, settings, callsAnchorDay, apptsAnchorDay, apptsWtd, callsForAttribution, leads, teamGoal, priorities, leadAdjustments, apptsLastWeekRaw, leadsLastWeekRaw] =
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
      // OWNER 11/2: the LAST COMPLETED week's rows for the week-conversion
      // line — the SAME two chains the Weekly CC Report's weekConversion
      // consumes for its headline: deposit-week wins (the winsLw fetch shape)
      // + the work-date lead cohort of [lwMon..lwSun]. Same-batch (no
      // sequential round trips); the filters below mirror weeklyPageData
      // EXACTLY (filterApptsInWinBucketRange + isBookingWin +
      // appointmentInScope; splitLeadsByType) so the two reports stay
      // digit-identical by construction.
      store.getAppointmentsByWinBusinessDateBetween(lwMon, lwSun),
      store.getLeadsByWorkDates(dateRange(lwMon, lwSun)),
    ]);

  const scope = settings.acuity;
  // Scope BEFORE any booking computation (owner directive — see apptsInScope).
  const apptsAnchorDayScoped = apptsInScope(apptsAnchorDay, scope);
  const apptsWtdScoped = apptsInScope(apptsWtd, scope);
  // OWNER 11/2: the completed week's QUALIFYING wins — the Weekly CC Report's
  // EXACT winsLw filter stack (win-bucket slice + isBookingWin + scope), so
  // the numerator can never drift from the report's headline. The fetch floor
  // [lwMon..lwSun] is a subset of weeklyPageData's window; the win-bucket
  // slice below is the same idempotent filter, so the set is identical.
  const winsLastWeek = filterApptsInWinBucketRange(apptsLastWeekRaw, lwMon, lwSun).filter(
    (a) => isBookingWin(a) && appointmentInScope(a, scope),
  );
  // The completed week's TOTAL work-date cohort through splitLeadsByType — the
  // report's EXACT denominator (no adjustments, same as leadsWeekSummary).
  const leadsLastWeek = splitLeadsByType(leadsLastWeekRaw).total;
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
    // OWNER 11/2: the LAST COMPLETED week's (qualifying winsLw, leadsWeek)
    // pair — the exact pairing the Weekly CC Report's weekConversion.rate
    // computes; ONE shared function (totalLeadConversionWeek) downstream.
    lastWeekConversion: { wins: winsLastWeek.length, leads: leadsLastWeek },
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
  if (metrics.totalLeadConversionLastWeek == null)
    warnings.push(
      `No qualifying wins or leads recorded ${formatDateHuman(lwMon)} – ${formatDateHuman(lwSun)} — Total Lead Conversion — Last Week is unavailable.`,
    );
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
