/**
 * WEEKLY CHANNEL PANEL (owner directive 2026-10-28) + CC Report erasure —
 * deterministic tests through the weeklyPageData seam (MemoryStore, pinned
 * today = Tue 2026-10-28 → report week Mon 10/19 .. Sun 10/25).
 *
 * The "Alliance / Auction / Website" panel previously counted LEADS from GHL
 * pipeline opportunities (a pre-Forms-Data basis that showed 0/0 for the
 * 10/19–25 week) and hardcoded Website bookings to null. The directive:
 *  - Leads column = the SAME work-date cohort counts the Leads panel shows for
 *    the three Forms Data sources (no re-derivation).
 *  - Paid bookings column = SOURCE ATTRIBUTION chain (nearest-lead-to-
 *    booking-creation, booking-period basis) for the three sources — Website
 *    included, honest 0 when nothing attributed (never "—").
 *  - Caption tracks the SELECTED report week (it always did — the page's
 *    lwMon..lwSun window), so it now says "report week (dates)".
 * And the CC Report carries NO lead-source section anymore (the erasure
 * directive) — asserted here at the page level too.
 *
 * Fixture wiring (why the numbers come out as they do):
 *  - au-1 (Auction Certificates, contact k-au) booked w-au in-week → CURRENT
 *  - al-1 (Alliance Certificates, contact k-al) booked w-al in-week → CURRENT
 *  - au-prior (Auction Certificates, contact k-prior, sheet date Fri 10/9 →
 *    work date 10/12 = the PRIOR week's cohort) booked w-prior created
 *    IN-WEEK → PRIOR-period match, keeps the auction source
 *  - web-1 (Website Applications, contact k-web) never books → website
 *    attribution is an honest 0
 *  - au-2 (Auction Certificates, no identity) never books
 */
import { describe, expect, test } from "bun:test";
import { weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";
import type { AppointmentRow, LeadRow } from "../metrics/compute";

const TODAY = "2026-10-28"; // Tue → report week Mon 2026-10-19 .. Sun 2026-10-25
const H = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString(); // EDT

const win = (id: string, contactId: string, createdDate: string, winDate: string, type = "Portrait Session"): AppointmentRow => ({
  id,
  acuity_appointment_id: id, // the memory store keys appointments on the Acuity id — omitting it would collapse every upsert
  contact_id: contactId,
  calendar_id: null,
  appointment_type: type,
  appointment_datetime: H(winDate, "14:00"),
  created_at: H(createdDate, "12:00"),
  created_business_date: createdDate,
  booking_win_business_date: winDate,
  raw: { priceSold: "300.00", amountPaid: "300.00" },
  payment_state: "paid", // the PRODUCTION chain (computeWeeklyProduction) keys on the persisted paid state
  status: "scheduled",
  cancelled: false,
});

const lead = (id: string, sheet: string, sourceDate: string, workDate: string, contactId: string | null = null): LeadRow => ({
  id,
  lead_type: "Certificate", // form rows classify by SHEET identity — text is never a genre vote
  source_date: sourceDate,
  work_date: workDate,
  contact_id: contactId,
  assigned_rep_id: null,
  source_sheet: sheet,
  source_id: id,
  provider: "google_sheets",
});

async function seedPanelStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  // three in-week wins (created inside the report week — the attribution anchor)
  await store.upsertAppointments([
    win("p-w-au", "k-au", "2026-10-21", "2026-10-22", "Auction Portrait Session"), // current-period → auction
    win("p-w-al", "k-al", "2026-10-21", "2026-10-22", 'Alliance Portrait Session + 20" Portrait'), // current-period → alliance
    win("p-w-prior", "k-prior", "2026-10-21", "2026-10-22"), // prior-period → auction (type irrelevant to attribution)
  ]);
  await store.upsertLeads([
    lead("p-au-1", "auction_register_certificate", "2026-10-21", "2026-10-22", "k-au"), // booked (current)
    lead("p-au-2", "auction_register_certificate", "2026-10-20", "2026-10-21"), // unbooked
    lead("p-al-1", "alliance_activate_certificate", "2026-10-21", "2026-10-22", "k-al"), // booked (current)
    lead("p-web-1", "website_applications", "2026-10-21", "2026-10-22", "k-web"), // never books → honest 0
    // PRIOR-period auction lead: sheet date Fri 10/9 rolls to work date Mon
    // 10/12 (the PRIOR week's cohort) — its booking created 10/21 stays
    // attributed to the auction source, prior-period category.
    lead("p-au-prior", "auction_register_certificate", "2026-10-09", "2026-10-12", "k-prior"),
  ]);
  return store;
}

describe("Weekly channel panel (owner directive 10/28) — payload level", () => {
  test("Leads column == the work-date cohort counts the Leads panel shows (data.leads, three sources)", async () => {
    const data = await weeklyPageData({ store: await seedPanelStore(), today: TODAY });
    expect(data.leads.auction_register_certificate).toBe(2); // au-1 + au-2 (au-prior sits in the PRIOR week's cohort)
    expect(data.leads.alliance_activate_certificate).toBe(1);
    expect(data.leads.website_applications).toBe(1);
    // ALWAYS in agreement with the Leads panel: the per-source cohort table
    // (data.sourcePerformance.cohort — the Weekly tab's Lead Source |
    // Leads Received rows) counts the SAME work-date cohort.
    const cohortLead = (source: string) => data.sourcePerformance.cohort.find((r) => r.source === source)?.leads ?? -1;
    expect(cohortLead("auction_register_certificate")).toBe(data.leads.auction_register_certificate);
    expect(cohortLead("alliance_activate_certificate")).toBe(data.leads.alliance_activate_certificate);
    expect(cohortLead("website_applications")).toBe(data.leads.website_applications);
  });

  test("Paid bookings column == the SOURCE ATTRIBUTION chain (booking-period basis, incl. Website honest 0)", async () => {
    const data = await weeklyPageData({ store: await seedPanelStore(), today: TODAY });
    // current (au-1→w-au) + prior (au-prior→w-prior): both keep the auction source
    expect(data.channelAttribution.auction).toBe(2);
    expect(data.channelAttribution.alliance).toBe(1); // al-1→w-al, current-period
    expect(data.channelAttribution.website).toBe(0); // web-1 never books — honest 0, not "—"
    // derived from the EXISTING audit table: per-bucket sum of its three
    // categories (current + prior + later) — no second attribution run
    const attributed = (source: string) => {
      const r = data.sourcePerformance.table.rows.find((x) => x.source === source);
      return r == null ? 0 : r.bookings + r.priorBookings + r.laterBookings;
    };
    expect(data.channelAttribution.alliance).toBe(attributed("alliance_activate_certificate"));
    expect(data.channelAttribution.auction).toBe(attributed("auction_register_certificate"));
    expect(data.channelAttribution.website).toBe(attributed("website_applications"));
    // the deliberate difference from the hero: these are active paid wins of
    // the week (audit view) — the production block reports the created-in-week
    // Gross with cancellations included
    expect(data.bookings.production.gross).toBe(3); // w-au, w-al, w-prior — all created in-week
    expect(data.bookings.production.cancellations).toBe(0);
    expect(data.bookings.production.net).toBe(3);
  });

  test("the CC Report copy carries NO lead-source section (erasure, page level)", async () => {
    const data = await weeklyPageData({ store: await seedPanelStore(), today: TODAY });
    expect(data.report.reportText).not.toContain("LEAD SOURCE PERFORMANCE");
    expect(data.report.reportText).not.toContain("Leads = leads received for this work week");
    expect(data.report.reportText).not.toContain("Total — Leads:");
    expect(data.report.reportText).not.toContain("Booking-period audit:");
    expect(data.report.reportText).not.toContain("detail on the Weekly tab");
    // the kept template survives: hero + MTD gross + the channel lines
    // (rev-97: the ±goal comparison rides the QUALIFYING count — 3 active
    // wins here — while Gross / Cancellations / Net stay as production figures)
    expect(data.report.reportText).toContain("Bookings (Week): 3/79 (−76) qualifying · Gross: 3 · Cancellations: 0 · Net: 3");
    expect(data.report.reportText).toMatch(
      /Bookings \(Month-to-Date, October 2026\): 3\/— qualifying · Gross \(cancellations included\): 3/,
    );
    expect(data.report.reportText).toContain("Alliance — Leads: 0 · Bookings: 1");
  });

  test("the panel caption tracks the SELECTED report week, not a fixed 'previous week'", async () => {
    const data = await weeklyPageData({ store: await seedPanelStore(), today: TODAY });
    expect(data.week.start).toBe("2026-10-19");
    expect(data.week.end).toBe("2026-10-25");
  });
});
