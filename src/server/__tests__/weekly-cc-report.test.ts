/**
 * WEEKLY CC REPORT (owner template, 2026-09-29) — deterministic tests.
 *
 *  1. splitWinsByChannel: Alliance/Auction counted from Acuity type names
 *     (case-insensitive, independent counters); website is never computed.
 *  2. buildWeeklyCcReportText: the owner's EXACT template order — bookings
 *     week/month with goalVsActual, Alliance/Auction/Website leads+bookings,
 *     leads, conversion (+ by genre), calendar/booked-out, the three
 *     not-yet-defined placeholders as BLANK fields, then the narrative
 *     sections. Honest states: no goal → "X/—", channel leads "not synced",
 *     website bookings "—".
 *  3. Narrative persistence: stored notes override the computed Celebrate
 *     default; weeklyPageData passes stored notes through (PageDeps seam,
 *     MemoryStore + pinned today).
 */
import { describe, expect, test } from "bun:test";
import { splitWinsByChannel, celebrateDefaultLine, WEEKLY_CC_SECTIONS } from "../metrics/weekly";
import { buildWeeklyCcReportText, type WeeklyCcReportInput } from "../metrics/weekly-report-text";
import { weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";

const win = (id: string, type: string) => ({
  id,
  contact_id: null,
  calendar_id: null,
  appointment_type: type,
  appointment_datetime: "2026-09-22T18:00:00.000Z",
  created_at: "2026-09-22T16:00:00.000Z",
  created_business_date: "2026-09-22",
  booking_win_business_date: "2026-09-22",
  raw: { priceSold: "300.00", amountPaid: "300.00" },
  status: "scheduled",
  cancelled: false,
});

describe("splitWinsByChannel (pure)", () => {
  test("counts Alliance and Auction from Acuity type names, case-insensitive", () => {
    const wins = [
      win("a", 'Alliance Portrait Session + 20" Portrait'),
      win("b", 'Auction Portrait Session + 20" Portrait + Hotel'),
      win("c", "AUCTION Animalia Session"),
      win("d", "Animalia Session (cat & other animals)"), // neither channel
      win("e", "Portrait Session"),
    ];
    expect(splitWinsByChannel(wins)).toEqual({ alliance: 1, auction: 2 });
  });
  test("independent counters: a type matching both words counts in both", () => {
    const wins = [win("x", "Alliance Auction Hybrid")];
    expect(splitWinsByChannel(wins)).toEqual({ alliance: 1, auction: 1 });
  });
  test("empty input → zeros (website is never computed here)", () => {
    expect(splitWinsByChannel([])).toEqual({ alliance: 0, auction: 0 });
  });
});

describe("celebrateDefaultLine (pure)", () => {
  test("prefill text and null guard", () => {
    expect(celebrateDefaultLine({ repName: "Allison Wittner", total: 47 })).toBe("Allison Wittner — 47 paid bookings");
    expect(celebrateDefaultLine(null)).toBeNull();
  });
});

// ---------- report text assembly ----------

const baseInput = (): WeeklyCcReportInput => ({
  week: { start: "2026-09-21", end: "2026-09-27" },
  monthKey: "2026-09",
  bookingsWeek: { total: 62, goal: 79 },
  bookingsMonth: { total: 239, goal: 316 },
  channels: { alliance: 13, auction: 17, website: null },
  leads: { family: 214, animalia: 178, total: 392 },
  conversion: { overall: 0.2105, family: 0.1818, animalia: 0.2381 },
  // BOOKINGS FROM LEADS (owner request 2026-09-29): the owner's reference week —
  // 62 paid bookings / 702 sheet leads = 8.83% overall funnel rate.
  funnel: { wins: 62, leads: 702, pct: 62 / 702 },
  calendar: {
    thisWeek: { appointments: 34, capacity: 63 },
    nextWeek: { appointments: 12, capacity: 63 },
    beyond: 118,
    firstFullyOpenDay: "2026-10-14",
  },
  notes: {
    department_updates: "Staffing steady.",
    big3: "1. Push Alliance follow-ups\n2. Auction confirmations\n3. Morning Rev",
    big3_followup: "Two of three done.",
  },
  celebrateDefault: "Allison Wittner — 47 paid bookings",
});

describe("buildWeeklyCcReportText (pure, deterministic)", () => {
  test("renders the owner's template order verbatim", () => {
    const text = buildWeeklyCcReportText(baseInput());
    expect(text).toBe(
      [
        "CC Report — Week of Mon, Sep 21, 2026 – Sun, Sep 27, 2026",
        "",
        "Bookings (Week): 62/79 (−17)",
        "Bookings (Month-to-Date, September 2026): 239/316 (−77)",
        "",
        "Alliance — Leads: not synced · Bookings: 13",
        "Auction — Leads: not synced · Bookings: 17",
        "Website — Leads: not synced · Bookings: —",
        "",
        "Leads (week — synced Family/Animalia sheets):",
        "Family: 214",
        "Animalia: 178",
        "Total: 392",
        "",
        "Conversion of Assigned Leads: 21.05% (Family 18.18% · Animalia 23.81%)",
        "Bookings from Leads: 8.83%",
        "",
        "Calendar / Booked-out:",
        "This week: 34/63 filled (54%)",
        "Next week: 12/63 filled (19%)",
        "Beyond next week: 118 sessions",
        "First fully open day: Wed, Oct 14, 2026",
        "",
        "Empty appointments:",
        "Holes:",
        "1st Call Completed through Monday:",
        "",
        "Department Updates: Staffing steady.",
        "Big 3: 1. Push Alliance follow-ups",
        "2. Auction confirmations",
        "3. Morning Rev",
        "Update on Last Week's Big Three: Two of three done.",
        "Celebrate / Top Performer: Allison Wittner — 47 paid bookings",
        "Company Culture / Team Building:",
        "Escalations:",
        "Customer Service:",
        "Recruitment / Training:",
        "Roadblocks / Support Needed:",
        "Leadership Learning:",
      ].join("\n"),
    );
  });

  test("honest states: no monthly goal → 'X/—'; zero conversion denominators → '—'; open-day '—'", () => {
    const input = baseInput();
    input.bookingsMonth.goal = null;
    input.conversion = { overall: null, family: null, animalia: null };
    input.calendar.thisWeek = { appointments: 5, capacity: 0 };
    input.calendar.firstFullyOpenDay = null;
    input.funnel = { wins: 0, leads: 0, pct: null }; // zero sheet leads → never a fabricated 0%
    const text = buildWeeklyCcReportText(input);
    expect(text).toContain("Bookings (Month-to-Date, September 2026): 239/—");
    expect(text).toContain("Conversion of Assigned Leads: — (Family — · Animalia —)");
    expect(text).toContain("Bookings from Leads: —");
    expect(text).toContain("This week: 5/— filled");
    expect(text).toContain("First fully open day: —");
  });

  test("a stored Celebrate note overrides the computed default; sections persist verbatim", () => {
    const input = baseInput();
    input.notes.celebrate = "Custom shout-out.";
    const text = buildWeeklyCcReportText(input);
    expect(text).toContain("Celebrate / Top Performer: Custom shout-out.");
    // without a stored note the computed default fills the line
    expect(buildWeeklyCcReportText(baseInput())).toContain("Celebrate / Top Performer: Allison Wittner — 47 paid bookings");
  });

  test("all ten narrative sections render in the owner's order after the placeholders", () => {
    const text = buildWeeklyCcReportText(baseInput());
    const lines = text.split("\n");
    const labels = WEEKLY_CC_SECTIONS.map((s) => lines.find((l) => l.startsWith(s.label + ":")));
    expect(labels.length).toBe(10);
    expect(labels.every((l) => l != null)).toBe(true);
    // order: placeholders precede every narrative section
    const idxPlaceholder = lines.indexOf("Empty appointments:");
    for (const s of WEEKLY_CC_SECTIONS) {
      expect(lines.findIndex((l) => l.startsWith(s.label + ":"))).toBeGreaterThan(idxPlaceholder);
    }
  });
});

// ---------- narrative persistence through the page payload ----------

const TODAY = "2026-09-29";
const LW_MON = "2026-09-21";
const H = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString();

async function seedStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  await store.upsertAppointments([
    {
      id: "r-alliance",
      acuity_appointment_id: "r-alliance",
      contact_id: "k1",
      calendar_id: "cal-1",
      appointment_type: 'Alliance Portrait Session + 20" Portrait',
      appointment_datetime: H("2026-09-22", "14:00"),
      created_at: H("2026-09-22", "12:00"),
      created_business_date: "2026-09-22",
      booking_win_business_date: "2026-09-22",
      raw: { priceSold: "300.00", amountPaid: "300.00" },
      status: "scheduled",
      cancelled: false,
    },
    {
      id: "r-auction",
      acuity_appointment_id: "r-auction",
      contact_id: "k1",
      calendar_id: "cal-1",
      appointment_type: "Auction Animalia Session",
      appointment_datetime: H("2026-09-24", "14:00"),
      created_at: H("2026-09-24", "12:00"),
      created_business_date: "2026-09-24",
      booking_win_business_date: "2026-09-24",
      raw: { priceSold: "300.00", amountPaid: "300.00" },
      status: "scheduled",
      cancelled: false,
    },
  ]);
  return store;
}

describe("weeklyPageData CC Report payload (MemoryStore, pinned today)", () => {
  test("channels counted from the week's wins; website null; leads passthrough; report text assembled", async () => {
    const store = await seedStore();
    await store.upsertWeeklyReportNotes({
      week_start: LW_MON,
      notes: { big3: "1. One\n2. Two\n3. Three", celebrate: "Custom celebrate." },
    });
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.channels).toEqual({ alliance: 1, auction: 1, website: null });
    expect(data.report.notes).toEqual({ big3: "1. One\n2. Two\n3. Three", celebrate: "Custom celebrate." });
    // stored note wins over the computed default (no attributions → no default anyway)
    expect(data.report.reportText).toContain("Celebrate / Top Performer: Custom celebrate.");
    expect(data.report.reportText).toContain("Big 3: 1. One");
    expect(data.report.reportText).toContain("Alliance — Leads: not synced · Bookings: 1");
    expect(data.report.reportText).toContain("Website — Leads: not synced · Bookings: —");
    expect(data.report.reportText).toContain("Empty appointments:");
    expect(data.report.reportText).toContain("1st Call Completed through Monday:");
  });

  test("no stored notes → empty map, celebrate default fills from last week's top performer", async () => {
    const store = await seedStore();
    await store.upsertUsers([
      { id: "rep-allison", provider: "highlevel", external_id: "allison", name: "Allison Wittner", email: null, is_active: true, call_start_date: null },
    ]);
    // The stores generate INTERNAL ids (upserts ignore supplied ids) — resolve
    // the rep + appointment ids the same way production attribution rows do.
    const repId = (await store.getAllUsers()).find((u) => u.name === "Allison Wittner")!.id;
    const stored = await store.getAppointmentsOverlapping("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
    const apptId = (acuityId: string) => stored.find((a) => a.acuity_appointment_id === acuityId)!.id;
    await store.upsertAttributions([
      { id: "at1", appointment_id: apptId("r-alliance"), call_id: null, rep_id: repId, method: "manual", confidence: 1, manual_override: true },
      { id: "at2", appointment_id: apptId("r-auction"), call_id: null, rep_id: repId, method: "manual", confidence: 1, manual_override: true },
    ]);
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.report.notes).toEqual({});
    expect(data.report.celebrateDefault).toBe("Allison Wittner — 2 paid bookings");
    expect(data.report.reportText).toContain("Celebrate / Top Performer: Allison Wittner — 2 paid bookings");
  });
});
