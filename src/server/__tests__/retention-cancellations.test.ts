/**
 * RETENTION CANCELLATIONS ENGINE tests (stage 4a, deliverable 5) — the engine
 * that shipped in 6b9c72d (+ the 084106e totality fix), now under test.
 *
 * COVERAGE:
 *   - deriveCancellationOutcome TOTALITY: every input shape returns a
 *     derivation (never throws) — including the ?? [] defensive path over a
 *     MISSING candidates list (084106e) and unparseable session instants;
 *   - IDEMPOTENT re-runs of computeRetentionCancellations over a MemoryStore:
 *     same inputs → same rows, zero writes (unchanged counted honestly); a
 *     genuine content change updates exactly that row;
 *   - the MUSCLE-SAVE rule, STRICTLY: outcome saved_original requires an
 *     ACTUAL successor appointment row re-booked at the cancelled session's
 *     exact instant — an answered call, a heuristic, or "the client is still
 *     booked somewhere" never manufactures a save; successor ids and
 *     recovered_at always trace to a real appointment record;
 *   - honest counts: unlinked cancellations and missing cancelled_at stamps
 *     are counted, never written; manual overrides are never recomputed over.
 *
 * WIRING (items 1–3) and SCORECARD-FILL ISOLATION (item 4) live in
 * retention-ui.test.ts / retention-queue.test.ts / retention-scorecard.test.ts
 * — all consuming the same §16 inCancellationUniverse source of truth.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { computeRetentionCancellations, deriveCancellationOutcome, RETENTION_CANCELLATIONS_VERSION, CANCELLATION_OUTCOMES } from "../retention/cancellations";

// Fixed clock: 2026-10-20 ET → lookback floor 09-20; default reschedule window = 14 days.
const NOW = () => new Date("2026-10-20T15:00:00Z");
const SESSION_MS = Date.parse("2026-10-10T14:00:00Z");

const candidate = (id: string, createdAtIso: string, sessionIso: string) => ({
  appointmentId: `row-${id}`,
  acuityAppointmentId: id,
  appointmentDatetimeIso: sessionIso,
  createdAtIso,
  appointmentType: "Portrait Session",
});

describe("deriveCancellationOutcome — totality (never throws, always a derivation)", () => {
  const base = { cancelledAtMs: Date.parse("2026-10-11T15:00:00Z"), rescheduleDays: 14, nowMs: Date.parse("2026-10-20T15:00:00Z"), attemptsCount: 0, anyAnswered: false };

  test("a candidate re-booked at the cancelled session's exact instant → saved_original (the original appointment, kept)", () => {
    const d = deriveCancellationOutcome({ ...base, cancelledSessionMs: SESSION_MS, candidates: [candidate("S1", "2026-10-12T10:00:00Z", "2026-10-10T14:00:00Z")] });
    expect(d.outcome).toBe("saved_original");
    expect(d.successorAppointmentId).toBe("row-S1");
    expect(d.recovered).toBe(true);
    expect(d.recoveredAtIso).toBe("2026-10-12T10:00:00Z"); // the moment the recovery landed (the successor's own record)
    expect(d.candidates).toHaveLength(1);
  });

  test("a different-slot rebooking → rescheduled; earliest created_at wins (acuity id tiebreak)", () => {
    const d = deriveCancellationOutcome({
      ...base,
      cancelledSessionMs: SESSION_MS,
      candidates: [
        candidate("S9", "2026-10-13T10:00:00Z", "2026-10-25T14:00:00Z"),
        candidate("S2", "2026-10-12T10:00:00Z", "2026-10-20T14:00:00Z"),
        candidate("S2", "2026-10-12T10:00:00Z", "2026-10-22T14:00:00Z"), // same created_at → acuity id tiebreak is deterministic
      ],
    });
    expect(d.outcome).toBe("rescheduled");
    expect(d.recovered).toBe(true);
    expect(d.successorAppointmentId).toBe("row-S2"); // earliest of the equal-instant pair, not the later S9
  });

  test("same-slot wins over an EARLIER different-slot candidate (the save is the original appointment, kept)", () => {
    const d = deriveCancellationOutcome({
      ...base,
      cancelledSessionMs: SESSION_MS,
      candidates: [candidate("EARLY", "2026-10-12T08:00:00Z", "2026-10-18T14:00:00Z"), candidate("SAME", "2026-10-13T10:00:00Z", "2026-10-10T14:00:00Z")],
    });
    expect(d.outcome).toBe("saved_original");
    expect(d.successorAppointmentId).toBe("row-SAME");
  });

  test("no candidates, save window still open → pending (the actionable queue)", () => {
    const d = deriveCancellationOutcome({ ...base, cancelledSessionMs: SESSION_MS, candidates: [] });
    expect(d.outcome).toBe("pending");
    expect(d.recovered).toBe(false);
    expect(d.successorAppointmentId).toBeNull();
  });

  test("no candidates, window elapsed, attempts but none answered → unable_to_reach", () => {
    const d = deriveCancellationOutcome({ ...base, nowMs: base.cancelledAtMs + 14 * 24 * 3_600_000 + 1, attemptsCount: 2, anyAnswered: false, cancelledSessionMs: SESSION_MS, candidates: [] });
    expect(d.outcome).toBe("unable_to_reach");
  });

  test("no candidates, window elapsed, otherwise → confirmed_cancellation", () => {
    const d = deriveCancellationOutcome({ ...base, cancelledSessionMs: SESSION_MS, candidates: [] });
    const elapsed = { ...base, nowMs: base.cancelledAtMs + 14 * 24 * 3_600_000 + 1 };
    expect(deriveCancellationOutcome({ ...elapsed, cancelledSessionMs: SESSION_MS, candidates: [] }).outcome).toBe("confirmed_cancellation");
    expect(d.outcome).toBe("pending"); // sanity: same instant had NOT elapsed yet
  });

  test("MUSCLE RULE (derivation level): an ANSWERED call with no successor is still never a save", () => {
    const d = deriveCancellationOutcome({ ...base, nowMs: base.cancelledAtMs + 14 * 24 * 3_600_000 + 1, attemptsCount: 3, anyAnswered: true, cancelledSessionMs: SESSION_MS, candidates: [] });
    expect(d.outcome).toBe("confirmed_cancellation");
    expect(d.successorAppointmentId).toBeNull();
    expect(d.recovered).toBe(false);
  });

  test("084106e: a MISSING candidates list is total (defensive ?? []) — pending while the window is open", () => {
    const d = deriveCancellationOutcome({ ...base, cancelledSessionMs: SESSION_MS, candidates: undefined as unknown as [] });
    expect(d.outcome).toBe("pending");
    expect(d.candidates).toEqual([]);
  });

  test("084106e: a MISSING candidates list is total — elapsed window → confirmed, never a throw", () => {
    const d = deriveCancellationOutcome({ ...base, nowMs: base.cancelledAtMs + 14 * 24 * 3_600_000 + 1, cancelledSessionMs: SESSION_MS, candidates: undefined as unknown as [] });
    expect(d.outcome).toBe("confirmed_cancellation");
  });

  test("a null session instant cannot classify a save — candidates → rescheduled (earliest)", () => {
    const d = deriveCancellationOutcome({ ...base, cancelledSessionMs: null, candidates: [candidate("S1", "2026-10-12T10:00:00Z", "2026-10-10T14:00:00Z")] });
    expect(d.outcome).toBe("rescheduled"); // no same-slot proof possible without the cancelled session's own instant
  });

  test("an unparseable candidate datetime is never a same-slot match (no invented instants)", () => {
    const d = deriveCancellationOutcome({
      ...base,
      cancelledSessionMs: SESSION_MS,
      candidates: [candidate("BAD", "2026-10-12T10:00:00Z", "not-a-date"), candidate("OK", "2026-10-13T10:00:00Z", "2026-10-10T14:00:00Z")],
    });
    expect(d.outcome).toBe("saved_original"); // OK re-booked the exact instant
    expect(d.successorAppointmentId).toBe("row-OK");
  });

  test("the window edge: windowEnd <= now is elapsed; a millisecond before is still pending", () => {
    const end = base.cancelledAtMs + 14 * 24 * 3_600_000;
    expect(deriveCancellationOutcome({ ...base, nowMs: end, cancelledSessionMs: null, candidates: [] }).outcome).toBe("confirmed_cancellation");
    expect(deriveCancellationOutcome({ ...base, nowMs: end - 1, cancelledSessionMs: null, candidates: [] }).outcome).toBe("pending");
  });

  test("the outcome vocabulary is closed (plan §11)", () => {
    expect(CANCELLATION_OUTCOMES).toEqual(["saved_original", "rescheduled", "confirmed_cancellation", "unable_to_reach", "pending", "transferred", "other"]);
  });
});

// ---- computeRetentionCancellations end-to-end (MemoryStore) ----

interface Seed {
  store: MemoryStore;
  clientIds: Record<string, string>;
  apptIds: Record<string, string>;
}

async function seed(): Promise<Seed> {
  const store = new MemoryStore();
  await store.upsertContacts(
    ["CT1", "CT2", "CT3", "CT4", "CT5", "CT6", "CT7", "CT8"].map((ext, i) => ({
      id: "",
      provider: "highlevel",
      external_id: ext,
      name: `Client ${i + 1}`,
      phone: `91755501${String(i).padStart(2, "0")}`,
      email: `${ext.toLowerCase()}@example.com`,
      assigned_rep_id: null,
      created_at: NOW().toISOString(),
    })) as never,
  );
  const contacts = await store.getContacts();
  const contactIds: Record<string, string> = {};
  for (const c of contacts) contactIds[c.external_id!] = c.id;

  const appt = (acuityId: string, contactId: string | null, datetime: string, createdAt: string, o: { cancelled?: boolean; cancelledAt?: string | null } = {}) => ({
    id: "",
    acuity_appointment_id: acuityId,
    contact_id: contactId,
    calendar_id: "1335091",
    calendar_name: "MALLORY PORTRAITS",
    appointment_type: "Portrait Session",
    appointment_datetime: datetime,
    created_at: createdAt,
    status: "scheduled",
    cancelled: o.cancelled ?? false,
    cancelled_at: o.cancelledAt ?? null,
    raw: null,
  });
  await store.upsertAppointments([
    // CT1 — cancelled, then re-took THEIR ORIGINAL SLOT (a real save).
    appt("AC1", contactIds.CT1!, "2026-10-10T14:00:00Z", "2026-10-01T10:00:00Z", { cancelled: true, cancelledAt: "2026-10-11T15:00:00Z" }),
    appt("AS1", contactIds.CT1!, "2026-10-10T14:00:00Z", "2026-10-12T10:00:00Z"), // same instant, created after the cancellation
    // CT2 — cancelled, window elapsed, one unanswered attempt → unable_to_reach.
    appt("AC2", contactIds.CT2!, "2026-10-05T14:00:00Z", "2026-09-28T10:00:00Z", { cancelled: true, cancelledAt: "2026-10-01T15:00:00Z" }),
    // CT3 — cancelled, then rebooked a DIFFERENT slot → rescheduled.
    appt("AC3", contactIds.CT3!, "2026-10-06T14:00:00Z", "2026-09-29T10:00:00Z", { cancelled: true, cancelledAt: "2026-10-02T15:00:00Z" }),
    appt("AS3", contactIds.CT3!, "2026-10-20T14:00:00Z", "2026-10-05T10:00:00Z"),
    // CT4 — cancelled, window elapsed, ANSWERED attempt, no successor → confirmed (never a heuristic save).
    appt("AC4", contactIds.CT4!, "2026-10-07T14:00:00Z", "2026-09-30T10:00:00Z", { cancelled: true, cancelledAt: "2026-10-03T15:00:00Z" }),
    // CT5 — cancelled with NO cancelled_at stamp → no place on the timeline.
    appt("AC5", contactIds.CT5!, "2026-10-08T14:00:00Z", "2026-10-01T10:00:00Z", { cancelled: true }),
    // CT6 — cancelled in scope but never identity-linked → honest unlinked count.
    appt("AC6", null, "2026-10-09T14:00:00Z", "2026-10-02T10:00:00Z", { cancelled: true, cancelledAt: "2026-10-08T15:00:00Z" }),
    // CT7 — cancelled; a manual override row exists → the writer must skip it.
    appt("AC7", contactIds.CT7!, "2026-10-04T14:00:00Z", "2026-09-27T10:00:00Z", { cancelled: true, cancelledAt: "2026-10-04T15:00:00Z" }),
    // CT8 — cancelled YESTERDAY, save window wide open, no successor → pending (Active Cancellations).
    appt("AC8", contactIds.CT8!, "2026-10-26T14:00:00Z", "2026-10-15T10:00:00Z", { cancelled: true, cancelledAt: "2026-10-19T15:00:00Z" }),
  ] as never);
  const appts = await store.getAppointmentsWithClientsSince("2026-09-01T00:00:00Z");
  const apptIds: Record<string, string> = {};
  for (const a of appts) apptIds[a.acuity_appointment_id!] = a.id;

  const clientIds: Record<string, string> = {};
  for (const ext of ["CT1", "CT2", "CT3", "CT4", "CT5", "CT7", "CT8"]) {
    const c = await store.insertInternalClient({ seedKey: `hl-contact:${ext}`, displayName: ext, normalizedPhone: "9175550100", normalizedEmail: `${ext.toLowerCase()}@example.com`, ghlContactExternalId: ext });
    clientIds[ext] = c.id;
    await store.insertClientMatchLinkIfAbsent({ internalClientId: c.id, provider: "highlevel", entity: "contact", externalId: ext, matchMethod: "exact_id", confidence: "exact" });
  }
  // acuity:appointment links — AC6 deliberately LEFT OUT (the unlinked case).
  for (const [ext, apptExt] of [["CT1", "AC1"], ["CT1", "AS1"], ["CT2", "AC2"], ["CT3", "AC3"], ["CT3", "AS3"], ["CT4", "AC4"], ["CT5", "AC5"], ["CT7", "AC7"], ["CT8", "AC8"]] as const) {
    await store.insertClientMatchLinkIfAbsent({ internalClientId: clientIds[ext]!, provider: "acuity", entity: "appointment", externalId: apptExt, matchMethod: "exact_id", confidence: "exact" });
  }

  // CT2: one UNANSWERED attempt (→ unable_to_reach once the window elapses).
  await store.insertRetentionAttempts([
    {
      internalClientId: clientIds.CT2!,
      appointmentId: apptIds.AC2!,
      callId: null,
      source: "test",
      externalMessageId: "MSG-T2",
      employeeUserId: null,
      employeeExternalId: null,
      attemptAtIso: "2026-10-03T14:00:00Z",
      callStatus: "no-answer",
      durationSeconds: 0,
      direction: "outbound",
      attemptClass: "unanswered",
      evidence: {},
      attribution: "test",
    },
  ]);
  // CT4: one ANSWERED attempt — and still NO successor anywhere (the muscle rule).
  await store.insertRetentionAttempts([
    {
      internalClientId: clientIds.CT4!,
      appointmentId: apptIds.AC4!,
      callId: null,
      source: "test",
      externalMessageId: "MSG-T4",
      employeeUserId: null,
      employeeExternalId: null,
      attemptAtIso: "2026-10-05T14:00:00Z",
      callStatus: "completed",
      durationSeconds: 300,
      direction: "outbound",
      attemptClass: "answered",
      evidence: {},
      attribution: "test",
    },
  ]);

  // CT7: a manual override row — management spoke; the automatic writer must never recompute over it.
  // (MemoryStore inserts build rows from the typed write only, so the override
  // is stamped through the store's own map — there is no management-write API
  // yet; the override stage ships later.)
  await store.insertRetentionCancellations([
    {
      appointmentId: apptIds.AC7!,
      internalClientId: clientIds.CT7!,
      ghlContactExternalId: "CT7",
      cancelledAtIso: "2026-10-04T15:00:00Z",
      attemptsCount: 0,
      anyAnswered: false,
      finalContactStatus: null,
      outcome: "other",
      successorAppointmentId: null,
      recovered: false,
      recoveredAtIso: null,
      notes: { override_reason: "management decision (test)" },
    },
  ]);
  const cancellationsMap = (store as unknown as { retentionCancellations: Map<string, { manual_overrides: Record<string, unknown> | null }> }).retentionCancellations;
  const overrideRow = cancellationsMap.get(apptIds.AC7!)!;
  overrideRow.manual_overrides = { outcome: "other" };

  return { store, clientIds, apptIds };
}

describe("computeRetentionCancellations — idempotent diff-writes over real appointments", () => {
  test("first run classifies every scenario; unlinked/missing-stamp counted honestly; override skipped", async () => {
    const s = await seed();
    const res = await computeRetentionCancellations(s.store, { now: NOW });
    expect(res.outcome).toBe("synced");
    expect(res.cancellationsEvaluated).toBe(6); // C1..C4, C7 (override), C8 — AC5 has no stamp, AC6 is unlinked
    expect(res.unlinkedCancellations).toBe(1);
    expect(res.missingCancelledAt).toBe(1);
    expect(res.skippedOverrides).toBe(1); // CT7's management row is never recomputed over
    expect(res.inserted).toBe(5); // C1, C2, C3, C4, C8 (C7 skipped)
    expect(res.updated).toBe(0);
    expect(res.outcomeCounts).toEqual({ saved_original: 1, unable_to_reach: 1, rescheduled: 1, confirmed_cancellation: 1, pending: 1 });
    expect(res.rescheduleDays).toBe(14);

    const rows = await s.store.listRetentionCancellations();
    expect(rows.length).toBe(6); // 5 written + 1 pre-existing override row
    const byAppt = Object.fromEntries(rows.map((r) => [r.appointment_id, r]));

    // MUSCLE-SAVE: the save traces to the ACTUAL rebooked appointment record.
    const save = byAppt[s.apptIds.AC1!]!;
    expect(save.outcome).toBe("saved_original");
    expect(save.successor_appointment_id).toBe(s.apptIds.AS1!); // a real appointment row id
    expect(save.recovered).toBe(true);
    expect(save.recovered_at).toBe("2026-10-12T10:00:00Z"); // the successor's created_at — when the recovery landed
    expect((save.notes as { reschedule_rule: { selected_successor: { acuity_appointment_id: string } } }).reschedule_rule.selected_successor).toEqual({
      appointment_id: s.apptIds.AS1!,
      acuity_appointment_id: "AS1",
    });
    expect(save.notes && (save.notes as Record<string, unknown>).derived_by).toBe(`retention-cancellations v${RETENTION_CANCELLATIONS_VERSION}`);

    expect(byAppt[s.apptIds.AC2!]!.outcome).toBe("unable_to_reach"); // attempts 1, none answered
    const resched = byAppt[s.apptIds.AC3!]!;
    expect(resched.outcome).toBe("rescheduled");
    expect(resched.successor_appointment_id).toBe(s.apptIds.AS3!); // different slot, still a real row
    expect(resched.recovered_at).toBe("2026-10-05T10:00:00Z");
    // MUSCLE RULE end-to-end: an ANSWERED call with no successor NEVER manufactures a save.
    expect(byAppt[s.apptIds.AC4!]!.outcome).toBe("confirmed_cancellation");
    expect(byAppt[s.apptIds.AC4!]!.recovered).toBe(false);
    expect(byAppt[s.apptIds.AC4!]!.successor_appointment_id).toBeNull();
    // The pending cancellation (window open) — the queue's actionable row.
    expect(byAppt[s.apptIds.AC8!]!.outcome).toBe("pending");
    expect(byAppt[s.apptIds.AC8!]!.recovered).toBe(false);
    // The override row survives untouched.
    const overridden = byAppt[s.apptIds.AC7!]!;
    expect(overridden.outcome).toBe("other");
    expect(overridden.manual_overrides).toEqual({ outcome: "other" });
  });

  test("idempotence: the same inputs write NOTHING on re-run (unchanged counted, no dupes)", async () => {
    const s = await seed();
    const first = await computeRetentionCancellations(s.store, { now: NOW });
    expect(first.inserted).toBe(5);
    const before = await s.store.listRetentionCancellations();

    const second = await computeRetentionCancellations(s.store, { now: NOW });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(5);
    expect(second.skippedOverrides).toBe(1);
    expect(second.outcomeCounts).toEqual(first.outcomeCounts);

    const after = await s.store.listRetentionCancellations();
    expect(after.length).toBe(before.length);
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
  });

  test("a genuine content change updates EXACTLY that row; identical rows are never rewritten", async () => {
    const s = await seed();
    await computeRetentionCancellations(s.store, { now: NOW });
    const before = await s.store.listRetentionCancellations();

    // CT1 books ANOTHER qualifying session (different slot) after the save —
    // the candidate list grows, so C1's notes legitimately change, but the
    // same-slot successor STILL wins the save.
    await s.store.upsertAppointments([
      {
        id: "",
        acuity_appointment_id: "AS1b",
        contact_id: (await s.store.getContacts()).find((c) => c.external_id === "CT1")!.id,
        calendar_id: "1335091",
        calendar_name: "MALLORY PORTRAITS",
        appointment_type: "Portrait Session",
        appointment_datetime: "2026-10-25T14:00:00Z",
        created_at: "2026-10-13T10:00:00Z",
        status: "scheduled",
        cancelled: false,
        raw: null,
      },
    ] as never);
    await s.store.insertClientMatchLinkIfAbsent({ internalClientId: s.clientIds.CT1!, provider: "acuity", entity: "appointment", externalId: "AS1b", matchMethod: "exact_id", confidence: "exact" });

    const third = await computeRetentionCancellations(s.store, { now: NOW });
    expect(third.inserted).toBe(0);
    expect(third.updated).toBe(1); // only C1's evidence changed
    expect(third.unchanged).toBe(4);
    const after = await s.store.listRetentionCancellations();
    expect(after.length).toBe(before.length);
    const save = after.find((r) => r.appointment_id === s.apptIds.AC1!)!;
    expect(save.outcome).toBe("saved_original"); // same-slot priority held
    expect(save.successor_appointment_id).toBe(s.apptIds.AS1!);
    expect((save.notes as { reschedule_rule: { candidates: unknown[] } }).reschedule_rule.candidates).toHaveLength(2); // the evidence now lists both
  });

  test("cancelled_at is COPIED, never moved, and the write is versioned + audited in notes", async () => {
    const s = await seed();
    await computeRetentionCancellations(s.store, { now: NOW });
    const row = (await s.store.listRetentionCancellations()).find((r) => r.appointment_id === s.apptIds.AC1!)!;
    expect(row.cancelled_at).toBe("2026-10-11T15:00:00Z"); // copied from appointments.cancelled_at (write-once)
    expect(row.ghl_contact_external_id).toBe("CT1");
    expect(row.attempts_count).toBe(0);
    expect(row.any_answered).toBe(false);
    expect(row.final_contact_status).toBeNull();
    const notes = row.notes as Record<string, unknown>;
    expect(notes.cancelled_at_basis).toContain("write-once");
    expect(notes.identity_basis).toContain("stage-2 chain");
    expect(notes.saved_original_rule).toContain("exact instant");
  });
});
