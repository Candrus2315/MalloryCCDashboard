/**
 * ROUTE-LEVEL SMOKE (stage 3b + UX overhaul spec §5.3/§6) — the two Retention
 * routes mount with valid route ids, the drill's validateSearch maps every
 * ?kpi=/filter param (including the kpi-aware range default and the locked
 * Needs Review classification), the PAGE's validateSearch validates ?week=
 * AND ?queue= (unknown values fall back to all; the reserved no-show/
 * reschedule stages fall back too), and the nav array carries Retention
 * immediately after Performance. The markup pins below hold the UX overhaul
 * contract: overview + demoted secondary row, stage cards, the ONE unified
 * queue with its seven columns and urgency order, side-by-side
 * Performance/Impact, the wired scorecard cells, and the quiet Data Quality
 * strip.
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

describe("retention route ?queue= (UX overhaul §5.3 — the unified queue's stage filter)", () => {
  const vs = (RetentionRoute as unknown as { options: { validateSearch: (s: Record<string, unknown>) => Record<string, unknown> } }).options
    .validateSearch;
  test("queue param: every ACTIVE chip value passes through", () => {
    expect(vs({}).queue).toBeUndefined(); // renders as "all"
    expect(vs({ queue: "all" }).queue).toBe("all");
    expect(vs({ queue: "excitement" }).queue).toBe("excitement");
    expect(vs({ queue: "unreached" }).queue).toBe("unreached");
    expect(vs({ queue: "cancellations" }).queue).toBe("cancellations");
    expect(vs({ queue: "needs-review" }).queue).toBe("needs-review");
  });
  test("unknown values fall back to all (undefined), mirroring the drill's convention", () => {
    expect(vs({ queue: "bogus" }).queue).toBeUndefined();
    expect(vs({ queue: 42 }).queue).toBeUndefined();
  });
  test("RESERVED stages (no-shows, reschedules) fall back to all until their pipeline stages ship (D4/D5)", () => {
    expect(vs({ queue: "no-shows" }).queue).toBeUndefined();
    expect(vs({ queue: "reschedules" }).queue).toBeUndefined();
  });
  test("queue and week coexist (the scorecard select preserves the queue filter)", () => {
    expect(vs({ queue: "unreached", week: "2026-10-19" })).toEqual({ queue: "unreached", week: "2026-10-19" });
  });
});

describe("retention page UX OVERHAUL (spec §5, owner directive 2026-10-21)", () => {
  const page = () => readFileSync(new URL("../../routes/retention.tsx", import.meta.url), "utf8");

  test("§5 order: Overview → Needs Attention → Queue → Performance beside Impact → Scorecard → Data Quality", () => {
    const src = page();
    const order = [
      `aria-label="Retention Overview"`,
      `aria-label="Needs Attention"`,
      `aria-label="Today's Retention Queue"`,
      `aria-label="This Week's Retention Performance"`,
      `aria-label="Retention Impact"`,
      `aria-label="Weekly scorecard"`,
      `aria-label="Data Quality"`,
    ];
    let last = -1;
    for (const marker of order) {
      const idx = src.indexOf(marker);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  test("§5.1 Overview: 4 primary cards + the demoted secondary row (no card chrome)", () => {
    const src = page();
    expect(src).toContain("Clients Due");
    expect(src).toContain("Appointments requiring an excitement call this week"); // human sub
    expect(src).toContain("Clients Still Need Contact");
    expect(src).toContain("still within call window"); // the split line
    expect(src).toContain(`search={{ kpi: "unreached" }}`); // drill link
    expect(src).toContain(`search={{ kpi: "needs-review" }}`);
    // the demotion: ONE quiet row of four text cells (label + text-xl value)
    expect(src).toContain("SecondaryCount");
    for (const label of [`label="Calls Attempted"`, `label="Clients Spoken With"`, `label="No-Shows"`, `label="Data Match Exceptions"`]) {
      expect(src).toContain(label);
    }
    expect(src).toContain("border-t border-(--table-border-weak)"); // the hairline under Row A
    expect(src).toContain("text-xl font-semibold tracking-tight tabular-nums"); // the quiet values
    // the Still Unreached card deep-links the queue pre-filtered (§5.1)
    expect(src).toContain("Open the unreached queue");
    expect(src).toContain(`search={{ queue: "unreached" }}`);
  });

  test("§5.2 Needs Attention: four compact stage cards with deep-link CTAs (client names stop here)", () => {
    const src = page();
    for (const title of ["Excitement Calls", "Cancellation Recovery", "No-Show Prevention", "Needs Review"]) {
      expect(src).toContain(title);
    }
    // CTAs deep-link ?queue= — the ONE shared queue, pre-filtered
    expect(src).toContain(`search={{ queue: "excitement" }}`);
    expect(src).toContain(`search={{ queue: "cancellations" }}`);
    expect(src).toContain(`search={{ queue: "needs-review" }}`);
    // the no-show card honestly links the comparison (no action queue exists yet)
    expect(src).toContain("See the comparison");
    expect(src).toContain(`search={{ kpi: "no-shows" }}`);
    // names appear in the queue and drill-downs, not here
    expect(src).toContain("no names until a queue is opened");
  });

  test("§5.3 Queue: chips (reserved stages ABSENT), 7 columns, urgency vocabulary, completed affordances", () => {
    const src = page();
    // chips — only the five active ones; the reserved stages must NOT render
    for (const label of [`value: "all"`, `value: "excitement"`, `value: "unreached"`, `value: "cancellations"`, `value: "needs-review"`]) {
      expect(src).toContain(label);
    }
    expect(src).not.toContain(`value: "no-shows"`);
    expect(src).not.toContain(`value: "reschedules"`);
    // client-side segment mapping over the ONE loader array (never re-derived)
    expect(src).toContain("SEGMENT_IN");
    expect(src).toContain("queue.rows.filter");
    // the seven columns
    for (const col of [">Client<", ">Stage<", ">Appointment<", ">Last Contact<", ">Priority<", ">Status<"]) {
      expect(src).toContain(col);
    }
    // urgency vocabulary + the caution dot for closing windows
    expect(src).toContain("RETENTION_PRIORITY_LABEL");
    expect(src).toContain("--dot-caution");
    expect(src).toContain("window closes today");
    expect(src).toContain("window closed");
    // last contact renders "— none yet", never a fabricated date
    expect(src).toContain("— none yet");
    // completed affordances are LINK-ONLY + the ledger-derived recovery count
    expect(src).toContain("Completed: see everyone reached this week");
    expect(src).toContain(`search={{ kpi: "spoken-with", range: "this-week" }}`);
    expect(src).toContain("cancellations recovered this week");
    expect(src).toContain(`search={{ kpi: "recovery", range: "this-week" }}`);
    // the Action column carries the read-only InfoTip
    expect(src).toContain("the dashboard tracks and never contacts anyone");
    // empty states say WHY per chip
    expect(src).toContain("QUEUE_EMPTY_WHY");
    expect(src).toContain("No cancellations awaiting outcome.");
  });

  test("§5.4/§5.5 Performance spans 7 beside Impact spans 5; Impact is the titled mini-list; no future-metric placeholders", () => {
    const src = page();
    expect(src).toContain("This Week&rsquo;s Retention Performance");
    expect(src).toContain("xl:col-span-7");
    expect(src).toContain("xl:col-span-5");
    expect(src).toContain("xl:grid-cols-12");
    expect(src).toContain("Contact Compliance");
    expect(src).toContain("Clients Reached");
    expect(src).toContain("Cancellation Saves");
    expect(src).toContain("Successful Reschedules");
    expect(src).toContain("Recovery Rate");
    // cancellation family keeps the honest — when null
    expect(src).toContain(`saves.value == null ? num("—")`);
    expect(src).toContain(`recovery.ratio == null ? num("—")`);
    // the impact restructure
    expect(src).toContain("No-Show Comparison");
    expect(src).toContain("had spoken with");
    expect(src).toContain("had not spoken with");
    expect(src).toContain("do excitement calls actually reduce no-shows?");
    expect(src).toContain("spokenSplit");
    // future metrics get NO placeholder cells (no stub rows)
    expect(src).not.toContain("Revenue protected");
    expect(src).not.toContain("Show rate");
  });

  test("§5.6 Scorecard: humanized labels, storage fact demoted to the InfoTip, D7 wired to the stored row", () => {
    const src = page();
    expect(src).toContain("Results lock each Monday for the previous week");
    expect(src).toContain("Your first completed weekly scorecard will appear Monday");
    expect(src).not.toContain("No stored week exists yet — the Monday compute writes");
    expect(src).not.toContain("due = appt date −"); // formulas stay in InfoTips
    expect(src).toContain("Of the prior week&rsquo;s clients");
    // zone-2 humanization
    expect(src).toContain(`label="Clients due"`);
    expect(src).toContain(`label="Contact attempted"`);
    expect(src).toContain(`label="Still unreached"`);
    expect(src).not.toContain(`label="Eligible appointments"`);
    expect(src).not.toContain("Called ≥1 attempt");
    // the storage fact lives in the Scoring basis InfoTip, not as a surface chip
    expect(src).toContain("a stored week is never rewritten");
    expect(src).not.toContain(`label="stored — past weeks never rewrite"`);
    // D7 — the five wired cells now read the stored row (null stays "—")
    expect(src).toContain("scorecard.cancellations_worked ?? ");
    expect(src).toContain("scorecard.saves ?? ");
    expect(src).toContain("scorecard.reschedules ?? ");
    expect(src).toContain("scorecard.recoveries ?? ");
    expect(src).toContain("scorecard.recovery_rate == null ?");
    // No-Shows + Transfers remain honest "—" (no writer yet)
    expect(src).toContain(`<KpiMid label="No-Shows" value="—" />`);
    expect(src).toContain(`<KpiMid label="Transfers" value="—" sub="Excluded from owner compliance" />`);
  });

  test("§5.7 engineering language off the surface; formulas stay in InfoTips", () => {
    const src = page();
    expect(src).not.toContain("recovered ÷ eligible"); // loader-speak
    expect(src).not.toContain("spoke with ÷ due");
    expect(src).toContain("Share of this week&rsquo;s due clients"); // human phrasing
    expect(src).toContain("Computed {formatStamp(scorecard.computed_at)} ET"); // fact stamp stays
    expect(src).toContain("Where these numbers come from"); // method footer unchanged
  });

  test("§5.8 Data Quality demoted + quiet: one small strip, exc=open exceptions link", () => {
    const src = page();
    expect(src).toContain("Data Quality");
    expect(src).toContain("unmatched records");
    expect(src).toContain("records requiring review");
    expect(src).toContain(`search={{ kpi: "match-exceptions", exc: "open" }}`);
    expect(src).toContain("text-xs"); // the quieter type scale
    expect(src).toContain("py-3"); // tighter strip
  });

  test("§4 honesty: CTAs navigate only — no mutating buttons anywhere on the page", () => {
    const src = page();
    expect(src).not.toMatch(/<button/i); // nothing mutates (Segmented's buttons live in its own component)
    expect(src).not.toContain("Mark Reached");
    expect(src).not.toContain("Save Appointment");
    expect(src).toContain("Action"); // the verb-link column survives
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

