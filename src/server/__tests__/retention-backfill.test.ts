/**
 * RETENTION IDENTITY BACKFILL tests (stage 2, plan §7.5) — MemoryStore.
 * Covers: exact_id seeding from resolved appointments.contact_id; phone/email
 * fallback; new-client creation; ambiguity → exceptions (never guessed);
 * name-only never matches; manual-resolve stickiness across re-runs; and the
 * byte-identical idempotence gate.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { applyInternalClientBackfill, type BackfillInput } from "../retention/backfill";
import type { Store } from "../store/types";

function baseInput(): BackfillInput {
  return {
    appointments: [
      // resolved contact chain (exact_id seed path)
      { acuityAppointmentId: "A1", status: "scheduled", clientName: "Jane Doe", clientPhone: "(603) 555-1212", clientEmail: "jane@example.com", contactExternalId: "CT1" },
      { acuityAppointmentId: "A2", status: "scheduled", clientName: "Jane Doe", clientPhone: "603-555-1212", contactExternalId: "CT1" },
      // unresolved contact → phone fallback against seeded clients
      { acuityAppointmentId: "A3", status: "scheduled", clientName: "Bob Roe", clientPhone: "+1 212 555 0101", clientEmail: "bob@other.org", contactExternalId: null },
      // name-only appointment (owner rule: never matches)
      { acuityAppointmentId: "A4", status: "scheduled", clientName: "Mystery Person", contactExternalId: null },
    ],
    contacts: [
      { externalId: "CT1", name: "Jane Doe", phone: "(603) 555-1212", email: "jane@example.com", hasRecentCall: false },
      { externalId: "CT2", name: "Bob Roe", phone: "2125550101", email: "bob@other.org", hasRecentCall: true },
      { externalId: "CT3", name: "New Caller", phone: "9175550199", email: null, hasRecentCall: true }, // no candidate → new client
      { externalId: "CT4", name: "Shared Line", phone: "6035551212", email: null, hasRecentCall: false }, // not recent → untouched here
      { externalId: "CT5", name: "Ghost Initials", phone: null, email: null, hasRecentCall: true }, // name only → exception
    ],
    callsWithoutClient: [
      { provider: "highlevel", externalCallId: "MSG1", startedAtIso: "2026-10-15T17:55:14Z", direction: "outbound", callStatus: "voicemail", durationSeconds: 47, contactInternalId: null, reason: "null_contact_id" },
    ],
  };
}

async function snapshot(store: Store) {
  const clients = await store.listInternalClients();
  const links = [];
  for (const c of clients) links.push(...(await store.getClientMatchLinksByInternalClient(c.id)));
  const exceptions = await store.getDataMatchExceptions();
  const canon = (rows: unknown[]) => JSON.stringify(rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  return {
    clients: canon(clients),
    links: canon(links),
    exceptions: canon(exceptions),
    clientCount: clients.length,
    linkCount: links.length,
    exceptionCount: exceptions.length,
  };
}

async function seedStore(): Promise<{ store: MemoryStore; contactIds: Record<string, string> }> {
  const store = new MemoryStore();
  await store.upsertContacts([
    { id: "", provider: "highlevel", external_id: "CT1", name: "Jane Doe", phone: "(603) 555-1212", email: "jane@example.com", assigned_rep_id: null, created_at: new Date().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT2", name: "Bob Roe", phone: "2125550101", email: "bob@other.org", assigned_rep_id: null, created_at: new Date().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT3", name: "New Caller", phone: "9175550199", email: null, assigned_rep_id: null, created_at: new Date().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT5", name: "Ghost Initials", phone: null, email: null, assigned_rep_id: null, created_at: new Date().toISOString() },
  ] as never);
  const contacts = await store.getContacts();
  const contactIds: Record<string, string> = {};
  for (const c of contacts) contactIds[c.external_id] = c.id;
  const apptRow = (acuityId: string, contactId: string | null, name: string) => ({
    id: "",
    acuity_appointment_id: acuityId,
    contact_id: contactId,
    calendar_id: null,
    appointment_type: "Portrait Session",
    appointment_datetime: "2026-10-26T14:00:00Z",
    created_at: "2026-10-16T15:00:00Z",
    status: "scheduled",
    cancelled: false,
    client_name: name,
  });
  await store.upsertAppointments([
    apptRow("A1", contactIds.CT1, "Jane Doe"),
    apptRow("A2", contactIds.CT1, "Jane Doe"),
    apptRow("A3", null, "Bob Roe"),
    apptRow("A4", null, "Mystery Person"),
  ] as never);
  await store.upsertCalls([
    {
      id: "",
      provider: "highlevel",
      external_call_id: "CALL1",
      rep_id: null,
      contact_id: contactIds.CT2,
      direction: "outbound",
      call_status: "voicemail",
      started_at: "2026-10-15T17:55:14Z",
      duration_seconds: 47,
      over_two_minutes: false,
    },
  ] as never);
  return { store, contactIds };
}

describe("applyInternalClientBackfill", () => {
  test("pass A seeds clients + both-side exact_id links; recent-call contacts create/match; fallbacks + exceptions honest", async () => {
    const { store } = await seedStore();
    const result = await applyInternalClientBackfill(store, baseInput());
    // clients: CT1 (via appointment), CT2 + CT3 (new_client_origin via recent calls)
    expect(result.clientsCreated).toBe(3);
    const a1 = await store.getInternalClientForAppointment("A1");
    expect(a1?.ghl_contact_external_id).toBe("CT1");
    const a2 = await store.getInternalClientForAppointment("A2");
    expect(a2?.id).toBe(a1?.id); // both appointments → same client
    const a1Link = await store.getClientMatchLink("acuity", "appointment", "A1");
    expect(a1Link).toMatchObject({ match_method: "exact_id", confidence: "exact", resolved_by: "auto" });
    expect(a1Link?.evidence).toMatchObject({ basis: "appointments_contact_id", contact_external_id: "CT1" });
    const ct1Link = await store.getClientMatchLink("highlevel", "contact", "CT1");
    expect(ct1Link?.match_method).toBe("exact_id");
    // pass C: CT2 recent-call contact with phone/email matching nobody → NEW client
    const ct2 = await store.getClientMatchLink("highlevel", "contact", "CT2");
    expect(ct2).toMatchObject({ match_method: "exact_id", confidence: "exact" });
    expect(ct2?.evidence).toMatchObject({ basis: "new_client_origin" });
    // pass B (runs after C): A3's phone/email now match CT2's client → fallback link
    const a3Client = await store.getInternalClientForAppointment("A3");
    expect(a3Client?.id).toBe(ct2?.internal_client_id);
    const a3Link = await store.getClientMatchLink("acuity", "appointment", "A3");
    expect(a3Link).toMatchObject({ match_method: "phone_email", confidence: "exact" });
    // CT3: phone matches nothing → new client (§7.5.2 "else create new")
    const ct3Link = await store.getClientMatchLink("highlevel", "contact", "CT3");
    expect(ct3Link?.evidence).toMatchObject({ basis: "new_client_origin" });
    // CT5: name only → exception, NEVER a match
    const ct5Link = await store.getClientMatchLink("highlevel", "contact", "CT5");
    expect(ct5Link).toBeNull();
    const ct5Exc = (await store.getDataMatchExceptions({ status: "open" })).find((e) => e.dedupe_key === "contact-identity:hl:CT5");
    expect(ct5Exc?.kind).toBe("name_only");
    // A4: name-only appointment → exception (appointments never mint clients)
    const a4Exc = (await store.getDataMatchExceptions({ status: "open" })).find((e) => e.dedupe_key === "appt-identity:A4");
    expect(a4Exc?.kind).toBe("name_only");
    // null-contact call → exception, nothing silent
    const callExc = (await store.getDataMatchExceptions()).find((e) => e.dedupe_key === "call-identity:highlevel:MSG1");
    expect(callExc?.kind).toBe("no_identity");
    expect(callExc?.payload).toMatchObject({ reason: "null_contact_id", subject: { external_call_id: "MSG1" } });
  });

  test("call → internal client resolution through the store", async () => {
    const { store, contactIds } = await seedStore();
    await applyInternalClientBackfill(store, baseInput());
    const calls = [...(await store.getAllCallsSince("1970-01-01T00:00:00Z"))];
    const resolved = await store.getInternalClientsForCallIds(calls.map((c) => c.id));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].internal_client_id).not.toBeNull();
    const viaContact = await store.getInternalClientsForContactExternalIds(["CT2"]);
    expect(viaContact[0].client?.id).toBe(resolved[0].internal_client_id);
    void contactIds;
  });

  test("IDEMPOTENCE: re-run produces byte-identical rows", async () => {
    const { store } = await seedStore();
    await applyInternalClientBackfill(store, baseInput());
    const before = await snapshot(store);
    const again = await applyInternalClientBackfill(store, baseInput());
    const after = await snapshot(store);
    expect(again.clientsCreated).toBe(0);
    expect(again.contactLinksCreated).toBe(0);
    expect(again.appointmentLinksCreated).toBe(0);
    expect(again.fallbackLinksCreated).toBe(0);
    expect(again.exceptionsCreated).toBe(0);
    expect(after.clients).toBe(before.clients);
    expect(after.links).toBe(before.links);
    expect(after.exceptions).toBe(before.exceptions);
    expect(after.clientCount).toBe(before.clientCount);
    expect(after.linkCount).toBe(before.linkCount);
    expect(after.exceptionCount).toBe(before.exceptionCount);
  });

  test("ambiguous phone → exception; manual resolve is sticky and never re-matched", async () => {
    const store = new MemoryStore();
    // Two clients already share a phone (the one live-zero case the matcher must still guard).
    const ca = await store.insertInternalClient({ seedKey: "hl-contact:CA1", displayName: "AlPHA One", normalizedPhone: "6035551212", ghlContactExternalId: "CA1" });
    const cb = await store.insertInternalClient({ seedKey: "hl-contact:CB1", displayName: "beta Two", normalizedPhone: "6035551212", ghlContactExternalId: "CB1" });
    const input: BackfillInput = {
      appointments: [],
      contacts: [{ externalId: "CT9", name: "Shared Line Caller", phone: "(603) 555-1212", email: null, hasRecentCall: true }],
      callsWithoutClient: [],
    };
    const r1 = await applyInternalClientBackfill(store, input);
    expect(r1.exceptionsCreated).toBe(1);
    const exc = (await store.getDataMatchExceptions({ status: "open" })).find((e) => e.dedupe_key === "contact-identity:hl:CT9");
    expect(exc?.kind).toBe("ambiguous_phone");
    expect(exc?.payload).toMatchObject({ candidates: [ca.id, cb.id].sort() });
    // Management resolves manually → client A, method manual, audited.
    await store.resolveDataMatchException(exc!.id, { internalClientId: ca.id, resolvedBy: "owner" });
    const resolvedList = await store.getDataMatchExceptions();
    expect(resolvedList.find((e) => e.id === exc!.id)?.status).toBe("resolved");
    let link = await store.getClientMatchLink("highlevel", "contact", "CT9");
    expect(link).toMatchObject({ internal_client_id: ca.id, match_method: "manual", confidence: "manual" });
    // Re-run: sticky — the manual link is untouched (no re-match, no override).
    const r2 = await applyInternalClientBackfill(store, input);
    expect(r2.exceptionsCreated).toBe(0);
    link = await store.getClientMatchLink("highlevel", "contact", "CT9");
    expect(link).toMatchObject({ internal_client_id: ca.id, match_method: "manual" });
    // The audit trail exists (manual_overrides sink).
    const overrides = await store.getManualOverrides(10);
    expect(overrides.some((o) => o.entity_type === "data_match_exception" && o.entity_id === exc!.id)).toBe(true);
  });
});
