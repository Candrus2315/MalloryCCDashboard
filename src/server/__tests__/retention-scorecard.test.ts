/**
 * RETENTION WEEKLY SCORECARD tests (stage 3c) — MemoryStore end-to-end.
 * Covers: the §16 metric formulas over a deterministic Mon–Sun ET week
 * (eligible / called / spoke-with / unreached incl. both unreached arms —
 * open window vs closed-with-zero-answered —, both compliance flavors,
 * Needs Review, match-exceptions snapshot, owner from history), week
 * BOUNDARY (due on the next Monday is the next week's), NULL cancellation
 * family (no writers yet — never 0), IDEMPOTENCE (double-compute → identical
 * row, no rewrite, computed_at preserved), the MONDAY ≥06:00 ET trigger
 * (skip on other days / before 06:00, compute on/after), the
 * already-stored no-op, MANUAL trigger, and the ONE-bounded-attempt BOOT
 * BACKFILL.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { computeRetention } from "../retention/compute";
import {
  buildScorecardWrite,
  computeAndStoreWeeklyScorecard,
  etDayOfWeek,
  priorCompletedWeekEt,
  retentionOwnerForWeek,
  RETENTION_SCORECARD_VERSION,
} from "../retention/scorecard";
import {
  ensureRetentionScorecardBootBackfill,
  resetRetentionScorecardBootBackfill,
  resetRetentionScorecardThrottle,
  retentionScorecardTick,
  SCORECARD_COMPUTE_MINUTES_ET,
} from "../retention/scorecard-tick";

// Fixed clock: MONDAY 2026-10-26 15:00Z = 11:00 ET → prior completed
// Mon–Sun ET week = 2026-10-19 .. 2026-10-25 (due dates 10/19..10/25 ←
// sessions 10/26..11/01).
const NOW = () => new Date("2026-10-26T15:00:00Z");
const WEEK_START = "2026-10-19";
const WEEK_END = "2026-10-25";

interface Seed {
  store: MemoryStore;
  lauraId: string;
  apptIds: Record<string, string>;
  clientIds: Record<string, string>;
}

async function seed(): Promise<Seed> {
  const store = new MemoryStore();
  await store.upsertUsers([
    { id: "", provider: "highlevel", external_id: "LAU", name: "Laura Rivera", email: "laura@mallory.test", is_active: false, call_start_date: null },
  ] as never);
  const users = await store.getAllUsers();
  const lauraId = users.find((u) => u.external_id === "LAU")!.id;

  await store.upsertContacts([
    { id: "", provider: "highlevel", external_id: "CT1", name: "Jane Doe", phone: "(603) 555-1212", email: "jane@example.com", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT2", name: "Bob Roe", phone: "2125550101", email: "bob@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT3", name: "Carol Ray", phone: "2125550102", email: "carol@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT4", name: "Dave Fox", phone: "2125550103", email: "dave@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT5", name: "Erin Coy", phone: "2125550104", email: "erin@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT6", name: "Frank Owl", phone: "2125550105", email: "frank@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT7", name: "Grace Eel", phone: "2125550106", email: "grace@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
  ] as never);
  const contacts = await store.getContacts();
  const cid: Record<string, string> = {};
  for (const c of contacts) cid[c.external_id!] = c.id;

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
  // Cohort for the 10/19–10/25 week (due = appt − 7):
  //  A1 Jane  10/26 → due 10/19 · voicemail attempt  → voicemail, closed window, zero answered → §16 "unreached"? NO — voicemail is its own outcome (not in the unreached status set).
  //  A2 Bob   10/27 → due 10/20 · completed 120s     → verified_spoke_with (the one spoken-with).
  //  A3 Carol 10/28 → due 10/21 · ZERO attempts      → attempted_unclear, OPEN window → unreached.
  //  A4 Dave  10/29 → due 10/22 · no-answer attempt  → no_answer, OPEN window → unreached.
  //  A5 Erin  10/30 → due 10/23 · SWC note, NO call  → needs_review (D5).
  //  A7 Grace 10/26 → due 10/19 · ZERO attempts      → attempted_unclear, window CLOSED (past) + zero answered → unreached (other arm).
  //  A6 Frank 11/02 → due 10/26 → NEXT week's first due date — boundary exclusion.
  await store.upsertAppointments([
    appt("A1", cid.CT1!, "2026-10-26T14:00:00Z", null),
    appt("A2", cid.CT2!, "2026-10-27T14:00:00Z", null),
    appt("A3", cid.CT3!, "2026-10-28T14:00:00Z", null),
    appt("A4", cid.CT4!, "2026-10-29T14:00:00Z", null),
    appt("A5", cid.CT5!, "2026-10-30T14:00:00Z", "SWC LR 10/23/26 intake done"),
    appt("A6", cid.CT6!, "2026-11-02T14:00:00Z", null),
    appt("A7", cid.CT7!, "2026-10-26T14:00:00Z", null),
  ] as never);
  const appts = await store.getAppointmentsWithClientsSince("2026-09-01T00:00:00Z");
  const apptIds: Record<string, string> = {};
  for (const a of appts) apptIds[a.acuity_appointment_id!] = a.id;

  const link = async (ext: string) => {
    const client = await store.insertInternalClient({ seedKey: `hl-contact:${ext}`, displayName: contacts.find((c) => c.external_id === ext)!.name ?? ext, normalizedPhone: contacts.find((c) => c.external_id === ext)!.phone ?? "", normalizedEmail: contacts.find((c) => c.external_id === ext)!.email ?? "", ghlContactExternalId: ext });
    await store.insertClientMatchLinkIfAbsent({ internalClientId: client.id, provider: "highlevel", entity: "contact", externalId: ext, matchMethod: "exact_id", confidence: "exact" });
    return client;
  };
  const clients: Record<string, Awaited<ReturnType<typeof link>>> = {};
  for (const ext of ["CT1", "CT2", "CT3", "CT4", "CT5", "CT6", "CT7"]) clients[ext] = await link(ext);
  for (const [ext, apptExt] of [["CT1", "A1"], ["CT2", "A2"], ["CT3", "A3"], ["CT4", "A4"], ["CT5", "A5"], ["CT6", "A6"], ["CT7", "A7"]] as const) {
    await store.insertClientMatchLinkIfAbsent({ internalClientId: clients[ext]!.id, provider: "acuity", entity: "appointment", externalId: apptExt, matchMethod: "exact_id", confidence: "exact" });
  }

  const call = (externalId: string, contactId: string, datetime: string, status: string, duration: number) => ({
    provider: "highlevel",
    external_call_id: externalId,
    rep_id: lauraId,
    contact_id: contactId,
    started_at: datetime,
    duration_seconds: duration,
    over_two_minutes: duration > 120,
    direction: "outbound",
    call_status: status,
    provider_rep_external_id: "LAU",
  });
  await store.upsertCalls([
    call("MSG1", cid.CT1!, "2026-10-19T15:00:00Z", "voicemail", 47), // A1
    call("MSG2", cid.CT2!, "2026-10-20T15:00:00Z", "completed", 120), // A2 → spoke with
    call("MSG3", cid.CT4!, "2026-10-22T15:00:00Z", "no-answer", 0), // A4
  ] as never);

  // Retention Owner of the scored week (role history; never hard-coded).
  store.seedRetentionOwnerHistory([
    { employee_user_id: lauraId, name: "Laura Rivera", initials: "LR", active: true, effective_start: "2026-10-01", effective_end: null },
  ]);

  return { store, lauraId, apptIds, clientIds: Object.fromEntries(Object.entries(clients).map(([k, v]) => [k, v.id])) };
}

describe("priorCompletedWeekEt + etDayOfWeek", () => {
  test("Monday → prior Mon–Sun; other days → the still-running week is NOT scored", () => {
    expect(etDayOfWeek("2026-10-26")).toBe(1); // Monday
    expect(etDayOfWeek("2026-10-25")).toBe(0); // Sunday
    expect(priorCompletedWeekEt("2026-10-26")).toEqual({ weekStart: "2026-10-19", weekEnd: "2026-10-25" });
    // On a Sunday the "prior completed week" is still the RUNNING week's predecessor —
    // completed weeks are only ever Mon–Sun windows fully in the past:
    expect(priorCompletedWeekEt("2026-10-25")).toEqual({ weekStart: "2026-10-12", weekEnd: "2026-10-18" });
  });
});

describe("computeAndStoreWeeklyScorecard — §16 formulas", () => {
  test("computes the prior completed week verbatim; boundary + null family", async () => {
    const s = await seed();
    const compute = await computeRetention(s.store, { now: NOW });
    expect(compute.outcome).toBe("synced");

    const res = await computeAndStoreWeeklyScorecard(s.store, { weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW });
    expect(res.outcome).toBe("computed");
    expect(res.created).toBe(true);

    const rows = await s.store.listRetentionScorecards();
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.week_start).toBe(WEEK_START);
    expect(r.week_end).toBe(WEEK_END);
    expect(r.due_days).toBe(7);
    // Cohort: A1..A5 + A7 due in-week; A6 (due 10/26) is NEXT week's — excluded.
    expect(r.eligible).toBe(6);
    // Called ≥1 in-window attempt: A1, A2, A4.
    expect(r.called).toBe(3);
    // Spoke with: A2 only.
    expect(r.spoken_with).toBe(1);
    // Unreached (§16 verbatim): A3 (open window, zero attempts), A4 (open, no-answer), A7 (closed + zero answered).
    // A1 is VOICEMAIL — its own outcome, NOT in the unreached status set.
    expect(r.unreached).toBe(3);
    expect(r.compliance_appointment).toBeCloseTo(1 / 6, 6);
    expect(r.compliance_attempt).toBeCloseTo(3 / 6, 6);
    expect(r.needs_review).toBe(1); // A5 (SWC note, no call — D5)
    expect(r.match_exceptions).toBe(await s.store.countDataMatchExceptions("open"));
    // Cancellation family + no-shows + transfers: no writers yet — null, never 0.
    expect(r.cancellations_worked).toBeNull();
    expect(r.saves).toBeNull();
    expect(r.reschedules).toBeNull();
    expect(r.recoveries).toBeNull();
    expect(r.recovery_rate).toBeNull();
    expect(r.no_shows).toBeNull();
    expect(r.no_shows_spoken).toBeNull();
    expect(r.no_shows_not_spoken).toBeNull();
    expect(r.transfers).toBeNull();
    // Owner resolved from retention_owner_history (never hard-coded).
    expect(r.owner_name).toBe("Laura Rivera");
    expect(r.owner_initials).toBe("LR");
    expect(r.owner_user_id).toBe(s.lauraId);
    expect(r.compute_version).toBe(RETENTION_SCORECARD_VERSION);
    expect(r.computed_at).toBeTruthy();
  });

  test("double-compute is idempotent: identical row, no rewrite, computed_at preserved", async () => {
    const s = await seed();
    await computeRetention(s.store, { now: NOW });
    const r1 = await computeAndStoreWeeklyScorecard(s.store, { weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW });
    expect(r1.outcome).toBe("computed");
    const rows1 = await s.store.listRetentionScorecards();
    const r2 = await computeAndStoreWeeklyScorecard(s.store, { weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW });
    expect(r2.outcome).toBe("already-stored");
    expect(r2.created).toBe(false);
    const rows2 = await s.store.listRetentionScorecards();
    expect(rows2.length).toBe(1);
    expect(JSON.parse(JSON.stringify(rows2[0]))).toEqual(JSON.parse(JSON.stringify(rows1[0])));
    // Even a changed data world does NOT rewrite a stored week:
    await computeRetention(s.store, { now: NOW }); // re-run writes nothing anyway
    const r3 = await computeAndStoreWeeklyScorecard(s.store, { weekStart: WEEK_START, weekEnd: WEEK_END, now: () => new Date("2026-11-02T15:00:00Z") });
    expect(r3.outcome).toBe("already-stored");
    expect((await s.store.listRetentionScorecards()).length).toBe(1);
  });

  test("buildScorecardWrite: zero-eligible week → null ratios (never 0%/100%)", () => {
    const w = buildScorecardWrite({
      weekStart: "2026-10-12",
      weekEnd: "2026-10-18",
      dueDays: 7,
      cohort: [],
      calledCount: 0,
      spokenWithCount: 0,
      unreachedCount: 0,
      needsReviewCount: 0,
      matchExceptionsOpen: 2,
      owner: null,
    });
    expect(w.eligible).toBe(0);
    expect(w.complianceAppointment).toBeNull();
    expect(w.complianceAttempt).toBeNull();
    expect(w.match_exceptions).toBe(2);
  });
});

describe("retentionOwnerForWeek (plan §12 effective dates)", () => {
  test("resolves the owner effective at the week's close; empty history → null", () => {
    const laura = { id: "r1", employee_user_id: "u1", name: "Laura Rivera", initials: "LR", active: true, effective_start: "2026-10-01", effective_end: null };
    const next = { id: "r2", employee_user_id: "u2", name: "Next Owner", initials: "NO", active: true, effective_start: "2026-10-26", effective_end: null };
    // Week ending 10/25 → Laura (effective at week_end); a mid-window future row never leaks backward.
    expect(retentionOwnerForWeek([laura, next], "2026-10-25")?.name).toBe("Laura Rivera");
    // Week ending 11/01 → the successor.
    expect(retentionOwnerForWeek([laura, next], "2026-11-01")?.name).toBe("Next Owner");
    expect(retentionOwnerForWeek([], "2026-10-25")).toBeNull();
  });
});

describe("retentionScorecardTick — Monday ~06:00 ET trigger", () => {
  test("background: Monday ≥06:00 ET computes the prior week; re-tick is already-stored", async () => {
    resetRetentionScorecardThrottle();
    const s = await seed();
    await computeRetention(s.store, { now: NOW });
    const first = await retentionScorecardTick({ store: s.store, now: NOW, trigger: "background" });
    expect(first.outcome).toBe("computed");
    // Within the check throttle the next background tick skips; past the
    // throttle the stored-week guard makes the re-tick an already-stored no-op.
    const throttled = await retentionScorecardTick({ store: s.store, now: NOW, trigger: "background" });
    expect(throttled).toEqual({ outcome: "skipped", reason: "recent-check" });
    resetRetentionScorecardThrottle();
    const second = await retentionScorecardTick({ store: s.store, now: NOW, trigger: "background" });
    expect(second.outcome).toBe("already-stored");
    expect((await s.store.listRetentionScorecards()).length).toBe(1);
  });

  test("background: non-Monday and pre-06:00 ET skip", async () => {
    resetRetentionScorecardThrottle();
    const s = await seed();
    const sunday = await retentionScorecardTick({ store: s.store, now: () => new Date("2026-10-25T15:00:00Z"), trigger: "background" });
    expect(sunday).toEqual({ outcome: "skipped", reason: "not-monday" });
    const pre0600 = await retentionScorecardTick({ store: s.store, now: () => new Date("2026-10-26T09:59:00Z"), trigger: "background" });
    expect(pre0600).toEqual({ outcome: "skipped", reason: "before-0600-et" });
    // exactly 06:00 ET unlocks
    const at0600 = await retentionScorecardTick({ store: s.store, now: () => new Date("2026-10-26T10:00:00Z"), trigger: "background" });
    expect(at0600.outcome).toBe("computed");
  });

  test("manual trigger computes on any day (SYNC NOW semantics)", async () => {
    resetRetentionScorecardThrottle();
    const s = await seed();
    await computeRetention(s.store, { now: NOW });
    const manual = await retentionScorecardTick({ store: s.store, now: () => new Date("2026-10-28T15:00:00Z"), trigger: "manual" });
    expect(manual.outcome).toBe("computed");
  });

  test("SCORECARD_COMPUTE_MINUTES_ET is 06:00 ET", () => {
    expect(SCORECARD_COMPUTE_MINUTES_ET).toBe(360);
  });
});

describe("ensureRetentionScorecardBootBackfill — one bounded attempt", () => {
  test("backfills the most recent missing week once; second call is a no-op", async () => {
    resetRetentionScorecardBootBackfill();
    const s = await seed();
    await computeRetention(s.store, { now: NOW });
    const first = await ensureRetentionScorecardBootBackfill({ store: s.store, now: () => new Date("2026-10-27T15:00:00Z") });
    expect(first.outcome).toBe("computed");
    expect((await s.store.listRetentionScorecards()).length).toBe(1);
    const second = await ensureRetentionScorecardBootBackfill({ store: s.store, now: () => new Date("2026-10-27T15:05:00Z") });
    expect(second).toEqual({ outcome: "skipped", reason: "boot-backfill-already-attempted" });
    expect((await s.store.listRetentionScorecards()).length).toBe(1);
  });

  test("already-stored week → already-stored (attempt consumed, no write)", async () => {
    resetRetentionScorecardBootBackfill();
    const s = await seed();
    await computeRetention(s.store, { now: NOW });
    await computeAndStoreWeeklyScorecard(s.store, { weekStart: WEEK_START, weekEnd: WEEK_END, now: NOW });
    const res = await ensureRetentionScorecardBootBackfill({ store: s.store, now: NOW });
    expect(res.outcome).toBe("already-stored");
    expect((await s.store.listRetentionScorecards()).length).toBe(1);
  });
});
