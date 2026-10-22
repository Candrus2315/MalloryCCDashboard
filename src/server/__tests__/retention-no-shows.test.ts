/**
 * RETENTION NO-SHOW PIPELINE tests (stage 4b) — MemoryStore end-to-end over
 * the D10 detection engine: detection basics, the STRICT passed-boundary, the
 * module fetch-window boundary, identity honesty (unlinked counted, never
 * written), idempotent diff-writes (re-runs write nothing), the follow-up
 * state machine (cancelled-after-no-show, rescheduled-after-no-show,
 * rebooked, write-once session/detected stamps), the writer's data-start
 * independence (writers observe everything; the DISPLAY layer filters), and
 * the tick's guards (sync_runs provider, 5-min background throttle, manual
 * bypass, never-fails-the-tick).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import { computeRetentionNoShows, deriveNoShowState, type NoShowStateDerivation } from "../retention/no-shows";
import { retentionNoShowTick } from "../retention/no-shows-tick";

// Fixed clock: 2026-10-20T15:00:00Z (Tue). The module fetch floor is
// today − (lookback 30 + due 7 + 2) ET = 2026-09-11T04:00:00Z.
const NOW = () => new Date("2026-10-20T15:00:00Z");

interface Seed {
  store: MemoryStore;
  apptIds: Record<string, string>;
  clientIds: Record<string, string>;
}

async function seed(extraAppts: Record<string, { datetime: string; cancelled?: boolean; status?: string; created?: string }> = {}): Promise<Seed> {
  const store = new MemoryStore();
  await store.upsertContacts([
    { id: "", provider: "highlevel", external_id: "CT1", name: "Jane Doe", phone: "(603) 555-1212", email: "jane@example.com", assigned_rep_id: null, created_at: NOW().toISOString() },
    { id: "", provider: "highlevel", external_id: "CT2", name: "Bob Roe", phone: "2125550101", email: "bob@other.org", assigned_rep_id: null, created_at: NOW().toISOString() },
  ] as never);
  const base: Record<string, { datetime: string; cancelled?: boolean; status?: string; created?: string }> = {
    // passed + still scheduled + resolved client → the D10 no-show
    NS1: { datetime: "2026-10-16T14:00:00Z", created: "2026-10-01T10:00:00Z" },
    // future session → never a no-show
    NS2: { datetime: "2026-10-26T14:00:00Z", created: "2026-10-01T10:00:00Z" },
    // passed but cancelled → belongs to the stage-4a cancellations ledger
    NS3: { datetime: "2026-10-16T15:00:00Z", cancelled: true, status: "cancelled", created: "2026-10-01T10:00:00Z" },
    // passed + still scheduled, but the session predates the module fetch floor
    // (created_at inside the window so the row IS fetched — counted, not written)
    NS4: { datetime: "2026-09-05T14:00:00Z", created: "2026-09-12T10:00:00Z" },
    // passed + still scheduled, no client link → unlinked (counted honestly)
    NS5: { datetime: "2026-10-17T14:00:00Z", created: "2026-10-01T10:00:00Z" },
    // boundary: session start EXACTLY at now → D10 is strict (< now) → not a no-show
    B1: { datetime: "2026-10-20T15:00:00Z", created: "2026-10-01T10:00:00Z" },
    // boundary: one millisecond earlier → a no-show
    B2: { datetime: "2026-10-20T14:59:59.999Z", created: "2026-10-01T10:00:00Z" },
    // pre-cutoff session (before the week of Mon Oct 12 2026 ET) — the WRITER
    // observes everything in its fetch window; the DISPLAY layer filters
    PRE: { datetime: "2026-10-05T14:00:00Z", created: "2026-10-01T10:00:00Z" },
    ...extraAppts,
  };
  const apptRows = Object.entries(base).map(([acuityId, o]) => ({
    id: "",
    acuity_appointment_id: acuityId,
    contact_id: acuityId === "NS5" ? null : null,
    calendar_id: "1335091",
    calendar_name: "MALLORY PORTRAITS",
    appointment_type: "Portrait Session",
    appointment_datetime: o.datetime,
    created_at: o.created ?? "2026-10-01T10:00:00Z",
    status: o.status ?? "scheduled",
    cancelled: o.cancelled ?? false,
    raw: null,
  }));
  await store.upsertAppointments(apptRows as never);
  const appts = await store.getAppointmentsWithClientsSince("2026-08-01T00:00:00Z");
  const apptIds: Record<string, string> = {};
  for (const a of appts) if (a.acuity_appointment_id) apptIds[a.acuity_appointment_id] = a.id;

  const clientIds: Record<string, string> = {};
  for (const [ext, name, phone] of [["CT1", "Jane Doe", "6035551212"], ["CT2", "Bob Roe", "2125550101"]] as const) {
    const c = await store.insertInternalClient({ seedKey: `hl-contact:${ext}`, displayName: name, normalizedPhone: phone, normalizedEmail: `${ext.toLowerCase()}@example.com`, ghlContactExternalId: ext });
    clientIds[ext] = c.id;
    await store.insertClientMatchLinkIfAbsent({ internalClientId: c.id, provider: "highlevel", entity: "contact", externalId: ext, matchMethod: "exact_id", confidence: "exact" });
  }
  // Every appointment except NS5 links to CT1 (the stage-2 chain).
  for (const acuityId of Object.keys(base)) {
    if (acuityId === "NS5") continue;
    await store.insertClientMatchLinkIfAbsent({ internalClientId: clientIds.CT1!, provider: "acuity", entity: "appointment", externalId: acuityId, matchMethod: "exact_id", confidence: "exact" });
  }
  return { store, apptIds, clientIds };
}

const rowOf = async (s: Seed, acuityId: string) => (await s.store.listRetentionNoShows()).find((r) => r.appointment_id === s.apptIds[acuityId]!) ?? null;

describe("computeRetentionNoShows — detection (D10)", () => {
  test("detects a passed, still-scheduled, in-scope, client-resolved appointment; skips future/cancelled/boundary/unlinked/below-floor", async () => {
    const s = await seed();
    const res = await computeRetentionNoShows(s.store, { now: NOW });
    expect(res.outcome).toBe("synced");
    expect(res.inserted).toBe(3); // NS1 + B2 + PRE (CT1) — NS5 unlinked, NS2 future, NS3 cancelled, NS4 below floor, B1 exactly-now
    expect(res.noShowsEvaluated).toBe(3);
    expect(res.unlinkedNoShows).toBe(1);
    expect(res.unlinkedAcuityIds).toEqual(["NS5"]);
    expect(res.belowFetchFloor).toBe(1);

    const row = await rowOf(s, "NS1");
    expect(row).not.toBeNull();
    expect(row!.session_at).toBe("2026-10-16T14:00:00Z"); // MemoryStore echoes the stored ISO verbatim; pg normalizes (.000Z)
    expect(row!.session_date_et).toBe("2026-10-16"); // D10 ranges by APPOINTMENT date
    expect(row!.state).toBe("open");
    expect(row!.detected_at).toBe(NOW().toISOString());
    expect(row!.internal_client_id).toBe(s.clientIds.CT1!);
    expect(row!.ghl_contact_external_id).toBe("CT1");
    expect(row!.notes!.detection_basis).toContain("D10");
    // the future, cancelled, exactly-now and below-floor appointments have NO row
    for (const acuityId of ["NS2", "NS3", "NS4", "B1", "NS5"]) {
      expect(await rowOf(s, acuityId)).toBeNull();
    }
    // the writer observes pre-cutoff sessions (display filters, never the writer)
    expect(await rowOf(s, "PRE")).not.toBeNull();
});
});

describe("computeRetentionNoShows — idempotence (content-keyed diff)", () => {
  test("a second identical pass writes nothing", async () => {
    const s = await seed();
    const first = await computeRetentionNoShows(s.store, { now: NOW });
    expect(first.inserted).toBe(3);
    const second = await computeRetentionNoShows(s.store, { now: NOW });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(3);
    expect((await s.store.listRetentionNoShows()).length).toBe(4);
    const row = await rowOf(s, "NS1");
    expect(row!.detected_at).toBe(NOW().toISOString()); // write-once survives re-runs
  });
});

describe("computeRetentionNoShows — follow-up state machine", () => {
  test("cancelled-after-no-show: the row is KEPT (never deleted), state records the cancellation, write-once stamps survive", async () => {
    const s = await seed();
    await computeRetentionNoShows(s.store, { now: NOW });
    const before = await rowOf(s, "NS1");
    // the sync later confirms the cancellation (Acuity's list never shows it —
    // the reconciliation path flips the stored row)
    await s.store.upsertAppointments([
      { id: s.apptIds.NS1!, acuity_appointment_id: "NS1", contact_id: null, calendar_id: "1335091", calendar_name: "MALLORY PORTRAITS", appointment_type: "Portrait Session", appointment_datetime: "2026-10-16T14:00:00Z", created_at: "2026-10-01T10:00:00Z", status: "cancelled", cancelled: true, raw: null },
    ] as never);
    const res = await computeRetentionNoShows(s.store, { now: NOW });
    expect(res.updated).toBe(1);
    const after = await rowOf(s, "NS1");
    expect(after).not.toBeNull(); // the missed session happened — the row STAYS
    expect(after!.state).toBe("cancelled_after_no_show");
    expect(after!.detected_at).toBe(before!.detected_at); // write-once
    expect(after!.session_at).toBe(before!.session_at); // write-once
    expect((await s.store.listRetentionNoShows()).length).toBe(3); // no duplicates
  });

  test("rescheduled-after-no-show: the datetime moving forward keeps the row with the ORIGINAL missed session; the move rides the notes — and a session moved forward BEFORE any pass never detects", async () => {
    const s = await seed();
    await computeRetentionNoShows(s.store, { now: NOW });
    const before = await rowOf(s, "NS1");
    await s.store.upsertAppointments([
      { id: s.apptIds.NS1!, acuity_appointment_id: "NS1", contact_id: null, calendar_id: "1335091", calendar_name: "MALLORY PORTRAITS", appointment_type: "Portrait Session", appointment_datetime: "2026-10-27T14:00:00Z", created_at: "2026-10-01T10:00:00Z", status: "scheduled", cancelled: false, raw: null },
    ] as never);
    const res = await computeRetentionNoShows(s.store, { now: NOW });
    expect(res.updated).toBe(1);
    const after = await rowOf(s, "NS1");
    expect(after!.state).toBe("rescheduled_after_no_show");
    expect(after!.session_at).toBe(before!.session_at); // the MISSED session, never moved
    expect(after!.detected_at).toBe(before!.detected_at);
    expect(after!.notes!.rescheduled_to).toBe("2026-10-27T14:00:00.000Z");

    // moved-before-detection: a session in the future by the time ANY pass looks is simply not a no-show
    const s2 = await seed({ MOVED: { datetime: "2026-10-30T14:00:00Z", created: "2026-10-01T10:00:00Z" } });
    const res2 = await computeRetentionNoShows(s2.store, { now: NOW });
    expect(res2.inserted).toBe(3); // MOVED adds nothing
    expect(await rowOf(s2, "MOVED")).toBeNull();
  });

  test("rebooked: a qualifying successor created AFTER detection (within the reschedule window) advances the state and names the real appointment row", async () => {
    const s = await seed();
    await computeRetentionNoShows(s.store, { now: NOW });
    const later = () => new Date("2026-10-21T15:00:00Z");
    await s.store.upsertAppointments([
      { id: "", acuity_appointment_id: "REBOOK", contact_id: null, calendar_id: "1335091", calendar_name: "MALLORY PORTRAITS", appointment_type: "Portrait Session", appointment_datetime: "2026-10-28T14:00:00Z", created_at: "2026-10-20T16:00:00Z", status: "scheduled", cancelled: false, raw: null },
    ] as never);
    await s.store.insertClientMatchLinkIfAbsent({ internalClientId: s.clientIds.CT1!, provider: "acuity", entity: "appointment", externalId: "REBOOK", matchMethod: "exact_id", confidence: "exact" });
    const res = await computeRetentionNoShows(s.store, { now: later });
    expect(res.updated).toBe(3); // every open no-show of the SAME client is answered by the rebooking
    const after = await rowOf(s, "NS1");
    expect(after!.state).toBe("rebooked");
    const rebookId = (await s.store.getAppointmentsWithClientsSince("2026-08-01T00:00:00Z")).find((a) => a.acuity_appointment_id === "REBOOK")!.id;
    expect(after!.successor_appointment_id).toBe(rebookId);
});
});

describe("deriveNoShowState — the pure precedence chain", () => {
  test("cancelled > rescheduled > rebooked > open; a missing datetime never claims a move", () => {
    const d = (o: { cancelled: boolean; currentSessionMs: number | null; successor: { appointmentId: string } | null; nowMs: number }): NoShowStateDerivation["state"] => deriveNoShowState(o).state;
    const nowMs = Date.parse("2026-10-20T15:00:00Z");
    expect(d({ cancelled: true, currentSessionMs: nowMs - 1000, successor: { appointmentId: "x" }, nowMs })).toBe("cancelled_after_no_show");
    expect(d({ cancelled: false, currentSessionMs: nowMs + 1000, successor: { appointmentId: "x" }, nowMs })).toBe("rescheduled_after_no_show");
    expect(d({ cancelled: false, currentSessionMs: nowMs - 1000, successor: { appointmentId: "x" }, nowMs })).toBe("rebooked");
    expect(d({ cancelled: false, currentSessionMs: nowMs - 1000, successor: null, nowMs })).toBe("open");
    // missing/unparseable current datetime + no cancellation → no claimed move
    expect(d({ cancelled: false, currentSessionMs: null, successor: null, nowMs })).toBe("open");
  });
});

describe("retentionNoShowTick — the scheduler wiring", () => {
  test("runs the engine under its own sync_runs provider; background re-runs inside the throttle skip; manual bypasses it", async () => {
    const s = await seed();
    const manual = await retentionNoShowTick({ store: s.store, now: NOW, trigger: "manual" });
    expect(manual.outcome).toBe("synced");
    const runs = await s.store.getSyncRuns(10);
    const mine = runs.filter((r) => r.provider === "retention-no-shows");
    expect(mine.length).toBe(1);
    expect(mine[0]!.status).toBe("success");
    expect(mine[0]!.records_upserted).toBe(3);

    const bg = await retentionNoShowTick({ store: s.store, now: NOW, trigger: "background" });
    expect(bg.outcome).toBe("skipped");
    const bgSoon = await retentionNoShowTick({ store: s.store, now: () => new Date("2026-10-20T15:04:59Z"), trigger: "background" });
    expect(bgSoon.outcome).toBe("skipped");
    const bgLater = await retentionNoShowTick({ store: s.store, now: () => new Date("2026-10-20T15:05:01Z"), trigger: "background" });
    expect(bgLater.outcome).toBe("synced");
    const manualAgain = await retentionNoShowTick({ store: s.store, now: () => new Date("2026-10-20T15:06:00Z"), trigger: "manual" });
    expect(manualAgain.outcome).toBe("synced"); // idempotent — synced with zero writes
    if (manualAgain.outcome === "synced") {
      expect(manualAgain.inserted).toBe(0);
      expect(manualAgain.updated).toBe(0);
    }
  });

  test("an engine failure never throws — the tick records the error and returns honestly", async () => {
    const s = await seed();
    // a store whose getSettings rejects — the engine's first read
    const broken = new Proxy(s.store, {
      get(target, prop, recv) {
        if (prop === "getSettings") return () => Promise.reject(new Error("settings read failed"));
        return Reflect.get(target, prop, recv);
      },
    });
    const res = await retentionNoShowTick({ store: broken as unknown as MemoryStore, now: NOW, trigger: "manual" });
    expect(res.outcome).toBe("error");
    if (res.outcome === "error") expect(res.error).toContain("settings read failed");
    const runs = await s.store.getSyncRuns(10);
    const mine = runs.filter((r) => r.provider === "retention-no-shows");
    expect(mine[0]!.status).toBe("error");
  });
});
