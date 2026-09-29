/**
 * MONTHLY BOOKING GOAL (owner-approved 2026-09-29) — deterministic tests.
 *
 *  1. Month-key math: addMonthsKey (year wrap both directions), monthKeyLabel,
 *     monthKeyOf — pure string arithmetic, no timezone edges.
 *  2. Store round-trip (MemoryStore): upsert/overwrite/get/delete — a month
 *     never inherits another month's goal (September's 316 stays out of
 *     October).
 *  3. weeklyPageData through the PageDeps seam (MemoryStore + pinned today):
 *     a goal stored for the current month renders "X/316 (−N)" (goalVsActual
 *     format); no goal → null + "X/—" (never invented); October does not
 *     inherit September's goal.
 */
import { describe, expect, test } from "bun:test";
import { addMonthsKey, monthKeyLabel, monthKeyOf, goalVsActual } from "../metrics/weekly";
import { weeklyPageData } from "../page-data";
import { MemoryStore } from "../store/memory";

describe("monthly-goal month keys (pure)", () => {
  test("addMonthsKey — within the year and across the December boundary", () => {
    expect(addMonthsKey("2026-09", 0)).toBe("2026-09");
    expect(addMonthsKey("2026-09", 1)).toBe("2026-10");
    expect(addMonthsKey("2026-12", 1)).toBe("2027-01");
    expect(addMonthsKey("2026-01", -1)).toBe("2025-12");
    expect(addMonthsKey("2025-01", -1)).toBe("2024-12");
  });
  test("monthKeyLabel — 'September 2026' style; unparsable keys pass through", () => {
    expect(monthKeyLabel("2026-09")).toBe("September 2026");
    expect(monthKeyLabel("2027-01")).toBe("January 2027");
    expect(monthKeyLabel("2025-12")).toBe("December 2025");
    expect(monthKeyLabel("nonsense")).toBe("nonsense");
  });
  test("monthKeyOf — the ET calendar month containing today", () => {
    expect(monthKeyOf("2026-09-29")).toBe("2026-09");
    expect(monthKeyOf("2026-01-01")).toBe("2026-01");
    expect(monthKeyOf("2026-12-31")).toBe("2026-12");
  });
  test("goalVsActual already carries the ±N presentation (regression)", () => {
    expect(goalVsActual(239, 316)).toBe("239/316 (−77)");
  });
});

describe("MemoryStore monthly-goal round-trip", () => {
  test("upsert → get → overwrite → delete; another month stays unset", async () => {
    const store = new MemoryStore();
    expect(await store.getMonthlyGoal("2026-09")).toBeNull();
    await store.upsertMonthlyGoal({ month: "2026-09", goal: 316 });
    expect(await store.getMonthlyGoal("2026-09")).toEqual({ month: "2026-09", goal: 316 });
    // OCTOBER MUST NOT INHERIT SEPTEMBER'S 316
    expect(await store.getMonthlyGoal("2026-10")).toBeNull();
    await store.upsertMonthlyGoal({ month: "2026-09", goal: 300 }); // overwrite
    expect((await store.getMonthlyGoal("2026-09"))?.goal).toBe(300);
    await store.deleteMonthlyGoal("2026-09");
    expect(await store.getMonthlyGoal("2026-09")).toBeNull();
  });
});

// ---------- weeklyPageData integration (MemoryStore + pinned clock) ----------

const TODAY = "2026-09-29"; // Tue — last completed week 9/21..9/27, MTD 9/1..9/29
const OCT = "2026-10-05"; // Mon — last completed week 9/28..10/4, MTD 10/1..10/5
const H = (date: string, time: string) => new Date(`${date}T${time}:00.000-04:00`).toISOString(); // EDT

async function seedWinsStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.saveSettings({ acuity: { calendars_included: [], types_included: [] } });
  const win = (id: string, winDate: string, type: string) => ({
    id,
    acuity_appointment_id: id,
    contact_id: "k1",
    calendar_id: "cal-1",
    appointment_type: type,
    appointment_datetime: H(winDate, "14:00"),
    created_at: H(winDate, "12:00"),
    created_business_date: winDate,
    booking_win_business_date: winDate,
    raw: { priceSold: "300.00", amountPaid: "300.00" },
    status: "scheduled",
    cancelled: false,
  });
  await store.upsertAppointments([
    win("g-alliance", "2026-09-22", 'Alliance Portrait Session + 20" Portrait'),
    win("g-auction", "2026-09-25", 'Auction Portrait Session + 20" Portrait + Hotel'),
    win("g-plain", "2026-09-26", "Portrait Session"),
  ]);
  return store;
}

describe("weeklyPageData monthly-goal resolution (pinned today)", () => {
  test("goal stored for the current month → goalLine in goalVsActual format", async () => {
    const store = await seedWinsStore();
    await store.upsertMonthlyGoal({ month: "2026-09", goal: 316 });
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.month.key).toBe("2026-09");
    expect(data.mtd.goal).toBe(316);
    expect(data.mtd.goalLine).toBe("3/316 (−313)");
  });

  test("no goal for the month → honest null + 'X/—' (never invented)", async () => {
    const store = await seedWinsStore();
    const data = await weeklyPageData({ store, today: TODAY });
    expect(data.mtd.goal).toBeNull();
    expect(data.mtd.goalLine).toBe("3/—");
  });

  test("OCTOBER DOES NOT INHERIT SEPTEMBER'S GOAL — new month, no row, goal null", async () => {
    const store = await seedWinsStore();
    await store.upsertMonthlyGoal({ month: "2026-09", goal: 316 });
    const data = await weeklyPageData({ store, today: OCT });
    expect(data.month.key).toBe("2026-10");
    expect(data.mtd.goal).toBeNull();
    expect(data.mtd.goalLine).toBe("0/—");
  });
});
