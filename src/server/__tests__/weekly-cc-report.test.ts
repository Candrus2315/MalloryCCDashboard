/**
 * WEEKLY CC REPORT (owner template, 2026-09-29) — deterministic tests.
 *
 *  1. splitWinsByChannel: Alliance/Auction BOOKINGS counted from Acuity type
 *     names (case-insensitive, independent counters); website is never computed.
 *  2. splitChannelLeads: Alliance/Auction LEADS from GHL opportunities
 *     (owner-verified 2026-09-29: the channels' pipelines), bucketed by ET
 *     created date into Mon–Sun weeks — completed weeks only, the same rule as
 *     the funnel series; website has no synced source and stays null.
 *  3. buildWeeklyCcReportText: the owner's EXACT template order — bookings
 *     week/month with goalVsActual, Alliance/Auction/Website leads+bookings,
 *     leads, conversion (+ by genre), calendar/booked-out, the three
 *     not-yet-defined placeholders as BLANK fields, then the narrative
 *     sections. Honest states: no goal → "X/—", website leads/bookings "—".
 *  4. Narrative persistence: stored notes override the computed Celebrate
 *     default; weeklyPageData passes stored notes through (PageDeps seam,
 *     MemoryStore + pinned today).
 */
import { describe, expect, test } from "bun:test";
import {
  splitWinsByChannel,
  splitChannelLeads,
  recentCompletedWeekStarts,
  celebrateDefaultLine,
  WEEKLY_CC_SECTIONS,
  ALLIANCE_PIPELINE_ID,
  AUCTION_PIPELINE_ID,
} from "../metrics/weekly";
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

// ---------- ALLIANCE/AUCTION LEADS from GHL opportunities (owner-verified 2026-09-29) ----------

const opp = (id: string, pipelineId: string, createdAtUtc: string) => ({ id, pipeline_id: pipelineId, source_created_at: createdAtUtc });

describe("splitChannelLeads (pure — GHL opportunities, ET created-date weeks)", () => {
  const MON = "2026-09-21";
  const SUN = "2026-09-27";
  test("counts only the channel pipelines, by ET created date inside the Mon–Sun week", () => {
    const leads = [
      opp("a1", ALLIANCE_PIPELINE_ID, "2026-09-22T14:00:00Z"), // Mon 10:00 ET Sep 22 → counts
      opp("a2", AUCTION_PIPELINE_ID, "2026-09-27T03:30:00Z"), // Sat 23:30 ET Sep 26 → counts
      opp("a3", ALLIANCE_PIPELINE_ID, "2026-09-28T02:00:00Z"), // Sun 22:00 ET Sep 27 → counts (week ends Sunday ET)
      opp("n1", "some-other-pipeline", "2026-09-23T12:00:00Z"), // not a channel
      opp("a4", ALLIANCE_PIPELINE_ID, "2026-09-20T23:00:00Z"), // previous Sunday ET → out
      opp("a5", ALLIANCE_PIPELINE_ID, "2026-09-28T12:00:00Z"), // next Monday ET → out
      opp("a6", ALLIANCE_PIPELINE_ID, null), // no created time — never guessed
    ];
    expect(splitChannelLeads(leads, MON, SUN)).toEqual({ alliance: 2, auction: 1, website: null });
  });
  test("independent counters; empty input → zeros; website always null", () => {
    expect(splitChannelLeads([opp("x", ALLIANCE_PIPELINE_ID + AUCTION_PIPELINE_ID, "2026-09-22T12:00:00Z")], MON, SUN)).toEqual({
      alliance: 0,
      auction: 0,
      website: null,
    });
    expect(splitChannelLeads([], MON, SUN)).toEqual({ alliance: 0, auction: 0, website: null });
  });
  test("week bucketing uses COMPLETED Mon–Sun weeks only — the same rule as the funnel series (in-progress week never in it)", () => {
    // Owner's reference week (2026-09-29): leads on each day of the two most
    // recent weeks. The series for a Tuesday covers Aug 24–Sep 27 — NEVER the
    // in-progress week starting Sep 28, even though leads exist in it.
    const leads = [
      opp("w1", ALLIANCE_PIPELINE_ID, "2026-09-08T18:00:00Z"), // Tue Sep 8 (ET Sep 8)
      opp("w2", AUCTION_PIPELINE_ID, "2026-09-22T14:00:00Z"), // report week
      opp("w3", ALLIANCE_PIPELINE_ID, "2026-09-29T14:00:00Z"), // TODAY — in-progress week
    ];
    const weeks = recentCompletedWeekStarts("2026-09-29", 5);
    expect(weeks.at(-1)).toBe("2026-09-21"); // last completed week ends Sep 27
    expect(weeks).not.toContain("2026-09-28"); // in-progress week excluded
    const perWeek = weeks.map((mon) => ({ mon, ...splitChannelLeads(leads, mon, new Date(Date.parse(mon) + 6 * 86400000).toISOString().slice(0, 10)) }));
    const reportWeek = perWeek.find((w) => w.mon === "2026-09-21")!;
    expect(reportWeek.alliance).toBe(0);
    expect(reportWeek.auction).toBe(1);
    // the in-progress week's lead never lands in any series week
    const totalAlliance = perWeek.reduce((s, w) => s + w.alliance, 0);
    expect(totalAlliance).toBe(1); // only the Sep 8 lead (Sep 22 is auction)
  });
});

// ---------- report text assembly ----------

const baseInput = (): WeeklyCcReportInput => ({
  week: { start: "2026-09-21", end: "2026-09-27" },
  monthKey: "2026-09",
  bookingsWeek: { total: 62, goal: 79 },
  bookingsMonth: { total: 239, goal: 316 },
  channels: { alliance: 13, auction: 17, website: null },
  // Alliance/Auction LEADS now synced from GHL opportunities (owner-verified
  // 2026-09-29); website has no source → null renders "—".
  channelLeads: { alliance: 7, auction: 21, website: null },
  leads: { family: 214, animalia: 178, total: 392 },
  conversion: { overall: 0.2105, family: 0.1818, animalia: 0.2381 },
  // BOOKINGS FROM LEADS (owner request 2026-09-29): the owner's reference week —
  // 62 paid bookings / 702 sheet leads = 8.83% overall funnel rate.
  funnel: { wins: 62, leads: 702, pct: 62 / 702 },
  calendar: {
    // slotsOccupied = appointments here (no double-bookings in the fixture) —
    // the fill lines stay byte-identical; the doubled case has its own test.
    thisWeek: { appointments: 34, slotsOccupied: 34, capacity: 63 },
    nextWeek: { appointments: 12, slotsOccupied: 12, capacity: 63 },
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
        "Alliance — Leads: 7 · Bookings: 13",
        "Auction — Leads: 21 · Bookings: 17",
        "Website — Leads: — · Bookings: —",
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

  test("DISTINCT-SLOT fill (owner report 10/6): 65 sessions on 61 slots → '61/69 filled (88%) · 65 sessions'", () => {
    const input = baseInput();
    // the owner's reported Oct 5–11 shape: 4 double-booked slots (Oct 5 ×1,
    // Oct 7 ×1, Oct 11 ×2) → 65 sessions occupy 61 distinct of 69 slots.
    input.calendar.thisWeek = { appointments: 65, slotsOccupied: 61, capacity: 69 };
    input.calendar.nextWeek = { appointments: 12, slotsOccupied: 12, capacity: 63 };
    const text = buildWeeklyCcReportText(input);
    expect(text).toContain("This week: 61/69 filled (88%) · 65 sessions");
    // sessions == slots → no redundant sessions suffix
    expect(text).toContain("Next week: 12/63 filled (19%)\n");
  });

  test("honest states: no monthly goal → 'X/—'; zero conversion denominators → '—'; open-day '—'", () => {
    const input = baseInput();
    input.bookingsMonth.goal = null;
    input.conversion = { overall: null, family: null, animalia: null };
    input.calendar.thisWeek = { appointments: 5, slotsOccupied: 5, capacity: 0 };
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
  // Alliance/Auction LEADS: GHL opportunities on the channels' pipelines
  // (owner-verified source), bucketed by ET created date. One out-of-week and
  // one off-pipeline row prove the bucketing/filtering, not just the totals.
  await store.upsertOpportunities([
    { provider: "highlevel", external_id: "opp-al-1", name: null, status: "open", monetary_value: null, contact_id: null, rep_id: null, pipeline_id: ALLIANCE_PIPELINE_ID, stage_id: null, source_created_at: H("2026-09-22", "10:00"), source_updated_at: null },
    { provider: "highlevel", external_id: "opp-al-2", name: null, status: "won", monetary_value: null, contact_id: null, rep_id: null, pipeline_id: ALLIANCE_PIPELINE_ID, stage_id: null, source_created_at: H("2026-09-25", "15:00"), source_updated_at: null },
    { provider: "highlevel", external_id: "opp-au-1", name: null, status: "open", monetary_value: null, contact_id: null, rep_id: null, pipeline_id: AUCTION_PIPELINE_ID, stage_id: null, source_created_at: H("2026-09-26", "20:00"), source_updated_at: null },
    { provider: "highlevel", external_id: "opp-next", name: null, status: "open", monetary_value: null, contact_id: null, rep_id: null, pipeline_id: ALLIANCE_PIPELINE_ID, stage_id: null, source_created_at: H("2026-09-28", "12:00"), source_updated_at: null },
    { provider: "highlevel", external_id: "opp-other", name: null, status: "open", monetary_value: null, contact_id: null, rep_id: null, pipeline_id: "unrelated-pipeline", stage_id: null, source_created_at: H("2026-09-23", "12:00"), source_updated_at: null },
  ]);
  return store;
}

describe("weeklyPageData CC Report payload (MemoryStore, pinned today)", () => {
  test("channels counted from the week's wins; AA leads from GHL opportunities; website null; report text assembled", async () => {
    const store = await seedStore();
    await store.upsertWeeklyReportNotes({
      week_start: LW_MON,
      notes: { big3: "1. One\n2. Two\n3. Three", celebrate: "Custom celebrate." },
    });
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.channels).toEqual({ alliance: 1, auction: 1, website: null });
    // AA LEADS: 2 alliance + 1 auction in the report week (out-of-week and
    // off-pipeline opportunity rows excluded — see seedStore).
    expect(data.channelLeads).toEqual({ alliance: 2, auction: 1, website: null });
    expect(data.report.notes).toEqual({ big3: "1. One\n2. Two\n3. Three", celebrate: "Custom celebrate." });
    // stored note wins over the computed default (no attributions → no default anyway)
    expect(data.report.reportText).toContain("Celebrate / Top Performer: Custom celebrate.");
    expect(data.report.reportText).toContain("Big 3: 1. One");
    expect(data.report.reportText).toContain("Alliance — Leads: 2 · Bookings: 1");
    expect(data.report.reportText).toContain("Website — Leads: — · Bookings: —");
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
