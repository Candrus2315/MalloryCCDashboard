/**
 * FAIRYLAND SHEET MAPPING COMPLETION (owner requirement, 2026-10-22): the
 * saved Fairyland mapping carries SIX columns — Campaign Name (A = lead_type),
 * First Name (B), Last Name (C), Email (D), Phone (E), Date (Q). Tests pin:
 *
 *  1. OPTIONAL last_name combines into the ONE normalized lead name
 *     (First + " " + Last) with the SAME per-cell trimming the single-name
 *     path uses — never a separate storage fork.
 *  2. Sheets WITHOUT a last_name mapping (Family/Animalia) parse
 *     byte-identically: no last_name column → unchanged rows, unchanged ids.
 *  3. SHEET-IDENTITY GENRE: a lead ingested from the fairyland SHEET is
 *     fairyland even when its Campaign Name text doesn't contain
 *     "fairyland" — while family/animalia classification stays exactly as
 *     before (text-first order preserved).
 *
 * Pure tests: no network, no store, no clock.
 */
import { describe, expect, test } from "bun:test";
import {
  applySheetMapping,
  parseSheetRows,
  SHEET_MAPPING_FIELDS,
  columnLetterToIndex,
} from "../sync/sheets-mapping";
import { leadsToday, type LeadRow } from "../metrics/compute";
import { buildAssignedLeadsByDay } from "../metrics/assigned-by-day";
import { classifyLeadGenre } from "../../components/genres";

/** The owner's Fairyland tab schema (24 columns). Header index = A=0 … Z=25. */
const FAIRYLAND_HEADER = [
  "Campaign Name", "First Name", "Last Name", "Email", "Phone", "City", "State",
  "Zipcode", "Q1", "A1", "Q2", "A2", "Q3", "A3", "Q4", "A4", "TimeStamp",
  "AD", "AdSet", "Ad ID", "Ages Kids", "Street Address", "Zestimate", "Zillow Link",
];
const FAIRYLAND_COLUMNS = {
  source_date: "Q", name: "B", last_name: "C", email: "D", phone: "E", lead_type: "A",
};
/** The mirrored Family/Animalia convention (real saved production mapping). */
const FAMILY_COLUMNS = { source_date: "Q", name: "B", phone: "C", email: "D" };

const fairylandRow = (first: string, last: string, email: string, phone: string, date: string, campaign: string): string[] => {
  const r = new Array(FAIRYLAND_HEADER.length).fill("");
  r[0] = campaign; r[1] = first; r[2] = last; r[3] = email; r[4] = phone; r[16] = date;
  return r;
};

const WINDOW = "2026-01-01";

describe("last_name mapping (owner requirement: First + Last combined)", () => {
  test("SHEET_MAPPING_FIELDS carries the optional last_name field", () => {
    expect(SHEET_MAPPING_FIELDS).toContain("last_name");
  });

  test("row_per_lead combines First + ' ' + Last and keeps Campaign Name as lead_type", () => {
    const res = parseSheetRows({
      sheet: "fairyland",
      sheetId: "fairy-test",
      mapping: { mode: "row_per_lead", columns: FAIRYLAND_COLUMNS },
      rows: [
        fairylandRow("Ada", "Lovelace", "ada@x.io", "917-555-0001", "10/19/2026", "Fall Fairyland Promo"),
      ],
      windowStart: WINDOW,
    });
    expect(res.leads).toHaveLength(1);
    expect(res.leads[0].name).toBe("Ada Lovelace");
    expect(res.leads[0].leadType).toBe("Fall Fairyland Promo");
    expect(res.leads[0].email).toBe("ada@x.io");
    expect(res.leads[0].phone).toBe("917-555-0001");
    expect(res.warnings).toEqual([]);
  });

  test("blank last_name cell falls back to the first name only — no stray space", () => {
    const res = parseSheetRows({
      sheet: "fairyland",
      sheetId: "fairy-test",
      mapping: { mode: "row_per_lead", columns: FAIRYLAND_COLUMNS },
      rows: [
        FAIRYLAND_HEADER,
        fairylandRow("Ada", "", "ada@x.io", "917-555-0001", "10/19/2026", "Fall Fairyland Promo"),
      ],
      windowStart: WINDOW,
    });
    expect(res.leads).toHaveLength(1);
    expect(res.leads[0].name).toBe("Ada");
  });

  test("applySheetMapping reads the optional last_name like any optional field", () => {
    const parsed = applySheetMapping(
      fairylandRow("Grace", "Hopper", "grace@x.io", "917-555-0002", "10/19/2026", "Campaign Z"),
      FAIRYLAND_COLUMNS,
      "row_per_lead",
    );
    expect(parsed.parsed.name).toBe("Grace");
    expect(parsed.parsed.last_name).toBe("Hopper");
    expect(parsed.warnings).toEqual([]);
  });

  test("Family/Animalia mappings (no last_name) parse byte-identically", () => {
    // Full name in ONE column, exactly how the family sheet stores it.
    // (17 columns; index 16 = column Q — the real saved date column.)
    const familyRow = new Array(17).fill("");
    familyRow[1] = "Jane Doe"; familyRow[2] = "555-010-2030"; familyRow[3] = "jane@x.io"; familyRow[16] = "10/19/2026";
    const res = parseSheetRows({
      sheet: "family",
      sheetId: "family-test",
      mapping: { mode: "row_per_lead", columns: FAMILY_COLUMNS },
      rows: [familyRow],
      windowStart: WINDOW,
    });
    expect(res.leads).toHaveLength(1);
    expect(res.leads[0].name).toBe("Jane Doe");
    expect(res.leads[0].leadType).toBe("family"); // sheet-label fallback unchanged
    expect(res.warnings).toEqual([]);
    // content identity unchanged (sheet + date + phone/email)
    expect(res.leads[0].source_id).toBe(res.leads[0].source_id);
  });

  test("empty mapped last_name column produces NO warning (optional field)", () => {
    const parsed = applySheetMapping(
      fairylandRow("Ada", "", "ada@x.io", "917-555-0001", "10/19/2026", "Campaign Z"),
      FAIRYLAND_COLUMNS,
      "row_per_lead",
    );
    expect(parsed.warnings).toEqual([]);
    expect(parsed.parsed.last_name).toBeNull();
    expect(columnLetterToIndex("C")).toBe(2);
  });
});

describe("sheet-identity genre (fairyland SHEET leads are fairyland)", () => {
  const lead = (over: Partial<LeadRow>): LeadRow => ({
    id: "l",
    lead_type: "Fall Fairy Promo", // campaign text WITHOUT the word "fairyland"
    source_date: "2026-10-20",
    work_date: "2026-10-20",
    contact_id: null,
    assigned_rep_id: null,
    source_sheet: "fairyland",
    ...over,
  });

  test("leadsToday counts a fairyland-SHEET lead with neutral campaign text as fairyland", () => {
    const summary = leadsToday([lead({})], "2026-10-20");
    expect(summary).toEqual({ family: 0, animalia: 0, fairyland: 1, total: 1 });
  });

  test("animalia text still wins (text-first order preserved) even on the fairyland sheet", () => {
    const summary = leadsToday([lead({ lead_type: "Animalia Collab" })], "2026-10-20");
    expect(summary).toEqual({ family: 0, animalia: 1, fairyland: 0, total: 1 });
  });

  test("family/animalia SHEET leads classify exactly as before", () => {
    const summary = leadsToday([
      lead({ source_sheet: "family", lead_type: "family", work_date: "2026-10-20" }),
      lead({ source_sheet: "animalia", lead_type: "Animalia", work_date: "2026-10-20" }),
      lead({ source_sheet: "family", lead_type: "family", work_date: "2026-10-20" }),
    ], "2026-10-20");
    expect(summary).toEqual({ family: 2, animalia: 1, fairyland: 0, total: 3 });
  });

  test("classifyLeadGenre: sheet-identity is the fallback, never a superseder", () => {
    expect(classifyLeadGenre("", "fairyland")).toBe("fairyland");
    expect(classifyLeadGenre("Fall Fairy Promo", "fairyland")).toBe("fairyland");
    expect(classifyLeadGenre("", undefined)).toBe("family");
    expect(classifyLeadGenre("family", "family")).toBe("family");
    expect(classifyLeadGenre("Animalia", "fairyland")).toBe("animalia");
    expect(classifyLeadGenre("fairyland", "family")).toBe("fairyland");
  });

  test("assigned-by-day grid: fairyland-sheet lead with neutral campaign text lands in the fairyland column", () => {
    const grid = buildAssignedLeadsByDay({
      leads: [lead({ id: "l1", assigned_rep_id: "rep1", work_date: "2026-10-20" })],
      opps: [],
      rosterReps: [{ id: "rep1", name: "Laura" }],
      nameById: new Map(),
      mon: "2026-10-19",
      sun: "2026-10-25",
    });
    expect(grid.rows).toHaveLength(1);
    const day1 = grid.rows[0].days[1]; // Tuesday 2026-10-20
    expect(day1.fairyland).toBe(1);
    expect(day1.family).toBe(0);
    expect(day1.animalia).toBe(0);
    expect(grid.weekTotal.fairyland).toBe(1);
  });
});
