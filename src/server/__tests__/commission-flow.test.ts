/**
 * COMMISSION FLOW — store round-trips (MemoryStore — the Pg mirror compiles
 * against the same interface and is exercised by the live-DB backfill run),
 * the Sunday-close tick (idempotency, §5 zero-bookings records, tier-held
 * gating), and the historical backfill's cycle assembly (RULING 4).
 *
 * GOTCHA honored: store upserts REGENERATE internal ids (appointments are
 * keyed by acuity_appointment_id) — attributions are seeded against the ids
 * resolved back from the store, never the supplied literals.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { AppointmentRow, AttributionRow } from "../metrics/compute";
import { commissionCloseTick, buildWeeklyRecord, lastCompletedCommissionWeekStart } from "../commission/close";
import { computeValidationWeeks, rollupCycle, writeBackfillCycle, buildBackfillCycleRow, BACKFILL_CYCLE_ID } from "../commission/backfill";
import { etDayStartUtc, etDayEndUtc } from "../date-logic";
import type { CommissionCycleRow, CommissionWeeklyRow, UserRow } from "../store/types";

const WEEK = "2026-09-07";
const WEEK_END = "2026-09-13";
let seq = 0;
/** ET → UTC for September 2026 (EDT, UTC−4 — exact for this test month). */
const etToUtc = (date: string, time: string): string => {
  const [h, m] = time.split(":").map(Number);
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h + 4, m, 0)).toISOString();
};
function appt(o: { date?: string; time?: string; created?: string; paid?: boolean } = {}): AppointmentRow {
  seq += 1;
  const date = o.date ?? "2026-09-09";
  const time = o.time ?? "10:00";
  const created = o.created ?? date;
  return {
    id: `ca-${seq}`,
    contact_id: null,
    calendar_id: "cal-mallory",
    appointment_type: "Portrait Session",
    appointment_datetime: etToUtc(date, time),
    created_at: etToUtc(created, "12:00"),
    created_business_date: created,
    created_time_precision: "full",
    payment_state: o.paid === false ? "pending_payment" : "paid",
    booking_win_business_date: o.paid === false ? null : created,
    status: "scheduled",
    cancelled: false,
    raw: { paid: o.paid === false ? "no" : "yes" } as Record<string, unknown>,
  };
}
function attribution(appointmentId: string, repId: string | null, manual = false): AttributionRow {
  seq += 1;
  return { id: `cat-${seq}`, appointment_id: appointmentId, call_id: null, rep_id: repId, method: repId ? "contact_id" : "none", confidence: repId ? 1 : 0, manual_override: manual, note: null };
}
const repRow = (name: string, over: Partial<UserRow> = {}): UserRow => ({
  id: "",
  provider: "highlevel",
  external_id: `ext-${name}`,
  name,
  email: `${name.toLowerCase().split(" ")[0]}@mallory.test`,
  is_active: true,
  call_start_date: null,
  ...over,
});

async function seedRoster(store: MemoryStore): Promise<{ allison: string; carmine: string }> {
  await store.upsertUsers([repRow("Allison Wittner"), repRow("Carmine Morgano"), repRow("Dan McKillop")]);
  const users = await store.getUsers();
  const byName = new Map(users.map((u) => [u.name, u]));
  const allison = byName.get("Allison Wittner");
  const carmine = byName.get("Carmine Morgano");
  const dan = byName.get("Dan McKillop");
  if (!allison || !carmine || !dan) throw new Error("seed roster failed");
  expect(allison.commission_tier).toBe(5); // ensureSchema seed (fill-only-when-unset)
  expect(allison.employment_type).toBe("full_time");
  expect(allison.tier_effective_date).toBe("2026-08-31");
  expect(allison.commission_eligible).toBe(true);
  expect(dan.commission_tier).toBeNull(); // Dan: no tier → never eligible
  expect(dan.commission_eligible).toBe(false);
  return { allison: allison.id, carmine: carmine.id };
}

/** Upsert a win-shaped appointment, resolve its STORE id back, and attribute it to a rep. */
async function seedWin(store: MemoryStore, repId: string | null, o: { date?: string; time?: string; created?: string; paid?: boolean } = {}): Promise<AppointmentRow> {
  const row = appt(o);
  const acuityId = `acq-${seq}`;
  await store.upsertAppointments([{ ...row, acuity_appointment_id: acuityId, client_name: "Client" }] as never);
  const resolved = (await store.getAppointmentsOverlapping(etDayStartUtc("2026-08-24"), etDayEndUtc("2026-10-31")))
    .find((r) => r.acuity_appointment_id === acuityId);
  if (!resolved) throw new Error("seedWin: appointment not resolvable");
  await store.upsertAttributions([attribution(resolved.id, repId)]);
  return resolved;
}

describe("store round-trips", () => {
  test("weekly record upsert keyed (user_id, week_start) — re-runs never duplicate", async () => {
    const store = new MemoryStore();
    const { allison } = await seedRoster(store);
    const base: CommissionWeeklyRow = {
      id: "",
      user_id: allison,
      rep_name: "Allison Wittner",
      week_start: WEEK,
      week_end: WEEK_END,
      employment_type: "full_time",
      tier: 5,
      tier_effective_date_used: "2026-08-31",
      qualifying_bookings: 12,
      base_commission: 240,
      additional_commission: 0,
      pool_bonus: 0,
      hole_bonus: 10,
      manual_adjustment: 0,
      total: 250,
      calc_date: new Date().toISOString(),
      calc_version: 1,
      status: "final",
      cycle_id: null,
      assignment: "unassigned",
      counted_bookings: [],
      hole_audit: [],
    };
    await store.upsertCommissionWeeklyRecord(base);
    await store.upsertCommissionWeeklyRecord({ ...base, qualifying_bookings: 13 });
    const rows = await store.getCommissionWeeklyRecords({ weekStart: WEEK });
    expect(rows.length).toBe(1);
    expect(rows[0].qualifying_bookings).toBe(13);
    expect((await store.getCommissionWeeklyRecords({ userId: allison })).length).toBe(1);
  });
  test("cycle upsert + get + list; adjustments require a reason (§O)", async () => {
    const store = new MemoryStore();
    const { allison } = await seedRoster(store);
    const cycle: CommissionCycleRow = { ...buildBackfillCycleRow(), id: BACKFILL_CYCLE_ID };
    await store.upsertCommissionCycle(cycle);
    expect((await store.getCommissionCycle(BACKFILL_CYCLE_ID))?.payroll_date).toBe("2026-10-09");
    expect(await store.getCommissionCycle("nope")).toBeNull();
    await store.upsertCommissionCycle({ ...cycle, status: "ready_for_review" });
    expect((await store.getCommissionCycles())[0].status).toBe("ready_for_review");
    await expect(
      store.insertCommissionAdjustment({ cycle_id: BACKFILL_CYCLE_ID, user_id: allison, target: "weekly_record", target_id: "x", field: "manual_adjustment", old_value: "0", new_value: "-25", reason: "   ", changed_by: "Manager" }),
    ).rejects.toThrow(/reason is required/i);
    const adj = await store.insertCommissionAdjustment({ cycle_id: BACKFILL_CYCLE_ID, user_id: allison, target: "weekly_record", target_id: "x", field: "manual_adjustment", old_value: "0", new_value: "-25", reason: "Missing hole bonus for Sep 9", changed_by: "Manager" });
    expect(adj.changed_at).toBeTruthy();
    expect(adj.reason).toBe("Missing hole bonus for Sep 9");
    expect((await store.getCommissionAdjustments({ cycleId: BACKFILL_CYCLE_ID })).length).toBe(1);
    expect((await store.getCommissionAdjustments({ userId: allison })).length).toBe(1);
    expect((await store.getCommissionAdjustments({})).length).toBe(1);
  });
  test("setUserCommissionProfile set + clear (null → ineligible)", async () => {
    const store = new MemoryStore();
    const { carmine } = await seedRoster(store);
    await store.setUserCommissionProfile(carmine, { employment_type: "part_time", commission_tier: 2, tier_effective_date: "2026-10-01", tier_end_date: null, commission_eligible: true });
    let u = (await store.getUsers()).find((x) => x.id === carmine);
    expect(u).toMatchObject({ employment_type: "part_time", commission_tier: 2, tier_effective_date: "2026-10-01", commission_eligible: true });
    await store.setUserCommissionProfile(carmine, null);
    u = (await store.getUsers()).find((x) => x.id === carmine);
    expect(u).toMatchObject({ employment_type: null, commission_tier: null, commission_eligible: false });
  });
});

describe("commissionCloseTick — idempotent Sunday close", () => {
  test("lastCompletedCommissionWeekStart — Monday of the most recent COMPLETED Mon–Sun week", () => {
    expect(lastCompletedCommissionWeekStart("2026-09-29")).toBe("2026-09-21"); // Tue → previous week
    expect(lastCompletedCommissionWeekStart("2026-10-05")).toBe("2026-09-28"); // Mon — the week that closed Sunday night
    expect(lastCompletedCommissionWeekStart("2026-09-28")).toBe("2026-09-21"); // its own Monday morning → not yet complete
    expect(lastCompletedCommissionWeekStart("2026-09-27")).toBe("2026-09-14"); // Sunday (week still running)
  });
  test("one record per eligible employee per completed week; rerun is a no-op", async () => {
    const store = new MemoryStore();
    const { allison, carmine } = await seedRoster(store);
    await seedWin(store, carmine, { date: "2026-09-09", time: "10:00", created: "2026-09-09" });
    await seedWin(store, carmine, { date: "2026-09-10", time: "08:00", created: "2026-09-10" });
    const now = () => new Date("2026-09-15T12:00:00Z"); // Tue 9/15 ET
    const first = await commissionCloseTick(store, { now, throughWeekStart: WEEK, epochWeekStart: WEEK });
    expect(first.outcome).toBe("computed");
    expect(first.weeksClosed).toEqual([WEEK]);
    expect(first.recordsWritten).toBe(2); // Allison + Carmine (§5 — every eligible employee, even $0)
    const rows = await store.getCommissionWeeklyRecords({ weekStart: WEEK });
    expect(rows.length).toBe(2);
    const carmineRow = rows.find((r) => r.user_id === carmine);
    expect(carmineRow).toMatchObject({
      qualifying_bookings: 2,
      employment_type: "full_time",
      tier: 1,
      tier_effective_date_used: "2026-08-31",
      status: "final",
      assignment: "unassigned",
    });
    expect(carmineRow?.base_commission).toBe(10); // FT T1: 2 × $5
    expect(carmineRow?.hole_bonus).toBe(20); // two open-at-start slots filled in-week
    expect(carmineRow?.total).toBe(30);
    expect(carmineRow?.counted_bookings.length).toBe(2);
    expect(carmineRow?.hole_audit.length).toBe(2);
    const allisonRow = rows.find((r) => r.user_id === allison);
    expect(allisonRow).toMatchObject({ qualifying_bookings: 0, total: 0, hole_audit: [] });
    const second = await commissionCloseTick(store, { now, throughWeekStart: WEEK, epochWeekStart: WEEK });
    expect(second.recordsWritten).toBe(0);
    expect(second.outcome).toBe("skipped");
  });
  test("walk covers every completed week from the epoch INCLUSIVE (oldest → newest)", async () => {
    const store = new MemoryStore();
    await seedRoster(store);
    const now = () => new Date("2026-09-15T12:00:00Z");
    const res = await commissionCloseTick(store, { now, throughWeekStart: WEEK, epochWeekStart: "2026-08-31" });
    expect(res.weeksConsidered).toBe(2); // 8/31 + 9/7 (the 9/14 week is not complete)
    expect(res.weeksClosed).toEqual(["2026-08-31", "2026-09-07"]);
    expect(res.recordsWritten).toBe(4);
  });
});

describe("historical backfill — cycle assembly (RULING 4)", () => {
  test("cycle row: Aug 31 – Sep 27, 2026 · submission Oct 5 · payroll Oct 9", () => {
    const row = buildBackfillCycleRow();
    expect(row).toMatchObject({
      id: BACKFILL_CYCLE_ID,
      label: "Aug 31 – Sep 27, 2026",
      start_date: "2026-08-31",
      end_date: "2026-09-27",
      submission_date: "2026-10-05",
      payroll_date: "2026-10-09",
      status: "in_progress",
    });
  });
  test("writeBackfillCycle persists records ASSIGNED to the cycle; re-run idempotent", async () => {
    const store = new MemoryStore();
    const { allison } = await seedRoster(store);
    await seedWin(store, allison, { date: "2026-09-02", time: "09:00", created: "2026-09-02" });
    const res = await writeBackfillCycle(store, { calcDateIso: "2026-10-02T00:00:00.000Z" });
    expect(res.recordsWritten).toBe(8); // 4 weeks × 2 eligible employees (§5 — every eligible employee every week)
    const cycleWeeks = await store.getCommissionWeeklyRecords({ cycleId: BACKFILL_CYCLE_ID });
    expect(cycleWeeks.length).toBe(8);
    const allisonW1 = cycleWeeks.find((r) => r.user_id === allison && r.week_start === "2026-08-31");
    expect(allisonW1?.qualifying_bookings).toBe(1);
    expect(allisonW1?.assignment).toBe("current_cycle");
    expect(allisonW1?.cycle_id).toBe(BACKFILL_CYCLE_ID);
    expect(allisonW1?.base_commission).toBe(20); // FT T5: 1 × $20
    const allisonW4 = cycleWeeks.find((r) => r.user_id === allison && r.week_start === "2026-09-21");
    expect(allisonW4?.qualifying_bookings).toBe(0); // §5: no minimum — a $0 record still exists
    expect(allisonW4?.total).toBe(0);
    const res2 = await writeBackfillCycle(store, { calcDateIso: "2026-10-02T00:00:00.000Z" });
    expect(res2.recordsWritten).toBe(8);
    expect((await store.getCommissionWeeklyRecords({ cycleId: BACKFILL_CYCLE_ID })).length).toBe(8);
  });
  test("rollupCycle sums the computed weeks per employee (never re-derives)", async () => {
    const store = new MemoryStore();
    const { allison } = await seedRoster(store);
    await seedWin(store, allison, { date: "2026-09-02", time: "09:00", created: "2026-09-02" });
    const weeks = await computeValidationWeeks(store);
    const rollup = rollupCycle(BACKFILL_CYCLE_ID, buildBackfillCycleRow().label, weeks);
    expect(rollup.weekStarts).toEqual(["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"]);
    expect(rollup.teamTotalBookings).toBe(1); // rep-attributed only (RULING 2)
    const allisonRow = rollup.perEmployee.find((e) => e.name === "Allison Wittner");
    expect(allisonRow?.totalBookings).toBe(1);
    expect(allisonRow?.totalBaseCents).toBe(2000); // FT T5: 1 × $20
    expect(rollup.teamTotalCents).toBe(3000); // $20 base + $10 hole (the Sep 2 slot was open at week start)
  });
  test("buildWeeklyRecord stamps calc version, tier snapshot and the counted records", async () => {
    const store = new MemoryStore();
    const { allison } = await seedRoster(store);
    const win = await seedWin(store, allison, { date: "2026-09-09", time: "13:30", created: "2026-09-09" });
    const weeks = await computeValidationWeeks(store, { weekStarts: [WEEK] });
    const computation = weeks[0];
    const computed = computation.employees.find((e) => e.userId === allison);
    if (!computed) throw new Error("no employee");
    const employee = { userId: allison, name: computed.name, employmentType: computed.employmentType, tier: computed.tier, tierEffectiveDate: computed.tierEffectiveDateUsed };
    const record = buildWeeklyRecord({ computation, employee, calcDateIso: "2026-10-02T00:00:00.000Z" });
    expect(record.calc_version).toBe(1);
    expect(record.tier).toBe(5);
    expect(record.tier_effective_date_used).toBe("2026-08-31");
    expect(record.counted_bookings).toEqual([
      { id: win.id, acuity_appointment_id: win.acuity_appointment_id ?? null, client_name: "Client", appointment_type: "Portrait Session", win_date: "2026-09-09", manual: false },
    ]);
    // an in-week-created win occupying an open-at-start slot fills ONE hole with a full audit row
    expect(record.hole_audit).toEqual([
      expect.objectContaining({
        appointmentId: win.id,
        slot_date: "2026-09-09",
        slot_time: "13:30",
        slot_block: "afternoon",
        win_date: "2026-09-09",
        bonus_cents: 1000,
        week_start: WEEK,
      }),
    ]);
  });
});
