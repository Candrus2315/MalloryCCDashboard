/**
 * OWNER-MANDATED REGRESSION SET — rep-metric rulings (plan rev 88, 10/29).
 *
 * WRONG-3 (mandated cases): expected-by-now day-state at the 18:30 ET cutoff —
 *   just before 18:30 · exactly at 18:30 · just after 18:30 · Thursday evening
 *   · Friday evening. Before the cutoff today participates normally (remaining
 *   days include today; its full-day expectation is NOT banked); at/after the
 *   cutoff today counts as completed (full-day expectation banked, remaining
 *   days drop today). Weekend unchanged. Threads PACE_DAY_CUTOFF_ET_MINUTES —
 *   no new date rules.
 * WRONG-1: assigned-only denominators (assignedLeadsTotal + active-rep credit).
 * WRONG-4: pooled team rates (buildTeamAverages Σ/Σ; repChips pooled compare).
 * WRONG-2: resolveRepGoal divisor semantics stay count-driven (active roster is
 *   threaded by the callers; the participated fallback lives in page-data).
 */
import { describe, expect, test } from "bun:test";
import { PACE_DAY_CUTOFF_ET_MINUTES, daysLeftInWorkWeekAt, weekElapsedWorkFractionAt } from "~/server/date-logic";
import { assignedLeadsTotal, assignedLeadConversion, buildTeamAverages, type RepRangeMetrics } from "~/server/metrics/compute";
import { attentionNotes, expectedToDate, weekElapsedFraction, type RepPerformanceRow } from "~/components/today-views";
import { repChips } from "~/components/team-views";
import type { RepStripRow } from "~/server/queries";

const THU = "2026-10-29"; // Thursday, work week Mon 2026-10-26
const FRI = "2026-10-30";
const SAT = "2026-10-31";
const BEFORE = PACE_DAY_CUTOFF_ET_MINUTES - 1; // 18:29 ET — just before
const AT = PACE_DAY_CUTOFF_ET_MINUTES; // 18:30 ET — exactly at
const AFTER = PACE_DAY_CUTOFF_ET_MINUTES + 1; // 18:31 ET — just after

const row = (o: Partial<RepPerformanceRow>): RepPerformanceRow => ({
  repId: "r",
  name: "R",
  totalCalls: 0,
  callsOverThreshold: 0,
  bookingsFromOverThreshold: 0,
  totalBookings: 0,
  assignedLeads: 0,
  conversationConversion: null,
  assignedLeadConversion: null,
  avgCallDurationSeconds: null,
  goal: 0,
  actual: 0,
  goalPercent: null,
  operatingState: "active" as const,
  callStartDate: null,
  ...o,
});

const behindRow = (goal: number, actual: number) =>
  row({ repId: "p", name: "Pace Rep", goal, actual, goalPercent: actual / goal, totalCalls: 4 });

describe("WRONG-3 mandated regression: expected-by-now at the 18:30 ET cutoff", () => {
  test("weekElapsedWorkFractionAt — just before / exactly at / just after (Thursday)", () => {
    expect(weekElapsedWorkFractionAt(THU, BEFORE)).toBeCloseTo(3 / 5); // today open — completed days only
    expect(weekElapsedWorkFractionAt(THU, AT)).toBeCloseTo(4 / 5); // today completed — full day banked
    expect(weekElapsedWorkFractionAt(THU, AFTER)).toBeCloseTo(4 / 5);
  });
  test("weekElapsedWorkFractionAt — Thursday evening vs Friday evening; weekend unchanged", () => {
    expect(weekElapsedWorkFractionAt(FRI, BEFORE)).toBeCloseTo(4 / 5);
    expect(weekElapsedWorkFractionAt(FRI, AT)).toBeCloseTo(5 / 5); // Friday evening: week's work expected in full
    expect(weekElapsedWorkFractionAt(SAT, AT)).toBe(1); // weekend — 5/5 in both states
    expect(weekElapsedWorkFractionAt(SAT, BEFORE)).toBe(1);
  });
  test("weekElapsedFraction keeps the no-clock legacy semantics (pre-ruling)", () => {
    expect(weekElapsedFraction(THU)).toBeCloseTo(4 / 5); // legacy: today always counts fully
    expect(weekElapsedFraction(THU, BEFORE)).toBeCloseTo(3 / 5);
  });
  test("remaining-days copy is cutoff-aware in lockstep (daysLeftInWorkWeekAt)", () => {
    expect(daysLeftInWorkWeekAt(THU, BEFORE)).toBe(2); // Thu + Fri — today still open
    expect(daysLeftInWorkWeekAt(THU, AT)).toBe(1); // Fri only — today worked out
    expect(daysLeftInWorkWeekAt(FRI, BEFORE)).toBe(1);
    expect(daysLeftInWorkWeekAt(FRI, AT)).toBe(0); // week complete — "work week is done" copy
  });
  test("attention behind-pace note: before 18:30 → completed-days expectation + today still counted left", () => {
    const notes = attentionNotes([behindRow(22, 8)], THU, BEFORE);
    expect(notes[0]?.text).toBe(
      "Pace Rep is behind pace — 8 of 22 bookings with 2 days left (expected ≈ 13.2 by now).",
    );
    expect(expectedToDate(22, THU, BEFORE)).toBeCloseTo(13.2);
  });
  test("attention behind-pace note: exactly at 18:30 → today's full expectation banks, days-left drops", () => {
    const notes = attentionNotes([behindRow(22, 8)], THU, AT);
    expect(notes[0]?.text).toBe(
      "Pace Rep is behind pace — 8 of 22 bookings with 1 day left (expected ≈ 17.6 by now).",
    );
    // just after — identical (the step happens exactly at the cutoff)
    expect(attentionNotes([behindRow(22, 8)], THU, AFTER)[0]?.text).toBe(notes[0]?.text);
  });
  test("attention behind-pace note: Friday evening at/after cutoff → work-week-done copy", () => {
    const notes = attentionNotes([behindRow(22, 8)], FRI, AT);
    expect(notes[0]?.text).toBe("Pace Rep is behind pace — 8 of 22 bookings, and the work week is done. Pace resumes Monday.");
  });
});

describe("WRONG-1: assigned-only denominators (owner ruling)", () => {
  const lead = (id: string, workDate: string, assigned: string | null, sheet = "family") => ({
    id,
    source_date: workDate,
    work_date: workDate,
    lead_type: "Family",
    source_sheet: sheet,
    assigned_rep_id: assigned,
  });
  test("assignedLeadsTotal: assigned-only, form sheets excluded, active-rep credit", () => {
    const leads = [
      lead("1", THU, "a"),
      lead("2", THU, "a"),
      lead("3", THU, "b"),
      lead("4", THU, null), // unassigned — never in the denominator
      lead("5", THU, "a", "google_ads_leads"), // form source — team total, never a rep metric
      lead("6", "2026-10-28", "a"), // other work date — out of period
    ];
    expect(assignedLeadsTotal(leads, THU, THU)).toBe(3); // no roster → legacy fallback (all assigned owners)
    expect(assignedLeadsTotal(leads, THU, THU, new Set(["a", "b"]))).toBe(3);
    expect(assignedLeadsTotal(leads, THU, THU, new Set(["a"]))).toBe(2); // departed b's rows stay out of team rollups
    expect(assignedLeadConversion(2, 3)).toBeCloseTo(2 / 3);
    expect(assignedLeadConversion(2, 0)).toBeNull(); // honest "—", never a fake rate
  });
});

describe("WRONG-4: pooled team rates (owner ruling)", () => {
  const metric = (over: Partial<RepRangeMetrics>): RepRangeMetrics => ({
    repId: "x",
    totalCalls: 0,
    callsOverThreshold: 0,
    bookingsFromOverThreshold: 0,
    totalBookings: 0,
    assignedLeads: 0,
    conversationConversion: null,
    assignedLeadConversion: null,
    avgCallDurationSeconds: null,
    ...over,
  });
  test("buildTeamAverages pools both conversion rates; counts stay means; zero denominators stay null", () => {
    const t = buildTeamAverages({
      others: [
        metric({ repId: "a", totalCalls: 10, callsOverThreshold: 4, bookingsFromOverThreshold: 1, totalBookings: 1, assignedLeads: 20 }),
        metric({ repId: "b", totalCalls: 2, callsOverThreshold: 6, bookingsFromOverThreshold: 3, totalBookings: 3, assignedLeads: 10 }),
      ],
    });
    // conversation pooled = (1+3)/(4+6) = 0.4 (mean of rep rates would be 0.35)
    expect(t.conversationConversion).toBeCloseTo(0.4);
    // assigned pooled = (1+3)/(20+10) = 0.1333…
    expect(t.assignedLeadConversion).toBeCloseTo(4 / 30);
    expect(t.totalCalls).toBe(6); // count mean unchanged
    const zeroDen = buildTeamAverages({ others: [metric({ repId: "a" })] });
    expect(zeroDen.conversationConversion).toBeNull();
    expect(zeroDen.assignedLeadConversion).toBeNull();
  });
  test("repChips Strong-conversion compares against the POOLED team rate", () => {
    const strip = (o: Partial<RepStripRow>): RepStripRow => ({
      id: "x",
      name: "X",
      totalBookings: 0,
      callsOverThreshold: 0,
      conversationConversion: null,
      totalCalls: 0,
      avgCallDurationSeconds: null,
      goal: null,
      operatingState: "active" as const,
      historical: false,
      callStartDate: null,
      ...o,
    });
    // Pooled team rate = (1+5+5+9)/(5+100+100+10) = 20/215 ≈ 0.093 — the two
    // low-rate reps carry the big denominators. Mean of rep rates = 0.3. The
    // rep at 0.2 exceeds the POOLED rate (chip) but not the MEAN (would be
    // suppressed) — exactly the divergence ruling 4 resolves for the team.
    const rep = strip({ id: "rep", name: "Rep", totalBookings: 3, callsOverThreshold: 5, conversationConversion: 0.2 });
    const others = [
      strip({ id: "o1", name: "O1", callsOverThreshold: 100, conversationConversion: 0.05 }),
      strip({ id: "o2", name: "O2", callsOverThreshold: 100, conversationConversion: 0.05 }),
      strip({ id: "o3", name: "O3", totalBookings: 5, callsOverThreshold: 10, conversationConversion: 0.9 }),
    ];
    const chips = repChips([rep, ...others]);
    expect(chips.get("rep")?.label).toBe("Strong conversion");
  });
});
