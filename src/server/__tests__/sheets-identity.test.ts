/**
 * SHEETS LEAD IDENTITY — v2 CONTENT KEYS + UPSERT-ONLY STORAGE (owner
 * directive 2026-09-28).
 *
 * Pins the exact live failure: stored leads were keyed by sheet ROW position
 * (v1 ordinals + per-sheet REPLACE), so inserting/re-sorting rows above a
 * position remapped every later key to different content and a sync rewrote
 * the wrong leads' dates — "Leads worked today" swung between refreshes
 * (observed live: 315 → 262 → 183 → 315 within an hour on 2026-09-28).
 *
 * Pinned here:
 *  (a) row inserted above an existing lead → that lead's stored dates unchanged;
 *  (b) full re-sort of the sheet → zero stored changes;
 *  (c) genuinely new row appended → exactly one new lead, correct work_date;
 *  (d) same sheet synced twice → zero stored changes (idempotent);
 *  (e) family and animalia sheets stay independent;
 *  +  one-time re-key migration (legacy row-keyed rows → content keys,
 *     idempotent, work_date repaired, demo rows untouched);
 *  +  drift guard: a date change under a stable key lands LOUD in the run note;
 *  +  demo purge on first live sync (demo- prefix, targeted).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { GoogleSheetsAdapter } from "../sync/adapters";
import type { NormalizedLead } from "../sync/sheets-mapping";
import { sheetLeadKey } from "../sync/sheets-mapping";
import { runSheetsSync } from "../sync/run";
import { migrateSheetsLeadKeys } from "../sync/sheets-rekey";
import { getWorkDate } from "../date-logic";

/** A row_per_lead lead as the live parser would emit it (v2 content id). */
function lead(sheet: "family" | "animalia", sourceDate: string, handle: { phone?: string; email?: string }, name = "Lead"): NormalizedLead {
  return {
    source_id: sheetLeadKey(sheet, sourceDate, handle.phone ?? null, handle.email ?? null),
    leadType: sheet,
    sourceDate,
    workDate: getWorkDate(sourceDate),
    name,
    phone: handle.phone ?? null,
    email: handle.email ?? null,
    sheet,
  };
}

/** Adapter stub over an ordered list of sheet rows (mutable between syncs). */
function rowsAdapter(rows: NormalizedLead[]): GoogleSheetsAdapter {
  return { provider: "google_sheets", isDemo: false, fetchLeads: async () => [...rows] };
}

const settings = await new MemoryStore().getSettings();
const SUN = "2026-09-27"; // Sunday → works into Monday 2026-09-28
const MON = "2026-09-28"; // Tuesday's cohort

/** A v1-era stored row (spreadsheet-id/positional source_id) for migration tests. */
const legacy = (sheet: string, date: string, sourceId: string, contact?: { phone?: string; email?: string }) => ({
  provider: "google_sheets",
  source_id: sourceId,
  lead_type: sheet,
  source_date: date,
  work_date: getWorkDate(date),
  name: null,
  phone: contact?.phone ?? null,
  email: contact?.email ?? null,
  contact_id: null,
  assigned_rep_id: null,
  source_sheet: sheet,
});

/** Full stored-lead fingerprint: id → (source_date, work_date, name). */
async function fingerprint(store: MemoryStore): Promise<Map<string, string>> {
  const all = await store.getLeadsByProvider("google_sheets");
  return new Map(all.map((l) => [l.source_id, `${l.source_date}|${l.work_date}|${l.name}|${l.source_sheet}`]));
}

describe("(a) row inserted above an existing lead → stored dates unchanged", () => {
  test("insertion above remaps nothing; the lead keeps its source/work date", async () => {
    const store = new MemoryStore();
    const rows = [lead("family", SUN, { phone: "+19175550001" }, "Emma"), lead("family", SUN, { phone: "+19175550002" }, "Liam")];
    await runSheetsSync(store, settings, rowsAdapter(rows));
    const before = await fingerprint(store);
    expect(before.size).toBe(2);

    // The owner inserts a NEW row at the TOP of the sheet (position shift).
    const after = [lead("family", SUN, { phone: "+19175550009" }, "Newcomer"), ...rows];
    const res = await runSheetsSync(store, settings, rowsAdapter(after));
    expect(res.count).toBe(3);

    const fp = await fingerprint(store);
    expect(fp.size).toBe(3); // one genuinely new lead, nothing rewritten
    for (const [id, val] of before) expect(fp.get(id)).toBe(val); // byte-identical
    expect(fp.get(sheetLeadKey("family", SUN, "+19175550001", null))).toContain(`${SUN}|${getWorkDate(SUN)}`);
    expect(fp.has(sheetLeadKey("family", SUN, "+19175550009", null))).toBe(true);
    // Monday cohort counts stay exact.
    const monday = (await store.getLeadsByWorkDates([MON])).filter((l) => l.source_sheet === "family");
    expect(monday.length).toBe(3);
  });
});

describe("(b) full re-sort of the sheet → zero stored changes", () => {
  test("reversed + shuffled order writes nothing new", async () => {
    const store = new MemoryStore();
    const rows = [
      lead("family", SUN, { phone: "+19175550001" }),
      lead("family", SUN, { email: "A@x.com" }),
      lead("family", "2026-09-26", { phone: "+19175550003" }),
      lead("animalia", SUN, { phone: "+19175550004" }),
      lead("animalia", SUN, { email: "b@y.com" }),
    ];
    await runSheetsSync(store, settings, rowsAdapter(rows));
    const before = await fingerprint(store);
    expect(before.size).toBe(5);

    const res = await runSheetsSync(store, settings, rowsAdapter([...rows].reverse()));
    expect(res.count).toBe(5);
    expect(res.note ?? "").not.toContain("LEAD-DATE-DRIFT");
    const after = await fingerprint(store);
    expect(after).toEqual(before); // zero stored changes
  });
});

describe("(c) genuinely new row appended → exactly one new lead", () => {
  test("appended row adds one lead with the SPEC work_date (Tue lead → Wed work)", () => {
    const d = "2026-09-22"; // Tuesday
    expect(getWorkDate(d)).toBe("2026-09-23");
  });
  test("appended row stored once with the right work_date", async () => {
    const store = new MemoryStore();
    const rows = [lead("family", SUN, { phone: "+19175550001" })];
    await runSheetsSync(store, settings, rowsAdapter(rows));
    rows.push(lead("family", "2026-09-22", { phone: "+19175550077" }));
    const res = await runSheetsSync(store, settings, rowsAdapter(rows));
    expect(res.count).toBe(2);
    const all = await store.getLeadsByProvider("google_sheets");
    expect(all.length).toBe(2); // exactly one new lead — no duplicates
    const added = all.find((l) => l.source_id === sheetLeadKey("family", "2026-09-22", "+19175550077", null))!;
    expect(added).toBeDefined();
    expect(added.source_date).toBe("2026-09-22");
    expect(added.work_date).toBe("2026-09-23"); // Tue–Fri → next day
  });
});

describe("(d) same sheet synced twice → zero stored changes", () => {
  test("re-sync is a byte-identical no-op", async () => {
    const store = new MemoryStore();
    const rows = [lead("family", SUN, { phone: "+19175550001" }, "Emma"), lead("animalia", SUN, { email: "z@y.com" }, "Zoe")];
    const adapter = rowsAdapter(rows);
    await runSheetsSync(store, settings, adapter);
    const before = await fingerprint(store);
    const res = await runSheetsSync(store, settings, adapter);
    expect(res.count).toBe(2);
    expect(await fingerprint(store)).toEqual(before);
  });
});

describe("(e) family and animalia stay independent", () => {
  test("a family-only sync never touches stored animalia rows", async () => {
    const store = new MemoryStore();
    await runSheetsSync(store, settings, rowsAdapter([
      lead("animalia", SUN, { phone: "+19175550004" }),
      lead("animalia", SUN, { email: "b@y.com" }),
    ]));
    const before = await fingerprint(store);
    expect(before.size).toBe(2);

    // Family fetch succeeds; animalia not included (e.g. its per-sheet fetch failed).
    const res = await runSheetsSync(store, settings, rowsAdapter([lead("family", SUN, { phone: "+19175550001" })]));
    expect(res.count).toBe(1);
    const after = await fingerprint(store);
    for (const [id, val] of before) expect(after.get(id)).toBe(val); // animalia untouched
    expect(after.size).toBe(3);
  });
});

describe("one-time re-key migration (legacy row-keyed rows → v2 content keys)", () => {
  test("legacy ids re-key from content; second run is a no-op; no duplicates", async () => {
    const store = new MemoryStore();
    // v1-style rows: spreadsheet-id + date + phone handle, plus a positional ordinal row.
    await store.upsertLeads([
      legacy("family", SUN, "1ABCsheetsheetid#family#d2026-09-27#p9175550001", { phone: "+19175550001" }),
      legacy("family", SUN, "1ABCsheetsheetid#family#d2026-09-27#p9175550002", { phone: "+19175550002" }),
      legacy("animalia", "2026-09-26", "1ABCsheetsheetid#animalia#d2026-09-26#0"), // anonymous count-mode row
      legacy("animalia", "2026-09-26", "1ABCsheetsheetid#animalia#d2026-09-26#1"),
    ]);
    const cohortBefore = (await store.getLeadsByWorkDates([MON])).length;
    expect(cohortBefore).toBe(4);

    const res = await migrateSheetsLeadKeys(store);
    expect(res.rekeyed).toBe(4);
    const after = await store.getLeadsByProvider("google_sheets");
    expect(after.length).toBe(4); // re-keyed in place, nothing duplicated
    expect(after.every((l) => l.source_id.startsWith("gs2#"))).toBe(true);
    expect((await store.getLeadsByWorkDates([MON])).length).toBe(4); // cohort preserved
    // The contact lead's new key is the pure content key.
    expect(after.map((l) => l.source_id)).toContain(sheetLeadKey("family", SUN, "+19175550001", null));
    // Anonymous rows collide on the "c" handle → deterministic ordinal suffixes.
    expect(after.filter((l) => l.source_sheet === "animalia").map((l) => l.source_id).sort())
      .toEqual([sheetLeadKey("animalia", "2026-09-26", null, null), `${sheetLeadKey("animalia", "2026-09-26", null, null)}#2`]);

    // Idempotent: a second pass changes nothing.
    const again = await migrateSheetsLeadKeys(store);
    expect(again.rekeyed).toBe(0);
    expect((await store.getLeadsByProvider("google_sheets")).length).toBe(4);
  });

  test("work_date repaired to the current SPEC rule; demo rows left alone", async () => {
    const store = new MemoryStore();
    await store.upsertLeads([
      { ...legacy("family", SUN, "oldid#1", { phone: "+19175550001" }), work_date: "2000-01-01" }, // stale rule
      { ...legacy("family", SUN, "demo-fam-2026-09-27-0", { phone: "+19999990001" }), source_id: "demo-fam-2026-09-27-0" },
    ]);
    const res = await migrateSheetsLeadKeys(store);
    expect(res.rekeyed).toBe(1); // demo row untouched
    expect(res.workDateFixed).toBe(1);
    const rows = await store.getLeadsByProvider("google_sheets");
    const fixed = rows.find((l) => l.phone === "+19175550001")!;
    expect(fixed.work_date).toBe(getWorkDate(SUN));
    expect(rows.some((l) => l.source_id === "demo-fam-2026-09-27-0")).toBe(true);
  });

  test("runSheetsSync auto-migrates legacy rows before upserting (self-healing deploy)", async () => {
    const store = new MemoryStore();
    await store.upsertLeads([legacy("family", SUN, "1ABCsheetsheetid#family#d2026-09-27#p9175550001", { phone: "+19175550001" })]);
    const res = await runSheetsSync(store, settings, rowsAdapter([
      lead("family", SUN, { phone: "+19175550001" }, "Emma"), // same content, new key
      lead("family", SUN, { phone: "+19175550002" }),
    ]));
    expect(res.count).toBe(2);
    expect(res.note ?? "").toContain("re-keyed 1 legacy");
    const all = await store.getLeadsByProvider("google_sheets");
    expect(all.length).toBe(2); // the legacy row became the content-key row — no double count
    expect(all.every((l) => l.source_id.startsWith("gs2#"))).toBe(true);
  });
});

describe("drift guard: a date change under a stable key is LOUD in the note", () => {
  test("work_date drift (e.g. work-date rule change) is flagged, source_date can never drift", async () => {
    const store = new MemoryStore();
    await runSheetsSync(store, settings, rowsAdapter([lead("family", SUN, { phone: "+19175550001" })]));
    // Simulate a stored row whose work_date no longer matches the rule.
    const stored = (await store.getLeadsByProvider("google_sheets")).find((l) => l.phone === "+19175550001")!;
    await store.updateLeadWorkDate(stored.id, "2000-01-01");

    const res = await runSheetsSync(store, settings, rowsAdapter([lead("family", SUN, { phone: "+19175550001" })]));
    expect(res.note ?? "").toContain("LEAD-DATE-DRIFT");
    // The sync HEALS the drift (upsert writes the rule-correct work_date).
    const healed = (await store.getLeadsByProvider("google_sheets")).find((l) => l.phone === "+19175550001")!;
    expect(healed.work_date).toBe(getWorkDate(SUN));
  });
});

describe("demo purge on first live sync (upsert-only keeps demo rows out of live data)", () => {
  test("demo rows are purged by their demo- prefix; real rows untouched", async () => {
    const store = new MemoryStore();
    await store.upsertLeads([
      { ...legacy("family", SUN, "demo-fam-2026-09-27-0", { phone: "+19999990001" }) },
      legacy("family", SUN, "gs2#family#d2026-09-27#p9175550001", { phone: "+19175550001" }),
    ]);
    const res = await runSheetsSync(store, settings, rowsAdapter([lead("family", SUN, { phone: "+19175550002" })]));
    expect(res.count).toBe(1);
    expect(res.note ?? "").toContain("demo lead rows purged");
    const rows = await store.getLeadsByProvider("google_sheets");
    expect(rows.some((l) => l.source_id.startsWith("demo-"))).toBe(false);
    expect(rows.filter((l) => l.source_sheet === "family").length).toBe(2); // real row kept + new row
  });
});
