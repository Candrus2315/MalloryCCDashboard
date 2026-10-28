/**
 * REP-CARD COHORT SCOPING tests (owner directive 2026-10-27, part 2; AMENDED
 * by the work-date cohort alignment directive): the primary Bookings numerator
 * is COHORT-TO-DATE PRODUCED — DISTINCT assigned cohort leads (per source)
 * that have ≥1 qualifying paid booking EVER, credited by LEAD ASSIGNMENT (the
 * builder consumes the produced sets as an input; the per-rep machinery is
 * computeAssignedCohortProduced, pinned in workdate-cohort-alignment.test.ts).
 * The verdict rollup (prior/later/no-link/form) stays as the card's AUDIT
 * detail and can never leak into the numerator. Form sources carry no rep
 * cohort (team-level); the card's column contract is Source | Bookings |
 * Assigned Leads | Conv % with every value beneath its header.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildRepCohortSourcePerformance,
  type SourceBucket,
  type WinWithClients,
} from "../metrics/source-attribution";
import type { AttributionRow, LeadRow } from "../metrics/compute";

const PERIOD = { start: "2026-10-19", end: "2026-10-25" };
const R = "rep-r";
const R2 = "rep-r2";

let n = 0;
const cohortLead = (over: Partial<LeadRow> = {}): LeadRow => ({
  id: over.id ?? `L${++n}`,
  lead_type: over.lead_type ?? "Family",
  source_date: over.source_date ?? "2026-10-20",
  work_date: over.work_date ?? over.source_date ?? "2026-10-20",
  contact_id: over.contact_id ?? null,
  assigned_rep_id: over.assigned_rep_id ?? R,
  source_sheet: over.source_sheet ?? "family",
});

let m = 0;
const win = (over: Partial<WinWithClients> = {}): WinWithClients => ({
  id: over.id ?? `W${++m}`,
  contact_id: over.contact_id ?? null,
  calendar_id: null,
  appointment_type: "Family Portrait Session",
  appointment_datetime: "2026-10-22T15:00:00Z",
  created_at: "2026-10-21T16:00:00Z",
  status: "completed",
  cancelled: false,
  created_business_date: "2026-10-21",
  payment_state: "paid",
  booking_win_business_date: "2026-10-22",
  client_phone: over.client_phone ?? null,
  client_email: over.client_email ?? null,
});

const attr = (appointmentId: string, repId: string | null): AttributionRow => ({
  id: `a-${appointmentId}`,
  appointment_id: appointmentId,
  call_id: null,
  rep_id: repId,
  method: "contact_id",
  confidence: 1,
  manual_override: false,
});

const res = (source: SourceBucket, leadId: string | null, sourceDate: string | null) => ({
  source,
  leadId,
  sourceDate,
});

/** A produced-sets literal in the shape computeAssignedCohortProduced returns. */
const produced = (entries: Array<[SourceBucket, string[]]>): Map<SourceBucket, Set<string>> =>
  new Map(entries.map(([b, ids]) => [b, new Set(ids)] as const));

function build(opts: {
  wins: WinWithClients[];
  byWinSource: Map<string, { source: SourceBucket; leadId: string | null; sourceDate: string | null }>;
  cohortLeads?: LeadRow[];
  repId?: string | null;
  producedSets?: Map<SourceBucket, Set<string>>;
  producedInPeriodSets?: Map<SourceBucket, Set<string>>;
}) {
  return buildRepCohortSourcePerformance({
    repId: opts.repId !== undefined ? opts.repId : R,
    wins: opts.wins,
    attributions: opts.wins.map((w) => attr(w.id, opts.repId === undefined ? R : (opts.repId ?? null))),
    byWinSource: opts.byWinSource,
    assignedCohortLeads: opts.cohortLeads ?? [],
    period: PERIOD,
    // The numerator rides the produced sets (cohort-to-date doctrine) —
    // defaults mirror "no cohort lead produced anything yet".
    cohortProducedLeadIds: opts.producedSets ?? new Map(),
    cohortProducedInPeriodLeadIds: opts.producedInPeriodSets ?? new Map(),
  });
}

const rowOf = (d: ReturnType<typeof buildRepCohortSourcePerformance>, source: string) =>
  d.rows.find((r) => r.source === source);

// ---------- 1. cohort scoping ----------

describe("buildRepCohortSourcePerformance (rep-card cohort scoping)", () => {
  test("primary numerator = cohort-to-date PRODUCED leads (distinct, credited by assignment); verdict audit stays OUT of the numerator", () => {
    const cohort = [
      cohortLead({ id: "L1" }), // family, in cohort
      cohortLead({ id: "L2", source_date: "2026-10-21", work_date: "2026-10-21" }),
      cohortLead({ id: "L3", lead_type: "Animalia", source_sheet: "animalia", source_date: "2026-10-22", work_date: "2026-10-22" }),
      cohortLead({ id: "L4", assigned_rep_id: R2 }), // current lead, but ANOTHER rep's cohort
      // (L0, the prior-period lead below, is NOT in this slice — production
      // passes the period's work-date cohort and L0's work date is earlier)
      // form → never a rep cohort. NOTE: assigned_rep_id null must bypass the
      // helper's ?? default (?? treats null as absent) — spread-override it.
      { ...cohortLead({ id: "L5", lead_type: "Google Ads Lead", source_sheet: "google_ads_leads" }), assigned_rep_id: null },
    ];
    const wins = [
      win({ id: "W1" }), // identity-matched L1 (W1+W2 = ONE distinct produced lead)
      win({ id: "W2" }), // matched L1 again — DISTINCT-LEAD counting: still one
      win({ id: "W3" }), // matched L3 → animalia produced lead
      win({ id: "W4" }), // matched L0 → prior-period verdict → detail only
      win({ id: "W5" }), // matched L4 (other rep's lead) → not this rep's cohort
      win({ id: "W6" }), // no lead link → truly unattributed
      win({ id: "W7" }), // matched L5 (form) → team-level, never a rep cohort
      win({ id: "W8" }), // verdict rep R2, matched L4 → not rep R's row at all
    ];
    const byWinSource = new Map<string, { source: SourceBucket; leadId: string | null; sourceDate: string | null }>([
      ["W1", res("family", "L1", "2026-10-20")],
      ["W2", res("family", "L1", "2026-10-20")],
      ["W3", res("animalia", "L3", "2026-10-22")],
      ["W4", res("family", "L0", "2026-10-10")],
      ["W5", res("family", "L4", "2026-10-20")],
      ["W6", res("unattributed", null, null)],
      ["W7", res("google_ads_leads", "L5", "2026-10-21")],
      ["W8", res("family", "L4", "2026-10-20")],
    ]);
    const attributions = [
      ...["W1", "W2", "W3", "W4", "W5", "W6", "W7"].map((id) => attr(id, R)),
      attr("W8", R2),
    ];
    // The produced sets production computes (computeAssignedCohortProduced):
    // DISTINCT cohort leads of this rep with ≥1 causal qualifying win ever —
    // L1 (two wins, one lead) + L3. Verdict wins CANNOT add to these sets:
    // W4's L0, W5's L4 (other rep's cohort), W7's L5 (form) are absent.
    const producedSets = produced([
      ["family", ["L1"]],
      ["animalia", ["L3"]],
    ]);
    const d = buildRepCohortSourcePerformance({
      repId: R,
      wins,
      attributions,
      byWinSource,
      assignedCohortLeads: cohort,
      period: PERIOD,
      cohortProducedLeadIds: producedSets,
      cohortProducedInPeriodLeadIds: produced([
        ["family", ["L1"]],
        ["animalia", ["L3"]],
      ]),
    });

    const family = rowOf(d, "family");
    expect(family).toBeDefined();
    // numerator = DISTINCT produced cohort leads: L1 only (W1+W2 collapse)
    expect(family!.bookings).toBe(1);
    // denominator UNCHANGED: the rep's work-date cohort rows for the source
    expect(family!.leadsAssigned).toBe(2); // L1 + L2 — the unchanged work-date assigned cohort
    expect(family!.conv).toBeCloseTo(0.5);
    expect(family!.kind).toBe("cohort");
    expect(family!.resolvedWins).toBe(4); // audit: this rep's LINKED family wins, any category (W1 W2 W4 W5)

    const animalia = rowOf(d, "animalia");
    expect(animalia!.bookings).toBe(1);
    expect(animalia!.leadsAssigned).toBe(1);
    expect(animalia!.conv).toBeCloseTo(1.0);

    // form source: no rep cohort (owner rule) → 0 / — / — but the row renders with the resolved win count
    const google = rowOf(d, "google_ads_leads");
    expect(google).toBeDefined();
    expect(google!.bookings).toBe(0);
    expect(google!.leadsAssigned).toBe(0);
    expect(google!.conv).toBeNull();
    expect(google!.kind).toBe("team");
    expect(google!.resolvedWins).toBe(1);

    // "unattributed" is NEVER a primary row — the detail carries it
    expect(rowOf(d, "unattributed")).toBeUndefined();

    // DETAIL COUNTS — the total is asserted as the SELF-CONSISTENCY invariant
    // (sum of the cohort rows' bookings; standalone verification also fixed
    // at 1 + 1 = 2 for this fixture: two DISTINCT produced leads)
    const cohortRowSum = d.rows.filter((r) => r.kind === "cohort").reduce((s, r) => s + r.bookings, 0);
    expect(d.totalCohortBookings).toBe(cohortRowSum);
    expect(d.totalCohortBookings).toBe(1 + 1); // family + animalia rows above
    expect(d.totalResolvedWins).toBe(7); // W1..W7 (W8 is rep R2's)
    expect(d.priorBySource).toEqual([{ source: "family", label: "Family", count: 1 }]);
    expect(d.totalPriorWins).toBe(1);
    expect(d.trulyUnattributedWins).toBe(1);
    expect(d.teamFormWins).toEqual([{ source: "google_ads_leads", label: "Google Ads Leads", count: 1 }]);
    expect(d.laterBySource).toEqual([]);
    expect(d.totalLaterWins).toBe(0);
    // COHORT-TO-DATE split (nothing hidden): both produced leads have an
    // in-period causal win → the later bucket stays empty
    expect(d.producedInPeriodBySource).toEqual([
      { source: "family", label: "Family", count: 1 },
      { source: "animalia", label: "Animalia", count: 1 },
    ]);
    expect(d.producedLaterBySource).toEqual([]);
  });

  test("the produced map is the ONLY numerator input: a prior-period verdict win can never leak in, and cohort-produced leads count WITHOUT a verdict", () => {
    // L9 sits in the rep's work-date cohort (received earlier, rolled into the
    // period by the work-date logic) — its verdict win W9 is PRIOR-period
    // (sheet date 10-10 predates the range) and stays audit-only.
    const cohort = [cohortLead({ id: "L9", source_date: "2026-10-10", work_date: "2026-10-20" })];
    const wins = [win({ id: "W9" })];
    const byWinSource = new Map([["W9", res("family", "L9", "2026-10-10")]]);

    // (a) L9 produced NOTHING causal (production's produced map omits it — e.g.
    // the win's identity belongs to another contact): numerator 0, audit keeps the prior win.
    const dNone = build({ wins, byWinSource, cohortLeads: cohort });
    expect(rowOf(dNone, "family")!.bookings).toBe(0);
    expect(dNone.priorBySource).toEqual([{ source: "family", label: "Family", count: 1 }]);
    expect(dNone.totalCohortBookings).toBe(0);
    expect(dNone.totalResolvedWins).toBe(1);

    // (b) L9 DID produce (computeAssignedCohortProduced counts it: causal win,
    // lead in the cohort, credited by ASSIGNMENT): the cohort-to-date doctrine
    // counts it for the ORIGINAL week — no verdict filter applies in either
    // direction. The verdict audit still shows it as prior-period, unchanged.
    const dProduced = build({
      wins,
      byWinSource,
      cohortLeads: cohort,
      producedSets: produced([["family", ["L9"]]]),
      producedInPeriodSets: produced([["family", ["L9"]]]),
    });
    expect(rowOf(dProduced, "family")!.bookings).toBe(1);
    expect(dProduced.totalCohortBookings).toBe(1);
    expect(dProduced.priorBySource).toEqual([{ source: "family", label: "Family", count: 1 }]);
    expect(dProduced.totalPriorWins).toBe(1);
    expect(dProduced.producedLaterBySource).toEqual([]);
  });

  test("form rows only render when the rep has resolved wins; zero activity → no rows; null repId → empty", () => {
    const cohort = [cohortLead({ id: "L1" })];
    // rep with a cohort lead but no wins at all → row renders (0/1/0.0%)
    const d0 = build({ wins: [], byWinSource: new Map(), cohortLeads: cohort });
    expect(d0.rows).toHaveLength(1);
    expect(d0.rows[0]).toMatchObject({ source: "family", bookings: 0, leadsAssigned: 1, conv: 0 });

    // no cohort, no wins → empty card
    const dEmpty = build({ wins: [], byWinSource: new Map(), cohortLeads: [] });
    expect(dEmpty.rows).toHaveLength(0);

    // no rep selected → empty card, no crash
    const dNull = build({ wins: [win({ id: "WX" })], byWinSource: new Map([["WX", res("family", "L1", "2026-10-20")]]), cohortLeads: cohort, repId: null });
    expect(dNull.rows).toHaveLength(0);
    expect(dNull.repId).toBeNull();
  });

  test("later-period wins surface in the detail, never merged and never a numerator; a produced-ALL-later lead lands in producedLater", () => {
    const cohort = [cohortLead({ id: "L1" })];
    const wins = [win({ id: "WL" })];
    const byWinSource = new Map([["WL", res("animalia", "LAFTER", "2026-10-28")]]);

    // without production: the row still renders (0 bookings / — conv) so the
    // later-period win keeps its resolved source as an anchor; the count lives in the detail
    const d = build({ wins, byWinSource, cohortLeads: cohort });
    expect(rowOf(d, "animalia")).toMatchObject({ bookings: 0, leadsAssigned: 0, conv: null, resolvedWins: 1 });
    expect(d.laterBySource).toEqual([{ source: "animalia", label: "Animalia", count: 1 }]);
    expect(d.totalLaterWins).toBe(1);
    expect(d.totalCohortBookings).toBe(0);

    // with production AFTER the period end: the lead counts toward its
    // ORIGINAL week (cohort-to-date) AND is split into producedLaterBySource —
    // never into producedInPeriodBySource.
    const dLater = build({
      wins,
      byWinSource,
      cohortLeads: cohort,
      producedSets: produced([["animalia", ["L1"]]]),
      producedInPeriodSets: new Map(),
    });
    expect(rowOf(dLater, "animalia")!.bookings).toBe(1); // cohort-to-date: booked later still counts
    expect(dLater.producedLaterBySource).toEqual([{ source: "animalia", label: "Animalia", count: 1 }]);
    expect(dLater.producedInPeriodBySource).toEqual([]);
  });
});

// ---------- 2. column contract (alignment guard) ----------

describe("rep card column contract (Source | Bookings | Assigned Leads | Conv %)", () => {
  const src = readFileSync(new URL("../../routes/reps.tsx", import.meta.url), "utf8");
  const sectionStart = src.indexOf('aria-label="Booking sources (rep cohort)"');
  const sectionEnd = src.indexOf('ASSIGNED LEADS BY DAY', sectionStart);
  const section = src.slice(sectionStart, sectionEnd);

  test("headers render in the owner's exact order", () => {
    const headers = [...section.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((mm) => mm[1]);
    expect(headers).toEqual(["Source", "Bookings", "Assigned Leads", "Conv %"]);
  });

  test("every data row emits exactly 4 cells — one beneath each header (alignment guard)", () => {
    const rowBlock = section.slice(section.indexOf(".map((r) => ("), section.indexOf("</tbody>"));
    const tds = rowBlock.match(/<td /g) ?? [];
    expect(tds).toHaveLength(4); // label | bookings | assigned | conv — no extra/missing cell, no conditional cell
    // and no CSS-grid column template anywhere in the section (the shift can't come from a grid class)
    expect(section.includes("grid-template")).toBe(false);
    expect(/grid-cols/.test(section)).toBe(false);
  });

  test("the collapsed attribution detail carries prior / no-link / team-level form counts", () => {
    expect(section.includes("Attribution detail")).toBe(true);
    expect(section.includes("Prior-period wins")).toBe(true);
    expect(section.includes("trulyUnattributedWins")).toBe(true);
    expect(section.includes("teamFormWins")).toBe(true);
    expect(section.includes("laterBySource")).toBe(true);
  });
});
