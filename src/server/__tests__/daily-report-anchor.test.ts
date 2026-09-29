/**
 * DAILY REPORT PERFORMANCE ANCHOR (owner directive) — regression tests.
 *
 * The Daily Report's performance figures (Bookings, Conversation Conversion,
 * Assigned Lead Conversion) cover the most recent COMPLETE operating day:
 *  - workday at/after 18:30 ET (PACE_DAY_CUTOFF_ET_MINUTES) → TODAY;
 *  - otherwise (before 18:30 on a workday, or Sat/Sun any time) → the most
 *    recent PRIOR workday (Mon→Fri, Tue–Fri→yesterday, Sat/Sun→Fri).
 * Never Saturday, never Sunday. The LEADS section is UNCHANGED: today's
 * work-date cohort, weekly budget, pace — the anchor never moves those.
 *
 * Labels/banners name the ACTUAL day: "Bookings Yesterday" only when the
 * anchor really is the calendar prior day; "Bookings Friday" on a Monday
 * morning; "Bookings Today" after EOD; the copied report's line says which
 * day it covers ("Bookings (Fri): 4").
 */
import { describe, expect, test } from "bun:test";
import {
  buildDailyReportMetrics,
  type AppointmentRow,
  type AttributionRow,
  type CallRow,
  type LeadRow,
} from "../metrics/compute";
import {
  anchorDayPhrase,
  bookingsAnchorLabel,
  bookingsAnchorLineLabel,
  buildDailyReportEmail,
  buildDailyReportSlack,
  buildDailyReportText,
} from "../metrics/report-text";
import { dailyReportAnchorDate, weekdayName } from "../date-logic";
import { MemoryStore } from "../store/memory";
import { dailyReportPageData } from "../page-data";

// Operating week Mon 2026-09-21 .. Sun 2026-09-27 (+ the next Monday).
const MON = "2026-09-28"; // the Monday AFTER the fixture week (Monday-morning case)
const W1_MON = "2026-09-21";
const TUE = "2026-09-22";
const THU = "2026-09-24";
const FRI = "2026-09-25";
const SAT = "2026-09-26";
const SUN = "2026-09-27";
const H0900 = 9 * 60;
const H1830 = 18 * 60 + 30; // PACE_DAY_CUTOFF_ET_MINUTES — the owner EOD
const H1831 = 18 * 60 + 31;

// ---------- fixtures (mirror the existing pure-row shapes) ----------
const call = (id: string, startedAt: string, dur: number): CallRow => ({
  id,
  rep_id: "r1",
  contact_id: "k1",
  started_at: startedAt,
  duration_seconds: dur,
  over_two_minutes: dur > 120,
});
const attr = (apptId: string, callId: string | null, repId: string | null): AttributionRow => ({
  id: `v-${apptId}`,
  appointment_id: apptId,
  call_id: callId,
  rep_id: repId,
  method: callId ? "call_id" : repId ? "contact_id" : "none",
  confidence: repId ? 1 : 0,
  manual_override: false,
});
const lead = (id: string, type: string, work: string): LeadRow => ({
  id,
  lead_type: type,
  source_date: work,
  work_date: work,
  contact_id: "k1",
  assigned_rep_id: "r1",
  source_sheet: type,
});
const winAppt = (id: string, createdDate: string): AppointmentRow => ({
  id,
  contact_id: "k1",
  calendar_id: "cal-1",
  appointment_type: "Family Portrait Session",
  appointment_datetime: `${createdDate}T14:00:00.000Z`,
  created_at: `${createdDate}T14:00:00.000Z`,
  created_business_date: createdDate,
  raw: { priceSold: "300.00", amountPaid: "300.00", certificate: null, canceled: false },
  status: "scheduled",
  cancelled: false,
});

const baseInput = {
  teamBookingGoal: 79,
  weeklyLeadBudget: 700,
  thresholdSeconds: 120,
};

// ---------- the anchor rule itself ----------
describe("dailyReportAnchorDate — the owner performance-anchor rule", () => {
  test("Mon 09:00 → Friday (the most recent prior workday — never Sunday)", () => {
    expect(dailyReportAnchorDate(MON, H0900)).toBe(FRI);
  });
  test("Mon 18:29 → Friday; Mon 18:30 → Monday (EOD cutoff inclusive, same as pace)", () => {
    expect(dailyReportAnchorDate(MON, H1830 - 1)).toBe(FRI);
    expect(dailyReportAnchorDate(MON, H1830)).toBe(MON);
  });
  test("Tue 07:00 → Monday", () => {
    expect(dailyReportAnchorDate(TUE, H0900)).toBe(W1_MON);
  });
  test("Fri 18:31 → Friday (today counts once the day is worked out)", () => {
    expect(dailyReportAnchorDate(FRI, H1831)).toBe(FRI);
  });
  test("Sat/Sun any time → Friday; never Saturday, never Sunday", () => {
    expect(dailyReportAnchorDate(SAT, H0900)).toBe(FRI);
    expect(dailyReportAnchorDate(SAT, H1831)).toBe(FRI);
    expect(dailyReportAnchorDate(SUN, H0900)).toBe(FRI);
    expect(dailyReportAnchorDate(SUN, 23 * 60 + 59)).toBe(FRI);
  });
  test("Thursday 09:00 → Wednesday (plain prior workday); weekdayName renders both forms", () => {
    expect(dailyReportAnchorDate(THU, H0900)).toBe("2026-09-23");
    expect(weekdayName(FRI, true)).toBe("Friday");
    expect(weekdayName(FRI, false)).toBe("Fri");
  });
});

// ---------- the metrics builder under the anchor ----------
describe("buildDailyReportMetrics under the anchor rule (conversions re-dated)", () => {
  test("MONDAY MORNING: anchor Friday — conversation conversion from FRIDAY's calls, assigned-lead conversion from FRIDAY's cohort", () => {
    const m = buildDailyReportMetrics({
      reportDate: MON,
      etNowMinutes: H0900,
      callsAnchorDay: [call("c1", "2026-09-25T14:00:00.000Z", 300), call("c2", "2026-09-25T15:00:00.000Z", 60)],
      apptsCreatedAnchorDay: [winAppt("a1", FRI)],
      apptsCreatedWtd: [winAppt("a1", FRI)],
      allCallsForWeek: [call("c1", "2026-09-25T14:00:00.000Z", 300), call("c9", "2026-09-28T13:00:00.000Z", 500)],
      attributions: [attr("a1", "c1", "r1")],
      // FRIDAY's cohort (work_date Fri — Thursday-sourced leads) + Monday's cohort
      leadsAllRecent: [lead("l1", "family", FRI), lead("l2", "animalia", FRI), lead("l3", "animalia", FRI), lead("l4", "family", MON)],
      ...baseInput,
    });
    expect(m.anchorDate).toBe(FRI);
    expect(m.bookingsAnchorDay).toBe(1);
    expect(m.conversationConversion).toBeCloseTo(1 / 1, 6); // win from the 300s FRIDAY call ÷ 1 over-threshold Friday call
    expect(m.assignedLeadConversion).toBeCloseTo(1 / 3, 6); // 1 win ÷ 3 leads worked FRIDAY (no more Monday "unavailable")
    // LEADS SECTION UNCHANGED: today's (Monday) work-date cohort + weekly budget figures
    expect(m.leadsToday).toBe(1);
    expect(m.familyLeadsToday).toBe(1);
    expect(m.animaliaLeadsToday).toBe(0);
    expect(m.weeklyLeads).toBe(1); // weekly counts work_date Mon..Sun only — Friday's cohort is LAST week
    expect(m.leadCohortSourceDates).toEqual([FRI, SAT, SUN]); // Monday's cohort, untouched
    expect(m.paceWeekend).toBe(false);
  });

  test("MONDAY MORNING with no Friday data: conversions null — the banner phrase names FRIDAY", () => {
    const m = buildDailyReportMetrics({
      reportDate: MON,
      etNowMinutes: H0900,
      callsAnchorDay: [],
      apptsCreatedAnchorDay: [],
      apptsCreatedWtd: [],
      allCallsForWeek: [],
      attributions: [],
      leadsAllRecent: [],
      ...baseInput,
    });
    expect(m.anchorDate).toBe(FRI);
    expect(m.conversationConversion).toBeNull();
    expect(m.assignedLeadConversion).toBeNull();
    expect(anchorDayPhrase(m.anchorDate, m.reportDate)).toBe("Friday");
    expect(bookingsAnchorLabel(m.anchorDate, m.reportDate)).toBe("Bookings Friday");
    expect(bookingsAnchorLineLabel(m.anchorDate, m.reportDate)).toBe("Bookings (Fri)");
    expect(buildDailyReportText(m, { priority1: "p", priority2: "p", priority3: "p" })).toContain("Bookings (Fri): 0");
  });

  test("AFTER EOD on a workday: anchor TODAY — 'Bookings Today' label; conversions from today's calls/cohort", () => {
    const m = buildDailyReportMetrics({
      reportDate: TUE,
      etNowMinutes: H1830,
      callsAnchorDay: [call("c1", "2026-09-22T14:00:00.000Z", 300), call("c2", "2026-09-22T15:00:00.000Z", 30)],
      apptsCreatedAnchorDay: [winAppt("a1", TUE), winAppt("a2", TUE)],
      apptsCreatedWtd: [winAppt("a1", TUE), winAppt("a2", TUE)],
      allCallsForWeek: [call("c1", "2026-09-22T14:00:00.000Z", 300), call("c2", "2026-09-22T15:00:00.000Z", 30)],
      attributions: [attr("a1", "c1", "r1"), attr("a2", "c2", "r1")],
      leadsAllRecent: [lead("l1", "family", TUE), lead("l2", "animalia", TUE), lead("l3", "family", TUE), lead("l4", "animalia", TUE)],
      ...baseInput,
    });
    expect(m.anchorDate).toBe(TUE);
    expect(m.bookingsAnchorDay).toBe(2);
    expect(bookingsAnchorLabel(m.anchorDate, m.reportDate)).toBe("Bookings Today");
    expect(anchorDayPhrase(m.anchorDate, m.reportDate)).toBe("today");
    expect(m.conversationConversion).toBeCloseTo(1 / 1, 6); // a2's call is only 30s — under threshold
    expect(m.assignedLeadConversion).toBeCloseTo(2 / 4, 6);
    const text = buildDailyReportText(m, { priority1: "p", priority2: "p", priority3: "p" });
    expect(text).toContain("Bookings (Today): 2");
    expect(buildDailyReportEmail(m, { priority1: "p", priority2: "p", priority3: "p" })).toContain("Bookings (Today): 2");
    expect(buildDailyReportSlack(m, { priority1: "p", priority2: "p", priority3: "p" })).toContain("Bookings (Today): 2");
  });

  test("WEEKEND report: anchor Friday; leads panel UNCHANGED (Saturday's cohort counts, Sunday-sourced included)", () => {
    const m = buildDailyReportMetrics({
      reportDate: SAT,
      etNowMinutes: H0900,
      callsAnchorDay: [call("c1", "2026-09-25T14:00:00.000Z", 300)],
      apptsCreatedAnchorDay: [winAppt("a1", FRI)],
      apptsCreatedWtd: [],
      allCallsForWeek: [call("c1", "2026-09-25T14:00:00.000Z", 300)],
      attributions: [attr("a1", "c1", "r1")],
      // Saturday's cohort: leads with work_date SAT (sourced Fri/Sat/Sun per getLeadCohort)
      leadsAllRecent: [lead("l1", "family", SAT), lead("l2", "animalia", SAT)],
      ...baseInput,
    });
    expect(m.anchorDate).toBe(FRI); // never Sunday's empty data
    expect(m.bookingsAnchorDay).toBe(1);
    expect(m.conversationConversion).toBeCloseTo(1 / 1, 6);
    // untouched leads panel: Saturday's work-date cohort — includes Sunday-sourced leads by design
    expect(m.leadsToday).toBe(2);
    expect(m.leadCohortSourceDates).toEqual([FRI, SAT, SUN]);
    // pace figures unchanged on the weekend
    expect(m.paceWeekend).toBe(true);
    expect(m.dailyBookingsNeeded).toBe(0);
    expect(m.dailyLeadsNeeded).toBe(0);
    // Saturday's anchor IS the calendar prior day → unchanged "yesterday" wording
    expect(anchorDayPhrase(m.anchorDate, m.reportDate)).toBe("yesterday");
    expect(bookingsAnchorLabel(m.anchorDate, m.reportDate)).toBe("Bookings Yesterday");
    expect(bookingsAnchorLineLabel(m.anchorDate, m.reportDate)).toBe("Bookings");
  });

  test("WITHOUT a threaded clock (legacy callers/tests): anchor stays the calendar yesterday", () => {
    const m = buildDailyReportMetrics({
      reportDate: "2026-09-23", // Wednesday
      callsAnchorDay: [],
      apptsCreatedAnchorDay: [],
      apptsCreatedWtd: [],
      allCallsForWeek: [],
      attributions: [],
      leadsAllRecent: [],
      ...baseInput,
    });
    expect(m.anchorDate).toBe("2026-09-22"); // calendar prior day — pre-anchor semantics
    expect(anchorDayPhrase(m.anchorDate, m.reportDate)).toBe("yesterday");
  });
});

// ---------- label units: day-name wording, never mislabeled "yesterday" ----------
describe("anchor labels + banner phrases", () => {
  test("anchor == calendar yesterday → unchanged 'yesterday' wording everywhere", () => {
    expect(anchorDayPhrase(THU, FRI)).toBe("yesterday");
    expect(bookingsAnchorLabel(THU, FRI)).toBe("Bookings Yesterday");
    expect(bookingsAnchorLineLabel(THU, FRI)).toBe("Bookings");
  });
  test("Monday morning → Friday naming (KPI, sublabel, compact line)", () => {
    expect(anchorDayPhrase(FRI, MON)).toBe("Friday");
    expect(bookingsAnchorLabel(FRI, MON)).toBe("Bookings Friday");
    expect(bookingsAnchorLineLabel(FRI, MON)).toBe("Bookings (Fri)");
  });
  test("anchor == today (EOD) → 'today' / 'Bookings Today' / 'Bookings (Today)'", () => {
    expect(anchorDayPhrase(TUE, TUE)).toBe("today");
    expect(bookingsAnchorLabel(TUE, TUE)).toBe("Bookings Today");
    expect(bookingsAnchorLineLabel(TUE, TUE)).toBe("Bookings (Today)");
  });
});

// ---------- page-level (MemoryStore): banners + report text name the anchor day ----------
describe("dailyReportPageData under the anchor rule", () => {
  // 2026-09-28 is a Monday; EDT = UTC-4 — fixture instants carry explicit offsets.
  const ET = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString();

  async function seedStoreWith(opts: {
    fridayCalls: boolean;
    fridayWins: boolean;
    fridayLeads: boolean;
    /** Today-cohort leads; off for the Tuesday test so the Monday anchor denominator is truly empty. */
    mondayLeads?: boolean;
  }) {
    const store = new MemoryStore();
    await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
    await store.upsertUsers([
      { id: "u-src-1", provider: "highlevel", external_id: "hl-1", name: "Rep One", email: null, is_active: true, call_start_date: null },
    ]);
    const repId = (await store.getAllUsers())[0].id;
    if (opts.fridayCalls) {
      await store.upsertCalls([
        {
          id: "call-fri-1",
          external_call_id: "ext-fri-1",
          provider: "highlevel",
          rep_id: repId,
          contact_id: "k1",
          started_at: ET(FRI, "10:00"),
          duration_seconds: 300,
          over_two_minutes: true,
        },
      ]);
    }
    if (opts.fridayWins) {
      await store.upsertAppointments([
        {
          id: "appt-fri-win",
          acuity_appointment_id: "acuity-fri-win",
          contact_id: "k1",
          calendar_id: "cal-1",
          calendar_name: "MALLORY PORTRAITS",
          appointment_type: "Family Portrait Session",
          appointment_datetime: ET(FRI, "14:00"),
          created_at: ET(FRI, "12:00"),
          raw: { priceSold: "300.00", amountPaid: "300.00", certificate: null, canceled: false },
          status: "scheduled",
          cancelled: false,
        },
      ]);
      await store.upsertAttributions([
        { id: "attr-fri-1", appointment_id: "appt-fri-win", call_id: opts.fridayCalls ? "call-fri-1" : null, rep_id: repId, method: "call_id", confidence: 1, manual_override: false },
      ]);
    }
    if (opts.fridayLeads) {
      await store.upsertLeads([
        { id: "l-fri-1", lead_type: "family", source_date: THU, work_date: FRI, contact_id: "k1", assigned_rep_id: repId, source_sheet: "family", source_id: "src-fri-1", provider: "sheets" },
      ]);
    }
    // TODAY's (Monday) cohort so the leads warning never fires in these tests.
    if (opts.mondayLeads !== false) {
      await store.upsertLeads([
        { id: "l-mon-1", lead_type: "animalia", source_date: SAT, work_date: MON, contact_id: "k1", assigned_rep_id: repId, source_sheet: "animalia", source_id: "src-mon-1", provider: "sheets" },
        { id: "l-mon-2", lead_type: "animalia", source_date: SUN, work_date: MON, contact_id: "k1", assigned_rep_id: repId, source_sheet: "animalia", source_id: "src-mon-2", provider: "sheets" },
      ]);
    }
    return { store, repId };
  }

  test("Monday-morning report computes Friday's numbers end-to-end; no anchor-day warnings", async () => {
    const { store } = await seedStoreWith({ fridayCalls: true, fridayWins: true, fridayLeads: true });
    const data = await dailyReportPageData({ store, today: MON, etNowMinutes: H0900 });
    expect(data.metrics.anchorDate).toBe(FRI);
    expect(data.metrics.bookingsAnchorDay).toBe(1);
    expect(data.metrics.conversationConversion).not.toBeNull();
    expect(data.metrics.assignedLeadConversion).not.toBeNull();
    expect(data.warnings.some((w) => w.includes("Conversation Conversion is unavailable"))).toBe(false);
    expect(data.warnings.some((w) => w.includes("Assigned Lead Conversion is unavailable"))).toBe(false);
    expect(data.reportText).toContain("Bookings (Fri): 1");
    expect(data.emailText).toContain("Bookings (Fri): 1");
    expect(data.slackText).toContain("Bookings (Fri): 1");
  });

  test("Monday-morning with NO Friday data: banners name FRIDAY (never 'yesterday')", async () => {
    const { store } = await seedStoreWith({ fridayCalls: false, fridayWins: false, fridayLeads: false });
    const data = await dailyReportPageData({ store, today: MON, etNowMinutes: H0900 });
    expect(data.metrics.anchorDate).toBe(FRI);
    expect(data.warnings).toContain("No qualifying calls recorded Friday — Conversation Conversion is unavailable.");
    expect(data.warnings).toContain("No leads worked Friday — Assigned Lead Conversion is unavailable.");
  });

  test("Tuesday-morning with prior-day data: banners keep the unchanged 'yesterday' wording", async () => {
    const { store } = await seedStoreWith({ fridayCalls: false, fridayWins: false, fridayLeads: false, mondayLeads: false });
    const data = await dailyReportPageData({ store, today: "2026-09-22", etNowMinutes: H0900 });
    expect(data.metrics.anchorDate).toBe(W1_MON);
    expect(data.warnings).toContain("No qualifying calls recorded yesterday — Conversation Conversion is unavailable.");
    expect(data.warnings).toContain("No leads worked yesterday — Assigned Lead Conversion is unavailable.");
  });

  test("After EOD on a Monday: anchor is TODAY; report text says 'Bookings (Today)'", async () => {
    const { store } = await seedStoreWith({ fridayCalls: false, fridayWins: false, fridayLeads: false });
    const data = await dailyReportPageData({ store, today: MON, etNowMinutes: H1830 });
    expect(data.metrics.anchorDate).toBe(MON);
    expect(data.reportText).toContain("Bookings (Today): 0");
    expect(data.warnings).toContain("No qualifying calls recorded today — Conversation Conversion is unavailable.");
  });
});
