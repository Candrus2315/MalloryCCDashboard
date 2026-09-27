/**
 * AVAILABILITY ENGINE + PAYLOAD tests (MemoryStore fixtures, no live API).
 *
 * Truth table per the lead's brief and design/availability-spec.md:
 *  - a canceled appointment FREES its slot (never occupies capacity);
 *  - a rescheduled appointment (same Acuity id, new datetime) occupies ONLY
 *    the new slot — one row, upsert moved it;
 *  - blocked time removes slots (blockedCount) — never open, never booked;
 *  - padding removes ADJACENT slots around an appointment;
 *  - capacity 0 → utilization null (never a fake 0%);
 *  - ET boundary: 03:59Z belongs to the PREVIOUS ET day, 04:00Z to the new one
 *    (EDT, UTC-4);
 *  - scope empty selection = EVERYTHING counts; explicit selection filters;
 *  - payload: 7 days, connection honesty (demo/live/disconnected/stale),
 *    filters from settings.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { computeDayAvailability, appointmentInScope } from "../metrics/availability";
import { computeOpenSlots, materializeRecurringBlocks, type AppointmentRow, type AvailabilityRule, type BlockedTimeRow } from "../metrics/compute";
import { availabilityPageData } from "../page-data";
import { etDayStartUtc, addDays } from "../date-logic";

// Monday 2026-09-28 (EDT, UTC-4): ET midnight = 04:00Z
const MON = "2026-09-28";
const SUN = "2026-09-27";
// 10:00 ET on MON in UTC:
const MON_10ET = "2026-09-28T14:00:00.000Z";
const MON_11_30ET = "2026-09-28T15:30:00.000Z";
const MON_13ET = "2026-09-28T17:00:00.000Z";

const WEEKDAY_RULES: AvailabilityRule[] = [
  { weekday: 1, open_time: "10:00", close_time: "18:00", active: true },
  { weekday: 0, open_time: "10:00", close_time: "16:00", active: false }, // Sunday closed
];
// slot math: interval 90, duration 60 → 10:00, 11:30, 13:00, 14:30, 16:00 (5 slots)
const SLOT_INPUT = { slotIntervalMin: 90, durationMin: 60, paddingMin: 0 };

const appt = (datetime: string, extra: Partial<AppointmentRow> = {}): AppointmentRow => ({
  id: extra.id ?? `apt-${datetime}`,
  contact_id: null,
  calendar_id: "cal-family",
  calendar_name: "Family Studio",
  acuity_appointment_id: "a1",
  appointment_type: "Family Session",
  appointment_datetime: datetime,
  created_at: "2026-09-20T15:00:00.000Z",
  status: "scheduled",
  cancelled: false,
  duration_minutes: 60,
  ...extra,
});

const block = (start: string, end: string, id = "b1"): BlockedTimeRow => ({ id, start_at: start, end_at: end, reason: "photo shoot" });

const ET = (date: string, hhmm: string, durMin = 60): BlockedTimeRow => {
  // build a UTC interval from an ET clock time on an ET date (fixed EDT offset in fixtures)
  const [h, m] = hhmm.split(":").map(Number);
  const startMs = new Date(etDayStartUtc(date)).getTime() + (h * 60 + m) * 60_000;
  return { id: "b", start_at: new Date(startMs).toISOString(), end_at: new Date(startMs + durMin * 60_000).toISOString(), reason: null };
};

describe("computeDayAvailability (engine truth table)", () => {
  test("empty day: capacity from studio hours, zero booked, utilization 0", () => {
    const day = computeDayAvailability({ date: MON, rules: WEEKDAY_RULES, blocked: [], appointments: [], ...SLOT_INPUT });
    expect(day.totalCapacity).toBe(5);
    expect(day.booked).toBe(0);
    expect(day.openSlotTimes).toEqual(["10:00 AM", "11:30 AM", "1:00 PM", "2:30 PM", "4:00 PM"].map((s) => s));
    expect(day.utilization).toBe(0);
    expect(day.blockedCount).toBe(0);
  });

  test("a booked appointment occupies its slot: booked 1, open 4, utilization 0.2", () => {
    const day = computeDayAvailability({ date: MON, rules: WEEKDAY_RULES, blocked: [], appointments: [appt(MON_10ET)], ...SLOT_INPUT });
    expect(day.booked).toBe(1);
    expect(day.totalCapacity).toBe(5);
    expect(day.openSlotTimes).toHaveLength(4);
    expect(day.openSlotTimes).not.toContain("10:00 AM");
    expect(day.utilization).toBeCloseTo(0.2);
  });

  test("CANCELED appointment frees its slot (never occupies capacity)", () => {
    const day = computeDayAvailability({
      date: MON,
      rules: WEEKDAY_RULES,
      blocked: [],
      appointments: [appt(MON_10ET, { cancelled: true, status: "cancelled" })],
      ...SLOT_INPUT,
    });
    expect(day.booked).toBe(0);
    expect(day.openSlotTimes).toContain("10:00 AM");
    expect(day.openSlotTimes).toHaveLength(5);
  });

  test("per-appointment duration is respected (a 120-minute appointment eats two slot positions)", () => {
    // appointment 11:30–13:30 ET with a 120-minute duration overlaps BOTH the
    // 11:30 and 13:00 slot positions; a 60-minute one would eat only its own
    const long = computeDayAvailability({
      date: MON, rules: WEEKDAY_RULES, blocked: [],
      appointments: [appt(MON_11_30ET, { duration_minutes: 120 })], ...SLOT_INPUT,
    });
    const short = computeDayAvailability({
      date: MON, rules: WEEKDAY_RULES, blocked: [],
      appointments: [appt(MON_11_30ET, { duration_minutes: 60 })], ...SLOT_INPUT,
    });
    expect(long.booked).toBe(2);
    expect(long.utilization).toBeCloseTo(0.4);
    expect(short.booked).toBe(1);
  });

  test("BLOCKED time removes slots: blockedCount counts them, open excludes them, booked+blocked+open=capacity", () => {
    const day = computeDayAvailability({
      date: MON,
      rules: WEEKDAY_RULES,
      blocked: [ET(MON, "11:30", 60)],
      appointments: [appt(MON_10ET)],
      ...SLOT_INPUT,
    });
    expect(day.booked).toBe(1);
    expect(day.blockedCount).toBe(1);
    expect(day.openSlotTimes).not.toContain("11:30 AM");
    expect(day.openSlotTimes).toHaveLength(3);
    expect(day.booked + day.blockedCount + day.openSlotTimes.length).toBe(day.totalCapacity);
  });

  test("PADDING removes the adjacent slots around an appointment from OPEN as blockedCount — booked stays true occupancy (S4b hardening)", () => {
    // hourly grid, 60-minute appointment 11:00–12:00 ET: without padding only
    // its own slot is booked; with 15 minutes of padding the turnover buffer
    // (10:45–12:15) also removes the adjacent 10:00 and 12:00 slots from open
    // — as BLOCKED (turnover), never as booked (the owner-caught trap: 6 real
    // bookings rendered 9/9 FULL when buffers inflated booked).
    const appt11 = appt("2026-09-28T15:00:00.000Z"); // 11:00 ET
    const hourly = { slotIntervalMin: 60, durationMin: 60, paddingMin: 0 };
    const without = computeDayAvailability({ date: MON, rules: WEEKDAY_RULES, blocked: [], appointments: [appt11], ...hourly });
    expect(without.booked).toBe(1);
    expect(without.openSlotTimes).toContain("10:00 AM");
    expect(without.openSlotTimes).toContain("12:00 PM");
    const withPad = computeDayAvailability({
      date: MON, rules: WEEKDAY_RULES, blocked: [], appointments: [appt11],
      slotIntervalMin: 60, durationMin: 60, paddingMin: 15,
    });
    expect(withPad.booked).toBe(1); // ONLY the session's own slot is booked
    expect(withPad.blockedCount).toBe(2); // 10:00 + 12:00 buffer-only slots
    expect(withPad.openSlotTimes).not.toContain("10:00 AM");
    expect(withPad.openSlotTimes).not.toContain("12:00 PM");
    expect(withPad.booked + withPad.blockedCount + withPad.openSlotTimes.length).toBe(withPad.totalCapacity);
  });

  test("capacity 0 (closed weekday) → utilization null, never a fake 0%", () => {
    const day = computeDayAvailability({ date: SUN, rules: WEEKDAY_RULES, blocked: [], appointments: [], ...SLOT_INPUT });
    expect(day.totalCapacity).toBe(0);
    expect(day.utilization).toBeNull();
    expect(day.openSlotTimes).toEqual([]);
  });

  test("no rule for the weekday at all → zero-capacity honest day", () => {
    const day = computeDayAvailability({ date: "2026-09-29", rules: WEEKDAY_RULES, blocked: [], appointments: [], ...SLOT_INPUT });
    expect(day.totalCapacity).toBe(0);
    expect(day.utilization).toBeNull();
  });

  test("ET boundary: 03:59Z belongs to the PREVIOUS ET day, 04:00Z to the new one (EDT)", () => {
    // Monday open 00:00–08:00 ET, Sunday open 22:00–24:00 ET, so the ET
    // midnight boundary (04:00Z in September) sits inside studio hours.
    const boundaryRules: AvailabilityRule[] = [
      { weekday: 1, open_time: "00:00", close_time: "08:00", active: true },
      { weekday: 0, open_time: "22:00", close_time: "24:00", active: true },
    ];
    const grid = { slotIntervalMin: 60, durationMin: 60, paddingMin: 0 };

    // a 1-minute session at 23:59 ET (2026-09-28T03:59Z) ends exactly at ET
    // midnight: it belongs to SUNDAY 9/27 and must NOT touch Monday's slots
    const lateSunday = appt("2026-09-28T03:59:00.000Z", { duration_minutes: 1 });
    const mondayOfSundaySession = computeDayAvailability({
      date: MON, rules: boundaryRules, blocked: [], appointments: [lateSunday], ...grid,
    });
    expect(mondayOfSundaySession.booked).toBe(0);
    const sundayOfSundaySession = computeDayAvailability({
      date: SUN, rules: boundaryRules, blocked: [], appointments: [lateSunday], ...grid,
    });
    expect(sundayOfSundaySession.booked).toBe(1); // occupies Sunday's 11:00 PM slot

    // one second later (04:00Z = midnight ET) the session belongs to MONDAY
    const midnightMonday = appt("2026-09-28T04:00:00.000Z", { duration_minutes: 60 });
    const mondayOfMidnightSession = computeDayAvailability({
      date: MON, rules: boundaryRules, blocked: [], appointments: [midnightMonday], ...grid,
    });
    expect(mondayOfMidnightSession.booked).toBe(1); // Monday's 12:00 AM slot
    const sundayOfMidnightSession = computeDayAvailability({
      date: SUN, rules: boundaryRules, blocked: [], appointments: [midnightMonday], ...grid,
    });
    expect(sundayOfMidnightSession.booked).toBe(0);
  });

  test("scope: EMPTY selection counts EVERYTHING (owner rule)", () => {
    const appts = [
      appt(MON_10ET, { calendar_name: "Mystery Calendar", calendar_id: "cal-z", appointment_type: "Whatever" }),
      appt(MON_11_30ET, { acuity_appointment_id: "a2" }),
    ];
    const day = computeDayAvailability({
      date: MON,
      rules: WEEKDAY_RULES,
      blocked: [],
      appointments: appts,
      scope: { calendars_included: [], types_included: [] },
      ...SLOT_INPUT,
    });
    expect(day.booked).toBe(2);
  });

  test("scope: explicit calendar selection excludes other calendars (by name or id)", () => {
    const appts = [
      appt(MON_10ET), // Family Studio
      appt(MON_11_30ET, { acuity_appointment_id: "a2", calendar_name: "Animalia Studio", calendar_id: "cal-animalia" }),
      appt(MON_13ET, { acuity_appointment_id: "a3", calendar_name: "Other", calendar_id: "cal-other" }),
    ];
    const byName = computeDayAvailability({
      date: MON, rules: WEEKDAY_RULES, blocked: [], appointments: appts,
      scope: { calendars_included: ["Family Studio"], types_included: [] }, ...SLOT_INPUT,
    });
    expect(byName.booked).toBe(1);
    const byId = computeDayAvailability({
      date: MON, rules: WEEKDAY_RULES, blocked: [], appointments: appts,
      scope: { calendars_included: ["cal-animalia"], types_included: [] }, ...SLOT_INPUT,
    });
    expect(byId.booked).toBe(1);
  });

  test("scope: explicit type selection filters by appointment_type; calendar name null + id match still counts", () => {
    const appts = [
      appt(MON_10ET, { appointment_type: "Family Session" }),
      appt(MON_11_30ET, { acuity_appointment_id: "a2", appointment_type: "Pet Session" }),
    ];
    const byType = computeDayAvailability({
      date: MON, rules: WEEKDAY_RULES, blocked: [], appointments: appts,
      scope: { calendars_included: [], types_included: ["Family Session"] }, ...SLOT_INPUT,
    });
    expect(byType.booked).toBe(1);
    const idOnlyRow: AppointmentRow = { ...appt(MON_10ET), calendar_name: null, calendar_id: "cal-9" };
    expect(appointmentInScope(idOnlyRow, { calendars_included: ["cal-9"], types_included: [] })).toBe(true);
    expect(appointmentInScope(idOnlyRow, { calendars_included: ["cal-1"], types_included: [] })).toBe(false);
  });

  test("unparseable appointment datetime is skipped, not guessed into a slot", () => {
    const day = computeDayAvailability({
      date: MON, rules: WEEKDAY_RULES, blocked: [],
      appointments: [appt("not-a-timestamp")], ...SLOT_INPUT,
    });
    expect(day.booked).toBe(0);
  });
});

describe("TWO-BLOCK DAILY SCHEDULE (owner directive 2026-09-27: multiple hour-blocks per weekday)", () => {
  // Real studio schedule, EVERY day: morning 09:00–13:00 (the 12:00 session
  // runs to 1:00pm) + afternoon 13:30–18:30, hourly slots → exactly 9 starts.
  // The rules array is deliberately listed out of time order: the engine must
  // concatenate the blocks in TIME order regardless of storage order.
  const TWO_BLOCK_RULES: AvailabilityRule[] = [
    { weekday: 1, open_time: "13:30", close_time: "18:30", active: true },
    { weekday: 1, open_time: "09:00", close_time: "13:00", active: true },
  ];
  const HOURLY = { slotIntervalMin: 60, durationMin: 60, paddingMin: 0 };
  const EXPECTED_9 = [
    "9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM",
    "1:30 PM", "2:30 PM", "3:30 PM", "4:30 PM", "5:30 PM",
  ];

  test("two-block day produces exactly the 9 expected start times, concatenated in time order", () => {
    const day = computeDayAvailability({ date: MON, rules: TWO_BLOCK_RULES, blocked: [], appointments: [], ...HOURLY });
    expect(day.openSlotTimes).toEqual(EXPECTED_9);
    expect(day.totalCapacity).toBe(9);
    expect(day.booked).toBe(0);
    expect(day.blockedCount).toBe(0);
    expect(day.utilization).toBe(0);
  });

  test("per-block invariants: morning-only 4 slots, afternoon-only 5, day = 4 + 5 = 9", () => {
    const morningOnly = computeDayAvailability({ date: MON, rules: [TWO_BLOCK_RULES[1]], blocked: [], appointments: [], ...HOURLY });
    const afternoonOnly = computeDayAvailability({ date: MON, rules: [TWO_BLOCK_RULES[0]], blocked: [], appointments: [], ...HOURLY });
    expect(morningOnly.totalCapacity).toBe(4);
    expect(morningOnly.openSlotTimes).toEqual(EXPECTED_9.slice(0, 4));
    expect(afternoonOnly.totalCapacity).toBe(5);
    expect(afternoonOnly.openSlotTimes).toEqual(EXPECTED_9.slice(4));
    const both = computeDayAvailability({ date: MON, rules: TWO_BLOCK_RULES, blocked: [], appointments: [], ...HOURLY });
    expect(both.totalCapacity).toBe(morningOnly.totalCapacity + afternoonOnly.totalCapacity);
    expect(both.booked + both.blockedCount + both.openSlotTimes.length).toBe(both.totalCapacity);
  });

  test("a 12:00–13:00 booking (the session that runs to 1pm) removes ONLY its own slot; neither block corrupts", () => {
    const day = computeDayAvailability({
      date: MON, rules: TWO_BLOCK_RULES, blocked: [],
      appointments: [appt("2026-09-28T16:00:00.000Z")], // 12:00 ET, 60 min
      ...HOURLY,
    });
    expect(day.booked).toBe(1);
    expect(day.openSlotTimes).toEqual(EXPECTED_9.filter((s) => s !== "12:00 PM"));
    // morning block: 4 slots − 1 booked = 3 open; afternoon block untouched: 5 open
    expect(day.totalCapacity).toBe(9);
    expect(day.booked + day.blockedCount + day.openSlotTimes.length).toBe(day.totalCapacity);
  });

  test("a booking SPANNING the lunch gap (12:30–14:00, 90 min) removes exactly one slot per block", () => {
    const day = computeDayAvailability({
      date: MON, rules: TWO_BLOCK_RULES, blocked: [],
      appointments: [appt("2026-09-28T16:30:00.000Z", { duration_minutes: 90 })], // 12:30–14:00 ET
      ...HOURLY,
    });
    // overlaps the 12:00 slot (morning block) and the 1:30 slot (afternoon
    // block); the gap itself holds no slot, so nothing else moves
    expect(day.booked).toBe(2);
    expect(day.openSlotTimes).toEqual(EXPECTED_9.filter((s) => s !== "12:00 PM" && s !== "1:30 PM"));
    expect(day.booked + day.blockedCount + day.openSlotTimes.length).toBe(day.totalCapacity);
  });

  test("blocked time INSIDE the gap (13:00–13:30) touches no slot: counts stay exact", () => {
    const day = computeDayAvailability({
      date: MON, rules: TWO_BLOCK_RULES,
      blocked: [ET(MON, "13:00", 30)],
      appointments: [], ...HOURLY,
    });
    expect(day.blockedCount).toBe(0);
    expect(day.openSlotTimes).toEqual(EXPECTED_9);
    expect(day.totalCapacity).toBe(9);
  });

  test("a day with only ONE active block still works (the other inactive)", () => {
    const morningOnly = computeDayAvailability({
      date: MON,
      rules: [
        { weekday: 1, open_time: "09:00", close_time: "13:00", active: true },
        { weekday: 1, open_time: "13:30", close_time: "18:30", active: false },
      ],
      blocked: [], appointments: [], ...HOURLY,
    });
    expect(morningOnly.totalCapacity).toBe(4);
    expect(morningOnly.openSlotTimes).toEqual(EXPECTED_9.slice(0, 4));
    const afternoonOnly = computeDayAvailability({
      date: MON,
      rules: [
        { weekday: 1, open_time: "09:00", close_time: "13:00", active: false },
        { weekday: 1, open_time: "13:30", close_time: "18:30", active: true },
      ],
      blocked: [], appointments: [], ...HOURLY,
    });
    expect(afternoonOnly.totalCapacity).toBe(5);
    expect(afternoonOnly.openSlotTimes).toEqual(EXPECTED_9.slice(4));
  });

  test("both blocks inactive → honest closed day (capacity 0, utilization null)", () => {
    const day = computeDayAvailability({
      date: MON,
      rules: [
        { weekday: 1, open_time: "09:00", close_time: "13:00", active: false },
        { weekday: 1, open_time: "13:30", close_time: "18:30", active: false },
      ],
      blocked: [], appointments: [], ...HOURLY,
    });
    expect(day.totalCapacity).toBe(0);
    expect(day.utilization).toBeNull();
    expect(day.openSlotTimes).toEqual([]);
  });
});

describe("computeOpenSlots delegation (Today page parity)", () => {
  test("computeOpenSlots returns exactly the engine's openSlotTimes", () => {
    const appointments = [appt(MON_10ET)];
    const blocked = [ET(MON, "14:30", 60)];
    const viaEngine = computeDayAvailability({ date: MON, rules: WEEKDAY_RULES, blocked, appointments, ...SLOT_INPUT });
    const today = computeOpenSlots({ date: MON, rules: WEEKDAY_RULES, blocked, appointments, ...SLOT_INPUT });
    expect(today).toEqual(viaEngine.openSlotTimes);
  });

  test("recurring blocks materialize per day and remove slots through the same engine", () => {
    const recurring = [{ id: "rb1", weekday: 1, start_time: "10:00", end_time: "11:30", reason: "standup", active: true }];
    const materialized = materializeRecurringBlocks(MON, recurring);
    const day = computeDayAvailability({ date: MON, rules: WEEKDAY_RULES, blocked: materialized, appointments: [], ...SLOT_INPUT });
    expect(day.blockedCount).toBe(1);
    expect(day.openSlotTimes).not.toContain("10:00 AM");
  });
});

describe("RESCHEDULE (one row moves to the new time — store upsert semantics)", () => {
  test("same Acuity id upserted with a new datetime: old slot free, new slot booked, ONE row", async () => {
    const store = new MemoryStore();
    const base = {
      acuity_appointment_id: "a1",
      contact_id: null,
      calendar_id: "cal-family",
      calendar_name: "Family Studio",
      appointment_type: "Family Session",
      created_at: "2026-09-20T15:00:00.000Z",
      status: "scheduled",
      cancelled: false,
      client_name: "Jane Doe",
      client_phone: "+19175550142",
      client_email: "jane@example.com",
      duration_minutes: 60,
    };
    await store.upsertAppointments([{ ...base, appointment_datetime: MON_10ET }]);
    // Acuity reschedule: SAME id, new datetime
    await store.upsertAppointments([{ ...base, appointment_datetime: MON_13ET }]);
    const rows = await store.getAppointmentsOverlapping(etDayStartUtc(MON), etDayStartUtc(addDays(MON, 1)));
    expect(rows).toHaveLength(1);
    expect(rows[0].appointment_datetime).toBe(MON_13ET);

    const day = computeDayAvailability({ date: MON, rules: WEEKDAY_RULES, blocked: [], appointments: rows, ...SLOT_INPUT });
    expect(day.booked).toBe(1);
    expect(day.openSlotTimes).not.toContain("1:00 PM");
    expect(day.openSlotTimes).toContain("10:00 AM"); // old slot is open again
  });
});

describe("availabilityPageData payload (playbook contract, MemoryStore + pinned today)", () => {
  test("7 days from today, engine shapes, filters from settings, honest disconnected state", async () => {
    const store = new MemoryStore();
    const data = await availabilityPageData({ store, today: MON });
    expect(data.today).toBe(MON);
    expect(data.days).toHaveLength(7);
    expect(data.days.map((d) => d.date)).toEqual(Array.from({ length: 7 }, (_, i) => addDays(MON, i)));
    // Monday: 9 slots from the DEFAULT two-block studio schedule (owner
    // directive 2026-09-27: 09:00–13:00 + 13:30–18:30, 60-min interval/duration)
    expect(data.days[0].totalCapacity).toBe(9);
    expect(data.days[0].openSlotTimes).toEqual([
      "9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM",
      "1:30 PM", "2:30 PM", "3:30 PM", "4:30 PM", "5:30 PM",
    ]);
    expect(data.days[0].utilization).toBe(0);
    expect(data.connection).toEqual({ connected: false, mode: "disconnected", lastSyncAt: null, stale: false });
    // default scope is EMPTY = everything counts (owner rule) — the live
    // account's calendars share no name with demo-era defaults, and an empty
    // default can never hide real bookings (phantom openings)
    expect(data.filters).toEqual({ calendars: [], types: [] });
    expect(data.warnings.some((w) => w.includes("Acuity connection required"))).toBe(true);
  });

  test("booked appointments flow into the payload; connection honesty: disconnected → demo → live", async () => {
    const store = new MemoryStore();
    const base = {
      acuity_appointment_id: "a1",
      contact_id: null,
      calendar_id: "cal-family",
      calendar_name: "Family Studio",
      appointment_type: "Family Session",
      created_at: "2026-09-20T15:00:00.000Z",
      status: "scheduled",
      cancelled: false,
      duration_minutes: 60,
    };
    await store.upsertAppointments([{ ...base, appointment_datetime: MON_10ET }]);
    // no connection row yet → honest "disconnected" (we don't know the state)
    const noRow = await availabilityPageData({ store, today: MON });
    // default two-block hours carry 15-min padding: the 10:00–11:00 ET session
    // books its OWN slot; the turnover buffer 9:45–11:15 removes the 9:00 and
    // 11:00 morning slots from open as blockedCount (S4b hardening — booked
    // is true occupancy, never buffer-inflated)
    expect(noRow.days[0].booked).toBe(1);
    expect(noRow.days[0].blockedCount).toBe(2);
    expect(noRow.days[0].openSlotTimes).not.toContain("10:00 AM");
    expect(noRow.days[0].openSlotTimes).not.toContain("9:00 AM");
    expect(noRow.days[0].openSlotTimes).not.toContain("11:00 AM");
    // the afternoon block is untouched by a morning session
    expect(noRow.days[0].openSlotTimes).toContain("1:30 PM");
    expect(noRow.connection.mode).toBe("disconnected");

    // demo-labeled connection row (demo dataset state) → mode demo, not connected
    const nowDemo = new Date().toISOString();
    await store.upsertConnection({
      provider: "acuity", status: "demo", is_demo: true, last_sync_at: nowDemo,
      last_successful_sync_at: nowDemo, last_error: null, config: {},
    });
    const demo = await availabilityPageData({ store, today: MON });
    expect(demo.connection).toMatchObject({ connected: false, mode: "demo" });

    // live + fresh → connected/live, no outdated warning
    const nowIso = new Date().toISOString();
    await store.upsertConnection({
      provider: "acuity", status: "connected", is_demo: false, last_sync_at: nowIso,
      last_successful_sync_at: nowIso, last_error: null, config: {},
    });
    const live = await availabilityPageData({ store, today: MON });
    expect(live.connection).toMatchObject({ connected: true, mode: "live", stale: false });
    expect(live.warnings.some((w) => w.includes("outdated"))).toBe(false);
  });

  test("stale live connection warns 'Availability may be outdated'", async () => {
    const store = new MemoryStore();
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await store.upsertConnection({
      provider: "acuity", status: "connected", is_demo: false, last_sync_at: old,
      last_successful_sync_at: old, last_error: null, config: {},
    });
    const data = await availabilityPageData({ store, today: MON });
    expect(data.connection.stale).toBe(true);
    expect(data.connection.connected).toBe(true);
    expect(data.warnings.some((w) => w.includes("Availability may be outdated"))).toBe(true);
  });
});
