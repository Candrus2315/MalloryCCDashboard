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
  reportDate: "2026-09-25",
  weekStart: "2026-09-21",
  leadCohortSourceDates: ["2026-09-24"],
  bookingsYesterday: 11,
  bookingsWtd: 37,
  weeklyBookingGoal: 79,
  bookingsLeft: 42,
  dailyBookingsNeeded: 21,
  conversationConversion: 0.6363,
  assignedLeadConversion: 0.1318,
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

/** The SPEC example, verbatim (owner's Daily CC Report format). */
const SPEC_EXAMPLE = [
  "Daily CC Report",
  "",
  "Bookings: 11",
  "Bookings for the Week: 37",
  "Key Driver: 79",
  "Left: 42",
  "Daily: 21",
  "Conversion of Calls Over 2 Mins: 63.63%",
  "Conversion of Assigned Leads: 13.18%",
  "% of Appt Achieved: 53.16%",
  "",
  "Leads:",
  "Weekly Lead Budget: 700",
  "Leads Today: 80",
  "Family: 27",
  "Animalia: 53",
  "Total Weekly Leads: 594",
  "% of Budget Used: 84.86%",
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
      callsYesterday: [call("c1", "2026-09-24T14:00:00.000Z", 300), call("c2", "2026-09-24T15:00:00.000Z", 60)],
      // bookings created yesterday: 2 (1 cancelled → excluded)
      apptsCreatedYesterday: [appt("a1", "2026-09-24T16:00:00.000Z"), appt("a2", "2026-09-24T17:00:00.000Z", "cancelled"), appt("a3", "2026-09-24T18:00:00.000Z")],
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

    expect(m.bookingsYesterday).toBe(2); // cancelled excluded
    expect(m.bookingsWtd).toBe(3);
    expect(m.bookingsLeft).toBe(76); // 79 - 3
    expect(m.dailyBookingsNeeded).toBe(Math.ceil(76 / 1)); // Friday → 1 WORKING day left (Mon–Fri)
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
  });

  test("missing yesterday data → null conversions (page shows a warning, not a number)", () => {
    const m = buildDailyReportMetrics({
      reportDate: T,
      callsYesterday: [],
      apptsCreatedYesterday: [],
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
    expect(m.bookingsYesterday).toBe(0);
  });

  test("WEEKEND report (owner-corrected): pace 0 with honest weekend flag", () => {
    const m = buildDailyReportMetrics({
      reportDate: "2026-09-26", // Saturday — agents work Mon–Fri
      callsYesterday: [],
      apptsCreatedYesterday: [],
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
});
