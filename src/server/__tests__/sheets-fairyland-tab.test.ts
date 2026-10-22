/**
 * FAIRYLAND WIRING (owner directive 2026-10-22): the third-genre sheet is
 * configured — spreadsheet `1dT_7KABCOuv3L4kEJiyxlMyEsxLl42snaJPxzlXVO3U`,
 * tab "2026 fairies" (NOT the first tab), row_per_lead, the SAME mapping
 * convention as Family/Animalia (name→B, email→D, phone→E, source_date→Q).
 *
 * These tests pin the ONE small code addition that made it possible — an
 * optional `tab_name` on SheetConfig that targets a NAMED tab — and prove the
 * Family/Animalia behavior stayed byte-identical (no tab name configured →
 * first tab, exactly as before). NO live Google calls: every test injects a
 * stub fetch impl.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { MemoryStore } from "../store/memory";
import {
  fetchSheetRows,
  LiveSheetsAdapter,
  type SheetsHttp,
  type SheetsLiveRunReport,
} from "../sync/sheets-live";
import { getWorkDate } from "../date-logic";
import { parseSheetRows } from "../sync/sheets-mapping";
import type { TimedFetchImpl } from "../sync/fetch-timeout";
import { mergeSheetsSettings, type SheetConfig } from "../store/types";

const FAIRYLAND_ID = "1dT_7KABCOuv3L4kEJiyxlMyEsxLl42snaJPxzlXVO3U";
const FAIRYLAND_TAB = "2026 fairies";
/** The owner's Fairyland tab schema (24 columns). Only Q/B/D/E are mapped. */
const FAIRYLAND_HEADER = [
  "Campaign Name", "First Name", "Last Name", "Email", "Phone", "City", "State",
  "Zipcode", "Q1", "A1", "Q2", "A2", "Q3", "A3", "Q4", "A4", "TimeStamp",
  "AD", "AdSet", "Ad ID", "Ages Kids", "Street Address", "Zestimate", "Zillow Link",
];
/** The mirrored Family/Animalia convention (real saved production mapping). */
const ROW_PER_LEAD_COLUMNS = { source_date: "Q", name: "B", phone: "E", email: "D" };

// A REAL RSA keypair (generated once): the adapter actually signs the JWT with
// this key before the stubbed token endpoint answers — a fake PEM would throw.
const { privateKey: REAL_RSA_PEM } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  // Google's service-account JSON schema — readServiceAccount parses these keys.
  client_email: "sa@test.invalid",
  project_id: "p",
  private_key: REAL_RSA_PEM.export({ type: "pkcs8", format: "pem" }).toString(),
};

interface RecordedCall { url: string; method: string }

/**
 * Stub Sheets HTTP: answers the OAuth token call, the first-tab metadata call
 * (with `firstTabTitle`), and values.get per tab (with `tabResponses` keyed by
 * tab title). Records every non-token URL so tests can assert WHICH range was
 * fetched.
 */
function makeSheetsHttp(firstTabTitle: string, tabResponses: Record<string, string[][]>): { http: SheetsHttp; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: TimedFetchImpl = ((_url: string | URL | Request, init?: { method?: string }) => {
    const url = String(_url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 }));
    }
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("fields=properties.title")) {
      return Promise.resolve(new Response(JSON.stringify({ sheets: [{ properties: { title: firstTabTitle } }] }), { status: 200 }));
    }
    const range = decodeURIComponent(url.split("/values/")[1]?.split("?")[0] ?? "");
    const tab = range.replace(/!A1:ZZ$/, "");
    return Promise.resolve(new Response(JSON.stringify({ values: tabResponses[tab] ?? [] }), { status: 200 }));
  }) as unknown as TimedFetchImpl;
  return { http: { fetchImpl, timeoutMs: 5_000 }, calls };
}

function valuesUrls(calls: RecordedCall[]): string[] {
  return calls.filter((c) => c.url.includes("/values/")).map((c) => decodeURIComponent(c.url.split("/values/")[1].split("?")[0]));
}
function metadataCallCount(calls: RecordedCall[]): number {
  return calls.filter((c) => c.url.includes("fields=properties.title")).length;
}

// ---------- fetchSheetRows: the named-tab targeting ----------
describe("fetchSheetRows optional tab targeting", () => {
  test("tabName set → fetches THAT tab, skipping the first-tab metadata roundtrip", async () => {
    const { http, calls } = makeSheetsHttp("Cover", {
      [FAIRYLAND_TAB]: [FAIRYLAND_HEADER, ["Fairy Mini", "Willow", "Fern", "willow@example.com", "(555) 201-0001", "", "", "", "", "", "", "", "", "", "", "", "10/21/2026 13:45"]],
    });
    const res = await fetchSheetRows("tok", FAIRYLAND_ID, SA, http, FAIRYLAND_TAB);
    expect(res.tab).toBe(FAIRYLAND_TAB);
    expect(res.rows[0]).toEqual(FAIRYLAND_HEADER);
    expect(valuesUrls(calls)).toEqual([`${FAIRYLAND_TAB}!A1:ZZ`]); // the named tab ONLY
    expect(metadataCallCount(calls)).toBe(0); // first-tab lookup never ran
  });

  test("NO tabName → first-tab behavior byte-identical (metadata call, first tab's range)", async () => {
    const { http, calls } = makeSheetsHttp("Leads", { Leads: [["Date", "Count"], ["10/20/2026", "3"]] });
    const res = await fetchSheetRows("tok", "sheet-x", SA, http);
    expect(res.tab).toBe("Leads");
    expect(res.rows).toEqual([["Date", "Count"], ["10/20/2026", "3"]]);
    expect(metadataCallCount(calls)).toBe(1);
    expect(valuesUrls(calls)).toEqual(["Leads!A1:ZZ"]);
  });

  test("whitespace-only tabName falls back to first tab (normalize-then-target)", async () => {
    const { http, calls } = makeSheetsHttp("First Tab", { "First Tab": [["h"]] });
    const res = await fetchSheetRows("tok", "sheet-x", SA, http, "   ");
    expect(res.tab).toBe("First Tab");
    expect(metadataCallCount(calls)).toBe(1);
    expect(valuesUrls(calls)).toEqual(["First Tab!A1:ZZ"]);
  });
});

// ---------- LiveSheetsAdapter: config → the same pipeline ----------
describe("LiveSheetsAdapter threads tab_name through fetchLeads", () => {
  const savedEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  beforeEach(() => {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(SA);
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else process.env.GOOGLE_SERVICE_ACCOUNT_JSON = savedEnv;
  });

  function cfg(): { family: SheetConfig; animalia: SheetConfig; fairyland: SheetConfig } {
    return {
      family: { sheet_id: "fam-id", mode: "row_per_lead", columns: { ...ROW_PER_LEAD_COLUMNS } },
      animalia: { sheet_id: "ani-id", mode: "row_per_lead", columns: { ...ROW_PER_LEAD_COLUMNS } },
      fairyland: {
        sheet_id: FAIRYLAND_ID,
        mode: "row_per_lead",
        columns: { ...ROW_PER_LEAD_COLUMNS },
        tab_name: FAIRYLAND_TAB,
      },
    };
  }
  const fairyRows = [
    FAIRYLAND_HEADER,
    ["Fairy Mini", "Willow", "Fern", "willow@example.com", "(555) 201-0001", "", "", "", "", "", "", "", "", "", "", "", "10/21/2026 13:45"],
    ["Fairy Signature", "Juniper", "Moss", "", "(555) 201-0002", "", "", "", "", "", "", "", "", "", "", "", "10/21/2026 14:02"],
  ];
  /** A 17-col row in the SAME row_per_lead shape family/animalia sheets carry (Q=date, B=name, D=email, E=phone). */
  const leadRow = (name: string, email: string, phone: string, ts: string) =>
    ["", name, "", email, phone, "", "", "", "", "", "", "", "", "", "", "", ts];
  const firstTabRows = (label: string) => [
    ["", "First", "", "Email", "Phone", "", "", "", "", "", "", "", "", "", "", "", "TimeStamp"],
    leadRow(`${label} A`, "", "(555) 100-0001", "10/20/2026 09:00"),
    leadRow(`${label} B`, `${label.toLowerCase()}b@example.com`, "", "10/20/2026 10:00"),
  ];

  test("fairyland values come from the NAMED tab; family/animalia still hit their first tabs", async () => {
    const { http, calls } = makeSheetsHttp("Sheet1", {
      [FAIRYLAND_TAB]: fairyRows,
      Sheet1: firstTabRows("fam"),
    });
    const adapter = new LiveSheetsAdapter(cfg(), 35, http);
    const leads = await adapter.fetchLeads();
    const report: SheetsLiveRunReport | null = adapter.lastRun;
    // Named tab was targeted for fairyland ONLY:
    const ranges = valuesUrls(calls);
    expect(ranges.filter((r) => r === `${FAIRYLAND_TAB}!A1:ZZ`).length).toBe(1);
    // family + animalia fetched their FIRST tab by title (metadata lookups ran
    // for them, never for fairyland):
    expect(metadataCallCount(calls)).toBe(2);
    expect(ranges.filter((r) => r.startsWith("Sheet1!")).length).toBe(2);
    // Parse results: the two fairyland lead rows ingested, correctly labeled.
    expect(report?.perSheet.find((p) => p.sheet === "fairyland")).toMatchObject({ ok: true, leads: 2, tab: FAIRYLAND_TAB });
    expect(leads.filter((l) => l.sheet === "fairyland").length).toBe(2);
    // Family/animalia parsed from their first tabs (day-count rows expand to 2 leads each).
    expect(leads.filter((l) => l.sheet === "family").length).toBe(2);
    expect(leads.filter((l) => l.sheet === "animalia").length).toBe(2);
  });

  test("unconfigured fairyland (empty id) still skips honestly — unchanged", async () => {
    const { http } = makeSheetsHttp("Sheet1", { Sheet1: firstTabRows("fam") });
    const adapter = new LiveSheetsAdapter(
      { ...cfg(), fairyland: { sheet_id: "", mode: "row_per_lead", columns: { ...ROW_PER_LEAD_COLUMNS }, tab_name: FAIRYLAND_TAB } },
      35,
      http,
    );
    const leads = await adapter.fetchLeads();
    expect(adapter.lastRun?.warnings.some((w) => w.includes("fairyland: no sheet id configured"))).toBe(true);
    expect(leads.some((l) => l.sheet === "fairyland")).toBe(false);
  });
});

// ---------- parseSheetRows: fairyland row_per_lead mapping (pure) ----------
describe("fairyland row_per_lead mapping (owner tab schema)", () => {
  const rows = [
    FAIRYLAND_HEADER,
    // in-window lead with phone; TimeStamp = the Q date (M/D/YYYY h:mm)
    ["Fairy Mini", "Willow", "Fern", "willow@example.com", "(555) 201-0001", "Springfield", "IL", "62704", "Q", "A", "Q", "A", "Q", "A", "Q", "A", "10/21/2026 13:45", "AD", "Set", "123", "4-7", "1 Elm St", "$310k", "zillow"],
    // email-only lead (no phone) — still ingested
    ["Fairy Signature", "Juniper", "Moss", "juniper@example.com", "", "", "", "", "", "", "", "", "", "", "", "", "10/21/2026 14:02"],
    // no phone AND no email → skipped honestly
    ["Fairy Mini", "No Contact", "Person", "", "", "", "", "", "", "", "", "", "", "", "", "", "10/21/2026 15:00"],
    // garbage date in Q → skipped honestly
    ["Fairy Mini", "Bad", "Date", "x@example.com", "555", "", "", "", "", "", "", "", "", "", "", "", "not a date"],
  ];

  test("maps TimeStamp→date, First Name→name, Email/Phone; unmapped columns ignored; label falls back to 'fairyland'", () => {
    const res = parseSheetRowsStub(rows, "2026-10-01");
    expect(res.stats.sheet).toBe("fairyland");
    expect(res.stats.mode).toBe("row_per_lead");
    expect(res.stats.leads).toBe(2);
    expect(res.stats.dataRows).toBe(3);
    // Header row + the no-contact row + the bad-date row: the header has no
    // parsable date in Q, so it lands in skippedBad exactly like every other
    // unmapped-tab-header row does for family/animalia (long-standing behavior).
    expect(res.stats.skippedBad).toBe(3);
    expect(res.stats.collisions).toBe(0);
    expect(res.warnings.join(" ")).toContain("no phone and no email");
    // Unmapped columns (City/State/Zip/Q&A/Age/Street/Zestimate/Zillow) produce NO warnings:
    expect(res.warnings.join(" ")).not.toContain("no column set");

    const willow = res.leads[0];
    expect(willow.sheet).toBe("fairyland");
    expect(willow.name).toBe("Willow");
    expect(willow.email).toBe("willow@example.com");
    expect(willow.phone).toBe("(555) 201-0001");
    expect(willow.sourceDate).toBe("2026-10-21");
    expect(willow.workDate).toBe(getWorkDate("2026-10-21")); // Wed → Tue 10/20
    expect(willow.leadType).toBe("fairyland"); // no lead_type mapped → sheet label
    expect(willow.source_id).toBe(`gs2#fairyland#d2026-10-21#p5552010001`);

    const juniper = res.leads[1];
    expect(juniper.source_id).toBe("gs2#fairyland#d2026-10-21#ejuniper@example.com");
  });

  test("two same-contact rows on one day collide deterministically (#2), both kept", () => {
    const dup = [
      FAIRYLAND_HEADER,
      ["Fairy Mini", "Willow", "Fern", "willow@example.com", "(555) 201-0001", "", "", "", "", "", "", "", "", "", "", "", "10/21/2026 13:45"],
      ["Fairy Mini", "Willow", "Fern", "willow@example.com", "(555) 201-0001", "", "", "", "", "", "", "", "", "", "", "", "10/21/2026 17:45"],
    ];
    const res = parseSheetRowsStub(dup, "2026-10-01");
    expect(res.stats.leads).toBe(2);
    expect(res.stats.collisions).toBe(1);
    expect(res.leads[0].source_id).toBe("gs2#fairyland#d2026-10-21#p5552010001");
    expect(res.leads[1].source_id).toBe("gs2#fairyland#d2026-10-21#p5552010001#2");
  });

  test("rows older than the backfill window are skipped (counted)", () => {
    const old = [
      FAIRYLAND_HEADER,
      ["Fairy Mini", "Old", "Lead", "old@example.com", "(555) 201-0999", "", "", "", "", "", "", "", "", "", "", "", "8/1/2026 10:00"],
    ];
    const res = parseSheetRowsStub(old, "2026-10-01");
    expect(res.stats.leads).toBe(0);
    expect(res.stats.skippedOld).toBe(1);
  });
});

function parseSheetRowsStub(rows: string[][], windowStart: string) {
  return parseSheetRows({
    sheet: "fairyland",
    sheetId: FAIRYLAND_ID,
    mapping: { mode: "row_per_lead", columns: { ...ROW_PER_LEAD_COLUMNS } },
    rows,
    windowStart,
  });
}

// ---------- config plumbing: tab_name survives save + read ----------
describe("SheetConfig tab_name survives the settings path", () => {
  test("mergeSheetsSettings (owner actor) carries tab_name; a later non-owner patch preserves it", () => {
    const current = {
      family: { sheet_id: "fam", mode: "row_per_lead" as const, columns: { ...ROW_PER_LEAD_COLUMNS } },
      animalia: { sheet_id: "ani", mode: "row_per_day_count" as const, columns: { source_date: "Q", count: "B", lead_type: "C" } },
      fairyland: { sheet_id: "", mode: "row_per_day_count" as const, columns: { source_date: "Q", count: "B", lead_type: "C" } },
    };
    const patch = {
      fairyland: { sheet_id: FAIRYLAND_ID, tab_name: FAIRYLAND_TAB, mode: "row_per_lead" as const, columns: { ...ROW_PER_LEAD_COLUMNS } },
    };
    const { sheets, modeChanges } = mergeSheetsSettings(current, patch, true);
    expect(modeChanges).toEqual([{ sheet: "fairyland", from: "row_per_day_count", to: "row_per_lead" }]);
    expect(sheets.fairyland).toMatchObject({ sheet_id: FAIRYLAND_ID, tab_name: FAIRYLAND_TAB, mode: "row_per_lead" });
    // A later system write (allowModeChange=false) that touches fairyland's
    // columns keeps BOTH the saved mode AND the tab name:
    const later = mergeSheetsSettings(sheets, { fairyland: { ...sheets.fairyland, columns: { ...ROW_PER_LEAD_COLUMNS } } }, false);
    expect(later.sheets.fairyland.tab_name).toBe(FAIRYLAND_TAB);
    expect(later.sheets.fairyland.mode).toBe("row_per_lead");
    // family/animalia untouched:
    expect(later.sheets.family.sheet_id).toBe("fam");
    expect(later.sheets.animalia.sheet_id).toBe("ani");
    expect(later.sheets.animalia.tab_name).toBeUndefined();
  });

  test("MemoryStore round-trip: tab_name persists through saveSettings → getSettings (normalize never drops it)", async () => {
    const store = new MemoryStore();
    await store.saveSettings(
      { sheets: { fairyland: { sheet_id: FAIRYLAND_ID, tab_name: FAIRYLAND_TAB, mode: "row_per_lead", columns: { ...ROW_PER_LEAD_COLUMNS } } } },
      "christopher",
    );
    const s = await store.getSettings();
    expect(s.sheets.fairyland).toMatchObject({ sheet_id: FAIRYLAND_ID, tab_name: FAIRYLAND_TAB, mode: "row_per_lead" });
    expect(s.sheets.fairyland.columns).toEqual(ROW_PER_LEAD_COLUMNS);
    // family/animalia keep their defaults (no tab_name key invented):
    expect(s.sheets.family.tab_name).toBeUndefined();
    expect(s.sheets.animalia.tab_name).toBeUndefined();
    // An empty/garbage tab_name normalizes away (absent = first tab):
    await store.saveSettings({ sheets: { fairyland: { ...s.sheets.fairyland, tab_name: "  " } } }, "christopher");
    const s2 = await store.getSettings();
    expect(s2.sheets.fairyland.tab_name).toBeUndefined();
    expect(s2.sheets.fairyland.sheet_id).toBe(FAIRYLAND_ID); // the rest survived
  });
});
