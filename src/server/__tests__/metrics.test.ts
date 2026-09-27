import { describe, expect, test } from "bun:test";
import { computeAttributions, normalizePhone } from "../attribution";
import {
  assignedLeadConversion,
  bookingsByRep,
  bookingsFromOverThresholdCalls,
  buildTodayMetrics,
  conversationConversion,
  countBookingsCreatedBetween,
  goalAchievement,
  leadBudgetUsage,
  leadsRemaining,
  leadsToday,
  paceNeeded,
  summarizeCalls,
  type AppointmentRow,
  type AttributionRow,
  type CallRow,
  type LeadRow,
} from "../metrics/compute";

const T = "2026-09-25T14:00:00.000Z"; // Fri Sep 25, 10:00 ET

const call = (id: string, rep: string, contact: string, startedAt: string, dur: number): CallRow => ({
  id,
  rep_id: rep,
  contact_id: contact,
  started_at: startedAt,
  duration_seconds: dur,
  over_two_minutes: dur > 120,
});

const appt = (id: string, contact: string, createdAt: string, status = "scheduled", createdBusinessDate?: string): AppointmentRow => ({
  id,
  contact_id: contact,
  calendar_id: "cal-1",
  appointment_type: "Family Portrait Session",
  appointment_datetime: "2026-10-01T14:00:00.000Z",
  created_at: createdAt,
  created_business_date: createdBusinessDate ?? createdAt.slice(0, 10),
  status,
  cancelled: status === "cancelled",
});

describe("summarizeCalls", () => {
  test("total, over threshold, avg duration", () => {
    const calls = [call("c1", "r1", "k1", T, 60), call("c2", "r1", "k2", T, 300), call("c3", "r2", "k3", T, 121)];
    const s = summarizeCalls(calls, 120);
    expect(s.total).toBe(3);
    expect(s.overThreshold).toBe(2); // strictly MORE than 120
    expect(s.avgDurationSeconds).toBe(Math.round((60 + 300 + 121) / 3));
  });

  test("120s exactly does NOT count as over threshold", () => {
    expect(summarizeCalls([call("c1", "r1", "k1", T, 120)], 120).overThreshold).toBe(0);
    expect(summarizeCalls([call("c1", "r1", "k1", T, 121)], 120).overThreshold).toBe(1);
  });
});

describe("bookings", () => {
  const appts = [
    appt("a1", "2026-09-25T10:00:00.000Z", "2026-09-25"),
    appt("a2", "2026-09-25T11:00:00.000Z", "2026-09-25"),
    appt("a3", "2026-09-25T12:00:00.000Z", "2026-09-25", "cancelled"), // cancelled → not a booking
    appt("a4", "2026-09-24T12:00:00.000Z", "2026-09-24"), // outside today range
  ];

  test("cancelled appointments do not count as bookings (bucketed by ET business date)", () => {
    expect(
      countBookingsCreatedBetween(appts, "2026-09-25", "2026-09-25"),
    ).toBe(2);
  });

  test("bookingsByRep uses attributions and skips unattributed", () => {
    const attrs: AttributionRow[] = [
      { id: "t1", appointment_id: "a1", call_id: "c1", rep_id: "r1", method: "contact_id", confidence: 1, manual_override: false },
      { id: "t2", appointment_id: "a2", call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false },
      { id: "t3", appointment_id: "a3", call_id: null, rep_id: "r2", method: "manual", confidence: 1, manual_override: true },
    ];
    const m = bookingsByRep(appts, attrs);
    expect(m.get("r1")).toBe(1);
    expect(m.get("r2")).toBeUndefined(); // a3 is cancelled → excluded even though manually attributed
  });

  test("bookingsFromOverThresholdCalls re-checks call duration against the configured threshold", () => {
    const calls = [call("c1", "r1", "k1", "2026-09-25T09:00:00.000Z", 200), call("c9", "r1", "k4", "2026-09-25T09:00:00.000Z", 90)];
    const attrs: AttributionRow[] = [
      { id: "t1", appointment_id: "a1", call_id: "c1", rep_id: "r1", method: "contact_id", confidence: 1, manual_override: false },
      { id: "t4", appointment_id: "a4", call_id: "c9", rep_id: "r1", method: "contact_id", confidence: 1, manual_override: false },
    ];
    const over = bookingsFromOverThresholdCalls(appts, attrs, calls, 120);
    expect(over.map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("conversions, goals, pace", () => {
  test("conversation conversion", () => {
    expect(conversationConversion(7, 11)).toBeCloseTo(0.636, 3);
    expect(conversationConversion(5, 0)).toBeNull();
  });
  test("assigned lead conversion", () => {
    expect(assignedLeadConversion(11, 80)).toBeCloseTo(0.1375, 4);
    expect(assignedLeadConversion(3, 0)).toBeNull();
  });
  test("goal achievement", () => {
    expect(goalAchievement(37, 79)).toBeCloseTo(0.468, 3);
    expect(goalAchievement(10, 0)).toBeNull();
  });
  test("pace needed divides remaining by days left, counting today", () => {
    expect(paceNeeded(42, 3)).toBe(14);
    expect(paceNeeded(7, 2)).toBe(4); // ceil
    expect(paceNeeded(0, 3)).toBe(0);
    expect(paceNeeded(5, 0)).toBe(0);
  });
});

describe("leads", () => {
  const lead = (id: string, type: string, work: string): LeadRow => ({
    id,
    lead_type: type,
    source_date: work,
    work_date: work,
    contact_id: null,
    assigned_rep_id: "r1",
    source_sheet: type,
  });
  const leads = [
    lead("l1", "family", "2026-09-25"),
    lead("l2", "animalia", "2026-09-25"),
    lead("l3", "animalia", "2026-09-25"),
    lead("l4", "family", "2026-09-22"),
  ];

  test("leads today filters on work_date, not source_date", () => {
    const s = leadsToday(leads, "2026-09-25");
    expect(s).toEqual({ family: 1, animalia: 2, total: 3 });
  });

  test("budget usage / remaining", () => {
    expect(leadBudgetUsage(594, 700)).toBeCloseTo(0.8486, 4);
    expect(leadsRemaining(594, 700)).toBe(106);
  });
});

describe("computeAttributions", () => {
  const contacts = [
    { id: "k1", name: "Ann", phone: "+1 (917) 555-0101", email: "ANN@x.com", assigned_rep_id: "r1" },
    { id: "k2", name: "Bob", phone: "917-555-0102", email: "bob@x.com", assigned_rep_id: "r2" },
  ];

  test("matches by contact_id priority, most recent qualifying call wins, window enforced", () => {
    const calls = [
      call("c1", "r1", "k1", "2026-09-25T08:00:00.000Z", 200),
      call("c2", "r2", "k1", "2026-09-25T10:30:00.000Z", 150), // most recent qualifying
      call("c3", "r1", "k1", "2026-09-20T10:00:00.000Z", 500), // outside 24h window
      call("c4", "r1", "k1", "2026-09-25T11:00:00.000Z", 60), // too short
    ];
    const appts = [appt("a1", "k1", "2026-09-25T12:00:00.000Z")];
    const res = computeAttributions({ appointments: appts, calls, contacts, thresholdSeconds: 120, windowHours: 24 });
    expect(res.attributions[0].call_id).toBe("c2");
    expect(res.attributions[0].rep_id).toBe("r2");
    expect(res.attributions[0].method).toBe("contact_id");
    expect(res.unattributedAppointmentIds).toHaveLength(0);
  });

  test("falls back to phone (normalized) then email", () => {
    // appointment without contact_id, matched via phone
    const apptNoContact = { ...appt("a1", "", "2026-09-25T12:00:00.000Z"), contact_id: null, client_phone: "917.555.0102" } as AppointmentRow & { client_phone: string };
    const calls = [call("c5", "r2", "k2", "2026-09-25T10:00:00.000Z", 400)];
    let res = computeAttributions({ appointments: [apptNoContact], calls, contacts, thresholdSeconds: 120, windowHours: 24 });
    expect(res.attributions[0].method).toBe("phone");
    expect(res.attributions[0].rep_id).toBe("r2");

    // email fallback: contact matched by email, qualifying call exists → attributed via email match
    const apptByEmail = { ...appt("a2", "", "2026-09-25T12:00:00.000Z"), contact_id: null, client_email: "ann@X.com" } as AppointmentRow & { client_email: string };
    res = computeAttributions({
      appointments: [apptByEmail],
      calls: [call("c6", "r1", "k1", "2026-09-25T11:00:00.000Z", 500)],
      contacts,
      thresholdSeconds: 120,
      windowHours: 24,
    });
    expect(res.attributions[0].method).toBe("email");
    expect(res.attributions[0].rep_id).toBe("r1");
  });

  test("unclear attribution goes to unattributed queue (never guessed)", () => {
    const res = computeAttributions({
      appointments: [appt("a1", "", "2026-09-25T12:00:00.000Z")],
      calls: [],
      contacts,
      thresholdSeconds: 120,
      windowHours: 24,
    });
    expect(res.unattributedAppointmentIds).toEqual(["a1"]);
    expect(res.attributions[0]).toMatchObject({ rep_id: null, method: "none", confidence: 0 });
  });

  test("phone normalization ignores formatting and country code", () => {
    expect(normalizePhone("+1 (917) 555-0101")).toBe("9175550101");
    expect(normalizePhone("9175550101")).toBe("9175550101");
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("buildTodayMetrics (integration of the metrics layer)", () => {
  test("aggregates a coherent week", () => {
    const calls: CallRow[] = [
      call("c1", "r1", "k1", "2026-09-25T10:00:00.000Z", 300),
      call("c2", "r1", "k2", "2026-09-25T10:30:00.000Z", 60),
    ];
    const apptsToday = [appt("a1", "k1", "2026-09-25T11:00:00.000Z")];
    const attrs: AttributionRow[] = [
      { id: "t1", appointment_id: "a1", call_id: "c1", rep_id: "r1", method: "contact_id", confidence: 1, manual_override: false },
    ];
    const leads: LeadRow[] = [
      { id: "l1", lead_type: "family", source_date: "2026-09-24", work_date: "2026-09-25", contact_id: "k1", assigned_rep_id: "r1", source_sheet: "family" },
    ];
    const m = buildTodayMetrics({
      reportDate: "2026-09-25",
      calls,
      apptsCreatedToday: apptsToday,
      apptsCreatedYesterday: [appt("a9", "k9", "2026-09-24T15:00:00.000Z")],
      apptsCreatedWtd: [...apptsToday, appt("a8", "k8", "2026-09-21T15:00:00.000Z")],
      callsWtd: calls,
      allCallsForWeek: calls,
      attributions: attrs,
      leadsAllRecent: leads,
      teamBookingGoal: 79,
      weeklyLeadBudget: 700,
      thresholdSeconds: 120,
      openSlotsByDay: [
        { date: "2026-09-25", slots: ["10:00 AM"] },
        { date: "2026-09-26", slots: [] },
      ],
      reps: [{ id: "r1", name: "Maya" }],
      repGoals: [{ rep_id: "r1", week_start: "2026-09-21", goal: 14 }],
    });
    expect(m.bookings.today).toBe(1);
    expect(m.bookings.yesterday).toBe(1);
    expect(m.bookings.wtd).toBe(2);
    expect(m.bookings.paceNeeded).toBe(Math.ceil((79 - 2) / 1)); // Friday → 1 WORKING day left (Mon–Fri)
    expect(m.paceDaysLeft).toBe(1);
    expect(m.paceWeekend).toBe(false);
    expect(m.openSlotsByDay[0]).toEqual({ date: "2026-09-25", slots: ["10:00 AM"] });
    expect(m.callsToday.total).toBe(2);
    expect(m.callsToday.overThreshold).toBe(1);
    expect(m.conversionsToday.conversation).toBe(1); // 1 booking from 1 over-threshold call today
    expect(m.leads.today.total).toBe(1);
    expect(m.repRows[0]).toMatchObject({ name: "Maya", totalCalls: 2, callsOverThreshold: 1, totalBookings: 1, goal: 14 });
    expect(m.repRows[0].goalPercent).toBeCloseTo(1 / 14, 4);
  });

  test("WEEKEND (owner-corrected): no working days left — pace 0 + weekend flag, never a fiction", () => {
    const m = buildTodayMetrics({
      reportDate: "2026-09-26", // Saturday
      calls: [],
      apptsCreatedToday: [],
      apptsCreatedYesterday: [],
      apptsCreatedWtd: [],
      callsWtd: [],
      allCallsForWeek: [],
      attributions: [],
      leadsAllRecent: [],
      teamBookingGoal: 79,
      weeklyLeadBudget: 700,
      thresholdSeconds: 120,
      openSlotsByDay: [],
      reps: [],
      repGoals: [],
    });
    expect(m.paceWeekend).toBe(true);
    expect(m.paceDaysLeft).toBe(0);
    expect(m.bookings.paceNeeded).toBe(0); // divide-by-zero guarded
    expect(m.leads.dailyNeeded).toBe(0); // "0/day" is honest: pace resumes Monday
  });
});
