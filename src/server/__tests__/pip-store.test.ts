/**
 * PIP MODULE (Phase 1) — store tests on BOTH stores.
 *
 * The 9/29 lesson (PR #18/#19): MemoryStore-only tests hid missing PgStore
 * methods and the syncs crashed in production. Every test here runs against
 * MemoryStore ALWAYS, and against a real PgStore when TEST_DATABASE_URL is
 * set (pg rows are cleaned up in finally; history rows for deleted test pips
 * go with them — nothing test-made survives).
 *
 * Semantics under test (owner directive 9/30):
 *  - lifecycle draft → issued → completed|cancelled with the exact guard
 *    requirements; nothing auto-transitions;
 *  - issued documents are immutable (draft edits rejected after issue);
 *  - the evidence snapshot is written ONCE at issue (write-once; UNIQUE per
 *    version; never updated);
 *  - check-ins only on issued PIPs;
 *  - every event lands in the typed event log AND the manual_overrides mirror;
 *  - template CRUD.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { PgStore } from "../store/pg";
import { STORE_INTERFACE_MEMBERS, STORE_VALUE_MEMBERS } from "../store/satisfies";
import type { Store } from "../store/types";
import { createPipDraftCore, listPipsCore, cancelPipCore, completePipCore, issuePipCore, updatePipDraftCore } from "../pip-api";

const RESTART = process.env.TEST_DATABASE_URL;

/** The full shared battery — one function, run against each store. */
async function runLifecycleBattery(makeStore: () => Store, cleanup?: (pipIds: string[], templateIds: string[], userIds: string[]) => Promise<void>): Promise<void> {
  const store = makeStore();
  const pipIds: string[] = [];
  const templateIds: string[] = [];
  const userIds: string[] = [];
  try {
    // A DEDICATED test rep (never a real roster rep — test PIPs must never
    // attach to real people, especially on the live pg database). upserts
    // ignore supplied ids, so resolve the internal id after the upsert.
    const stamp = Date.now();
    await store.upsertUsers([
      { provider: "highlevel", external_id: `test-pip-rep-${stamp}`, name: `PIP Test Rep ${stamp}`, email: `pip-test-${stamp}@example.com`, is_active: true, call_start_date: null },
    ]);
    const rep = (await store.getAllUsers()).find((u) => u.external_id === `test-pip-rep-${stamp}`);
    expect(rep).toBeDefined();
    userIds.push(rep!.id);

    // ---- create ----
    const draft = await store.createPip({
      rep_id: rep.id,
      title: "Q4 booking goal review",
      goal_text: "Reach the weekly booking goal in each week of the review period.",
      weekly_goal_min: 12,
      hard_weekly_minimum: true,
      pip_start_date: "2026-10-05",
      pip_end_date: "2026-11-06",
      manager_observations: "Missed the weekly goal in 4 of the last 5 weeks.",
      action_plan: [{ text: "Daily call block 9–10am", completed: false, completed_at: null }],
      created_by: "christopher",
    });
    pipIds.push(draft.id);
    expect(draft.status).toBe("draft");
    expect(draft.current_version).toBe(1);
    expect(draft.employee_visible).toBe(false);
    expect(draft.action_plan).toHaveLength(1);
    // No auto-transitions: a freshly created PIP is a draft with no stamps.
    expect(draft.issued_at).toBeNull();
    expect(draft.completed_at).toBeNull();

    // ---- draft edits ----
    const edited = await store.updatePipDraft(draft.id, {
      title: "Q4 booking goal review (revised)",
      manager_observations: "Missed the weekly goal in 4 of the last 5 weeks; call volume below roster median.",
      actor: "christopher",
    });
    expect(edited.title).toContain("revised");
    expect(edited.updated_at >= draft.updated_at).toBe(true);

    // ---- guards: cannot issue without requirements ----
    const bare = await store.createPip({ rep_id: rep.id, title: "Bare draft" });
    pipIds.push(bare.id);
    await expect(store.issuePip(bare.id, { issuedBy: "christopher" })).rejects.toThrow(/goal_text/i);
    const noEnd = await store.updatePipDraft(bare.id, { goal_text: "A goal" });
    await expect(store.issuePip(noEnd.id, { issuedBy: "christopher" })).rejects.toThrow(/pip_start_date/i);

    // ---- issue: frozen evidence snapshot v1 ----
    const issued = await store.issuePip(draft.id, { issuedBy: "christopher" });
    expect(issued.status).toBe("issued");
    expect(issued.issued_by).toBe("christopher");
    expect(issued.issued_at).not.toBeNull();
    const snaps = await store.getPipEvidenceSnapshots(draft.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].version).toBe(1);
    // PHASE 2 SNAPSHOT ENVELOPE (snapshot_schema 2): { captured_at, captured_by, pip: <row as it stood>, ...extras }
    // The frozen document carries the pip row AS IT STOOD — the revised title DID land.
    const snapDoc = snaps[0].snapshot as Record<string, unknown>;
    expect(snapDoc.snapshot_schema).toBe(2);
    expect(snapDoc.captured_by).toBe("christopher");
    expect(typeof snapDoc.captured_at).toBe("string");
    const frozenPip = snapDoc.pip as Record<string, unknown> | undefined;
    expect(frozenPip).toBeDefined();
    expect((frozenPip as Record<string, unknown>).title).toBe("Q4 booking goal review (revised)");
    expect((frozenPip as Record<string, unknown>).manager_observations).toContain("roster median");

    // issued document is immutable — every document field rejects
    await expect(store.updatePipDraft(draft.id, { title: "nope" })).rejects.toThrow(/draft/i);
    await expect(store.updatePipDraft(draft.id, { goal_text: "nope" })).rejects.toThrow(/draft/i);
    await expect(store.updatePipDraft(draft.id, { pip_start_date: "2026-10-06" })).rejects.toThrow(/draft/i);
    // re-issuing is impossible (no double snapshot)
    await expect(store.issuePip(draft.id, { issuedBy: "christopher" })).rejects.toThrow(/draft/i);
    expect((await store.getPipEvidenceSnapshots(draft.id)).length).toBe(1);

    // ---- PHASE 4: acknowledgment action (store contract) ----
    await expect(store.recordPipAck(bare.id, { ackedBy: "christopher" })).rejects.toThrow(/issued/i);
    const acked = await store.recordPipAck(draft.id, { ackedBy: "christopher" });
    expect(acked.manager_acked_at).not.toBeNull();
    expect(acked.manager_acked_by).toBe("christopher");
    expect(acked.status).toBe("issued"); // stamps ONLY the ack columns
    await expect(store.recordPipAck(draft.id, { ackedBy: "christopher" })).rejects.toThrow(/already/i);
    expect((await store.getPipEvents({ pipId: draft.id })).map((e) => e.event_type)).toContain("pip_ack_recorded");

    // ---- check-ins: issued only ----
    await expect(
      store.addPipCheckin({ pip_id: bare.id, checkin_date: "2026-10-06", current_performance: "too early" }),
    ).rejects.toThrow(/issued/i);
    const checkin = await store.addPipCheckin({
      pip_id: draft.id,
      checkin_date: "2026-10-12",
      manager_name: "christopher",
      current_performance: "Week 1: 9 bookings vs goal 12.",
      manager_notes: "Reviewed pipeline hygiene together.",
      next_checkin_date: "2026-10-19",
    });
    expect(checkin.pip_id).toBe(draft.id);
    expect((await store.getPipCheckins(draft.id))).toHaveLength(1);

    // ---- complete: requires category + notes ----
    await expect(store.completePip(draft.id, { conclusionCategory: "", conclusionNotes: "x", actor: "christopher" })).rejects.toThrow(/conclusion_category/i);
    await expect(store.completePip(draft.id, { conclusionCategory: "Successful", conclusionNotes: "", actor: "christopher" })).rejects.toThrow(/conclusion_notes/i);
    await expect(store.completePip(bare.id, { conclusionCategory: "X", conclusionNotes: "y", actor: "christopher" })).rejects.toThrow(/issued/i);
    const completed = await store.completePip(draft.id, {
      conclusionCategory: "Successful completion",
      conclusionNotes: "Goals met in every week of the review period.",
      actor: "christopher",
    });
    expect(completed.status).toBe("completed");
    expect(completed.completed_at).not.toBeNull();

    // completed → fully immutable
    await expect(store.updatePipDraft(draft.id, { title: "nope" })).rejects.toThrow(/draft/i);
    await expect(store.addPipCheckin({ pip_id: draft.id, checkin_date: "2026-11-10" })).rejects.toThrow(/issued/i);
    await expect(store.cancelPip(draft.id, { cancelledBy: "christopher", reason: "nope" })).rejects.toThrow(/issued/i);

    // ---- cancel path (from issued) ----
    const draft2 = await store.createPip({ rep_id: rep.id, title: "To be cancelled", goal_text: "G", pip_start_date: "2026-10-05", pip_end_date: "2026-11-06" });
    pipIds.push(draft2.id);
    await store.issuePip(draft2.id, { issuedBy: "christopher" });
    await expect(store.cancelPip(draft2.id, { cancelledBy: "christopher", reason: "" })).rejects.toThrow(/cancellation_reason/i);
    const cancelled = await store.cancelPip(draft2.id, { cancelledBy: "christopher", reason: "Rep left the role; plan ended without conclusion." });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellation_reason).toContain("Rep left the role");
    await expect(store.updatePipDraft(draft2.id, { title: "nope" })).rejects.toThrow(/draft/i);

    // ---- list + typed event log + audit mirror ----
    const activeList = await store.listPips("issued");
    expect(activeList.find((p) => p.id === draft.id)).toBeUndefined(); // completed already
    const all = await store.listPips(null);
    expect(all.length).toBeGreaterThanOrEqual(3); // draft + bare + draft2 (core-created ones come later)
    const events = await store.getPipEvents({ pipId: draft.id });
    const types = events.map((e) => e.event_type);
    expect(types).toContain("pip_created");
    expect(types).toContain("pip_edited");
    expect(types).toContain("pip_observation_changed");
    expect(types).toContain("pip_issued");
    expect(types).toContain("pip_checkin_added");
    expect(types).toContain("pip_completed");
    const obsEvent = events.find((e) => e.event_type === "pip_observation_changed");
    expect(obsEvent?.previous_value ?? "").toContain("4 of the last 5 weeks");
    const overrides = await store.getManualOverrides(50);
    expect(overrides.some((o) => o.entity_type === "pip" && o.entity_id === draft.id)).toBe(true);

    // ---- server cores (rep validation + names) ----
    await expect(createPipDraftCore(store, { repId: "does-not-exist", title: "x" })).rejects.toThrow(/rep/i);
    const viaCore = await createPipDraftCore(store, { repId: rep.id, title: "Core-created draft" });
    pipIds.push(viaCore.id);
    const listed = await listPipsCore(store, "draft");
    const listedRow = listed.find((p) => p.id === viaCore.id);
    expect(listedRow?.rep_name).toBe(rep.name);
    // issue through the core seam too (same path the UI uses)
    await updatePipDraftCore(store, { pipId: viaCore.id, goalText: "Core goal", pipStartDate: "2026-10-05", pipEndDate: "2026-11-06" });
    await issuePipCore(store, { pipId: viaCore.id, actor: "christopher" });
    expect((await store.getPip(viaCore.id))?.status).toBe("issued");
    // cancel via core seam
    const viaCore2 = await createPipDraftCore(store, { repId: rep.id, title: "Core cancel", goalText: "g", pipStartDate: "2026-10-05", pipEndDate: "2026-11-06" });
    pipIds.push(viaCore2.id);
    await issuePipCore(store, { pipId: viaCore2.id });
    await cancelPipCore(store, { pipId: viaCore2.id, reason: "core-cancelled" });
    expect((await store.getPip(viaCore2.id))?.status).toBe("cancelled");
    await expect(completePipCore(store, { pipId: viaCore2.id, conclusionCategory: "x", conclusionNotes: "y" })).rejects.toThrow(/issued/i);

    // ---- templates ----
    const tpl = await store.createPipTemplate({
      name: "Booking goal plan",
      category: "Booking goals",
      default_goal_text: "Reach the weekly booking goal every week.",
      default_checkin_cadence_days: 7,
      default_duration_weeks: 4,
      created_by: "christopher",
    });
    templateIds.push(tpl.id);
    expect(tpl.default_checkin_cadence_days).toBe(7);
    const tplUpdated = await store.updatePipTemplate(tpl.id, { name: "Booking goal plan v2", actor: "christopher" });
    expect(tplUpdated.name).toBe("Booking goal plan v2");
    expect((await store.listPipTemplates()).find((t) => t.id === tpl.id)?.name).toBe("Booking goal plan v2");
    await expect(store.createPipTemplate({ name: "" })).rejects.toThrow(/name/i);
    // PHASE 4: in-use counts cover LIVE plans (draft + issued) only.
    const tplDraft = await store.createPip({ rep_id: rep.id, title: "From template", goal_text: "g", template_id: tpl.id, pip_start_date: "2026-10-05", pip_end_date: "2026-11-06" });
    pipIds.push(tplDraft.id);
    expect((await store.getPipTemplateUsage()).get(tpl.id)).toBe(1);
    await store.issuePip(tplDraft.id, { issuedBy: "christopher" });
    expect((await store.getPipTemplateUsage()).get(tpl.id)).toBe(1); // issued still counts
    await store.cancelPip(tplDraft.id, { cancelledBy: "christopher", reason: "closed" });
    expect((await store.getPipTemplateUsage()).get(tpl.id)).toBeUndefined(); // closed plans stop counting
    await store.deletePipTemplate(tpl.id);
    expect(await store.getPipTemplate(tpl.id)).toBeNull();
    const tplEvents = await store.getPipEvents({});
    expect(tplEvents.some((e) => e.event_type === "pip_template_deleted" && e.template_id === tpl.id)).toBe(true);
  } finally {
    if (cleanup) await cleanup(pipIds, templateIds, userIds);
  }
}

describe("PIP store — MemoryStore", () => {
  test("lifecycle, guards, snapshot write-once, check-ins, audit, templates", async () => {
    await runLifecycleBattery(() => new MemoryStore());
  });
});

describe.skipIf(!RESTART)("PIP store — PgStore (real Postgres)", () => {
  test("lifecycle, guards, snapshot write-once, check-ins, audit, templates", async () => {
    const store = new PgStore(RESTART!);
    await store.ensureSchema();
    // MIGRATION IDEMPOTENCY: a second ensureSchema run is a no-op, never a throw.
    await store.ensureSchema();
    await runLifecycleBattery(
      () => store,
      async (pipIds, templateIds, userIds) => {
        // FK-safe cleanup order: events/snapshots/checkins/pip rows, then the
        // dedicated test rep. (Test rows only — the live DB keeps nothing.)
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
      },
    );
  }, 90_000);
});

describe("Store-interface completeness (runtime walk — closes the PR#17 debt)", () => {
  test("every Store member exists as a callable on BOTH store instances", () => {
    expect(STORE_INTERFACE_MEMBERS.length).toBeGreaterThan(100);
    const mem = new MemoryStore() as unknown as Record<string, unknown>;
    for (const name of STORE_INTERFACE_MEMBERS) {
      if (STORE_VALUE_MEMBERS.includes(name)) {
        expect(typeof mem[name]).not.toBe("undefined");
        continue;
      }
      expect(typeof mem[name], `MemoryStore.${name}`).toBe("function");
    }
  });

  test.skipIf(!RESTART)("every Store member exists as a callable on a real PgStore", () => {
    const pg = new PgStore(RESTART!) as unknown as Record<string, unknown>;
    for (const name of STORE_INTERFACE_MEMBERS) {
      if (STORE_VALUE_MEMBERS.includes(name)) {
        expect(typeof pg[name]).not.toBe("undefined");
        continue;
      }
      expect(typeof pg[name], `PgStore.${name}`).toBe("function");
    }
  });
});
