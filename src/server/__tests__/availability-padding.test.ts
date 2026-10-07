/**
 * S4b PART B — AVAILABILITY PADDING HARDENING (owner-caught trap).
 *
 * Pre-S4b, padding was folded INTO the appointment's busy interval, so a slot
 * overlapping only the turnover BUFFER counted as booked — 6 real bookings
 * rendered a 9/9 FULL day. The hardened engine:
 *   - booked  = slots the appointment SESSION itself occupies;
 *   - blocked = slots overlapping only the padding BUFFER (plus real blocks);
 *   - open    = the rest;
 *   - booked + blocked + open === capacity, per block and per day;
 *   - paddingMin = 0 reproduces the pre-S4b engine byte-for-byte (regression
 *     net: the inline reference implementation below IS the old algorithm).
 */
import { describe, expect, test } from "bun:test";
import { computeDayAvailability } from "../metrics/availability";
import type { AppointmentRow, AvailabilityRule, BlockedTimeRow } from "../metrics/compute";

// 2026-09-30 is a WEDNESDAY (weekday 3); September = EDT = UTC−4 →
// 10:00 ET == "2026-09-30T14:00:00.000Z".
const DAY = "2026-09-30";
const et = (hhMM: string): string => {
  const [h, m] = hhMM.split(":").map(Number);
  return `${DAY}T${String(h + 4).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}:00.000Z`;
};

const MORNING: AvailabilityRule = { weekday: 3, open_time: "09:00", close_time: "13:00", active: true };
const AFTERNOON: AvailabilityRule = { weekday: 3, open_time: "13:30", close_time: "18:30", active: true };

const appt = (id: string, startHHMM: string, minutes = 60, extra: Partial<AppointmentRow> = {}): AppointmentRow => ({
  id,
  contact_id: null,
  calendar_id: null,
  appointment_type: "Family Portrait Session",
  appointment_datetime: et(startHHMM),
  created_at: et(startHHMM),
  status: "scheduled",
  cancelled: false,
  duration_minutes: minutes,
  ...extra,
});

const base = (overrides: Partial<Parameters<typeof computeDayAvailability>[0]> = {}) => ({
  date: DAY,
  rules: [MORNING, AFTERNOON],
  blocked: [] as BlockedTimeRow[],
  appointments: [] as AppointmentRow[],
  slotIntervalMin: 60,
  durationMin: 60,
  paddingMin: 0,
  ...overrides,
});

// ---------- A) a buffer-only adjacent slot is blockedCount, NOT booked ----------

describe("S4b padding hardening — buffer-only slots", () => {
  test("appointment 10:00–11:00, padding 15: slots 09:00 and 11:00 are blocked, only 10:00 is booked", () => {
    const d = computeDayAvailability(
      base({ appointments: [appt("a1", "10:00")], paddingMin: 15, rules: [MORNING] }),
    );
    // single morning block: capacity 4 (09:00, 10:00, 11:00, 12:00)
    expect(d.totalCapacity).toBe(4);
    expect(d.booked).toBe(1); // the session itself: slot 10:00 only
    expect(d.blockedCount).toBe(2); // buffer-only: 09:00 (pad before) + 11:00 (pad after)
    expect(d.openSlotTimes).toEqual(["12:00 PM"]);
    expect(d.booked + d.blockedCount + d.openSlotTimes.length).toBe(d.totalCapacity);
    expect(d.utilization).toBeCloseTo(0.25);
  });

  test("the PRE-S4b engine would have called this day 3/4 booked — the fix moves buffer slots out of booked", () => {
    const d = computeDayAvailability(
      base({ appointments: [appt("a1", "10:00")], paddingMin: 15, rules: [MORNING] }),
    );
    // old behavior (padding folded into the busy interval): booked 3, open 1.
    expect(d.booked).not.toBe(3);
    expect(d.blockedCount).toBe(2);
  });

  test("booked counts TRUE occupancy — a session exactly filling one slot never books its neighbors without padding", () => {
    const d = computeDayAvailability(base({ appointments: [appt("a1", "10:00")], paddingMin: 0, rules: [MORNING] }));
    expect(d.booked).toBe(1);
    expect(d.blockedCount).toBe(0);
    expect(d.openSlotTimes).toEqual(["9:00 AM", "11:00 AM", "12:00 PM"]);
  });

  test("a slot the session merely touches at its end boundary stays open when padding is 0 (half-open intervals)", () => {
    // session 10:00–11:00: slot 11:00 does NOT overlap the session
    const d = computeDayAvailability(base({ appointments: [appt("a1", "10:00")], paddingMin: 0, rules: [MORNING] }));
    expect(d.openSlotTimes).toContain("11:00 AM");
  });

  test("padding>0 still removes the appointment's own slot AND the buffer slots from open — none appear as open", () => {
    const d = computeDayAvailability(
      base({ appointments: [appt("a1", "10:00")], paddingMin: 30, rules: [MORNING] }),
    );
    // buffer [09:30, 11:30): slots 09:00 (09:00+60 > 09:30) and 11:00 blocked
    expect(d.booked).toBe(1);
    expect(d.blockedCount).toBe(2);
    expect(d.openSlotTimes).toEqual(["12:00 PM"]);
  });

  test("cancelled and out-of-scope appointments consume nothing (buffer included)", () => {
    const d = computeDayAvailability(
      base({
        appointments: [
          appt("c1", "10:00", 60, { cancelled: true, status: "cancelled" }),
          appt("z1", "10:00", 60, { calendar_name: "Zoom" }),
        ],
        paddingMin: 15,
        rules: [MORNING],
        scope: { calendars_included: ["Family Studio"], types_included: [] },
      }),
    );
    expect(d.booked).toBe(0);
    expect(d.blockedCount).toBe(0);
    expect(d.openSlotTimes).toEqual(["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM"]);
  });
});

// ---------- B) the capacity invariant holds per block AND per day ----------

describe("S4b padding hardening — booked + blocked + open === capacity", () => {
  const appts = [appt("m1", "10:00"), appt("a1", "15:30"), appt("a2", "17:00", 60, { duration_minutes: 90 })];
  // a2 runs 17:00–18:30 (stored duration): occupies slots 17:00 fully and the
  // tail of the grid (18:30 close → no further slot), buffer with padding 15.

  test("per-block accounting: the day result is exactly the sum of the two block runs", () => {
    const morning = computeDayAvailability(base({ appointments: appts, paddingMin: 15, rules: [MORNING] }));
    const afternoon = computeDayAvailability(base({ appointments: appts, paddingMin: 15, rules: [AFTERNOON] }));
    const day = computeDayAvailability(base({ appointments: appts, paddingMin: 15, rules: [MORNING, AFTERNOON] }));

    expect(morning.totalCapacity).toBe(4);
    expect(afternoon.totalCapacity).toBe(5);
    expect(day.totalCapacity).toBe(9);
    expect(day.booked).toBe(morning.booked + afternoon.booked);
    expect(day.blockedCount).toBe(morning.blockedCount + afternoon.blockedCount);
    expect(day.openSlotTimes).toEqual([...morning.openSlotTimes, ...afternoon.openSlotTimes]);
    // invariant holds per block…
    expect(morning.booked + morning.blockedCount + morning.openSlotTimes.length).toBe(morning.totalCapacity);
    expect(afternoon.booked + afternoon.blockedCount + afternoon.openSlotTimes.length).toBe(afternoon.totalCapacity);
    // …and for the day.
    expect(day.booked + day.blockedCount + day.openSlotTimes.length).toBe(day.totalCapacity);
  });

  test("two-block day with padding: every slot lands in exactly one bucket (no double-count)", () => {
    const d = computeDayAvailability(base({ appointments: appts, paddingMin: 15 }));
    expect(d.totalCapacity).toBe(9);
    expect(d.booked).toBe(4); // 10:00 session; 15:30 session; 16:30+17:00 slots overlap the 17:00–18:30 session
    // buffer-only: 09:00, 11:00 (m1 ±15min) + 14:30 (a1 buffer tail) → 3
    expect(d.blockedCount).toBe(3);
    expect(d.openSlotTimes).toEqual(["12:00 PM", "1:30 PM"]);
    expect(d.booked + d.blockedCount + d.openSlotTimes.length).toBe(9);
  });

  test("blocked times and appointment buffers compose — both land in blockedCount, never booked", () => {
    const d = computeDayAvailability(
      base({
        appointments: [appt("a1", "10:00")],
        blocked: [{ id: "b1", start_at: et("11:30"), end_at: et("12:30"), reason: "lunch" }],
        paddingMin: 15,
        rules: [MORNING],
      }),
    );
    expect(d.booked).toBe(1); // 10:00 session only
    expect(d.blockedCount).toBe(3); // 09:00 (buffer) + 11:00 (buffer) + 12:00 (block)
    expect(d.openSlotTimes).toEqual([]);
    expect(d.booked + d.blockedCount + d.openSlotTimes.length).toBe(4);
  });
});

// ---------- C) padding 0 = byte-identical to the pre-S4b engine ----------

/**
 * The PRE-S4b algorithm, verbatim (single busy list with padding folded in;
 * booked on any overlap). The regression net: with paddingMin = 0 the new
 * engine must agree with this on every fixture.
 */
function referencePreS4b(input: Parameters<typeof computeDayAvailability>[0]) {
  const empty = { date: input.date, totalCapacity: 0, booked: 0, openSlotTimes: [] as string[], utilization: null, blockedCount: 0 };
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const blocks = input.rules
    .filter((r) => r.weekday === 3 && r.active) // reference fixtures are all Wednesday
    .map((r) => ({ openMin: toMin(r.open_time), closeMin: toMin(r.close_time) }))
    .filter((b) => Number.isFinite(b.openMin) && Number.isFinite(b.closeMin) && b.closeMin > b.openMin)
    .sort((a, b) => a.openMin - b.openMin || a.closeMin - b.closeMin);
  if (blocks.length === 0) return empty;
  const etDayStartUtc = (date: string): string => {
    // 2026-09 is EDT (UTC−4): the ET day starts at 04:00Z
    return `${date}T04:00:00.000Z`;
  };
  const dayStartMs = new Date(etDayStartUtc(input.date)).getTime();
  const dayEndMs = new Date(etDayStartUtc("2026-10-01")).getTime();
  const apptBusy: Array<[number, number]> = [];
  for (const a of input.appointments) {
    if (a.cancelled || a.status === "cancelled") continue;
    if (input.scope?.calendars_included?.length && !input.scope.calendars_included.includes(a.calendar_name ?? (a.calendar_id ?? "") as never)) continue;
    const start = Date.parse(a.appointment_datetime);
    const dur = typeof a.duration_minutes === "number" && a.duration_minutes > 0 ? a.duration_minutes : input.durationMin;
    const end = start + dur * 60_000;
    if (!Number.isFinite(start) || end <= dayStartMs || start >= dayEndMs) continue;
    const padMs = input.paddingMin * 60_000;
    apptBusy.push([(start - padMs - dayStartMs) / 60_000, (end + padMs - dayStartMs) / 60_000]);
  }
  const blockBusy: Array<[number, number]> = [];
  for (const b of input.blocked) {
    const start = new Date(b.start_at).getTime();
    const end = new Date(b.end_at).getTime();
    if (end <= dayStartMs || start >= dayEndMs) continue;
    blockBusy.push([(start - dayStartMs) / 60_000, (end - dayStartMs) / 60_000]);
  }
  const overlaps = (s: number, e: number, intervals: Array<[number, number]>) => intervals.some(([bs, be]) => s < be && e > bs);
  const slotLabel = (minutes: number) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(
      new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)),
    );
  let totalCapacity = 0;
  let booked = 0;
  let blockedCount = 0;
  const openSlotTimes: string[] = [];
  for (const { openMin, closeMin } of blocks) {
    for (let t = openMin; t + input.durationMin <= closeMin; t += input.slotIntervalMin) {
      totalCapacity += 1;
      if (overlaps(t, t + input.durationMin, apptBusy)) {
        booked += 1;
        continue;
      }
      if (overlaps(t, t + input.durationMin, blockBusy)) {
        blockedCount += 1;
        continue;
      }
      openSlotTimes.push(slotLabel(t));
    }
  }
  return {
    date: input.date,
    totalCapacity,
    booked,
    openSlotTimes,
    utilization: totalCapacity > 0 ? booked / totalCapacity : null,
    blockedCount,
  };
}

describe("S4b padding hardening — padding 0 regression (byte-identical to pre-S4b)", () => {
  const fixtures: Parameters<typeof computeDayAvailability>[0][] = [
    base({}),
    base({ rules: [MORNING] }),
    base({ appointments: [appt("a1", "10:00")] }),
    base({ appointments: [appt("a1", "09:00"), appt("a2", "13:30"), appt("a3", "17:30")] }),
    base({ appointments: [appt("a1", "12:30", 90)] }), // stored duration spans the block gap
    base({ appointments: [appt("a1", "08:30", 120)] }), // starts before the block, overlaps in
    base({ appointments: [appt("a1", "18:00", 60)] }), // tail slot
    base({ appointments: [appt("a1", "10:00", 60, { cancelled: true, status: "cancelled" })] }),
    base({
      appointments: [appt("z", "10:00", 60, { calendar_name: "Zoom" })],
      scope: { calendars_included: ["Family Studio"], types_included: [] },
    }),
    base({
      blocked: [
        { id: "b1", start_at: et("09:30"), end_at: et("10:30"), reason: "photo upload" },
        { id: "b2", start_at: et("14:00"), end_at: et("16:00"), reason: "meeting" },
        { id: "b3", start_at: et("20:00"), end_at: et("21:00"), reason: "after hours" },
      ],
    }),
    base({ appointments: [appt("a1", "10:00"), appt("a2", "15:00", 45)], blocked: [{ id: "b1", start_at: et("11:30"), end_at: et("12:15"), reason: "x" }] }),
    base({ slotIntervalMin: 30, durationMin: 60, appointments: [appt("a1", "10:30", 45)] }),
    base({ paddingMin: 0, appointments: [appt("a1", "11:00", 30)] }),
  ];

  test("padding 0: every fixture reproduces the pre-S4b engine byte-for-byte", () => {
    for (const f of fixtures) {
      const got = computeDayAvailability({ ...f, paddingMin: 0 });
      const want = referencePreS4b({ ...f, paddingMin: 0 });
      // PR-2 added `slotTimes` (the engine's generated candidate labels) — an
      // additive field the pre-S4b reference never had. The byte-for-byte
      // claim covers the legacy contract fields; slotTimes is separately
      // pinned by its own invariant below.
      const { slotTimes: _slotTimes, ...gotLegacy } = got;
      expect(gotLegacy).toEqual(want);
      expect(got.slotTimes.length).toBe(got.totalCapacity);
    }
  });

  test("padding 15 on the same fixtures MOVES buffer-only slots booked → blocked (the fix, demonstrated)", () => {
    const f = base({ appointments: [appt("a1", "10:00")], rules: [MORNING] });
    const fixed = computeDayAvailability({ ...f, paddingMin: 15 });
    const old = referencePreS4b({ ...f, paddingMin: 15 });
    expect(old.booked).toBe(3); // the trap: buffer slots counted booked
    expect(old.blockedCount).toBe(0);
    expect(fixed.booked).toBe(1);
    expect(fixed.blockedCount).toBe(2);
    // the removed-from-open set is identical — only the bucket changed
    expect(fixed.booked + fixed.blockedCount + fixed.openSlotTimes.length).toBe(old.booked + old.blockedCount + old.openSlotTimes.length);
    expect(fixed.totalCapacity).toBe(old.totalCapacity);
  });
});
