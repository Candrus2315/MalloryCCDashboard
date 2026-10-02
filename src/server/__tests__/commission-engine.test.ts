/**
 * COMMISSION ENGINE — pure money math (spec §C/§D/§E/§G/§H + OWNER RULINGS
 * 1–2 + the §5 tier-calc rule). Every rate table asserted EXACTLY at its
 * thresholds; the §5 rule asserted against the tempting-but-wrong re-tiering.
 */
import { describe, expect, test } from "bun:test";
import {
  FT_TIERS,
  PT_TIERS,
  centsToDollars,
  dollarsToCents,
  holeBonusCents,
  poolBonusCents,
  rateCommission,
  tierRulesFor,
} from "../commission/engine";

const RATE = (ft: boolean, tier: 1 | 2 | 3 | 4 | 5, bookings: number) =>
  rateCommission(ft ? "full_time" : "part_time", tier, bookings);

describe("§C/§D tier tables — exact at the boundaries", () => {
  test("FT T1 flat $5 (any volume)", () => {
    expect(RATE(true, 1, 0).totalCents).toBe(0);
    expect(RATE(true, 1, 41).totalCents).toBe(20500);
    expect(RATE(true, 1, 41).appliedOverRate).toBeNull();
  });
  test("FT T2: 1–24 @$10, 25+ @ $5", () => {
    expect(RATE(true, 2, 24).totalCents).toBe(24000);
    expect(RATE(true, 2, 25).totalCents).toBe(24500); // 24×10 + 1×5
    expect(RATE(true, 2, 30).totalCents).toBe(24000 + 6 * 500);
    expect(RATE(true, 2, 30).inThresholdBookings).toBe(24);
    expect(RATE(true, 2, 30).outThresholdBookings).toBe(6);
  });
  test("FT T3: 1–28 @$15, 29+ @ $5", () => {
    expect(RATE(true, 3, 28).totalCents).toBe(42000);
    expect(RATE(true, 3, 29).totalCents).toBe(42500);
    expect(RATE(true, 3, 40).totalCents).toBe(42000 + 12 * 500);
  });
  test("FT T4: 1–35 @$18, 36+ @ $5", () => {
    expect(RATE(true, 4, 35).totalCents).toBe(63000);
    expect(RATE(true, 4, 36).totalCents).toBe(63500);
    expect(RATE(true, 4, 50).totalCents).toBe(63000 + 15 * 500);
  });
  test("FT T5: 1–40 @$20, 41+ @ $10", () => {
    expect(RATE(true, 5, 40).totalCents).toBe(80000);
    expect(RATE(true, 5, 41).totalCents).toBe(81000);
    expect(RATE(true, 5, 45).totalCents).toBe(80000 + 5 * 1000);
  });
  test("PT T1 flat $5", () => {
    expect(RATE(false, 1, 30).totalCents).toBe(15000);
  });
  test("PT T2: 1–14 @$10, 15+ @ $5", () => {
    expect(RATE(false, 2, 14).totalCents).toBe(14000);
    expect(RATE(false, 2, 15).totalCents).toBe(14500);
  });
  test("PT T3: 1–16 @$15, 17+ @ $5", () => {
    expect(RATE(false, 3, 16).totalCents).toBe(24000);
    expect(RATE(false, 3, 17).totalCents).toBe(24500);
    expect(RATE(false, 3, 61).totalCents).toBe(24000 + 45 * 500); // $465 — the §M "61 → $915" figure is placeholder illustration, the TABLE governs
  });
  test("PT T4: 1–20 @$18, 21+ @ $5", () => {
    expect(RATE(false, 4, 20).totalCents).toBe(36000);
    expect(RATE(false, 4, 21).totalCents).toBe(36500);
  });
  test("PT T5: 1–24 @$20, 25+ @ $10", () => {
    expect(RATE(false, 5, 24).totalCents).toBe(48000);
    expect(RATE(false, 5, 25).totalCents).toBe(49000);
  });
  test("rate tables themselves are verbatim", () => {
    expect(FT_TIERS[2]).toEqual({ threshold: 24, rate: 10, overRate: 5 });
    expect(PT_TIERS[5]).toEqual({ threshold: 24, rate: 20, overRate: 10 });
    expect(tierRulesFor("full_time")[1]).toEqual({ flat: 5 });
    expect(tierRulesFor("part_time")[1]).toEqual({ flat: 5 });
  });
});

describe("§5 TIER CALC RULE — the ASSIGNED tier governs regardless of volume", () => {
  test("Tier 5 booking 28 gets 28 × the TIER 5 rate ($560), never T3's formula", () => {
    const r = RATE(true, 5, 28);
    expect(r.totalCents).toBe(56000);
    expect(r.appliedRate).toBe(20);
    expect(r.inThresholdBookings).toBe(28);
    expect(r.outThresholdBookings).toBe(0);
  });
  test("Tier 1 (flat) booking 50 gets 50 × $5 — flat never degrades", () => {
    expect(RATE(true, 1, 50).totalCents).toBe(25000);
  });
  test("zero bookings → $0 (no minimum required to earn; a $0 record still exists)", () => {
    expect(RATE(true, 5, 0).totalCents).toBe(0);
    expect(RATE(false, 3, 0).totalCents).toBe(0);
  });
  test("invalid tier / employment / count THROW — unassigned tiers never silently compute $0", () => {
    // @ts-expect-error deliberately invalid inputs
    expect(() => rateCommission("full_time", 6 as never, 10)).toThrow();
    // @ts-expect-error
    expect(() => rateCommission("full_time", 0 as never, 10)).toThrow();
    // @ts-expect-error
    expect(() => rateCommission("seasonal" as never, 3 as never, 10)).toThrow();
    expect(() => RATE(true, 3, -1)).toThrow();
    expect(() => RATE(true, 3, 1.5)).toThrow();
  });
});

describe("§G 79-pool (OWNER RULING 2 — caller owns the rep-attributed-only total)", () => {
  test("below 79 the pool is LOCKED ($0)", () => {
    expect(poolBonusCents(78, 40)).toBe(0);
    expect(poolBonusCents(0, 0)).toBe(0);
  });
  test("at 79+ pool = team × $5, and each employee's proportional share is exactly employee × $5", () => {
    // pool 79 × $5 = $395; an employee with 26 of 79 gets 26 ÷ 79 × 39500 = 13,000¢
    expect(poolBonusCents(79, 79)).toBe(39500);
    expect(poolBonusCents(79, 26)).toBe(13000);
    expect(poolBonusCents(80, 1)).toBe(500);
    // The shares of the whole team sum to the pool exactly (funded per booking).
    let sum = 0;
    const team = 90;
    const parts = [40, 25, 15, 10];
    for (const p of parts) sum += poolBonusCents(team, p);
    expect(sum).toBe(team * 500);
  });
  test("invalid inputs throw", () => {
    expect(() => poolBonusCents(-1, 5)).toThrow();
    expect(() => poolBonusCents(79, 2.5)).toThrow();
  });
});

describe("§H hole bonus + money boundaries", () => {
  test("$10 per qualifying hole (integer cents)", () => {
    expect(holeBonusCents(0)).toBe(0);
    expect(holeBonusCents(3)).toBe(3000);
    expect(() => holeBonusCents(-1)).toThrow();
  });
  test("cents ↔ dollars round-trip", () => {
    expect(centsToDollars(318000)).toBe(3180);
    expect(dollarsToCents(3180)).toBe(318000);
    expect(centsToDollars(91500)).toBe(915);
  });
});
