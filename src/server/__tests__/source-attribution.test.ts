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
  sourceMatchCategory,
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
  // honor the override so tests can construct genuinely unpaid rows (the
  // paid-only win rule in computeLeadCohortOutcomes rides on isBookingWin)
  payment_state: over.payment_state ?? "paid",
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
    expect(r.get("w1")).toEqual({ source: "google_ads_leads", leadId: "l1", sourceDate: "2026-10-19" });
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
    expect(r.get("wn")).toEqual({ source: "unattributed", leadId: null, sourceDate: null });
    const w2 = win({ id: "wm", contact_id: "c9" });
    const r2 = resolveBookingSources([w2], [lead({ contact_id: "c9", source_sheet: "mystery_sheet" })]);
    // classifyLeadSource mirrors splitLeadsByType: an unknown sheet's row falls into the family catch-all (never a separate invented bucket)
    expect(r2.get("wm")!.source).toBe("family");
  });
});

// ---------- table math ----------

const PERIOD = { start: "2026-10-19", end: "2026-10-25" };

describe("buildSourcePerformanceTable", () => {
  test("classification is BYTE-IDENTICAL to splitLeadsByType; conv null on zero leads; total row", () => {
    const cohort: LeadJoinRow[] = [
      lead({ id: "1", contact_id: "c1", source_sheet: "family", lead_type: "Family", source_date: "2026-10-19" }),
      // family-sheet row typed "Animalia" → animalia (splitLeadsByType's text rule)
      lead({ id: "2", contact_id: "c2", source_sheet: "family", lead_type: "Animalia", source_date: "2026-10-19" }),
      lead({ id: "3", contact_id: "c3", source_sheet: "google_ads_leads", lead_type: "Pet", source_date: "2026-10-20" }),
    ];
    const wins = [
      win({ id: "tw1", contact_id: "c1" }), // → family lead (in cohort → current-period)
      win({ id: "tw2", contact_id: "c3" }), // → google ads lead (in cohort → current-period)
      win({ id: "tw3", contact_id: "c9" }), // → no lead link → Truly Unattributed
    ];
    const byWinSource = resolveBookingSources(wins, cohort);
    const table = buildSourcePerformanceTable(cohort.map(asLeadRow), wins, byWinSource, PERIOD);
    const split = splitLeadsByType(cohort.map(asLeadRow));
    const row = (s: string) => table.rows.find((r) => r.source === s)!;
    expect(row("family").leads).toBe(split.family);
    expect(row("animalia").leads).toBe(split.animalia);
    expect(row("fairyland").leads).toBe(split.fairyland);
    expect(row("google_ads_leads").leads).toBe(split.google_ads_leads);
    expect(row("family").bookings).toBe(1);
    expect(row("google_ads_leads").conv).toBe(1);
    // Truly Unattributed: not a per-source count, never a numerator
    expect(row("unattributed").bookings).toBe(0);
    expect(row("unattributed").conv).toBeNull();
    expect(table.trulyUnattributedBookings).toBe(1);
    expect(row("fairyland").conv).toBeNull(); // 0 leads → "—", never 0%
    expect(table.totalLeads).toBe(3);
    expect(table.totalBookings).toBe(3);
    expect(table.totalCurrentBookings).toBe(2);
    expect(table.totalConv).toBe(2 / 3); // COHORT conversion, not 3/3
    expect(table.sourceResolvedBookings).toBe(2);
    expect(table.coverage).toBe(2 / 3);
    expect(table.rows[table.rows.length - 1].source).toBe("total");
  });

  test("THREE-CATEGORY split: prior-period matches keep their resolved source and never enter a numerator", () => {
    // Cohort: one family lead inside the week. A second contact's ONLY lead is
    // from the prior week — its booking must stay under Family, labeled
    // prior-period, and NOT lift family's conversion numerator.
    const inWeek = lead({ id: "in", contact_id: "c1", source_sheet: "family", lead_type: "Family", source_date: "2026-10-20" });
    const prior = lead({ id: "prior", contact_id: "c2", source_sheet: "family", lead_type: "Family", source_date: "2026-10-11" });
    const later = lead({ id: "later", contact_id: "c3", source_sheet: "animalia", lead_type: "Animalia", source_date: "2026-10-28" });
    const wins = [
      win({ id: "w-in", contact_id: "c1", created_business_date: "2026-10-21" }), // current-period
      win({ id: "w-prior", contact_id: "c2", created_business_date: "2026-10-21" }), // prior-period → family
      win({ id: "w-later", contact_id: "c3", created_business_date: "2026-10-21" }), // later-period → animalia
      win({ id: "w-none", contact_id: "c9", created_business_date: "2026-10-21" }), // unlinked
    ];
    const leads = [inWeek, prior, later];
    const byWinSource = resolveBookingSources(wins, leads);
    const table = buildSourcePerformanceTable([asLeadRow(inWeek)], wins, byWinSource, PERIOD);
    const row = (s: string) => table.rows.find((r) => r.source === s)!;
    // family: 1 cohort lead; 1 current + 1 prior booking
    expect(row("family").bookings).toBe(1);
    expect(row("family").priorBookings).toBe(1);
    expect(row("family").laterBookings).toBe(0);
    expect(row("family").conv).toBe(1); // 1/1 — the prior match never entered the numerator
    // animalia: zero cohort leads, but the later-period match keeps its source
    expect(row("animalia").leads).toBe(0);
    expect(row("animalia").bookings).toBe(0);
    expect(row("animalia").priorBookings).toBe(0);
    expect(row("animalia").laterBookings).toBe(1);
    expect(row("animalia").conv).toBeNull(); // no leads → "—", never 0%
    // totals: 4 wins = 1 current + 1 prior + 1 later + 1 unlinked
    expect(table.totalLeads).toBe(1);
    expect(table.totalBookings).toBe(4);
    expect(table.totalCurrentBookings).toBe(1);
    expect(table.totalPriorBookings).toBe(1);
    expect(table.totalLaterBookings).toBe(1);
    expect(table.trulyUnattributedBookings).toBe(1);
    expect(table.sourceResolvedBookings).toBe(3);
    expect(table.coverage).toBe(3 / 4);
    // total conv = COHORT figure (1/1), never 1/4
    expect(table.totalConv).toBe(1);
    // label honesty: the unattributed row is "Truly Unattributed"
    expect(row("unattributed").label).toBe("Truly Unattributed");
  });

  test("conversion-numerator isolation: prior-period wins never lift any source's conv or the total", () => {
    // 1 google lead in cohort + 9 prior google matches → conv stays 1/1 = 100%,
    // NOT 10/1; the funnel total stays 1/1, not 10/1.
    const inWeek = lead({ id: "g-in", contact_id: "c1", source_sheet: "google_ads_leads", lead_type: "G", source_date: "2026-10-20" });
    const priorLeads = Array.from({ length: 9 }, (_, i) =>
      lead({ id: "g-prior" + i, contact_id: "cp" + i, source_sheet: "google_ads_leads", lead_type: "G", source_date: "2026-10-0" + (i + 1) }),
    );
    const wins = [win({ id: "w-in", contact_id: "c1" }), ...priorLeads.map((_, i) => win({ id: "w-p" + i, contact_id: "cp" + i }))];
    const byWinSource = resolveBookingSources(wins, [inWeek, ...priorLeads]);
    const table = buildSourcePerformanceTable([asLeadRow(inWeek)], wins, byWinSource, PERIOD);
    const g = table.rows.find((r) => r.source === "google_ads_leads")!;
    expect(g.bookings).toBe(1);
    expect(g.priorBookings).toBe(9);
    expect(g.conv).toBe(1);
    expect(table.totalConv).toBe(1);
    expect(table.totalBookings).toBe(10);
    expect(table.coverage).toBe(1); // 10/10 wins resolved to a source
    expect(table.trulyUnattributedBookings).toBe(0);
  });

  test("sourceMatchCategory: current/prior/later/unlinked against the period bounds", () => {
    const cohortIds = new Set(["a"]);
    expect(sourceMatchCategory({ leadId: null, sourceDate: null }, cohortIds, PERIOD)).toBe("unlinked");
    expect(sourceMatchCategory(undefined, cohortIds, PERIOD)).toBe("unlinked");
    expect(sourceMatchCategory({ leadId: "a", sourceDate: "2026-10-19" }, cohortIds, PERIOD)).toBe("current");
    expect(sourceMatchCategory({ leadId: "a", sourceDate: "2026-10-25" }, cohortIds, PERIOD)).toBe("current");
    expect(sourceMatchCategory({ leadId: "x", sourceDate: "2026-10-18" }, cohortIds, PERIOD)).toBe("prior");
    expect(sourceMatchCategory({ leadId: "x", sourceDate: "2026-09-25" }, cohortIds, PERIOD)).toBe("prior");
    expect(sourceMatchCategory({ leadId: "x", sourceDate: "2026-10-26" }, cohortIds, PERIOD)).toBe("later");
  });

  test("sourceConversion divide-by-zero → null; one win → exactly one source", () => {
    expect(sourceConversion(0, 0)).toBeNull();
    expect(sourceConversion(1, 0)).toBeNull();
    expect(sourceConversion(1, 4)).toBe(0.25);
  });

  test("date-range filtering: cohort and wins come only from what the caller passes; out-of-cohort matches keep their source", () => {
    const inRange = lead({ id: "in", contact_id: "c1", source_date: "2026-10-20" });
    const outOfRange = lead({ id: "out", contact_id: "c2", source_date: "2026-09-01" });
    const wins = [win({ id: "rw", contact_id: "c1" })];
    const byWinSource = resolveBookingSources(wins, [inRange]);
    const table = buildSourcePerformanceTable([asLeadRow(inRange)], wins, byWinSource, PERIOD);
    expect(table.totalLeads).toBe(1); // the 09-01 lead was never in the cohort
    // The win matched inRange (source_date 09-01 was never offered) → current-period
    const table2 = buildSourcePerformanceTable([asLeadRow(outOfRange)], wins, resolveBookingSources(wins, [outOfRange, inRange]), PERIOD);
    expect(table2.totalLeads).toBe(1);
    // THREE-CATEGORY SEMANTICS: the win still matched inRange (Oct 20) — the
    // caller's cohort is only outOfRange, but the category follows the matched
    // lead's DATE (inside the period) → credited to its source as current.
    const fam = table2.rows.find((r) => r.source === "family")!;
    expect(fam.bookings).toBe(1);
    expect(table2.trulyUnattributedBookings).toBe(0);
    // A genuinely prior match (win resolved to the Sep 1 lead) keeps its source:
    const priorWins = [win({ id: "pw", contact_id: "c2" })];
    const table3 = buildSourcePerformanceTable([asLeadRow(inRange)], priorWins, resolveBookingSources(priorWins, [outOfRange]), PERIOD);
    expect(table3.rows.find((r) => r.source === "family")!.priorBookings).toBe(1);
    expect(table3.rows.find((r) => r.source === "family")!.bookings).toBe(0);
    expect(table3.trulyUnattributedBookings).toBe(0);
  });

  test("bestWorstSourceLines", () => {
    const rows = buildSourcePerformanceTable(
      [lead({ id: "1", contact_id: "c1", source_sheet: "family" }), lead({ id: "2", contact_id: "c2", source_sheet: "google_ads_leads", lead_type: "P" })].map(asLeadRow),
      [win({ id: "bw", contact_id: "c1" })],
      resolveBookingSources([win({ id: "bw", contact_id: "c1" })], [lead({ id: "1", contact_id: "c1", source_sheet: "family" }), lead({ id: "2", contact_id: "c2", source_sheet: "google_ads_leads", lead_type: "P" })]),
      PERIOD,
    );
    const bw = bestWorstSourceLines(rows);
    expect(bw.best).toBe("Family (100.0%)");
    expect(bw.worst).toBe("Google Ads Leads (0.0%)");
  });

  test("coverage math: null when no wins; 77/80 → 0.9625 shape", () => {
    const noWins = buildSourcePerformanceTable([asLeadRow(lead({ id: "nl", contact_id: "c1" }))], [], new Map(), PERIOD);
    expect(noWins.totalBookings).toBe(0);
    // Coverage is null with no wins at all (nothing to resolve); the cohort
    // conversion is a DEFINED 0.0 (1 lead came in, none booked).
    expect(noWins.coverage).toBeNull();
    expect(noWins.totalConv).toBe(0);
    const l1 = lead({ id: "cl1", contact_id: "d1", source_date: "2026-10-20" });
    const l2 = lead({ id: "cl2", contact_id: "d2", source_date: "2026-10-21" });
    const wins = [win({ id: "cw1", contact_id: "d1" }), win({ id: "cw2", contact_id: "d2" }), win({ id: "cw3", contact_id: "zz" })];
    const t = buildSourcePerformanceTable([asLeadRow(l1), asLeadRow(l2)], wins, resolveBookingSources(wins, [l1, l2]), PERIOD);
    expect(t.sourceResolvedBookings).toBe(2);
    expect(t.trulyUnattributedBookings).toBe(1);
    expect(t.coverage).toBe(2 / 3);
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
    // TEST EXPECTATION ADJUSTED (flagged to the lead, per the audit blueprint §C
    // "cross-source duplicates"): the original people=2 contradicts this fixture's
    // own "same single source — not overlap" comment. dup@x.com appears twice in
    // ONE source (family) — same-source duplication, NOT cross-source overlap;
    // counting it would overstate the copied note ("appear as leads from 2+
    // sources"). The only person in 2+ DISTINCT source_sheet values here is the
    // phone group (family+google_ads): 1 person, 1 pair.
    expect(o.people).toBe(1);
    expect(o.pairs).toBe(1); // the phone group spans family+google_ads; the other emails are single-source groups
    expect(o.note).toContain("1 person appears as a lead from 2+ sources");
  });
});

// ---------- weekly report text ----------

describe("buildWeeklyCcReportText — LEAD SOURCE PERFORMANCE ERASED (owner directive 10/28)", () => {
  // The report no longer ACCEPTS a sourcePerformance input (the field is gone
  // from WeeklyCcReportInput — page-data.ts stopped passing it) and can never
  // render the section: no header, no methodology sentence, no per-source lead
  // lines, no "Total — Leads", no booking-period audit footnote. The per-source
  // tables keep living on the WEEKLY TAB only — their builders are tested in
  // the describe blocks below this one.
  const base: WeeklyCcReportInput = {
    week: { start: "2026-10-19", end: "2026-10-25" },
    monthKey: "2026-10",
    bookingsWeek: { total: 5, goal: 79 },
    bookingsMonth: { total: 12, goal: null },
    channels: { alliance: 1, auction: 2, website: null },
    channelLeads: { alliance: 3, auction: 4, website: null },
    leads: { family: 10, animalia: 4, fairyland: 1, auction_register_certificate: 2, google_ads_leads: 6, alliance_activate_certificate: 0, website_applications: 1, total: 24 },
    // OWNER 10/30: the report's conversion is the TOTAL-lead headline
    // (weekConversion); the legacy assigned-only `conversion` input renders
    // nowhere. rate 0.5 → "50.0%" at the one-decimal parity precision.
    weekConversion: { rate: 0.5, family: 0.5, animalia: null, fairyland: null },
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

  test("the erased section renders NOWHERE — even on the fullest template (hero + gross MTD + holes + form-source lead lines)", () => {
    const text = buildWeeklyCcReportText({
      ...base,
      productionWeek: { gross: 84, cancellations: 5, net: 79, goal: 69 },
      productionMonth: { gross: 246, goal: 316 },
    });
    // header + methodology sentence
    expect(text).not.toContain("LEAD SOURCE PERFORMANCE");
    expect(text).not.toContain("Leads = leads received for this work week");
    // ALL seven per-source lead lines (the kept channel lines use the
    // "Alliance — Leads: N · Bookings: N" shape — distinct from "<Label> — Leads:")
    for (const label of ["Family", "Animalia", "Fairyland", "Auction Certificates", "Google Ads Leads", "Alliance Certificates", "Website Applications"]) {
      expect(text).not.toContain(`${label} — Leads:`);
    }
    // the Total — Leads line and the trailing audit footnote, every fragment
    expect(text).not.toContain("Total — Leads:");
    expect(text).not.toContain("Booking-period audit:");
    expect(text).not.toContain("Prior-period:");
    expect(text).not.toContain("Later-period:");
    expect(text).not.toContain("No reliable link:");
    expect(text).not.toContain("Coverage:");
    expect(text).not.toContain("detail on the Weekly tab");
    // the kept sections survive intact around the erasure — REV-97: the goal
    // comparisons ride the QUALIFYING counts (bookingsWeek 5 / bookingsMonth
    // 12), gross stays as the production figures
    expect(text).toContain("Bookings (Week): 5/69 (−64) qualifying · Gross: 84 · Cancellations: 5 · Net: 79");
    expect(text).toContain("Bookings (Month-to-Date, October 2026): 12/316 (−304) qualifying · Gross (cancellations included): 246");
    expect(text).toContain("Auction Certificates: 2");
    expect(text).toContain("Total: 24");
    expect(text).toContain("Holes (empty slots): 3");
    expect(text).toContain("Total Lead Conversion — Week: 50.0%"); // owner 10/30 template (one-decimal parity precision)
    expect(text).toContain("  by source: Family 50.0% · Animalia — · Fairyland —");
  });

  test("template tolerance preserved: the render differs ONLY by the provided optional inputs — never by a source section", () => {
    const legacy = buildWeeklyCcReportText(base); // no production inputs → legacy lines
    const withHero = buildWeeklyCcReportText({
      ...base,
      productionWeek: { gross: 84, cancellations: 5, net: 79, goal: 69 },
      productionMonth: { gross: 246, goal: 316 },
    });
    expect(legacy).toContain("Bookings (Week): 5/79 (−74)");
    expect(legacy).not.toContain("LEAD SOURCE PERFORMANCE");
    expect(withHero).not.toContain("LEAD SOURCE PERFORMANCE");
    // no per-source line in either render
    expect(legacy).not.toContain("Family — Leads:");
    expect(withHero).not.toContain("Family — Leads:");
  });
});

// ---------- primary table shape (Weekly tab, simplified presentation) ----------

describe("primary source-performance table (Weekly tab simplified shape)", () => {
  test("primary view = the seven canonical sources + Total (no Unattributed row); detail fields stay intact", () => {
    // The three-category fixture: one in-week family lead, one prior-week
    // family lead, one later-week animalia lead, and four wins (current,
    // prior, later, no-link).
    const inWeek = lead({ id: "in", contact_id: "c1", source_sheet: "family", lead_type: "Family", source_date: "2026-10-20" });
    const prior = lead({ id: "prior", contact_id: "c2", source_sheet: "family", lead_type: "Family", source_date: "2026-10-11" });
    const later = lead({ id: "later", contact_id: "c3", source_sheet: "animalia", lead_type: "Animalia", source_date: "2026-10-28" });
    const wins = [
      win({ id: "w-in", contact_id: "c1", created_business_date: "2026-10-21" }), // current-period
      win({ id: "w-prior", contact_id: "c2", created_business_date: "2026-10-21" }), // prior-period → family
      win({ id: "w-later", contact_id: "c3", created_business_date: "2026-10-21" }), // later-period → animalia
      win({ id: "w-none", contact_id: "c9", created_business_date: "2026-10-21" }), // unlinked
    ];
    const leads = [inWeek, prior, later];
    const byWinSource = resolveBookingSources(wins, leads);
    const table = buildSourcePerformanceTable([asLeadRow(inWeek)], wins, byWinSource, PERIOD);
    // THE PRIMARY-VIEW SELECTION RULE the Weekly tab renders: drop ONLY the
    // Truly Unattributed row — the seven canonical sources (display order),
    // "other" when nonzero, then Total.
    const primary = table.rows.filter((r) => r.source !== "unattributed");
    expect(primary.map((r) => r.source)).toEqual([
      "family",
      "animalia",
      "fairyland",
      "auction_register_certificate",
      "google_ads_leads",
      "alliance_activate_certificate",
      "website_applications",
      "total",
    ]);
    // Bookings = current-period cohort wins (the SAME validated numerator);
    // Conversion % = current-period ÷ leads ("—" never fabricated).
    expect(primary.find((r) => r.source === "family")).toMatchObject({ leads: 1, bookings: 1, conv: 1 });
    expect(primary.find((r) => r.source === "animalia")).toMatchObject({ leads: 0, bookings: 0, conv: null });
    expect(primary.find((r) => r.source === "total")).toMatchObject({ leads: 1, bookings: 1, conv: 1 });
    // The detail view still has every three-category field per row + totals.
    expect(table.rows.find((r) => r.source === "family")).toMatchObject({ priorBookings: 1, laterBookings: 0 });
    expect(table.rows.find((r) => r.source === "animalia")).toMatchObject({ priorBookings: 0, laterBookings: 1 });
    expect(table.trulyUnattributedBookings).toBe(1);
    expect(table.sourceResolvedBookings).toBe(3);
    expect(table.coverage).toBe(3 / 4);
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
    // SHEET-IDENTITY FALLBACK (owner directive 2026-10-27, item 4): the
    // Fairyland sheet's Campaign Name says "Fairies" — never matched by
    // /fairyland/i — so sheet identity decides for fairyland-sheet rows.
    expect(classifyLeadSource({ lead_type: "Fairies", source_sheet: "fairyland" })).toBe("fairyland");
    expect(classifyLeadSource({ lead_type: "Fairies", source_sheet: "family" })).toBe("family"); // family-sheet text never re-buckets
    expect(phone10("+1 (555) 201-1234")).toBe("5552011234");
    expect(buildLeadSourceIndex([lead({ contact_id: "c1", phone: "5551112222" })]).byContact.get("c1")).toHaveLength(1);
  });
});
