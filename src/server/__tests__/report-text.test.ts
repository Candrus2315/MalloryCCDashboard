import { describe, expect, test } from "bun:test";
import { buildDailyReportMetrics, type DailyReportMetrics } from "../metrics/compute";
import {
  big3Incomplete,
  buildDailyReportEmail,
  buildDailyReportSlack,
  buildDailyReportText,
  formatInt,
  formatPercent,
  type Big3Input,
} from "../metrics/report-text";
import type { AppointmentRow, AttributionRow, CallRow, LeadRow } from "../metrics/compute";

// ---------- helpers ----------

const specExampleMetrics = (): DailyReportMetrics => ({
  fairylandLeadsToday: 0,
  reportDate: "2026-09-25",
  anchorDate: "2026-09-24", // calendar yesterday — the SPEC's "next morning" report
  weekStart: "2026-09-21",
  leadCohortSourceDates: ["2026-09-24"],
  bookingsAnchorDay: 11,
  bookingsWtd: 37,
  // OWNER PARITY DIRECTIVE 10/30: the week lines run on the canonical weekly
  // gross — here the same 37 (the fixture has no separate production input).
  weekBookings: 37,
  weeklyBookingGoal: 79,
  bookingsLeft: 42,
  dailyBookingsNeeded: 21,
  conversationConversion: 0.6363,
  assignedLeadConversion: 0.1318,
  // OWNER DIRECTIVE 10/30: the two total-lead conversion lines + pickup
  // placeholder (null → "—" until the owner approves a definition).
  totalLeadConversionYesterday: 0.6363,
  totalLeadConversionWeek: 37 / 594,
  dailyPickupRate: null,
  goalAchievement: 0.5316,
  weeklyLeadBudget: 700,
  leadsToday: 80,
  familyLeadsToday: 27,
  animaliaLeadsToday: 53,
  weeklyLeads: 594,
  leadBudgetUsedPct: 0.8486,
  leadsRemaining: 106,
  dailyLeadsNeeded: 27,
});

const specExampleBig3: Big3Input = {
  priority1: "Morning Rev",
  priority2: "Candidate follow up",
  priority3: "1 on 1s",
};

/**
 * The SPEC example (owner's Daily CC Report format) — percentages at the
 * ONE-decimal precision the owner flagged (2026-10-28): "63.6%", never
 * "63.63%" and never float dust ("71.7857…%").
 */
const SPEC_EXAMPLE = [
  "Daily CC Report",
  "",
  "Bookings Yesterday: 11",
  "Bookings for the Week: 37",
  "Key Driver: 79",
  "Left: 42",
  "Daily: 21",
  "Total Lead Conversion — Yesterday: 63.6%",
  "Total Lead Conversion — Week: 6.2%",
  "Daily Pickup Rate: —",
  "",
  "Leads:",
  "Weekly Lead Budget: 700",
  "Leads Today: 80",
  "Family: 27",
  "Animalia: 53",
  "Fairyland: 0",
  "Total Weekly Leads: 594",
  "% of Budget Used: 84.9%",
  "Leads Remaining: 106",
  "",
  "Big 3:",
  "1. Morning Rev",
  "2. Candidate follow up",
  "3. 1 on 1s",
].join("\n");

// ---------- formatting ----------

describe("report text formatting", () => {
  test("percentages: 2 decimals, half-up at exact boundaries (63.625 → 63.63%)", () => {
    expect(formatPercent(0.6363)).toBe("63.63%");
    expect(formatPercent(0.63625)).toBe("63.63%"); // half-up edge case
    expect(formatPercent(0.1318)).toBe("13.18%");
    expect(formatPercent(0.5316)).toBe("53.16%");
    expect(formatPercent(0.8486)).toBe("84.86%");
    expect(formatPercent(0.5)).toBe("50.00%");
    expect(formatPercent(1)).toBe("100.00%");
    expect(formatPercent(0)).toBe("0.00%");
  });

  test("DAILY REPORT precision (owner-flagged): one decimal, never float dust", () => {
    // The copied report's four percentages are formatPercent(x, 1): a
    // repeating-decimal ratio renders clean ("71.8%"), never the raw float
    // ("71.78571428571429%") and never the 2-decimal default ("71.79%").
    expect(formatPercent(0.7178571428571428, 1)).toBe("71.8%"); // 503/7 % dust
    expect(formatPercent(2 / 3, 1)).toBe("66.7%"); // repeating 6s
    expect(formatPercent(43 / 79, 1)).toBe("54.4%"); // live goal-achievement shape
    expect(formatPercent(0.5, 1)).toBe("50.0%");
    expect(formatPercent(1, 1)).toBe("100.0%");
    const text = buildDailyReportText(specExampleMetrics(), specExampleBig3);
    for (const line of text.split("\n")) {
      for (const match of line.matchAll(/(\d+\.\d+)%/g)) {
        expect(match[1].split(".")[1]).toHaveLength(1); // exactly one decimal
      }
      expect(line).not.toMatch(/\d{3,}\.\d/); // no long float tails anywhere
    }
    expect(text).toContain("Total Lead Conversion — Yesterday: 63.6%");
    expect(text).toContain("Total Lead Conversion — Week: 6.2%");
    expect(text).toContain("Bookings Yesterday: 11");
    expect(text).not.toContain("Conversion of Calls Over 2 Mins");
    expect(text).not.toContain("Conversion of Assigned Leads");
    expect(text).not.toContain("% of Appt Achieved");
    expect(text).toContain("% of Budget Used: 84.9%");
    expect(text).not.toContain("63.63%");
  });

  test("counts stay integer-formatted; missing data renders as em dash", () => {
    expect(formatInt(80)).toBe("80");
    expect(formatInt(700)).toBe("700");
    expect(formatInt(0)).toBe("0");
    expect(formatInt(null)).toBe("—");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
  });
});

// ---------- SPEC example snapshot ----------

describe("buildDailyReportText (SPEC example)", () => {
  test("reproduces the SPEC example EXACTLY when fed those metric values", () => {
    const text = buildDailyReportText(specExampleMetrics(), specExampleBig3);
    expect(text).toBe(SPEC_EXAMPLE);
  });

  test("unfilled Big 3 slots render as em dash placeholders, never plausible content", () => {
    const text = buildDailyReportText(specExampleMetrics(), { priority1: "Morning Rev" });
    expect(text).toContain("Big 3:\n1. Morning Rev\n2. —\n3. —");
    expect(big3Incomplete({ priority1: "a" })).toBe(true);
    expect(big3Incomplete(specExampleBig3)).toBe(false);
  });

  test("COPY FOR EMAIL prefixes a subject line with the report date", () => {
    const email = buildDailyReportEmail(specExampleMetrics(), specExampleBig3);
    expect(email).toBe(`Subject: Daily CC Report — Fri, Sep 25\n\n${SPEC_EXAMPLE}`);
  });

  test("COPY FOR SLACK fences the base text in a code block", () => {
    const slack = buildDailyReportSlack(specExampleMetrics(), specExampleBig3);
    expect(slack).toBe("```\n" + SPEC_EXAMPLE + "\n```");
  });
});

// ---------- metric assembly ----------

describe("buildDailyReportMetrics (assembles raw rows via the metrics layer)", () => {
  const T = "2026-09-25"; // Friday report date → worked leads = Thursday's
  const call = (id: string, startedAt: string, dur: number): CallRow => ({
    id,
    rep_id: "r1",
    contact_id: "k1",
    started_at: startedAt,
    duration_seconds: dur,
    over_two_minutes: dur > 120,
  });
  const appt = (id: string, createdAt: string, status = "scheduled"): AppointmentRow => ({
    id,
    contact_id: "k1",
    calendar_id: "cal-1",
    appointment_type: "Family Portrait Session",
    appointment_datetime: "2026-10-01T14:00:00.000Z",
    created_at: createdAt,
    status,
    cancelled: status === "cancelled",
  });
  const attr = (appointmentId: string, callId: string): AttributionRow => ({
    id: "t-" + appointmentId,
    appointment_id: appointmentId,
    call_id: callId,
    rep_id: "r1",
    method: "contact_id",
    confidence: 1,
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

  test("yesterday's bookings/conversions + week progress + work-date lead cohort", () => {
    const m = buildDailyReportMetrics({
      reportDate: T,
      // yesterday (Thu Sep 24, ET) calls: 2 total, 1 over threshold
      callsAnchorDay: [call("c1", "2026-09-24T14:00:00.000Z", 300), call("c2", "2026-09-24T15:00:00.000Z", 60)],
      // bookings created yesterday: 2 (1 cancelled → excluded)
      apptsCreatedAnchorDay: [appt("a1", "2026-09-24T16:00:00.000Z"), appt("a2", "2026-09-24T17:00:00.000Z", "cancelled"), appt("a3", "2026-09-24T18:00:00.000Z")],
      // WTD: yesterday's 2 + today's 1 = 3
      apptsCreatedWtd: [
        appt("a1", "2026-09-24T16:00:00.000Z"),
        appt("a3", "2026-09-24T18:00:00.000Z"),
        appt("a4", "2026-09-25T14:00:00.000Z"),
      ],
      allCallsForWeek: [call("c1", "2026-09-24T14:00:00.000Z", 300), call("c9", "2026-09-25T13:00:00.000Z", 500)],
      attributions: [attr("a1", "c1"), attr("a4", "c9")], // a3 has no qualifying call
      leadsAllRecent: [
        lead("l1", "family", "2026-09-25"), // worked today
        lead("l2", "animalia", "2026-09-25"),
        lead("l3", "family", "2026-09-24"), // worked yesterday
        lead("l6", "animalia", "2026-09-24"), // worked yesterday
        lead("l4", "animalia", "2026-09-22"),
        lead("l5", "family", "2026-09-22"),
      ],
      teamBookingGoal: 79,
      weeklyLeadBudget: 700,
      thresholdSeconds: 120,
    });

    expect(m.bookingsAnchorDay).toBe(2); // cancelled excluded
    expect(m.bookingsWtd).toBe(3);
    expect(m.weekBookings).toBe(3); // the canonical qualifying WTD count (the ONLY basis — owner 10/30 post-#126)
    expect(m.bookingsLeft).toBe(76); // 79 - 3 (live weekly remaining)
    // FROZEN START-OF-DAY TARGET (owner rev 90): wins BEFORE Friday = 2 (a1, a3;
    // a4 is Friday's) → deficit 77 ÷ 1 Friday workday = 77 — NOT the live 76,
    // which would compare Friday's booking against a requirement containing it.
    expect(m.winsBeforeToday).toBe(2);
    expect(m.dailyBookingsNeeded).toBe(Math.ceil(77 / 1)); // Friday → 1 WORKING day left (Mon–Fri)
    expect(m.conversationConversion).toBeCloseTo(1 / 1, 6); // a1 from 300s call; a3 unattributed
    expect(m.assignedLeadConversion).toBeCloseTo(2 / 2, 6); // 2 bookings ÷ 2 leads worked yesterday
    expect(m.goalAchievement).toBeCloseTo(3 / 79, 6);
    expect(m.leadsToday).toBe(2); // work_date = report date (cohort logic)
    expect(m.familyLeadsToday).toBe(1);
    expect(m.animaliaLeadsToday).toBe(1);
    expect(m.weeklyLeads).toBe(6);
    expect(m.leadBudgetUsedPct).toBeCloseTo(6 / 700, 6);
    expect(m.leadsRemaining).toBe(694);
    expect(m.leadCohortSourceDates).toEqual(["2026-09-24"]); // Fri works Thu
    // OWNER DIRECTIVE 10/30: the total-lead conversion lines. Yesterday = the
    // SAME pooled numerator as "Bookings Yesterday" (2) ÷ the anchor day's
    // TOTAL leads (l3+l6 = 2). Week = weekBookings 3 ÷ weekly leads 6.
    expect(m.totalLeadConversionYesterday).toBeCloseTo(2 / 2, 6);
    expect(m.totalLeadConversionWeek).toBeCloseTo(3 / 6, 6);
    expect(m.dailyPickupRate).toBeNull(); // definition pending (owner 10/30) — never a number
  });

  test("missing yesterday data → null conversions (page shows a warning, not a number)", () => {
    const m = buildDailyReportMetrics({
      reportDate: T,
      callsAnchorDay: [],
      apptsCreatedAnchorDay: [],
      apptsCreatedWtd: [],
      allCallsForWeek: [],
      attributions: [],
      leadsAllRecent: [],
      teamBookingGoal: 79,
      weeklyLeadBudget: 700,
      thresholdSeconds: 120,
    });
    expect(m.conversationConversion).toBeNull();
    expect(m.assignedLeadConversion).toBeNull();
    expect(m.totalLeadConversionYesterday).toBeNull(); // 0 anchor-day leads → "—", never 0%
    expect(m.totalLeadConversionWeek).toBeNull(); // 0 weekly leads → "—", never 0%
    expect(m.bookingsAnchorDay).toBe(0);
  });

  test("WEEKEND report (owner-corrected): pace 0 with honest weekend flag", () => {
    const m = buildDailyReportMetrics({
      reportDate: "2026-09-26", // Saturday — agents work Mon–Fri
      callsAnchorDay: [],
      apptsCreatedAnchorDay: [],
      apptsCreatedWtd: [],
      allCallsForWeek: [],
      attributions: [],
      leadsAllRecent: [],
      teamBookingGoal: 79,
      weeklyLeadBudget: 700,
      thresholdSeconds: 120,
    });
    expect(m.paceWeekend).toBe(true);
    expect(m.workDaysLeft).toBe(0);
    expect(m.dailyBookingsNeeded).toBe(0);
    expect(m.dailyLeadsNeeded).toBe(0);
  });

  // ---------- OWNER DIRECTIVE 10/30: TOTAL-lead conversion basis ----------

  describe("Total Lead Conversion lines (owner 10/30 — Mallory's metrics)", () => {
    const T = "2026-09-25"; // Friday report → anchor = Thursday 2026-09-24
    const lead = (id: string, type: string, work: string, assigned: string | null): LeadRow => ({
      id,
      lead_type: type,
      source_date: work,
      work_date: work,
      contact_id: "k" + id,
      assigned_rep_id: assigned,
      source_sheet: type,
    });
    const appt = (id: string, createdAt: string, status = "scheduled"): AppointmentRow => ({
      id,
      contact_id: "k1",
      calendar_id: "cal-1",
      appointment_type: "Family Portrait Session",
      appointment_datetime: "2026-10-01T14:00:00.000Z",
      created_at: createdAt,
      status,
      cancelled: status === "cancelled",
    });

    test("Yesterday conversion divides by the ANCHOR DAY'S TOTAL leads — unassigned pool and form sources included", () => {
      const m = buildDailyReportMetrics({
        reportDate: T,
        callsAnchorDay: [],
        // 2 pooled bookings on the anchor day (the "Bookings Yesterday" number)
        apptsCreatedAnchorDay: [appt("a1", "2026-09-24T16:00:00.000Z"), appt("a2", "2026-09-24T17:00:00.000Z")],
        apptsCreatedWtd: [appt("a1", "2026-09-24T16:00:00.000Z"), appt("a2", "2026-09-24T17:00:00.000Z")],
        allCallsForWeek: [],
        attributions: [],
        // Anchor day (Thu 9/24) TOTAL cohort = 5 leads: 2 assigned genre rows,
        // 1 UNASSIGNED genre row, 2 form-workbook rows (assigned_rep_id null
        // in practice). The legacy assigned-only denominator would be 2 →
        // 100%; the TOTAL basis is 2 ÷ 5.
        leadsAllRecent: [
          lead("l1", "family", "2026-09-24", "r1"),
          lead("l2", "animalia", "2026-09-24", "r2"),
          lead("l3", "family", "2026-09-24", null),
          lead("l4", "auction_register_certificate", "2026-09-24", null),
          lead("l5", "google_ads_leads", "2026-09-24", null),
        ],
        teamBookingGoal: 79,
        weeklyLeadBudget: 700,
        thresholdSeconds: 120,
      });
      expect(m.bookingsAnchorDay).toBe(2); // the SAME number "Bookings Yesterday" shows
      expect(m.totalLeadConversionYesterday).toBeCloseTo(2 / 5, 6); // pooled ÷ pooled TOTAL
    });

    test("Week line runs on the CANONICAL QUALIFYING WTD count (owner 10/30 post-#126) — cancelled-after-payment rows never count toward goal", () => {
      // The week lines' numerator is the SAME qualifying Booking-Win chain the
      // Today strip shows (deposit-date basis; pending payments AND
      // cancelled-after-payment rows never count toward goal achievement).
      // A paid-then-cancelled row created in-week (what the Weekly hero's
      // created-basis gross would count) must NOT reach "Bookings for the
      // Week" / "Left" / "% of goal" / the week conversion numerator.
      const m = buildDailyReportMetrics({
        reportDate: T,
        callsAnchorDay: [],
        apptsCreatedAnchorDay: [appt("a1", "2026-09-24T16:00:00.000Z"), appt("a2", "2026-09-24T17:00:00.000Z")],
        apptsCreatedWtd: [
          appt("a1", "2026-09-24T16:00:00.000Z"),
          appt("a2", "2026-09-24T17:00:00.000Z"),
          appt("cx", "2026-09-24T18:00:00.000Z", "cancelled"), // paid-then-cancelled (gross counts it, qualifying never does)
          { ...appt("pd", "2026-09-24T19:00:00.000Z"), raw: { paid: "no", priceSold: "300.00" } }, // pending payment
        ],
        allCallsForWeek: [],
        attributions: [],
        leadsAllRecent: [
          lead("l1", "family", "2026-09-24", "r1"),
          lead("l2", "animalia", "2026-09-24", "r2"),
          lead("l3", "family", "2026-09-24", null),
          lead("l4", "auction_register_certificate", "2026-09-24", null),
          lead("l5", "google_ads_leads", "2026-09-24", null),
        ],
        teamBookingGoal: 79,
        weeklyLeadBudget: 700,
        thresholdSeconds: 120,
      });
      expect(m.weekBookings).toBe(2); // the qualifying count — NOT gross-with-cancellations
      expect(m.bookingsLeft).toBe(77); // max(0, 79 − 2)
      expect(m.goalAchievement).toBeCloseTo(2 / 79, 6);
      expect(m.totalLeadConversionWeek).toBeCloseTo(2 / 5, 6); // numerator = the SAME qualifying count
      // The frozen-target chain is UNTOUCHED: winsBeforeToday keeps its
      // deposit-date basis (both anchors are before Friday) and the frozen
      // target follows it, not the week-bookings figure.
      expect(m.winsBeforeToday).toBe(2);
      expect(m.dailyBookingsNeeded).toBe(Math.ceil((79 - 2) / 1));
      // The anchor-day line is unaffected.
      expect(m.totalLeadConversionYesterday).toBeCloseTo(2 / 5, 6);
    });
  });
});
