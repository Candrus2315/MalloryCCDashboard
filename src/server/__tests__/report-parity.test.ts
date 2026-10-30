/**
 * CROSS-REPORT PARITY (owner directive 10/30, hard requirement) — the Daily
 * Report and the Weekly CC Report must agree DIGIT-FOR-DIGIT for the same
 * week and cutoff on the three overlapping figures:
 *
 *   1. Bookings for the Week (Daily)      == Bookings (Week) (Weekly CC)
 *   2. Total Weekly Leads (Daily)         == Total (Weekly CC leads)
 *   3. Total Lead Conversion — Week (Daily) == Total Lead Conversion — Week (Weekly CC)
 *
 * The conversion is computed by ONE shared function — totalLeadConversionWeek
 * (compute.ts) — over ONE canonical (bookings, leads) pair: the Final Booking
 * Logic gross (created Mon–Sun, identity-deduped, cancellations included) and
 * the work-date lead cohort total (all seven sources). NO mean-of-rates
 * anywhere. Mirrors the frozen-target suite's pure-builder parity pattern,
 * then proves the loader wiring end-to-end on a MemoryStore (Daily for a
 * Sunday vs the Weekly CC Report for that same just-completed week).
 */
import { describe, expect, test } from "bun:test";
import { buildDailyReportMetrics, totalLeadConversionWeek, type AppointmentRow, type LeadRow } from "../metrics/compute";
import { buildDailyReportText } from "../metrics/report-text";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "../metrics/weekly-report-text";
import { splitLeadsByType } from "../metrics/weekly";
import { dailyReportPageData, weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";

// Week of Mon 2026-09-21 … Sun 2026-09-27 — the owner's reference weekly
// shape: gross 84 (created Mon–Sun, identity-deduped, cancels included) over
// 957 work-date leads (audit-79v84 proportion).
const MON = "2026-09-21";
const THU = "2026-09-24";
const FRI = "2026-09-25";
const SUN = "2026-09-27";
const GROSS = 84;
const GOAL = 79;

/** The week's canonical (bookings, leads) pair through the ONE shared function. */
const sharedRate = () => totalLeadConversionWeek(GROSS, weekLeadRows().length);

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

/** The Daily Report for FRIDAY of the parity week (anchor = Thursday). */
function dailyMetrics(leads: LeadRow[]) {
  return buildDailyReportMetrics({
    reportDate: FRI,
    callsAnchorDay: [],
    apptsCreatedAnchorDay: [anchorAppt("d1", THU), anchorAppt("d2", THU)],
    apptsCreatedWtd: [anchorAppt("d1", THU), anchorAppt("d2", THU)],
    // The canonical weekly production — the SAME gross the Weekly CC hero shows.
    weekProduction: { gross: GROSS, cancellations: 5, net: GROSS - 5 },
    allCallsForWeek: [],
    attributions: [],
    leadsAllRecent: leads,
    teamBookingGoal: GOAL,
    weeklyLeadBudget: 700,
    thresholdSeconds: 120,
  });
}

/** The Weekly CC Report for the SAME week, fed by the SAME shared rate. */
function weeklyReport(leads: LeadRow[]): string {
  const leadsSummary = splitLeadsByType(leads);
  const input: WeeklyCcReportInput = {
    week: { start: MON, end: SUN },
    monthKey: "2026-09",
    bookingsWeek: { total: GROSS, goal: GOAL },
    bookingsMonth: { total: 246, goal: 316 },
    productionWeek: { gross: GROSS, cancellations: 5, net: GROSS - 5, goal: GOAL },
    productionMonth: { gross: 246, goal: 316 },
    channels: { alliance: 0, auction: 0, website: null },
    channelLeads: { alliance: 0, auction: 0, website: null },
    leads: leadsSummary,
    weekConversion: {
      rate: totalLeadConversionWeek(GROSS, leadsSummary.total),
      family: 30 / 470,
      animalia: 25 / 350,
      fairyland: 5 / 60,
    },
    funnel: { wins: GROSS, leads: leadsSummary.total, pct: null },
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

  test("1 — Bookings for the Week (Daily) == Bookings (Week) gross (Weekly CC)", () => {
    expect(m.weekBookings).toBe(GROSS);
    expect(lineOf(dailyText, "Bookings for the Week:")).toBe(`Bookings for the Week: ${GROSS}`);
    expect(weeklyText).toContain(`Bookings (Week): ${GROSS}/${GOAL} (+${GROSS - GOAL}) gross`);
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
    expect(m.totalLeadConversionWeek).toBe(sharedRate());
    // …and the same rendered string at the parity-locked one-decimal precision.
    expect(lineOf(dailyText, "Total Lead Conversion — Week:")).toBe(
      lineOf(weeklyText, "Total Lead Conversion — Week:"),
    );
    expect(lineOf(weeklyText, "Total Lead Conversion — Week:")).toBe("Total Lead Conversion — Week: 8.8%");
  });

  test("4 — never a mean of per-source or rep rates (pooled division only)", () => {
    // The three by-source rates average to 7.3%, the pooled division is 8.8% —
    // the headline MUST be the pooled division.
    const mean = (30 / 470 + 25 / 350 + 5 / 60) / 3;
    expect(m.totalLeadConversionWeek).not.toBeCloseTo(mean, 2);
    expect(m.totalLeadConversionWeek).toBeCloseTo(GROSS / leads.length, 10);
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
  // Three paid wins created inside the parity week (created basis = gross 3)
  // + one pending row that never counts anywhere.
  await store.upsertAppointments([paidWin("p-w1", "2026-09-22"), paidWin("p-w2", "2026-09-24"), paidWin("p-w3", "2026-09-26"), {
    ...paidWin("p-pending", "2026-09-23"),
    raw: { paid: "no", priceSold: "300.00" },
    booking_win_business_date: null,
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
  test("weekBookings / weeklyLeads / week conversion agree digit-for-digit from the canonical pair", async () => {
    const store = await seedParityStore();
    // The Daily Report rendered ON Sunday 9/27 covers the CURRENT week (9/21–27).
    const daily = await dailyReportPageData({ store, today: SUN, etNowMinutes: 10 * 60 });
    // The Weekly CC Report rendered the NEXT Monday covers LAST week (9/21–27) — the same week.
    const weekly = await weeklyPageData({ store, today: "2026-09-28" });

    expect(daily.metrics.weekBookings).toBe(weekly.bookings.production.gross); // gross basis, both
    expect(daily.metrics.weeklyLeads).toBe(weekly.leads.total); // same work-date cohort total
    // ONE shared function over the SAME pair — exact float equality.
    expect(daily.metrics.totalLeadConversionWeek).toBe(
      totalLeadConversionWeek(weekly.bookings.production.gross, weekly.leads.total),
    );
    // And the rendered headlines are the identical string.
    const dailyLine = lineOf(daily.reportText, "Total Lead Conversion — Week:");
    const weeklyLine = lineOf(weekly.report.reportText, "Total Lead Conversion — Week:");
    expect(dailyLine).toBe(weeklyLine);
    expect(dailyLine).toBe("Total Lead Conversion — Week: 75.0%"); // 3 gross ÷ 4 leads
    // Bookings/leads parity in the copied text too.
    expect(lineOf(daily.reportText, "Bookings for the Week:")).toBe("Bookings for the Week: 3");
    expect(weekly.report.reportText).toContain("Bookings (Week): 3/79 (−76) gross");
    expect(lineOf(daily.reportText, "Total Weekly Leads:")).toBe("Total Weekly Leads: 4");
    expect(lineOf(weekly.report.reportText, "Total:")).toBe("Total: 4");
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
