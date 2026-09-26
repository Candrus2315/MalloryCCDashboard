/**
 * Guard for the Reps-page presentation rules (design/reps-redesign-spec.md):
 * goal-progress plain language (never a bare negative), the coaching rules'
 * first-match order, TEAMDENOM gate, and the zero-activity honest note.
 * Presentation-side only: everything here composes existing metric outputs.
 * Lives outside src/server so `bun test src/server` counts stay stable.
 */
import { describe, expect, test } from "bun:test";
import { coachingObservations, goalProgress } from "~/components/reps-views";
import type { TeamComparison } from "~/server/metrics/compute";

const cmp = (metric: string, rep: number | null, teamAvg: number | null, unit: TeamComparison["unit"]): TeamComparison => ({
  metric,
  rep,
  teamAvg,
  diff: rep != null && teamAvg != null ? rep - teamAvg : null,
  unit,
});

const baseInput = {
  repName: "Rep One",
  totalCalls: 6, // below the team mean (8) — the strong-volume phrasing tests override this
  callsOverThreshold: 4,
  totalBookings: 3,
  assignedLeads: 20,
  comparisons: [
    cmp("Conversation Conversion", 0.5, 0.6, "pp"),
    cmp("Assigned Lead Conversion", 0.15, 0.12, "pp"),
  ],
  teamAverages: { totalCalls: 8, callsOverThreshold: 5, conversationConversion: 0.6, assignedLeadConversion: 0.12 },
  conversationOthers: 4,
  goal: { wtd: 8, goalValue: 12, anchorDay: "2026-09-25" }, // Friday → 5/5 elapsed... see per-test overrides
  today: "2026-09-25",
};

describe("goalProgress (spec: plain-language difference from goal)", () => {
  test("behind goal → remaining bookings, neutral tone — never '−11'", () => {
    const g = goalProgress({ wtd: 8, goalValue: 12 });
    expect(g.remaining).toBe(4);
    expect(g.achievement).toBeCloseTo(8 / 12);
    expect(g.remainingHero).toBe("4");
    expect(g.remainingTone).toBe("neutral");
    expect(g.remainingSub).toBe("bookings remaining");
  });
  test("above goal → positive tone, 'above weekly goal'", () => {
    const g = goalProgress({ wtd: 14, goalValue: 12 });
    expect(g.remainingHero).toBe("2");
    expect(g.remainingTone).toBe("positive");
    expect(g.remainingSub).toBe("above weekly goal");
  });
  test("exactly at goal → 'weekly goal reached'", () => {
    const g = goalProgress({ wtd: 12, goalValue: 12 });
    expect(g.remainingHero).toBe("0");
    expect(g.remainingSub).toBe("weekly goal reached");
  });
  test("no resolvable goal → em dash, never a fake 0%", () => {
    const g = goalProgress({ wtd: 3, goalValue: 0 });
    expect(g.goal).toBeNull();
    expect(g.achievement).toBeNull();
    expect(g.remainingHero).toBe("—");
  });
});

describe("coachingObservations (rule-based, max 3, NO fake AI)", () => {
  test("zero activity → one honest sync note, no performance verdicts", () => {
    const out = coachingObservations({ ...baseInput, totalCalls: 0, totalBookings: 0 });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("risk");
    expect(out[0].text).toContain("no calls or bookings recorded");
  });
  test("conversion below team (denominators ≥ 3) → percentage-point phrasing", () => {
    const out = coachingObservations(baseInput);
    expect(out.some((o) => o.text.includes("percentage points below team average"))).toBe(true);
  });
  test("TEAMDENOM gate: thin rep or team denominator → no conversion verdict", () => {
    const thinRep = coachingObservations({ ...baseInput, callsOverThreshold: 2 });
    const thinTeam = coachingObservations({ ...baseInput, conversationOthers: 2 });
    for (const out of [thinRep, thinTeam]) {
      expect(out.some((o) => o.text.includes("Conversation conversion") && o.text.includes("below"))).toBe(false);
    }
  });
  test("strong volume + below-average conversion → the spec's combined phrasing", () => {
    const out = coachingObservations({ ...baseInput, totalCalls: 20 });
    expect(out.some((o) => o.text.startsWith("Call volume is above team average but conversation conversion is below"))).toBe(true);
  });
  test("weekly pace: behind on a workday → 'behind weekly pace'; weekend → 'finished the week'", () => {
    const friday = coachingObservations({ ...baseInput, goal: { wtd: 8, goalValue: 12, anchorDay: "2026-09-25" } });
    expect(friday.some((o) => o.text.includes("behind weekly pace"))).toBe(true);
    // a PAST weekend anchor (today Monday, viewed week ended Sunday) → work-week-complete phrasing
    const sunday = coachingObservations({
      ...baseInput,
      today: "2026-09-28",
      goal: { wtd: 8, goalValue: 12, anchorDay: "2026-09-27" },
    });
    expect(sunday.some((o) => o.text.includes("finished the week"))).toBe(true);
  });
  test("on/above pace and above-team conversions → positives, capped at 3", () => {
    const out = coachingObservations({
      ...baseInput,
      comparisons: [
        cmp("Conversation Conversion", 0.7, 0.6, "pp"),
        cmp("Assigned Lead Conversion", 0.2, 0.12, "pp"),
      ],
      goal: { wtd: 12, goalValue: 12, anchorDay: "2026-09-25" },
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out.every((o) => o.severity === "positive")).toBe(true);
    expect(out.some((o) => o.text.includes("Weekly goal already reached"))).toBe(true);
  });
  test("clean rep with no flags → empty (panel shows the all-clear line)", () => {
    const out = coachingObservations({
      ...baseInput,
      comparisons: [cmp("Conversation Conversion", null, null, "pp"), cmp("Assigned Lead Conversion", null, null, "pp")],
      teamAverages: { totalCalls: 10, callsOverThreshold: 8, conversationConversion: null, assignedLeadConversion: null },
      goal: null, // no week-scoped goal in play — nothing can fire
    });
    expect(out).toEqual([]);
  });
});
