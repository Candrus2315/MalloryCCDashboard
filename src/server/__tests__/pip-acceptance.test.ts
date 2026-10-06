/**
 * PIP PHASE 5 — THE OWNER'S 12 ACCEPTANCE TESTS (owner directive 9/30 + the
 * module's core rules, walked end-to-end through the Core API — the exact
 * functions the server functions call). MemoryStore always; PgStore when
 * TEST_DATABASE_URL is set (the pip-store/pip-phase4 playbook: far-out 2027
 * windows so no live row interferes, every test row cleaned up in finally).
 *
 * The 12 scenarios (each maps to a directive rule; the pip-design-spec lists
 * the phases, the rules below are the module's acceptance contract):
 *   AC1  Draft creation is manager-driven; template defaults apply + provenance.
 *   AC2  Issue freezes the document permanently (v1 snapshot with evidence).
 *   AC3  Frozen snapshots are IMMUTABLE (write-once; terminal states frozen).
 *   AC4  Weekly goal-met = HARD weekly minimums, never averaged.
 *   AC5  Check-ins append after issue; overdue detection is rule-based.
 *   AC6  Manager-created templates: create/edit/delete + live in-use counts.
 *   AC7  Per-employee history stitches every lifecycle state.
 *   AC8  RBAC — manager-only server surface (pip-rbac.test.ts; wiring walked).
 *   AC9  Manager records the acknowledgment (no employee logins); audited.
 *   AC10 Complete/Cancel are explicit manager actions with required reasons.
 *   AC11 Full audit: every mutation lands in the event log + manual_overrides.
 *   AC12 Print/PDF export serves the FROZEN snapshot verbatim (no recompute).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MemoryStore } from "../store/memory";
import {
  addPipCheckinCore,
  cancelPipCore,
  completePipCore,
  createPipDraftCore,
  createPipTemplateCore,
  deletePipTemplateCore,
  getPipPrintDocCore,
  getPipRepHistoriesCore,
  issuePipCore,
  performanceLandingCore,
  recordPipAckCore,
  updatePipDraftCore,
  updatePipTemplateCore,
} from "../pip-api";
import { pipEvidenceCore } from "../pip-evidence";
import type { Store } from "../store/types";
import type { AttributionRow } from "../metrics/compute";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Far-out Mon–Sun weeks no live record can share (the pip-evidence playbook). */
const W1 = "2027-01-04";
const W2 = "2027-01-11";
const W3 = "2027-01-18";
const W4 = "2027-01-25";
const WEEKS = [W1, W2, W3, W4];
const REVIEW_END = "2027-01-31";
const TODAY = "2027-01-20"; // a Wednesday inside week 3

interface BatteryCtx {
  store: Store;
  stamp: number;
  repId: string;
  templateId: string;
  /** appointment ids created post-issue for the no-recompute proof (cleanup). */
  extraAcuityIds: string[];
  pipIds: string[];
  templateIds: string[];
  userIds: string[];
}

/**
 * Seed N paid in-scope wins for the rep in a win-bucket week and attribute
 * them (the pip-evidence seeding pattern: scope settings from the store, ids
 * resolved via the overlapping selector, manual attributions).
 */
async function seedWins(store: Store, stamp: number, repId: string, week: string, count: number, startSeq: number): Promise<void> {
  if (count <= 0) return;
  const scopeSettings = await store.getSettings();
  const seedCalendar = scopeSettings.acuity?.calendars_included?.[0] ?? null;
  const seedType = scopeSettings.acuity?.types_included?.[0] ?? "Animalia Session";
  const rows = Array.from({ length: count }, (_, i) => startSeq + i + 1);
  await store.upsertAppointments(
    rows.map(
      (n) =>
        ({
          id: `pip-acc-${stamp}-${n}`,
          contact_id: null,
          calendar_id: seedCalendar,
          appointment_type: seedType,
          appointment_datetime: `${week}T14:00:00.000Z`,
          created_at: `${week}T14:00:00.000Z`,
          created_business_date: week,
          raw: { paid: "yes", price: "300.00", amountPaid: "300.00" },
          status: "scheduled",
          cancelled: false,
          acuity_appointment_id: `pip-acc-${stamp}-${n}`,
          payment_state: "paid",
          booking_win_business_date: week,
        }) as unknown as Parameters<Store["upsertAppointments"]>[0][number],
    ),
  );
  const overlap = await store.getAppointmentsOverlapping(`${week}T00:00:00.000Z`, `${week}T23:59:59.000Z`);
  const attrRows: AttributionRow[] = rows.map((n, i) => ({
    id: `pip-acc-attr-${stamp}-${n}`,
    appointment_id: overlap.find((a) => a.acuity_appointment_id === `pip-acc-${stamp}-${n}`)!.id,
    call_id: null,
    rep_id: repId,
    method: "manual",
    confidence: 1,
    manual_override: true,
    note: "pip acceptance seed",
  }));
  await store.upsertAttributions(attrRows);
}

async function runAcceptanceBattery(makeStore: () => Store): Promise<BatteryCtx> {
  const store = makeStore();
  const stamp = Date.now();
  const ctx: BatteryCtx = { store, stamp, repId: "", templateId: "", extraAcuityIds: [], pipIds: [], templateIds: [], userIds: [] };
  const cleanupIds = { pipIds: ctx.pipIds, templateIds: ctx.templateIds, userIds: ctx.userIds };

  // ---- roster: one test rep ----
  await store.upsertUsers([
    {
      provider: "highlevel",
      external_id: `test-pip-acc-${stamp}`,
      name: `P5 Acceptance Rep ${stamp}`,
      email: `pip-acc-${stamp}@example.com`,
      is_active: true,
      call_start_date: null,
    },
  ]);
  const rep = (await store.getAllUsers()).find((u) => u.external_id === `test-pip-acc-${stamp}`)!;
  ctx.repId = rep.id;
  cleanupIds.userIds.push(rep.id);

  // ---- AC1: draft creation with template defaults + provenance ----
  const template = await createPipTemplateCore(store, {
    name: `P5 acceptance template ${stamp}`,
    category: "Booking Performance",
    defaultGoalText: "Hit the weekly booking minimum in every review week.",
    defaultCheckinCadenceDays: 7,
    actor: "christopher",
  });
  ctx.templateId = template.id;
  cleanupIds.templateIds.push(template.id);
  expect(template.version).toBe(1);

  const draft = await createPipDraftCore(store, {
    repId: rep.id,
    title: `P5 acceptance ${stamp}`,
    templateId: template.id,
    reviewStartDate: W1,
    reviewEndDate: REVIEW_END,
    pipStartDate: W1,
    pipEndDate: REVIEW_END,
    weeklyGoalMin: 6,
    hardWeeklyMinimum: true,
    actor: "christopher",
  });
  cleanupIds.pipIds.push(draft.id);
  expect(draft.status).toBe("draft");
  expect(draft.template_id).toBe(template.id); // provenance stamped
  expect(draft.template_version).toBe(1);
  expect(draft.goal_text).toBe("Hit the weekly booking minimum in every review week."); // template default applied
  expect(draft.checkin_cadence_days).toBe(7);
  expect(draft.manager_acked_at).toBeNull();

  // Guards: unknown rep / unknown template refuse to create.
  await expect(
    createPipDraftCore(store, { repId: "nobody", title: "x", actor: "christopher" }),
  ).rejects.toThrow(/Unknown rep/i);
  await expect(
    createPipDraftCore(store, { repId: rep.id, title: "x", templateId: "no-such-template", actor: "christopher" }),
  ).rejects.toThrow(/Unknown template/i);

  // ---- AC4 (engine level, before freeze): hard weekly minimums, never averaged ----
  await seedWins(store, stamp, rep.id, W1, 5, 0); // week 1 → 5 wins
  await seedWins(store, stamp, rep.id, W2, 7, 10); // week 2 → 7 wins
  await seedWins(store, stamp, rep.id, W3, 2, 20); // week 3 (in progress) → 2 wins
  const draftAfter = await store.getPip(draft.id);
  expect(draftAfter!.status).toBe("draft");
  const liveEvidence = await pipEvidenceCore(store, {
    repId: rep.id,
    reviewStart: W1,
    reviewEnd: REVIEW_END,
    weeklyGoalMin: 6,
    hardWeeklyMinimum: true,
    today: TODAY,
  });
  expect(liveEvidence.weekly.map((w) => w.actual)).toEqual([5, 7, 2, null]); // future = null, never 0
  expect(liveEvidence.weekly.map((w) => w.met)).toEqual([false, true, null, null]);
  // NEVER AVERAGED: the completed weeks' average is (5+7)/2 = 6 = the minimum —
  // an averaged rule would pass this employee; the hard per-week rule does not.
  expect((5 + 7) / 2).toBe(6);
  expect(liveEvidence.weeks_goal_met).toBe(1);
  expect(liveEvidence.weekly.filter((w) => w.met === false).length).toBe(1);

  // ---- AC2: issue freezes the document permanently ----
  const issued = await issuePipCore(store, { pipId: draft.id, actor: "christopher", today: TODAY });
  expect(issued.status).toBe("issued");
  expect(issued.issued_by).toBe("christopher");
  expect(issued.issued_at).not.toBeNull();
  const snapshots = await store.getPipEvidenceSnapshots(draft.id);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].version).toBe(1);
  const doc = snapshots[0].snapshot as Record<string, unknown>;
  expect(doc.snapshot_schema).toBe(2);
  const docPip = doc.pip as Record<string, unknown>;
  expect(docPip.title).toBe(`P5 acceptance ${stamp}`);
  expect(docPip.status).toBe("draft"); // the row AS IT STOOD at issue
  const docEvidence = doc.evidence as { weekly: { actual: number | null; met: boolean | null }[] };
  expect(docEvidence.weekly.map((w) => w.actual)).toEqual([5, 7, 2, null]);
  const statements = doc.statements as { key: string; text: string }[];
  expect(statements.length).toBeGreaterThanOrEqual(1);
  expect(statements.some((s) => s.key === "goal_weeks")).toBe(true);
  expect((doc.employee as { name: string }).name).toBe(`P5 Acceptance Rep ${stamp}`);

  // The issued document is frozen: draft editing refuses.
  await expect(
    updatePipDraftCore(store, { pipId: draft.id, title: "nope", actor: "christopher" }),
  ).rejects.toThrow(/draft/i);
  // Re-issue refuses (only DRAFT PIPs can be issued).
  await expect(issuePipCore(store, { pipId: draft.id, actor: "christopher", today: TODAY })).rejects.toThrow(/draft/i);

  // ---- AC12 (post-issue part 1): the print doc serves the frozen snapshot verbatim ----
  const printBefore = await getPipPrintDocCore(store, draft.id);
  expect(printBefore).not.toBeNull();
  expect(printBefore!.document).not.toBeNull();
  expect(JSON.stringify((printBefore!.document as Record<string, unknown>).evidence)).toBe(
    JSON.stringify(docEvidence),
  );

  // LIVE CHANGE that would move a recomputation: 1 more attributed win in week 1.
  await seedWins(store, stamp, rep.id, W1, 1, 30);
  ctx.extraAcuityIds.push(`pip-acc-${stamp}-31`);
  const printAfter = await getPipPrintDocCore(store, draft.id);
  const printEvidence = (printAfter!.document as Record<string, unknown>).evidence as {
    weekly: { actual: number | null }[];
  };
  expect(printEvidence.weekly.map((w) => w.actual)).toEqual([5, 7, 2, null]); // NOT recomputed (would be [6,7,2,...])

  // ---- AC5: check-ins append after issue; overdue detection is rule-based ----
  const checkin = await addPipCheckinCore(store, {
    pipId: draft.id,
    checkinDate: "2027-01-13",
    managerName: "christopher",
    currentPerformance: "Week 1 finished at 5 of 6 — below the minimum.",
    nextCheckinDate: "2027-01-13",
  });
  expect(checkin.pip_id).toBe(draft.id);
  await expect(
    addPipCheckinCore(store, { pipId: draft.id, checkinDate: "bad-date", managerName: "christopher" }),
  ).rejects.toThrow(/YYYY-MM-DD/i);
  const landingOverdue = await performanceLandingCore(store, { today: TODAY });
  const overdueRow = landingOverdue.pips.find((p) => p.id === draft.id)!;
  expect(overdueRow.checkin_overdue).toBe(true); // next check-in date passed
  expect(overdueRow.checkin_count).toBe(1);

  // ---- AC9: the manager records the acknowledgment (no employee logins) ----
  const acked = await recordPipAckCore(store, { pipId: draft.id, actor: "christopher" });
  expect(acked.manager_acked_at).not.toBeNull();
  expect(acked.manager_acked_by).toBe("christopher");
  expect(acked.status).toBe("issued"); // ack stamps ONLY the ack columns
  await expect(recordPipAckCore(store, { pipId: draft.id, actor: "christopher" })).rejects.toThrow(/already/i);
  const landingAcked = await performanceLandingCore(store, { today: TODAY });
  const ackedRow = landingAcked.pips.find((p) => p.id === draft.id)!;
  expect(ackedRow.ack_awaiting).toBe(false); // the derivation cleared

  // ---- AC10: Complete/Cancel are explicit + guarded ----
  await expect(
    completePipCore(store, { pipId: draft.id, conclusionCategory: "", conclusionNotes: "y", actor: "christopher" }),
  ).rejects.toThrow(/conclusion_category/i);
  await expect(
    completePipCore(store, { pipId: draft.id, conclusionCategory: "x", conclusionNotes: " ", actor: "christopher" }),
  ).rejects.toThrow(/conclusion_notes/i);
  const completed = await completePipCore(store, {
    pipId: draft.id,
    conclusionCategory: "Successful completion",
    conclusionNotes: "Weeks 2 onward met the minimum.",
    actor: "christopher",
  });
  expect(completed.status).toBe("completed");
  expect(completed.conclusion_category).toBe("Successful completion");
  // Terminal states accept nothing.
  await expect(
    completePipCore(store, { pipId: draft.id, conclusionCategory: "x", conclusionNotes: "y", actor: "christopher" }),
  ).rejects.toThrow(/issued/i);
  await expect(
    cancelPipCore(store, { pipId: draft.id, reason: "again", actor: "christopher" }),
  ).rejects.toThrow(/issued/i);
  await expect(
    updatePipDraftCore(store, { pipId: draft.id, title: "nope", actor: "christopher" }),
  ).rejects.toThrow(/draft/i);
  await expect(
    addPipCheckinCore(store, { pipId: draft.id, checkinDate: "2027-01-21", managerName: "christopher" }),
  ).rejects.toThrow(/issued/i);

  // ---- AC3: frozen snapshots immutable through the whole lifecycle ----
  const snapsAfter = await store.getPipEvidenceSnapshots(draft.id);
  expect(snapsAfter).toHaveLength(1);
  expect(JSON.stringify(snapsAfter[0].snapshot)).toBe(JSON.stringify(doc)); // byte-identical

  // ---- AC3b: cancel path keeps the snapshot byte-identical too ----
  const cancelDraft = await createPipDraftCore(store, {
    repId: rep.id,
    title: `P5 cancel ${stamp}`,
    goalText: "g",
    pipStartDate: W1,
    pipEndDate: REVIEW_END,
    actor: "christopher",
  });
  cleanupIds.pipIds.push(cancelDraft.id);
  const cancelIssued = await issuePipCore(store, { pipId: cancelDraft.id, actor: "christopher", today: TODAY });
  const cancelSnaps = await store.getPipEvidenceSnapshots(cancelDraft.id);
  expect(cancelSnaps).toHaveLength(1);
  const cancelFrozen = JSON.stringify(cancelSnaps[0].snapshot);
  const cancelled = await cancelPipCore(store, { pipId: cancelDraft.id, reason: "Ended without completion.", actor: "christopher" });
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.cancellation_reason).toContain("without completion");
  expect(await store.getPipEvidenceSnapshots(cancelDraft.id)).toHaveLength(1);
  expect(JSON.stringify((await store.getPipEvidenceSnapshots(cancelDraft.id))[0].snapshot)).toBe(cancelFrozen);
  await expect(
    cancelPipCore(store, { pipId: cancelDraft.id, reason: "again", actor: "christopher" }),
  ).rejects.toThrow(/issued/i);

  // ---- AC6: templates edit/version-bump/delete + live in-use counts ----
  const tplUpdated = await updatePipTemplateCore(store, {
    templateId: template.id,
    name: `P5 acceptance template ${stamp} v2`,
    actor: "christopher",
  });
  expect(tplUpdated.version).toBe(2); // every edit bumps
  // in-use counts are LIVE: the completed PIP no longer counts; the cancelled
  // one doesn't either; a fresh DRAFT referencing the template does.
  const usageBefore = await store.getPipTemplateUsage();
  expect(usageBefore.get(template.id) ?? 0).toBe(0); // both lifecycle-PIPs are closed
  const liveDraft = await createPipDraftCore(store, {
    repId: rep.id,
    title: `P5 in-use draft ${stamp}`,
    templateId: template.id,
    actor: "christopher",
  });
  cleanupIds.pipIds.push(liveDraft.id);
  expect((await store.getPipTemplateUsage()).get(template.id)).toBe(1);
  // Deletion refuses nothing referenced? — store semantics: delete is allowed
  // only when unreferenced is NOT enforced; the audit trail persists either way.
  const disposable = await createPipTemplateCore(store, { name: `P5 disposable template ${stamp}`, actor: "christopher" });
  cleanupIds.templateIds.push(disposable.id);
  await deletePipTemplateCore(store, disposable.id);
  expect((await store.listPipTemplates()).find((t) => t.id === disposable.id)).toBeUndefined();

  // ---- AC7: per-employee history stitches every lifecycle state ----
  const histories = await getPipRepHistoriesCore(store, { today: TODAY });
  const repHistory = histories.reps.find((r) => r.rep_id === rep.id)!;
  expect(repHistory.rep_name).toBe(`P5 Acceptance Rep ${stamp}`);
  const statuses = repHistory.pips.filter((p) => p.id !== liveDraft.id).map((p) => p.status);
  expect(statuses).toContain("completed");
  expect(statuses).toContain("cancelled");
  const completedHistory = repHistory.pips.find((p) => p.id === draft.id)!;
  expect(completedHistory.weeks_completed).toBe(2);
  // AC7 summaries are LIVE derivations through the ONE engine (pipEvidenceCore):
  // the extra week-1 win seeded for the AC12 no-recompute proof now makes week 1
  // met as well (6 >= 6). The FROZEN print document still shows [5,...] — AC12
  // proves snapshot ≠ recompute; the history view intentionally tracks live data.
  expect(completedHistory.weeks_met).toBe(2);
  expect(completedHistory.weeks_missed).toBe(0);
  // newest first
  const createdOrder = repHistory.pips.map((p) => p.created_at);
  expect([...createdOrder].sort((a, b) => b.localeCompare(a))).toEqual(createdOrder);
  // an unassigned draft refuses to create (app requires a rep on create)
  await expect(
    createPipDraftCore(store, { repId: "", title: "must fail", actor: "christopher" }),
  ).rejects.toThrow(/Pick a rep/i);

  // ---- AC12 (part 2): drafts print honestly; unknown ids return null ----
  const draftPrint = await getPipPrintDocCore(store, liveDraft.id);
  expect(draftPrint!.document).toBeNull(); // nothing frozen yet
  expect(draftPrint!.pip.status).toBe("draft");
  expect(await getPipPrintDocCore(store, "no-such-pip")).toBeNull();

  // ---- AC11: full audit — every mutation lands in the typed log + mirror ----
  const events = await store.getPipEvents({ pipId: draft.id, limit: 100 });
  for (const t of ["pip_created", "pip_issued", "pip_checkin_added", "pip_ack_recorded", "pip_completed"]) {
    expect(events.some((e) => e.event_type === t), `event ${t} must be logged`).toBe(true);
  }
  const cancelEvents = await store.getPipEvents({ pipId: cancelDraft.id, limit: 100 });
  expect(cancelEvents.some((e) => e.event_type === "pip_cancelled")).toBe(true);
  // Template events + never-deleted history: walk the full ledger.
  const allEvents = await store.getPipEvents({ limit: 500 });
  expect(allEvents.some((e) => e.event_type === "pip_template_created" && e.template_id === template.id)).toBe(true);
  expect(allEvents.some((e) => e.event_type === "pip_template_updated" && e.template_id === template.id)).toBe(true);
  expect(allEvents.some((e) => e.event_type === "pip_template_deleted" && e.template_id === disposable.id)).toBe(true);
  // The manual_overrides mirror carries the PIP actions (Settings → Audit).
  const overrides = await store.getManualOverrides(200);
  expect(overrides.some((o) => o.entity_type === "pip" && o.entity_id === draft.id)).toBe(true);
  expect(overrides.some((o) => o.entity_type === "pip_template" && o.entity_id === template.id)).toBe(true);
  // History is never deleted: the deleted template's events survive.
  expect(allEvents.some((e) => e.template_id === disposable.id && e.event_type === "pip_template_created")).toBe(true);

  return ctx;
}

describe("PIP Phase 5 — the owner's 12 acceptance scenarios (MemoryStore)", () => {
  test("AC1–AC12: lifecycle, evidence, RBAC module surface, audit, print honesty", async () => {
    const ctx = await runAcceptanceBattery(() => new MemoryStore());

    // ---- AC8 (wiring): every PIP server function asserts the manager server-side ----
    const source = readFileSync(new URL("../pip-api.ts", import.meta.url), "utf8");
    const re = /export const (\w+) = createServerFn/g;
    let m: RegExpExecArray | null;
    const names: string[] = [];
    while ((m = re.exec(source))) names.push(m[1]);
    expect(names.length).toBeGreaterThanOrEqual(18);
    for (const name of names) {
      const start = source.indexOf(`export const ${name} = createServerFn`);
      const next = source.indexOf("\nexport const ", start + 1);
      const body = source.slice(start, next === -1 ? source.length : next);
      expect(body, `server fn ${name} must call assertPipManager()`).toContain("await assertPipManager()");
    }
    // The pip module is the module's WHOLE server surface — nothing else reads PIP tables.
    const pipFnNames = new Set(names);
    for (const expected of ["getPerformanceList", "getPipDetail", "getPipPrintDoc", "createPipDraft", "issuePip", "recordPipAck"]) {
      expect(pipFnNames.has(expected)).toBe(true);
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PIP Phase 5 — acceptance battery (PgStore, real Postgres)", () => {
  test("same 12-scenario battery against the live schema (far-out 2027; full cleanup)", async () => {
    const { PgStore } = await import("../store/pg");
    const store = new PgStore(TEST_DATABASE_URL!);
    await store.ensureSchema();
    let ctx: BatteryCtx | null = null;
    try {
      ctx = await runAcceptanceBattery(() => store);
    } finally {
      const c = ctx ?? { pipIds: [], templateIds: [], userIds: [], extraAcuityIds: [], stamp: 0, repId: "", templateId: "" };
      const { default: postgres } = await import("postgres");
      const sql = postgres(TEST_DATABASE_URL!, { max: 1, ...(TEST_DATABASE_URL!.includes("sslmode=") ? {} : { ssl: "require" }) });
      try {
        if (c.pipIds.length) {
          await sql`DELETE FROM pip_event_log WHERE pip_id = ANY(${c.pipIds})`;
          await sql`DELETE FROM pip_evidence_snapshots WHERE pip_id = ANY(${c.pipIds})`;
          await sql`DELETE FROM pip_checkins WHERE pip_id = ANY(${c.pipIds})`;
          await sql`DELETE FROM manual_overrides WHERE entity_type = 'pip' AND entity_id = ANY(${c.pipIds})`;
          await sql`DELETE FROM pips WHERE id = ANY(${c.pipIds})`;
        }
        if (c.templateIds.length) {
          await sql`DELETE FROM pip_event_log WHERE template_id = ANY(${c.templateIds})`;
          await sql`DELETE FROM manual_overrides WHERE entity_type = 'pip_template' AND entity_id = ANY(${c.templateIds})`;
          await sql`DELETE FROM pip_templates WHERE id = ANY(${c.templateIds})`;
        }
        await sql`DELETE FROM booking_attributions WHERE note = 'pip acceptance seed'`;
        await sql`DELETE FROM manual_overrides WHERE entity_id IN (SELECT id::text FROM appointments WHERE acuity_appointment_id LIKE 'pip-acc-%')`;
        await sql`DELETE FROM appointments WHERE acuity_appointment_id LIKE 'pip-acc-%'`;
        if (c.userIds.length) {
          await sql`DELETE FROM manual_overrides WHERE entity_type = 'user' AND entity_id = ANY(${c.userIds})`;
          await sql`DELETE FROM users WHERE id = ANY(${c.userIds})`;
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 120_000);
});
