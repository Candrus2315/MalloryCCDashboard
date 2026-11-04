/**
 * ONLINE BOOKINGS SECTION (owner directive 2026-11-04) — additive displays.
 *
 * The creator-rule engine (PR #151) writes verdict rows with reason_code
 * "online-booking" — proven client-created bookings, TEAM-ONLY credit (rep
 * NULL). This pins the four displays built on that state, ALL additive:
 *
 *   1. TODAY page — an "Online Bookings" section (list + count) over the
 *      current week + previous week; SSR from the store.
 *   2. UNATTRIBUTED QUEUE — online-booking rows LEAVE it (a known team-only
 *      category is not unknown credit); the queue keeps genuinely unknown
 *      rows only.
 *   3. DAILY REPORT — one team line "Online Bookings: N (team-only)" for the
 *      report day (template-tolerant: fixtures without the field keep the
 *      copied report byte-identical).
 *   4. WEEKLY CC REPORT — one count line "of which Online Bookings: N" inside
 *      the week's bookings context (same tolerance).
 *
 * Shared derivation everywhere: onlineBookingWins/countOnlineBookings — the
 * qualifying-win slice (win-bucket + isBookingWin + scope) intersected with
 * the STORED creator-rule verdicts. Team totals, rep math, goal math and
 * conversions never read these helpers.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDailyReportMetrics,
  buildUnattributedQueue,
  countOnlineBookings,
  onlineBookingWins,
  type AppointmentRow,
  type AttributionRow,
  type CallRow,
  type LeadRow,
} from "../metrics/compute";
import { buildDailyReportText } from "../metrics/report-text";
import { buildWeeklyCcReportText } from "../metrics/weekly-report-text";
import { MemoryStore } from "../store/memory";
import { todayPageData } from "../page-data";

// Week of Mon 2026-11-09 (EST, UTC-5) + the previous week Mon 2026-11-02.
// today = Friday, so the current week already has win dates ≤ today (a win is
// never dated in the future — deposit-date basis).
const TODAY = "2026-11-13";
const PREV_MON = "2026-11-02";
const WED = "2026-11-11";
const THU_NEXT = "2026-11-12";
const ET = (date: string, time: string) => new Date(`${date}T${time}:00.000-05:00`).toISOString();

/** A paid (win) appointment row with explicit win-bucket date. */
const winAppt = (id: string, over: Partial<AppointmentRow> = {}): AppointmentRow => ({
  id,
  acuity_appointment_id: `acuity-${id}`,
  contact_id: null,
  calendar_id: null,
  calendar_name: null,
  appointment_type: "Family Portrait Session",
  appointment_datetime: ET(THU_NEXT, "11:00"),
  created_at: ET(WED, "10:00"),
  created_business_date: WED,
  payment_state: "paid",
  booking_win_business_date: WED,
  status: "scheduled",
  cancelled: false,
  ...over,
});

/** The Lucas-shaped owner designation row (creator rule, PR #151 writer v8). */
const onlineRow = (appointmentId: string, over: Partial<AttributionRow> = {}): AttributionRow => ({
  id: `attr:${appointmentId}`,
  appointment_id: appointmentId,
  call_id: null,
  rep_id: null,
  method: "owner-designation",
  confidence: 1,
  manual_override: true,
  reason_code: "online-booking",
  note: "owner-designation — test",
  ...over,
});

// ---------- 1) the shared derivation ----------

describe("onlineBookingWins / countOnlineBookings — the one data source", () => {
  const appts = [
    // The designated online booking — a qualifying win: IN.
    winAppt("a-online", { client_name: "Lucas Finch" }),
    // A rep-attributed win: never in the section (rep credit).
    winAppt("a-rep", { client_name: "Rep Win", created_at: ET(WED, "11:00") }),
    // A designated row that is NOT a win (deposit unpaid): OUT.
    winAppt("a-pending", { payment_state: "pending_payment", booking_win_business_date: null }),
    // A designated row later cancelled: OUT (wins only).
    winAppt("a-cancelled", { cancelled: true, status: "cancelled" }),
  ];
  const attrs = [
    onlineRow("a-online"),
    {
      id: "attr:a-rep",
      appointment_id: "a-rep",
      call_id: null,
      rep_id: "r1",
      method: "manual",
      confidence: 1,
      manual_override: true,
      reason_code: null,
    },
    onlineRow("a-pending"),
    onlineRow("a-cancelled"),
  ];

  test("returns exactly the designated client-created WINS", () => {
    const rows = onlineBookingWins(appts, attrs);
    expect(rows.map((r) => r.id)).toEqual(["a-online"]);
    expect(countOnlineBookings(appts, attrs)).toBe(1);
  });

  test("rep precedence holds: an online-booking reason on a row WITH a rep is attributed, not online", () => {
    // attributionStateOf checks rep first — the section must never list a
    // rep-credited booking even if its stored reason_code says online.
    const rows = onlineBookingWins(
      [winAppt("a-both")],
      [onlineRow("a-both", { rep_id: "r1", method: "manual" })],
    );
    expect(rows).toHaveLength(0);
  });

  test("no stored verdict row → not in the section (honest gap, never guessed)", () => {
    expect(onlineBookingWins([winAppt("a-ghost")], [])).toHaveLength(0);
  });
});

// ---------- 2) the queue keeps genuinely unknown rows only ----------

describe("buildUnattributedQueue — online-booking rows leave the queue", () => {
  const queueInput = (over: Partial<Parameters<typeof buildUnattributedQueue>[0]> = {}) => ({
    appointments: [
      winAppt("a-lucas", { client_name: "Lucas Finch" }),
      winAppt("a-unknown", { client_name: "Unknown Client", created_at: ET(WED, "12:00") }),
    ] as unknown as Parameters<typeof buildUnattributedQueue>[0]["appointments"],
    attributions: [] as AttributionRow[],
    calls: [] as CallRow[],
    contacts: [],
    thresholdSeconds: 120,
    ...over,
  });

  test("the designated online booking is NOT queue material; the unknown win stays", () => {
    const rows = buildUnattributedQueue(
      queueInput({
        attributions: [onlineRow("a-lucas"), onlineRow("a-unknown", { reason_code: "no-matching-contact", manual_override: false, method: "none" })],
      }),
    );
    expect(rows.map((r) => r.appointment_id)).toEqual(["a-unknown"]);
    expect(rows[0]!.reason_code).toBe("no-matching-contact");
  });

  test("a withoutVerdict win still queues (genuinely unknown until a verdict exists)", () => {
    const rows = buildUnattributedQueue(queueInput({ attributions: [onlineRow("a-lucas")] }));
    expect(rows.map((r) => r.appointment_id)).toEqual(["a-unknown"]);
  });

  test("no stored verdicts at all → both queue (pre-#151 behavior for unknowns)", () => {
    const rows = buildUnattributedQueue(queueInput({}));
    expect(rows.map((r) => r.appointment_id).sort()).toEqual(["a-lucas", "a-unknown"]);
  });
});

// ---------- 3) the Daily Report team line ----------

describe("Daily Report — Online Bookings team line (additive)", () => {
  const buildMetrics = () =>
    buildDailyReportMetrics({
      reportDate: TODAY,
      callsAnchorDay: [],
      // The anchor-day win slice: one online + one rep win — the team total
      // (bookingsAnchorDay) counts BOTH; the online line counts ONE.
      apptsCreatedAnchorDay: [winAppt("a-online", { client_name: "Lucas Finch" }), winAppt("a-rep")],
      apptsCreatedWtd: [winAppt("a-online", { client_name: "Lucas Finch" }), winAppt("a-rep")],
      allCallsForWeek: [],
      attributions: [onlineRow("a-online")],
      leadsAllRecent: [] as LeadRow[],
      teamBookingGoal: 79,
      weeklyLeadBudget: 700,
      thresholdSeconds: 120,
      etNowMinutes: 9 * 60,
    });

  test("the builder computes the count from the SAME qualifying slice (team total includes online)", () => {
    const m = buildMetrics();
    expect(m.bookingsAnchorDay).toBe(2);
    expect(m.onlineBookingsAnchorDay).toBe(1);
  });

  test("the copied report carries 'Online Bookings: N (team-only)' right under the Bookings line", () => {
    const m = buildMetrics();
    const lines = buildDailyReportText(m, {}).split("\n");
    const bookingsIdx = lines.findIndex((l) => l.startsWith("Bookings "));
    expect(lines[bookingsIdx + 1]).toBe(`Online Bookings: ${m.onlineBookingsAnchorDay} (team-only)`);
    expect(lines[bookingsIdx + 1]).toContain("(team-only)");
  });

  test("template tolerance: a metrics object without the field renders byte-identical (no line)", () => {
    const m = buildMetrics();
    const withField = buildDailyReportText(m, {});
    const { onlineBookingsAnchorDay: _omit, ...legacy } = m;
    const legacyText = buildDailyReportText(legacy as typeof m, {});
    expect(legacyText).not.toContain("Online Bookings:");
    // The new line is the ONLY delta between the two texts.
    expect(withField.replace(`Online Bookings: ${m.onlineBookingsAnchorDay} (team-only)\n`, "")).toBe(legacyText);
  });
});

// ---------- 4) the Weekly CC Report count line ----------

describe("Weekly CC Report — 'of which Online Bookings: N' (additive)", () => {
  const base = {
    week: { start: PREV_MON, end: "2026-11-08" },
    monthKey: "2026-11",
    bookingsWeek: { total: 3, goal: 79 as number | null },
    bookingsMonth: { total: 10, goal: 316 as number | null },
    channels: { alliance: 0, auction: 0, website: null as number | null },
    channelLeads: { alliance: 0, auction: 0, website: null as number | null },
    leads: {
      family: 0, animalia: 0, fairyland: 0,
      auction_register_certificate: 0, google_ads_leads: 0,
      alliance_activate_certificate: 0, website_applications: 0,
      total: 0,
    },
    funnel: { wins: 3, leads: 0, pct: null },
    calendar: {
      thisWeek: { appointments: 0, slotsOccupied: 0, capacity: 0 },
      nextWeek: { appointments: 0, slotsOccupied: 0, capacity: 0 },
      beyond: 0,
      firstFullyOpenDay: null,
    },
    holes: null,
    notes: {},
    celebrateDefault: null,
  };

  test("renders 'of which Online Bookings: N' directly under the Bookings (Week) line", () => {
    const text = buildWeeklyCcReportText({ ...base, onlineBookingsWeek: 1 });
    const lines = text.split("\n");
    const weekIdx = lines.findIndex((l) => l.startsWith("Bookings (Week):"));
    expect(weekIdx).toBeGreaterThanOrEqual(0);
    expect(lines[weekIdx + 1]).toBe("of which Online Bookings: 1");
  });

  test("template tolerance: absent input keeps the report byte-identical", () => {
    const legacyText = buildWeeklyCcReportText({ ...base });
    expect(legacyText).not.toContain("of which Online Bookings:");
    const newText = buildWeeklyCcReportText({ ...base, onlineBookingsWeek: 2 });
    const legacyLines = legacyText.split("\n");
    const newLines = newText.split("\n");
    expect(newLines.length).toBe(legacyLines.length + 1);
    expect(newLines.filter((l) => l !== "of which Online Bookings: 2")).toEqual(legacyLines);
  });

  test("zero renders as 0 (honest count, never omitted or dash)", () => {
    const text = buildWeeklyCcReportText({ ...base, onlineBookingsWeek: 0 });
    expect(text).toContain("of which Online Bookings: 0");
  });
});

// ---------- 5) TODAY page payload end-to-end (SSR from the store) ----------

describe("todayPageData — Online Bookings section payload", () => {
  async function seedStore() {
    const store = new MemoryStore();
    await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
    await store.upsertUsers([
      { id: "u-src-1", provider: "highlevel", external_id: "hl-1", name: "Rep One", email: null, is_active: true, call_start_date: null },
    ]);
    await store.upsertAppointments([
      // Current-week designated online booking (the Lucas shape).
      { ...winAppt("appt-online-cur"), acuity_appointment_id: "1800632924", client_name: "Lucas Finch", appointment_datetime: ET(THU_NEXT, "11:00") },
      // Previous-week designated online booking (inside the section window).
      {
        ...winAppt("appt-online-prev"),
        acuity_appointment_id: "1800630001",
        client_name: "Prev Week Online",
        appointment_datetime: ET("2026-11-06", "11:00"),
        created_at: ET("2026-11-05", "10:00"),
        booking_win_business_date: "2026-11-05",
        created_business_date: "2026-11-05",
      },
      // Current-week rep-attributed win — never in the section.
      { ...winAppt("appt-rep-win"), acuity_appointment_id: "1800630002", client_name: "Rep Win", created_at: ET(WED, "11:00") },
      // Designated but unpaid — not a win, never in the section.
      { ...winAppt("appt-online-pending"), acuity_appointment_id: "1800630003", client_name: "Pending Online", payment_state: "pending_payment", booking_win_business_date: null },
    ]);
    // MEMORY STORE CONTRACT: the store assigns its OWN canonical ids on upsert
    // (keyed by provider external id) — verdict rows must reference the ids
    // read BACK from the store, never the seed ids.
    const canon = new Map(
      (await store.getAppointmentsByWinBusinessDateBetween("2026-11-01", "2026-11-30")).map((a) => [a.acuity_appointment_id, a.id]),
    );
    const repId = (await store.getAllUsers())[0]!.id;
    await store.upsertAttributions([
      onlineRow(canon.get("1800632924")!),
      onlineRow(canon.get("1800630001")!),
      {
        id: "attr:appt-rep-win",
        appointment_id: canon.get("1800630002")!,
        call_id: null,
        rep_id: repId,
        method: "manual",
        confidence: 1,
        manual_override: true,
        reason_code: null,
      },
      onlineRow(canon.get("1800630003")!),
    ]);
    return store;
  }

  test("lists the designated wins of current + previous week, newest first, team-only rows", async () => {
    const store = await seedStore();
    const data = await todayPageData({ store, today: TODAY });
    const rows = data.onlineBookings;
    expect(rows.map((r) => r.client_name)).toEqual(["Lucas Finch", "Prev Week Online"]);
    const lucas = rows[0]!;
    expect(lucas.acuity_appointment_id).toBe("1800632924");
    expect(lucas.booked_date).toBe(WED);
    expect(lucas.session_date).toBe(THU_NEXT);
    expect(lucas.appointment_type).toBe("Family Portrait Session");
    // Team-only: the payload rows carry NO rep fields at all.
    for (const r of rows) {
      expect(Object.keys(r)).not.toContain("rep_id");
      expect(Object.keys(r)).not.toContain("rep_name");
    }
  });

  test("team totals are UNCHANGED in shape — online wins already counted (wtd includes them)", async () => {
    const store = await seedStore();
    const data = await todayPageData({ store, today: TODAY });
    // WTD = current-week qualifying wins: the online win + the rep win
    // (the pending designated row never counted and still does not).
    expect(data.metrics.bookings.wtd).toBe(2);
  });
});
