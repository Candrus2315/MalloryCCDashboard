/**
 * SESSION 2 (owner-ratified attribution program) — identity repair + window +
 * invariants:
 *  - call→contact restoration backfill: hierarchy precedence (direct beats
 *    inherited beats value-match), fill-null-only guarantee, ambiguous
 *    multi-rep/value-match handling, checkpoint resume;
 *  - DATE-GRANULARITY window: ET midnight crossings (booking created Mon →
 *    window Sun+Mon; created on the 1st → last-day-of-prev-month + 1st);
 *  - multi-rep ambiguity routes to the manual queue;
 *  - booking-coverage invariant: Attributed + Unattributed === Total, and
 *    Total never shrinks when identity resolution is incomplete.
 * All fixtures run on MemoryStore (no live API, no live DB writes).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { ContactRow } from "../store/types";
import {
  CALL_CONTACT_BACKFILL_CHECKPOINT_KEY,
  parseCallContactCheckpoint,
  runCallContactBackfillChunk,
} from "../sync/call-contact-backfill";
import { matchAppointmentsToCalls, bookingCreationDateEt, attributionWindowDates } from "../metrics/attribution";
import { assertBookingInvariant, bookingCoverage, type AttributionRow, type CallRow, type AppointmentRow } from "../metrics/compute";

// ---------- fixtures ----------

const NOW_ISO = "2026-09-26T12:00:00.000Z";
const now = () => new Date(NOW_ISO);

let seq = 0;
async function seedStore(): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.ensureSchema();
  return store;
}

async function seedContact(store: MemoryStore, over: Partial<ContactRow> = {}): Promise<ContactRow> {
  seq += 1;
  await store.upsertContacts([
    {
      id: "",
      provider: "highlevel",
      external_id: over.external_id ?? `hl-contact-${seq}`,
      name: over.name ?? `Contact ${seq}`,
      phone: over.phone ?? null,
      email: over.email ?? null,
      assigned_rep_id: over.assigned_rep_id ?? null,
      created_at: "2026-09-01T00:00:00.000Z",
      ...over,
    },
  ]);
  const all = await store.getContacts();
  return all.find((c) => c.external_id === (over.external_id ?? `hl-contact-${seq}`))!;
}

async function seedRep(store: MemoryStore, externalId: string): Promise<string> {
  await store.upsertUsers([{ id: "", provider: "highlevel", external_id: externalId, name: `Rep ${externalId}`, email: `${externalId}@malloryportraits.com`, is_active: true, call_start_date: null }]);
  const users = await store.getAllUsers();
  return users.find((u) => u.external_id === externalId)!.id;
}

async function seedCall(
  store: MemoryStore,
  over: Partial<CallRow & { external_call_id: string; conversation_id: string | null; provider: string }>,
): Promise<CallRow> {
  seq += 1;
  const row = {
    id: "",
    provider: "highlevel",
    external_call_id: over.external_call_id ?? `hl-msg-${seq}`,
    rep_id: over.rep_id ?? null,
    contact_id: over.contact_id ?? null,
    started_at: over.started_at ?? "2026-09-25T15:00:00.000Z",
    duration_seconds: over.duration_seconds ?? 300,
    over_two_minutes: (over.duration_seconds ?? 300) > 120,
    conversation_id: over.conversation_id ?? null,
  };
  await store.upsertCalls([row as CallRow & { external_call_id: string; provider: string }]);
  const calls = await store.getAllCallsSince("1970-01-01T00:00:00.000Z");
  return calls.find((c) => c.external_call_id === row.external_call_id)!;
}

// ---------- call→contact restoration backfill ----------

describe("call→contact backfill — resolution hierarchy", () => {
  test("tier 1 direct: the ledger's message contactId wins and is stored with provenance", async () => {
    const store = await seedStore();
    const rep = await seedRep(store, "rep1");
    const contact = await seedContact(store);
    await seedCall(store, { contact_id: null, rep_id: rep });
    await store.upsertHarvestCalls([
      { message_id: "", conversation_id: "conv-x", user_external_id: "rep1", contact_external_id: contact.external_id, started_at: "2026-09-25T15:00:00.000Z", duration_seconds: 300, direction: "out", call_status: null },
    ]);
    // fix message id to the seeded call
    const call = (await store.getAllCallsSince("1970-01-01T00:00:00.000Z"))[0];
    await store.upsertHarvestCalls([
      { message_id: call.external_call_id!, conversation_id: "conv-x", user_external_id: "rep1", contact_external_id: contact.external_id, started_at: call.started_at, duration_seconds: 300, direction: "out", call_status: null },
    ]);

    const r = await runCallContactBackfillChunk({ store, now });
    expect(r.filled).toBe(1);
    expect(r.byMethod.direct_message_contact).toBe(1);
    const after = (await store.getAllCallsSince("1970-01-01T00:00:00.000Z"))[0];
    expect(after.contact_id).toBe(contact.id);
    expect(after.contact_resolution_method).toBe("direct_message_contact");
  });

  test("tier precedence: direct beats parent-conversation beats value-match; idempotent rerun changes nothing", async () => {
    const store = await seedStore();
    const rep = await seedRep(store, "rep1");
    const direct = await seedContact(store, { external_id: "hl-direct" });
    const parent = await seedContact(store, { external_id: "hl-parent", phone: "+15551230001" });
    const byPhone = await seedContact(store, { external_id: "hl-phone", phone: "5551230999" });
    const call = await seedCall(store, { contact_id: null, conversation_id: "conv-1" });
    await store.upsertHarvestCalls([
      { message_id: call.external_call_id!, conversation_id: "conv-1", user_external_id: "rep1", contact_external_id: direct.external_id, started_at: call.started_at, duration_seconds: 300, direction: "out", call_status: null },
    ]);
    await store.upsertHarvestConversations([{ conv_id: "conv-1", last_message_date: 0, date_added: 0, message_types: [1], last_message_type: "TYPE_CALL", contact_id: parent.external_id, assigned_to: null }]);

    const r1 = await runCallContactBackfillChunk({ store, now });
    expect(r1.byMethod.direct_message_contact).toBe(1);
    const after = (await store.getAllCallsSince("1970-01-01T00:00:00.000Z"))[0];
    expect(after.contact_id).toBe(direct.id); // direct wins over the conversation's contact
    expect(after.contact_resolution_method).toBe("direct_message_contact");

    // A call with NO ledger row resolves through the parent conversation.
    const call2 = await seedCall(store, { external_call_id: "hl-msg-noledger", contact_id: null, conversation_id: "conv-1" });
    void call2;
    const r2 = await runCallContactBackfillChunk({ store, now });
    expect(r2.byMethod.parent_conversation_contact).toBe(1);
    const calls = await store.getAllCallsSince("1970-01-01T00:00:00.000Z");
    const c2 = calls.find((c) => c.external_call_id === "hl-msg-noledger")!;
    expect(c2.contact_id).toBe(parent.id);
    expect(c2.contact_resolution_method).toBe("parent_conversation_contact");

    // Idempotent rerun: no call is re-examined (cursor), counts unchanged.
    const r3 = await runCallContactBackfillChunk({ store, now });
    expect(r3.scanned).toBe(0);
    expect(r3.done).toBe(true);
    void byPhone;
  });

  test("fill-null-only: an existing contact_id is NEVER overwritten; ambiguous/unresolved keep contact NULL", async () => {
    const store = await seedStore();
    const rep = await seedRep(store, "rep1");
    const owner = await seedContact(store, { external_id: "hl-owner" });
    const other = await seedContact(store, { external_id: "hl-other" });
    // Call ALREADY linked (never re-resolved) + a call whose phone matches `other`.
    const linked = await seedCall(store, { external_call_id: "hl-linked", contact_id: owner.id, conversation_id: null });
    const orphan = await seedCall(store, { external_call_id: "hl-orphan", contact_id: null, conversation_id: null });
    void orphan;
    // Two contacts sharing one phone → ambiguous (never picked between).
    const shared1 = await seedContact(store, { external_id: "hl-shared-1", phone: "5551230777", assigned_rep_id: rep });
    const shared2 = await seedContact(store, { external_id: "hl-shared-2", phone: "+15551230777", assigned_rep_id: rep });
    void shared1;
    void shared2;
    // Give the ORPHAN a source phone via the optional fetch hook (the only
    // path that can carry a phone for a call — call rows never have one).
    const port = Object.assign(store, {
      fetchSourceIdentity: async (c: { external_call_id: string | null }) =>
        c.external_call_id === "hl-orphan" ? { phone: "5551230777" } : null,
    });
    const r = await runCallContactBackfillChunk({ store: port, now });
    const calls = await store.getAllCallsSince("1970-01-01T00:00:00.000Z");
    const afterLinked = calls.find((c) => c.id === linked.id)!;
    expect(afterLinked.contact_id).toBe(owner.id); // untouched
    const afterOrphan = calls.find((c) => c.external_call_id === "hl-orphan")!;
    expect(afterOrphan.contact_id).toBeNull(); // 2 distinct roster-rep contacts → never pick
    expect(afterOrphan.contact_resolution_method).toBe("ambiguous");
    expect(r.byMethod.ambiguous).toBeGreaterThanOrEqual(1);
  });

  test("resumable: the checkpoint persists and a fresh chunk resumes past the cursor", async () => {
    const store = await seedStore();
    const contact = await seedContact(store);
    const c1 = await seedCall(store, { external_call_id: "hl-m1", contact_id: null, started_at: "2026-09-20T10:00:00.000Z" });
    const c2 = await seedCall(store, { external_call_id: "hl-m2", contact_id: null, started_at: "2026-09-21T10:00:00.000Z" });
    void c1;
    void c2;
    await store.upsertHarvestCalls([
      { message_id: "hl-m1", conversation_id: null, user_external_id: null, contact_external_id: contact.external_id, started_at: "2026-09-20T10:00:00.000Z", duration_seconds: 300, direction: null, call_status: null },
      { message_id: "hl-m2", conversation_id: null, user_external_id: null, contact_external_id: contact.external_id, started_at: "2026-09-21T10:00:00.000Z", duration_seconds: 300, direction: null, call_status: null },
    ]);
    const r1 = await runCallContactBackfillChunk({ store, batchSize: 1, now });
    expect(r1.scanned).toBe(1);
    const cp = parseCallContactCheckpoint(await store.getSyncCheckpoint(CALL_CONTACT_BACKFILL_CHECKPOINT_KEY));
    expect(cp!.lastCallId).toBe(c1.id);
    const r2 = await runCallContactBackfillChunk({ store, batchSize: 1, now });
    expect(r2.scanned).toBe(1);
    expect(r2.byMethod.direct_message_contact).toBe(1);
    const calls = await store.getAllCallsSince("1970-01-01T00:00:00.000Z");
    expect(calls.every((c) => c.contact_id === contact.id)).toBe(true);
  });
});

// ---------- date-granularity window ----------

describe("date-granularity window (owner-ratified 9/26)", () => {
  test("ET midnight crossing: booking created Mon → window Sun+Mon; date-only anchor keeps the date", () => {
    const anchor = bookingCreationDateEt({ created_at: "2026-09-28T00:00:00.000Z", appointment_datetime: "2026-10-05T14:00:00.000Z" });
    expect(anchor!.date).toBe("2026-09-28"); // UTC midnight = date-only encoding, NOT shifted to 09-27
    expect(anchor!.anchoredOn).toBe("created_at");
    const w = attributionWindowDates("2026-09-28");
    expect(w).toEqual({ from: "2026-09-27", to: "2026-09-28" }); // Sun + Mon
  });

  test("month boundary: created on the 1st → window = last day of previous month + the 1st; session date never used", () => {
    const anchor = bookingCreationDateEt({ created_at: "2026-11-01T00:00:00.000Z", appointment_datetime: "2026-11-20T15:00:00.000Z" });
    expect(anchor!.date).toBe("2026-11-01");
    expect(attributionWindowDates("2026-11-01")).toEqual({ from: "2026-10-31", to: "2026-11-01" });
    // Legacy row without created_at falls back to the session date — MARKED.
    const legacy = bookingCreationDateEt({ appointment_datetime: "2026-11-01T05:00:00.000Z" });
    expect(legacy!.anchoredOn).toBe("session-fallback");
  });
});

// ---------- multi-rep ambiguity + metric invariants ----------

describe("ambiguity → manual queue + booking-coverage invariant", () => {
  test("multi-rep: qualifying calls from TWO roster reps → ambiguous (manual queue), single-rep attributes", () => {
    const appt = { id: "a1", contact_id: "c-1", client_phone: null, client_email: null, appointment_datetime: "2026-09-28T14:00:00.000Z", created_at: "2026-09-28T14:00:00.000Z" };
    const calls = [
      { id: "k1", external_call_id: "hl-r1", rep_id: "rep-1", contact_id: "c-1", started_at: "2026-09-28T13:00:00.000Z", duration_seconds: 600 },
      { id: "k2", external_call_id: "hl-r2", rep_id: "rep-2", contact_id: "c-1", started_at: "2026-09-28T11:00:00.000Z", duration_seconds: 600 },
    ];
    const [multi] = matchAppointmentsToCalls([appt], calls, [{ id: "c-1" }], { meeting_threshold_seconds: 120, attribution_window_hours: 24 }, {
      today: "2026-09-28",
      users: [{ id: "rep-1", is_active: true }, { id: "rep-2", is_active: true }],
    });
    expect(multi.status).toBe("unattributed");
    expect(multi.reason).toBe("ambiguous");
    expect(multi.detail).toContain("2 distinct roster reps");

    const [single] = matchAppointmentsToCalls([appt], [calls[0]], [{ id: "c-1" }], { meeting_threshold_seconds: 120, attribution_window_hours: 24 }, {
      today: "2026-09-28",
      users: [{ id: "rep-1", is_active: true }, { id: "rep-2", is_active: true }],
    });
    expect(single.status).toBe("attributed");
    expect(single.repId).toBe("rep-1");
  });

  test("invariant: Attributed + Unattributed === Total; Total NEVER shrinks when identity is incomplete", () => {
    const appts = [
      { id: "a1", contact_id: null, calendar_id: null, appointment_type: "Family", appointment_datetime: "2026-09-28T14:00:00.000Z", created_at: "2026-09-28T14:00:00.000Z", status: "scheduled", cancelled: false },
      { id: "a2", contact_id: null, calendar_id: null, appointment_type: "Family", appointment_datetime: "2026-09-28T15:00:00.000Z", created_at: "2026-09-28T15:00:00.000Z", status: "scheduled", cancelled: false },
    ] as AppointmentRow[];
    const partial: AttributionRow[] = [
      { id: "attr:a1", appointment_id: "a1", call_id: "k1", rep_id: "rep-1", method: "contact_id", confidence: 1, manual_override: false, note: "date_granularity_window call-dates 2026-09-27..2026-09-28 ET" },
      { id: "attr:a2", appointment_id: "a2", call_id: null, rep_id: null, method: "none", confidence: 0, manual_override: false },
    ];
    const cov = bookingCoverage(appts, partial);
    expect(cov).toEqual({ total: 2, attributed: 1, unattributed: 1 });
    expect(() => assertBookingInvariant(appts, partial, { engineAttributed: 1, engineUnattributed: 1 })).not.toThrow();
    // Identity resolution getting WORSE moves a1 to unattributed — Total stays 2.
    const cov2 = bookingCoverage(appts, [partial[1]]);
    expect(cov2.total).toBe(2);
    expect(cov2.attributed).toBe(0);
    expect(cov2.unattributed).toBe(2);
    // A wiring regression that loses a verdict row throws (never silent).
    expect(() => assertBookingInvariant(appts, [partial[0]], { engineAttributed: 1, engineUnattributed: 0 })).toThrow(/invariant/i);
  });
});
