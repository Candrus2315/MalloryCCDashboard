/**
 * RETENTION COMPUTATION CORE tests (stage 3a) — MemoryStore end-to-end.
 * Covers: cohort selection (D6 due dates), the §8 client-mediated attribution
 * through the stage-2 chain, the §9 classification wiring, D8 inbound
 * tracking, roster-INDEPENDENT employee resolution (owner directive
 * 2026-10-20: Laura left the roster — her rows are intact, is_active false),
 * honest unlinked counting, IDEMPOTENCE (re-run writes nothing, rows byte-
 * identical), the ringing → terminal re-observation contract (same row
 * updated, never merged/duplicated), and manual-resolve STICKINESS (the
 * exceptions resolve persists through re-runs and feeds the compute).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { computeRetention } from "../retention/compute";
import { applyInternalClientBackfill } from "../retention/backfill";
import { resetRetentionThrottle, retentionTick } from "../retention/tick";

// Fixed clock: 2026-10-20 ET → cohort = due dates [2026-09-20 .. 2026-10-20];
// a 10/26 session has due date 10/19 — in cohort (the live LVM LR 10/19→10/26 shape).
const NOW = () => new Date("2026-10-20T15:00:00Z");
const APPT_1026 = "2026-10-26T14:00:00Z"; // due 2026-10-19
const APPT_1024 = "2026-10-24T14:00:00Z"; // due 2026-10-17
const APPT_1018 = "2026-10-18T14:00:00Z"; // due 2026-10-11
const CALL_1019 = "2026-10-19T15:00:00Z"; // inside [appt−7d, appt) of both A1 and A2
const CALL_1020 = "2026-10-20T16:00:00Z"; // inside A1's window

interface Seed {
  store: MemoryStore;
  lauraId: string;
  contactIds: Record<string, string>;
  apptIds: Record<string, string>;
  clientIds: Record<string, string>;
}

async function seed(): Promise<Seed> {
  const store = new MemoryStore();
  // Laura LEFT the roster 10/20 (owner) — her users row is intact, is_active false.
  await store.upsertUsers([
    { id: "", provider: "highlevel", external_id: "LAU", name: "Laura Rivera", email: "laura@mallory.test", is_active: false, call_start_date: null },
  ] as never);
  const users = await store.getAllUsers();
  const lauraId = users.find((u) => u.external_id === "LAU")!.id;

  await store.upsertContacts([
    { id: "", provider: "highlevel", external_id: "CT1", name: "Jane Doe", phone: "(603) 555-1212", email: "jane@example.com", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT2", name: "Bob Roe", phone: "2125550101", email: "bob@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
  ] as never);
  const contacts = await store.getContacts();
  const contactIds: Record<string, string> = {};
  for (const c of contacts) contactIds[c.external_id!] = c.id;

  const appt = (acuityId: string, contactId: string | null, datetime: string, notes: string | null, calName = "MALLORY PORTRAITS") => ({
    id: "",
    acuity_appointment_id: acuityId,
    contact_id: contactId,
    calendar_id: "1335091",
    calendar_name: calName,
    appointment_type: "Portrait Session",
    appointment_datetime: datetime,
    created_at: "2026-10-16T18:00:00Z",
    status: "scheduled",
    cancelled: false,
    raw: notes == null ? null : { notes },
  });
  await store.upsertAppointments([
    appt("A1", contactIds.CT1!, APPT_1026, "LVM LR 10/19/26\nPaid with invoice 2324"),
    appt("A2", contactIds.CT2!, APPT_1024, "SWC LR 10/19/26 intake done"),
    appt("A3", null, APPT_1018, null), // no resolved contact → no client link (unlinked)
  ] as never);
  const appts = await store.getAppointmentsWithClientsSince("2026-09-01T00:00:00Z");
  const apptIds: Record<string, string> = {};
  for (const a of appts) apptIds[a.acuity_appointment_id!] = a.id;

  // Stage-2 chain links: CT1/A1 → client Jane; CT2/A2 → client Bob; A3 unlinked.
  const jane = await store.insertInternalClient({ seedKey: "hl-contact:CT1", displayName: "Jane Doe", normalizedPhone: "6035551212", normalizedEmail: "jane@example.com", ghlContactExternalId: "CT1" });
  const bob = await store.insertInternalClient({ seedKey: "hl-contact:CT2", displayName: "Bob Roe", normalizedPhone: "2125550101", normalizedEmail: "bob@other.org", ghlContactExternalId: "CT2" });
  for (const [client, ext] of [[jane, "CT1"], [bob, "CT2"]] as const) {
    await store.insertClientMatchLinkIfAbsent({ internalClientId: client.id, provider: "highlevel", entity: "contact", externalId: ext, matchMethod: "exact_id", confidence: "exact" });
  }
  await store.insertClientMatchLinkIfAbsent({ internalClientId: jane.id, provider: "acuity", entity: "appointment", externalId: "A1", matchMethod: "exact_id", confidence: "exact" });
  await store.insertClientMatchLinkIfAbsent({ internalClientId: bob.id, provider: "acuity", entity: "appointment", externalId: "A2", matchMethod: "exact_id", confidence: "exact" });

  const call = (externalId: string, o: { direction: string; status: string; duration: number; contactId: string | null; repId?: string | null }) => ({
    provider: "highlevel",
    external_call_id: externalId,
    rep_id: o.repId ?? null,
    contact_id: o.contactId,
    started_at: externalId === "MSG2" ? CALL_1020 : CALL_1019,
    duration_seconds: o.duration,
    over_two_minutes: o.duration > 120,
    direction: o.direction,
    call_status: o.status,
    provider_rep_external_id: o.repId === lauraId ? "LAU" : null,
  });
  await store.upsertCalls([
    call("MSG1", { direction: "outbound", status: "voicemail", duration: 47, contactId: contactIds.CT1!, repId: lauraId }),
    call("MSG2", { direction: "inbound", status: "completed", duration: 30, contactId: contactIds.CT1!, repId: lauraId }), // D8 inbound
    call("MSG3", { direction: "outbound", status: "no-answer", duration: 0, contactId: contactIds.CT2!, repId: lauraId }),
    call("MSG4", { direction: "outbound", status: "failed", duration: 0, contactId: null }), // null contact → no client
  ] as never);

  return { store, lauraId, contactIds, apptIds, clientIds: { jane: jane.id, bob: bob.id } };
}

const stripIds = (rows: unknown[]) => JSON.parse(JSON.stringify(rows)) as unknown[];

describe("computeRetention — cohort, classification, idempotence", () => {
  test("run 1 classifies the cohort; run 2 is byte-identical and writes nothing", async () => {
    const s = await seed();
    const r1 = await computeRetention(s.store, { now: NOW });
    expect(r1.outcome).toBe("synced");
    expect(r1.appointmentsEvaluated).toBe(2); // A1 + A2 (A3 unlinked, counted honestly)
    expect(r1.unlinkedAppointments).toBe(1);
    expect(r1.unlinkedAcuityIds).toEqual(["A3"]);
    // MSG1: outbound voicemail 47s in A1's window → voicemail attempt (LVM note consistent).
    expect(r1.attemptsInserted).toBe(2); // MSG1 → A1; MSG3 → A2 (MSG2 inbound, MSG4 no client)
    expect(r1.inboundInWindowCalls).toBe(1); // MSG2 tracked, never an attempt
    expect(r1.callsWithoutClient).toBe(1); // MSG4 (null contact) — never silent
    expect(r1.finalStatusCounts).toEqual({ verified_spoke_with: 0, voicemail: 1, no_answer: 0, attempted_unclear: 0, needs_review: 1 });
    // A1: LVM note + voicemail call → consistent voicemail.
    expect(r1.attemptClassCounts).toMatchObject({ voicemail: 1, no_answer: 1 });

    const attempts1 = await s.store.listRetentionAttempts();
    const outcomes1 = await s.store.listRetentionAppointmentOutcomes();
    const r2 = await computeRetention(s.store, { now: NOW });
    expect(r2.attemptsInserted).toBe(0);
    expect(r2.attemptsUpdated).toBe(0);
    expect(r2.attemptsUnchanged).toBe(2);
    expect(r2.outcomesInserted).toBe(0);
    expect(r2.outcomesUpdated).toBe(0);
    expect(r2.outcomesUnchanged).toBe(2);
    expect(stripIds(await s.store.listRetentionAttempts())).toEqual(stripIds(attempts1));
    expect(stripIds(await s.store.listRetentionAppointmentOutcomes())).toEqual(stripIds(outcomes1));
  });

  test("attempt rows carry the full audit snapshot (employee roster-independent, D8 evidence, transcript null)", async () => {
    const s = await seed();
    await computeRetention(s.store, { now: NOW });
    const attempts = await s.store.listRetentionAttempts();
    const msg1 = attempts.find((a) => a.external_message_id === "MSG1")!;
    expect(msg1).toBeTruthy();
    expect(msg1.attempt_class).toBe("voicemail");
    expect(msg1.appointment_id).toBe(s.apptIds.A1!);
    expect(msg1.employee_user_id).toBe(s.lauraId); // roster-INDEPENDENT (is_active false)
    expect(msg1.employee_external_id).toBe("LAU");
    expect(msg1.evidence.transcript_available).toBe(null);
    expect(msg1.evidence.employee_basis).toContain("roster-independent");
    expect(msg1.evidence.d8_rule).toContain("inbound tracked but never an attempt");
    expect((msg1.evidence.attributed_to as Record<string, unknown>).acuity_appointment_id).toBe("A1");
    expect((msg1.evidence.window_candidates as unknown[]).length).toBe(1);
  });

  test("outcomes carry the note evidence + aggregation basis (auditability per owner spec §17)", async () => {
    const s = await seed();
    await computeRetention(s.store, { now: NOW });
    const outcomes = await s.store.listRetentionAppointmentOutcomes();
    const a1 = outcomes.find((o) => o.appointment_id === s.apptIds.A1!)!;
    expect(a1.final_status).toBe("voicemail");
    expect(a1.attempts_count).toBe(1);
    expect(a1.any_answered).toBe(false);
    expect(a1.contact_due_date).toBe("2026-10-19");
    expect(a1.eligible).toBe(true);
    expect((a1.evidence.inbound_in_window as { count: number }).count).toBe(1); // D8 tracked
    expect((a1.evidence.note_evidence as { voicemailMarkers: unknown[] }).voicemailMarkers).toHaveLength(1);
    expect((a1.evidence.aggregation as { basis: string[] }).basis.join(" ")).toContain("LVM");
    expect(a1.evidence.transcript_availability).toBe(null);
    // A2: SWC note + no-answer call → Needs Review (D5).
    const a2 = outcomes.find((o) => o.appointment_id === s.apptIds.A2!)!;
    expect(a2.final_status).toBe("needs_review");
    expect(a2.needs_review_reason).toContain("SWC");
    expect(a2.attempts_count).toBe(1);
  });

  test("zero-attempt appointment → attempted_unclear with the honest no-attempts basis", async () => {
    const s = await seed();
    // A3 is unlinked so it never gets an outcome row — give CT2's client a
    // second appointment with no calls to exercise the zero-attempt path.
    await s.store.upsertAppointments([
      {
        id: "",
        acuity_appointment_id: "A5",
        contact_id: s.contactIds.CT2!,
        calendar_id: "1335091",
        calendar_name: "MALLORY PORTRAITS",
        appointment_type: "Portrait Session",
        appointment_datetime: APPT_1018,
        created_at: "2026-10-10T18:00:00Z",
        status: "scheduled",
        cancelled: false,
        raw: { notes: "Paid with invoice 99" },
      },
    ] as never);
    await s.store.insertClientMatchLinkIfAbsent({ internalClientId: s.clientIds.bob!, provider: "acuity", entity: "appointment", externalId: "A5", matchMethod: "exact_id", confidence: "exact" });
    const r = await computeRetention(s.store, { now: NOW });
    expect(r.appointmentsEvaluated).toBe(3);
    const outcomes = await s.store.listRetentionAppointmentOutcomes();
    const allAppts = await s.store.getAppointmentsWithClientsSince("2026-09-01T00:00:00Z");
    const a5Id = allAppts.find((x) => x.acuity_appointment_id === "A5")!.id;
    const a5 = outcomes.find((o) => o.appointment_id === a5Id)!;
    expect(a5.final_status).toBe("attempted_unclear");
    expect(a5.attempts_count).toBe(0);
    expect((a5.evidence.aggregation as { basis: string[] }).basis[0]).toContain("no outbound attempts recorded");
  });

  test("ringing → terminal re-observation updates the SAME attempt row (§9 rule 7; never duplicated/merged)", async () => {
    const s = await seed();
    // Swap MSG1 to a transient ringing observation first (same external id).
    await s.store.upsertCalls([
      { provider: "highlevel", external_call_id: "MSG1", rep_id: s.lauraId, contact_id: s.contactIds.CT1!, started_at: CALL_1019, duration_seconds: 0, over_two_minutes: false, direction: "outbound", call_status: "ringing", provider_rep_external_id: "LAU" },
    ] as never);
    const r1 = await computeRetention(s.store, { now: NOW });
    const attempts1 = await s.store.listRetentionAttempts();
    const ringing = attempts1.find((a) => a.external_message_id === "MSG1")!;
    expect(ringing.attempt_class).toBe("transient");
    expect(ringing.call_status).toBe("ringing");
    // A1 ringing-only + LVM note → note conflict (needs_review); A2 SWC + no-answer → needs_review.
    expect(r1.finalStatusCounts.needs_review).toBe(2);
    expect(r1.finalStatusCounts.attempted_unclear).toBe(0);
    // Now GHL advances the same call to a terminal completed+45s observation.
    await s.store.upsertCalls([
      { provider: "highlevel", external_call_id: "MSG1", rep_id: s.lauraId, contact_id: s.contactIds.CT1!, started_at: CALL_1019, duration_seconds: 45, over_two_minutes: false, direction: "outbound", call_status: "completed", provider_rep_external_id: "LAU" },
    ] as never);
    const r2 = await computeRetention(s.store, { now: NOW });
    expect(r2.attemptsInserted).toBe(0); // no NEW row — the same call re-observed
    expect(r2.attemptsUpdated).toBe(1);
    const attempts2 = await s.store.listRetentionAttempts();
    expect(attempts2.find((a) => a.external_message_id === "MSG1")!.id).toBe(ringing.id); // SAME row
    expect(attempts2.find((a) => a.external_message_id === "MSG1")!.attempt_class).toBe("answered");
    const outcomes2 = await s.store.listRetentionAppointmentOutcomes();
    const a1 = outcomes2.find((o) => o.appointment_id === s.apptIds.A1!)!;
    expect(a1.final_status).toBe("needs_review"); // LVM note now conflicts (no voicemail call anymore) — honest escalation
    expect(a1.needs_review_reason).toContain("LVM");
  });

  test("D8: inbound in-window call is tracked in evidence but never becomes an attempt", async () => {
    const s = await seed();
    await computeRetention(s.store, { now: NOW });
    const attempts = await s.store.listRetentionAttempts();
    expect(attempts.find((a) => a.external_message_id === "MSG2")).toBeUndefined();
    const outcomes = await s.store.listRetentionAppointmentOutcomes();
    const a1 = outcomes.find((o) => o.appointment_id === s.apptIds.A1!)!;
    const inbound = a1.evidence.inbound_in_window as { count: number; call_ids: string[] };
    expect(inbound.count).toBe(1);
    expect(inbound.call_ids).toEqual(["MSG2"]);
  });

  test("null-contact call never becomes an attempt and is counted honestly (callsWithoutClient)", async () => {
    const s = await seed();
    const r = await computeRetention(s.store, { now: NOW });
    expect(r.callsWithoutClient).toBe(1);
    const attempts = await s.store.listRetentionAttempts();
    expect(attempts.find((a) => a.external_message_id === "MSG4")).toBeUndefined();
  });

  test("manual-resolve STICKINESS: exception resolved to a client persists through backfill re-runs and feeds the compute", async () => {
    const s = await seed();
    // A3 (name-only, unresolved contact) → exception via the stage-2 backfill.
    const r1 = await applyInternalClientBackfill(s.store, {
      appointments: [{ acuityAppointmentId: "A3", status: "scheduled", clientName: "Mystery Person", clientPhone: null, clientEmail: null, contactExternalId: null }],
      contacts: [],
      callsWithoutClient: [],
    });
    expect(r1.exceptionsCreated).toBe(1);
    const exceptions1 = await s.store.getDataMatchExceptions({ status: "open" });
    expect(exceptions1).toHaveLength(1);
    // Management resolves: A3 is Jane Doe (sticky manual link).
    await s.store.resolveDataMatchException(exceptions1[0]!.id, { internalClientId: s.clientIds.jane!, resolvedBy: "christopher" });
    // Backfill re-run: the manual resolve is NEVER re-matched.
    const r2 = await applyInternalClientBackfill(s.store, {
      appointments: [{ acuityAppointmentId: "A3", status: "scheduled", clientName: "Mystery Person", clientPhone: null, clientEmail: null, contactExternalId: null }],
      contacts: [],
      callsWithoutClient: [],
    });
    expect(r2.exceptionsCreated).toBe(0);
    const excAfter = (await s.store.getDataMatchExceptions()).find((e) => e.id === exceptions1[0]!.id)!;
    expect(excAfter.status).toBe("resolved");
    const link = await s.store.getClientMatchLink("acuity", "appointment", "A3");
    expect(link!.match_method).toBe("manual");
    expect(link!.resolved_by).toBe("manual:christopher");
    expect(link!.internal_client_id).toBe(s.clientIds.jane!);
    // Audit trail exists (manual_overrides).
    const overrides = await s.store.getManualOverrides(50);
    expect(overrides.some((o) => o.entity_type === "data_match_exception" && o.entity_id === exceptions1[0]!.id && o.changed_by.includes("christopher"))).toBe(true);
    // The compute honors the manual link: A3 now joins the cohort as Jane's.
    const r3 = await computeRetention(s.store, { now: NOW });
    expect(r3.unlinkedAppointments).toBe(0);
    expect(r3.appointmentsEvaluated).toBe(3);
    const outcomes = await s.store.listRetentionAppointmentOutcomes();
    const a3 = outcomes.find((o) => o.appointment_id === s.apptIds.A3!)!;
    expect(a3.internal_client_id).toBe(s.clientIds.jane!);
    expect(a3.final_status).toBe("attempted_unclear"); // zero attempts, no notes
  });

  test("re-resolving a closed exception is refused (write-once)", async () => {
    const s = await seed();
    await applyInternalClientBackfill(s.store, {
      appointments: [{ acuityAppointmentId: "A3", status: "scheduled", clientName: "Mystery Person", clientPhone: null, clientEmail: null, contactExternalId: null }],
      contacts: [],
      callsWithoutClient: [],
    });
    const open = (await s.store.getDataMatchExceptions({ status: "open" }))[0]!;
    await s.store.dismissDataMatchException(open.id, { resolvedBy: "christopher" });
    const dismissed = (await s.store.getDataMatchExceptions()).find((e) => e.id === open.id)!;
    expect(dismissed.status).toBe("dismissed");
    await expect(s.store.resolveDataMatchException(open.id, { internalClientId: s.clientIds.jane!, resolvedBy: "christopher" })).rejects.toThrow();
  });
});

describe("retentionTick — scheduler contract", () => {
  test("runs the compute, records its own sync_runs row, throttles background re-runs, never throws", async () => {
    const s = await seed();
    resetRetentionThrottle(); // module-global throttle: other files' ticks must not leak into this test
    const t1 = await retentionTick({ store: s.store, now: NOW, trigger: "manual" });
    expect(t1.outcome).toBe("synced");
    const runs = await s.store.getSyncRuns(10);
    const mine = runs.filter((r) => r.provider === "retention");
    expect(mine.length).toBe(1);
    expect(mine[0]!.status).toBe("success");
    resetRetentionThrottle(); // manual t1 stamped nothing; a clean background start
    const t2 = await retentionTick({ store: s.store, now: NOW, trigger: "background" });
    expect(t2.outcome).toBe("synced"); // first background run after the reset executes
    const t3 = await retentionTick({ store: s.store, now: NOW, trigger: "background" });
    expect(t3.outcome).toBe("skipped");
    expect((t3 as { reason: string }).reason).toBe("recent-tick");
  });

  test("failure is recorded fail-honest on the sync_runs row and returned, never thrown", async () => {
    const s = await seed();
    // A store whose listRetentionAttempts explodes → error outcome, recorded run.
    const bad = new Proxy(s.store, {
      get(target, prop, recv) {
        if (prop === "listRetentionAttempts") return async () => {
          throw new Error("simulated db outage");
        };
        return Reflect.get(target, prop, recv);
      },
    });
    const res = await retentionTick({ store: bad as never, now: NOW, trigger: "manual" });
    expect(res.outcome).toBe("error");
    expect((res as { error: string }).error).toContain("simulated db outage");
    const runs = await s.store.getSyncRuns(10);
    const mine = runs.filter((r) => r.provider === "retention");
    expect(mine[0]!.status).toBe("error");
    expect(mine[0]!.error).toContain("simulated db outage");
  });
});
