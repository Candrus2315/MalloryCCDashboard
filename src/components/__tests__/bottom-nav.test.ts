/**
 * Bottom tab bar tests (Mobile Phase 2). The bar is owner-specified chrome —
 * exactly five tabs in the owner's order with the owner's mobile labels
 * ("Teams", not "Team"), the secondary routes staying drawer-only, and the
 * shared active rule copied from __root.tsx ("/" exact, others prefix — so a
 * secondary route shows NO active tab). These guards keep that contract from
 * drifting; the component renders it verbatim from the same constants.
 */
import { describe, expect, test } from "bun:test";
import { BOTTOM_NAV_TABS, isBottomTabActive } from "../bottom-nav";

describe("bottom nav tab set", () => {
  test("carries exactly the owner's five tabs in the owner's order", () => {
    expect(BOTTOM_NAV_TABS.map((t) => t.to)).toEqual([
      "/",
      "/reps",
      "/team",
      "/availability",
      "/settings",
    ]);
  });

  test("labels use the owner's mobile wording (Teams, not Team)", () => {
    expect(BOTTOM_NAV_TABS.map((t) => t.label)).toEqual([
      "Today",
      "Reps",
      "Teams",
      "Availability",
      "Settings",
    ]);
  });

  test("secondary routes stay out of the bar (drawer-only reach path)", () => {
    const secondary = ["/daily-report", "/weekly", "/commissions", "/performance", "/audit"];
    for (const tab of BOTTOM_NAV_TABS) {
      expect(secondary).not.toContain(tab.to);
    }
  });
});

describe("bottom nav active rule (verbatim __root rule)", () => {
  test("Today matches the root path exactly", () => {
    expect(isBottomTabActive("/", "/")).toBe(true);
    expect(isBottomTabActive("/", "/reps")).toBe(false);
    expect(isBottomTabActive("/", "/availability")).toBe(false);
  });

  test("every other tab owns its path prefix", () => {
    expect(isBottomTabActive("/reps", "/reps")).toBe(true);
    expect(isBottomTabActive("/team", "/team")).toBe(true);
    expect(isBottomTabActive("/availability", "/availability")).toBe(true);
    expect(isBottomTabActive("/settings", "/settings")).toBe(true);
    // prefixes only — a tab never lights up on an unrelated path
    expect(isBottomTabActive("/reps", "/team")).toBe(false);
    expect(isBottomTabActive("/settings", "/settings-help" /* no such route, but prefix rule */)).toBe(true);
  });

  test("a secondary route shows NO active tab (honest state)", () => {
    for (const path of [
      "/daily-report",
      "/weekly",
      "/commissions",
      "/commissions-validation",
      "/performance",
      "/performance-templates",
      "/audit",
    ]) {
      const active = BOTTOM_NAV_TABS.filter((t) => isBottomTabActive(t.to, path));
      expect(active).toEqual([]);
    }
  });
});
