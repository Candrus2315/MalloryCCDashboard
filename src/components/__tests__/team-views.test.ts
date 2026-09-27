/**
 * Guards for the Team-page presentation rules (design/team-redesign-spec.md):
 * the pacing sentence's honest pace clauses (weekend pace=0 shows the metrics
 * layer's own note, never an invented number), lead-budget-pace verdicts,
 * chip rules (no grades — per-rep goals are not in the payload), and the
 * attention panel's risk-first rule order. Presentation-side only: everything
 * here composes existing metric outputs. Lives outside src/server so
 * `bun test src/server` counts stay stable.
 */
import { describe, expect, test } from "bun:test";
import {
  attentionNotes,
  compareRepRows,
  diffSampleDenominator,
  goalCell,
  leadPacing,
  paceSummary,
  repChips,
  restrainedDiff,
  SMALL_SAMPLE_FOOTNOTE,
} from "~/components/team-views";
import type { TeamRangeMetrics, TrendPoint } from "~/server/metrics/compute";
import type { RepStripRow } from "~/server/queries";

const metrics = (over: Partial<TeamRangeMetrics> = {}): TeamRangeMetrics => ({
  totalCalls: 0,
  callsOverThreshold: 0,
  bookingsFromOverThreshold: 0,
  totalBookings: 0,
  assignedLeads: 0,
  conversationConversion: null,
  assignedLeadConversion: null,
  avgCallDurationSeconds: null,
  goal: { value: 79, basis: "team-goal", note: "79 from stored team goals" },
  actual: 0,
  remaining: 79,
  goalAchievement: 0,
  paceNeeded: 0,
  paceDaysLeft: 5,
  paceNote: "5 working days left through Fri, Sep 25",
  ...over,
});

const point = (key: string, over: Partial<TrendPoint> = {}): TrendPoint => ({
  key,
  label: key,
  bookings: 0,
  calls: 0,
  callsOverThreshold: 0,
  bookingsFromOverThreshold: 0,
  conversationConversion: null,
  assignedLeadConversion: null,
  avgCallDurationSeconds: null,
  leads: 0,
  family: 0,
  animalia: 0,
  budgetRef: 0,
  ...over,
});

const rep = (id: string, name: string, over: Partial<RepStripRow> = {}): RepStripRow => ({
  id,
  name,
  totalBookings: 0,
  callsOverThreshold: 0,
  conversationConversion: null,
  totalCalls: 0,
  avgCallDurationSeconds: null,
  goal: null,
  operatingState: "active" as const,
  callStartDate: null,
  ...over,
});

describe("paceSummary (spec §2: one pacing unit, honest pace clauses)", () => {
  test("last working day → 'needed today (last working day)'", () => {
    const ps = paceSummary({
      metrics: metrics({
        actual: 51,
        remaining: 28,
        goalAchievement: 51 / 79,
        paceNeeded: 28,
        paceDaysLeft: 1,
        paceNote: "1 working day left through Fri, Sep 25",
      }),
      rangeEnd: "2026-09-25",
      today: "2026-09-25",
    });
    expect(ps.achieved).toBe("64.6%");
    expect(ps.remaining).toBe("28");
    expect(ps.paceClause).toBe("28 needed today (last working day)");
    expect(ps.paceFootnote).toBe("1 working day left through Fri, Sep 25");
    expect(ps.barPct).toBeCloseTo((51 / 79) * 100);
    expect(ps.hit).toBe(false);
  });

  test("mid-week → per-working-day phrasing", () => {
    const ps = paceSummary({
      metrics: metrics({ actual: 20, remaining: 59, goalAchievement: 20 / 79, paceNeeded: 15, paceDaysLeft: 4 }),
      rangeEnd: "2026-09-24",
      today: "2026-09-22",
    });
    expect(ps.paceClause).toBe("15 needed per working day");
    expect(ps.paceFootnote).toBe("5 working days left through Fri, Sep 25"); // metrics layer's note, verbatim
  });

  test("weekend (pace=0, range open) → 0 needed today + the metrics layer's own note", () => {
    const ps = paceSummary({
      metrics: metrics({
        actual: 51,
        remaining: 28,
        goalAchievement: 51 / 79,
        paceNeeded: 0,
        paceDaysLeft: 0,
        paceNote: "work week complete — pace resumes Monday",
      }),
      rangeEnd: "2026-09-26",
      today: "2026-09-26",
    });
    expect(ps.paceClause).toBe("0 needed today · work week complete — pace resumes Monday");
    expect(ps.paceFootnote).toBeNull();
  });

  test("ended range → no pace needed", () => {
    const ps = paceSummary({
      metrics: metrics({ paceNeeded: 0, paceDaysLeft: 0, paceNote: "range already ended — no pace needed" }),
      rangeEnd: "2026-09-19",
      today: "2026-09-26",
    });
    expect(ps.paceClause).toBe("No pace needed — range already ended.");
  });

  test("goal reached → bar fills, remaining 0, hit", () => {
    const ps = paceSummary({
      metrics: metrics({ actual: 80, remaining: 0, goalAchievement: 80 / 79, paceNeeded: 0, paceDaysLeft: 0 }),
      rangeEnd: "2026-09-26",
      today: "2026-09-26",
    });
    expect(ps.barPct).toBe(100);
    expect(ps.hit).toBe(true);
    expect(ps.remaining).toBe("0");
  });

  test("no goal → no achievement, no bar", () => {
    const ps = paceSummary({
      metrics: metrics({ goal: { value: 0, basis: "with-default", note: "no goal" } }),
      rangeEnd: "2026-09-26",
      today: "2026-09-26",
    });
    expect(ps.achieved).toBeNull();
    expect(ps.barPct).toBeNull();
  });
});

describe("leadPacing (spec §4: are we getting enough leads?)", () => {
  test("below budget pace", () => {
    const lp = leadPacing([
      point("2026-09-21", { leads: 10, budgetRef: 20 }),
      point("2026-09-22", { leads: 12, budgetRef: 20 }),
      point("2026-09-23", { leads: 11, budgetRef: 20 }),
      point("2026-09-24", { leads: 10, budgetRef: 20 }),
      point("2026-09-25", { leads: 10, budgetRef: 20 }),
    ]);
    expect(lp.leads).toBe(53);
    expect(lp.budget).toBeCloseTo(100);
    expect(lp.verdict).toBe("Below budget pace");
    expect(lp.delta).toBe("−47 leads");
    expect(lp.pct).toBe("53%");
  });

  test("above budget pace", () => {
    const lp = leadPacing([
      point("2026-09-21", { leads: 60, budgetRef: 50 }),
      point("2026-09-22", { leads: 52, budgetRef: 50 }),
    ]);
    expect(lp.verdict).toBe("Above budget pace");
    expect(lp.delta).toBe("+12 leads");
    expect(lp.pct).toBe("112%");
  });

  test("on budget pace → no delta", () => {
    const lp = leadPacing([point("2026-09-21", { leads: 50, budgetRef: 50 })]);
    expect(lp.verdict).toBe("On budget pace");
    expect(lp.delta).toBeNull();
  });

  test("no budget → verdict null, leads still reported", () => {
    const lp = leadPacing([point("2026-09-21", { leads: 9 })]);
    expect(lp.leads).toBe(9);
    expect(lp.verdict).toBeNull();
    expect(lp.delta).toBeNull();
    expect(lp.pct).toBeNull();
  });
});

describe("repChips (spec §5: real metrics only, no grades)", () => {
  test("unique top bookings → Top performer", () => {
    const chips = repChips([
      rep("a", "A", { totalBookings: 9 }),
      rep("b", "B", { totalBookings: 4, conversationConversion: 0.2 }),
      rep("c", "C", { totalBookings: 3, conversationConversion: 0.4 }),
      rep("d", "D", { totalBookings: 1, conversationConversion: 0.4 }),
    ]);
    expect(chips.get("a")).toEqual({ kind: "positive", label: "Top performer" });
    expect(chips.get("b")).toBeUndefined(); // below the qualifying average → no chip
  });

  test("conversion above team average (≥3 qualifying) → Strong conversion", () => {
    const chips = repChips([
      rep("a", "A", { totalBookings: 9, conversationConversion: 0.5, callsOverThreshold: 9 }),
      rep("b", "B", { totalBookings: 4, conversationConversion: 0.2, callsOverThreshold: 8 }),
      rep("c", "C", { totalBookings: 3, conversationConversion: 0.3, callsOverThreshold: 7 }),
      rep("d", "D", { totalBookings: 1, conversationConversion: 0.6, callsOverThreshold: 6 }),
    ]);
    expect(chips.get("d")).toEqual({ kind: "positive", label: "Strong conversion" });
  });

  test("§9 chip fix: Strong conversion needs MIN_CONVERSION_SAMPLE qualifying calls", () => {
    // D's 60% stands on only 4 qualifying calls (< MIN_CONVERSION_SAMPLE=5) →
    // NO positive chip even though it exceeds the team average.
    const chips = repChips([
      rep("a", "A", { totalBookings: 9, conversationConversion: 0.5, callsOverThreshold: 10 }),
      rep("b", "B", { totalBookings: 4, conversationConversion: 0.2, callsOverThreshold: 10 }),
      rep("c", "C", { totalBookings: 3, conversationConversion: 0.3, callsOverThreshold: 10 }),
      rep("d", "D", { totalBookings: 1, conversationConversion: 0.6, callsOverThreshold: 4 }),
    ]);
    expect(chips.get("d")).toBeUndefined();
    // exactly 5 qualifying calls → the chip earns itself
    const withSample = repChips([
      rep("a", "A", { totalBookings: 9, conversationConversion: 0.5, callsOverThreshold: 10 }),
      rep("b", "B", { totalBookings: 4, conversationConversion: 0.2, callsOverThreshold: 10 }),
      rep("c", "C", { totalBookings: 3, conversationConversion: 0.3, callsOverThreshold: 10 }),
      rep("d", "D", { totalBookings: 1, conversationConversion: 0.6, callsOverThreshold: 5 }),
    ]);
    expect(withSample.get("d")).toEqual({ kind: "positive", label: "Strong conversion" });
  });

  test("§9 chip fix: all-zero team → no positive chips", () => {
    const chips = repChips([
      rep("a", "A", { conversationConversion: 0, callsOverThreshold: 8 }),
      rep("b", "B", { conversationConversion: 0, callsOverThreshold: 6 }),
      rep("c", "C", { conversationConversion: 0, callsOverThreshold: 7 }),
      rep("d", "D", { conversationConversion: 0, callsOverThreshold: 5 }),
    ]);
    for (const id of ["a", "b", "c", "d"]) {
      expect(chips.get(id)?.kind).not.toBe("positive");
    }
  });

  test("§10: not-yet-active rep → Not Yet Active chip, no activity/attention chips", () => {
    const chips = repChips([
      rep("a", "A", { totalBookings: 9 }),
      rep("d", "Dan", { operatingState: "not-yet-active" as const, callStartDate: "2026-09-28" }),
    ]);
    expect(chips.get("d")).toEqual({ kind: "neutral", label: "Not Yet Active" });
  });

  test("fewer than 3 qualifying conversions → no average, no chip", () => {
    const chips = repChips([
      rep("a", "A", { totalBookings: 9, conversationConversion: 0.1 }),
      rep("b", "B", { totalBookings: 4, conversationConversion: 0.9 }),
      rep("c", "C", { totalBookings: 3 }),
    ]);
    expect(chips.get("b")).toBeUndefined();
  });

  test("no activity → neutral chip; calls but no bookings → needs attention", () => {
    const chips = repChips([
      rep("a", "A", { totalBookings: 9 }),
      rep("b", "B", { callsOverThreshold: 7 }),
      rep("c", "C"),
    ]);
    expect(chips.get("c")).toEqual({ kind: "neutral", label: "No activity" });
    expect(chips.get("b")).toEqual({ kind: "risk", label: "Needs attention" });
  });

  test("tied max bookings → no Top performer", () => {
    const chips = repChips([
      rep("a", "A", { totalBookings: 9 }),
      rep("b", "B", { totalBookings: 9 }),
      rep("c", "C", { totalBookings: 1 }),
    ]);
    expect(chips.get("a")).toBeUndefined();
    expect(chips.get("b")).toBeUndefined();
  });
});

describe("attentionNotes (spec §6: rule-based, 3–5, risks first)", () => {
  test("behind pace with working days left → goal-pace risk first", () => {
    const notes = attentionNotes({
      metrics: metrics({ actual: 51, remaining: 28, goalAchievement: 51 / 79, paceNeeded: 28, paceDaysLeft: 1 }),
      points: [],
      bucketMode: "day",
      repRows: [rep("a", "A", { totalBookings: 51 })],
      rangeEnd: "2026-09-25",
      today: "2026-09-25",
    });
    expect(notes[0]?.severity).toBe("risk");
    expect(notes[0]?.text).toContain("64.6% of goal with 1 working day remaining");
  });

  test("goal reached → positive note", () => {
    const notes = attentionNotes({
      metrics: metrics({ actual: 82, remaining: 0, goalAchievement: 82 / 79 }),
      points: [],
      bucketMode: "day",
      repRows: [],
      rangeEnd: "2026-09-26",
      today: "2026-09-26",
    });
    expect(notes[0]?.severity).toBe("positive");
    expect(notes[0]?.text).toContain("Booking goal reached: 82 of 79");
  });

  test("pace vs recent daily average — weekend buckets excluded, avg below pace → risk", () => {
    const points = [
      point("2026-09-21", { bookings: 2 }),
      point("2026-09-22", { bookings: 2 }),
      point("2026-09-23", { bookings: 2 }),
      point("2026-09-24", { bookings: 2 }),
      point("2026-09-25", { bookings: 2 }),
      point("2026-09-26"), // Saturday — never in the recent-workday average
      point("2026-09-27"), // Sunday
    ];
    const notes = attentionNotes({
      metrics: metrics({ actual: 10, remaining: 69, goalAchievement: 10 / 79, paceNeeded: 28, paceDaysLeft: 5 }),
      points,
      bucketMode: "day",
      repRows: [],
      rangeEnd: "2026-09-27",
      today: "2026-09-27",
    });
    const pace = notes.find((n) => n.text.includes("recent daily booking average"));
    expect(pace?.severity).toBe("risk");
    expect(pace?.text).toContain("above the recent daily booking average of 2");
  });

  test("top rep, silent rep, and leads below budget all surface", () => {
    const notes = attentionNotes({
      metrics: metrics({ actual: 20, remaining: 59, goalAchievement: 20 / 79, paceNeeded: 0, paceDaysLeft: 0, paceNote: "work week complete — pace resumes Monday" }),
      points: [point("2026-09-21", { leads: 10, budgetRef: 100 / 7 })],
      bucketMode: "day",
      repRows: [rep("a", "Wittner", { totalBookings: 12 }), rep("b", "McKillop")],
      rangeEnd: "2026-09-26",
      today: "2026-09-26",
    });
    expect(notes.some((n) => n.rep === "Wittner" && n.text.includes("leads the team in bookings (12)"))).toBe(true);
    expect(notes.some((n) => n.rep === "McKillop" && n.text.includes("verify sync or lead assignment"))).toBe(true);
    expect(notes.some((n) => n.text.includes("Lead volume is below budget pace"))).toBe(true);
  });

  test("§10: a not-yet-active rep never triggers silent/no-booking attention notes", () => {
    const notes = attentionNotes({
      metrics: metrics({ actual: 12, remaining: 67, goalAchievement: 12 / 79, paceNeeded: 0, paceDaysLeft: 0, paceNote: "work week complete — pace resumes Monday" }),
      points: [point("2026-09-21", { leads: 20, budgetRef: 100 / 7 })],
      bucketMode: "day",
      repRows: [
        rep("a", "Wittner", { totalBookings: 12, callsOverThreshold: 30 }),
        rep("d", "Dan", { operatingState: "not-yet-active" as const, callStartDate: "2026-09-28" }),
      ],
      rangeEnd: "2026-09-25",
      today: "2026-09-25",
    });
    expect(notes.some((n) => n.rep === "Dan")).toBe(false);
  });

  test("assigned-lead conversion unavailable + healthy conversation → combined honest note", () => {
    const notes = attentionNotes({
      metrics: metrics({ actual: 5, totalBookings: 5, remaining: 74, goalAchievement: 5 / 79, conversationConversion: 0.42, callsOverThreshold: 12 }),
      points: [],
      bucketMode: "week",
      repRows: [],
      rangeEnd: "2026-09-26",
      today: "2026-09-26",
    });
    expect(notes.some((n) => n.text.includes("Assigned Lead Conversion is unavailable"))).toBe(true);
    expect(notes.some((n) => n.text.includes("Conversation conversion is 42.0%"))).toBe(true);
  });

  test("notes cap at 5 with risks ordered before positives", () => {
    const points = [
      point("2026-09-21", { leads: 1, budgetRef: 20, bookings: 1 }),
      point("2026-09-22", { leads: 1, budgetRef: 20, bookings: 1 }),
      point("2026-09-23", { leads: 1, budgetRef: 20, bookings: 1 }),
      point("2026-09-24", { leads: 1, budgetRef: 20, bookings: 1 }),
      point("2026-09-25", { leads: 1, budgetRef: 20, bookings: 1 }),
    ];
    const notes = attentionNotes({
      metrics: metrics({
        actual: 5,
        remaining: 74,
        goalAchievement: 5 / 79,
        paceNeeded: 28,
        paceDaysLeft: 5,
        assignedLeads: 0,
        totalBookings: 5,
        conversationConversion: 0.5,
      }),
      points,
      bucketMode: "day",
      repRows: [rep("a", "Top Rep", { totalBookings: 3 }), rep("b", "Silent Rep")],
      rangeEnd: "2026-09-27",
      today: "2026-09-27",
    });
    expect(notes.length).toBeLessThanOrEqual(5);
    const firstPositive = notes.findIndex((n) => n.severity === "positive");
    if (firstPositive >= 0) {
      expect(notes.slice(firstPositive).every((n) => n.severity === "positive")).toBe(true);
    }
  });
});

describe("goalCell (§7 Bookings cell: exact numbers, bar as §8 supplement)", () => {
  test("partial progress → '8 / 15.8' + '50.6%' + partial bar", () => {
    const c = goalCell(8, 15.8);
    expect(c.actual).toBe("8");
    expect(c.goal).toBe("15.8");
    expect(c.pct).toBe("50.6%");
    expect(c.barPct).toBeCloseTo(50.63, 1);
    expect(c.hit).toBe(false);
  });

  test("zero actual → 0.0%, bar at 0 (honest, not hidden)", () => {
    const c = goalCell(0, 15.8);
    expect(c.actual).toBe("0");
    expect(c.pct).toBe("0.0%");
    expect(c.barPct).toBe(0);
    expect(c.hit).toBe(false);
  });

  test("exactly at goal → 100.0%, bar full, hit", () => {
    const c = goalCell(15.8, 15.8);
    expect(c.pct).toBe("100.0%");
    expect(c.barPct).toBe(100);
    expect(c.hit).toBe(true);
  });

  test("over goal → pct keeps the real math, bar capped at 100", () => {
    const c = goalCell(20, 15.8);
    expect(c.pct).toBe("126.6%");
    expect(c.barPct).toBe(100);
    expect(c.hit).toBe(true);
  });

  test("null goal → numbers only, no bar, no pct (never an invented goal)", () => {
    const c = goalCell(8, null);
    expect(c.actual).toBe("8");
    expect(c.goal).toBeNull();
    expect(c.pct).toBeNull();
    expect(c.barPct).toBeNull();
    expect(c.hit).toBe(false);
  });

  test("literal 0 goal → '8 / 0' honestly, but ratio never renders as ∞", () => {
    const c = goalCell(8, 0);
    expect(c.goal).toBe("0");
    expect(c.pct).toBeNull();
    expect(c.barPct).toBeNull();
  });
});

describe("restrainedDiff (§11: thin-sample diffs are reference, not verdicts)", () => {
  test("truth table: denominators 0/1/2 restrain, ≥3 keep normal emphasis", () => {
    expect(restrainedDiff(700, 0)).toBe(true);
    expect(restrainedDiff(700, 1)).toBe(true);
    expect(restrainedDiff(700, 2)).toBe(true);
    expect(restrainedDiff(700, 3)).toBe(false);
    expect(restrainedDiff(700, 10)).toBe(false);
  });

  test("null diff → restrained-neutral (nothing to emphasize)", () => {
    expect(restrainedDiff(null, 10)).toBe(true);
  });

  test("unknown denominator → restrained (never shout on an unclear basis)", () => {
    expect(restrainedDiff(700, null)).toBe(true);
  });

  test("negative diffs obey the same rule", () => {
    expect(restrainedDiff(-93, 2)).toBe(true);
    expect(restrainedDiff(-8.8, 30)).toBe(false);
  });
});

describe("diffSampleDenominator (the sample a diff's basis rests on)", () => {
  const counts = {
    totalCalls: 40,
    callsOverThreshold: 12,
    bookingsFromOverThreshold: 5,
    totalBookings: 4,
    assignedLeads: 2,
  };
  const row = (metric: string, teamAvg: number | null, unit: "pct" | "pp" | "seconds" = "pct") => ({
    metric,
    teamAvg,
    diff: null,
    unit,
  });

  test("§11 pin: Rep 4 bookings vs team avg 0.5 → +700% rests on a 0.5 basis → restrained", () => {
    const d = diffSampleDenominator(row("Total Bookings", 0.5), counts);
    expect(d).toBe(0.5);
    expect(restrainedDiff(700, d)).toBe(true);
  });

  test("healthy count basis → not restrained (the smaller side governs)", () => {
    expect(diffSampleDenominator(row("Total Bookings", 30), { ...counts, totalBookings: 40 })).toBe(30);
    expect(diffSampleDenominator(row("Calls", 68), { ...counts, totalCalls: 74 })).toBe(68);
  });

  test("rate rows use the rep's own rate denominator", () => {
    expect(diffSampleDenominator(row("Conversation Conversion", 0.5, "pp"), counts)).toBe(12);
    expect(diffSampleDenominator(row("Assigned Lead Conversion", 0.4, "pp"), counts)).toBe(2);
  });

  test("duration rows use the calls behind the average", () => {
    expect(diffSampleDenominator(row("Average Call Duration", 180, "seconds"), counts)).toBe(40);
  });

  test("over-2-min and bookings-from rows use the smaller of rep count and team average", () => {
    expect(diffSampleDenominator(row("Calls Over 2 Min", 1), counts)).toBe(1);
    expect(diffSampleDenominator(row("Bookings From Calls Over 2 Minutes", 9), counts)).toBe(5);
  });

  test("unknown metric label → null → restrained (never shout on an unknown basis)", () => {
    const d = diffSampleDenominator(row("Something Else", 5), counts);
    expect(d).toBeNull();
    expect(restrainedDiff(10, d)).toBe(true);
  });

  test("shared footnote text is exact (one line under the comparison table)", () => {
    expect(SMALL_SAMPLE_FOOTNOTE).toBe("Small sample — difference shown for reference.");
  });
});

describe("compareRepRows (§7 sort: caret-only headers, nulls last preserved)", () => {
  test("bookings desc default → higher first", () => {
    const rows = [rep("a", "A", { totalBookings: 3 }), rep("b", "B", { totalBookings: 9 }), rep("c", "C", { totalBookings: 5 })];
    const sorted = [...rows].sort((x, y) => compareRepRows(x, y, "bookings", false));
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  test("missing values sort LAST in both directions, never as zero", () => {
    const rows = [
      rep("a", "A", { avgCallDurationSeconds: 120 }),
      rep("b", "B"), // null duration
      rep("c", "C", { avgCallDurationSeconds: 60 }),
    ];
    const desc = [...rows].sort((x, y) => compareRepRows(x, y, "avg-duration", false));
    const asc = [...rows].sort((x, y) => compareRepRows(x, y, "avg-duration", true));
    expect(desc.map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(asc.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  test("null conversation conversion sorts last; ties stay stable", () => {
    const rows = [
      rep("a", "A", { conversationConversion: 0.4 }),
      rep("b", "B"),
      rep("c", "C", { conversationConversion: 0.2 }),
      rep("d", "D"),
    ];
    const sorted = [...rows].sort((x, y) => compareRepRows(x, y, "conv", false));
    expect(sorted.map((r) => r.id)).toEqual(["a", "c", "b", "d"]);
  });

  test("rep name compares lexicographically, direction-aware", () => {
    const rows = [rep("a", "Wittner"), rep("b", "McKillop"), rep("c", "Ash")];
    const asc = [...rows].sort((x, y) => compareRepRows(x, y, "rep", true));
    const desc = [...rows].sort((x, y) => compareRepRows(x, y, "rep", false));
    expect(asc.map((r) => r.name)).toEqual(["Ash", "McKillop", "Wittner"]);
    expect(desc.map((r) => r.name)).toEqual(["Wittner", "McKillop", "Ash"]);
  });

  test("all-null column → no reorder crash (ties return 0)", () => {
    const rows = [rep("a", "A"), rep("b", "B")];
    expect([...rows].sort((x, y) => compareRepRows(x, y, "avg-duration", false)).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
