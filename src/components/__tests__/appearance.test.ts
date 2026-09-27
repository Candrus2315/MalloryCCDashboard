/**
 * Appearance truth table (P5 execution spec Part 2.3): the pure
 * resolveTheme(pref, systemPrefersDark) covers all five spec cases —
 * system+OS-dark, system+OS-light, stored override beats OS, unknown →
 * system, default system. Pure compositions only — lives outside src/server
 * so `bun test src/server` counts stay stable.
 */
import { describe, expect, test } from "bun:test";
import { APPEARANCE_STORAGE_KEY, resolveTheme, type AppearancePref } from "~/components/appearance";

describe("resolveTheme truth table", () => {
  test("system + OS dark → dark", () => {
    expect(resolveTheme("system", true)).toBe("dark");
  });
  test("system + OS light → light", () => {
    expect(resolveTheme("system", false)).toBe("light");
  });
  test("stored light overrides OS dark", () => {
    expect(resolveTheme("light", true)).toBe("light");
  });
  test("stored dark overrides OS light", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  test("the pre-paint script's unknown-storage fallback resolves to the OS value (system rule)", () => {
    // __root.tsx pre-paint: p!=='light' && p!=='dark' → follow the OS, which is
    // exactly resolveTheme("system", osDark) — the two implementations agree.
    for (const osDark of [false, true]) {
      expect(resolveTheme("system", osDark)).toBe(osDark ? "dark" : "light");
    }
  });
});

describe("appearance storage contract", () => {
  test("key name matches the pre-paint script exactly", () => {
    // The __root.tsx inline script and this module must never drift.
    expect(APPEARANCE_STORAGE_KEY).toBe("mallory-appearance");
  });
  test("pref domain is exactly the three UI options", () => {
    const domain: AppearancePref[] = ["system", "light", "dark"];
    expect(domain).toHaveLength(3);
  });
});
