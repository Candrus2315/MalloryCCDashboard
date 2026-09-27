/**
 * TODAY GOAL RESOLUTION (owner binding directive 2026-09-27) — Today's Rep
 * Performance resolves every rep's weekly goal through the SAME resolveRepGoal
 * the Reps page uses (rep goal when set >0, else the week's team goal shared
 * evenly across the active roster, default 79 when no team-goal row). No new
 * goal table/field/default; the ONE helper is the source of truth, so Today
 * and Reps can never disagree for the same rep+week.
 *
 * MemoryStore injected via the PageDeps seam — never getStore() (could reach
 * live Postgres), never createServerFn (needs the runtime). Same playbook as
 * week-cadence.test.ts. GOTCHA (pinned by usage): upsertUsers ignores supplied
 * ids (generates u_N) — goals are attached via the ids getAllUsers() returns.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { repsPageData, todayPageData } from "../page-data";
import { buildRepPerformanceRows, resolveRepGoal } from "../metrics/compute";

// September 2026: Fri 9/25 is TODAY (EDT). Current week Mon 9/21..Sun 9/27.
const FRI = "2026-09-25";
const CUR_MON = "2026-09-21";

async function seedStore(opts: {
  repGoals: { rep: "A" | "B"; goal: number }[];
  teamGoal: number | null;
}) {
  const store = new MemoryStore();
  await store.upsertUsers([
    { id: "u-a", provider: "highlevel", external_id: "hl-a", name: "Rep A", email: null, is_active: true, call_start_date: null },
    { id: "u-b", provider: "highlevel", external_id: "hl-b", name: "Rep B", email: null, is_active: true, call_start_date: null },
  ]);
  if (opts.teamGoal != null) {
    await store.upsertTeamGoal({ week_start: CUR_MON, booking_goal: opts.teamGoal, lead_budget: 700 });
  }
  const all = await store.getAllUsers();
  const idOf = (name: string) => all.find((u) => u.name === name)!.id;
  await store.upsertRepGoals(
    opts.repGoals.map((g) => ({ rep_id: idOf(`Rep ${g.rep}`), week_start: CUR_MON, goal: g.goal })),
  );
  return { store, idA: idOf("Rep A"), idB: idOf("Rep B") };
}

describe("Today goal resolution = Reps goal resolution (owner directive)", () => {
  test("(a) rep WITHOUT an explicit goal + team goal set → team-share, not 'No goal set'", async () => {
    const { store } = await seedStore({ repGoals: [{ rep: "A", goal: 12 }], teamGoal: 80 });
    const p = await todayPageData({ store, today: FRI });
    const byRep = new Map(p.metrics.repRows.map((r) => [r.name, r]));
    // Rep A: explicit rep goal wins, verbatim.
    expect(byRep.get("Rep A")!.goal).toBe(12);
    expect(byRep.get("Rep A")!.goalBasis).toBe("rep-goal");
    expect(byRep.get("Rep A")!.goalNote).toBe(`rep goal · week of ${CUR_MON}`);
    // Rep B: NO rep_goals row → the week's team goal ÷ repCount (2 reps).
    expect(byRep.get("Rep B")!.goal).toBe(40);
    expect(byRep.get("Rep B")!.goalBasis).toBe("team-share");
    expect(byRep.get("Rep B")!.goalNote).toBe("team goal share — weekly team goal ÷ 2 reps");
  });

  test("(b) explicit rep goal passes through EXACTLY (no rounding, no override)", async () => {
    const { store } = await seedStore({ repGoals: [{ rep: "B", goal: 7 }], teamGoal: 80 });
    const p = await todayPageData({ store, today: FRI });
    const rowB = p.metrics.repRows.find((r) => r.name === "Rep B")!;
    expect(rowB.goal).toBe(7);
    expect(rowB.goalPercent).not.toBeNull();
  });

  test("(c) team-goal row absent → resolveRepGoal's 79 default shared evenly", async () => {
    const { store } = await seedStore({ repGoals: [], teamGoal: null });
    const p = await todayPageData({ store, today: FRI });
    for (const row of p.metrics.repRows) {
      expect(row.goal).toBe(79 / 2);
      expect(row.goalBasis).toBe("team-share");
    }
  });

  test("(d) Today and Reps resolve the IDENTICAL goal for the same rep+week", async () => {
    const { store, idA, idB } = await seedStore({ repGoals: [{ rep: "A", goal: 12 }], teamGoal: 80 });
    const today = await todayPageData({ store, today: FRI });
    const todayByRep = new Map(today.metrics.repRows.map((r) => [r.name, r]));
    for (const [name, id] of [["Rep A", idA], ["Rep B", idB]] as const) {
      const reps = await repsPageData({ rep: id }, { store, today: FRI });
      // SAME value, SAME basis, SAME note — the owner binding directive.
      expect(reps.detail?.goal.value).toBe(todayByRep.get(name)!.goal);
      expect(reps.detail?.goal.basis).toBe(todayByRep.get(name)!.goalBasis);
      expect(reps.detail?.goal.note).toBe(todayByRep.get(name)!.goalNote);
    }
  });

  test("(d2) mirrored inputs → identical resolveRepGoal output on both paths", () => {
    // The exact mirror both paths construct: weeks=[ws], repGoalsByWeek from
    // getRepGoals(ws), teamGoalByWeek from getTeamGoal(ws), repCount=reps.length.
    const repGoalsByWeek = new Map([[CUR_MON, 12]]);
    const teamGoalByWeek = new Map([[CUR_MON, 80]]);
    const a = resolveRepGoal({ weeks: [CUR_MON], repGoalsByWeek, teamGoalByWeek, repCount: 2 });
    const b = resolveRepGoal({ weeks: [CUR_MON], repGoalsByWeek, teamGoalByWeek, repCount: 2 });
    expect(a).toEqual(b);
    expect(a!.value).toBe(12);
    const share = resolveRepGoal({ weeks: [CUR_MON], repGoalsByWeek: new Map(), teamGoalByWeek, repCount: 2 });
    expect(share!.value).toBe(40);
    expect(share!.basis).toBe("team-share");
  });
});

describe("goal basis/note passthrough (presentation only)", () => {
  test("buildRepPerformanceRows carries basis/note verbatim; raw rows → null", () => {
    const base = {
      reps: [{ id: "u-a", name: "Rep A", call_start_date: null }],
      calls: [],
      appts: [],
      attributions: [],
      allCallsForWeek: [],
      leads: [],
      weekStart: CUR_MON,
      weekEnd: "2026-09-27",
      thresholdSeconds: 120,
    };
    const resolved = buildRepPerformanceRows({
      ...base,
      repGoals: [{ rep_id: "u-a", week_start: CUR_MON, goal: 40, goal_basis: "team-share", goal_note: "team goal share — weekly team goal ÷ 2 reps" }],
    });
    expect(resolved[0].goal).toBe(40);
    expect(resolved[0].goalBasis).toBe("team-share");
    expect(resolved[0].goalNote).toBe("team goal share — weekly team goal ÷ 2 reps");
    const raw = buildRepPerformanceRows({ ...base, repGoals: [] });
    expect(raw[0].goal).toBe(0);
    expect(raw[0].goalBasis).toBeNull();
    expect(raw[0].goalNote).toBeNull();
  });
});
