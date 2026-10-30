/**
 * CROSS-REPORT PARITY (owner directive 10/30, hard requirement; post-PR-#126
 * booking-numerator fix) — for the same week and cutoff:
 *
 *   1. Bookings for the Week / Bookings WTD (Daily) == the Weekly's
 *      QUALIFYING goal-tracker count (bookingsWeek.total — the deposit-week
 *      Booking-Win chain its goal logic already uses). DELIBERATELY NOT the
 *      Weekly hero's created-Mon–Sun gross: that figure counts
 *      cancelled-after-payment rows, so it ran ahead of the qualifying count
 *      (72 vs 69 on the owner's live data) and broke goal achievement.
 *   2. Total Weekly Leads (Daily) == Total (Weekly CC leads)
 *   3. Total Lead Conversion — Week (Daily) == Total Lead Conversion — Week
 *      (Weekly CC)
 *
 * The conversion is computed by ONE shared function — totalLeadConversionWeek
 * (compute.ts) — over ONE canonical (bookings, leads) pair: the QUALIFYING
 * booking count (deposit-date basis; pending payments AND cancelled-after-
 * payment rows never count) and the work-date lead cohort total (all seven
 * sources). NO mean-of-rates anywhere. Also pinned: the TODAY strip's WTD
 * count is the very same numerator the Daily Report's week lines consume.
 *
 * REV-97 GOAL-BASIS PARITY (owner directive 10/30, codified): goal achievement
 * uses the canonical QUALIFYING booking count — never Gross — on BOTH reports.
 * The CC Report's "Bookings (Week)" ±goal comparison consumes the SAME
 * qualifying chain (bookingsWeek.total) the conversion headline uses, so the
 * goal comparisons ACROSS reports agree for the same cutoff; the gross /
 * cancellations / net figures stay displayed as production reporting in the
 * same line (displayed, never goal-driving). The MTD comparison rides the
 * qualifying MTD chain (bookingsMonth.total == mtd.total) the same way.
 * FOURTH-SURFACE PARITY (rev-97 follow-up): the Weekly tab's Month-to-Date
 * panel — the LAST gross-basis "vs goal" rendering — consumes the SAME
 * qualifying MTD chain (mtd.total == bookingsMonth.total, the deposit-date
 * winsMtd chain) as the CC Report's MTD line, so the goal comparisons agree
 * everywhere they appear; the panel's Gross / Cancellations / Net MTD stay
 * displayed as its production block.
 * Mirrors the frozen-target suite's pure-builder parity pattern, then proves
 * the loader wiring end-to-end on a MemoryStore (Daily for a Sunday vs the
 * Weekly CC Report for that same just-completed week), then replays the
 * owner's live 10/30 shape (69 qualifying + 3 paid-then-cancelled = 72 gross
 * + 3 unpaid pendings over 834 leads).
 */
import { describe, expect, test } from "bun:test";
import {
  buildDailyReportMetrics,
  buildTodayMetrics,
  appointmentPaymentStateOf,
  totalLeadConversionWeek,
  type AppointmentRow,
  type LeadRow,
} from "../metrics/compute";
import { buildDailyReportText } from "../metrics/report-text";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "../metrics/weekly-report-text";
import { goalVsActual, splitLeadsByType } from "../metrics/weekly";
import { dailyReportPageData, weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";

// Week of Mon 2026-09-21 … Sun 2026-09-27 — the owner's reference weekly
// shape: the HERO gross is 3 (2 qualifying wins + 1 paid-then-cancelled) over
// 957 work-date leads (audit-79v84 proportion). The goal/conversion numerator
// is the QUALIFYING pair (2) — never the gross.
const MON = "2026-09-21";
const THU = "2026-09-24";
const FRI = "2026-09-25";
const SUN = "2026-09-27";
const QUAL = 2; // qualifying WTD wins (the goal/conversion numerator)
const GROSS = 3; // hero gross = QUAL + 1 cancelled-after-payment
const GOAL = 79;

/** The week's canonical (bookings, leads) pair through the ONE shared function. */
const sharedRate = (leads: LeadRow[]) => totalLeadConversionWeek(QUAL, leads.length);

const weekLeadRows = (): LeadRow[] => {
  const rows: LeadRow[] = [];
  const mk = (i: number, type: string, work: string, assigned: string | null): LeadRow => ({
    id: `pl-${i}`,
    lead_type: type,
    source_date: work,
    work_date: work,
    contact_id: `k-${i}`,
    assigned_rep_id: assigned,
    source_sheet: type,
  });
  // 957 leads: genres (assigned and unassigned mixed) + the four form sources
  // (never assigned in practice). Work dates Mon–Fri only (the work-date fold).
  let i = 0;
  const push = (n: number, type: string) => {
    for (let k = 0; k < n; k++) {
      const work = [MON, "2026-09-22", "2026-09-23", THU, FRI][k % 5];
      rows.push(mk(i++, type, work, type.startsWith("fam") && k % 2 === 0 ? "r1" : null));
    }
  };
  push(470, "family");
  push(350, "animalia");
  push(60, "fairyland");
  push(30, "auction_register_certificate");
  push(27, "google_ads_leads");
  push(15, "alliance_activate_certificate");
  push(5, "website_applications");
  return rows;
};

const anchorAppt = (id: string, etDate: string): AppointmentRow => ({
  id,
  contact_id: null,
  calendar_id: "cal-1",
  appointment_type: "Family Portrait Session",
  appointment_datetime: "2026-09-24T14:00:00.000Z",
  created_at: `${etDate}T14:00:00.000Z`,
  status: "scheduled",
  cancelled: false,
});

/** Paid-then-cancelled in-week row — the hero gross counts it, the qualifying chain never does. */
const cancelledAppt = (id: string, etDate: string): AppointmentRow => ({
  ...anchorAppt(id, etDate),
  status: "cancelled",
  cancelled: true,
});

/** The Daily Report for FRIDAY of the parity week (anchor = Thursday). */
function dailyMetrics(leads: LeadRow[]) {
  return buildDailyReportMetrics({
    reportDate: FRI,
    callsAnchorDay: [],
    apptsCreatedAnchorDay: [anchorAppt("d1", THU), anchorAppt("d2", THU)],
    apptsCreatedWtd: [anchorAppt("d1", THU), anchorAppt("d2", THU), cancelledAppt("cx", THU)],
    allCallsForWeek: [],
    attributions: [],
    leadsAllRecent: leads,
    teamBookingGoal: GOAL,
    weeklyLeadBudget: 700,
    thresholdSeconds: 120,
  });
}

/** The Weekly CC Report for the SAME week: hero gross separate, goal tracker qualifying. */
function weeklyReport(leads: LeadRow[]): string {
  const leadsSummary = splitLeadsByType(leads);
  const input: WeeklyCcReportInput = {
    week: { start: MON, end: SUN },
    monthKey: "2026-09",
    bookingsWeek: { total: QUAL, goal: GOAL },
    bookingsMonth: { total: 246, goal: 316 },
    productionWeek: { gross: GROSS, cancellations: 1, net: QUAL, goal: GOAL },
    productionMonth: { gross: 246, goal: 316 },
    channels: { alliance: 0, auction: 0, website: null },
    channelLeads: { alliance: 0, auction: 0, website: null },
    leads: leadsSummary,
    weekConversion: {
      rate: totalLeadConversionWeek(QUAL, leadsSummary.total),
      family: 30 / 470,
      animalia: 25 / 350,
      fairyland: 5 / 60,
    },
    funnel: { wins: QUAL, leads: leadsSummary.total, pct: null },
    calendar: {
      thisWeek: { appointments: 0, slotsOccupied: 0, capacity: 69 },
      nextWeek: { appointments: 0, slotsOccupied: 0, capacity: 69 },
      beyond: 0,
      firstFullyOpenDay: null,
    },
    notes: {},
    celebrateDefault: null,
  };
  return buildWeeklyCcReportText(input);
}

const lineOf = (text: string, prefix: string): string =>
  text.split("\n").find((l) => l.startsWith(prefix)) ?? "<missing>";

describe("CROSS-REPORT PARITY (owner 10/30): Daily Report == Weekly CC Report, same week", () => {
  const leads = weekLeadRows();
  const m = dailyMetrics(leads);
  const dailyText = buildDailyReportText(m, { priority1: "a", priority2: "b", priority3: "c" });
  const weeklyText = weeklyReport(leads);

  test("1 — Bookings for the Week (Daily) == the Weekly's QUALIFYING goal-tracker count — NOT the hero gross", () => {
    expect(m.weekBookings).toBe(QUAL);
    expect(lineOf(dailyText, "Bookings for the Week:")).toBe(`Bookings for the Week: ${QUAL}`);
    // REV-97: the CC Report's ±goal comparison rides the QUALIFYING count —
    // the same figure the Daily reports — while Gross / Cancellations / Net
    // stay in the line as production reporting (deliberately different
    // numbers: gross counts the cancelled-after-payment row).
    expect(lineOf(weeklyText, "Bookings (Week):")).toBe(
      `Bookings (Week): ${goalVsActual(QUAL, GOAL)} qualifying · Gross: ${GROSS} · Cancellations: 1 · Net: ${QUAL}`,
    );
    // SUPERSEDED PIN (post-#126 fix): Daily-WTD == Weekly-gross no longer
    // holds — the gross counts the cancelled-after-payment row, the
    // goal/conversion numerator must not.
    expect(GROSS).not.toBe(QUAL);
    expect(m.weekBookings).not.toBe(GROSS);
  });

  test("2 — Total Weekly Leads (Daily) == Total (Weekly CC)", () => {
    // The two cohort summarizers (leadsForWeek on the Daily side,
    // splitLeadsByType on the Weekly side) agree on the SAME rows.
    expect(m.weeklyLeads).toBe(leads.length);
    expect(splitLeadsByType(leads).total).toBe(leads.length);
    expect(lineOf(dailyText, "Total Weekly Leads:")).toBe(`Total Weekly Leads: ${leads.length}`);
    expect(lineOf(weeklyText, "Total:")).toBe(`Total: ${leads.length}`);
  });

  test("3 — Total Lead Conversion — Week: ONE shared function, digit-identical strings", () => {
    // Same float (identical expression, not an approximation)…
    expect(m.totalLeadConversionWeek).toBe(sharedRate(leads));
    // …and the same rendered string at the parity-locked one-decimal precision.
    expect(lineOf(dailyText, "Total Lead Conversion — Week:")).toBe(
      lineOf(weeklyText, "Total Lead Conversion — Week:"),
    );
    expect(lineOf(weeklyText, "Total Lead Conversion — Week:")).toBe("Total Lead Conversion — Week: 0.2%");
  });

  test("4 — never a mean of per-source or rep rates (pooled division only)", () => {
    // The three by-source rates average to 7.3%, the pooled division is 0.2% —
    // the headline MUST be the pooled division over the qualifying numerator.
    const mean = (30 / 470 + 25 / 350 + 5 / 60) / 3;
    expect(m.totalLeadConversionWeek).not.toBeCloseTo(mean, 2);
    expect(m.totalLeadConversionWeek).toBeCloseTo(QUAL / leads.length, 10);
  });

  test("5 — the parity trio sits inside both templates' unchanged structure", () => {
    // Daily: the renamed label + the two new lines + the pickup placeholder…
    expect(dailyText).toContain("Bookings Yesterday: 2");
    expect(dailyText).toContain("Total Lead Conversion — Yesterday: 1.0%"); // 2 pooled bookings ÷ 191 Thursday leads
    expect(dailyText).toContain("Daily Pickup Rate: —");
    expect(dailyText).not.toContain("Conversion of Assigned Leads");
    expect(dailyText).not.toContain("Conversion of Calls Over 2 Mins");
    expect(dailyText).not.toContain("% of Appt Achieved");
    // …Weekly: headline + subordinate by-source detail, old line gone.
    const lines = weeklyText.split("\n");
    const i = lines.findIndex((l) => l.startsWith("Total Lead Conversion — Week:"));
    expect(lines[i + 1]).toBe("  by source: Family 6.4% · Animalia 7.1% · Fairyland 8.3%");
    expect(weeklyText).not.toContain("Conversion of Assigned Leads");
  });

  test("6 — the TODAY strip's WTD count is the SAME numerator the Daily week lines consume", () => {
    // Same fixture rows into both pure builders: Today's canonical WTD
    // (deposit-date Booking-Win chain) == Daily "Bookings for the Week".
    const t = buildTodayMetrics({
      reportDate: FRI,
      calls: [],
      apptsCreatedToday: [],
      apptsCreatedYesterday: [],
      apptsCreatedWtd: [anchorAppt("d1", THU), anchorAppt("d2", THU), cancelledAppt("cx", THU)],
      callsWtd: [],
      allCallsForWeek: [],
      attributions: [],
      leadsAllRecent: [],
      teamBookingGoal: GOAL,
      weeklyLeadBudget: 700,
      thresholdSeconds: 120,
      openSlotsByDay: [],
      reps: [],
      repGoals: [],
    });
    expect(t.bookings.wtd).toBe(QUAL);
    expect(t.bookings.wtd).toBe(m.weekBookings);
  });
});

// ---------- loader-level parity (MemoryStore, pinned clocks) ----------

const paidWin = (id: string, createdDate: string): AppointmentRow & { client_phone: string | null; client_email: string | null } => ({
  id,
  acuity_appointment_id: id,
  contact_id: null,
  calendar_id: null,
  appointment_type: "Portrait Session",
  appointment_datetime: `2026-09-2${createdDate.slice(-1)}T14:00:00Z`,
  created_at: `${createdDate}T12:00:00Z`,
  created_business_date: createdDate,
  booking_win_business_date: createdDate,
  raw: { paid: "yes", priceSold: "300.00", amountPaid: "300.00" },
  status: "scheduled",
  cancelled: false,
  client_phone: null,
  client_email: null,
});

const loaderLead = (id: string, workDate: string, assigned: string | null = null): LeadRow => ({
  id,
  lead_type: "family",
  source_date: workDate,
  work_date: workDate,
  contact_id: null,
  assigned_rep_id: assigned,
  source_sheet: "family",
  source_id: id,
  provider: "google_sheets",
});

async function seedParityStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  // Three paid wins created inside the parity week (created basis = gross 4
  // once the paid-then-cancelled row lands) + one pending row that never
  // counts anywhere + one paid-then-cancelled row (hero gross counts it —
  // cancellations included — the qualifying chain never does).
  await store.upsertAppointments([paidWin("p-w1", "2026-09-22"), paidWin("p-w2", "2026-09-24"), paidWin("p-w3", "2026-09-26"), {
    ...paidWin("p-pending", "2026-09-23"),
    raw: { paid: "no", priceSold: "300.00" },
    booking_win_business_date: null,
  }, {
    ...paidWin("p-cx", "2026-09-25"),
    status: "cancelled",
    cancelled: true,
  }]);
  // The parity week's work-date cohort: 4 leads (work dates Mon–Thu).
  await store.upsertLeads([
    loaderLead("p-l1", "2026-09-21"),
    loaderLead("p-l2", "2026-09-22"),
    loaderLead("p-l3", "2026-09-23"),
    loaderLead("p-l4", "2026-09-24", "r1"),
  ]);
  return store;
}

describe("loader-level parity (MemoryStore): Daily (Sunday of week W) == Weekly CC (Monday after W)", () => {
  test("weekBookings == the Weekly's QUALIFYING goal-tracker count; hero gross stays separate", async () => {
    const store = await seedParityStore();
    // The Daily Report rendered ON Sunday 9/27 covers the CURRENT week (9/21–27).
    const daily = await dailyReportPageData({ store, today: SUN, etNowMinutes: 10 * 60 });
    // The Weekly CC Report rendered the NEXT Monday covers LAST week (9/21–27) — the same week.
    const weekly = await weeklyPageData({ store, today: "2026-09-28" });

    // Hero gross = 4 (3 active + 1 paid-then-cancelled); cancellations 1; net 3.
    expect(weekly.bookings.production.gross).toBe(4);
    expect(weekly.bookings.production.cancellations).toBe(1);
    expect(weekly.bookings.production.net).toBe(3);
    // The Daily's week figure is the QUALIFYING count (3), NOT the gross (4).
    expect(daily.metrics.weekBookings).toBe(3);
    // PARITY: Daily WTD == the Weekly's own qualifying goal-tracker count.
    expect(weekly.bookings.total).toBe(3);
    expect(daily.metrics.weekBookings).toBe(weekly.bookings.total);
    expect(daily.metrics.weekBookings).toBe(weekly.funnel.wins);
    expect(daily.metrics.weeklyLeads).toBe(weekly.leads.total); // same work-date cohort total
    // ONE shared function over the SAME pair — exact float equality.
    expect(daily.metrics.totalLeadConversionWeek).toBe(
      totalLeadConversionWeek(weekly.bookings.total, weekly.leads.total),
    );
    // And the rendered headlines are the identical string.
    const dailyLine = lineOf(daily.reportText, "Total Lead Conversion — Week:");
    const weeklyLine = lineOf(weekly.report.reportText, "Total Lead Conversion — Week:");
    expect(dailyLine).toBe(weeklyLine);
    expect(dailyLine).toBe("Total Lead Conversion — Week: 75.0%"); // 3 qualifying ÷ 4 leads
    // Bookings/leads parity in the copied text too.
    expect(lineOf(daily.reportText, "Bookings for the Week:")).toBe("Bookings for the Week: 3");
    // REV-97 PARITY PIN: the CC Report's week goal comparison consumes the
    // SAME qualifying count the Daily reports (weekBookings 3) vs the same
    // weekly goal — goal comparisons across reports agree for the same
    // cutoff; the gross (4) stays in the line as its production figure.
    expect(lineOf(weekly.report.reportText, "Bookings (Week):")).toBe(
      `Bookings (Week): ${goalVsActual(daily.metrics.weekBookings, weekly.bookings.goal)} qualifying · Gross: 4 · Cancellations: 1 · Net: 3`,
    );
    // REV-97 PARITY PIN (MTD): the report's MTD ±goal comparison is the
    // QUALIFYING MTD count (mtd.total — the deposit-date chain) vs the same
    // monthly goal; gross stays as the production figure. (No monthly goal is
    // stored in this fixture → the honest "X/—".)
    expect(lineOf(weekly.report.reportText, "Bookings (Month-to-Date,")).toBe(
      `Bookings (Month-to-Date, September 2026): ${goalVsActual(weekly.mtd.total, weekly.mtd.goal)} qualifying · Gross (cancellations included): ${weekly.mtd.gross}`,
    );
    expect(lineOf(daily.reportText, "Total Weekly Leads:")).toBe("Total Weekly Leads: 4");
    expect(lineOf(weekly.report.reportText, "Total:")).toBe("Total: 4");
  });

  test("FOURTH-SURFACE MTD PARITY (rev-97 follow-up): the Weekly tab's MTD panel == the CC Report MTD line — same qualifying comparison, same cutoff", async () => {
    // Same fixture, PLUS the monthly goal stored for THIS month's key so the
    // goal comparison is a real "X/G (±N)" (not the honest "X/—").
    const store = await seedParityStore();
    await store.upsertMonthlyGoal({ month: "2026-09", goal: 316 });
    const weekly = await weeklyPageData({ store, today: "2026-09-28" });

    // The MTD panel renders signedDelta(mtd.total, mtd.goal) next to
    // formatInt(mtd.total) / formatInt(mtd.goal) — the SAME digits
    // goalVsActual(mtd.total, mtd.goal) carries (same sign convention).
    expect(weekly.mtd.goal).toBe(316);
    expect(weekly.mtd.total).toBe(3); // qualifying MTD (deposit-date winsMtd chain)
    expect(weekly.mtd.gross).toBe(4); // production MTD (cancellations included)
    expect(weekly.mtd.total).not.toBe(weekly.mtd.gross); // the pin can't pass on equal values
    const panelComparison = goalVsActual(weekly.mtd.total, weekly.mtd.goal);
    expect(panelComparison).toBe("3/316 (−313)");

    // PARITY: the CC Report's MTD line carries the panel's exact comparison —
    // ONE qualifying chain (bookingsMonth.total == mtd.total == winsMtd.length).
    const mtdLine = lineOf(weekly.report.reportText, "Bookings (Month-to-Date,");
    expect(mtdLine).toBe(
      `Bookings (Month-to-Date, September 2026): ${panelComparison} qualifying · Gross (cancellations included): ${weekly.mtd.gross}`,
    );
    // And the gross-based comparison NEVER renders on either surface — the
    // goal comparison moved to qualifying, gross stays production-only.
    expect(mtdLine).not.toContain(goalVsActual(weekly.mtd.gross, weekly.mtd.goal)); // "4/316 (−312)"
  });

  test("the Weekly headline never moves when assigned-only counts change (total-lead basis, not assigned)", async () => {
    const store = await seedParityStore();
    const before = await weeklyPageData({ store, today: "2026-09-28" });
    const beforeLine = lineOf(before.report.reportText, "Total Lead Conversion — Week:");
    expect(beforeLine).toBe("Total Lead Conversion — Week: 75.0%");

    // Assign EVERY lead to a rep (and add a user so the assignment is real) —
    // the assigned-only cohort changes completely; the TOTAL cohort does not.
    await store.upsertUsers([
      { provider: "highlevel", external_id: "r1", name: "Rep One", email: "r1@example.com", is_active: true },
    ]);
    await store.upsertLeads([
      loaderLead("p-l1", "2026-09-21", "r1"),
      loaderLead("p-l2", "2026-09-22", "r1"),
      loaderLead("p-l3", "2026-09-23", "r1"),
      loaderLead("p-l4", "2026-09-24", "r1"),
    ]);
    const after = await weeklyPageData({ store, today: "2026-09-28" });
    expect(lineOf(after.report.reportText, "Total Lead Conversion — Week:")).toBe(beforeLine); // UNCHANGED
    // …while the payload's assigned-only conversion block (the Weekly tab's
    // panel — out of the report) does move with the assignments.
    expect(after.conversion.overall).not.toBeNull();
  });
});

// ---------- OWNER LIVE-SHAPE REGRESSION (10/30): 69 qualifying + 3 paid-cancelled = 72 gross, 3 unpaid pendings, 834 leads ----------

const WMON = "2026-10-26";
const WDATES = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
const N_QUAL = 69;
const N_CX = 3;
const N_PEND = 3;
const N_LEADS = 834;

/** October paid win with a correct session datetime. */
const octWin = (id: string, date: string): AppointmentRow & { client_phone: string | null; client_email: string | null } => ({
  id,
  acuity_appointment_id: id,
  contact_id: null,
  calendar_id: null,
  appointment_type: "Portrait Session",
  appointment_datetime: `${date}T18:00:00Z`,
  created_at: `${date}T12:00:00Z`,
  created_business_date: date,
  booking_win_business_date: date,
  raw: { paid: "yes", priceSold: "300.00", amountPaid: "300.00" },
  status: "scheduled",
  cancelled: false,
  client_phone: null,
  client_email: null,
});

async function seedOwnerShapeStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  const appts: (AppointmentRow & { client_phone: string | null; client_email: string | null })[] = [];
  for (let i = 0; i < N_QUAL; i++) appts.push(octWin(`q-${i}`, WDATES[i % WDATES.length]));
  for (let i = 0; i < N_CX; i++) {
    appts.push({ ...octWin(`cx-${i}`, WDATES[i]), status: "cancelled", cancelled: true }); // paid-then-cancelled, created in-week
  }
  for (let i = 0; i < N_PEND; i++) {
    appts.push({
      ...octWin(`pd-${i}`, "2026-10-30"),
      raw: { paid: "no", priceSold: "300.00" },
      booking_win_business_date: null, // unpaid → no win date, never buckets
    });
  }
  await store.upsertAppointments(appts);
  const leads: LeadRow[] = [];
  for (let i = 0; i < N_LEADS; i++) {
    leads.push(loaderLead(`ol-${i}`, WDATES[i % WDATES.length]));
  }
  await store.upsertLeads(leads);
  return store;
}

describe("BOOKING-NUMERATOR REGRESSION (owner live shape 10/30): goal/conversion surfaces use the QUALIFYING count", () => {
  test("Daily WTD 69 (not gross 72); conversion 69÷834; Weekly qualifying 69 with gross 72 / cancels 3 / net 69 on the hero", async () => {
    const store = await seedOwnerShapeStore();
    // Daily Report on Friday 10/30 (before the 18:30 cutoff) — week 10/26–11/1.
    const daily = await dailyReportPageData({ store, today: "2026-10-30", etNowMinutes: 10 * 60 });
    // Weekly CC Report the NEXT Monday — same reporting week.
    const weekly = await weeklyPageData({ store, today: "2026-11-02" });

    // THE FIX: every goal/conversion surface reads the qualifying 69…
    expect(daily.metrics.weekBookings).toBe(N_QUAL);
    expect(daily.metrics.bookingsWtd).toBe(N_QUAL);
    expect(daily.metrics.goalAchievement).toBeCloseTo(N_QUAL / 79, 10);
    expect(daily.metrics.bookingsLeft).toBe(79 - N_QUAL);
    expect(daily.metrics.totalLeadConversionWeek).toBeCloseTo(N_QUAL / N_LEADS, 12);
    expect(lineOf(daily.reportText, "Bookings for the Week:")).toBe(`Bookings for the Week: ${N_QUAL}`);
    expect(lineOf(daily.reportText, "Key Driver:")).toBe("Key Driver: 79");
    expect(lineOf(daily.reportText, "Left:")).toBe("Left: 10");
    expect(lineOf(daily.reportText, "Total Lead Conversion — Week:")).toBe("Total Lead Conversion — Week: 8.3%"); // 69÷834, NOT 72÷834 (8.6%)

    // …while the Weekly hero's production block (Final Booking Logic, untouched)
    // keeps showing 72 gross / 3 cancellations / 69 net — the 3 delta rows
    // (paid-then-cancelled) stay visible exactly where they were.
    expect(weekly.bookings.production.gross).toBe(72);
    expect(weekly.bookings.production.cancellations).toBe(N_CX);
    expect(weekly.bookings.production.net).toBe(N_QUAL);
    // REV-97 PARITY PIN: the copied week line's ±goal comparison is the
    // QUALIFYING count (69) vs the same goal — identical to the Daily's
    // qualifying figure at the same cutoff — with the production figures
    // (gross 72 / cancellations 3 / net 69) displayed alongside.
    expect(lineOf(weekly.report.reportText, "Bookings (Week):")).toBe(
      `Bookings (Week): ${goalVsActual(daily.metrics.weekBookings, weekly.bookings.goal)} qualifying · Gross: 72 · Cancellations: ${N_CX} · Net: ${N_QUAL}`,
    );
    expect(lineOf(weekly.report.reportText, "Bookings (Week):")).toBe(
      "Bookings (Week): 69/79 (−10) qualifying · Gross: 72 · Cancellations: 3 · Net: 69",
    );
    // REV-97 PARITY PIN (MTD): the qualifying MTD chain (mtd.total) drives the
    // report's MTD ±goal comparison; gross stays as the production figure.
    expect(lineOf(weekly.report.reportText, "Bookings (Month-to-Date,")).toBe(
      `Bookings (Month-to-Date, November 2026): ${goalVsActual(weekly.mtd.total, weekly.mtd.goal)} qualifying · Gross (cancellations included): ${weekly.mtd.gross}`,
    );

    // The Weekly's qualifying goal-tracker chain agrees with the Daily.
    expect(weekly.bookings.total).toBe(N_QUAL);
    expect(weekly.funnel.wins).toBe(N_QUAL);
    const dailyLine = lineOf(daily.reportText, "Total Lead Conversion — Week:");
    expect(lineOf(weekly.report.reportText, "Total Lead Conversion — Week:")).toBe(dailyLine);

    // Denominator unchanged: 834 total weekly leads on both sides.
    expect(daily.metrics.weeklyLeads).toBe(N_LEADS);
    expect(weekly.leads.total).toBe(N_LEADS);

    // The 3 unpaid pendings exist, are persisted pending_payment, and count
    // toward NOTHING in these figures (gross and qualifying both exclude them).
    const wtdRows = await store.getAppointmentsByWinBusinessDateBetween(WMON, "2026-10-30");
    const pendings = wtdRows.filter((r) => appointmentPaymentStateOf(r) === "pending_payment" && !r.cancelled);
    expect(pendings.length).toBe(N_PEND);
  });
});
