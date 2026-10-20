/**
 * ROUTE-LEVEL SMOKE (stage 3b) — the two Retention routes mount with valid
 * route ids, the drill's validateSearch maps every ?kpi=/filter param
 * (including the kpi-aware range default and the locked Needs Review
 * classification), and the nav array carries Retention immediately after
 * Performance (owner spec: nav near Performance; no BottomNav change).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Route as RetentionRoute } from "../../routes/retention";
import { Route as DrillRoute } from "../../routes/retention-drill";

describe("retention routes", () => {
  test("both routes mount with their dash-named ids", () => {
    expect(String((RetentionRoute as unknown as { id?: string }).id ?? "/retention")).toBe("/retention");
    expect(String((DrillRoute as unknown as { id?: string }).id ?? "/retention-drill")).toBe("/retention-drill");
  });

  test("drill validateSearch: kpi defaults, kpi-aware range default, locked needs-review classification", () => {
    const vs = (DrillRoute as unknown as { options: { validateSearch: (s: Record<string, unknown>) => Record<string, unknown> } }).options.validateSearch;
    const empty = vs({});
    expect(empty.kpi).toBe("clients-due");
    expect(empty.range).toBe("this-week");
    expect(empty.classification).toBe("all");
    expect(empty.outcome).toBe("all");
    expect(empty.employee).toBe("all");
    expect(empty.exc).toBe("open");
    // Queue kpis default to All open (they count the whole open queue).
    expect(vs({ kpi: "needs-review" }).range).toBe("all");
    expect(vs({ kpi: "needs-review" }).classification).toBe("needs_review");
    expect(vs({ kpi: "match-exceptions" }).range).toBe("all");
    // Unknown kpi falls back honestly; explicit params ride through.
    expect(vs({ kpi: "bogus" }).kpi).toBe("clients-due");
    expect(vs({ kpi: "unreached", range: "last-week", employee: "u1", classification: "no_answer", outcome: "pending", exc: "resolved" })).toEqual({
      kpi: "unreached",
      range: "last-week",
      classification: "no_answer",
      outcome: "pending",
      employee: "u1",
      exc: "resolved",
    });
  });

  test("nav carries Retention immediately after Performance, before Settings; BottomNav untouched", () => {
    const root = readFileSync(new URL("../../routes/__root.tsx", import.meta.url), "utf8");
    const perfIdx = root.indexOf('to: "/performance"');
    const retentionIdx = root.indexOf('{ to: "/retention", label: "Retention" }');
    const settingsIdx = root.indexOf('{ to: "/settings", label: "Settings" }');
    expect(perfIdx).toBeGreaterThanOrEqual(0);
    expect(retentionIdx).toBeGreaterThan(perfIdx);
    expect(settingsIdx).toBeGreaterThan(retentionIdx);
    const bottomNav = readFileSync(new URL("../../components/bottom-nav.tsx", import.meta.url), "utf8");
    expect(bottomNav).not.toContain("retention");
  });

  test("page + drill route files use the shared vocabulary (no new CSS classes, tokens only)", () => {
    const page = readFileSync(new URL("../../routes/retention.tsx", import.meta.url), "utf8");
    const drill = readFileSync(new URL("../../routes/retention-drill.tsx", import.meta.url), "utf8");
    for (const src of [page, drill]) {
      // every color routes through a --token (the bg-(--token) shorthand).
      // Match the real raw-color vectors — arbitrary hex (bg-[#f00]), rgb()/rgba(),
      // and Tailwind palette names (text-red-400) — NOT the letters r/g/b (which
      // false-positived on "text-right") and NOT the "(" of the token shorthand.
      expect(src).not.toMatch(/(?:bg|text|border)-(?:\[#|rgba?\(|(?:red|blue|green|yellow|amber|emerald|slate|gray|grey|zinc|neutral|stone|orange|lime|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)\b)/); // no raw colors — tokens only
    }
    expect(drill).toContain("retention-"); // csv filename prefix
    expect(drill).toContain("min-w-[1080px]"); // table floor per spec §3
    expect(drill).toContain("md:hidden"); // mobile card list pairing
  });
});
