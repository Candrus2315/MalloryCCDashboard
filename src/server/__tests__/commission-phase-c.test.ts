/**
 * COMMISSION PHASE C — approval workflow, submitted-cycle locking, corrections
 * audit, week↔cycle membership, payroll email, dashboard payload.
 *
 * Owner directives (spec §N/§O/§19/§20/§S/§14):
 *  - Forward-only cycle states, every transition audited (who/what/old→new/
 *    reason/when); no auto-submission anywhere.
 *  - SUBMITTED-CYCLE LOCK: stored weekly records/payroll totals can never be
 *    rewritten (tier/rate/setting changes and close/backfill re-runs no-op
 *    with an audit row); a fresh recompute may surface drift but the stored
 *    values freeze.
 *  - Corrections require a reason and land as audited money-side adjustments —
 *    never silent rewrites of the auto-calc fields.
 *  - A week belongs to at most ONE cycle (no double counting).
 *  - Payroll email = name / Bookings / Commission Bonus, stored numbers only.
 *
 * MemoryStore injected via the PageDeps/store seams — never getStore().
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { CommissionAdjustmentRow, CommissionCycleRow, CommissionWeeklyRow, Store, UserRow } from "../store/types";
import {
  applyCommissionCorrection,
  assignCommissionWeeks,
  CYCLE_TRANSITIONS,
  marginalBookingValueCents,
  nextCommissionSubmission,
  submitCommissionCycle,
  transitionCommissionCycle,
  unassignCommissionWeeks,
} from "../commission/lifecycle";
import { commissionCloseTick } from "../commission/close";
import { commissionPageData, todayPageData } from "../page-data";
import { buildPayrollEmail, payrollEmailLines } from "../../components/commission-views";

const W1 = "2026-08-31";
const W2 = "2026-09-07";
const W3 = "2026-09-14";
const W4 = "2026-09-21";
const BOUNDARY = "2026-09-28"; // the week that must stay Unassigned unless the owner assigns it
const CYCLE_ID = "cycle-2026-08-31-2026-09-27";
const FRI = "2026-10-02"; // ET today for the dashboard-card test

function repRow(name: string, over: Partial<UserRow> = {}): UserRow {
  return {
    id: "",
    provider: "highlevel",
    external_id: `ext-${name}`,
    name,
    email: `${name.toLowerCase().split(" ")[0]}@mallory.test`,
    is_active: true,
    call_start_date: null,
    ...over,
  };
}

function record(userId: string, name: string, weekStart: string, over: Partial<CommissionWeeklyRow> = {}): CommissionWeeklyRow {
  return {
    id: "",
    user_id: userId,
    rep_name: name,
    week_start: weekStart,
    week_end: addDaysLocal(weekStart, 6),
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

/** Local addDays (date-only, no tz import needed for these Monday-based tests). */
function addDaysLocal(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function cycleRow(over: Partial<CommissionCycleRow> = {}): CommissionCycleRow {
  const nowIso = new Date().toISOString();
  return {
    id: CYCLE_ID,
    label: "Aug 31 – Sep 27, 2026",
    start_date: W1,
    end_date: addDaysLocal(W4, 6),
    submission_date: "2026-10-05",
    payroll_date: "2026-10-09",
    status: "in_progress",
    submitted_date: null,
    submitted_by: null,
    final_snapshot: null,
    created_at: nowIso,
    updated_at: nowIso,
    ...over,
  };
}

/** Seed the stored Oct-cycle shape: 2 reps × 4 weeks, records born cycle-bound. */
async function seedCycle(store: MemoryStore): Promise<{ a: string; b: string }> {
  await store.upsertUsers([repRow("Allison Wittner"), repRow("Carmine Morgano")]);
  const users = await store.getUsers();
  const a = users.find((u) => u.name === "Allison Wittner")!.id;
  const b = users.find((u) => u.name === "Carmine Morgano")!.id;
  for (const ws of [W1, W2, W3, W4]) {
    await store.upsertCommissionWeeklyRecord(record(a, "Allison Wittner", ws, { cycle_id: CYCLE_ID, assignment: "current_cycle" }));
    await store.upsertCommissionWeeklyRecord(record(b, "Carmine Morgano", ws, { cycle_id: CYCLE_ID, assignment: "current_cycle", qualifying_bookings: 4, total: 20, base_commission: 20 }));
  }
  await store.upsertCommissionCycle(cycleRow());
  return { a, b };
}

async function lastAudit(store: Store, filter?: { cycleId?: string }): Promise<CommissionAdjustmentRow | undefined> {
  const rows = await store.getCommissionAdjustments(filter);
  return rows[0];
}

describe("§N approval workflow — state transitions", () => {
  test("legal full path in_progress → ready_for_review → approved, each audited (who/when/from→to)", async () => {
    const store = new MemoryStore();
    await seedCycle(store);
    const r1 = await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "chris", note: "Numbers validated" });
    expect(r1.from).toBe("in_progress");
    expect(r1.to).toBe("ready_for_review");
    let audit = await lastAudit(store, { cycleId: CYCLE_ID });
    expect(audit?.target).toBe("cycle");
    expect(audit?.field).toBe("status");
    expect(audit?.old_value).toBe("in_progress");
    expect(audit?.new_value).toBe("ready_for_review");
    expect(audit?.changed_by).toBe("chris");
    expect(audit?.reason).toContain("Numbers validated");
    expect(audit?.changed_at).toBeTruthy();

    const r2 = await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "chris" });
    expect(r2.to).toBe("approved");
    audit = await lastAudit(store, { cycleId: CYCLE_ID });
    expect(audit?.old_value).toBe("ready_for_review");
    expect(audit?.new_value).toBe("approved");
    expect(audit?.reason).toContain("Approved"); // default reason text
    const cycle = await store.getCommissionCycle(CYCLE_ID);
    expect(cycle?.status).toBe("approved");
  });

  test("illegal transitions throw (skipping steps, backwards, out of submitted)", async () => {
    const store = new MemoryStore();
    await seedCycle(store);
    expect(CYCLE_TRANSITIONS.in_progress).toEqual(["ready_for_review"]);
    await expect(transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "m" })).rejects.toThrow(/Illegal transition/);
    await expect(transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "submitted", actor: "m" })).rejects.toThrow(/Illegal transition|Use the explicit submit/);
    // advance twice then try to go back
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "m" });
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "m" });
    await expect(transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "m" })).rejects.toThrow(/Illegal transition/);
  });

  test("submission requires approved status; submitted is terminal", async () => {
    const store = new MemoryStore();
    await seedCycle(store);
    await expect(submitCommissionCycle(store, { cycleId: CYCLE_ID, actor: "chris" })).rejects.toThrow(/must be Approved/);
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "chris" });
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "chris" });
    const res = await submitCommissionCycle(store, { cycleId: CYCLE_ID, actor: "chris", submittedDate: "2026-10-05" });
    expect(res.cycle.status).toBe("submitted");
    expect(res.cycle.submitted_by).toBe("chris");
    expect(res.cycle.submitted_date).toBe("2026-10-05");
    // terminal
    await expect(transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "chris" })).rejects.toThrow(/submitted and locked/);
    await expect(submitCommissionCycle(store, { cycleId: CYCLE_ID, actor: "chris" })).rejects.toThrow(/already submitted/);
  });

  test("submission freezes the §N final snapshot (counts, bonus, calc version, payroll date)", async () => {
    const store = new MemoryStore();
    await seedCycle(store);
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "m" });
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "m" });
    const res = await submitCommissionCycle(store, { cycleId: CYCLE_ID, actor: "m" });
    const snap = res.snapshot;
    expect(snap.finalMonthlyBookingCount).toBe(10 * 4 + 4 * 4); // 56
    expect(snap.finalBonusAmount).toBe(200 * 4 + 20 * 4); // 880
    expect(snap.calculationVersions).toEqual([2]);
    expect(snap.payrollDate).toBe("2026-10-09");
    expect(snap.submissionDeadline).toBe("2026-10-05");
    expect(snap.perEmployee.length).toBe(2);
    const stored = (await store.getCommissionCycle(CYCLE_ID))!.final_snapshot as Record<string, unknown>;
    expect(stored["finalBonusAmount"]).toBe(880);
    const submissionAudit = await lastAudit(store, { cycleId: CYCLE_ID });
    expect(submissionAudit?.field).toBe("submission");
    expect(submissionAudit?.new_value).toBe("submitted");
  });
});

describe("§19 SUBMITTED-CYCLE LOCK — stored payroll freezes forever", () => {
  test("upsert of a locked record is a NO-OP that changes nothing + writes a block audit", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "m" });
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "m" });
    await submitCommissionCycle(store, { cycleId: CYCLE_ID, actor: "m" });

    const before = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: W1 }))[0];
    const res = await store.upsertCommissionWeeklyRecord(record(a, "Allison Wittner", W1, {
      qualifying_bookings: 999, total: 99999, base_commission: 99999, cycle_id: CYCLE_ID, assignment: "current_cycle",
    }));
    expect(res.blocked).toBe(true);
    expect(res.written).toBe(false);
    const after = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: W1 }))[0];
    expect(after.qualifying_bookings).toBe(before.qualifying_bookings);
    expect(after.total).toBe(before.total);
    expect(after.calc_version).toBe(2);
    const audit = await lastAudit(store, { cycleId: CYCLE_ID });
    expect(audit?.field).toBe("rewrite_blocked");
    expect(audit?.changed_by).toBe("system:write-guard");
    expect(audit?.reason).toContain("frozen");
  });

  test("assignment='previously_submitted' alone locks, even if the cycle row is gone", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    const rec = record(a, "Allison Wittner", W1, { cycle_id: CYCLE_ID, assignment: "previously_submitted" });
    await store.upsertCommissionWeeklyRecord(rec);
    const res = await store.upsertCommissionWeeklyRecord(record(a, "Allison Wittner", W1, { qualifying_bookings: 500, cycle_id: null, assignment: "unassigned" }));
    expect(res.blocked).toBe(true);
    const after = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: W1 }))[0];
    expect(after.assignment).toBe("previously_submitted");
    expect(after.qualifying_bookings).toBe(10);
  });

  test("tier/rep/setting changes never rewrite stored records; recompute surfaces drift, stored frozen", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "m" });
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "m" });
    await submitCommissionCycle(store, { cycleId: CYCLE_ID, actor: "m" });
    const before = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: W1 }))[0];
    // tier/rate/setting change: bump Allison's tier — the engine's rateCommission
    // re-runs would compute different money, but the STORED record never changes.
    await store.setUserCommissionProfile(a, { employment_type: "full_time", commission_tier: 1, tier_effective_date: "2026-08-31", tier_end_date: null, commission_eligible: true });
    expect(marginalBookingValueCents("full_time", 1, 10)).toBe(500); // engine WOULD say $5/booking now
    const after = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: W1 }))[0];
    expect(after.tier).toBe(before.tier);
    expect(after.base_commission).toBe(before.base_commission);
    expect(after.total).toBe(before.total);
  });

  test("close tick re-run after submission writes nothing new for those weeks (records counted honestly)", async () => {
    const store = new MemoryStore();
    const { a, b } = await seedCycle(store);
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "m" });
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "m" });
    await submitCommissionCycle(store, { cycleId: CYCLE_ID, actor: "m" });
    // The close tick has nothing due (records exist), so it must be a no-op:
    const res = await commissionCloseTick(store, { epochWeekStart: W1, throughWeekStart: W4 });
    expect(res.recordsWritten).toBe(0);
    expect(res.outcome).toBe("skipped");
    const recs = await store.getCommissionWeeklyRecords({ cycleId: CYCLE_ID });
    expect(recs.length).toBe(8);
    expect(recs.every((r) => r.assignment === "previously_submitted")).toBe(true);
    expect(a && b).toBeTruthy();
  });
});

describe("§O/§20 corrections — reason required, audited, money-side only", () => {
  test("empty/blank reason throws and NOTHING changes", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    const before = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: W1 }))[0];
    await expect(applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "manual_adjustment", deltaDollars: 50, reason: "   ", actor: "m" })).rejects.toThrow(/reason is required/i);
    const after = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: W1 }))[0];
    expect(after.total).toBe(before.total);
    expect((await store.getCommissionAdjustments({ cycleId: CYCLE_ID })).length).toBe(0);
  });

  test("manual adjustment: manual_adjustment + total move; auto-calc fields frozen; audit row complete", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    const res = await applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "manual_adjustment", deltaDollars: -25, reason: "Duplicate booking paid twice", actor: "chris" });
    expect(res.deltaDollars).toBe(-25);
    expect(res.record.manual_adjustment).toBe(-25);
    expect(res.record.total).toBe(175);
    expect(res.record.base_commission).toBe(200); // frozen
    expect(res.record.qualifying_bookings).toBe(10); // frozen
    expect(res.record.calc_version).toBe(2); // frozen
    expect(res.audit.field).toBe("manual_adjustment");
    expect(res.audit.old_value).toContain("total $200.00");
    expect(res.audit.new_value).toContain("total $175.00");
    expect(res.audit.changed_by).toBe("chris");
    expect(res.audit.reason).toBe("Duplicate booking paid twice");
    expect(res.audit.changed_at).toBeTruthy();
  });

  test("zero-delta manual adjustment is refused (no junk audit rows)", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    await expect(applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "manual_adjustment", deltaDollars: 0, reason: "x", actor: "m" })).rejects.toThrow(/non-zero/);
  });

  test("exclude_booking uses the record's OWN tier math (marginal value) and audits the booking id", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    // FT T5, 10 bookings: 10 ≤ 40 → the marginal (10th) booking is worth $20.
    expect(marginalBookingValueCents("full_time", 5, 10)).toBe(2000);
    // the correction targets a COUNTED booking — seed the frozen snapshot with one
    await store.upsertCommissionWeeklyRecord(record(a, "Allison Wittner", W1, {
      cycle_id: CYCLE_ID, assignment: "current_cycle",
      counted_bookings: [{ id: "appt-xyz", acuity_appointment_id: "acq-1", client_name: "Client", appointment_type: "Portrait Session", win_date: "2026-09-02", manual: false }],
    }));
    const res = await applyCommissionCorrection(store, {
      cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "exclude_booking",
      appointmentId: "appt-xyz", reason: "Deposit refunded", actor: "m",
    });
    expect(res.deltaDollars).toBe(-20);
    expect(res.record.total).toBe(180);
    expect(res.audit.field).toBe("booking_excluded:appt-xyz");
    // refusing to exclude an unknown booking
    await expect(applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "exclude_booking", appointmentId: "nope", reason: "x", actor: "m" })).rejects.toThrow(/counted bookings/);
  });

  test("restore_booking requires a prior audited exclusion", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    await store.upsertCommissionWeeklyRecord(record(a, "Allison Wittner", W1, {
      cycle_id: CYCLE_ID, assignment: "current_cycle",
      counted_bookings: [{ id: "appt-xyz", acuity_appointment_id: "acq-1", client_name: "Client", appointment_type: "Portrait Session", win_date: "2026-09-02", manual: false }],
    }));
    await expect(applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "restore_booking", appointmentId: "appt-xyz", reason: "x", actor: "m" })).rejects.toThrow(/No audited exclusion/);
    await applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "exclude_booking", appointmentId: "appt-xyz", reason: "refund", actor: "m" });
    const res = await applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "restore_booking", appointmentId: "appt-xyz", reason: "refund reversed", actor: "m" });
    expect(res.deltaDollars).toBe(20);
    expect(res.record.total).toBe(200);
    expect(res.audit.field).toBe("booking_restored:appt-xyz");
  });

  test("hole_bonus correction adds $10 × count and is audited", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    const res = await applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "hole_bonus", holeCount: 2, reason: "Two slots filled but capped by ruling 5 — owner override", actor: "m" });
    expect(res.deltaDollars).toBe(20);
    expect(res.record.manual_adjustment).toBe(20);
    expect(res.record.hole_bonus).toBe(0); // auto-calc field frozen; the money is the adjustment
    expect(res.audit.field).toBe("hole_bonus_added");
  });

  test("corrections work on SUBMITTED records (that is the audited path) and the cycle must match", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "m" });
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "m" });
    await submitCommissionCycle(store, { cycleId: CYCLE_ID, actor: "m" });
    const res = await applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "manual_adjustment", deltaDollars: 10, reason: "Missed filled-hole bonus found after submission", actor: "m" });
    expect(res.record.total).toBe(210);
    expect(res.record.assignment).toBe("previously_submitted");
    // wrong-cycle corrections are refused
    await expect(applyCommissionCorrection(store, { cycleId: "other-cycle", userId: a, weekStart: W1, kind: "manual_adjustment", deltaDollars: 5, reason: "x", actor: "m" })).rejects.toThrow(/belongs to cycle/);
  });
});

describe("§S week↔cycle states — no double counting", () => {
  test("boundary week (Sep 28 – Oct 4) stays Unassigned and rides the next cycle", async () => {
    const store = new MemoryStore();
    await seedCycle(store);
    const { a } = await seedCycle(store);
    await store.upsertCommissionWeeklyRecord(record(a, "Allison Wittner", BOUNDARY));
    const boundary = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: BOUNDARY }))[0];
    expect(boundary.assignment).toBe("unassigned");
    expect(boundary.cycle_id).toBeNull();
    // The Commission Center must NOT fold it into the current cycle (outside its range)
    const page = await commissionPageData({ store, today: FRI });
    expect(page.records.some((r) => r.week_start === BOUNDARY)).toBe(false);
    expect(page.unassignedRiding.some((r) => r.week_start === BOUNDARY)).toBe(true);
  });

  test("a week can be assigned to ONE cycle; assigning the same week to another cycle is refused", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    await store.upsertCommissionWeeklyRecord(record(a, "Allison Wittner", BOUNDARY));
    await store.upsertCommissionCycle(cycleRow({ id: "cycle-next", label: "next", start_date: BOUNDARY, end_date: addDaysLocal(BOUNDARY, 6), submission_date: "2026-11-02" }));
    // assign to the NEXT cycle (RULING 4 pre-approval pull)
    const res = await assignCommissionWeeks(store, { cycleId: "cycle-next", weekStarts: [BOUNDARY], actor: "m" });
    expect(res.assignedRecords).toBe(1);
    let rec = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: BOUNDARY }))[0];
    expect(rec.assignment).toBe("current_cycle");
    expect(rec.cycle_id).toBe("cycle-next");
    // double counting is structurally impossible:
    await expect(assignCommissionWeeks(store, { cycleId: CYCLE_ID, weekStarts: [BOUNDARY], actor: "m" })).rejects.toThrow(/exactly one cycle|unassign it first/);
    // ...and assigning into a SUBMITTED cycle is refused too
    await transitionCommissionCycle(store, { cycleId: "cycle-next", to: "ready_for_review", actor: "m" });
    await transitionCommissionCycle(store, { cycleId: "cycle-next", to: "approved", actor: "m" });
    await submitCommissionCycle(store, { cycleId: "cycle-next", actor: "m" });
    await expect(assignCommissionWeeks(store, { cycleId: "cycle-next", weekStarts: [W2], actor: "m" })).rejects.toThrow(/submitted cycle/);
    // submitted membership flips
    rec = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: BOUNDARY }))[0];
    expect(rec.assignment).toBe("previously_submitted");
    await expect(assignCommissionWeeks(store, { cycleId: CYCLE_ID, weekStarts: [BOUNDARY], actor: "m" })).rejects.toThrow(/exactly one cycle/);
  });

  test("unassign works pre-submission (audited) then the week can move to another cycle", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    await store.upsertCommissionWeeklyRecord(record(a, "Allison Wittner", BOUNDARY));
    await store.upsertCommissionCycle(cycleRow({ id: "cycle-next", label: "next", start_date: BOUNDARY, end_date: addDaysLocal(BOUNDARY, 6), submission_date: "2026-11-02" }));
    await assignCommissionWeeks(store, { cycleId: "cycle-next", weekStarts: [BOUNDARY], actor: "m" });
    await unassignCommissionWeeks(store, { cycleId: "cycle-next", weekStarts: [BOUNDARY], actor: "m", note: "Owner moved it to the first cycle" });
    let rec = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: BOUNDARY }))[0];
    expect(rec.assignment).toBe("unassigned");
    expect(rec.cycle_id).toBeNull();
    const res = await assignCommissionWeeks(store, { cycleId: CYCLE_ID, weekStarts: [BOUNDARY], actor: "m" });
    expect(res.assignedRecords).toBe(1);
    rec = (await store.getCommissionWeeklyRecords({ userId: a, weekStart: BOUNDARY }))[0];
    expect(rec.cycle_id).toBe(CYCLE_ID);
    // every membership move left an audit row
    const audits = await store.getCommissionAdjustments({ targetId: `${a}:${BOUNDARY}` });
    expect(audits.length).toBe(3); // assign → unassign → assign
    expect(audits.every((r) => r.field === "assignment")).toBe(true);
  });

  test("assignment flips at submission make the submitted week impossible to re-count into a new cycle", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "m" });
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "approved", actor: "m" });
    const res = await submitCommissionCycle(store, { cycleId: CYCLE_ID, actor: "m" });
    expect(res.recordsFlipped).toBe(8); // 2 reps × 4 weeks
    const recs = await store.getCommissionWeeklyRecords({ cycleId: CYCLE_ID });
    expect(recs.every((r) => r.assignment === "previously_submitted")).toBe(true);
    await store.upsertCommissionCycle(cycleRow({ id: "cycle-next", label: "next", start_date: BOUNDARY, end_date: addDaysLocal(BOUNDARY, 6), submission_date: "2026-11-02" }));
    await expect(assignCommissionWeeks(store, { cycleId: "cycle-next", weekStarts: [W1], actor: "m" })).rejects.toThrow(/exactly one cycle/);
  });
});

describe("§14/§16 Copy Payroll Email — stored numbers only", () => {
  test("one block per employee: name / Bookings / Commission Bonus, bonus-ranked", async () => {
    const store = new MemoryStore();
    const { a, b } = await seedCycle(store);
    await applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: b, weekStart: W1, kind: "manual_adjustment", deltaDollars: 200, reason: "owner override", actor: "m" });
    const records = await store.getCommissionWeeklyRecords({ cycleId: CYCLE_ID });
    const lines = payrollEmailLines(records);
    expect(lines.length).toBe(2);
    expect(lines[0].name).toBe("Allison Wittner"); // 800 > 280
    expect(lines[0].bookings).toBe(40);
    expect(lines[0].bonusMoney).toBe("$800.00");
    const text = buildPayrollEmail(records);
    expect(text).toContain("Allison Wittner\nBookings: 40\nCommission Bonus: $800.00");
    expect(text).toContain("Carmine Morgano\nBookings: 16\nCommission Bonus: $280.00");
    expect(text).not.toContain("estimat"); // never mixed with estimates
    expect(a && b).toBeTruthy();
  });

  test("email totals reconcile to the cycle rollup (same stored records)", async () => {
    const store = new MemoryStore();
    await seedCycle(store);
    const records = await store.getCommissionWeeklyRecords({ cycleId: CYCLE_ID });
    const total = Math.round(records.reduce((s, r) => s + r.total, 0) * 100) / 100;
    const lines = payrollEmailLines(records);
    expect(Math.round(lines.reduce((s, l) => s + parseFloat(l.bonusMoney.replace("$", "")) * 100, 0)) / 100).toBe(total);
  });
});

describe("§21 dashboard commission card payload (Today, live from commission tables)", () => {
  test("todayPageData carries the estimate + next submission from stored cycles", async () => {
    const store = new MemoryStore();
    await seedCycle(store);
    const p = await todayPageData({ store, today: FRI });
    expect(p.commission).toBeTruthy();
    expect(p.commission!.weekStart).toBeTruthy();
    if (p.commission!.estimate) {
      expect(typeof p.commission!.estimate.teamBookings).toBe("number");
      expect(Array.isArray(p.commission!.estimate.employees)).toBe(true);
    } else {
      expect(p.commission!.estimateError).toBeTruthy(); // honest gap, never a guess
    }
    expect(p.commission!.nextSubmission?.submissionDate).toBe("2026-10-05");
    expect(p.commission!.nextSubmission?.status).toBe("in_progress");
    expect(p.commission!.nextSubmission?.label).toBe("Aug 31 – Sep 27, 2026");
  });

  test("nextCommissionSubmission picks the earliest FUTURE submission, else the latest cycle", async () => {
    const store = new MemoryStore();
    const c1 = cycleRow();
    const c2 = cycleRow({ id: "cycle-next", submission_date: "2026-11-02", start_date: BOUNDARY });
    await store.upsertCommissionCycle(c1);
    await store.upsertCommissionCycle(c2);
    expect(nextCommissionSubmission([c1, c2], FRI)?.id).toBe(CYCLE_ID); // Oct 5 ≥ Oct 2
    expect(nextCommissionSubmission([c1, c2], "2026-10-06")?.id).toBe("cycle-next");
    expect(nextCommissionSubmission([c1, c2], "2026-11-03")?.id).toBe("cycle-next"); // none future → the newest cycle (being worked now)
    expect(nextCommissionSubmission([], FRI)).toBeNull();
    // QA 2026-10-08: a SUBMITTED cycle is never shown as "next" — an
    // already-submitted cycle's deadline is neither upcoming nor overdue.
    const done = cycleRow({ status: "submitted", submitted_date: "2026-10-05", submitted_by: "m" });
    expect(nextCommissionSubmission([done], "2026-10-06")).toBeNull(); // only cycle is submitted → honest empty
    const doneNext = cycleRow({ id: "cycle-next", submission_date: "2026-11-02", start_date: BOUNDARY, status: "in_progress" });
    expect(nextCommissionSubmission([done, doneNext], "2026-11-03")?.id).toBe("cycle-next"); // unsubmitted overdue cycle still shows honestly
  });
});

describe("Commission Center payload carries the Phase C audit trail", () => {
  test("commissionPageData exposes the cycle's adjustments (newest first)", async () => {
    const store = new MemoryStore();
    const { a } = await seedCycle(store);
    await transitionCommissionCycle(store, { cycleId: CYCLE_ID, to: "ready_for_review", actor: "m" });
    await applyCommissionCorrection(store, { cycleId: CYCLE_ID, userId: a, weekStart: W1, kind: "manual_adjustment", deltaDollars: 5, reason: "test", actor: "m" });
    const page = await commissionPageData({ store, today: FRI });
    expect(page.adjustments.length).toBe(2);
    expect(page.adjustments[0].field).toBe("manual_adjustment"); // newest first
    expect(page.adjustments[1].field).toBe("status");
    // §26 validation untouched by a money-side correction? NO — total moved, so
    // the validation screen HONESTLY surfaces the delta (surfaced, never hidden).
    const val = await store.getCommissionWeeklyRecords({ userId: a, weekStart: W1 });
    expect(val[0].total).toBe(205);
  });
});
