/**
 * RETENTION TRANSFERS (stage 5) tests — MemoryStore end-to-end over the
 * original-booker-exception engine: clear detection (the cancelled original
 * on calendar A + a qualifying successor on a DIFFERENT known calendar B,
 * created strictly within the reschedule window), the ambiguity gate (unknown
 * successor / unknown original calendar, mixed same-/cross-calendar pools →
 * a transfer_ambiguous Data Match Exceptions row and NEVER a ledger row), the
 * same-calendar reschedule that is NOT a transfer, original-booker
 * attribution (the receiving appointment is evidence only), content-keyed
 * idempotence, the write-once COALESCE fields (detected_at / original
 * calendar), the writer's data-start INDEPENDENCE vs the DISPLAY layer's
 * Oct-12-2026-ET cutoff, the This-Week KPI + share-rate honesty, and the
 * tick's guards (own sync_runs provider, 5-min background throttle, manual
 * bypass, never-fails-the-tick).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  computeRetentionTransfers,
  deriveTransfer,
  TRANSFER_AMBIGUOUS_KIND,
  TRANSFER_BASIS,
  type TransferCandidate,
} from "../retention/transfers";
import { retentionTransfersTick, resetRetentionTransfersThrottle, RETENTION_TRANSFERS_MIN_INTERVAL_MS } from "../retention/transfers-tick";
import { retentionNeedsAttention, retentionOverview } from "../retention/ui-data";

// Fixed clock: 2026-10-20T15:00:00Z (Tue). Module fetch floor =
// today − (lookback 30 + due 7 + 2) ET = 2026-09-11T04:00:00Z; the D13
// lookback window begins 2026-09-20 ET. Retention DISPLAY cutoff = the week
// of Mon 2026-10-12 ET. Current Mon–Sun ET week: Oct 19–25.
const NOW = () => new Date("2026-10-20T15:00:00Z");

const MAIN = "1335091"; // calendar A — the original booker's staff
const OTHER = "12107308"; // calendar B — the receiving staff

interface ApptSpec {
  acuity: string;
  session: string;
  created: string;
  calendarId: string | null;
  calendarName: string | null;
  /** When present the appointment is cancelled with EXACTLY this stamp (the transfer window's anchor). */
  cancelledAt?: string;
  /** Which internal client series this appointment belongs to (the pool is same-client by construction — each scenario gets its own client). */
  client: string;
}

interface Seed {
  store: MemoryStore;
  apptIds: Record<string, string>;
  clientIds: Record<string, string>;
}

async function seedStore(appts: ApptSpec[]): Promise<Seed> {
  const store = new MemoryStore();
  const clientKeys = [...new Set(appts.map((a) => a.client))];
  const clientIds: Record<string, string> = {};
  for (const [i, key] of clientKeys.entries()) {
    const c = await store.insertInternalClient({
      seedKey: `hl-contact:${key}`,
      displayName: `${key} Client`,
      normalizedPhone: `60355512${String(i).padStart(2, "0")}`,
      normalizedEmail: `${key.toLowerCase()}@example.com`,
      ghlContactExternalId: key,
    });
    clientIds[key] = c.id;
    await store.insertClientMatchLinkIfAbsent({ internalClientId: c.id, provider: "highlevel", entity: "contact", externalId: key, matchMethod: "exact_id", confidence: "exact" });
  }
  await store.upsertAppointments(
    appts.map((a) => ({
      id: "",
      acuity_appointment_id: a.acuity,
      contact_id: null,
      calendar_id: a.calendarId,
      calendar_name: a.calendarName,
      appointment_type: "Portrait Session",
      appointment_datetime: a.session,
      created_at: a.created,
      status: "scheduled",
      cancelled: false,
      raw: null,
    })) as never,
  );
  // Cancellations with EXACT stamps (the engine's window anchor) — markAppointmentsCancelled is the memory store's keep-first stamping path.
  for (const a of appts) {
    if (a.cancelledAt) await store.markAppointmentsCancelled([a.acuity], a.cancelledAt, "test");
  }
  // Stage-2 identity chain: acuity/appointment → internal client.
  for (const a of appts) {
    await store.insertClientMatchLinkIfAbsent({ internalClientId: clientIds[a.client]!, provider: "acuity", entity: "appointment", externalId: a.acuity, matchMethod: "exact_id", confidence: "exact" });
  }
  const stored = await store.getAppointmentsWithClientsSince("2026-08-01T00:00:00Z");
  const apptIds: Record<string, string> = {};
  for (const a of stored) if (a.acuity_appointment_id) apptIds[a.acuity_appointment_id] = a.id;
  return { store, apptIds, clientIds };
}

const rowOf = async (s: Seed, acuityId: string) => (await s.store.listRetentionTransfers()).find((r) => r.appointment_id === s.apptIds[acuityId]!) ?? null;
const exceptionsOf = async (s: Seed) => await s.store.getDataMatchExceptions({});

// ---- Scenario timelines (all instants inside the fetch window) ----

/** Clear transfer: cancelled original on MAIN + successor created 1h later on OTHER (same client). */
const CLEAR: ApptSpec[] = [
  { acuity: "T1", session: "2026-10-14T14:00:00Z", created: "2026-10-01T10:00:00Z", calendarId: MAIN, calendarName: "MALLORY PORTRAITS", cancelledAt: "2026-10-13T15:00:00Z", client: "CTT" },
  { acuity: "T2", session: "2026-10-22T14:00:00Z", created: "2026-10-13T16:00:00Z", calendarId: OTHER, calendarName: "ANNEX STUDIO", client: "CTT" },
];
/** Same-calendar rebooking: an ordinary reschedule, never a transfer. */
const SAME_CAL: ApptSpec[] = [
  { acuity: "S1", session: "2026-10-14T14:00:00Z", created: "2026-10-01T10:00:00Z", calendarId: MAIN, calendarName: "MALLORY PORTRAITS", cancelledAt: "2026-10-13T15:00:00Z", client: "CTS" },
  { acuity: "S2", session: "2026-10-22T14:00:00Z", created: "2026-10-13T16:00:00Z", calendarId: MAIN, calendarName: "MALLORY PORTRAITS", client: "CTS" },
];
/** Ambiguous: the successor's calendar is unknown. */
const AMB_SUCC_UNKNOWN: ApptSpec[] = [
  { acuity: "A1", session: "2026-10-14T14:00:00Z", created: "2026-10-01T10:00:00Z", calendarId: MAIN, calendarName: "MALLORY PORTRAITS", cancelledAt: "2026-10-13T15:00:00Z", client: "CTA" },
  { acuity: "A2", session: "2026-10-22T14:00:00Z", created: "2026-10-13T16:00:00Z", calendarId: null, calendarName: null, client: "CTA" },
];
/** Ambiguous: the ORIGINAL's calendar is unknown. */
const AMB_ORIG_UNKNOWN: ApptSpec[] = [
  { acuity: "B1", session: "2026-10-14T14:00:00Z", created: "2026-10-01T10:00:00Z", calendarId: null, calendarName: null, cancelledAt: "2026-10-13T15:00:00Z", client: "CTB" },
  { acuity: "B2", session: "2026-10-22T14:00:00Z", created: "2026-10-13T16:00:00Z", calendarId: OTHER, calendarName: "ANNEX STUDIO", client: "CTB" },
];
/** Ambiguous: the pool MIXES same-calendar and cross-calendar successors. */
const AMB_MIXED: ApptSpec[] = [
  { acuity: "M1", session: "2026-10-14T14:00:00Z", created: "2026-10-01T10:00:00Z", calendarId: MAIN, calendarName: "MALLORY PORTRAITS", cancelledAt: "2026-10-13T15:00:00Z", client: "CTM" },
  { acuity: "M2", session: "2026-10-22T14:00:00Z", created: "2026-10-13T16:00:00Z", calendarId: MAIN, calendarName: "MALLORY PORTRAITS", client: "CTM" },
  { acuity: "M3", session: "2026-10-23T14:00:00Z", created: "2026-10-13T17:00:00Z", calendarId: OTHER, calendarName: "ANNEX STUDIO", client: "CTM" },
];
/** No rebooking at all: the cancellations ledger owns the outcome. */
const NO_REBOOK: ApptSpec[] = [
  { acuity: "X1", session: "2026-10-14T14:00:00Z", created: "2026-10-01T10:00:00Z", calendarId: MAIN, calendarName: "MALLORY PORTRAITS", cancelledAt: "2026-10-13T15:00:00Z", client: "CTX" },
];
/** Pre-cutoff transfer: the ORIGINAL's session (Sat Oct 11 ET) predates the owner's Oct-12-2026-ET display boundary — the WRITER still observes it. */
const PRE_CUTOFF: ApptSpec[] = [
  { acuity: "P1", session: "2026-10-11T14:00:00Z", created: "2026-10-01T10:00:00Z", calendarId: MAIN, calendarName: "MALLORY PORTRAITS", cancelledAt: "2026-10-11T18:00:00Z", client: "CTP" },
  { acuity: "P2", session: "2026-10-15T14:00:00Z", created: "2026-10-11T19:00:00Z", calendarId: OTHER, calendarName: "ANNEX STUDIO", client: "CTP" },
];
/** A plain cancelled original for the share-rate DENOMINATOR (cancelled inside the current ET week, no successor). */
const DENOM: ApptSpec[] = [{ acuity: "CX", session: "2026-10-21T14:00:00Z", created: "2026-10-01T10:00:00Z", calendarId: MAIN, calendarName: "MALLORY PORTRAITS", cancelledAt: "2026-10-20T12:00:00Z", client: "CTY" }];

describe("computeRetentionTransfers — clear detection", () => {
  test("cancelled original on calendar A + successor on different calendar B → ONE ledger row attributed to the ORIGINAL client; the receiving appointment is evidence only", async () => {
    const s = await seedStore(CLEAR);
    const res = await computeRetentionTransfers(s.store, { now: NOW });
    expect(res.outcome).toBe("synced");
    expect(res.transfersEvaluated).toBe(1);
    expect(res.inserted).toBe(1);
    expect(res.notTransfers).toBe(0);
    expect(res.ambiguousQueued).toBe(0);

    const row = await rowOf(s, "T1");
    expect(row).not.toBeNull();
    // ORIGINAL-BOOKER EXCEPTION: the row rides the ORIGINAL booker's client series…
    expect(row!.internal_client_id).toBe(s.clientIds.CTT!);
    expect(row!.ghl_contact_external_id).toBe("CTT");
    // …with the original-side calendar write-once fields copied at detection.
    expect(row!.original_calendar_id).toBe(MAIN);
    expect(row!.original_calendar_name).toBe("MALLORY PORTRAITS");
    // The receiving appointment is recorded as evidence — never its own row.
    expect(row!.receiving_appointment_id).toBe(s.apptIds.T2!);
    expect(row!.receiving_calendar_id).toBe(OTHER);
    expect(row!.basis).toBe(TRANSFER_BASIS);
    expect(row!.detected_at).toBe(NOW().toISOString());
    expect(row!.manual_overrides).toBeNull();
    expect((await s.store.listRetentionTransfers()).length).toBe(1); // exactly ONE row — no receiving-side duplicate
    const notes = row!.notes!;
    expect(notes.original_booker_exception).toContain("ORIGINAL");
    expect((notes.receiving_appointment as { acuity_appointment_id: string }).acuity_appointment_id).toBe("T2");
    expect((notes.reschedule_rule as { confirmed_at_detect: boolean }).confirmed_at_detect).toBe(false);
    expect((notes.reschedule_rule as { candidates: { same_calendar_as_original: boolean }[] }).candidates[0]!.same_calendar_as_original).toBe(false);
  });

  test("every successor rebooked the SAME calendar → an ordinary reschedule, NOT a transfer, NOT ambiguous", async () => {
    const s = await seedStore(SAME_CAL);
    const res = await computeRetentionTransfers(s.store, { now: NOW });
    expect(res.notTransfers).toBe(1);
    expect(res.inserted).toBe(0);
    expect(res.ambiguousQueued).toBe(0);
    expect(await s.store.listRetentionTransfers()).toEqual([]);
    expect(await exceptionsOf(s)).toEqual([]);
  });

  test("no qualifying successor at all → not a transfer (the cancellations ledger owns the outcome)", async () => {
    const s = await seedStore(NO_REBOOK);
    const res = await computeRetentionTransfers(s.store, { now: NOW });
    expect(res.transfersEvaluated).toBe(1);
    expect(res.notTransfers).toBe(1);
    expect(res.inserted).toBe(0);
    expect(await s.store.listRetentionTransfers()).toEqual([]);
  });

  test("deriveTransfer picks the EARLIEST cross-calendar rebooking (tiebreak acuity id) and is total on every fact combination", () => {
    const cand = (acuity: string, created: string, calendarId: string | null): TransferCandidate => ({
      appointmentId: `apt-${acuity}`,
      acuityAppointmentId: acuity,
      calendarId,
      calendarName: calendarId == null ? null : `CAL-${calendarId}`,
      createdAtIso: created,
      appointmentDatetimeIso: "2026-10-22T14:00:00Z",
      appointmentType: "Portrait Session",
    });
    // earliest created_at wins…
    const early = deriveTransfer({ originalCalendarId: MAIN, candidates: [cand("LATE", "2026-10-14T12:00:00Z", OTHER), cand("EARLY", "2026-10-13T18:00:00Z", OTHER)] });
    expect(early.kind).toBe("transfer");
    if (early.kind === "transfer") expect(early.receiving.acuityAppointmentId).toBe("EARLY");
    // …created_at tie → acuity-id tiebreak…
    const tie = deriveTransfer({ originalCalendarId: MAIN, candidates: [cand("ZZ", "2026-10-13T18:00:00Z", OTHER), cand("AA", "2026-10-13T18:00:00Z", OTHER)] });
    if (tie.kind === "transfer") expect(tie.receiving.acuityAppointmentId).toBe("AA");
    // …empty pool → not_transfer; unknown original → ambiguous.
    expect(deriveTransfer({ originalCalendarId: MAIN, candidates: [] }).kind).toBe("not_transfer");
    expect(deriveTransfer({ originalCalendarId: null, candidates: [cand("X", "2026-10-13T18:00:00Z", OTHER)] }).kind).toBe("ambiguous");
  });
});

describe("computeRetentionTransfers — ambiguous evidence (Data Match Exceptions, NEVER a ledger row)", () => {
  test("unknown successor calendar → transfer_ambiguous exception queued, no ledger row", async () => {
    const s = await seedStore(AMB_SUCC_UNKNOWN);
    const res = await computeRetentionTransfers(s.store, { now: NOW });
    expect(res.ambiguousQueued).toBe(1);
    expect(res.inserted).toBe(0);
    expect(await s.store.listRetentionTransfers()).toEqual([]);
    const excs = await exceptionsOf(s);
    expect(excs.length).toBe(1);
    const exc = excs[0]!;
    expect(exc.kind).toBe(TRANSFER_AMBIGUOUS_KIND);
    expect(exc.dedupe_key).toBe(`transfer-ambiguous:${s.apptIds.A1!}`);
    const payload = exc.payload as { ambiguity_rule?: string; subject?: { appointment_id?: string }; internal_client_id?: string };
    expect(payload.subject?.appointment_id).toBe(s.apptIds.A1!);
    expect(payload.internal_client_id).toBe(s.clientIds.CTA!);
    expect(payload.ambiguity_rule).toContain("unknown");
  });

  test("unknown ORIGINAL calendar → ambiguous too (the staff change can be neither proven nor refuted)", async () => {
    const s = await seedStore(AMB_ORIG_UNKNOWN);
    const res = await computeRetentionTransfers(s.store, { now: NOW });
    expect(res.ambiguousQueued).toBe(1);
    expect(res.inserted).toBe(0);
    expect(await s.store.listRetentionTransfers()).toEqual([]);
    const excs = await exceptionsOf(s);
    expect(excs.length).toBe(1);
    expect(excs[0]!.kind).toBe(TRANSFER_AMBIGUOUS_KIND);
  });

  test("mixed same-/cross-calendar pool → ambiguous (which one is the transfer is not decidable)", async () => {
    const s = await seedStore(AMB_MIXED);
    const res = await computeRetentionTransfers(s.store, { now: NOW });
    expect(res.ambiguousQueued).toBe(1);
    expect(res.inserted).toBe(0);
    expect(await s.store.listRetentionTransfers()).toEqual([]);
    const excs = await exceptionsOf(s);
    expect(excs.length).toBe(1);
    const payload = excs[0]!.payload as { ambiguity_rule?: string };
    expect(payload.ambiguity_rule).toContain("mixes");
  });

  test("the ambiguous queue is IF-ABSENT: a second pass dedupes (alreadyQueued) and never double-inserts", async () => {
    const s = await seedStore(AMB_MIXED);
    const first = await computeRetentionTransfers(s.store, { now: NOW });
    expect(first.ambiguousQueued).toBe(1);
    const second = await computeRetentionTransfers(s.store, { now: NOW });
    expect(second.ambiguousQueued).toBe(0);
    expect(second.alreadyQueued).toBe(1);
    expect((await exceptionsOf(s)).length).toBe(1);
    expect(await s.store.listRetentionTransfers()).toEqual([]);
  });
});

describe("computeRetentionTransfers — idempotence + write-once", () => {
  test("a second identical pass adds/removes nothing — one confirmation write (confirmed_at_detect false→true), then every further pass is unchanged", async () => {
    const s = await seedStore(CLEAR);
    const first = await computeRetentionTransfers(s.store, { now: NOW });
    expect(first.inserted).toBe(1);
    // The re-derivation of the EXISTING row upgrades the notes evidence to
    // confirmed_at_detect: true — a genuine, FINITE content change (the store
    // count never moves); every pass after that is a pure no-op.
    const second = await computeRetentionTransfers(s.store, { now: NOW });
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(0);
    expect((await s.store.listRetentionTransfers()).length).toBe(1); // nothing added, nothing removed
    const afterSecond = await rowOf(s, "T1");
    expect(afterSecond!.detected_at).toBe(NOW().toISOString()); // write-once survives re-runs
    expect((afterSecond!.notes!.reschedule_rule as { confirmed_at_detect: boolean }).confirmed_at_detect).toBe(true);
    const third = await computeRetentionTransfers(s.store, { now: NOW });
    expect(third.inserted).toBe(0);
    expect(third.updated).toBe(0);
    expect(third.unchanged).toBe(1);
    expect((await s.store.listRetentionTransfers()).length).toBe(1);
  });

  test("a re-derivation after the sync rewrites the original's calendar keeps the write-once anchor (detected_at + original calendar) and re-derives the receiving side", async () => {
    const s = await seedStore(CLEAR);
    await computeRetentionTransfers(s.store, { now: NOW });
    const before = await rowOf(s, "T1");
    // Acuity upserts rewrite the CURRENT calendar on every sync — the stored
    // row's original-calendar anchor must never move with it.
    await s.store.upsertAppointments([
      { id: s.apptIds.T1!, acuity_appointment_id: "T1", contact_id: null, calendar_id: "9999999", calendar_name: "REWROTE", appointment_type: "Portrait Session", appointment_datetime: "2026-10-14T14:00:00Z", created_at: "2026-10-01T10:00:00Z", status: "cancelled", cancelled: true, raw: null },
    ] as never);
    const res = await computeRetentionTransfers(s.store, { now: NOW });
    expect(res.inserted).toBe(0);
    const after = await rowOf(s, "T1");
    expect(after).not.toBeNull(); // a confirmed transfer is never deleted
    expect(after!.detected_at).toBe(before!.detected_at); // write-once (store COALESCE)
    expect(after!.original_calendar_id).toBe(MAIN); // write-once: the anchor stays at detection-time calendar A
    expect(after!.receiving_appointment_id).toBe(s.apptIds.T2!); // receiving side re-derived from current facts
    expect((await s.store.listRetentionTransfers()).length).toBe(1);
  });

  test("store-level COALESCE: updateRetentionTransfer preserves detected_at + original calendar, updates the receiving fields", async () => {
    const s = await seedStore([]);
    await s.store.insertRetentionTransfers([
      {
        appointmentId: "apt-1",
        internalClientId: "c1",
        ghlContactExternalId: "g1",
        originalCalendarId: "C1",
        originalCalendarName: "N1",
        receivingAppointmentId: "R1",
        receivingCalendarId: "RC1",
        receivingCalendarName: "RN1",
        detectedAtIso: "2026-10-19T10:00:00.000Z",
        basis: "B1",
        notes: { v: 1 },
      },
    ]);
    await s.store.updateRetentionTransfer({
      appointmentId: "apt-1",
      internalClientId: "c1",
      ghlContactExternalId: "g1",
      originalCalendarId: "C2",
      originalCalendarName: "N2",
      receivingAppointmentId: "R2",
      receivingCalendarId: "RC2",
      receivingCalendarName: "RN2",
      detectedAtIso: "2026-10-20T10:00:00.000Z",
      basis: "B2",
      notes: { v: 2 },
    });
    const rows = await s.store.listRetentionTransfers();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.detected_at).toBe("2026-10-19T10:00:00.000Z"); // write-once
    expect(row.original_calendar_id).toBe("C1"); // write-once
    expect(row.original_calendar_name).toBe("N1"); // write-once
    expect(row.receiving_appointment_id).toBe("R2"); // content fields update
    expect(row.notes).toEqual({ v: 2 });
  });
});

describe("computeRetentionTransfers + retention display — data-start scope (writer observes, display filters)", () => {
  test("the WRITER observes pre-cutoff originals in its fetch window (display-layer filter only)", async () => {
    const s = await seedStore([...CLEAR, ...PRE_CUTOFF]);
    const res = await computeRetentionTransfers(s.store, { now: NOW });
    expect(res.inserted).toBe(2); // T1 (in scope) AND P1 (pre-cutoff) — the writer's audit trail stays complete
    expect(await rowOf(s, "P1")).not.toBeNull();
    expect(await rowOf(s, "T1")).not.toBeNull();
  });

  test("the DISPLAY layer filters pre-cutoff transfers: queue rows + counts + overview exclude them; the in-scope transfer shows", async () => {
    const s = await seedStore([...CLEAR, ...PRE_CUTOFF]);
    await computeRetentionTransfers(s.store, { now: NOW });

    const queue = await retentionNeedsAttention(s.store, NOW);
    const transferRows = queue.rows.filter((r) => r.segment === "transfer");
    expect(transferRows.length).toBe(1); // P1 (session Oct 11 ET) hidden by the Oct-12 boundary
    expect(transferRows[0]!.appointmentId).toBe(s.apptIds.T1!);
    expect(transferRows[0]!.clientName).toBe("CTT Client");
    expect(transferRows[0]!.priority).toBe(5); // Records rank — a standing fact, not open work
    expect(transferRows[0]!.drillKpi).toBeNull(); // no drill home → the Action cell renders an honest —
    expect(transferRows[0]!.statusLabel).toBe("Transferred");
    expect(transferRows[0]!.apptDateEt).toBe("2026-10-14"); // the ORIGINAL booking's session
    expect(queue.counts.transfers).toBe(1);

    const overview = await retentionOverview(s.store, NOW);
    expect(overview.transfersTotal).toBe(1);
    expect(overview.transfersThisWeek).toBe(1); // detected_at = NOW, inside the Mon Oct 19–Sun Oct 25 ET week
    expect(overview.transfersRate).toBeNull(); // no tracked cancellations this week → honest — (never a fabricated 0%)
  });

  test("the share rate exists only with a real denominator (tracked cancellations cancelled this week)", async () => {
    const s = await seedStore([...CLEAR, ...DENOM]);
    await computeRetentionTransfers(s.store, { now: NOW });
    // Seed the stage-4a cancellations ledger directly: CX cancelled THIS week (display-scoped) → the denominator exists.
    await s.store.insertRetentionCancellations([
      {
        appointmentId: s.apptIds.CX!,
        internalClientId: s.clientIds.CTY!,
        ghlContactExternalId: "CTY",
        cancelledAtIso: "2026-10-20T12:00:00Z",
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
    const overview = await retentionOverview(s.store, NOW);
    expect(overview.transfersThisWeek).toBe(1);
    expect(overview.transfersRate).not.toBeNull();
    expect(overview.transfersRate).toBeCloseTo(1 / 1, 10); // 1 transfer ÷ 1 tracked cancellation this week
    expect(overview.transfersTotal).toBe(1);
  });
});

describe("retentionTransfersTick — the scheduler wiring", () => {
  test("runs the engine under its own sync_runs provider; background re-runs inside the throttle skip; manual bypasses it", async () => {
    resetRetentionTransfersThrottle(); // module-level throttle may carry real-clock state from other test files
    const s = await seedStore(CLEAR);
    const manual = await retentionTransfersTick({ store: s.store, now: NOW, trigger: "manual" });
    expect(manual.outcome).toBe("synced");
    const runs = await s.store.getSyncRuns(10);
    const mine = runs.filter((r) => r.provider === "retention-transfers");
    expect(mine.length).toBe(1);
    expect(mine[0]!.status).toBe("success");
    expect(mine[0]!.records_upserted).toBe(1);

    // The throttle arms only on background passes: first background runs, the
    // +4:59 re-run skips, the +5:01 re-run runs again, manual always bypasses.
    const bg = await retentionTransfersTick({ store: s.store, now: NOW, trigger: "background" });
    expect(bg.outcome).toBe("synced");
    const bgSoon = await retentionTransfersTick({ store: s.store, now: () => new Date(NOW().getTime() + RETENTION_TRANSFERS_MIN_INTERVAL_MS - 1_000), trigger: "background" });
    expect(bgSoon.outcome).toBe("skipped");
    const bgLater = await retentionTransfersTick({ store: s.store, now: () => new Date(NOW().getTime() + RETENTION_TRANSFERS_MIN_INTERVAL_MS + 1_000), trigger: "background" });
    expect(bgLater.outcome).toBe("synced");
    const manualAgain = await retentionTransfersTick({ store: s.store, now: () => new Date(NOW().getTime() + RETENTION_TRANSFERS_MIN_INTERVAL_MS + 2_000), trigger: "manual" });
    expect(manualAgain.outcome).toBe("synced"); // idempotent — synced with zero writes
    if (manualAgain.outcome === "synced") {
      expect(manualAgain.inserted).toBe(0);
      expect(manualAgain.updated).toBe(0);
    }
  });

  test("an in-flight run of the same provider skips the tick (running guard)", async () => {
    resetRetentionTransfersThrottle();
    const s = await seedStore(CLEAR);
    const runId = await s.store.insertSyncRun("retention-transfers"); // a live run is in progress
    const res = await retentionTransfersTick({ store: s.store, now: NOW, trigger: "manual" });
    expect(res.outcome).toBe("skipped");
    if (res.outcome === "skipped") expect(res.reason).toBe("sync-in-progress");
    await s.store.finishSyncRun(runId, "success", 0, null);
    const after = await retentionTransfersTick({ store: s.store, now: NOW, trigger: "manual" });
    expect(after.outcome).toBe("synced");
  });

  test("an engine failure never throws — the tick records the error and returns honestly", async () => {
    resetRetentionTransfersThrottle();
    const s = await seedStore(CLEAR);
    // A store whose getSettings rejects — the engine's first read.
    const broken = new Proxy(s.store, {
      get(target, prop, recv) {
        if (prop === "getSettings") return () => Promise.reject(new Error("settings read failed"));
        return Reflect.get(target, prop, recv);
      },
    });
    const res = await retentionTransfersTick({ store: broken as unknown as MemoryStore, now: NOW, trigger: "manual" });
    expect(res.outcome).toBe("error");
    if (res.outcome === "error") expect(res.error).toContain("settings read failed");
    const runs = await s.store.getSyncRuns(10);
    const mine = runs.filter((r) => r.provider === "retention-transfers");
    expect(mine[0]!.status).toBe("error");
  });
});
