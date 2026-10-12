/**
 * COMMISSION CYCLE CREATE — pin tests (money path).
 *
 * Pins the metadata-only contract of createAndAssignCommissionCycle:
 *  - creating a cycle assigns ONLY stored in-window FINAL rows (cycle_id +
 *    assignment via the narrow §S membership method — money columns untouched);
 *  - a rerun is a no-op (already-assigned rows skipped, existing cycle row
 *    never re-upserted);
 *  - September-window rows never move (byte-identical snapshots);
 *  - out-of-window and non-final (superseded) rows are untouched;
 *  - overlap with an existing cycle (September's) refuses BEFORE any write;
 *  - an in-window row bound to another cycle refuses the WHOLE run (no partial
 *    assignment — §S: a week belongs to exactly one cycle).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { CommissionCycleRow, CommissionWeeklyRow } from "../store/types";
import { addDays } from "../date-logic";
import {
  createAndAssignCommissionCycle,
  firstMondayAfter,
  labelFromSpan,
} from "../commission/cycle-create";

const SEP_CYCLE_ID = "cycle-2026-08-31-2026-09-27";
const OCT_START = "2026-09-28";
const OCT_END = "2026-10-25";
const OCT_CYCLE_ID = "cycle-2026-09-28-2026-10-25";
const SEP_WEEKS = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"];
const OCT_WEEKS = ["2026-09-28", "2026-10-05"]; // the two stored October weeks (Oct 12/19 come later)
const REPS = [
  { id: "u-allison", name: "Allison Wittner", bookings: 32, total: 640 },
  { id: "u-carmine", name: "Carmine Morgano", bookings: 8, total: 40 },
  { id: "u-jen", name: "Jennifer Stitt", bookings: 4, total: 20 },
  { id: "u-laura", name: "Laura Rivera", bookings: 2, total: 30 },
];
/** The REAL stored October weeks (DB-verified 10/12): week 1 = 46 wins/$730.00,
 *  week 2 = 63 wins/$980.00 — the sums the assignment must not disturb. */
const OCT_STORED: Record<string, Array<{ id: string; name: string; bookings: number; total: number }>> = {
  "2026-09-28": REPS,
  "2026-10-05": [
    { id: "u-allison", name: "Allison Wittner", bookings: 43, total: 830 },
    { id: "u-carmine", name: "Carmine Morgano", bookings: 11, total: 55 },
    { id: "u-jen", name: "Jennifer Stitt", bookings: 4, total: 20 },
    { id: "u-laura", name: "Laura Rivera", bookings: 5, total: 75 },
  ],
};

function record(userId: string, name: string, weekStart: string, over: Partial<CommissionWeeklyRow> = {}): CommissionWeeklyRow {
  return {
    id: "",
    user_id: userId,
    rep_name: name,
    week_start: weekStart,
    week_end: addDays(weekStart, 6),
    employment_type: "full_time",
    tier: 5,
    tier_effective_date_used: "2026-08-31",
    qualifying_bookings: 10,
    base_commission: 200,
    additional_commission: 0,
    pool_bonus: 0,
    hole_bonus: 0,
    manual_adjustment: 0,
    total: 200,
    calc_date: new Date().toISOString(),
    calc_version: 2,
    status: "final",
    cycle_id: null,
    assignment: "unassigned",
    counted_bookings: [],
    hole_audit: [],
    hole_bonus_capped: false,
    ...over,
  };
}

function septemberCycleRow(): CommissionCycleRow {
  const nowIso = new Date().toISOString();
  return {
    id: SEP_CYCLE_ID,
    label: "Aug 31 – Sep 27, 2026",
    start_date: "2026-08-31",
    end_date: "2026-09-27",
    submission_date: "2026-10-05",
    payroll_date: "2026-10-09",
    status: "submitted", // September's row after its 10/9 payday (born in_progress)
    submitted_date: "2026-10-07",
    submitted_by: "manager",
    final_snapshot: { finalMonthlyBookingCount: 228, finalBonusAmount: 3680 },
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/** Seed the REAL stored shape: September cycle (submitted, 16 rows previously_submitted)
 *  + 8 stored October final rows (unassigned) + an out-of-window final row
 *  + an in-window superseded row (never assigned by anything). */
async function seed(store: MemoryStore): Promise<void> {
  await store.upsertCommissionCycle(septemberCycleRow());
  for (const ws of SEP_WEEKS) {
    for (const rep of REPS) {
      await store.upsertCommissionWeeklyRecord(
        record(rep.id, rep.name, ws, { cycle_id: SEP_CYCLE_ID, assignment: "previously_submitted" }),
      );
    }
  }
  for (const ws of OCT_WEEKS) {
    for (const rep of OCT_STORED[ws]) {
      await store.upsertCommissionWeeklyRecord(
        record(rep.id, rep.name, ws, { qualifying_bookings: rep.bookings, total: rep.total, base_commission: rep.total }),
      );
    }
  }
  // Out-of-window (after the cycle's end): must never move.
  await store.upsertCommissionWeeklyRecord(record("u-allison", "Allison Wittner", "2026-10-26"));
  // In-window but non-final (superseded): must never move, only be reported.
  await store.upsertCommissionWeeklyRecord(record("u-dan", "Dan McKillop", "2026-10-05", { status: "superseded" }));
}

const snapRows = (rows: CommissionWeeklyRow[]) => rows.map((r) => structuredClone(r));
const sortKey = (r: CommissionWeeklyRow) => `${r.week_start}:${r.user_id}`;

describe("createAndAssignCommissionCycle — metadata only (RULING 4)", () => {
  test("September label convention is byte-pinned (en dash, abbrev months) + derived submission/payroll dates", () => {
    expect(labelFromSpan("2026-08-31", "2026-09-27")).toBe("Aug 31 – Sep 27, 2026");
    expect(labelFromSpan(OCT_START, OCT_END)).toBe("Sep 28 – Oct 25, 2026");
    // September's stored convention: submission = first Monday of the following month, payroll = that Friday.
    expect(firstMondayAfter("2026-09-27")).toBe("2026-10-05");
    expect(firstMondayAfter(OCT_END)).toBe("2026-11-02");
  });

  test("creates the October cycle and assigns ONLY the 8 in-window final rows — September byte-identical", async () => {
    const store = new MemoryStore();
    await seed(store);
    const before = snapRows(await store.getCommissionWeeklyRecords());
    const beforeCycles = await store.getCommissionCycles();

    const res = await createAndAssignCommissionCycle(store, { start: OCT_START, end: OCT_END });

    // The cycle row — exact September-convention shape, born in_progress.
    expect(res.cycleCreated).toBe(true);
    expect(res.cycle).toEqual({
      id: OCT_CYCLE_ID,
      label: "Sep 28 – Oct 25, 2026",
      start_date: OCT_START,
      end_date: OCT_END,
      submission_date: "2026-11-02",
      payroll_date: "2026-11-06",
      status: "in_progress",
      submitted_date: null,
      submitted_by: null,
      final_snapshot: null,
      created_at: res.cycle.created_at,
      updated_at: res.cycle.updated_at,
    });
    expect((await store.getCommissionCycles()).length).toBe(2);

    // Exactly the 8 stored October final rows assigned — nothing else.
    expect(res.assigned.length).toBe(8);
    expect(res.assigned.every((r) => r.weekStart >= OCT_START && r.weekStart <= OCT_END)).toBe(true);
    expect(res.skippedNotFinal.map((r) => `${r.weekStart}:${r.repName}`)).toEqual(["2026-10-05:Dan McKillop"]);

    const after = snapRows(await store.getCommissionWeeklyRecords());
    const byKeyBefore = new Map(before.map((r) => [sortKey(r), r]));
    const byKeyAfter = new Map(after.map((r) => [sortKey(r), r]));
    expect(byKeyAfter.size).toBe(byKeyBefore.size);

    for (const [key, afterRow] of byKeyAfter) {
      const beforeRow = byKeyBefore.get(key);
      expect(beforeRow).toBeDefined();
      const inWindow = afterRow.week_start >= OCT_START && afterRow.week_start <= OCT_END;
      if (inWindow && afterRow.status === "final") {
        // Membership columns changed, EVERY stored value identical.
        expect(afterRow.cycle_id).toBe(OCT_CYCLE_ID);
        expect(afterRow.assignment).toBe("current_cycle");
        const { cycle_id: _c, assignment: _a, ...moneyBefore } = beforeRow!;
        const { cycle_id: _c2, assignment: _a2, ...moneyAfter } = afterRow;
        expect(moneyAfter).toEqual(moneyBefore);
      } else {
        // September (16 rows), out-of-window, superseded — byte-identical.
        expect(afterRow).toEqual(beforeRow!);
      }
    }
    const octoberAssigned = after.filter((r) => r.cycle_id === OCT_CYCLE_ID);
    expect(octoberAssigned.length).toBe(8);
    expect(octoberAssigned.every((r) => r.assignment === "current_cycle")).toBe(true);
    const sumBookings = octoberAssigned.reduce((s, r) => s + r.qualifying_bookings, 0);
    const sumTotal = octoberAssigned.reduce((s, r) => s + r.total, 0);
    expect(sumBookings).toBe(109); // the REAL stored sums: 46 (Sep 28 wk) + 63 (Oct 5 wk)
    expect(sumTotal).toBe(1710); // $730.00 + $980.00 — identical before and after the assignment
  });

  test("rerun is a no-op — picks up nothing new, existing cycle row never re-upserted", async () => {
    const store = new MemoryStore();
    await seed(store);
    await createAndAssignCommissionCycle(store, { start: OCT_START, end: OCT_END });
    const before = snapRows(await store.getCommissionWeeklyRecords());
    const beforeCycles = await store.getCommissionCycles();

    const res = await createAndAssignCommissionCycle(store, { start: OCT_START, end: OCT_END });

    expect(res.cycleCreated).toBe(false);
    expect(res.assigned.length).toBe(0);
    expect(res.alreadyAssigned.length).toBe(8);
    expect(res.skippedNotFinal.length).toBe(1);
    expect(snapRows(await store.getCommissionWeeklyRecords())).toEqual(before);
    expect(await store.getCommissionCycles()).toEqual(beforeCycles); // status/label/dates untouched
  });

  test("refuses a window overlapping September's cycle BEFORE any write", async () => {
    const store = new MemoryStore();
    await seed(store);
    const before = snapRows(await store.getCommissionWeeklyRecords());
    const beforeCycles = await store.getCommissionCycles();
    await expect(
      createAndAssignCommissionCycle(store, { start: "2026-09-21", end: "2026-10-18" }),
    ).rejects.toThrow(/overlaps stored cycle cycle-2026-08-31-2026-09-27/);
    expect(snapRows(await store.getCommissionWeeklyRecords())).toEqual(before);
    expect(await store.getCommissionCycles()).toEqual(beforeCycles);
  });

  test("an in-window row bound to another cycle refuses the WHOLE run — no partial assignment", async () => {
    const store = new MemoryStore();
    await seed(store);
    await store.setCommissionRecordAssignment("u-carmine", "2026-10-05", {
      cycleId: "cycle-other",
      assignment: "current_cycle",
    });
    const before = snapRows(await store.getCommissionWeeklyRecords());
    const beforeCycles = await store.getCommissionCycles();
    await expect(
      createAndAssignCommissionCycle(store, { start: OCT_START, end: OCT_END }),
    ).rejects.toThrow(/assignment=current_cycle \(cycle cycle-other\)/);
    expect(snapRows(await store.getCommissionWeeklyRecords())).toEqual(before);
    expect(await store.getCommissionCycles()).toEqual(beforeCycles); // no cycle row was created either
  });

  test("non-Monday start / non-Sunday end refused", async () => {
    const store = new MemoryStore();
    await seed(store);
    await expect(createAndAssignCommissionCycle(store, { start: "2026-09-29", end: OCT_END })).rejects.toThrow(/Monday/);
    await expect(createAndAssignCommissionCycle(store, { start: OCT_START, end: "2026-10-24" })).rejects.toThrow(/Sunday/);
  });
});
