/**
 * FAIRYLAND THIRD GENRE (owner directive 2026-10-22) — engine tests.
 *
 * The owner's hard rule: Fairyland is a THIRD genre treated exactly like
 * Family/Animalia everywhere — no fork, no separate workflow/UI. These tests
 * pin the classification precedence (animalia first, then fairyland, else
 * family — a pure widening, never a re-bucketing), the three-way splits, the
 * fairyland lead-count corrections, the assigned-by-day grid, the CSV genre
 * order (Fairyland appends LAST), and the Today-page filter-chip helper
 * ("All | Family | Animalia | Fairyland").
 */
import { describe, expect, test } from "bun:test";
import {
  isAnimaliaSession,
  isFairylandSession,
  splitWinsBySessionType,
  splitLeadsByType,
  type AppointmentRow,
} from "../metrics/weekly";
import { splitLeadRows, leadsToday, type LeadRow, type LeadCountAdjustment } from "../metrics/compute";
import { buildAssignedLeadsByDay, assignedLeadsCsv, ASSIGNED_GENRES, ASSIGNED_GENRE_LABELS } from "../metrics/assigned-by-day";
import { GENRES, GENRE_LABELS, genresForFilter, classifyLeadGenre, classifySessionGenre } from "../../components/genres";

// ---- fixtures ----
const appt = (id: string, appointmentType: string): AppointmentRow => ({
  id,
  contact_id: null,
  calendar_id: null,
  appointment_type: appointmentType,
  appointment_datetime: "2026-10-19T14:00:00Z",
  created_at: "2026-10-01T12:00:00Z",
  status: "completed",
  cancelled: false,
});

const lead = (id: string, leadType: string, overrides: Partial<LeadRow> = {}): LeadRow => ({
  id,
  lead_type: leadType,
  source_date: "2026-10-19",
  work_date: "2026-10-19",
  contact_id: null,
  assigned_rep_id: null,
  source_sheet: leadType,
  ...overrides,
});

// ---- 1. classifiers ----
describe("fairyland classifiers — case-insensitive, precedence preserved", () => {
  test("isFairylandSession matches fairyland in any case/position", () => {
    expect(isFairylandSession("Fairyland Portrait Session")).toBe(true);
    expect(isFairylandSession("fairyland mini")).toBe(true);
    expect(isFairylandSession("FAIRYLAND Session")).toBe(true);
    expect(isFairylandSession("Enchanted Fairyland Sitting")).toBe(true);
  });

  test("isFairylandSession is false for family/animalia/auction types", () => {
    expect(isFairylandSession("Portrait Session")).toBe(false);
    expect(isFairylandSession("Animalia Signature Session")).toBe(false);
    expect(isFairylandSession("Auction Portrait Session")).toBe(false);
  });

  test("existing animalia classification preserved bit-for-bit (animalia checked first)", () => {
    expect(isAnimaliaSession("Animalia Session")).toBe(true);
    expect(isAnimaliaSession("Portrait Session")).toBe(false);
  });

  test("canonical module classifies identically (server/client lockstep)", () => {
    expect(classifySessionGenre("Fairyland Signature Session")).toBe("fairyland");
    expect(classifySessionGenre("Animalia Signature Session")).toBe("animalia");
    expect(classifySessionGenre("Portrait Session")).toBe("family");
    expect(classifyLeadGenre("fairyland")).toBe("fairyland");
    expect(classifyLeadGenre("animalia")).toBe("animalia");
    expect(classifyLeadGenre("family")).toBe("family");
  });
});

// ---- 2. three-way splits ----
describe("three-way splits — Fairyland never silently counts as Family", () => {
  test("splitWinsBySessionType separates all three genres", () => {
    const wins = [
      appt("w1", "Portrait Session"),
      appt("w2", "Animalia Pet Portrait"),
      appt("w3", "Fairyland Character Portrait"),
      appt("w4", "Fairyland Signature Session"),
      appt("w5", "Portrait Session"),
    ];
    expect(splitWinsBySessionType(wins)).toEqual({ family: 2, animalia: 1, fairyland: 2 });
  });

  test("splitLeadsByType separates all three genres and totals every row", () => {
    const leads = [
      lead("l1", "family"),
      lead("l2", "animalia"),
      lead("l3", "fairyland"),
      lead("l4", "Fairyland"), // case-insensitive
      lead("l5", "family"),
    ];
    expect(splitLeadsByType(leads)).toEqual({ family: 2, animalia: 1, fairyland: 2, auction_register_certificate: 0, google_ads_leads: 0, alliance_activate_certificate: 0, website_applications: 0, total: 5 });
  });

  test("splitLeadRows (trend split) covers fairyland; junk types still land in neither split", () => {
    const leads = [
      lead("l1", "family"),
      lead("l2", "fairyland"),
      lead("l3", "animalia"),
      lead("l4", ""),
    ];
    expect(splitLeadRows(leads)).toEqual({ family: 1, animalia: 1, fairyland: 1, auction_register_certificate: 0, google_ads_leads: 0, alliance_activate_certificate: 0, website_applications: 0 });
  });
});

// ---- 2b. sheet-identity fallback (owner directive 2026-10-27, item 4) ----
// The LIVE Fairyland sheet's Campaign Name column says "Fairies" on 100% of
// rows (verified 2026-10-27), which /fairyland/i never matches — production
// data. Sheet identity is the deterministic identifier; text stays first so
// a fairyland WORD on another sheet's row is still honored, and a fairy-ish
// TEXT on a family/animalia-sheet row can never re-bucket it.
describe("sheet-identity fallback — fairyland-sheet rows typed \"Fairies\" report as Fairyland", () => {
  test("splitLeadsByType: fairyland-sheet 'Fairies' rows are fairyland; family-sheet rows stay family", () => {
    const leads = [
      lead("f1", "Fairies", { source_sheet: "fairyland" }),
      lead("f2", "Fairies", { source_sheet: "fairyland" }),
      lead("f3", "Fairies", { source_sheet: "family" }), // family sheet: identity governs
      lead("f4", "family", { source_sheet: "family" }),
      lead("f5", "animalia", { source_sheet: "animalia" }),
    ];
    expect(splitLeadsByType(leads)).toEqual({ family: 2, animalia: 1, fairyland: 2, auction_register_certificate: 0, google_ads_leads: 0, alliance_activate_certificate: 0, website_applications: 0, total: 5 });
  });

  test("splitLeadRows (trend split) applies the same sheet-identity fallback", () => {
    const leads = [
      lead("f1", "Fairies", { source_sheet: "fairyland" }),
      lead("f2", "Fairies", { source_sheet: "family" }), // unrecognized text → NEITHER split (no family catch-all — never guessed)
      lead("f3", "fairyland", { source_sheet: "fairyland" }),
    ];
    expect(splitLeadRows(leads)).toEqual({ family: 0, animalia: 0, fairyland: 2, auction_register_certificate: 0, google_ads_leads: 0, alliance_activate_certificate: 0, website_applications: 0 });
  });

  test("leadsToday already fell back by sheet identity (PR #94) — 'Fairies' text included", () => {
    const summary = leadsToday([lead("f1", "Fairies", { source_sheet: "fairyland" }), lead("f2", "family", { source_sheet: "family" })], "2026-10-19");
    expect(summary.fairyland).toBe(1);
    expect(summary.family).toBe(1);
    expect(summary.total).toBe(2);
  });

  test("form-source rows are never genre votes even from a fairyland-named text", () => {
    const leads = [lead("g1", "Fairies", { source_sheet: "google_ads_leads" })];
    expect(splitLeadsByType(leads)).toEqual({ family: 0, animalia: 0, fairyland: 0, auction_register_certificate: 0, google_ads_leads: 1, alliance_activate_certificate: 0, website_applications: 0, total: 1 });
  });
});

// ---- 3. lead-count corrections ----
describe("fairyland lead-count corrections flow through the metrics functions", () => {
  test("a fairyland delta adjusts the fairyland count and total — never family/animalia", () => {
    const rows = [lead("l1", "family"), lead("l2", "fairyland"), lead("l3", "fairyland")];
    const adjustments: LeadCountAdjustment[] = [{ work_date: "2026-10-19", sheet: "fairyland", delta: -1 }];
    const summary = leadsToday(rows, "2026-10-19", adjustments);
    expect(summary.fairyland).toBe(1);
    expect(summary.family).toBe(1);
    expect(summary.animalia).toBe(0);
    expect(summary.total).toBe(2);
  });

  test("with NO fairyland sheet synced, counts read zero honestly — corrections for it simply don't exist", () => {
    const rows = [lead("l1", "family"), lead("l2", "animalia")];
    const summary = leadsToday(rows, "2026-10-19");
    expect(summary.fairyland).toBe(0);
    expect(summary.total).toBe(2);
    // an adjustment naming the unconfigured sheet cannot even arise from
    // Settings (the editor observes configured sheets only) — and an unknown
    // sheet label in a stored adjustment is skipped, never folded into family.
    const stray: LeadCountAdjustment[] = [{ work_date: "2026-10-19", sheet: "fairies", delta: 5 }];
    const after = leadsToday(rows, "2026-10-19", stray);
    expect(after).toEqual({ family: 1, animalia: 1, fairyland: 0, auction_register_certificate: 0, google_ads_leads: 0, alliance_activate_certificate: 0, website_applications: 0, total: 2 });
  });
});

// ---- 4. assigned-by-day grid ----
describe("assigned-by-day grid — fairyland classification + CSV order", () => {
  const rosterReps = [{ id: "rep1", name: "Laura" }];
  const nameById = new Map([["rep1", "Laura"]]);

  test("fairyland leads land in the fairyland cell (not family)", () => {
    const grid = buildAssignedLeadsByDay({
      leads: [
        lead("l1", "fairyland", { assigned_rep_id: "rep1" }),
        lead("l2", "Fairyland", { assigned_rep_id: "rep1", work_date: "2026-10-20", source_date: "2026-10-20" }),
        lead("l3", "family", { assigned_rep_id: "rep1" }),
      ],
      opps: [],
      rosterReps,
      nameById,
      mon: "2026-10-19",
      sun: "2026-10-25",
    });
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0].total.fairyland).toBe(2);
    expect(grid.rows[0].total.family).toBe(1);
    expect(grid.weekTotal.fairyland).toBe(2);
  });

  test("ASSIGNED_GENRES appends Fairyland LAST and the CSV emits the genre label", () => {
    expect([...ASSIGNED_GENRES]).toEqual(["animalia", "family", "alliance", "auction", "fairyland"]);
    expect(ASSIGNED_GENRE_LABELS.fairyland).toBe("Fairyland");
    const grid = buildAssignedLeadsByDay({
      leads: [lead("l1", "fairyland", { assigned_rep_id: "rep1", work_date: "2026-10-21", source_date: "2026-10-21" })],
      opps: [],
      rosterReps,
      nameById,
      mon: "2026-10-19",
      sun: "2026-10-25",
    });
    const csv = assignedLeadsCsv(grid);
    expect(csv).toContain("Laura,2026-10-21 Wed,Fairyland,1");
    expect(csv).not.toContain("Family,1"); // fairyland lead never mislabeled
  });
});

// ---- 5. Today-page filter chips (net-new UI) ----
describe("today filter chips — All | Family | Animalia | Fairyland (display-layer only)", () => {
  test("genresForFilter returns all genres in canonical order on 'all'", () => {
    expect(genresForFilter("all")).toEqual(["family", "animalia", "fairyland"]);
  });

  test("genresForFilter narrows to exactly the selected genre", () => {
    expect(genresForFilter("fairyland")).toEqual(["fairyland"]);
    expect(genresForFilter("family")).toEqual(["family"]);
    expect(genresForFilter("animalia")).toEqual(["animalia"]);
  });

  test("chip option order is the owner's quoted order: All, Family, Animalia, Fairyland", () => {
    // The chips are built in index.tsx as All first, then GENRES — GENRES is
    // family-first, so the rendered order is exactly the owner's wording.
    const chipOrder = ["all", ...GENRES.map((g) => g)];
    expect(chipOrder).toEqual(["all", "family", "animalia", "fairyland"]);
  });

  test("GENRE_LABELS covers every genre (legend never renders an undefined label)", () => {
    for (const g of GENRES) expect(GENRE_LABELS[g]).toBeTruthy();
    expect(GENRE_LABELS.fairyland).toBe("Fairyland");
  });
});
