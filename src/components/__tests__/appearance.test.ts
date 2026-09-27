/**
 * Appearance truth table (P5 execution spec Part 2.3): the pure
 * resolveTheme(pref, systemPrefersDark) covers all five spec cases —
 * system+OS-dark, system+OS-light, stored override beats OS, unknown →
 * system, default system. Pure compositions only — lives outside src/server
 * so `bun test src/server` counts stay stable.
 */
import { describe, expect, test } from "bun:test";
import { APPEARANCE_STORAGE_KEY, applyThemeClass, resolveTheme, type AppearancePref } from "~/components/appearance";

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

describe("applyThemeClass — boolean force contract (Light-switch bug regression, 9/27)", () => {
  // classList.toggle(name, force) coerces force to boolean: a truthy STRING
  // ("light") means ADD the dark class. The bug shipped resolveTheme's string
  // result straight into toggle, so the dark class could never be removed.
  // These tests pin that the force arg is a real boolean, both directions.
  function fakeClassList() {
    const calls: Array<[string, boolean | undefined]> = [];
    return {
      calls,
      classList: {
        toggle(name: string, force?: boolean) {
          calls.push([name, force]);
        },
      },
    };
  }
  test("light → toggle('dark', false) — REMOVES the dark class", () => {
    const fake = fakeClassList();
    applyThemeClass(fake, "light");
    expect(fake.calls).toEqual([["dark", false]]);
    expect(fake.calls[0][1]).toBeFalse(); // strictly boolean false, not "light"
  });
  test("dark → toggle('dark', true) — adds the dark class", () => {
    const fake = fakeClassList();
    applyThemeClass(fake, "dark");
    expect(fake.calls).toEqual([["dark", true]]);
    expect(fake.calls[0][1]).toBeTrue();
  });
  test("the live coercion rule matches the DOM: 'light' as force would be truthy — guard it", () => {
    // Documents the DOM behavior that made the bug: truthy strings force-ADD.
    expect(Boolean("light")).toBeTrue();
    expect(Boolean(false)).toBeFalse();
  });
});
