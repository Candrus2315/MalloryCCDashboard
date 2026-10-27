/**
 * PER-SOURCE BOOKING ATTRIBUTION + CONVERSION tests (owner directive
 * 2026-10-27, Steps 3–5). Covers: the selection rule (nearest/tie-breaks/
 * fallbacks/unattributed), the per-source table math (digit-identical genre
 * classification, divide-by-zero → null), rep rollups (verdict-only),
 * lead-cohort outcomes (causality guard), overlap magnitude, date-range
 * filtering, and the Weekly Report section text (rendered vs byte-identical
 * absence).
 */
import { describe, expect, test } from "bun:test";
import {
  bestWorstSourceLines,
  buildLeadSourceIndex,
  buildSourcePerformanceTable,
  classifyLeadSource,
  computeLeadCohortOutcomes,
  crossSourceOverlap,
  nearestLeadForBooking,
  phone10,
  resolveBookingSources,
  rollupRepSourceBookings,
  sourceConversion,
  type LeadJoinRow,
  type WinWithClients,
} from "../metrics/source-attribution";
import { splitLeadsByType } from "../metrics/weekly";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "../metrics/weekly-report-text";
import type { AttributionRow, LeadRow } from "../metrics/compute";

// ---------- fixtures ----------

let n = 0;
const lead = (over: Partial<LeadJoinRow> = {}): LeadJoinRow => ({
  id: over.id ?? `l${++n}`,
  contact_id: over.contact_id ?? null,
  source_sheet: over.source_sheet ?? "family",
  lead_type: over.lead_type ?? "Family",
  source_date: over.source_date ?? "2026-10-20",
  phone: over.phone ?? null,
  email: over.email ?? null,
  created_at: over.created_at ?? null,
});

let m = 0;
const win = (over: Partial<WinWithClients> = {}): WinWithClients => ({
  id: over.id ?? `w${++m}`,
  contact_id: over.contact_id ?? null,
  calendar_id: null,
  appointment_type: over.appointment_type ?? "Family Portrait Session",
  appointment_datetime: over.appointment_datetime ?? "2026-10-22T15:00:00Z",
  created_at: over.created_at ?? "2026-10-20T16:00:00Z",
  status: "completed",
  cancelled: false,
  created_business_date: over.created_business_date ?? "2026-10-20",
  payment_state: "paid",
  booking_win_business_date: over.booking_win_business_date ?? "2026-10-22",
  client_phone: over.client_phone ?? null,
  client_email: over.client_email ?? null,
});

const attr = (appointmentId: string, repId: string | null, manual = false): AttributionRow => ({
  id: `a-${appointmentId}`,
  appointment_id: appointmentId,
  call_id: null,
  rep_id: repId,
  method: "contact_id",
  confidence: 1,
  manual_override: manual,
});

const asLeadRow = (l: LeadJoinRow): LeadRow => ({
  id: l.id,
  lead_type: l.lead_type,
  source_date: l.source_date,
  work_date: l.source_date,
  contact_id: l.contact_id,
  assigned_rep_id: null,
  source_sheet: l.source_sheet,
});

// ---------- selection rule ----------

describe("nearestLeadForBooking (the selection rule)", () => {
  test("picks the lead with the NEAREST source_date to the anchor", () => {
    const a = lead({ id: "a", source_date: "2026-10-01" });
    const b = lead({ id: "b", source_date: "2026-10-19" });
    expect(nearestLeadForBooking("2026-10-20", [a, b])!.id).toBe("b");
  });

  test("exact distance tie → most recently INGESTED wins (created_at)", () => {
    const older = lead({ id: "older", source_date: "2026-10-18", created_at: "2026-10-18T10:00:00Z" });
    const newer = lead({ id: "newer", source_date: "2026-10-22", created_at: "2026-10-21T10:00:00Z" });
    // 2026-10-20 anchor: both 2 days away — later ingest wins
    expect(nearestLeadForBooking("2026-10-20", [older, newer])!.id).toBe("newer");
    expect(nearestLeadForBooking("2026-10-20", [newer, older])!.id).toBe("newer");
  });

  test("tie with equal created_at → latest source_date, then smallest id (total determinism)", () => {
    const x = lead({ id: "x", source_date: "2026-10-18", created_at: "2026-10-18T10:00:00Z" });
    const y = lead({ id: "y", source_date: "2026-10-22", created_at: "2026-10-18T10:00:00Z" });
    expect(nearestLeadForBooking("2026-10-20", [x, y])!.id).toBe("y");
    const z1 = lead({ id: "z1", source_date: "2026-10-20", created_at: null });
    const z2 = lead({ id: "z2", source_date: "2026-10-20", created_at: null });
    expect(nearestLeadForBooking("2026-10-20", [z2, z1])!.id).toBe("z1");
  });

  test("null anchor or no candidates → null (unattributed, never guessed)", () => {
    expect(nearestLeadForBooking(null, [lead()])).toBeNull();
    expect(nearestLeadForBooking("2026-10-20", [])).toBeNull();
  });
});

// ---------- resolveBookingSources ----------

describe("resolveBookingSources (join + fallback hierarchy)", () => {
  test("contact_id route: the contact's nearest lead wins", () => {
    const l1 = lead({ id: "l1", contact_id: "c1", source_sheet: "google_ads_leads", lead_type: "X", source_date: "2026-10-19" });
    const l2 = lead({ id: "l2", contact_id: "c1", source_sheet: "family", source_date: "2026-10-01" });
    const r = resolveBookingSources([win({ contact_id: "c1", created_business_date: "2026-10-20" })], [l1, l2]);
    expect(r.get("w1")).toEqual({ source: "google_ads_leads", leadId: "l1" });
  });

  test("no contact → phone fallback (normalized to 10 digits)", () => {
    const l = lead({ id: "l1", contact_id: null, phone: "+1 (555) 201-1234", source_sheet: "family" });
    const w = win({ id: "wp", contact_id: null, client_phone: "5552011234" });
    const r = resolveBookingSources([w], [l]);
    expect(r.get("wp")!.source).toBe("family");
  });

  test("no contact/phone → email fallback (case-insensitive)", () => {
    const l = lead({ id: "l1", contact_id: null, email: "Jane@Example.COM", source_sheet: "website_applications", lead_type: "W" });
    const w = win({ id: "we", contact_id: null, client_email: "jane@example.com" });
    const r = resolveBookingSources([w], [l]);
    expect(r.get("we")!.source).toBe("website_applications");
  });

  test("no lead at all → unattributed (never invented); unknown sheet → other", () => {
    const w = win({ id: "wn", contact_id: null });
    const r = resolveBookingSources([w], [lead({ contact_id: "c9", phone: "9999999999" })]);
    expect(r.get("wn")).toEqual({ source: "unattributed", leadId: null });
    const w2 = win({ id: "wm", contact_id: "c9" });
    const r2 = resolveBookingSources([w2], [lead({ contact_id: "c9", source_sheet: "mystery_sheet" })]);
    // classifyLeadSource mirrors splitLeadsByType: an unknown sheet's row falls into the family catch-all (never a separate invented bucket)
    expect(r2.get("wm")!.source).toBe("family");
  });
});

// ---------- table math ----------

describe("buildSourcePerformanceTable", () => {
  test("classification is BYTE-IDENTICAL to splitLeadsByType; conv null on zero leads; total row", () => {
    const cohort: LeadJoinRow[] = [
      lead({ id: "1", contact_id: "c1", source_sheet: "family", lead_type: "Family", source_date: "2026-10-19" }),
      // family-sheet row typed "Animalia" → animalia (splitLeadsByType's text rule)
      lead({ id: "2", contact_id: "c2", source_sheet: "family", lead_type: "Animalia", source_date: "2026-10-19" }),
      lead({ id: "3", contact_id: "c3", source_sheet: "google_ads_leads", lead_type: "Pet", source_date: "2026-10-20" }),
    ];
    const wins = [
      win({ id: "tw1", contact_id: "c1" }), // → family lead
      win({ id: "tw2", contact_id: "c3" }), // → google ads lead
      win({ id: "tw3", contact_id: "c9" }), // → unattributed
    ];
    const byWinSource = resolveBookingSources(wins, cohort);
    const table = buildSourcePerformanceTable(cohort.map(asLeadRow), wins, byWinSource);
    const split = splitLeadsByType(cohort.map(asLeadRow));
    const row = (s: string) => table.rows.find((r) => r.source === s)!;
    expect(row("family").leads).toBe(split.family);
    expect(row("animalia").leads).toBe(split.animalia);
    expect(row("fairyland").leads).toBe(split.fairyland);
    expect(row("google_ads_leads").leads).toBe(split.google_ads_leads);
    expect(row("family").bookings).toBe(1);
    expect(row("google_ads_leads").conv).toBe(1);
    expect(row("unattributed").bookings).toBe(1);
    expect(row("unattributed").conv).toBeNull();
    expect(row("fairyland").conv).toBeNull(); // 0 leads → "—", never 0%
    expect(table.totalLeads).toBe(3);
    expect(table.totalBookings).toBe(3);
    expect(table.totalConv).toBe(1);
    expect(table.rows[table.rows.length - 1].source).toBe("total");
  });

  test("sourceConversion divide-by-zero → null; one win → exactly one source", () => {
    expect(sourceConversion(0, 0)).toBeNull();
    expect(sourceConversion(1, 0)).toBeNull();
    expect(sourceConversion(1, 4)).toBe(0.25);
  });

  test("date-range filtering: cohort and wins come only from what the caller passes", () => {
    const inRange = lead({ id: "in", contact_id: "c1", source_date: "2026-10-20" });
    const outOfRange = lead({ id: "out", contact_id: "c2", source_date: "2026-09-01" });
    const wins = [win({ id: "rw", contact_id: "c1" })];
    const byWinSource = resolveBookingSources(wins, [inRange]);
    const table = buildSourcePerformanceTable([asLeadRow(inRange)], wins, byWinSource);
    expect(table.totalLeads).toBe(1); // the 09-01 lead was never in the cohort
    const table2 = buildSourcePerformanceTable([asLeadRow(outOfRange)], wins, resolveBookingSources(wins, [outOfRange, inRange]));
    expect(table2.totalLeads).toBe(1);
    expect(table2.rows.find((r) => r.source === "unattributed")!.bookings).toBe(1);
  });

  test("bestWorstSourceLines", () => {
    const rows = buildSourcePerformanceTable(
      [lead({ id: "1", contact_id: "c1", source_sheet: "family" }), lead({ id: "2", contact_id: "c2", source_sheet: "google_ads_leads", lead_type: "P" })].map(asLeadRow),
      [win({ id: "bw", contact_id: "c1" })],
      resolveBookingSources([win({ id: "bw", contact_id: "c1" })], [lead({ id: "1", contact_id: "c1", source_sheet: "family" }), lead({ id: "2", contact_id: "c2", source_sheet: "google_ads_leads", lead_type: "P" })]),
    );
    const bw = bestWorstSourceLines(rows);
    expect(bw.best).toBe("Family (100.0%)");
    expect(bw.worst).toBe("Google Ads Leads (0.0%)");
  });
});

// ---------- rep rollup ----------

describe("rollupRepSourceBookings (bookingsByRep semantics — verdict only)", () => {
  test("wins land in a rep row ONLY through their attribution verdict; manual overrides included", () => {
    const leads = [lead({ id: "l1", contact_id: "c1", source_sheet: "family" })];
    const wins = [win({ id: "rp1", contact_id: "c1" }), win({ id: "rp2", contact_id: null }), win({ id: "rp3", contact_id: "c1" })];
    const byWinSource = resolveBookingSources(wins, leads);
    const attrs = [attr("rp1", "rep1"), attr("rp2", null), attr("rp3", "rep2", true)];
    const rollup = rollupRepSourceBookings(wins, attrs, byWinSource);
    expect(rollup.get("rep1")!.get("family")).toBe(1);
    expect(rollup.get("rep2")!.get("family")).toBe(1);
    expect(rollup.has("rep1") && rollup.get("rep1")!.get("unattributed")).toBeFalsy();
    // w2 (no verdict rep) never lands in ANY rep row:
    const total = [...rollup.values()].reduce((s, m) => s + [...m.values()].reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(2);
  });
});

// ---------- lead-cohort flavor ----------

describe("computeLeadCohortOutcomes (flavor a — booked leads through today)", () => {
  test("causality guard: a win CREATED before the lead's sheet date never counts", () => {
    const l = lead({ id: "l1", contact_id: "c1", source_date: "2026-10-19" });
    const earlyWin = win({ id: "ce", contact_id: "c1", created_business_date: "2026-10-18" });
    const lateWin = win({ id: "cl", contact_id: "c1", created_business_date: "2026-10-21" });
    const rows = computeLeadCohortOutcomes([l], [earlyWin, lateWin]);
    expect(rows.find((r) => r.source === "family")!.bookedLeads).toBe(1);
    const rowsEarlyOnly = computeLeadCohortOutcomes([l], [earlyWin]);
    expect(rowsEarlyOnly.find((r) => r.source === "family")!.bookedLeads).toBe(0);
    expect(rowsEarlyOnly.find((r) => r.source === "family")!.conv).toBe(0);
  });

  test("identity fallbacks count too (phone without contact); unpaid rows never count", () => {
    const l = lead({ id: "l1", contact_id: null, phone: "5550001111", source_sheet: "google_ads_leads", lead_type: "G" });
    const unpaid = win({ id: "cu", contact_id: null, client_phone: "5550001111", payment_state: "pending_payment", booking_win_business_date: null });
    const paid = win({ id: "cp", contact_id: null, client_phone: "5550001111", created_business_date: "2026-10-21" });
    const rows = computeLeadCohortOutcomes([l], [unpaid]);
    expect(rows.find((r) => r.source === "google_ads_leads")!.bookedLeads).toBe(0);
    const rowsPaid = computeLeadCohortOutcomes([l], [paid]);
    expect(rowsPaid.find((r) => r.source === "google_ads_leads")!.bookedLeads).toBe(1);
  });
});

// ---------- overlap magnitude ----------

describe("crossSourceOverlap (report note — never a dedupe)", () => {
  test("counts people appearing in 2+ sources by phone or email; skips identity-less rows", () => {
    const leads: LeadJoinRow[] = [
      lead({ id: "1", phone: "5551112222", source_sheet: "family" }),
      lead({ id: "2", phone: "(555) 111-2222", source_sheet: "google_ads_leads", lead_type: "G" }),
      lead({ id: "3", email: "dup@x.com", source_sheet: "family" }),
      lead({ id: "4", email: "dup@x.com", source_sheet: "family" }), // same single source — not overlap
      lead({ id: "5", source_sheet: "family" }), // no identity — never counted
      lead({ id: "6", email: "other@y.com", source_sheet: "alliance_activate_certificate", lead_type: "A" }),
    ];
    const o = crossSourceOverlap(leads, 90);
    expect(o.people).toBe(2);
    expect(o.pairs).toBe(1); // the phone group spans family+google_ads; the other emails are single-source groups
    expect(o.note).toContain("2 people");
  });
});

// ---------- weekly report text ----------

describe("buildWeeklyCcReportText — LEAD SOURCE PERFORMANCE section", () => {
  const base: WeeklyCcReportInput = {
    week: { start: "2026-10-19", end: "2026-10-25" },
    monthKey: "2026-10",
    bookingsWeek: { total: 5, goal: 79 },
    bookingsMonth: { total: 12, goal: null },
    channels: { alliance: 1, auction: 2, website: null },
    channelLeads: { alliance: 3, auction: 4, website: null },
    leads: { family: 10, animalia: 4, fairyland: 1, auction_register_certificate: 2, google_ads_leads: 6, alliance_activate_certificate: 0, website_applications: 1, total: 24 },
    conversion: { overall: 0.5, family: 0.5, animalia: null, fairyland: null },
    funnel: { wins: 5, leads: 24, pct: 5 / 24 },
    calendar: {
      thisWeek: { appointments: 4, slotsOccupied: 4, capacity: 69 },
      nextWeek: { appointments: 2, slotsOccupied: 2, capacity: 69 },
      beyond: 1,
      firstFullyOpenDay: null,
    },
    holes: 3,
    notes: {},
    celebrateDefault: null,
  };

  test("WITHOUT the input the template stays BYTE-IDENTICAL (no section line)", () => {
    const text = buildWeeklyCcReportText(base);
    expect(text).not.toContain("LEAD SOURCE PERFORMANCE");
  });

  test("WITH the input: per-source lines after the Leads block, one-decimal, — on zero leads", () => {
    const text = buildWeeklyCcReportText({
      ...base,
      sourcePerformance: {
        rows: [
          { source: "family", label: "Family", leads: 10, bookings: 4, conv: 0.4 },
          { source: "animalia", label: "Animalia", leads: 4, bookings: 0, conv: 0 },
          { source: "fairyland", label: "Fairyland", leads: 1, bookings: 0, conv: 0 },
          { source: "auction_register_certificate", label: "Auction Certificates", leads: 2, bookings: 1, conv: 0.5 },
          { source: "google_ads_leads", label: "Google Ads Leads", leads: 6, bookings: 0, conv: 0 },
          { source: "alliance_activate_certificate", label: "Alliance Certificates", leads: 0, bookings: 0, conv: null },
          { source: "website_applications", label: "Website Applications", leads: 1, bookings: 0, conv: 0 },
          { source: "unattributed", label: "Unattributed", leads: 0, bookings: 0, conv: null },
          { source: "total", label: "Total", leads: 24, bookings: 5, conv: 5 / 24 },
        ],
        totalLeads: 24,
        totalBookings: 5,
        totalConv: 5 / 24,
        best: "Auction Certificates (50.0%)",
        worst: "Animalia (0.0%)",
        overlapNote: "Note: 7 people appear as leads from 2+ sources in the last 90 days — each source counts its own sheet rows independently (no cross-source dedupe).",
      },
    });
    const lines = text.split("\n");
    const totalIdx = lines.findIndex((l) => l === "Total: 24");
    const convIdx = lines.findIndex((l) => l.startsWith("Conversion of Assigned Leads:"));
    const spIdx = lines.findIndex((l) => l === "LEAD SOURCE PERFORMANCE (report week):");
    expect(totalIdx).toBeGreaterThanOrEqual(0);
    expect(spIdx).toBeGreaterThan(totalIdx);
    expect(convIdx).toBeGreaterThan(spIdx);
    expect(text).toContain("Family — Leads: 10 · Bookings: 4 · Conversion: 40.0%");
    expect(text).toContain("Alliance Certificates — Leads: 0 · Bookings: 0 · Conversion: —");
    expect(text).toContain("Total — Leads: 24 · Bookings: 5 · Conversion: 20.8%");
    expect(text).toContain("Best source: Auction Certificates (50.0%) · Worst source: Animalia (0.0%)");
    expect(text).toContain("7 people appear as leads from 2+ sources");
    expect(text).toContain("Unattributed — Leads: 0 · Bookings: 0 · Conversion: —");
  });
});

// ---------- store fetch sanity (MemoryStore contract) ----------

describe("store join fetches (MemoryStore contract)", async () => {
  test("getLeadsJoinRange + getWinsWithClientsBetween return join-shaped rows", async () => {
    const { MemoryStore } = await import("../store/memory");
    const store = new MemoryStore();
    await store.upsertLeads([
      { id: "seed", lead_type: "Family", source_date: "2026-10-20", work_date: "2026-10-20", contact_id: "c1", assigned_rep_id: null, source_sheet: "family", source_id: "gs2#family#d2026-10-20#p5551112222", provider: "google_sheets", name: null, phone: "5551112222", email: null },
    ]);
    const joinRows = await store.getLeadsJoinRange("2026-10-19", "2026-10-21");
    expect(joinRows).toHaveLength(1);
    expect(joinRows[0]).toMatchObject({ contact_id: "c1", source_sheet: "family", phone: "5551112222" });
    const outOfRange = await store.getLeadsJoinRange("2026-10-01", "2026-10-18");
    expect(outOfRange).toHaveLength(0);
    await store.upsertAppointments([
      { acuity_appointment_id: "a1", appointment_type: "Family Portrait Session", appointment_datetime: "2026-10-22T15:00:00Z", created_at: "2026-10-20T16:00:00Z", status: "completed", cancelled: false, contact_id: "c1", client_name: "T", client_phone: "5551112222", client_email: null, payment_state: "paid", booking_win_business_date: "2026-10-22", created_business_date: "2026-10-20" } as never,
    ]);
    const wins = await store.getWinsWithClientsBetween("2026-10-19", "2026-10-25");
    expect(wins).toHaveLength(1);
    expect(wins[0].client_phone).toBe("5551112222");
  });
});

// ---------- identity helpers ----------

describe("classifyLeadSource mirrors splitLeadsByType exactly", () => {
  test("form sheets by identity, genre by lead_type text, family catch-all", () => {
    expect(classifyLeadSource({ lead_type: "Pet", source_sheet: "google_ads_leads" })).toBe("google_ads_leads");
    expect(classifyLeadSource({ lead_type: "Animalia", source_sheet: "family" })).toBe("animalia");
    expect(classifyLeadSource({ lead_type: "fairy land", source_sheet: "family" })).toBe("family"); // regex is /fairyland/i
    expect(classifyLeadSource({ lead_type: "Fairyland", source_sheet: "family" })).toBe("fairyland");
    expect(classifyLeadSource({ lead_type: "", source_sheet: "animalia" })).toBe("family"); // catch-all is TEXT, not sheet
    expect(classifyLeadSource({ lead_type: "Family", source_sheet: "family" })).toBe("family");
    expect(phone10("+1 (555) 201-1234")).toBe("5552011234");
    expect(buildLeadSourceIndex([lead({ contact_id: "c1", phone: "5551112222" })]).byContact.get("c1")).toHaveLength(1);
  });
});
