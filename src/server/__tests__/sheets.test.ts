/**
 * Google Sheets integration tests — pure functions with fixtures, no live API.
 * Covers: column-mapping parser (both shapes), source_date parsing robustness,
 * work_date computation incl. the Monday cohort, full-sheet parsing (window,
 * count expansion, deterministic ids), store-level upsert idempotency +
 * per-sheet REPLACE semantics, and the sync runner's provider-aware fallback.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { GoogleSheetsAdapter } from "../sync/adapters";
import {
  applySheetMapping,
  columnLetterToIndex,
  detectSheetMapping,
  parseSheetDate,
  parseSheetRows,
  type SheetMapping,
} from "../sync/sheets-mapping";
import { runDemoSync } from "../sync/run";
import { demoAwarenessLine, syncStaleWarnings } from "../queries";
import { etToday, getWorkDate, addDays } from "../date-logic";

const WINDOW_START = addDays(etToday(), -35);

describe("parseSheetDate robustness", () => {
  const cases: [unknown, string | null][] = [
    ["2026-09-24", "2026-09-24"],
    ["2026-9-4", "2026-09-04"],
    ["2026-09-24T05:00:00Z", "2026-09-24"],
    ["2026-09-24 14:30", "2026-09-24"],
    ["9/24/2026", "2026-09-24"],
    ["09/24/2026", "2026-09-24"],
    // US date + trailing time — the REAL lead sheets store date-time in the
    // date column (e.g. column Q: "02/02/2026 0:00"); time is ignored.
    ["02/02/2026 0:00", "2026-02-02"],
    ["9/24/2026 14:30", "2026-09-24"],
    ["12/31/2026 11:59:59 PM", "2026-12-31"],
    ["9-24-2026", "2026-09-24"],
    ["9/24/26", "2026-09-24"],
    ["Sep 24, 2026", "2026-09-24"],
    ["September 24 2026", "2026-09-24"],
    ["24 Sep 2026", "2026-09-24"],
    ["20260924", "2026-09-24"],
    ["", null],
    ["  ", null],
    ["n/a", null],
    ["13/45/2026", null], // invalid month/day
    ["2026-02-30", null], // Feb 30
    ["2026-13-01", null], // month 13
    [null, null],
  ];
  for (const [raw, want] of cases) {
    test(`${JSON.stringify(raw)} → ${want ?? "null"}`, () => {
      expect(parseSheetDate(raw)).toBe(want);
    });
  }
  test("Google serial date (days since 1899-12-30)", () => {
    // 46000 days after 1899-12-30 → computed independently below
    const want = new Date(Date.UTC(1899, 11, 30) + 46000 * 86_400_000).toISOString().slice(0, 10);
    expect(parseSheetDate("46000")).toBe(want);
    expect(parseSheetDate("123")).toBeNull(); // out of serial range
  });
});

describe("column mapping parser (both shapes)", () => {
  test("row_per_lead (default mode, Phase-1 parity)", () => {
    const row = ["2026-09-24", "Emma Carter", "+19175550142", "emma@example.com", "family"];
    const res = applySheetMapping(row, { source_date: "A", name: "B", phone: "C", email: "D", lead_type: "E" });
    expect(res.parsed.source_date).toBe("2026-09-24");
    expect(res.parsed.phone).toBe("+19175550142");
    expect(res.warnings).toEqual([]);
  });
  test("row_per_day_count reads the count column and ignores lead-only columns", () => {
    const row = ["2026-09-24", "12"];
    const res = applySheetMapping(row, { source_date: "A", count: "B" }, "row_per_day_count");
    expect(res.parsed.source_date).toBe("2026-09-24");
    expect(res.parsed.count).toBe("12");
    expect(res.warnings).toEqual([]);
  });
  test("row_per_day_count warns when the count column is unset", () => {
    const res = applySheetMapping(["2026-09-24", "12"], { source_date: "A" }, "row_per_day_count");
    expect(res.parsed.count).toBeNull();
    expect(res.warnings.join(" ")).toContain("count");
  });
  test("mode ignores columns outside its field set (no false warnings)", () => {
    // In day-count mode, a name column mapping is simply not interpreted.
    const res = applySheetMapping(["2026-09-24", "5", "x"], { source_date: "A", count: "B", name: "C" }, "row_per_day_count");
    expect(res.warnings).toEqual([]);
    expect(res.parsed.count).toBe("5");
  });
  test("columnLetterToIndex", () => {
    expect(columnLetterToIndex("A")).toBe(0);
    expect(columnLetterToIndex("Z")).toBe(25);
    expect(columnLetterToIndex("AA")).toBe(26);
    expect(columnLetterToIndex("zz")).toBe(701);
    expect(columnLetterToIndex("1")).toBeNull();
  });
});

describe("work_date computation (SPEC rule)", () => {
  test("Tue–Fri source dates work the next calendar day", () => {
    // 2026-09-21 Mon → Tue; 2026-09-24 Thu → Fri; 2026-09-22 Tue → Wed
    expect(getWorkDate("2026-09-21")).toBe("2026-09-22");
    expect(getWorkDate("2026-09-22")).toBe("2026-09-23");
    expect(getWorkDate("2026-09-24")).toBe("2026-09-25");
  });
  test("Friday cohort lands on Monday (+3)", () => {
    expect(getWorkDate("2026-09-25")).toBe("2026-09-28");
  });
  test("Saturday +2, Sunday +1 → Monday", () => {
    expect(getWorkDate("2026-09-26")).toBe("2026-09-28");
    expect(getWorkDate("2026-09-27")).toBe("2026-09-28");
  });
  test("parsed sheet dates carry the rule through parseSheetRows", () => {
    const res = parseSheetRows({
      sheet: "family",
      sheetId: "S",
      mapping: { mode: "row_per_day_count", columns: { source_date: "A", count: "B" } },
      rows: [["Date", "Count"], ["09/24/2026", "7"], ["09/25/2026", "2"], ["09/26/2026", "3"], ["09/27/2026", "1"]],
      windowStart: WINDOW_START,
    });
    const byDate = new Map(res.leads.map((l) => [l.sourceDate, l.workDate]));
    expect(byDate.get("2026-09-24")).toBe("2026-09-25");
    expect(byDate.get("2026-09-25")).toBe("2026-09-28"); // Fri → Mon
    expect(byDate.get("2026-09-26")).toBe("2026-09-28"); // Sat → Mon
    expect(byDate.get("2026-09-27")).toBe("2026-09-28"); // Sun → Mon
    expect(res.leads.length).toBe(13); // 7+2+3+1
  });
});

describe("parseSheetRows — row_per_day_count", () => {
  const mapping: SheetMapping = { mode: "row_per_day_count", columns: { source_date: "A", count: "B" } };
  const rows = () => [
    ["Leads per day", ""],
    ["Date", "Count"],
    ["09/24/2026", "12"],
    ["2026-09-23", "5"],
    ["09/22/2026", ""],          // missing count → skipped + warning
    ["garbage", "3"],            // unreadable date → skipped + warning
    ["", ""],                    // fully empty → silent skip
  ];
  test("expands counts into individual leads with deterministic ids", () => {
    const res = parseSheetRows({ sheet: "family", sheetId: "SHEET1", mapping, rows: rows(), windowStart: WINDOW_START });
    expect(res.stats.dataRows).toBe(3); // 3 rows had a readable date (one lacked a count)
    expect(res.stats.leads).toBe(17);
    expect(res.stats.skippedBad).toBe(4); // title row + header row + missing count + garbage date
    expect(res.stats.skippedEmpty).toBe(1);
    const ids = res.leads.map((l) => l.source_id);
    expect(new Set(ids).size).toBe(ids.length);
    // v2 content keys: anonymous count-expanded leads share the "c" handle
    // with deterministic first-seen ordinal suffixes.
    expect(ids[0]).toBe("gs2#family#d2026-09-24#c");
    expect(ids[11]).toBe("gs2#family#d2026-09-24#c#12");
    expect(ids[12]).toBe("gs2#family#d2026-09-23#c");
    expect(res.warnings.join(" ")).toContain("unreadable lead count");
  });
  test("re-parsing the same input yields identical source_ids (idempotency)", () => {
    const a = parseSheetRows({ sheet: "family", sheetId: "SHEET1", mapping, rows: rows(), windowStart: WINDOW_START });
    const b = parseSheetRows({ sheet: "family", sheetId: "SHEET1", mapping, rows: rows(), windowStart: WINDOW_START });
    expect(a.leads.map((l) => l.source_id)).toEqual(b.leads.map((l) => l.source_id));
  });
  test("rows before the backfill window are skipped and counted", () => {
    const oldDate = addDays(etToday(), -60);
    const res = parseSheetRows({
      sheet: "family", sheetId: "S", mapping,
      rows: [[oldDate, "4"], ["09/24/2026", "2"]],
      windowStart: WINDOW_START,
    });
    expect(res.stats.skippedOld).toBe(1);
    expect(res.stats.leads).toBe(2);
  });
  test("zero leads parsed → actionable warning", () => {
    const res = parseSheetRows({ sheet: "animalia", sheetId: "S", mapping, rows: [["name", "x"]], windowStart: WINDOW_START });
    expect(res.stats.dataRows).toBe(0);
    expect(res.warnings.join(" ")).toContain("No rows with a readable date");
  });
  test("lead rows include null contact fields and the sheet name as type fallback", () => {
    const res = parseSheetRows({ sheet: "family", sheetId: "S", mapping, rows: [["09/24/2026", "1"]], windowStart: WINDOW_START });
    expect(res.leads[0].leadType).toBe("family");
    expect(res.leads[0].phone).toBeNull();
    expect(res.leads[0].email).toBeNull();
    expect(res.leads[0].sheet).toBe("family");
  });
});

describe("parseSheetRows — row_per_lead", () => {
  const mapping: SheetMapping = {
    mode: "row_per_lead",
    columns: { source_date: "A", name: "B", phone: "C", email: "D", lead_type: "E" },
  };
  const rows = () => [
    ["Date", "Name", "Phone", "Email", "Lead Type"],
    ["2026-09-24", "Emma", "+19175550142", "emma@example.com", "family"],
    ["9/24/2026", "Liam", "(917) 555-0188", "", ""],
    ["2026-09-24", "NoContact", "", "", ""], // no phone/email → skipped
    ["2026-09-24", "EmailOnly", "", "e@x.com", ""],
  ];
  test("identity from phone/email; duplicates within a date get suffixes", () => {
    const res = parseSheetRows({ sheet: "family", sheetId: "S", mapping, rows: [...rows(), rows()[1]], windowStart: WINDOW_START });
    expect(res.stats.leads).toBe(4); // 3 unique + 1 duplicated row
    const ids = res.leads.map((l) => l.source_id);
    // v2 content keys — sheet label + date + phone handle, NO sheetId/position.
    expect(ids[0]).toBe("gs2#family#d2026-09-24#p9175550142");
    expect(ids[1]).toBe("gs2#family#d2026-09-24#p9175550188");
    expect(ids[3]).toBe("gs2#family#d2026-09-24#p9175550142#2"); // full identity collision → ordinal, counted
    expect(res.stats.collisions).toBe(1);
    expect(res.leads[3]!.leadType).toBe("family");
    expect(res.warnings.join(" ")).toContain("no phone and no email");
  });
  test("same phone on a different date is a different lead", () => {
    const res = parseSheetRows({
      sheet: "family", sheetId: "S", mapping,
      rows: [["2026-09-24", "A", "+19175550142", "", ""], ["2026-09-23", "A", "+19175550142", "", ""]],
      windowStart: WINDOW_START,
    });
    expect(res.leads.length).toBe(2);
    expect(res.leads[0]!.source_id).not.toBe(res.leads[1]!.source_id);
  });
});

describe("detectSheetMapping (suggestion only — never silently applied)", () => {
  test("count-like header → row_per_day_count", () => {
    const det = detectSheetMapping(["Date", "Leads", "Notes"]);
    expect(det?.mapping.mode).toBe("row_per_day_count");
    expect(det?.mapping.columns.count).toBe("B");
  });
  test("phone/email header → row_per_lead", () => {
    const det = detectSheetMapping(["Date", "Name", "Phone", "Email"]);
    expect(det?.mapping.mode).toBe("row_per_lead");
    expect(det?.mapping.columns.phone).toBe("C");
  });
  test("no date column → null", () => {
    expect(detectSheetMapping(["Name", "Phone"])).toBeNull();
  });
});

describe("store-level idempotency (MemoryStore, same semantics as pg)", () => {
  const lead = (n: number, date: string, sheet: string) => ({
    provider: "google_sheets",
    source_id: `${sheet}#d${date}#${n}`, // mirrors parseSheetRows ids (sheet-scoped)
    lead_type: sheet,
    source_date: date,
    work_date: getWorkDate(date),
    name: null, phone: null, email: null,
    contact_id: null, assigned_rep_id: null,
    source_sheet: sheet,
  });
  test("re-upserting the same rows does not double-count", async () => {
    const store = new MemoryStore();
    const rows = Array.from({ length: 5 }, (_, n) => lead(n, "2026-09-24", "family"));
    await store.upsertLeads(rows);
    await store.upsertLeads(rows);
    const got = await store.getLeadsByWorkDates(["2026-09-25"]);
    expect(got.length).toBe(5);
  });
  test("per-sheet REPLACE: a shrunk count replaces (not adds to) the stored one", async () => {
    const store = new MemoryStore();
    await store.upsertLeads(Array.from({ length: 20 }, (_, n) => lead(n, "2026-09-24", "family")));
    await store.upsertLeads(Array.from({ length: 20 }, (_, n) => lead(n, "2026-09-24", "animalia")));
    // Re-sync with only 18 family leads: delete + insert must drop the 2 stale rows.
    await store.deleteLeadsForSheet("family");
    await store.upsertLeads(Array.from({ length: 18 }, (_, n) => lead(n, "2026-09-24", "family")));
    const family = (await store.getLeadsByWorkDates(["2026-09-25"])).filter((l) => l.source_sheet === "family");
    const animalia = (await store.getLeadsByWorkDates(["2026-09-25"])).filter((l) => l.source_sheet === "animalia");
    expect(family.length).toBe(18);
    expect(animalia.length).toBe(20);
  });
  test("deleteLeadsForSheet leaves other sheets untouched", async () => {
    const store = new MemoryStore();
    await store.upsertLeads([lead(0, "2026-09-24", "family"), lead(0, "2026-09-24", "animalia")]);
    await store.deleteLeadsForSheet("family");
    const left = await store.getLeadsByWorkDates(["2026-09-25"]);
    expect(left.length).toBe(1);
    expect(left[0]!.source_sheet).toBe("animalia");
  });
});

describe("sync runner provider-awareness (stub adapters, no live API)", () => {
  const failingAdapter: GoogleSheetsAdapter = {
    provider: "google_sheets",
    isDemo: false,
    fetchLeads: async () => {
      throw new Error("The Google Sheets API is not enabled for the key's Google Cloud project. Enable it, then run SYNC NOW.");
    },
  };
  const liveAdapter = (): GoogleSheetsAdapter & { lastRun: unknown } => {
    const d = "2026-09-24";
    return {
      provider: "google_sheets",
      isDemo: false,
      lastRun: null,
      fetchLeads: async () => Array.from({ length: 3 }, (_, n) => ({
        source_id: `LIVE#d${d}#${n}`,
        leadType: "family",
        sourceDate: d,
        workDate: getWorkDate(d),
        name: null, phone: null, email: null,
        sheet: "family",
      })),
    };
  };

  test("failed live attempt → demo fallback data + honest error connection", async () => {
    const store = new MemoryStore();
    const res = await runDemoSync({ store, sheetsAdapter: failingAdapter, highlevelAdapter: null });
    const sheets = res.providers.find((p) => p.provider === "google_sheets")!;
    expect(sheets.error).toContain("Sheets API is not enabled");
    expect(sheets.count).toBeGreaterThan(0); // demo fallback leads stored
    const conn = (await store.getConnections()).find((c) => c.provider === "google_sheets")!;
    expect(conn.status).toBe("error");
    expect(conn.is_demo).toBe(true);
    expect(conn.last_error).toContain("Sheets API is not enabled");
    expect(conn.last_successful_sync_at).toBeNull();
    // pages get a warning about it
    expect(syncStaleWarnings(await store.getConnections()).join(" ")).toContain("Google Sheets reported a sync error");
  });

  test("successful live sync → connected, not demo, real leads replace demo rows", async () => {
    const store = new MemoryStore();
    // First a demo seed so we can prove the replace happened.
    await runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null });
    const demoCount = (await store.getLeadsByWorkDates([getWorkDate("2026-09-24")])).length;
    expect(demoCount).toBeGreaterThan(0);

    const adapter = liveAdapter();
    const res = await runDemoSync({ store, sheetsAdapter: adapter, highlevelAdapter: null });
    const sheets = res.providers.find((p) => p.provider === "google_sheets")!;
    expect(sheets.error).toBeNull();
    const conn = (await store.getConnections()).find((c) => c.provider === "google_sheets")!;
    expect(conn.status).toBe("connected");
    expect(conn.is_demo).toBe(false);
    expect(conn.last_error).toBeNull();
    const family = (await store.getLeadsByWorkDates([getWorkDate("2026-09-24")])).filter((l) => l.source_sheet === "family");
    expect(family.length).toBe(3); // demo family rows replaced by 3 live rows
    // (source_id isn't exposed by getLeadsByWorkDates; replace semantics are
    // proven by the count above + the idempotency re-sync below.)
    // re-sync is idempotent
    await runDemoSync({ store, sheetsAdapter: liveAdapter(), highlevelAdapter: null });
    const again = (await store.getLeadsByWorkDates([getWorkDate("2026-09-24")])).filter((l) => l.source_sheet === "family");
    expect(again.length).toBe(3);
  });
});

describe("demo-awareness banner line", () => {
  test("all demo → demo line", () => {
    const line = demoAwarenessLine([
      { provider: "highlevel", status: "demo", is_demo: true },
      { provider: "acuity", status: "demo", is_demo: true },
      { provider: "google_sheets", status: "demo", is_demo: true },
    ]);
    expect(line).toContain("Demo data:");
    expect(line).toContain("Google Sheets leads");
  });
  test("mixed → Live/Demo split", () => {
    const line = demoAwarenessLine([
      { provider: "highlevel", status: "demo", is_demo: true },
      { provider: "acuity", status: "demo", is_demo: true },
      { provider: "google_sheets", status: "connected", is_demo: false },
    ]);
    expect(line).toBe("Live: Google Sheets leads · Demo: HighLevel calls, Acuity bookings");
  });

  // OWNER CASE (2026-09-28): HighLevel read ECONNRESET mid-day. The calls data
  // in the store is 100% real (is_demo=false) — the banner must show it as
  // live-with-a-sync-error, NEVER as "Demo".
  test("real data with transient sync error → degraded-live clause, never Demo", () => {
    const line = demoAwarenessLine([
      { provider: "google_sheets", status: "connected", is_demo: false },
      { provider: "highlevel", status: "error", is_demo: false, last_successful_sync_at: "2026-09-28T18:42:00.000Z" },
      { provider: "acuity", status: "connected", is_demo: false },
    ]);
    expect(line).toBe(
      "Live: Google Sheets leads, Acuity bookings · Live — last sync error, numbers as of 14:42 ET, retrying: HighLevel calls",
    );
    expect(line).not.toContain("Demo");
  });

  test("real data, sync error, never synced successfully → honest pending clause, never Demo", () => {
    const line = demoAwarenessLine([
      { provider: "highlevel", status: "error", is_demo: false, last_successful_sync_at: null },
    ]);
    expect(line).toBe("Live — last sync incomplete, numbers pending: HighLevel calls");
    expect(line).not.toContain("Demo");
  });

  test("degraded clause uses ET clock from last_successful_sync_at (invalid/missing → pending)", () => {
    const line = demoAwarenessLine([
      { provider: "acuity", status: "pending", is_demo: false, last_successful_sync_at: "not-a-date" },
      { provider: "highlevel", status: "error", is_demo: false, last_successful_sync_at: "2026-09-28T18:42:00.000Z" },
    ]);
    expect(line).toBe(
      "Live — last sync incomplete, numbers pending: Acuity bookings · Live — last sync error, numbers as of 14:42 ET, retrying: HighLevel calls",
    );
  });

  test("demo provider with error status still buckets as Demo (is_demo wins)", () => {
    const line = demoAwarenessLine([
      { provider: "highlevel", status: "error", is_demo: true, last_successful_sync_at: "2026-09-28T18:42:00.000Z" },
      { provider: "google_sheets", status: "connected", is_demo: false },
    ]);
    expect(line).toBe("Live: Google Sheets leads · Demo: HighLevel calls");
  });
  test("partial sync warning fires for connected-with-error", () => {
    const warnings = syncStaleWarnings([
      { provider: "google_sheets", status: "connected", last_successful_sync_at: "2026-09-25T10:00:00Z", last_error: "animalia: 403" },
    ]);
    expect(warnings.join(" ")).toContain("synced partially");
  });
});
