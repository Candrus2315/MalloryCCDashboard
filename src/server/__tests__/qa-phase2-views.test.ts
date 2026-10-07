/**
 * QA Phase 2 (2026-10-08) — Commission Center / Settings / Performance-history
 * view-level fixes, each pinned against its finding:
 *
 * 1. Cycle Totals "Pool Unlocked" chip — the pool is a PER-WEEK construct; the
 *    cycle chip must key on pool money actually paid (stored pool_bonus sum),
 *    not on the cycle's summed booking count crossing 79 (a 228-booking cycle
 *    whose weeks were 49/58/61/60 paid $0 pool — the old chip said Unlocked).
 * 2. "1 holes not paid (ruling 10/2)" — singular/plural agreement.
 * 3. formatMoney thousands grouping ($3,680.00 — the established UI style).
 * 4. History event subject "Jennifer Stitt — Jennifer Stitt — Booking
 *    Performance" — PIP titles already carry the employee name; no doubling.
 * 5. Sync Center provider labels — internal enums (google_sheets,
 *    acuity_availability) render as their display names.
 */
import { describe, expect, test } from "bun:test";
import { cyclePoolChipView, poolChip, weekCellView } from "../../components/commission-views";
import { providerLabel } from "../../components/settings-views";
import { formatMoney } from "../../server/metrics/report-text";
import { historySubjectLabel } from "../../routes/performance-history";
import type { CommissionWeeklyRow } from "../../server/store/types";

function weekRow(overrides: Partial<CommissionWeeklyRow>): CommissionWeeklyRow {
  return {
    id: "w1",
    cycle_id: "c1",
    user_id: "u1",
    rep_name: "Rep",
    week_start: "2026-08-31",
    week_end: "2026-09-06",
    employment_type: "full_time",
    tier: 5,
    tier_effective_date_used: "2026-08-31",
    qualifying_bookings: 35,
    base_commission: 700,
    additional_commission: 0,
    pool_bonus: 0,
    hole_bonus: 0,
    manual_adjustment: 0,
    total: 700,
    calc_version: 2,
    assignment: "previously_submitted",
    hole_bonus_capped: true,
    hole_audit: [],
    counted_bookings: [],
    pool_unlocked: false,
    ...overrides,
  } as CommissionWeeklyRow;
}

describe("QA phase 2 — cycle pool chip keys on pool money paid, not cycle bookings", () => {
  test("a cycle whose weeks never reached 79 renders Pool Locked (was: Unlocked via the 228 sum)", () => {
    // The live stored cycle: 49+58+61+60 = 228 bookings, pool payouts $0.00.
    const view = cyclePoolChipView(true, 0);
    expect(view.label).toBe("Pool Locked");
    expect(view.kind).toBe("neutral");
  });

  test("a cycle that paid pool money renders Pool Unlocked (positive)", () => {
    const view = cyclePoolChipView(true, 395);
    expect(view.label).toBe("Pool Unlocked");
    expect(view.kind).toBe("positive");
  });

  test("no stored records → honest 'Pool —' gap, never an invented state", () => {
    expect(cyclePoolChipView(false, null).label).toBe("Pool —");
    expect(cyclePoolChipView(true, null).label).toBe("Pool —");
  });

  test("the per-week pool chip semantics are unchanged (locks untouched)", () => {
    expect(poolChip(false, 49).label).toBe("Pool Locked");
    expect(poolChip(true, 79).label).toBe("Pool Unlocked");
  });
});

describe("QA phase 2 — capped-hole cell copy agrees in number", () => {
  test("one capped fill reads '1 hole not paid (ruling 10/2)'", () => {
    const cell = weekCellView(weekRow({ hole_bonus_capped: true, hole_audit: [{ bonus_cents: 1000 } as never] }));
    expect(cell?.holesLine).toBe("1 hole not paid (ruling 10/2)");
  });

  test("two capped fills read '2 holes not paid (ruling 10/2)'", () => {
    const cell = weekCellView(
      weekRow({ hole_bonus_capped: true, hole_audit: [{ bonus_cents: 1000 } as never, { bonus_cents: 1000 } as never] }),
    );
    expect(cell?.holesLine).toBe("2 holes not paid (ruling 10/2)");
  });

  test("an uncapped paid hole keeps its money line", () => {
    const cell = weekCellView(weekRow({ hole_bonus_capped: false, hole_bonus: 10, hole_audit: [{ bonus_cents: 1000 } as never] }));
    expect(cell?.holesLine).toBe("+$10.00 holes (1)");
  });
});

describe("QA phase 2 — formatMoney groups thousands (established $X,XXX.00 style)", () => {
  test("cycle-scale totals group: $3,680.00 / $3,250.00", () => {
    expect(formatMoney(3680)).toBe("$3,680.00");
    expect(formatMoney(3250)).toBe("$3,250.00");
    expect(formatMoney(1250.5)).toBe("$1,250.50");
  });

  test("sub-thousand values are unchanged (payroll-email pin compatibility)", () => {
    expect(formatMoney(800)).toBe("$800.00");
    expect(formatMoney(460)).toBe("$460.00");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(null)).toBe("—");
  });
});

describe("QA phase 2 — history subject never doubles the employee name", () => {
  test("a title that already opens with the employee renders once", () => {
    expect(historySubjectLabel("Jennifer Stitt", "Jennifer Stitt — Booking Performance")).toBe(
      "Jennifer Stitt — Booking Performance",
    );
  });

  test("a title without the employee keeps the 'Employee — title' join", () => {
    expect(historySubjectLabel("Jennifer Stitt", "Call Activity")).toBe("Jennifer Stitt — Call Activity");
  });

  test("missing pieces fall back honestly", () => {
    expect(historySubjectLabel(null, "Jennifer Stitt — Booking Performance")).toBe(
      "Unassigned — Jennifer Stitt — Booking Performance",
    );
    expect(historySubjectLabel("Jennifer Stitt", null)).toBe("Jennifer Stitt");
    expect(historySubjectLabel(null, null)).toBe("Unassigned");
  });
});

describe("QA phase 2 — sync provider labels are display names, not raw enums", () => {
  test("the four sync providers map to their product names", () => {
    expect(providerLabel("highlevel")).toBe("HighLevel");
    expect(providerLabel("acuity")).toBe("Acuity");
    expect(providerLabel("google_sheets")).toBe("Google Sheets");
    expect(providerLabel("acuity_availability")).toBe("Acuity Availability");
    expect(providerLabel("attribution")).toBe("Attribution");
  });

  test("unknown providers fall back to the stored label (never blank)", () => {
    expect(providerLabel("future_provider")).toBe("future_provider");
  });
});
