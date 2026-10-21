/**
 * NEEDS ATTENTION QUEUE tests (owner restructure directive 2026-10-20, point
 * 1 + UX overhaul spec §3 D1/D2/D3/D6) — the client-level work queue under
 * the overview row, MemoryStore end-to-end with deterministic fixtures:
 * segment membership (call-due / unreached / window-missed / needs-review /
 * cancellation), disjointness, the §16 ONE-SOURCE-OF-TRUTH cross-check
 * against the drill-down's own unreached universe, human status labels, the
 * OWNER URGENCY ordering (1 cancellation · 2 call-due/unreached · 4
 * window-missed · 5 needs-review), the D1 last-contact field, the D2
 * window-closes derivations (loader clock, never client render time), the D3
 * recovered-this-week ledger count, and the empty-store shape. The
 * cancellations segment reads the WRITTEN ret_cancellations ledger (stage
 * 4a) through the same inCancellationUniverse predicate the Active
 * Cancellations card counts — a written-ledger 0 is a fact, never faked.
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
    expect(q.counts).toEqual({ callDue: 2, unreached: 0, windowMissed: 1, needsReview: 1, cancellations: 0 });

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

  test("ordering = the owner's urgency sort: rank 1/2/4/5, soonest appointment first inside call work", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    const segments = q.rows.map((r) => r.segment);
    // rank 2 (call work) · rank 4 (salvage) · rank 5 (records) — the same
    // fixture order the old segment-block sort produced, now via priority.
    expect(segments).toEqual(["call-due", "call-due", "window-missed", "needs-review"]);
    expect(q.rows.map((r) => r.priority)).toEqual([2, 2, 4, 5]);
    const callDueClients = q.rows.filter((r) => r.segment === "call-due").map((r) => r.clientName);
    expect(callDueClients).toEqual(["Jane Doe", "Cara Lee"]); // appt 10/26 < 10/27
  });

  test("stage 4a: empty written ledger → zero cancellation rows, count 0 (a fact, never faked)", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    expect(q.rows.filter((r) => r.segment === "cancellation")).toHaveLength(0);
    expect(q.counts.cancellations).toBe(0);
    expect(q.cancellationsEngineNote).toBe(CANCELLATIONS_ENGINE_NOTE);
  });

  test("stage 4a: pending ledger rows join the queue as cancellation work (Save → active-cancellations drill)", async () => {
    const s = await seed();
    // A5 (Eve Ray, session 11/02) is outside every outcome segment (due window
    // not open) — mark it cancelled and write its ledger row the way the
    // engine would: pending, cancelled_at inside the lookback.
    await s.store.upsertAppointments([
      {
        id: "",
        acuity_appointment_id: "A5",
        contact_id: (await s.store.getContacts()).find((c) => c.external_id === "CT5")!.id,
        calendar_id: "1335091",
        calendar_name: "MALLORY PORTRAITS",
        appointment_type: "Portrait Session",
        appointment_datetime: "2026-11-02T18:00:00Z",
        created_at: "2026-10-14T18:00:00Z",
        status: "scheduled",
        cancelled: true,
        cancelled_at: "2026-10-15T14:00:00Z",
        raw: null,
      },
    ] as never);
    const appts = await s.store.getAppointmentsWithClientsSince("2026-09-01T00:00:00Z");
    const a5 = appts.find((a) => a.acuity_appointment_id === "A5")!;
    await s.store.insertRetentionCancellations([
      {
        appointmentId: a5.id,
        internalClientId: s.clients.CT5,
        ghlContactExternalId: "CT5",
        cancelledAtIso: "2026-10-15T14:00:00Z",
        attemptsCount: 1,
        anyAnswered: false,
        finalContactStatus: "voicemail",
        outcome: "pending",
        successorAppointmentId: null,
        recovered: false,
        recoveredAtIso: null,
        notes: { acuity_appointment_id: "A5" },
      },
      // a saved cancellation is NOT queue work — outcome exists, not awaiting
      {
        appointmentId: appts.find((a) => a.acuity_appointment_id === "A6")!.id,
        internalClientId: s.clients.CT6,
        ghlContactExternalId: "CT6",
        cancelledAtIso: "2026-10-16T14:00:00Z",
        attemptsCount: 0,
        anyAnswered: false,
        finalContactStatus: null,
        outcome: "saved_original",
        successorAppointmentId: null,
        recovered: true,
        recoveredAtIso: "2026-10-17T10:00:00Z",
        notes: {},
      },
    ]);
    const q = await retentionNeedsAttention(s.store, NOW);
    const cancelRows = q.rows.filter((r) => r.segment === "cancellation");
    expect(cancelRows).toHaveLength(1); // only the pending row is actionable
    expect(cancelRows[0]).toMatchObject({
      clientName: "Eve Ray",
      statusLabel: "Awaiting outcome",
      actionLabel: "Save",
      drillKpi: "active-cancellations",
      attemptsCount: 1,
      lastCallStatus: null,
      apptDateEt: "2026-11-02",
      dueDate: "2026-10-15", // renders as "cancelled Oct 15" — the write-once stamp, not a due date
    });
    expect(q.counts.cancellations).toBe(1);
    // disjointness holds with the new segment present
    const ids = q.rows.map((r) => r.appointmentId);
    expect(new Set(ids).size).toBe(ids.length);
    // ordering: a pending cancellation is rank 1 (save now) — the FIRST work
    expect(q.rows[0]!.segment).toBe("cancellation");
    expect(q.rows[0]!.priority).toBe(1);
    expect(q.rows.every((r, i) => i === 0 || r.priority > 1)).toBe(true);
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

  test("D1: lastAttemptAt surfaces the outcome row's last contact (— none yet stays null)", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    const jane = q.rows.find((r) => r.clientName === "Jane Doe")!;
    expect(jane.lastAttemptAt).toBe("2026-10-19T15:00:00Z"); // MSG1 voicemail
    const cara = q.rows.find((r) => r.clientName === "Cara Lee")!;
    expect(cara.lastAttemptAt).toBeNull(); // zero attempts — "— none yet" is a proven fact
  });

  test("D2: windowCloses derives at load for open call work (null for closed windows + records)", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    const jane = q.rows.find((r) => r.clientName === "Jane Doe")!; // call-due, window open
    expect(jane.windowCloses).toBe(jane.apptIso);
    expect(jane.windowClosing).toBe(false); // appt 10/26 ≠ today (10/20 ET)
    const dan = q.rows.find((r) => r.clientName === "Dan Fox")!; // window-missed
    expect(dan.windowCloses).toBeNull();
    expect(dan.windowClosing).toBe(false);
    const bob = q.rows.find((r) => r.clientName === "Bob Roe")!; // needs-review
    expect(bob.windowCloses).toBeNull();
  });

  test("D2: a window closing TODAY flags windowClosing and sorts to the top of the call work", async () => {
    const s = await seed();
    // Grace Hill: session TODAY at 16:00 ET (20:00Z), zero attempts, due
    // window already open (appt − 7 = 10/13) → call-due, window closes today.
    await s.store.upsertContacts([
      { id: "", provider: "highlevel", external_id: "CT7", name: "Grace Hill", phone: "9175550166", email: "grace@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    ] as never);
    const ct7 = (await s.store.getContacts()).find((c) => c.external_id === "CT7")!.id;
    await s.store.upsertAppointments([
      {
        id: "",
        acuity_appointment_id: "A7",
        contact_id: ct7,
        calendar_id: "1335091",
        calendar_name: "MALLORY PORTRAITS",
        appointment_type: "Portrait Session",
        appointment_datetime: "2026-10-20T20:00:00Z",
        created_at: "2026-10-16T18:00:00Z",
        status: "scheduled",
        cancelled: false,
        raw: null,
      },
    ] as never);
    const g = await s.store.insertInternalClient({ seedKey: "hl-contact:CT7", displayName: "Grace Hill", normalizedPhone: "9175550166", normalizedEmail: "grace@other.org", ghlContactExternalId: "CT7" });
    await s.store.insertClientMatchLinkIfAbsent({ internalClientId: g.id, provider: "acuity", entity: "appointment", externalId: "A7", matchMethod: "exact_id", confidence: "exact" });
    expect((await computeRetention(s.store, { now: NOW })).outcome).toBe("synced");

    const q = await retentionNeedsAttention(s.store, NOW);
    const grace = q.rows.find((r) => r.clientName === "Grace Hill")!;
    expect(grace.segment).toBe("unreached"); // due last week (10/13) so NOT the excitement cohort — but the window is open, so still rank-2 call work
    expect(grace.windowClosing).toBe(true);
    expect(grace.windowCloses).toBe("2026-10-20T20:00:00.000Z");
    expect(grace.priority).toBe(2);
    // soonest appointment first inside rank 2 — today's closing window leads
    expect(q.rows.filter((r) => r.priority === 2)[0]!.clientName).toBe("Grace Hill");
  });

  test("D2: window-missed rows keep most-recently-missed first inside rank 4", async () => {
    const s = await seed();
    // Henry Wells: session Mon Oct 12 14:00 ET (2026-10-12T18:00:00Z) — EXACTLY
    // at the retention data-start boundary (owner directive 10/21), so IN
    // scope — one no-answer, an older miss than Dan's 10/13.
    await s.store.upsertContacts([
      { id: "", provider: "highlevel", external_id: "CT8", name: "Henry Wells", phone: "9175550155", email: "henry@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    ] as never);
    const ct8 = (await s.store.getContacts()).find((c) => c.external_id === "CT8")!.id;
    await s.store.upsertAppointments([
      {
        id: "",
        acuity_appointment_id: "A8",
        contact_id: ct8,
        calendar_id: "1335091",
        calendar_name: "MALLORY PORTRAITS",
        appointment_type: "Portrait Session",
        appointment_datetime: "2026-10-12T18:00:00Z",
        created_at: "2026-10-01T18:00:00Z",
        status: "scheduled",
        cancelled: false,
        raw: null,
      },
    ] as never);
    const h = await s.store.insertInternalClient({ seedKey: "hl-contact:CT8", displayName: "Henry Wells", normalizedPhone: "9175550155", normalizedEmail: "henry@other.org", ghlContactExternalId: "CT8" });
    await s.store.insertClientMatchLinkIfAbsent({ internalClientId: h.id, provider: "acuity", entity: "appointment", externalId: "A8", matchMethod: "exact_id", confidence: "exact" });
    await s.store.upsertCalls([
      { provider: "highlevel", external_call_id: "MSG8", rep_id: null, contact_id: ct8, started_at: "2026-10-06T14:00:00Z", duration_seconds: 0, over_two_minutes: false, direction: "outbound", call_status: "no-answer", provider_rep_external_id: null },
    ] as never);
    expect((await computeRetention(s.store, { now: NOW })).outcome).toBe("synced");

    const q = await retentionNeedsAttention(s.store, NOW);
    expect(q.rows.filter((r) => r.segment === "window-missed").map((r) => r.clientName)).toEqual([
      "Dan Fox", // 10/13 — the freshest salvage opportunity on top
      "Henry Wells", // 10/06
    ]);
    expect(q.rows.filter((r) => r.segment === "window-missed").every((r) => r.priority === 4)).toBe(true);
  });

  test("D3: cancellationsRecoveredThisWeek counts ledger recoveries inside the current Mon–Sun ET week (derived only)", async () => {
    const s = await seed();
    const q = await retentionNeedsAttention(s.store, NOW);
    expect(q.cancellationsRecoveredThisWeek).toBe(0); // written ledger, empty → an honest 0

    await s.store.insertRetentionCancellations([
      {
        appointmentId: (await s.store.getAppointmentsWithClientsSince("2026-09-01T00:00:00Z")).find((a) => a.acuity_appointment_id === "A1")!.id,
        internalClientId: s.clients.CT1,
        ghlContactExternalId: "CT1",
        cancelledAtIso: "2026-10-15T14:00:00Z",
        attemptsCount: 1,
        anyAnswered: false,
        finalContactStatus: "voicemail",
        outcome: "rescheduled",
        successorAppointmentId: null,
        recovered: true,
        recoveredAtIso: "2026-10-21T10:00:00Z", // inside 10/19–25
        notes: {},
      },
      {
        appointmentId: "",
        internalClientId: s.clients.CT2,
        ghlContactExternalId: "CT2",
        cancelledAtIso: "2026-10-02T14:00:00Z",
        attemptsCount: 0,
        anyAnswered: false,
        finalContactStatus: null,
        outcome: "saved_original",
        successorAppointmentId: null,
        recovered: true,
        recoveredAtIso: "2026-10-10T10:00:00Z", // LAST week — excluded
        notes: {},
      },
      {
        appointmentId: "",
        internalClientId: s.clients.CT3,
        ghlContactExternalId: "CT3",
        cancelledAtIso: "2026-10-16T14:00:00Z",
        attemptsCount: 0,
        anyAnswered: false,
        finalContactStatus: null,
        outcome: "pending",
        successorAppointmentId: null,
        recovered: false,
        recoveredAtIso: null, // not recovered — excluded by the §16 predicate
        notes: {},
      },
    ]);
    const q2 = await retentionNeedsAttention(s.store, NOW);
    expect(q2.cancellationsRecoveredThisWeek).toBe(1); // only the in-week recovery
  });

  test("D1: cancellation rows surface the attempt-ledger last contact (never a gap)", async () => {
    const s = await seed();
    await s.store.upsertAppointments([
      {
        id: "",
        acuity_appointment_id: "A5",
        contact_id: (await s.store.getContacts()).find((c) => c.external_id === "CT5")!.id,
        calendar_id: "1335091",
        calendar_name: "MALLORY PORTRAITS",
        appointment_type: "Portrait Session",
        appointment_datetime: "2026-11-02T18:00:00Z",
        created_at: "2026-10-14T18:00:00Z",
        status: "scheduled",
        cancelled: true,
        cancelled_at: "2026-10-15T14:00:00Z",
        raw: null,
      },
    ] as never);
    const appts = await s.store.getAppointmentsWithClientsSince("2026-09-01T00:00:00Z");
    const a5 = appts.find((a) => a.acuity_appointment_id === "A5")!;
    await s.store.insertRetentionCancellations([
      {
        appointmentId: a5.id,
        internalClientId: s.clients.CT5,
        ghlContactExternalId: "CT5",
        cancelledAtIso: "2026-10-15T14:00:00Z",
        attemptsCount: 0,
        anyAnswered: false,
        finalContactStatus: null,
        outcome: "pending",
        successorAppointmentId: null,
        recovered: false,
        recoveredAtIso: null,
        notes: {},
      },
    ]);
    const q = await retentionNeedsAttention(s.store, NOW);
    const eve = q.rows.find((r) => r.clientName === "Eve Ray")!;
    expect(eve.segment).toBe("cancellation");
    expect(eve.lastAttemptAt).toBeNull(); // zero attempts — honestly "— none yet"
    expect(eve.priority).toBe(1);
  });

  test("empty store → empty queue, zero counts (all facts, never fabricated)", async () => {
    const store = new MemoryStore();
    const q = await retentionNeedsAttention(store, NOW);
    expect(q.rows).toEqual([]);
    expect(q.counts).toEqual({ callDue: 0, unreached: 0, windowMissed: 0, needsReview: 0, cancellations: 0 });
    expect(q.cancellationsRecoveredThisWeek).toBe(0);
    expect(q.dueDays).toBe(7);
  });
});
