/**
 * WEEK CADENCE LOCK-IN (design/week-cadence-lockin.md) — pure-layer regression.
 *
 * The ratified FRIDAY → SAT/SUN → MONDAY 12AM ET → TUESDAY sequence, the
 * work-date lead logic, the historical "Week of…" selector, whole-page
 * atomicity, and goal independence per week_start.
 *
 * Testing layers (learning from the loader probe: createServerFn needs the
 * TanStack Start runtime, so loader-level behavior is NOT unit-testable):
 *   1. PURE date logic (date-logic.ts) — no store, no clock.
 *   2. PURE view compos (repsPageData / teamPageData) with the PageDeps
 *      seam — MemoryStore injected, clock pinned. Never getStore() (could
 *      reach live Postgres), never createServerFn (needs the runtime).
 * Every KPI flows through the ONE metrics engine; the atomicity tests pin
 * that the one resolved range drives every payload section together.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { UserRow } from "../store/types";
import {
  addDays,
  dateRange,

  etDayStartUtc,
  etRangeBounds,
  formatDateShort,
  getLeadCohort,
  getWorkDate,
  isHistoricalWeek,
  recentMondays,
  resolveRange,
  weekStart,
  weekday,
} from "../date-logic";
import { repsPageData, teamPageData } from "../page-data";
import type { AttributionRow, CallRow, LeadRow } from "../metrics/compute";

// September 2026: Fri 9/25 is TODAY (EDT, UTC-4). Current week Mon 9/21..Sun
// 9/27; prior week Mon 9/14..Sun 9/20 (the owner's reconciliation week).
const FRI = "2026-09-25";
const SAT = "2026-09-26";
const SUN = "2026-09-27";
const MON = "2026-09-28"; // Monday 12AM ET — the counter-reset boundary
const TUE = "2026-09-29";
const CUR_MON = "2026-09-21";
const PRIOR_MON = "2026-09-14";
const PRIOR_SUN = "2026-09-20";

/** UTC instant for an ET wall-clock moment (EDT: UTC-4) in Sept 2026. */
const ET = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString();

describe("work-date lead logic (THE centralized functions)", () => {
  test("getWorkDate: Fri/Sat/Sun sources ALL land on Monday; weekday sources next day", () => {
    // Hard-coded expectations — the ratified semantics, not derived.
    expect(getWorkDate("2026-09-18")).toBe(CUR_MON); // Fri source → NEXT Monday (+3)
    expect(getWorkDate("2026-09-19")).toBe(CUR_MON); // Sat source → next Monday (+2)
    expect(getWorkDate("2026-09-20")).toBe(CUR_MON); // Sun source → next Monday (+1)
    expect(getWorkDate(MON)).toBe(TUE);
    expect(getWorkDate(TUE)).toBe("2026-09-30");
    expect(getWorkDate("2026-09-24")).toBe(FRI); // Thu → Fri (no weekend skip)
  });

  test("cadence cohort: Friday works Thursday; weekend AND Monday work Fri+Sat+Sun; Tuesday works Monday", () => {
    expect(getLeadCohort(FRI)).toEqual(["2026-09-24"]); // Tue–Fri: previous day
    expect(getLeadCohort(SAT)).toEqual(["2026-09-25", SAT, SUN]); // upcoming Monday's window
    expect(getLeadCohort(SUN)).toEqual(["2026-09-25", SAT, SUN]); // same window
    // MONDAY 12AM ET = calendar date flips to Mon: WTD resets AND the cohort
    // is exactly the Fri/Sat/Sun leads the weekend was previewing.
    expect(getLeadCohort(MON)).toEqual(["2026-09-25", SAT, SUN]);
    // TUESDAY: Leads Today = Monday's SOURCE leads (the weekend cohort is
    // worked Monday, so Tuesday's previous-day cohort is Monday itself).
    expect(getLeadCohort(TUE)).toEqual([MON]);
  });

  test("cohort and work-date are mutual inverses across a 14-day window", () => {
    for (let i = 0; i < 14; i++) {
      const source = addDays(PRIOR_MON, i);
      const work = getWorkDate(source);
      expect(getLeadCohort(work)).toContain(source);
    }
  });

  test("weekend sources stay inside their SOURCE week but work into the NEXT week", () => {
    // The prior week's WTD window (9/14..9/20) contains sources Fri 9/18,
    // Sat 9/19, Sun 9/20 — but those leads are WORKED in the current week
    // (work_date 9/21). Operational reporting filters on work_date, so the
    // prior week shows them NOWHERE and the current week owns them.
    expect(weekday("2026-09-18")).toBe(5); // Fri
    expect(getWorkDate("2026-09-18")).toBe(CUR_MON);
    expect(dateRange(PRIOR_MON, PRIOR_SUN)).not.toContain(CUR_MON);
  });
});

describe("range resolution across the cadence (resolveRange)", () => {
  test("FRIDAY: This Week is WTD (Mon..Fri) — the week's counters are live", () => {
    const r = resolveRange("this-week", FRI);
    expect(r.start).toBe(CUR_MON);
    expect(r.end).toBe(FRI);
    expect(r.toDate).toBe(true);
  });

  test("SATURDAY/SUNDAY: This Week still toDate (Mon..today); the FULL week needs week-of", () => {
    expect(resolveRange("this-week", SAT)).toMatchObject({ start: CUR_MON, end: SAT });
    expect(resolveRange("this-week", SUN)).toMatchObject({ start: CUR_MON, end: SUN });
    const full = resolveRange("week-of", SAT, CUR_MON);
    expect(full).toMatchObject({ start: CUR_MON, end: SUN, toDate: false, label: "Week of Sep 21", warning: null });
  });

  test("MONDAY 12AM ET: This Week is FRESH (Mon..Mon) — no stale carry-over", () => {
    const r = resolveRange("this-week", MON);
    expect(r).toMatchObject({ start: MON, end: MON });
    expect(weekStart(MON)).toBe(MON);
  });

  test("MONDAY: the prior week is retrievable INTACT (full Mon..Sun) via week-of", () => {
    expect(resolveRange("week-of", MON, CUR_MON)).toMatchObject({ start: CUR_MON, end: SUN });
    expect(resolveRange("week-of", MON, PRIOR_MON)).toMatchObject({ start: PRIOR_MON, end: PRIOR_SUN });
  });

  test("any day normalizes to its Monday (selector feeds weekStart of the anchor)", () => {
    expect(resolveRange("week-of", FRI, "2026-09-16").start).toBe(PRIOR_MON); // Wed anchor → its Monday
    expect(resolveRange("week-of", FRI, PRIOR_SUN).start).toBe(PRIOR_MON); // Sunday anchor → its Monday
  });

  test("invalid week-of falls back to This Week WITH a warning (never silently mislabeled)", () => {
    const r = resolveRange("week-of", FRI, "garbage");
    expect(r.mode).toBe("this-week");
    expect(r.warning).toContain("This Week");
  });

  test("DST boundary: the fall-back week still resolves 7 full ET days", () => {
    // 2026 DST ends Sun Nov 1 (2AM ET → 1AM ET). The week Mon Oct 26..Sun
    // Nov 1 contains the change: EDT days start 04:00Z, EST days 05:00Z.
    expect(etDayStartUtc("2026-10-31")).toBe("2026-10-31T04:00:00.000Z"); // EDT
    expect(etDayStartUtc("2026-11-02")).toBe("2026-11-02T05:00:00.000Z"); // EST (after fall-back)
    const b = etRangeBounds("2026-10-26", "2026-11-01");
    expect(b.startUtc).toBe("2026-10-26T04:00:00.000Z");
    expect(b.endUtc).toBe("2026-11-02T05:00:00.000Z"); // = Nov 2 00:00 ET
    const spanMs = Date.parse(b.endUtc) - Date.parse(b.startUtc);
    expect(spanMs).toBe((7 * 24 + 1) * 3600_000); // 7 ET days PLUS the repeated hour (fall-back)
  });
});

describe("historical selector helpers", () => {
  test("isHistoricalWeek: only a week-of anchored BEFORE the current Monday is historical", () => {
    expect(isHistoricalWeek("week-of", PRIOR_MON, FRI)).toBe(true);
    expect(isHistoricalWeek("week-of", CUR_MON, FRI)).toBe(false); // current week via week-of is live
    // Other presets never claim historical: live presets track now, and
    // Yesterday/Last Week carry their own unambiguous labels.
    expect(isHistoricalWeek("this-week", CUR_MON, FRI)).toBe(false);
    expect(isHistoricalWeek("last-week", PRIOR_MON, FRI)).toBe(false);
    expect(isHistoricalWeek("today", FRI, FRI)).toBe(false);
    // On Monday, LAST week's Monday becomes historical for week-of.
    expect(isHistoricalWeek("week-of", CUR_MON, MON)).toBe(true);
  });

  test("recentMondays: current operating week first, then 7 prior Mondays", () => {
    expect(recentMondays(FRI, 3)).toEqual([CUR_MON, PRIOR_MON, "2026-09-07"]);
    expect(recentMondays(MON, 2)[0]).toBe(MON); // Monday itself starts the list
  });

  test("formatDateShort: compact picker label (no weekday/year)", () => {
    expect(formatDateShort(PRIOR_MON)).toBe("Sep 14");
  });
});

// ---------------------------------------------------------------------------
// FIXTURE: two weeks with deliberately DIFFERENT shapes, seeded through
// MemoryStore, read through the page builders with the clock pinned to
// Friday 2026-09-25. Every number below is asserted exactly.
// ---------------------------------------------------------------------------
async function seedCadenceStore(): Promise<{ store: MemoryStore; alphaId: string; betaId: string }> {
  const store = new MemoryStore();
  // Synthetic names — DEFAULT_CALL_START_DATES backfill must not touch them.
  await store.upsertUsers([
    { id: "u-src-alpha", provider: "highlevel", external_id: "hl-alpha", name: "Rep Alpha", email: null, is_active: true, call_start_date: null },
    { id: "u-src-beta", provider: "highlevel", external_id: "hl-beta", name: "Rep Beta", email: null, is_active: true, call_start_date: null },
  ]);
  const users = await store.getAllUsers();
  const byName = new Map(users.map((u: UserRow) => [u.name, u.id]));
  const alphaId = byName.get("Rep Alpha")!;
  const betaId = byName.get("Rep Beta")!;

  const call = (ext: string, rep: string, etDate: string, etTime: string, dur: number): CallRow & { external_call_id: string; provider: string } => ({
    id: `call-${ext}`,
    external_call_id: ext,
    provider: "highlevel",
    rep_id: rep,
    contact_id: `contact-${ext}`,
    started_at: ET(etDate, etTime),
    duration_seconds: dur,
    over_two_minutes: dur > 120,
  });
  await store.upsertCalls([
    // PRIOR week (9/14..9/20): Alpha 3 over-threshold + 1 under; Beta 2 over.
    call("p1", alphaId, PRIOR_MON, "10:00", 300),
    call("p2", alphaId, "2026-09-16", "11:00", 300),
    call("p3", alphaId, "2026-09-18", "09:00", 60), // under threshold
    call("p4", alphaId, "2026-09-19", "12:00", 300), // SATURDAY — inside the prior week
    call("p5", betaId, "2026-09-15", "10:00", 300),
    call("p6", betaId, "2026-09-17", "15:00", 300),
    // CURRENT week WTD (9/21..9/25): Alpha 4 over; Beta 1 over.
    call("c1", alphaId, CUR_MON, "10:00", 300),
    call("c2", alphaId, "2026-09-22", "10:00", 300),
    call("c3", alphaId, "2026-09-23", "10:00", 300),
    call("c4", alphaId, FRI, "10:00", 300),
    call("c5", betaId, "2026-09-24", "10:00", 300),
  ]);

  // Leads: source dates feed work dates via THE function under test.
  const lead = (ext: string, source: string, rep: string | null): LeadRow & { source_id: string; provider: string } => ({
    id: `lead-${ext}`,
    source_id: ext,
    provider: "google_sheets",
    lead_type: "family",
    source_date: source,
    work_date: getWorkDate(source), // seeded through the centralized logic
    contact_id: null,
    assigned_rep_id: rep,
    source_sheet: "family",
  });
  await store.upsertLeads([
    lead("lp1", "2026-09-16", alphaId), // Wed source → works Thu 9/17 (prior week)
    lead("lp2", "2026-09-17", betaId), // Thu source → works Fri 9/18 (prior week)
    lead("lw1", "2026-09-18", null), // FRI source → works NEXT Monday 9/21
    lead("lw2", "2026-09-19", null), // SAT source → works Monday 9/21
    lead("lw3", "2026-09-20", null), // SUN source → works Monday 9/21
    lead("lc1", CUR_MON, alphaId), // Mon source → works Tue 9/22
    lead("lc2", "2026-09-22", betaId), // Tue source → works Wed 9/23
  ]);

  // One attributed booking per week (appt created inside the week, matched to
  // an over-threshold call of the same week).
  await store.upsertAppointments([
    {
      id: "appt-src-prior",
      acuity_appointment_id: "acuity-prior",
      contact_id: "contact-p1",
      calendar_id: "cal-1",
      appointment_type: "Family Portrait Session",
      appointment_datetime: ET("2026-09-24", "14:00"),
      created_at: ET("2026-09-17", "10:00"),
      status: "scheduled",
      cancelled: false,
    },
    {
      id: "appt-src-cur",
      acuity_appointment_id: "acuity-cur",
      contact_id: "contact-c5",
      calendar_id: "cal-1",
      appointment_type: "Family Portrait Session",
      appointment_datetime: ET("2026-10-02", "14:00"),
      created_at: ET("2026-09-23", "10:00"),
      status: "scheduled",
      cancelled: false,
    },
  ]);
  const appts = await store.getAllAppointmentsSince(ET("2026-09-01", "00:00"));
  const priorApptId = appts.find((a) => a.created_at === ET("2026-09-17", "10:00"))!.id;
  const curApptId = appts.find((a) => a.created_at === ET("2026-09-23", "10:00"))!.id;
  const attr = (appointment_id: string, call_id: string, rep_id: string): AttributionRow => ({
    id: `attr-${appointment_id}`,
    appointment_id,
    call_id,
    rep_id,
    method: "contact_id",
    confidence: 1,
    manual_override: false,
  });
  await store.upsertAttributions([attr(priorApptId, "call-p1", alphaId), attr(curApptId, "call-c5", betaId)]);

  // Goals are keyed by week_start — deliberately different per week.
  await store.upsertTeamGoal({ week_start: PRIOR_MON, booking_goal: 50, lead_budget: 700 });
  await store.upsertTeamGoal({ week_start: CUR_MON, booking_goal: 100, lead_budget: 700 });
  return { store, alphaId, betaId };
}

describe("WHOLE-PAGE ATOMICITY — one resolved range drives every payload section", () => {
  test("historical 'Week of Sep 14' payload: every section computes from THAT week only", async () => {
    const { store } = await seedCadenceStore();
    const p = await teamPageData({ range: "week-of", from: PRIOR_MON }, { store, today: FRI });

    // Range + live-state label.
    expect(p.range).toMatchObject({
      mode: "week-of",
      start: PRIOR_MON,
      end: PRIOR_SUN,
      label: "Week of Sep 14",
      isCurrentWeek: false,
    });

    // TEAM METRICS: only the prior week's rows. Alpha 4 calls (3 over) +
    // Beta 2 (2 over) = 6 total, 5 over; Saturday 9/19 is INSIDE the week.
    expect(p.metrics.totalCalls).toBe(6);
    expect(p.metrics.callsOverThreshold).toBe(5);
    expect(p.metrics.totalBookings).toBe(1);
    expect(p.metrics.assignedLeads).toBe(2); // work_dates 9/17 + 9/18

    // GOAL: keyed to week_start 9/14 (50), NOT the current week's 100.
    expect(p.teamGoalDefault).toBe(50);
    expect(p.metrics.goal.value).toBe(50);

    // REP STRIP: per-rep rows match the same week through the same engine.
    const alpha = p.repRows.find((r) => r.name === "Rep Alpha")!;
    const beta = p.repRows.find((r) => r.name === "Rep Beta")!;
    expect(alpha.callsOverThreshold).toBe(3);
    expect(beta.callsOverThreshold).toBe(2);
    expect(alpha.totalBookings).toBe(1);

    // TRENDS: a 7-day range buckets DAILY — every non-zero bucket key must
    // sit inside the resolved week, and the buckets sum to the payload's own
    // totals (same filtered rows through the one engine: no widget lag).
    const inRange = p.trends.points.filter(
      (pt) => pt.key >= PRIOR_MON && pt.key <= PRIOR_SUN,
    );
    expect(inRange.length).toBe(p.trends.points.length); // NO bucket outside the week
    expect(inRange.reduce((s, pt) => s + pt.calls, 0)).toBe(6);
    expect(inRange.reduce((s, pt) => s + pt.callsOverThreshold, 0)).toBe(5);
    expect(inRange.reduce((s, pt) => s + pt.leads, 0)).toBe(2); // work_date cohort
    expect(inRange.reduce((s, pt) => s + pt.bookings, 0)).toBe(1);
    // The LEAD COHORT (all leads worked, assigned or not) is 2 this week —
    // the weekend trio is worked NEXT Monday and must not appear here.
    expect(p.metrics.assignedLeads).toBe(2); // rep-linked: lp1 (Alpha) + lp2 (Beta)
  });

  test("CURRENT-WEEK payload (WTD Friday) shows ONLY current data — no historical lag", async () => {
    const { store } = await seedCadenceStore();
    const p = await teamPageData({ range: "this-week" }, { store, today: FRI });
    expect(p.range).toMatchObject({ mode: "this-week", start: CUR_MON, end: FRI, isCurrentWeek: true });
    // Alpha 4 over + Beta 1 over = 5; Alpha's Saturday 9/19 call MUST NOT leak.
    expect(p.metrics.totalCalls).toBe(5);
    expect(p.metrics.callsOverThreshold).toBe(5);
    expect(p.metrics.totalBookings).toBe(1);
    // Rep-linked leads WTD: Mon source (work 9/22, Alpha) + Tue source
    // (work 9/23, Beta) = 2; the FULL work-date cohort is 5 — the weekend
    // trio (Fri/Sat/Sun sources → work 9/21) + those two.
    expect(p.metrics.assignedLeads).toBe(2);
    const cohort = p.trends.points
      .filter((pt) => pt.key >= CUR_MON && pt.key <= FRI)
      .reduce((s, pt) => s + pt.leads, 0);
    expect(cohort).toBe(5); // 3 weekend-source + 2 in-week leads, all worked WTD
    expect(p.teamGoalDefault).toBe(100);
  });

  test("goal independence per week_start: current/future goal changes never rewrite the past", async () => {
    const { store } = await seedCadenceStore();
    const before = await teamPageData({ range: "week-of", from: PRIOR_MON }, { store, today: FRI });
    expect(before.metrics.goal.value).toBe(50);
    // Change the CURRENT week's goal and add a FUTURE week's goal.
    await store.upsertTeamGoal({ week_start: CUR_MON, booking_goal: 200, lead_budget: 700 });
    await store.upsertTeamGoal({ week_start: MON, booking_goal: 300, lead_budget: 700 });
    const after = await teamPageData({ range: "week-of", from: PRIOR_MON }, { store, today: FRI });
    expect(after.metrics.goal.value).toBe(50); // prior week untouched
    expect(after.teamGoalDefault).toBe(50);
    // …while the current-week payload sees the change (live week is live).
    const cur = await teamPageData({ range: "this-week" }, { store, today: FRI });
    expect(cur.metrics.goal.value).toBe(200);
  });

  test("weekend-source leads land in the week that WORKS them (Monday), not their source week", async () => {
    const { store } = await seedCadenceStore();
    const prior = await teamPageData({ range: "week-of", from: PRIOR_MON }, { store, today: FRI });
    const cur = await teamPageData({ range: "week-of", from: CUR_MON }, { store, today: FRI });
    // Prior week works only its own weekdays' cohort (9/17 + 9/18).
    expect(prior.metrics.assignedLeads).toBe(2);
    const priorCohort = prior.trends.points.reduce((s, pt) => s + pt.leads, 0);
    expect(priorCohort).toBe(2);
    // Full current week (Mon..Sun): work_dates 9/21 (weekend trio) + 9/22 + 9/23 = 5.
    const curCohort = cur.trends.points.reduce((s, pt) => s + pt.leads, 0);
    expect(curCohort).toBe(5);
    expect(cur.metrics.assignedLeads).toBe(2); // rep-linked subset
    // The Saturday 9/19 call belongs to the PRIOR week, not the current week.
    expect(cur.metrics.totalCalls).toBe(5);
  });

  test("page-consistency: the same week twice renders IDENTICAL payloads (no drift between widgets)", async () => {
    const { store } = await seedCadenceStore();
    const a = await teamPageData({ range: "week-of", from: PRIOR_MON }, { store, today: FRI });
    const b = await teamPageData({ range: "week-of", from: PRIOR_MON }, { store, today: FRI });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // And the selected week is stable across different views of the same week
    // (selector value = weekStart of the resolved start).
    const viaSunday = await teamPageData({ range: "week-of", from: PRIOR_SUN }, { store, today: FRI });
    expect(viaSunday.range.start).toBe(a.range.start);
    expect(JSON.stringify(viaSunday.metrics)).toBe(JSON.stringify(a.metrics));
  });

  test("cross-page consistency: Reps and Team compute the SAME week through the ONE engine", async () => {
    const { store, alphaId } = await seedCadenceStore();
    const team = await teamPageData({ range: "week-of", from: PRIOR_MON }, { store, today: FRI });
    const reps = await repsPageData({ range: "week-of", from: PRIOR_MON }, { store, today: FRI });
    // Same resolved range + live-state on both pages.
    expect(reps.range).toMatchObject({ start: PRIOR_MON, end: PRIOR_SUN, label: "Week of Sep 14", isCurrentWeek: false });
    // Reps page repList agrees with the Team page rep strip (same summaries).
    const rAlpha = reps.repList.find((r) => r.id === alphaId)!;
    const tAlpha = team.repRows.find((r) => r.name === "Rep Alpha")!;
    expect(rAlpha.totalCalls).toBe(4);
    expect(rAlpha.callsOverThreshold).toBe(tAlpha.callsOverThreshold);
    expect(rAlpha.totalBookings).toBe(tAlpha.totalBookings);
    expect(reps.thresholdSeconds).toBe(team.thresholdSeconds);
  });

  test("Monday 12AM ET: WTD is fresh AND the prior week stays retrievable intact", async () => {
    const { store } = await seedCadenceStore();
    // New week begins: today = Monday 9/28 (12AM ET flip).
    const wtd = await teamPageData({ range: "this-week" }, { store, today: MON });
    expect(wtd.range).toMatchObject({ start: MON, end: MON, isCurrentWeek: true });
    expect(wtd.metrics.totalCalls).toBe(0); // nothing worked yet in the new week
    expect(wtd.metrics.assignedLeads).toBe(0);
    // Prior week fully intact through the selector — including the Saturday call.
    const prior = await teamPageData({ range: "week-of", from: CUR_MON }, { store, today: MON });
    expect(prior.range).toMatchObject({ start: CUR_MON, end: SUN, isCurrentWeek: false });
    expect(prior.metrics.totalCalls).toBe(5); // Alpha 4 + Beta 1 (Mon..Sun full week)
    expect(prior.metrics.assignedLeads).toBe(2); // rep-linked: lc1 + lc2
    const priorCohort = prior.trends.points.reduce((s, pt) => s + pt.leads, 0);
    expect(priorCohort).toBe(5); // full work-date cohort incl. the weekend trio
    expect(prior.teamGoalDefault).toBe(100);
  });
});
