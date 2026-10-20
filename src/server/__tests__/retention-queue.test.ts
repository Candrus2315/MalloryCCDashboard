/**
 * NEEDS ATTENTION QUEUE tests (owner restructure directive 2026-10-20, point
 * 1) — the client-level work queue under the TODAY row, MemoryStore end-to-
 * end with deterministic fixtures: segment membership (call-due / unreached /
 * window-missed / needs-review), disjointness, the §16 ONE-SOURCE-OF-TRUTH
 * cross-check against the drill-down's own unreached universe, human status
 * labels, ordering, the honest empty cancellation slot, and the empty-store
 * shape. The cancellations ledger has no writer yet, so its segment stays
 * empty by construction (CANCELLATIONS_ENGINE_NOTE) — never faked.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { computeRetention } from "../retention/compute";
import {
  retentionNeedsAttention,
  retentionDrillData,
  CANCELLATIONS_ENGINE_NOTE,
} from "../retention/ui-data";

// Fixed clock: 2026-10-20 ET (Tue) → current Mon–Sun due week = 10/19..10/25.
const NOW = () => new Date("2026-10-20T15:00:00Z");
const APPT_1026 = "2026-10-26T14:00:00Z"; // due 10/19 — current week, voicemail attempt
const APPT_1024 = "2026-10-24T14:00:00Z"; // due 10/17 — last week; SWC note + no-answer → needs_review
const APPT_1027 = "2026-10-27T18:00:00Z"; // due 10/20 — current week, no-answer attempt
const APPT_1013 = "2026-10-13T14:00:00Z"; // due 10/06 — session passed, never reached → window missed
const APPT_1102 = "2026-11-02T18:00:00Z"; // due 10/26 — NEXT week, window open, not this week's cohort
const APPT_1030 = "2026-10-30T15:00:00Z"; // due 10/23 — current week, ZERO attempts → "No attempt yet"

async function seed() {
  const store = new MemoryStore();
  await store.upsertUsers([
    { id: "", provider: "highlevel", external_id: "LAU", name: "Laura Rivera", email: "laura@mallory.test", is_active: false, call_start_date: null },
  ] as never);
  await store.upsertContacts([
    { id: "", provider: "highlevel", external_id: "CT1", name: "Jane Doe", phone: "(603) 555-1212", email: "jane@example.com", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT2", name: "Bob Roe", phone: "2125550101", email: "bob@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT3", name: "Cara Lee", phone: "9175550143", email: "cara@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT4", name: "Dan Fox", phone: "9175550188", email: "dan@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT5", name: "Eve Ray", phone: "9175550199", email: "eve@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT6", name: "Finn Gil", phone: "9175550177", email: "finn@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
  ] as never);
  const contacts = await store.getContacts();
  const contactIds: Record<string, string> = {};
  for (const c of contacts) contactIds[c.external_id!] = c.id;

  const appt = (acuityId: string, contactId: string | null, datetime: string, notes: string | null) => ({
    id: "",
    acuity_appointment_id: acuityId,
    contact_id: contactId,
    calendar_id: "1335091",
    calendar_name: "MALLORY PORTRAITS",
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
    appt("A3", contactIds.CT3!, APPT_1027, null),
    appt("A4", contactIds.CT4!, APPT_1013, null),
    appt("A5", contactIds.CT5!, APPT_1102, null),
    appt("A6", contactIds.CT6!, APPT_1030, null),
  ] as never);

  const clients: Record<string, string> = {};
  const seeds: [string, string, string, string, string][] = [
    ["CT1", "Jane Doe", "6035551212", "jane@example.com", "CT1"],
    ["CT2", "Bob Roe", "2125550101", "bob@other.org", "CT2"],
    ["CT3", "Cara Lee", "9175550143", "cara@other.org", "CT3"],
    ["CT4", "Dan Fox", "9175550188", "dan@other.org", "CT4"],
    ["CT5", "Eve Ray", "9175550199", "eve@other.org", "CT5"],
    ["CT6", "Finn Gil", "9175550177", "finn@other.org", "CT6"],
  ];
  for (const [key, name, phone, email, ext] of seeds) {
    const c = await store.insertInternalClient({ seedKey: `hl-contact:${ext}`, displayName: name, normalizedPhone: phone, normalizedEmail: email, ghlContactExternalId: ext });
    clients[key] = c.id;
    await store.insertClientMatchLinkIfAbsent({ internalClientId: c.id, provider: "highlevel", entity: "contact", externalId: ext, matchMethod: "exact_id", confidence: "exact" });
  }
  for (const [ext, key] of [["A1", "CT1"], ["A2", "CT2"], ["A3", "CT3"], ["A4", "CT4"], ["A5", "CT5"], ["A6", "CT6"]] as const) {
    await store.insertClientMatchLinkIfAbsent({ internalClientId: clients[key]!, provider: "acuity", entity: "appointment", externalId: ext, matchMethod: "exact_id", confidence: "exact" });
  }

  const call = (externalId: string, contactId: string | null, at: string) => ({
    provider: "highlevel",
    external_call_id: externalId,
    rep_id: null,
    contact_id: contactId,
    started_at: at,
    duration_seconds: 0,
    over_two_minutes: false,
    direction: "outbound",
    call_status: externalId === "MSG1" ? "voicemail" : "no-answer",
    provider_rep_external_id: null,
  });
  await store.upsertCalls([
    call("MSG1", contactIds.CT1!, "2026-10-19T15:00:00Z"), // voicemail → A1
    call("MSG3", contactIds.CT2!, "2026-10-18T15:00:00Z"), // no-answer → A2
    call("MSG6", contactIds.CT4!, "2026-10-08T14:00:00Z"), // no-answer → A4
    // CT3/A3: no calls — the zero-attempt call-due fixture (due today)
    // CT5/A5, CT6/A6: no calls — due windows not yet opened (see scope test)
  ] as never);

  const res = await computeRetention(store, { now: NOW });
  expect(res.outcome).toBe("synced");
  return { store, clients };
}

describe("retentionNeedsAttention (the owner's client-level work queue)", () => {
  test("segments: call-due / unreached / window-missed / needs-review with human labels", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    expect(q.counts).toEqual({ callDue: 2, unreached: 0, windowMissed: 1, needsReview: 1, cancellations: null });

    const byClient = Object.fromEntries(q.rows.map((r) => [r.clientName!, r]));
    // A1 — due this week, voicemail left, window open → call-due, classification label as status.
    expect(byClient["Jane Doe"]).toMatchObject({ segment: "call-due", statusLabel: "Voicemail", actionLabel: "Call", drillKpi: "clients-due", attemptsCount: 1, lastCallStatus: "voicemail" });
    // A3 — due today, ZERO attempts, window open → call-due with the honest "no attempt yet" status.
    expect(byClient["Cara Lee"]).toMatchObject({ segment: "call-due", statusLabel: "No attempt yet", actionLabel: "Call", attemptsCount: 0, lastCallStatus: null });
    // A4 — session passed, zero answered attempts → window missed, review.
    expect(byClient["Dan Fox"]).toMatchObject({ segment: "window-missed", statusLabel: "Window missed", actionLabel: "Review", drillKpi: "unreached", lastCallStatus: "no-answer" });
    // A2 — SWC note against a no-answer log → needs review, open.
    expect(byClient["Bob Roe"]).toMatchObject({ segment: "needs-review", statusLabel: "Evidence conflict", actionLabel: "Open", drillKpi: "needs-review" });
  });

  test("engine scope: clients whose due window has not opened yet are honestly absent", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    // A5 (due 10/26) and A6 (due 10/23) are still before their contact-due
    // date — the compute's proven universe admits a client when its window
    // OPENS (compute.ts: cohort = due ≤ today ET). The queue ships rows the
    // engine can prove today and invents nothing about the rest.
    expect(q.rows.some((r) => r.clientName === "Eve Ray")).toBe(false);
    expect(q.rows.some((r) => r.clientName === "Finn Gil")).toBe(false);
  });

  test("segments are disjoint — no appointment appears twice", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    const ids = q.rows.map((r) => r.appointmentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  test("ONE source of truth: the queue's unreached family equals the drill's §16 unreached universe", async () => {
    const s = await seed();
    const [q, drill] = await Promise.all([
      retentionNeedsAttention(s.store, NOW),
      retentionDrillData(s.store, { kpi: "unreached", range: "all", classification: "all", outcome: "all", employee: "all", exc: "open" }, NOW),
    ]);
    const queueUnreachedIds = q.rows.filter((r) => r.segment === "unreached" || r.segment === "window-missed").map((r) => r.appointmentId).sort();
    // plus the call-due rows that are ALSO in the §16 unreached status set
    const queueCallDueUnreachedIds = q.rows.filter((r) => r.segment === "call-due" && ["no_answer", "attempted_unclear"].includes(r.finalStatus)).map((r) => r.appointmentId).sort();
    const drillIds = drill.rows.map((r) => r.appointmentId).sort();
    expect([...queueUnreachedIds, ...queueCallDueUnreachedIds].sort()).toEqual(drillIds);
  });

  test("ordering: call-due soonest appointment first; missed windows most-recently-missed first", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    const segments = q.rows.map((r) => r.segment);
    // group order: call-due block, unreached block, window-missed block, needs-review block
    expect(segments).toEqual([
      "call-due",
      "call-due",
      "window-missed",
      "needs-review",
    ]);
    const callDueClients = q.rows.filter((r) => r.segment === "call-due").map((r) => r.clientName);
    expect(callDueClients).toEqual(["Jane Doe", "Cara Lee"]); // appt 10/26 < 10/27
  });

  test("the cancellation slot stays honestly empty until its stage lands", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    expect(q.rows.filter((r) => r.segment === "cancellation")).toHaveLength(0);
    expect(q.counts.cancellations).toBeNull();
    expect(q.cancellationsEngineNote).toBe(CANCELLATIONS_ENGINE_NOTE);
  });

  test("rows carry the drill-link fields (client, appointment ET, due date, acuity id)", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    const jane = q.rows.find((r) => r.clientName === "Jane Doe")!;
    expect(jane.acuityId).toBe("A1");
    expect(jane.apptDateEt).toBe("2026-10-26");
    expect(jane.apptTimeEt).toBeTruthy();
    expect(jane.dueDate).toBe("2026-10-19");
    expect(jane.internalClientId).toBe(s.clients.CT1);
  });

  test("empty store → empty queue, zero counts, cancellations still null (never fabricated)", async () => {
    const store = new MemoryStore();
    const q = await retentionNeedsAttention(store, NOW);
    expect(q.rows).toEqual([]);
    expect(q.counts).toEqual({ callDue: 0, unreached: 0, windowMissed: 0, needsReview: 0, cancellations: null });
    expect(q.dueDays).toBe(7);
  });
});
