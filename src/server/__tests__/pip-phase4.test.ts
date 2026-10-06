/**
 * PIP PHASE 4 — acknowledgment ACTION, Complete/Cancel transitions + snapshot
 * immutability, templates-in-use counts, per-rep performance history.
 * MemoryStore always; PgStore when TEST_DATABASE_URL is set (the
 * pip-store.test.ts / pip-phase3-landing.test.ts playbook — every test row is
 * cleaned up, nothing test-made survives on the live database).
 *
 * Under test (owner directive 9/30 + pip-design-spec Phase 4):
 *  - recordPipAck: the audited manager acknowledgment mutation (who+when via
 *    pip_ack_recorded + the manual_overrides mirror); issued-only guard; a
 *    recorded acknowledgment is never re-stamped; the EXISTING ack_awaiting
 *    derivation clears (chip + rank-4 attention line) with no second path;
 *  - lifecycle forward-only: draft → issued → completed|cancelled; required
 *    reasons; every transition audited; terminal states accept nothing;
 *  - frozen evidence snapshots at issue are NEVER rewritten — cancelling does
 *    not retroactively alter the issued evidence (byte-identical snapshot);
 *  - templates-in-use: server-derived from LIVE PIP rows (draft + issued);
 *    closed plans stop counting;
 *  - getPipRepHistoriesCore: per-employee stitched history with weekly
 *    goal-met summaries through pipEvidenceCore — the ONE evidence engine
 *    (hard per-week rule, never averaged; not-evaluable → null, never a fake 0).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { performanceLandingCore, getPipRepHistoriesCore } from "../pip-api";
import type { Store } from "../store/types";

/** Deterministic anchors: today sits safely AFTER the whole review window. */
const TODAY = "2026-10-07"; // a Wednesday
const W1 = "2026-09-21"; // Monday
const W_END = "2026-10-04"; // Sunday of the second week

async function runPhase4Battery(makeStore: () => Store): Promise<{ pipIds: string[]; templateIds: string[]; userIds: string[] }> {
  const pipIds: string[] = [];
  const templateIds: string[] = [];
  const userIds: string[] = [];
  const store = makeStore();
  const stamp = Date.now();
  await store.upsertUsers([
    {
      provider: "highlevel",
      external_id: `test-pip4-${stamp}`,
      name: `PIP Phase4 Rep ${stamp}`,
      email: `pip4-${stamp}@example.com`,
      is_active: true,
      call_start_date: null,
    },
  ]);
  const rep = (await store.getAllUsers()).find((u) => u.external_id === `test-pip4-${stamp}`)!;
  userIds.push(rep.id);

  const mkIssued = async (title: string, weeklyGoalMin: number | null, start = W1, end = W_END) => {
    const draft = await store.createPip({
      rep_id: rep.id,
      title,
      goal_text: "Reach the weekly minimum in every review week.",
      weekly_goal_min: weeklyGoalMin,
      hard_weekly_minimum: true,
      review_start_date: start,
      review_end_date: end,
      pip_start_date: start,
      pip_end_date: end,
      created_by: "christopher",
    });
    return store.issuePip(draft.id, { issuedBy: "christopher" });
  };

  // ---------- 1. acknowledgment ACTION + derivation clearing ----------
  // FUTURE window (starts next Monday): no completed weeks → no minimum_missed
  // signal, end date far out → no past_end/ending_soon — so the ladder's rank-4
  // awaiting_ack line is the signal under test.
  const ackPip = await mkIssued("Phase4 ack — issued, no other signals", 3, "2026-10-12", "2026-11-06");
  pipIds.push(ackPip.id);

  const landingBefore = await performanceLandingCore(store, { today: TODAY });
  const beforeRow = landingBefore.pips.find((p) => p.id === ackPip.id)!;
  expect(beforeRow.ack_awaiting).toBe(true);
  expect(beforeRow.attention?.code).toBe("awaiting_ack"); // rank 4 fires
  expect(beforeRow.attention?.rank).toBe(4);

  // Guards: drafts cannot record acknowledgment; the action is not re-stampable.
  const bareDraft = await store.createPip({ rep_id: rep.id, title: "Phase4 bare draft", created_by: "christopher" });
  pipIds.push(bareDraft.id);
  await expect(store.recordPipAck(bareDraft.id, { ackedBy: "christopher" })).rejects.toThrow(/issued/i);
  await expect(store.recordPipAck("nonexistent-pip", { ackedBy: "christopher" })).rejects.toThrow(/not found/i);

  const acked = await store.recordPipAck(ackPip.id, { ackedBy: "christopher" });
  expect(acked.status).toBe("issued"); // the action stamps ONLY the ack columns
  expect(acked.manager_acked_at).not.toBeNull();
  expect(acked.manager_acked_by).toBe("christopher");
  await expect(store.recordPipAck(ackPip.id, { ackedBy: "christopher" })).rejects.toThrow(/already/i);

  // Audited: typed event + the manual_overrides mirror (who / what / when).
  const events = await store.getPipEvents({ pipId: ackPip.id });
  const ackEvent = events.find((e) => e.event_type === "pip_ack_recorded");
  expect(ackEvent).toBeDefined();
  expect(ackEvent?.actor).toBe("christopher");
  expect(ackEvent?.field).toBe("manager_acked_at");
  expect(ackEvent?.previous_value ?? "").toBe("");
  expect(ackEvent?.new_value).not.toBe("");
  const overrides = await store.getManualOverrides(100);
  expect(overrides.some((o) => o.entity_type === "pip" && o.entity_id === ackPip.id && o.field === "manager_acked_at")).toBe(true);

  // The EXISTING derivation clears: chip + rank-4 attention line are gone via
  // the SAME path (no second derivation was added anywhere).
  const landingAfter = await performanceLandingCore(store, { today: TODAY });
  const afterRow = landingAfter.pips.find((p) => p.id === ackPip.id)!;
  expect(afterRow.ack_awaiting).toBe(false);
  expect(afterRow.attention?.code).not.toBe("awaiting_ack");
  expect(afterRow.attention?.code).toBe("unscheduled"); // the next signal in the ladder
  expect(landingAfter.pips.every((p) => p.attention?.code !== "awaiting_ack" || p.ack_awaiting === true)).toBe(true);

  // ---------- 2. Complete/Cancel transitions + snapshot immutability ----------
  const cancelPipRow = await mkIssued("Phase4 cancel — issued", 3);
  pipIds.push(cancelPipRow.id);
  const snapsBefore = await store.getPipEvidenceSnapshots(cancelPipRow.id);
  expect(snapsBefore).toHaveLength(1);
  expect(snapsBefore[0].version).toBe(1);
  const frozenBefore = JSON.stringify(snapsBefore[0].snapshot);

  // Cancel requires a reason; cancel is issued-only; transitions are forward-only.
  await expect(store.cancelPip(cancelPipRow.id, { cancelledBy: "christopher", reason: "" })).rejects.toThrow(/cancellation_reason/i);
  const cancelled = await store.cancelPip(cancelPipRow.id, {
    cancelledBy: "christopher",
    reason: "Rep re-booked the backlog; plan ended without conclusion.",
  });
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.cancelled_by).toBe("christopher");
  expect(cancelled.cancellation_reason).toContain("backlog");
  await expect(store.cancelPip(cancelPipRow.id, { cancelledBy: "christopher", reason: "again" })).rejects.toThrow(/issued/i);
  await expect(store.completePip(cancelPipRow.id, { conclusionCategory: "x", conclusionNotes: "y", actor: "christopher" })).rejects.toThrow(/issued/i);
  await expect(store.updatePipDraft(cancelPipRow.id, { title: "nope" })).rejects.toThrow(/draft/i);
  await expect(store.recordPipAck(cancelPipRow.id, { ackedBy: "christopher" })).rejects.toThrow(/issued/i);

  // CANCELLING MUST NOT RETROACTIVELY ALTER ISSUED EVIDENCE: still exactly one
  // v1 snapshot, byte-identical, and the cancel event is audited.
  const snapsAfter = await store.getPipEvidenceSnapshots(cancelPipRow.id);
  expect(snapsAfter).toHaveLength(1);
  expect(JSON.stringify(snapsAfter[0].snapshot)).toBe(frozenBefore);
  const cancelEvents = await store.getPipEvents({ pipId: cancelPipRow.id });
  const cancelEvent = cancelEvents.find((e) => e.event_type === "pip_cancelled");
  expect(cancelEvent).toBeDefined();
  expect(cancelEvent?.previous_value).toBe("issued");
  expect(cancelEvent?.new_value).toBe("cancelled");
  expect((cancelEvent?.details ?? {}).reason).toContain("backlog");

  // Complete path: conclusion required; completion stamps the acknowledgment.
  await expect(store.completePip(ackPip.id, { conclusionCategory: "", conclusionNotes: "y", actor: "christopher" })).rejects.toThrow(/conclusion_category/i);
  await expect(store.completePip(ackPip.id, { conclusionCategory: "x", conclusionNotes: "", actor: "christopher" })).rejects.toThrow(/conclusion_notes/i);
  const completed = await store.completePip(ackPip.id, {
    conclusionCategory: "Successful completion",
    conclusionNotes: "Minimum met in every completed week.",
    actor: "christopher",
  });
  expect(completed.status).toBe("completed");
  expect(completed.completed_at).not.toBeNull();
  expect(completed.manager_acked_at).not.toBeNull();
  await expect(store.completePip(ackPip.id, { conclusionCategory: "x", conclusionNotes: "y", actor: "christopher" })).rejects.toThrow(/issued/i);
  await expect(store.cancelPip(ackPip.id, { cancelledBy: "christopher", reason: "x" })).rejects.toThrow(/issued/i);

  const landingFinal = await performanceLandingCore(store, { today: TODAY });
  const completedRow = landingFinal.pips.find((p) => p.id === ackPip.id)!;
  expect(completedRow.ack_awaiting).toBe(false); // completion clears ack-pending too
  expect(completedRow.attention).toBeNull(); // closed plans never raise attention

  // ---------- 3. templates-in-use (LIVE rows: draft + issued) ----------
  const tpl = await store.createPipTemplate({ name: `Phase4 template ${stamp}`, default_duration_weeks: 4, created_by: "christopher" });
  templateIds.push(tpl.id);
  expect((await store.getPipTemplateUsage()).get(tpl.id)).toBeUndefined(); // unreferenced → absent

  const fromTpl1 = await store.createPip({ rep_id: rep.id, title: "Phase4 tpl draft 1", goal_text: "g", template_id: tpl.id, pip_start_date: W1, pip_end_date: W_END, created_by: "christopher" });
  pipIds.push(fromTpl1.id);
  expect((await store.getPipTemplateUsage()).get(tpl.id)).toBe(1); // a DRAFT references it

  const fromTpl2 = await store.createPip({ rep_id: rep.id, title: "Phase4 tpl draft 2", goal_text: "g", template_id: tpl.id, pip_start_date: W1, pip_end_date: W_END, created_by: "christopher" });
  pipIds.push(fromTpl2.id);
  await store.issuePip(fromTpl2.id, { issuedBy: "christopher" });
  expect((await store.getPipTemplateUsage()).get(tpl.id)).toBe(2); // draft + issued

  await store.issuePip(fromTpl1.id, { issuedBy: "christopher" });
  expect((await store.getPipTemplateUsage()).get(tpl.id)).toBe(2); // both issued
  await store.completePip(fromTpl1.id, { conclusionCategory: "Closed", conclusionNotes: "n/a", actor: "christopher" });
  expect((await store.getPipTemplateUsage()).get(tpl.id)).toBe(1); // closed plans stop counting

  await store.cancelPip(fromTpl2.id, { cancelledBy: "christopher", reason: "cleanup" });
  expect((await store.getPipTemplateUsage()).get(tpl.id)).toBeUndefined(); // no LIVE reference remains

  // ---------- 4. per-rep performance history (ONE evidence engine) ----------
  // cancelPipRow (now cancelled) carries the 2-week PAST window with minimum 3;
  // no wins were seeded, so each COMPLETED week evaluates 0 < 3 → not met.
  // Hard per-week rule, never averaged.
  const histories = await getPipRepHistoriesCore(store, { today: TODAY });
  const repHistory = histories.reps.find((r) => r.rep_id === rep.id)!;
  expect(repHistory).toBeDefined();
  expect(repHistory.rep_name).toBe(rep.name);
  expect(repHistory.pips.length).toBeGreaterThanOrEqual(3); // completed + cancelled (+ drafts below)
  const evaluable = repHistory.pips.find((p) => p.id === cancelPipRow.id)!;
  expect(evaluable.weeks_completed).toBe(2);
  expect(evaluable.weeks_met).toBe(0);
  expect(evaluable.weeks_missed).toBe(2); // both completed weeks below the minimum
  // Newest first within the employee's history.
  const created = repHistory.pips.map((p) => p.created_at);
  expect([...created].sort((a, b) => b.localeCompare(a))).toEqual(created);

  // A draft with no review window / minimum is part of the history but shows
  // honest nulls — never a fake 0.
  const histDraft = await store.createPip({ rep_id: rep.id, title: "Phase4 history draft", created_by: "christopher" });
  pipIds.push(histDraft.id);
  const histories2 = await getPipRepHistoriesCore(store, { today: TODAY });
  const repHistory2 = histories2.reps.find((r) => r.rep_id === rep.id)!;
  const draftHist = repHistory2.pips.find((p) => p.id === histDraft.id)!;
  expect(draftHist.status).toBe("draft");
  expect(draftHist.weeks_met).toBeNull();
  expect(draftHist.weeks_completed).toBeNull();
  expect(draftHist.weeks_missed).toBeNull();

  return { pipIds, templateIds, userIds };
}

describe("PIP Phase 4 — MemoryStore", () => {
  test("ack action + derivation clearing, Complete/Cancel + snapshot immutability, templates-in-use, per-rep history", async () => {
    await runPhase4Battery(() => new MemoryStore());
  });
});

const RESTART = process.env.TEST_DATABASE_URL;

describe.skipIf(!RESTART)("PIP Phase 4 — PgStore (real Postgres)", () => {
  test("ack action + derivation clearing, Complete/Cancel + snapshot immutability, templates-in-use, per-rep history", async () => {
    const { PgStore } = await import("../store/pg");
    const store = new PgStore(RESTART!);
    await store.ensureSchema();
    let created: { pipIds: string[]; templateIds: string[]; userIds: string[] } = { pipIds: [], templateIds: [], userIds: [] };
    try {
      created = await runPhase4Battery(() => store);
    } finally {
      const { pipIds, templateIds, userIds } = created;
      const { default: postgres } = await import("postgres");
      const sql = postgres(RESTART!, { max: 1, ...(RESTART!.includes("sslmode=") ? {} : { ssl: "require" }) });
      try {
        if (pipIds.length) {
          await sql`DELETE FROM pip_event_log WHERE pip_id = ANY(${pipIds})`;
          await sql`DELETE FROM pip_evidence_snapshots WHERE pip_id = ANY(${pipIds})`;
          await sql`DELETE FROM pip_checkins WHERE pip_id = ANY(${pipIds})`;
          await sql`DELETE FROM manual_overrides WHERE entity_type = 'pip' AND entity_id = ANY(${pipIds})`;
          await sql`DELETE FROM pips WHERE id = ANY(${pipIds})`;
        }
        if (templateIds.length) {
          await sql`DELETE FROM pip_event_log WHERE template_id = ANY(${templateIds})`;
          await sql`DELETE FROM manual_overrides WHERE entity_type = 'pip_template' AND entity_id = ANY(${templateIds})`;
          await sql`DELETE FROM pip_templates WHERE id = ANY(${templateIds})`;
        }
        if (userIds.length) {
          await sql`DELETE FROM users WHERE id = ANY(${userIds})`;
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 90_000);
});
