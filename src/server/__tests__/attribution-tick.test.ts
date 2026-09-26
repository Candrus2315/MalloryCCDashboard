/**
 * ATTRIBUTION WIRING tests — the scheduler tick + manual assignment path over
 * a memory store (no live API, no real clock). Covers:
 *  - attributionTick computes with the PURE engine and upserts results;
 *  - MANUAL WINS: a manually assigned attribution survives a re-run (reported
 *    as "manually-assigned", never recomputed);
 *  - unassign clears the manual row → the next tick recomputes from raw rows;
 *  - SCOPE: an out-of-scope (Zoom) appointment never enters attribution;
 *  - the unattributed QUEUE renders the engine's per-row reason;
 *  - only ACTIVE ROSTER reps are assignable (roster guard).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  attributionTick,
  computeAndPersistAttributions,
  resetAttributionThrottle,
  toAttributionRows,
} from "../sync/attribution-tick";
import { schedulerTick } from "../sync/scheduler";
import {
  assignAttributionCore,
  unassignAttributionCore,
} from "../queries";
import { buildUnattributedQueue } from "../metrics/compute";
import type { AppSettings } from "../store/types";

const NOW = new Date("2026-09-28T15:00:00Z"); // a Monday, mid-day UTC
const now = () => NOW;
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const H = 3_600_000;

/** Seed one roster rep + one non-roster user; returns internal rep ids. */
async function seedUsers(store: MemoryStore): Promise<{ rep: string; outsider: string }> {
  await store.upsertUsers([
    { id: "", provider: "highlevel", external_id: "usr_rep", name: "Alex Morgan", email: "alex@mallory.test", is_active: true, call_start_date: null },
    { id: "", provider: "highlevel", external_id: "usr_out", name: "Not On Roster", email: "out@x.test", is_active: false, call_start_date: null },
  ]);
  const users = await store.getAllUsers();
  return {
    rep: users.find((u) => u.external_id === "usr_rep")!.id,
    outsider: users.find((u) => u.external_id === "usr_out")!.id,
  };
}

/** Seed one contact + one qualifying call (3h before the booking anchor). */
async function seedContactAndCall(store: MemoryStore, repId: string): Promise<{ contact: string; call: string }> {
  await store.upsertContacts([
    { id: "", provider: "highlevel", external_id: "cnt_1", name: "Emma Carter", phone: "+19175550142", email: "emma@example.test", assigned_rep_id: repId },
  ]);
  const contact = (await store.getContacts()).find((c) => c.external_id === "cnt_1")!.id;
  await store.upsertCalls([
    {
      provider: "highlevel",
      external_call_id: "call_ext_1",
      rep_id: repId,
      provider_rep_external_id: "usr_rep",
      contact_id: contact,
      started_at: iso(27 * H), // 27h before NOW; within the 24h window of a booking created 3h ago
      duration_seconds: 300, // > 120s threshold
      over_two_minutes: true,
      direction: "outbound",
      call_status: "completed",
    },
  ]);
  const call = (await store.getAllCallsSince("2000-01-01")).find((c) => c.external_call_id === "call_ext_1")!.id;
  return { contact, call };
}

/** One in-scope booking created 3h ago (the call 27h ago qualifies: 24h window). */
async function seedBooking(store: MemoryStore, contactId: string, calendar = "MALLORY PORTRAITS"): Promise<string> {
  await store.upsertAppointments([
    {
      id: "",
      contact_id: contactId,
      calendar_id: "1335091",
      calendar_name: calendar,
      appointment_type: "Consult",
      appointment_datetime: iso(1 * H),
      created_at: iso(3 * H),
      duration_minutes: 60,
      status: "scheduled",
      cancelled: false,
      acuity_appointment_id: "acuity_1",
      client_name: "Emma Carter",
      client_phone: "19175550142",
      client_email: "emma@example.test",
    },
  ]);
  const appts = await store.getAppointmentsWithClientsSince("2000-01-01");
  return appts.find((a) => a.acuity_appointment_id === "acuity_1")!.id;
}

async function getSettings(store: MemoryStore, overrides: Partial<AppSettings> = {}): Promise<AppSettings> {
  const base = await store.getSettings();
  return { ...base, ...overrides };
}

describe("attributionTick", () => {
  test("computes with the pure engine and upserts attributions (memory store)", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const { rep } = await seedUsers(store);
    const { contact, call } = await seedContactAndCall(store, rep);
    const apptId = await seedBooking(store, contact);
    const settings = await getSettings(store);

    const res = await attributionTick({ store, settings, now, trigger: "manual" });
    expect(res.outcome).toBe("synced");
    expect(res.appointments).toBe(1);
    expect(res.attributed).toBe(1);
    expect(res.unattributed).toBe(0);

    const rows = await store.getAttributions();
    expect(rows).toHaveLength(1);
    expect(rows[0].appointment_id).toBe(apptId);
    expect(rows[0].call_id).toBe(call); // INTERNAL call id (eligibility join key)
    expect(rows[0].rep_id).toBe(rep);
    expect(rows[0].method).toBe("contact_id");
    expect(rows[0].manual_override).toBe(false);
    const runs = await store.getSyncRuns(5);
    expect(runs.some((r) => r.provider === "attribution" && r.status === "success")).toBe(true);
  });

  test("manual assignment SURVIVES a re-run (manual wins, reason manually-assigned)", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const { rep, outsider } = await seedUsers(store);
    const { contact } = await seedContactAndCall(store, rep);
    await seedBooking(store, contact);
    const settings = await getSettings(store);

    await attributionTick({ store, settings, now, trigger: "manual" });
    // Christopher assigns the OUTSIDER... rejected by the roster guard.
    const apptId = (await store.getAttributions())[0].appointment_id;
    await expect(assignAttributionCore(store, { appointmentId: apptId, repId: outsider })).rejects.toThrow(/roster/i);
    // ...then reassigns to the roster rep manually with a note.
    await assignAttributionCore(store, { appointmentId: apptId, repId: rep, note: "confirmed on the call" });

    // A re-run must NOT overwrite the manual row.
    const res = await attributionTick({ store, settings, now, trigger: "manual" });
    expect(res.manuallyAssigned).toBe(1);
    const row = (await store.getAttributions()).find((a) => a.appointment_id === apptId)!;
    expect(row.method).toBe("manual");
    expect(row.manual_override).toBe(true);
    expect(row.rep_id).toBe(rep);
    // the note + rep change are in the audit trail
    const overrides = await store.getManualOverrides(10);
    expect(overrides.some((o) => o.field === "note" && o.new_value === "confirmed on the call")).toBe(true);
    expect(overrides.some((o) => o.field === "rep" && o.new_value === "Alex Morgan")).toBe(true);
  });

  test("unassign clears the manual override — the next tick recomputes from raw rows", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const { rep } = await seedUsers(store);
    const { contact } = await seedContactAndCall(store, rep);
    await seedBooking(store, contact);
    const settings = await getSettings(store);

    await attributionTick({ store, settings, now, trigger: "manual" });
    const apptId = (await store.getAttributions())[0].appointment_id;
    await assignAttributionCore(store, { appointmentId: apptId, repId: rep });
    await unassignAttributionCore(store, apptId);
    expect(await store.getAttributions()).toHaveLength(0);
    // next tick restores the engine's own verdict
    await attributionTick({ store, settings, now, trigger: "manual" });
    const row = (await store.getAttributions()).find((a) => a.appointment_id === apptId)!;
    expect(row.manual_override).toBe(false);
    expect(row.method).toBe("contact_id");
    const overrides = await store.getManualOverrides(10);
    expect(overrides.some((o) => o.field === "rep" && o.new_value === "unassigned")).toBe(true);
  });

  test("SCOPE: a Zoom (out-of-scope) booking never enters attribution", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const { rep } = await seedUsers(store);
    const { contact } = await seedContactAndCall(store, rep);
    await seedBooking(store, contact, "MALLORY PORTRAITS");
    // second booking on the Zoom calendar — same contact, same qualifying call
    await store.upsertAppointments([
      {
        id: "",
        contact_id: contact,
        calendar_id: "zoom-cal",
        calendar_name: "Zoom",
        appointment_type: "Consult",
        appointment_datetime: iso(2 * H),
        created_at: iso(4 * H),
        duration_minutes: 30,
        status: "scheduled",
        cancelled: false,
        acuity_appointment_id: "acuity_zoom",
        client_name: "Emma Carter",
        client_phone: "19175550142",
        client_email: "emma@example.test",
      },
    ]);
    const settings = await getSettings(store, { acuity: { calendars_included: ["MALLORY PORTRAITS"], types_included: [] } });

    const res = await attributionTick({ store, settings, now, trigger: "manual" });
    expect(res.appointments).toBe(1); // only the in-scope booking was evaluated
    const rows = await store.getAttributions();
    expect(rows).toHaveLength(1);
    const zoomAppt = (await store.getAppointmentsWithClientsSince("2000-01-01")).find((a) => a.acuity_appointment_id === "acuity_zoom")!;
    expect(rows.some((r) => r.appointment_id === zoomAppt.id)).toBe(false);
  });

  test("background trigger is throttled to ~5 minutes; failures never throw", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const settings = await getSettings(store);
    const first = await attributionTick({ store, settings, now, trigger: "background" });
    expect(first.outcome).toBe("synced");
    const second = await attributionTick({ store, settings, now, trigger: "background" });
    expect(second.outcome).toBe("skipped");
    expect(second.reason).toBe("recent-tick");
    // a later clock clears the throttle
    const later = attributionTick({ store, settings, now: () => new Date(NOW.getTime() + 6 * 60_000), trigger: "background" });
    expect((await later).outcome).toBe("synced");
  });

  test("a failing store surfaces outcome=error (never throws into the scheduler)", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const settings = await getSettings(store);
    const broken = new Proxy(store, {
      get(target, prop) {
        if (prop === "getAppointmentsWithClientsSince") return async () => { throw new Error("db down"); };
        return Reflect.get(target, prop);
      },
    });
    const res = await attributionTick({ store: broken as MemoryStore, settings, now, trigger: "manual" });
    expect(res.outcome).toBe("error");
    expect(res.error).toContain("db down");
    const runs = await store.getSyncRuns(5);
    expect(runs.some((r) => r.provider === "attribution" && r.status === "error")).toBe(true);
  });

  test("schedulerTick piggy-backs the attribution tick (never fails the tick)", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const settings = await getSettings(store);
    const res = await schedulerTick({
      store,
      settings,
      creds: null, // demo mode: HighLevel portion skips, attribution still runs
      now,
      trigger: "manual",
      acuityAdapter: null,
    });
    expect(res.outcome).toBe("skipped"); // no credentials
    expect(res.attribution?.outcome).toBe("synced"); // but attribution ran
  });
});

describe("queue + conversion helpers", () => {
  test("queue rows carry the engine's unattributed reason", async () => {
    const store = new MemoryStore();
    const { rep } = await seedUsers(store);
    const { contact } = await seedContactAndCall(store, rep);
    const apptId = await seedBooking(store, contact);
    const settings = await getSettings(store);
    const [appt] = await store.getAppointmentsWithClientsSince("2000-01-01");

    // No qualifying call in window: move the call far outside the 24h window.
    const matchesNoCall = buildUnattributedQueue({
      appointments: [appt],
      attributions: [],
      calls: [], // no calls → no-qualifying-call
      contacts: (await store.getContacts()).map((c) => ({ id: c.id, phone: c.phone, email: c.email, assigned_rep_id: c.assigned_rep_id })),
      thresholdSeconds: settings.meaningful_call_threshold_seconds,
      windowHours: settings.attribution_window_hours,
      matches: [{ appointmentId: apptId, reason: "no-qualifying-call" }],
    });
    expect(matchesNoCall).toHaveLength(1);
    expect(matchesNoCall[0].reason).toBe("no-qualifying-call");
    expect(matchesNoCall[0].client_phone).toBe("19175550142");
    expect(matchesNoCall[0].client_email).toBe("emma@example.test");
    expect(matchesNoCall[0].candidate_calls).toHaveLength(0);

    // An ambiguous engine verdict renders as-is.
    const matchesAmbiguous = buildUnattributedQueue({
      appointments: [appt],
      attributions: [],
      calls: [],
      contacts: [],
      thresholdSeconds: settings.meaningful_call_threshold_seconds,
      windowHours: settings.attribution_window_hours,
      matches: [{ appointmentId: apptId, reason: "ambiguous" }],
    });
    expect(matchesAmbiguous[0].reason).toBe("ambiguous");
  });

  test("toAttributionRows: manual rows are preserved verbatim and reported", () => {
    const manualRow = { id: "m1", appointment_id: "appt_9", call_id: "c9", rep_id: "r2", method: "manual", confidence: 1, manual_override: true };
    const { rows, manuallyAssignedIds } = toAttributionRows(
      [
        { appointmentId: "appt_9", status: "attributed", callExternalId: "ext_9", repId: "r1", method: "contact_id" },
        { appointmentId: "appt_8", status: "unattributed", reason: "no-qualifying-call" },
      ],
      [manualRow],
      new Map([["ext_9", "internal_9"]]),
    );
    expect(manuallyAssignedIds).toEqual(["appt_9"]);
    const manual = rows.find((r) => r.appointment_id === "appt_9")!;
    expect(manual.rep_id).toBe("r2"); // manual wins — engine's r1 never applied
    expect(manual.method).toBe("manual");
    const unattr = rows.find((r) => r.appointment_id === "appt_8")!;
    expect(unattr.method).toBe("none");
    expect(unattr.rep_id).toBeNull();
    const attr = rows.find((r) => r.appointment_id === "appt_7");
    expect(attr).toBeUndefined();
  });

  test("computeAndPersistAttributions replaces prior computed rows on re-run", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const { rep } = await seedUsers(store);
    const { contact, call } = await seedContactAndCall(store, rep);
    await seedBooking(store, contact);
    const settings = await getSettings(store);

    const first = await computeAndPersistAttributions(store, settings, { now });
    expect(first.attributed).toBe(1);
    // Engine result flips when the call leaves the DATE-GRANULARITY window
    // (creation ET date + the day before) — the re-run REPLACES.
    await store.upsertCalls([{ ...call, started_at: iso(5 * 24 * H) }]); // 5 ET days back → out of window
    const second = await computeAndPersistAttributions(store, settings, { now });
    expect(second.appointments).toBe(1);
    expect(second.attributed).toBe(0);
    const rows = await store.getAttributions();
    expect(rows).toHaveLength(1);
    expect(rows[0].rep_id).toBeNull();
    expect(rows[0].call_id).toBeNull();
    expect(call).toBeTruthy();
  });
});
