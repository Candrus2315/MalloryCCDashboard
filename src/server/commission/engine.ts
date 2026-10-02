/**
 * COMMISSION ENGINE — pure core (spec §C/§D/§E/§G/§H, owner directive 10/1).
 *
 * NO DATABASE IMPORTS — this module is the deterministic money math the whole
 * feature shares. The store layer persists what this computes; the derive layer
 * (./derive) turns stored rows into the inputs; the close job (./close) and the
 * historical backfill (./backfill) call both.
 *
 * OWNER RULES IMPLEMENTED HERE (verbatim from the spec):
 *  - Tier tables §C (full-time) / §D (part-time): progressive WITHIN the week —
 *    the first N bookings up to the threshold earn the tier rate, every booking
 *    beyond it earns the lower over-threshold rate. Flat tiers pay one rate.
 *  - §5 TIER CALC RULE: the ASSIGNED tier determines the formula; weekly
 *    performance never moves tiers and there is NO minimum to earn. A Tier 5
 *    employee booking 28 still gets 28 × the Tier 5 in-threshold rate.
 *  - §G 79-BOOKING TEAM POOL: team ≥ 79 qualifying bookings unlocks
 *    pool = team × $5, distributed proportionally (employee bookings ÷ team
 *    bookings × pool). Below 79 the pool is locked ($0).
 *  - §H FILLED-HOLE BONUS: $10 per qualifying filled hole, kept as a SEPARATE
 *    field so the money source is visible.
 *
 * MONEY: all computation is INTEGER CENTS (exact). Store rows carry dollars
 * (2-decimal numeric); conversions live at the boundaries (centsToDollars).
 */

/** The current calculation version stamped on every weekly record. Bump on any rate/definition change. */
export const COMMISSION_CALC_VERSION = 2; // v2 = RULING 5 (owner 10/2): hole bonus capped to weeks with ≤8 open-at-start slots.

/** §G: team bookings needed to unlock the pool. */
export const POOL_THRESHOLD = 79;
/** §G: pool dollars per team booking once unlocked ($5). */
export const POOL_RATE_CENTS = 500;
/** §H: dollars per qualifying filled hole ($10). */
export const HOLE_BONUS_CENTS = 1000;
/**
 * RULING 5 (owner directive 10/2): hole bonuses are paid ONLY in weeks with
 * AT MOST this many slots still open at week start. A week that began with
 * more than HOLE_BONUS_MAX_OPEN_SLOTS open slots (a largely-empty week —
 * e.g. the 9/21 validation week, 24 open at start) pays NO hole bonus to ANY
 * rep, however many open-at-start slots were subsequently filled. The
 * slot-level audit rows stay derived (zeroed) so the drawer can still show
 * what was filled; the money is what the cap kills.
 */
export const HOLE_BONUS_MAX_OPEN_SLOTS = 8;

export type EmploymentType = "full_time" | "part_time";
export type CommissionTierNumber = 1 | 2 | 3 | 4 | 5;

/** One tier's progressive rule: `flat` tiers pay one rate for every booking; threshold tiers pay `rate` for bookings 1..threshold and `overRate` beyond. */
export interface TierRule {
  /** Present on flat tiers (both T1s). */
  flat?: number;
  /** Bookings 1..threshold earn `rate` (threshold tiers only). */
  threshold?: number;
  rate?: number;
  /** Bookings beyond the threshold earn `overRate` (threshold tiers only). */
  overRate?: number;
}

/** §C FULL-TIME TIERS (exact). */
export const FT_TIERS: Record<CommissionTierNumber, TierRule> = {
  1: { flat: 5 },
  2: { threshold: 24, rate: 10, overRate: 5 },
  3: { threshold: 28, rate: 15, overRate: 5 },
  4: { threshold: 35, rate: 18, overRate: 5 },
  5: { threshold: 40, rate: 20, overRate: 10 },
};

/** §D PART-TIME TIERS (exact). */
export const PT_TIERS: Record<CommissionTierNumber, TierRule> = {
  1: { flat: 5 },
  2: { threshold: 14, rate: 10, overRate: 5 },
  3: { threshold: 16, rate: 15, overRate: 5 },
  4: { threshold: 20, rate: 18, overRate: 5 },
  5: { threshold: 24, rate: 20, overRate: 10 },
};

export function tierRulesFor(employmentType: EmploymentType): Record<CommissionTierNumber, TierRule> {
  return employmentType === "full_time" ? FT_TIERS : PT_TIERS;
}

export function isValidCommissionTier(tier: unknown): tier is CommissionTierNumber {
  return typeof tier === "number" && Number.isInteger(tier) && tier >= 1 && tier <= 5;
}

export function isValidEmploymentType(v: unknown): v is EmploymentType {
  return v === "full_time" || v === "part_time";
}

/** Itemized commission result for one employee-week (integer cents). */
export interface RateBreakdown {
  /** Bookings earning the in-threshold (or flat) rate. */
  inThresholdBookings: number;
  /** Bookings earning the over-threshold rate (0 on flat tiers). */
  outThresholdBookings: number;
  /** The rate actually applied to the in-threshold bookings (dollars). */
  appliedRate: number;
  /** The over-threshold rate applied beyond the threshold (dollars; null on flat tiers). */
  appliedOverRate: number | null;
  baseCents: number;
  additionalCents: null | number;
  totalCents: number;
}

/**
 * §C/§D/§E — commission for `bookings` qualifying bookings under one assigned
 * tier. PROGRESSIVE within the week (first `threshold` bookings at the tier
 * rate, the rest at the over rate); flat tiers pay the flat rate for all.
 * The assigned tier governs regardless of volume (§5) — no minimums, no tier
 * movement. Throws on an invalid tier/employment type — an unassigned tier
 * must never silently compute $0 (callers gate eligibility first).
 */
export function rateCommission(employmentType: EmploymentType, tier: CommissionTierNumber, bookings: number): RateBreakdown {
  if (!isValidEmploymentType(employmentType)) throw new Error(`Invalid employment type: ${String(employmentType)}`);
  if (!isValidCommissionTier(tier)) throw new Error(`Invalid commission tier: ${String(tier)}`);
  if (!Number.isInteger(bookings) || bookings < 0) throw new Error(`Invalid booking count: ${String(bookings)}`);
  const rule = tierRulesFor(employmentType)[tier];
  if (rule.flat != null) {
    const baseCents = bookings * rule.flat * 100;
    return {
      inThresholdBookings: bookings,
      outThresholdBookings: 0,
      appliedRate: rule.flat,
      appliedOverRate: null,
      baseCents,
      additionalCents: null,
      totalCents: baseCents,
    };
  }
  const threshold = rule.threshold as number;
  const rate = rule.rate as number;
  const overRate = rule.overRate as number;
  const inCount = Math.min(bookings, threshold);
  const outCount = Math.max(0, bookings - threshold);
  const baseCents = inCount * rate * 100;
  const additionalCents = outCount * overRate * 100;
  return {
    inThresholdBookings: inCount,
    outThresholdBookings: outCount,
    appliedRate: rate,
    appliedOverRate: overRate,
    baseCents,
    additionalCents,
    totalCents: baseCents + additionalCents,
  };
}

/**
 * §G 79-BOOKING TEAM POOL share for ONE employee (integer cents).
 * Team < POOL_THRESHOLD → Pool Locked ($0). Otherwise pool = team × $5 and the
 * employee's share is the exact proportional cut (employee ÷ team × pool),
 * rounded half-up at cents. With integer booking counts the shares of the
 * whole team sum to the pool up to rounding (±1¢ when a share is not exact).
 */
export function poolBonusCents(teamBookings: number, employeeBookings: number): number {
  if (!Number.isInteger(teamBookings) || teamBookings < 0) throw new Error(`Invalid team booking count: ${String(teamBookings)}`);
  if (!Number.isInteger(employeeBookings) || employeeBookings < 0) throw new Error(`Invalid employee booking count: ${String(employeeBookings)}`);
  if (teamBookings < POOL_THRESHOLD) return 0; // Pool Locked
  const poolCents = teamBookings * POOL_RATE_CENTS;
  if (teamBookings === 0) return 0; // unreachable (≥79), defensive
  return Math.round((poolCents * employeeBookings) / teamBookings);
}

/** §H filled-hole bonus: $10 per qualifying filled hole (integer cents). */
export function holeBonusCents(filledHoles: number): number {
  if (!Number.isInteger(filledHoles) || filledHoles < 0) throw new Error(`Invalid filled-hole count: ${String(filledHoles)}`);
  return filledHoles * HOLE_BONUS_CENTS;
}

/** Cents → dollars at the store/UI boundary (exact halves never appear — inputs are whole cents). */
export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/** Dollars (2-decimal) → cents at the store/UI boundary. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** One employee's commission-relevant profile slice (already gated for eligibility). */
export interface CommissionEmployeeInput {
  userId: string;
  name: string;
  employmentType: EmploymentType;
  tier: CommissionTierNumber;
  /** The tier_effective_date USED for the week (snapshot onto the weekly record). */
  tierEffectiveDate: string | null;
}

/** Whole-week computation output for ONE employee (integer cents; separate bonus fields per §F). */
export interface EmployeeWeeklyCommission {
  userId: string;
  name: string;
  employmentType: EmploymentType;
  tier: CommissionTierNumber;
  tierEffectiveDateUsed: string | null;
  qualifyingBookings: number;
  baseCents: number;
  additionalCents: number;
  poolCents: number;
  filledHoles: number;
  holeCents: number;
  /** base + additional + pool + hole — manual adjustments are NOT part of the auto calc. */
  totalCents: number;
  breakdown: RateBreakdown;
}
