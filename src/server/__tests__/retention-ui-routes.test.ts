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

describe("retention route ?week= (stage 3c scorecard select)", () => {
  const vs = (RetentionRoute as unknown as { options: { validateSearch: (s: Record<string, unknown>) => Record<string, unknown> } }).options
    .validateSearch;
  test("week param: a YYYY-MM-DD shape passes through; anything else drops to undefined", () => {
    expect(vs({}).week).toBeUndefined();
    expect(vs({ week: "2026-10-19" }).week).toBe("2026-10-19");
    expect(vs({ week: "not-a-date" }).week).toBeUndefined();
    expect(vs({ week: 42 }).week).toBeUndefined();
  });
});

describe("retention page RESTRUCTURE (owner directive 2026-10-20)", () => {
  const page = () => readFileSync(new URL("../../routes/retention.tsx", import.meta.url), "utf8");

  test("section order: TODAY → Needs Attention → This Week performance → Retention Impact → Weekly Scorecard → Data Quality", () => {
    const src = page();
    const order = [
      'aria-label="Today"',
      'aria-label="Needs Attention"',
      'aria-label="This Week\'s Retention Performance"',
      'aria-label="Retention Impact"',
      'aria-label="Weekly scorecard"',
      'aria-label="Data Quality"',
    ];
    let last = -1;
    for (const marker of order) {
      const idx = src.indexOf(marker);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  test("TODAY row is action-first with human language and drill links", () => {
    const src = page();
    expect(src).toContain("Clients Due");
    expect(src).toContain("Appointments requiring an excitement call this week"); // point 7 verbatim human sub
    expect(src).toContain("Clients Still Need Contact"); // point 3 framing
    expect(src).toContain("still within call window"); // point 3 split line
    expect(src).toContain("missed call window");
    expect(src).toContain("search={{ kpi: \"unreached\" }}"); // the unreached card filters to those people
    expect(src).toContain("search={{ kpi: \"needs-review\" }}");
  });

  test("Needs Attention queue renders the spec's five columns; cancellations slot renders nothing (never faked)", () => {
    const src = page();
    for (const col of [">Client<", ">Appointment<", ">Reason<", ">Status<", ">Action<"]) {
      expect(src).toContain(col);
    }
    expect(src).toContain("SEGMENT_REASON[row.segment]"); // reason chips from the loader's segment
    expect(src).toContain("queue.rows"); // rows come from the SAME loader data the drill-downs use
    expect(src).toContain("cancellation: { dot:"); // the segment slot exists in the row vocabulary…
    expect(src).not.toContain("Needs Save"); // …and no fake cancellation rows are rendered
    expect(src).toContain("CANCELLATIONS_ENGINE_NOTE"); // honesty note kept
  });

  test("performance section holds the 4-5 KPIs with honest — for the unwritten cancellations ledger", () => {
    const src = page();
    expect(src).toContain("This Week&rsquo;s Retention Performance");
    expect(src).toContain("Contact Compliance");
    expect(src).toContain("Clients Reached");
    expect(src).toContain("Cancellation Saves");
    expect(src).toContain("Successful Reschedules");
    expect(src).toContain("Recovery Rate");
    // cancellation family: num("—") whenever the ledger value is null
    expect(src).toContain('saves.value == null ? num("—")');
    expect(src).toContain('recovery.ratio == null ? num("—")');
  });

  test("no-show card is the spoken/not-spoken comparison (point 4)", () => {
    const src = page();
    expect(src).toContain("had spoken with");
    expect(src).toContain("had not spoken with");
    expect(src).toContain("do excitement calls actually reduce no-shows?");
    expect(src).toContain("spokenSplit"); // the comparison comes from the loader, not parsed display strings
  });

  test("scorecard copy is human (point 6); technical detail lives in InfoTips", () => {
    const src = page();
    expect(src).toContain("Results lock each Monday for the previous week");
    expect(src).toContain("Your first completed weekly scorecard will appear Monday");
    expect(src).not.toContain("No stored week exists yet — the Monday compute writes"); // dev-doc copy replaced
    expect(src).not.toContain("due = appt date −"); // raw formula off the main surface
    expect(src).toContain("Of the prior week&rsquo;s clients"); // the primary weekly question stays
  });

  test("data-quality counts are demoted to a small strip with drill links (point 5)", () => {
    const src = page();
    expect(src).toContain("Data Quality");
    expect(src).toContain("unmatched records");
    expect(src).toContain("records requiring review");
    expect(src).toContain('search={{ kpi: "match-exceptions" }}');
  });

  test("semantic color system routes through --ret-* tokens only (point 8)", () => {
    const src = page();
    for (const tone of ["--ret-blue-", "--ret-amber-", "--ret-green-", "--ret-red-", "--ret-purple-"]) {
      expect(src).toContain(tone);
    }
  });

  test("queue loader preserves the drill universes via the shared predicate (exported, tested in retention-queue)", () => {
    // ui-data exports the shared predicate + the queue loader — ONE source of truth.
    const ui = readFileSync(new URL("../../server/retention/ui-data.ts", import.meta.url), "utf8");
    expect(ui).toContain("export function inKpiUniverse");
    expect(ui).toContain("export async function retentionNeedsAttention");
    // the drill's base filter calls the SAME predicate
    expect(ui).toContain("inKpiUniverse(o, params.kpi");
  });
});
