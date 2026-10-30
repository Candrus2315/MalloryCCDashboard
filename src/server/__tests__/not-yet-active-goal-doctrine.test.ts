/**
 * NOT-YET-ACTIVE GOAL DOCTRINE (owner directive 10/30) — a rep whose
 * call_start_date is after the report date (ET) carries ZERO goal share and
 * ZERO expected-by-now, and is EXCLUDED from the team-share fallback divisor
 * on every surface those figures feed (Today rep rows, Team strip, Reps page,
 * PIP evidence). Stored rep_goals rows are never deleted or altered — they
 * render again untouched on/after the start date (repOperatingState boundary:
 * the start date itself counts as ACTIVE — no manual flip, no caching).
 *
 * MemoryStore injected via the PageDeps seam — never getStore() (could reach
 * live Postgres). Same playbook as today-goal-resolution.test.ts. GOTCHA
 * (pinned there): upsertUsers ignores supplied ids (generates u_N) — goals
 * attach via the ids getAllUsers() returns.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { repsPageData, teamPageData, todayPageData } from "../page-data";
import { resolveRepGoal } from "../metrics/compute";
import { teamStripGoalValue } from "../../components/team-views";
import { attentionNotes } from "../../components/today-views";

// Week Mon 2026-11-30 .. Sun 2026-12-06. TODAY = Wed 12/02 (inside the week).
const MON = "2026-11-30";
const TODAY = "2026-12-02";
const START = "2026-12-05"; // AFTER the report date → not yet active

const ACTIVE = [
  { name: "Rep A", goal: null },
  { name: "Rep B", goal: 22 }, // owner-set per-rep goal (must be unaffected)
  { name: "Rep C", goal: null },
];

async function seedStore(pendingStart: string | null) {
  const store = new MemoryStore();
  await store.upsertUsers([
    ...ACTIVE.map((r, i) => ({
      id: `u-${i}`,
      provider: "highlevel" as const,
      external_id: `hl-${i}`,
      name: r.name,
      email: null,
      is_active: true,
      call_start_date: null,
    })),
    {
      id: "u-d",
      provider: "highlevel" as const,
      external_id: "hl-d",
      name: "Rep D",
      email: null,
      is_active: true,
      call_start_date: pendingStart,
    },
  ]);
  await store.upsertTeamGoal({ week_start: MON, booking_goal: 80, lead_budget: 700 });
  const all = await store.getAllUsers();
  const idOf = (name: string) => all.find((u) => u.name === name)!.id;
  // Owner-set rows: B's 22 AND D's 22 (D's must render as 0 while not-yet-active).
  await store.upsertRepGoals(
    [
      { name: "Rep B", goal: 22 },
      { name: "Rep D", goal: 22 },
    ].map((g) => ({ rep_id: idOf(g.name), week_start: MON, goal: g.goal })),
  );
  return { store, idOf };
}

describe("not-yet-active goal doctrine (owner directive 10/30)", () => {
  test("resolveRepGoal: repActive=false → zero value / not-active basis, owner-set row suppressed", () => {
    const resolved = resolveRepGoal({
      weeks: [MON],
      repGoalsByWeek: new Map([[MON, 22]]),
      teamGoalByWeek: new Map([[MON, 80]]),
      repCount: 3,
      repActive: false,
    });
    expect(resolved).toEqual({
      value: 0,
      basis: "not-active",
      note: "not yet active — goal counts from the call start date",
    });
    // Legacy callers (no repActive) are unchanged: owner-set goal wins verbatim.
    const legacy = resolveRepGoal({
      weeks: [MON],
      repGoalsByWeek: new Map([[MON, 22]]),
      teamGoalByWeek: new Map([[MON, 80]]),
      repCount: 3,
    });
    expect(legacy).toEqual({ value: 22, basis: "rep-goal", note: `rep goal · week of ${MON}` });
  });

  test("resolveRepGoal: repActive=false wins even at repCount 0 (pending rep before the divisor guard)", () => {
    const resolved = resolveRepGoal({
      weeks: [MON],
      repGoalsByWeek: new Map(),
      teamGoalByWeek: new Map(),
      repCount: 0,
      repActive: false,
    });
    expect(resolved?.value).toBe(0);
    expect(resolved?.basis).toBe("not-active");
    // Unchanged: an ACTIVE rep with no eligible divisor still resolves null.
    expect(
      resolveRepGoal({ weeks: [MON], repGoalsByWeek: new Map(), teamGoalByWeek: new Map(), repCount: 0 }),
    ).toBeNull();
  });

  test("Today: pending rep carries ZERO goal; active reps' team-share NOT diluted (divisor 3)", async () => {
    const { store } = await seedStore(START);
    const p = await todayPageData({ store, today: TODAY });
    const byRep = new Map(p.metrics.repRows.map((r) => [r.name, r]));
    // Pending rep: zero goal, suppressed basis/note — the owner-set 22 is NOT shown.
    const d = byRep.get("Rep D")!;
    expect(d.goal).toBe(0);
    expect(d.goalBasis).toBe("not-active");
    expect(d.goalNote).toContain("not yet active");
    expect(d.goalPercent).toBeNull(); // goalAchievement(actual, 0) → honest null
    expect(d.operatingState).toBe("not-yet-active");
    // Active reps: share of 80 across THREE goal-eligible reps (D excluded).
    const a = byRep.get("Rep A")!;
    expect(a.goal).toBeCloseTo(80 / 3, 10);
    expect(a.goalBasis).toBe("team-share");
    expect(a.goalNote).toBe("team goal share — weekly team goal ÷ 3 reps");
    expect(byRep.get("Rep C")!.goal).toBeCloseTo(80 / 3, 10);
    // Owner-set goal on an ACTIVE rep: byte-identical behavior.
    expect(byRep.get("Rep B")!.goal).toBe(22);
    expect(byRep.get("Rep B")!.goalBasis).toBe("rep-goal");
  });

  test("Today: pending rep gets NO attention note (zero expected-by-now, zero coaching)", async () => {
    const { store } = await seedStore(START);
    const p = await todayPageData({ store, today: TODAY });
    const notes = attentionNotes(p.metrics.repRows, TODAY);
    expect(notes.some((n) => n.rep === "Rep D")).toBe(false);
  });

  test("boundary: ON the start date the rep is active — divisor 4, owner-set goal restored", async () => {
    const { store } = await seedStore(TODAY); // call_start_date == report date → ACTIVE
    const p = await todayPageData({ store, today: TODAY });
    const byRep = new Map(p.metrics.repRows.map((r) => [r.name, r]));
    const d = byRep.get("Rep D")!;
    expect(d.goal).toBe(22); // the stored owner-set row renders again, unaltered
    expect(d.goalBasis).toBe("rep-goal");
    expect(d.operatingState).toBe("active");
    expect(byRep.get("Rep A")!.goal).toBeCloseTo(80 / 4, 10);
    expect(byRep.get("Rep A")!.goalNote).toBe("team goal share — weekly team goal ÷ 4 reps");
  });

  test("Team strip: pending rep payload goal suppressed; strip cell value is null (renders —)", async () => {
    const { store } = await seedStore(START);
    const p = await teamPageData({}, { store, today: TODAY });
    const d = p.repRows.find((r) => r.name === "Rep D")!;
    expect(d.operatingState).toBe("not-yet-active");
    expect(d.goal?.value).toBe(0);
    expect(d.goal?.basis).toBe("not-active");
    expect(teamStripGoalValue(d)).toBeNull(); // the strip's honest "—"
    const a = p.repRows.find((r) => r.name === "Rep A")!;
    expect(teamStripGoalValue(a)).toBeCloseTo(80 / 3, 10);
    // Expanded "Goal basis" line still shows the honest suppression note.
    expect(d.goal?.note).toContain("not yet active");
  });

  test("Reps page: selected pending rep resolves zero/not-active; active rep keeps the undiluted share", async () => {
    const { store, idOf } = await seedStore(START);
    const dPending = await repsPageData({ rep: idOf("Rep D") }, { store, today: TODAY });
    expect(dPending.detail?.goal.value).toBe(0);
    expect(dPending.detail?.goal.basis).toBe("not-active");
    const aActive = await repsPageData({ rep: idOf("Rep A") }, { store, today: TODAY });
    expect(aActive.detail?.goal.value).toBeCloseTo(80 / 3, 10);
    expect(aActive.detail?.goal.basis).toBe("team-share");
  });
});
