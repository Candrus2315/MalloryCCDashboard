/**
 * FORMS DATA WORKBOOK — FOUR INDEPENDENT LEAD SOURCES (owner directive
 * 2026-10-27). Pins the whole chain on the verified live data:
 *
 *  1. DATE PARSER: the certificates/website tabs write "Feb 1st 2026, 4:14 pm"
 *     (ordinal + clock time) — parsed to the ET calendar date; the Google Ads
 *     tab writes "10/7/2026" and Alliance "02/03/2026" (US M/D confirmed by a
 *     live scan of 696 slash-date cells: ZERO first components > 12).
 *  2. CONFIG: the four settings.sheets entries ship first-class (workbook id,
 *     exact tab names, row_per_lead, verified column letters), old settings
 *     rows merge up to them, and the merge loop covers all seven keys.
 *  3. PER-TAB PARSING with the REAL verified headers + sample rows: identity
 *     gs2#{sheet}#d{date}#{phone10|email}, lead_type from column F on the ads
 *     tab (sheet-label fallback elsewhere), work_date derivation, 35-day
 *     window skip.
 *  4. REPORTING: per-source counts for all seven sources; combined totals roll
 *     into the overall lead totals; genre counts NEVER absorb form-source rows
 *     (a Google Ads row whose Project Name says "Family" is a Google Ads lead,
 *     not a genre vote); cross-tab same-person counts in EACH source.
 *  5. SYNC: runSheetsSync stores per-source rows via the existing pipeline and
 *     a per-sheet Google API failure degrades the run without crashing it.
 *
 * Pure + MemoryStore only — no network, no live Google API.
 */
import { describe, expect, test } from "bun:test";
import { parseSheetDate, parseSheetRows, sheetLeadKey } from "../sync/sheets-mapping";
import { defaultSettings, mergeSheetsSettings, normalizeAppSettings, FORMS_WORKBOOK_ID, type AppSettings } from "../store/types";
import { splitLeadsByType } from "../metrics/weekly";
import { leadsToday, splitLeadRows, type LeadRow } from "../metrics/compute";
import { runSheetsSync } from "../sync/run";
import { MemoryStore } from "../store/memory";
import type { GoogleSheetsAdapter } from "../sync/adapters";
import type { NormalizedLead } from "../sync/sheets-mapping";

// ---------- verified live fixtures (lead's probe 10/27) ----------
const AUCTION_HEADER = ["First Name", "Last Name", "Phone", "Street Address", "City", "Postal Code", "State", "Email", "Certificate Number", "Address", "Timezone", "Submission Date", "URL"];
const ADS_HEADER = ["First Name", "Last Name", "Email", "Phone", "Date Entered ", "Project Name", "Source"];
const WEBSITE_HEADER = ["Full Name", "Phone", "Email", "Why do you want a portrait session?", "Who would be in the portrait?", "How did you find us?", "I agree to receive text messages and emails regarding this application.", "Timezone", "Submission Date", "URL"];

const certRow = (first: string, last: string, phone: string, email: string, date: string): string[] =>
  [first, last, phone, "62 Temple Street", "Springfield", "1105", "Massachusetts", email, "02-WFHP-0826", "62 Temple Street, Springfield,", "America/New_York (GMT-05:00)", date, "https://www.malloryportraits.c"];
const adsRow = (first: string, last: string, email: string, phone: string, date: string, project: string): string[] =>
  [first, last, email, phone, date, project, "Lead Intake Form"];
const webRow = (name: string, phone: string, email: string, date: string): string[] =>
  [name, phone, email, "My dog Tedy is wonderful", "Tedy", "Facebook", "I agree", "America/New_York (GMT-05:00)", date, "https://www.malloryportraits.c"];

// ---------- 1 — date parser (requirement 3) ----------
describe("parseSheetDate — form-workbook formats", () => {
  test("ordinal + clock time (Auction/Website tabs) → ET calendar date", () => {
    expect(parseSheetDate("Feb 1st 2026, 4:14 pm")).toBe("2026-02-01");
    expect(parseSheetDate("Jan 29th 2026, 3:05 pm")).toBe("2026-01-29");
    expect(parseSheetDate("Jan 31st 2026, 10:50 am")).toBe("2026-01-31");
    expect(parseSheetDate("Jan 31st 2026, 10:18 am")).toBe("2026-01-31");
  });
  test("ordinal without time still parses; time-only variants are ignored", () => {
    expect(parseSheetDate("Feb 1st 2026")).toBe("2026-02-01");
    expect(parseSheetDate("March 3rd 2026, 12:00 pm")).toBe("2026-03-03");
  });
  test("pre-extension formats are byte-identical (regression)", () => {
    expect(parseSheetDate("Sep 24, 2026")).toBe("2026-09-24");
    expect(parseSheetDate("24 Sep 2026")).toBe("2026-09-24");
    expect(parseSheetDate("10/7/2026")).toBe("2026-10-07");
    expect(parseSheetDate("02/03/2026")).toBe("2026-02-03"); // US M/D — live scan: no day-first evidence
    expect(parseSheetDate("02/02/2026 0:0")).toBe("2026-02-02");
    expect(parseSheetDate("19/10/2026 10:54")).toBe("2026-10-19"); // Fairyland day-first fallback
    expect(parseSheetDate("2026-10-22")).toBe("2026-10-22");
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate("not a date")).toBeNull();
  });
});

// ---------- 2 — config (requirements 1 + 6) ----------
describe("settings.sheets — four form-workbook sources ship first-class", () => {
  const cfg = () => normalizeAppSettings({}).sheets;

  test("defaults carry the workbook id, exact tab names, row_per_lead and verified columns", () => {
    const s = cfg();
    expect(s.auction_register_certificate).toEqual({
      sheet_id: FORMS_WORKBOOK_ID, mode: "row_per_lead",
      columns: { source_date: "L", name: "A", last_name: "B", phone: "C", email: "H" },
      tab_name: "Auction Register Certificate",
    });
    expect(s.google_ads_leads).toEqual({
      sheet_id: FORMS_WORKBOOK_ID, mode: "row_per_lead",
      columns: { source_date: "E", name: "A", last_name: "B", email: "C", phone: "D", lead_type: "F" },
      tab_name: "Google Ads Leads",
    });
    expect(s.alliance_activate_certificate).toEqual({
      sheet_id: FORMS_WORKBOOK_ID, mode: "row_per_lead",
      columns: { source_date: "L", name: "A", last_name: "B", phone: "C", email: "H" },
      tab_name: "Alliance Activate Certificate",
    });
    expect(s.website_applications).toEqual({
      sheet_id: FORMS_WORKBOOK_ID, mode: "row_per_lead",
      columns: { source_date: "I", name: "A", phone: "B", email: "C" },
      tab_name: "Website Applications",
    });
  });

  test("genre-sheet defaults are untouched", () => {
    const s = cfg();
    expect(s.family.sheet_id).toBe("1_5d1TDrOLg_E3RICEY6M7K9wnM97M9wkHLUN-C0oIvg");
    expect(s.animalia.sheet_id).toBe("1Zp_ghywl-u4e13NHMoPRubZ9DCZC-Khv1ePL6PVahZU");
    expect(s.fairyland.sheet_id).toBe("");
    expect(s.family.mode).toBe("row_per_day_count");
    expect(s.animalia.mode).toBe("row_per_day_count");
    expect(s.fairyland.mode).toBe("row_per_day_count");
  });

  test("settings saved before 10/27 merge up to the four configured defaults", () => {
    const old = { family: { sheet_id: "fam", mode: "row_per_day_count", columns: { source_date: "Q", count: "B", lead_type: "C" } } };
    const s = normalizeAppSettings({ sheets: old }).sheets;
    expect(s.family.sheet_id).toBe("fam");
    expect(s.auction_register_certificate.tab_name).toBe("Auction Register Certificate");
    expect(s.google_ads_leads.columns.lead_type).toBe("F");
  });

  test("mergeSheetsSettings persists a saved mapping for a form source without clobbering mode", () => {
    const base = defaultSettings();
    const { sheets } = mergeSheetsSettings(base.sheets, {
      website_applications: { ...base.sheets.website_applications, columns: { source_date: "I", name: "A", phone: "B", email: "C" }, mode: "row_per_lead" },
    }, false);
    expect(sheets.website_applications.columns.source_date).toBe("I");
    expect(sheets.website_applications.mode).toBe("row_per_lead");
    expect(sheets.family.sheet_id).toBe(base.sheets.family.sheet_id);
  });
});

// ---------- 3 — per-tab parsing (requirements 1 + 2 + 7) ----------
describe("parseSheetRows — the four tabs through the EXISTING pipeline", () => {
  const WINDOW = "2026-09-22";
  test("auction_register_certificate: identity, name join, ordinal date", () => {
    const res = parseSheetRows({
      sheet: "auction_register_certificate", sheetId: FORMS_WORKBOOK_ID, windowStart: WINDOW,
      mapping: { mode: "row_per_lead", columns: { source_date: "L", name: "A", last_name: "B", phone: "C", email: "H" } },
      rows: [AUCTION_HEADER, certRow("Caroline", "Merck", "18453009833", "merckc@gmail.com", "Oct 1st 2026, 4:14 pm"), certRow("Old", "Row", "15550001111", "old@x.io", "Feb 1st 2025, 4:14 pm"), AUCTION_HEADER.map(() => "")],
    });
    expect(res.leads).toHaveLength(1);
    const l = res.leads[0]!;
    expect(l.source_id).toBe(sheetLeadKey("auction_register_certificate", "2026-10-01", "18453009833", "merckc@gmail.com"));
    expect(l.source_id).toBe("gs2#auction_register_certificate#d2026-10-01#p8453009833"); // last 10 digits
    expect(l.name).toBe("Caroline Merck");
    expect(l.leadType).toBe("auction_register_certificate"); // no lead_type column → sheet key
    expect(l.sourceDate).toBe("2026-10-01");
    expect(l.sourceRawDate).toBe("Oct 1st 2026, 4:14 pm");
    expect(l.sheet).toBe("auction_register_certificate");
    expect(res.stats.skippedOld).toBe(1);
    expect(res.stats.skippedEmpty).toBe(1);
  });

  test("google_ads_leads: lead_type from column F (Project Name), M/D/YYYY dates", () => {
    const res = parseSheetRows({
      sheet: "google_ads_leads", sheetId: FORMS_WORKBOOK_ID, windowStart: WINDOW,
      mapping: { mode: "row_per_lead", columns: { source_date: "E", name: "A", last_name: "B", email: "C", phone: "D", lead_type: "F" } },
      rows: [ADS_HEADER, adsRow("AJ", "Amatrudo", "aj.amatrudo@outlook.com", "(207) 929-0863", "10/7/2026", "Family"), adsRow("Patricia", "Payson", "patriciapayson@gmail.com", "(603) 475-5220", "10/9/2026", "Pet")],
    });
    expect(res.leads).toHaveLength(2);
    expect(res.leads[0]!.leadType).toBe("Family");
    expect(res.leads[1]!.leadType).toBe("Pet");
    expect(res.leads[0]!.sourceDate).toBe("2026-10-07");
    expect(res.leads[0]!.source_id).toBe(sheetLeadKey("google_ads_leads", "2026-10-07", "(207) 929-0863", "aj.amatrudo@outlook.com"));
  });

  test("alliance_activate_certificate: 10/03/2026 reads US M/D (Oct 3; the parseSheetDate suite pins 02/03 → Feb 3)", () => {
    const res = parseSheetRows({
      sheet: "alliance_activate_certificate", sheetId: FORMS_WORKBOOK_ID, windowStart: WINDOW,
      mapping: { mode: "row_per_lead", columns: { source_date: "L", name: "A", last_name: "B", phone: "C", email: "H" } },
      rows: [AUCTION_HEADER, certRow("Tim", "Devlin", "(857) 407-8001", "tdevlinbla@gmail.com", "10/03/2026")],
    });
    expect(res.leads[0]!.sourceDate).toBe("2026-10-03");
    expect(res.leads[0]!.source_id.startsWith("gs2#alliance_activate_certificate#d2026-10-03#p8574078001")).toBe(true);
  });

  test("website_applications: full name in A, date I", () => {
    const res = parseSheetRows({
      sheet: "website_applications", sheetId: FORMS_WORKBOOK_ID, windowStart: WINDOW,
      mapping: { mode: "row_per_lead", columns: { source_date: "I", name: "A", phone: "B", email: "C" } },
      rows: [WEBSITE_HEADER, webRow("Nancy Duffy", "16035463146", "nancycc1780@gmail.com", "Oct 18th 2026, 10:50 am")],
    });
    expect(res.leads).toHaveLength(1);
    expect(res.leads[0]!.name).toBe("Nancy Duffy");
    expect(res.leads[0]!.leadType).toBe("website_applications");
    expect(res.leads[0]!.sourceDate).toBe("2026-10-18");
  });

  test("duplicate rows within ONE tab collapse to one identity + #2 suffix (kept, counted)", () => {
    const res = parseSheetRows({
      sheet: "google_ads_leads", sheetId: FORMS_WORKBOOK_ID, windowStart: WINDOW,
      mapping: { mode: "row_per_lead", columns: { source_date: "E", name: "A", last_name: "B", email: "C", phone: "D", lead_type: "F" } },
      rows: [ADS_HEADER, adsRow("Dupe", "One", "dupe@x.io", "6177756768", "10/12/2026", "Pet"), adsRow("Dupe", "One", "dupe@x.io", "6177756768", "10/12/2026", "Pet")],
    });
    expect(res.leads).toHaveLength(2);
    expect(res.leads[0]!.source_id).toBe(res.leads[1]!.source_id.replace(/#2$/, ""));
    expect(res.stats.collisions).toBe(1);
  });
});

// ---------- 4 — reporting: seven sources, combined totals, genre purity ----------
const lead = (source_sheet: string, lead_type: string, sourceDate: string, workDate: string, phone: string | null = null): LeadRow => ({
  id: `gs2#${source_sheet}#d${sourceDate}#${phone ?? "c"}`,
  lead_type,
  source_date: sourceDate,
  work_date: workDate,
  contact_id: null,
  assigned_rep_id: null,
  source_sheet,
});

describe("reporting — per-source counts for all seven sources", () => {
  test("splitLeadsByType: ads 'Family' text is NOT a genre vote; cross-tab same person counts in each source", () => {
    const rows: LeadRow[] = [
      lead("family", "family", "2026-10-20", "2026-10-20"),
      lead("animalia", "animalia", "2026-10-20", "2026-10-20"),
      lead("fairyland", "Fairyland Campaign", "2026-10-20", "2026-10-20"),
      lead("auction_register_certificate", "auction_register_certificate", "2026-10-20", "2026-10-20"),
      lead("google_ads_leads", "Family", "2026-10-20", "2026-10-20"), // Project Name "Family"
      lead("google_ads_leads", "Pet", "2026-10-21", "2026-10-21"),
      lead("alliance_activate_certificate", "alliance_activate_certificate", "2026-10-21", "2026-10-21"),
      lead("website_applications", "website_applications", "2026-10-21", "2026-10-21"),
    ];
    const split = splitLeadsByType(rows);
    expect(split.family).toBe(1);
    expect(split.animalia).toBe(1);
    expect(split.fairyland).toBe(1);
    expect(split.auction_register_certificate).toBe(1);
    expect(split.google_ads_leads).toBe(2);
    expect(split.alliance_activate_certificate).toBe(1);
    expect(split.website_applications).toBe(1);
    expect(split.total).toBe(8);
    const splitRows = splitLeadRows(rows);
    expect(splitRows.google_ads_leads).toBe(2);
    expect(splitRows.family).toBe(1);
  });

  test("cross-tab same person (same phone, two tabs, same date) counts in EACH source", () => {
    const rows: LeadRow[] = [
      lead("auction_register_certificate", "auction_register_certificate", "2026-10-20", "2026-10-20", "5552018842"),
      lead("alliance_activate_certificate", "alliance_activate_certificate", "2026-10-20", "2026-10-20", "5552018842"),
    ];
    const split = splitLeadsByType(rows);
    expect(split.auction_register_certificate).toBe(1);
    expect(split.alliance_activate_certificate).toBe(1);
    expect(split.total).toBe(2);
  });

  test("leadsToday: combined total rolls in; family stays genre-only", () => {
    const rows: LeadRow[] = [
      lead("family", "family", "2026-10-20", "2026-10-27"),
      lead("animalia", "animalia", "2026-10-20", "2026-10-27"),
      lead("fairyland", "Fairyland", "2026-10-20", "2026-10-27"),
      lead("website_applications", "website_applications", "2026-10-20", "2026-10-27"),
      lead("google_ads_leads", "Family", "2026-10-20", "2026-10-27"),
    ];
    const today = leadsToday(rows, "2026-10-27");
    expect(today.family).toBe(1);
    expect(today.animalia).toBe(1);
    expect(today.fairyland).toBe(1);
    expect(today.google_ads_leads).toBe(1);
    expect(today.website_applications).toBe(1);
    expect(today.auction_register_certificate).toBe(0);
    expect(today.alliance_activate_certificate).toBe(0);
    expect(today.total).toBe(5);
  });

  test("acceptance: Oct 19–25 source-dated week reads all four form tabs + genres, per source + combined", () => {
    const rows: LeadRow[] = [
      ...["2026-10-20", "2026-10-22", "2026-10-24"].map((d) => lead("family", "family", d, d)),
      lead("auction_register_certificate", "auction_register_certificate", "2026-10-21", "2026-10-21"),
      lead("google_ads_leads", "Pet", "2026-10-21", "2026-10-21"),
      lead("google_ads_leads", "Family", "2026-10-23", "2026-10-23"),
      lead("alliance_activate_certificate", "alliance_activate_certificate", "2026-10-25", "2026-10-25"),
      lead("website_applications", "website_applications", "2026-10-19", "2026-10-19"),
      lead("family", "family", "2026-10-18", "2026-10-18"), // outside the week — excluded
    ];
    const week = rows.filter((l) => l.source_date >= "2026-10-19" && l.source_date <= "2026-10-25");
    const split = splitLeadsByType(week);
    expect(split.family).toBe(3);
    expect(split.auction_register_certificate).toBe(1);
    expect(split.google_ads_leads).toBe(2);
    expect(split.alliance_activate_certificate).toBe(1);
    expect(split.website_applications).toBe(1);
    expect(split.total).toBe(8);
  });
});

// ---------- 5 — sync through the EXISTING pipeline (requirement 8) ----------
describe("runSheetsSync — four new sources via the existing store path", () => {
  test("stores per-source rows, keeps genre rows byte-stable, survives a per-sheet Google failure", async () => {
    // MemoryStore ONLY — never getStore(): with Database_URL set in the shell
    // env, getStore() resolves the production Postgres and the test would
    // write real rows there.
    const store = new MemoryStore();
    const settings: AppSettings = defaultSettings();
    const norm = (l: Partial<NormalizedLead> & { sheet: string; sourceDate: string }): NormalizedLead => ({
      source_id: sheetLeadKey(l.sheet, l.sourceDate, l.phone ?? null, l.email ?? null),
      leadType: l.leadType ?? l.sheet,
      sourceDate: l.sourceDate,
      workDate: l.workDate ?? l.sourceDate,
      sourceRawDate: l.sourceRawDate ?? null,
      name: l.name ?? null,
      phone: l.phone ?? null,
      email: l.email ?? null,
      sheet: l.sheet,
    });
    const okLeads: NormalizedLead[] = [
      norm({ sheet: "family", sourceDate: "2026-10-20", leadType: "family", phone: "9175550001", name: "Genre Row" }),
      norm({ sheet: "auction_register_certificate", sourceDate: "2026-10-20", phone: "18453009833", email: "merckc@gmail.com", name: "Caroline Merck", sourceRawDate: "Feb 1st 2026, 4:14 pm" }),
      norm({ sheet: "google_ads_leads", sourceDate: "2026-10-20", phone: "2079290863", email: "aj@x.io", name: "AJ Amatrudo", leadType: "Family" }),
      norm({ sheet: "alliance_activate_certificate", sourceDate: "2026-10-20", phone: "8574078001", email: "tim@x.io", name: "Tim Devlin" }),
      norm({ sheet: "website_applications", sourceDate: "2026-10-20", phone: "16035463146", email: "nancy@x.io", name: "Nancy Duffy" }),
    ];
    const adapter: GoogleSheetsAdapter = {
      provider: "google_sheets",
      isDemo: false,
      fetchLeads: async () => okLeads,
    };
    const res = await runSheetsSync(store, settings, adapter, { nowIso: "2026-10-27T15:00:00.000Z" });
    expect(res.error).toBeUndefined();
    expect(res.live).toBe(true);
    expect(res.count).toBe(5);
    const stored = await store.getLeadsByProvider("google_sheets");
    const bySheet = new Map<string, number>();
    for (const l of stored) bySheet.set(l.source_sheet, (bySheet.get(l.source_sheet) ?? 0) + 1);
    expect(bySheet.get("family")).toBeGreaterThanOrEqual(1);
    expect(bySheet.get("auction_register_certificate")).toBe(1);
    expect(bySheet.get("google_ads_leads")).toBe(1);
    expect(bySheet.get("alliance_activate_certificate")).toBe(1);
    expect(bySheet.get("website_applications")).toBe(1);
    // identity carries the sheet segment
    const caroline = stored.find((l) => l.source_sheet === "auction_register_certificate")!;
    expect(caroline.source_id).toBe("gs2#auction_register_certificate#d2026-10-20#p8453009833");
    // re-run: idempotent (same content keys, no duplicates)
    const after1 = (await store.getLeadsByProvider("google_sheets")).filter((l) => l.source_sheet === "auction_register_certificate").length;
    await runSheetsSync(store, settings, adapter, { nowIso: "2026-10-27T15:05:00.000Z" });
    const after2 = (await store.getLeadsByProvider("google_sheets")).filter((l) => l.source_sheet === "auction_register_certificate").length;
    expect(after2).toBe(after1);

    // PER-SHEET FAILURE: ads tab fails (SheetsError-class message), the rest still store.
    class FailingAdsAdapter implements GoogleSheetsAdapter {
      provider = "google_sheets" as const;
      isDemo = false;
      lastRun = {
        perSheet: [
          { sheet: "family", sheetId: "fam", mode: "row_per_day_count" as const, totalRows: 1, dataRows: 1, usedRows: 1, leads: 1, skippedOld: 0, skippedBad: 0, skippedEmpty: 0, collisions: 0, windowStart: "2026-09-22", ok: true, error: null, tab: "Fam", header: [] },
          { sheet: "google_ads_leads", sheetId: FORMS_WORKBOOK_ID, mode: "row_per_lead" as const, totalRows: 0, dataRows: 0, usedRows: 0, leads: 0, skippedOld: 0, skippedBad: 0, skippedEmpty: 0, collisions: 0, windowStart: "2026-09-22", ok: false, error: "Google Sheets denied access (403) — share the workbook with the service account (role: Viewer).", tab: null, header: null },
        ],
        warnings: [],
        suggestions: [],
        windowStart: "2026-09-22",
      };
      async fetchLeads(): Promise<NormalizedLead[]> {
        return [norm({ sheet: "family", sourceDate: "2026-10-21", leadType: "family", phone: "9175550002", name: "Still Works" })];
      }
    }
    const partial = await runSheetsSync(store, settings, new FailingAdsAdapter(), { nowIso: "2026-10-27T15:10:00.000Z" });
    expect(partial.live).toBe(true); // the run itself did not crash
    expect(partial.error).toContain("google_ads_leads"); // per-sheet error recorded
    const famCount = (await store.getLeadsByProvider("google_sheets")).filter((l) => l.source_sheet === "family" && l.phone === "9175550002").length;
    expect(famCount).toBe(1); // healthy sheets still stored through the failure
  });
});
