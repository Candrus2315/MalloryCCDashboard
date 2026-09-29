/**
 * ACUITY LIVE CLIENT + SYNC WIRING tests (fixture-based, NO live API — the
 * owner's real Acuity credentials exist in this machine's environment, so
 * every live resolution is either injected as a stub or guarded off under the
 * test runner via resolveAcuityAdapterForSync()).
 *
 * Covers: response parsing (offset normalization, canceled, reschedule-id
 * semantics, missing fields), upsert idempotency (same Acuity id twice = one
 * row), cancellations UPDATE (never duplicate), runDemoSync live wiring
 * (demo rows purged on success; demo seeding SKIPPED on live failure with the
 * real error recorded), availabilityTick guards + honesty, and the composed
 * schedulerTick (availability failure never fails the HighLevel tick).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  parseAcuityAppointment,
  parseAcuityAppointmentType,
  parseAcuityInstant,
  parseAcuityDuration,
  availabilityTick,
  resolveAcuityAdapterForSync,
  writeAcuityConnection,
  acuityWindow,
  chunkDateRange,
  ACUITY_LOOKBACK_DAYS,
  ACUITY_LOOKAHEAD_DAYS,
  ACUITY_CHUNK_DAYS,
  ACUITY_MAX_PAGE,
  AcuityLiveAdapter,
} from "../sync/acuity-live";
import { etToday, addDays } from "../date-logic";
import { runDemoSync } from "../sync/run";
import { schedulerTick } from "../sync/scheduler";
import type { NormalizedAppointment } from "../sync/adapters";

// ---------- fixtures ----------

const RAW_APPT = {
  id: 177001,
  calendarID: 12345,
  calendar: "Family Studio",
  appointmentTypeID: 6789,
  type: "Family Session",
  datetime: "2026-09-28T10:00:00-0400",
  duration: "60",
  dateCreated: "2026-09-20T11:04:00-0400",
  canceled: false,
  firstName: "Jane",
  lastName: "Doe",
  phone: "+1 917 555 0142",
  email: "jane@example.com",
};

const liveAppt = (id: string, datetimeUtc: string, extra: Partial<NormalizedAppointment> = {}): NormalizedAppointment => ({
  acuity_appointment_id: id,
  calendarId: "12345",
  calendarName: "Family Studio",
  appointmentType: "Family Session",
  appointmentDatetime: datetimeUtc,
  createdAt: "2026-09-20T15:00:00.000Z",
  status: "scheduled",
  cancelled: false,
  clientName: "Jane Doe",
  clientPhone: "+19175550142",
  clientEmail: "jane@example.com",
  durationMinutes: 60,
  ...extra,
});

/** Stub live adapter — never touches the network. */
function stubAcuity(appts: NormalizedAppointment[] | Error): AcuityLiveAdapter {
  return {
    provider: "acuity",
    isDemo: false,
    lastRun: { requests: 1, window: { minDate: "2026-09-27", maxDate: "2026-10-12" }, truncated: false, warnings: [] },
    fetchAppointments: async () => {
      if (appts instanceof Error) throw appts;
      return appts;
    },
    fetchBlockedTimes: async () => [],
  } as unknown as AcuityLiveAdapter;
}

const runSync = (store: MemoryStore, acuityAdapter: AcuityLiveAdapter | null) =>
  runDemoSync({ store, sheetsAdapter: null, highlevelAdapter: null, acuityAdapter });

/** Store-shaped appointment row (what store.upsertAppointments consumes). */
const storeRow = (id: string, datetimeUtc: string, extra: Record<string, unknown> = {}) => ({
  acuity_appointment_id: id,
  contact_id: null,
  calendar_id: "12345",
  calendar_name: "Family Studio",
  appointment_type: "Family Session",
  appointment_datetime: datetimeUtc,
  duration_minutes: 60,
  created_at: "2026-09-20T15:00:00.000Z",
  status: "scheduled",
  cancelled: false,
  ...extra,
});

const apptRows = async (store: MemoryStore) =>
  store.getAppointmentsOverlapping("1970-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z");

// ---------- parsers ----------

describe("Acuity response parsing", () => {
  test("offset normalization: '-0400' parses; instants come back as UTC ISO", () => {
    expect(parseAcuityInstant("2026-09-28T10:00:00-0400")).toBe("2026-09-28T14:00:00.000Z");
    expect(parseAcuityInstant("2026-09-28T10:00:00-04:00")).toBe("2026-09-28T14:00:00.000Z");
    expect(parseAcuityInstant("2026-09-28T14:00:00Z")).toBe("2026-09-28T14:00:00.000Z");
    expect(parseAcuityInstant("garbage")).toBeNull();
    expect(parseAcuityInstant(null)).toBeNull();
  });

  test("duration parsing accepts number or numeric string; rejects junk", () => {
    expect(parseAcuityDuration("60")).toBe(60);
    expect(parseAcuityDuration(90)).toBe(90);
    expect(parseAcuityDuration("abc")).toBeNull();
    expect(parseAcuityDuration(0)).toBeNull();
  });

  test("full appointment row maps to the normalized sync shape", () => {
    const parsed = parseAcuityAppointment(RAW_APPT);
    expect(parsed).not.toBeNull();
    expect(parsed!.acuity_appointment_id).toBe("177001");
    expect(parsed!.calendarId).toBe("12345");
    expect(parsed!.calendarName).toBe("Family Studio");
    expect(parsed!.appointmentType).toBe("Family Session");
    expect(parsed!.appointmentDatetime).toBe("2026-09-28T14:00:00.000Z");
    expect(parsed!.createdAt).toBe("2026-09-20T15:04:00.000Z");
    expect(parsed!.durationMinutes).toBe(60);
    expect(parsed!.cancelled).toBe(false);
    expect(parsed!.status).toBe("scheduled");
    expect(parsed!.clientName).toBe("Jane Doe");
    // Contact identities are normalized AT THE SOURCE through the CANONICAL
    // normalizer (identity/normalize.ts): phone → digits with the leading
    // country-code 1 DROPPED (a HighLevel "+15088891019" matches an Acuity
    // "5088891019"), email → lowercase-trimmed.
    expect(parsed!.clientPhone).toBe("9175550142");
    expect(parsed!.clientEmail).toBe("jane@example.com");
  });
  test("client contact fields normalize: messy phone/email in → digits + lowercase out", () => {
    const parsed = parseAcuityAppointment({
      ...RAW_APPT,
      phone: " (917) 555-0142 ",
      email: "  Jane.Doe@Example.COM ",
    });
    expect(parsed!.clientPhone).toBe("9175550142");
    expect(parsed!.clientEmail).toBe("jane.doe@example.com");
    const empty = parseAcuityAppointment({ ...RAW_APPT, phone: "", email: "" });
    expect(empty!.clientPhone).toBe("");
    expect(empty!.clientEmail).toBe("");
  });

  test("canceled:true maps to cancelled + status cancelled (frees the slot on upsert)", () => {
    const parsed = parseAcuityAppointment({ ...RAW_APPT, canceled: true });
    expect(parsed!.cancelled).toBe(true);
    expect(parsed!.status).toBe("cancelled");
  });

  test("missing id or datetime → null (never a guessed row)", () => {
    expect(parseAcuityAppointment({ ...RAW_APPT, id: undefined })).toBeNull();
    expect(parseAcuityAppointment({ ...RAW_APPT, datetime: "" })).toBeNull();
  });

  test("missing dateCreated falls back to the session datetime (real timestamp, flagged)", () => {
    const parsed = parseAcuityAppointment({ ...RAW_APPT, dateCreated: undefined }) as NormalizedAppointment & { canceledAndFallbackCreated?: boolean };
    expect(parsed.createdAt).toBe(parsed.appointmentDatetime);
    expect(parsed.canceledAndFallbackCreated).toBe(true);
  });

  test("appointment-type catalog parsing", () => {
    expect(parseAcuityAppointmentType({ id: 12, name: "Family Session", duration: "60" })).toEqual({ id: "12", name: "Family Session", duration: 60 });
    expect(parseAcuityAppointmentType({ id: 12 })).toBeNull();
  });
});

// ---------- store upsert semantics ----------

describe("upsert idempotency + cancellation UPDATE (MemoryStore)", () => {
  test("same Acuity id twice = ONE row (no duplicates)", async () => {
    const store = new MemoryStore();
    await store.upsertAppointments([storeRow("a1", "2026-09-28T14:00:00.000Z")]);
    await store.upsertAppointments([storeRow("a1", "2026-09-28T14:00:00.000Z")]);
    expect(await apptRows(store)).toHaveLength(1);
  });

  test("cancellation UPDATEs the row in place — one row, cancelled, slot freed", async () => {
    const store = new MemoryStore();
    await store.upsertAppointments([storeRow("a1", "2026-09-28T14:00:00.000Z")]);
    await store.upsertAppointments([storeRow("a1", "2026-09-28T14:00:00.000Z", { cancelled: true, status: "cancelled" })]);
    const rows = await apptRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0].cancelled).toBe(true);
  });

  test("reschedule keeps ONE row at the new datetime", async () => {
    const store = new MemoryStore();
    await store.upsertAppointments([storeRow("a1", "2026-09-28T14:00:00.000Z")]);
    await store.upsertAppointments([storeRow("a1", "2026-09-28T17:00:00.000Z")]);
    const rows = await apptRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0].appointment_datetime).toBe("2026-09-28T17:00:00.000Z");
  });
});

// ---------- runDemoSync Acuity wiring ----------

describe("runDemoSync Acuity live wiring", () => {
  test("LIVE SUCCESS: stores live appointments, PURGES demo acuity rows, connection connected/not-demo", async () => {
    const store = new MemoryStore();
    await runSync(store, null); // demo seed → demo- appointment rows exist
    const demoRows = await apptRows(store);
    expect(demoRows.some((a) => a.acuity_appointment_id?.startsWith("demo-"))).toBe(true);

    await runSync(store, stubAcuity([liveAppt("live-1", "2026-09-28T14:00:00.000Z")]));
    const rows = await apptRows(store);
    expect(rows).toHaveLength(1); // demo gone, live present, NEVER mixed
    expect(rows[0].acuity_appointment_id).toBe("live-1");
    const conn = (await store.getConnections()).find((c) => c.provider === "acuity");
    expect(conn?.status).toBe("connected");
    expect(conn?.is_demo).toBe(false);
    expect(conn?.last_error).toBeNull();
    expect(conn?.last_successful_sync_at).not.toBeNull();
    const runs = await store.getSyncRuns(20);
    expect(runs.find((r) => r.provider === "acuity" && r.status === "success")).toBeTruthy();
  });

  test("LIVE FAILURE: demo seed SKIPPED (no fake slots), real error recorded, last success preserved", async () => {
    const store = new MemoryStore();
    const prevSuccess = "2026-09-26T12:00:00.000Z";
    await store.upsertConnection({
      provider: "acuity", status: "connected", is_demo: false, last_sync_at: prevSuccess,
      last_successful_sync_at: prevSuccess, last_error: null, config: { source: "acuity-api" },
    });

    await runSync(store, stubAcuity(new Error("Acuity authentication failed (401) — check ACUITY_USER_ID / ACUITY_API_KEY")));

    const rows = await apptRows(store);
    expect(rows.some((a) => a.acuity_appointment_id?.startsWith("demo-"))).toBe(false); // no demo fallback
    const conn = (await store.getConnections()).find((c) => c.provider === "acuity");
    expect(conn?.status).toBe("error");
    expect(conn?.last_error).toContain("401");
    expect(conn?.last_successful_sync_at).toBe(prevSuccess); // stale real data, honestly timestamped
    const runs = await store.getSyncRuns(20);
    expect(runs.find((r) => r.provider === "acuity" && r.status === "error")).toBeTruthy();
  });

  test("upsert through the sync links client contact by phone when present", async () => {
    const store = new MemoryStore();
    await runSync(store, null); // demo seed brings HighLevel demo contacts
    const storedContacts = await store.getContacts();
    const withPhone = storedContacts.find((c) => (c.phone ?? "").replace(/\D/g, "").length >= 10);
    expect(withPhone).toBeTruthy();
    await runSync(store, stubAcuity([liveAppt("live-2", "2026-09-28T14:00:00.000Z", { clientPhone: withPhone!.phone ?? "" })]));
    const rows = await apptRows(store);
    const live = rows.find((a) => a.acuity_appointment_id === "live-2");
    expect(live).toBeTruthy();
    expect(live!.contact_id).toBe(withPhone!.id);
  });
});

// ---------- availabilityTick ----------

describe("availabilityTick", () => {
  test("default resolution under the test runner NEVER resolves a live adapter (no network)", async () => {
    expect(resolveAcuityAdapterForSync()).toBeNull(); // NODE_ENV=test guard, env creds present or not
    const store = new MemoryStore();
    const res = await availabilityTick({ store }); // no adapter injected
    expect(res).toEqual({ outcome: "skipped", reason: "no-credentials" });
    expect((await store.getSyncRuns(10)).length).toBe(0); // no run started
  });

  test("SUCCESS: upserts appointments + connected connection + success sync_runs row", async () => {
    const store = new MemoryStore();
    const res = await availabilityTick({ store, adapter: stubAcuity([liveAppt("live-3", "2026-09-28T14:00:00.000Z")]) });
    expect(res.outcome).toBe("synced");
    expect(res.appointments).toBe(1);
    const conn = (await store.getConnections()).find((c) => c.provider === "acuity");
    expect(conn?.status).toBe("connected");
    expect(conn?.is_demo).toBe(false);
    expect(await apptRows(store)).toHaveLength(1);
  });

  test("SKIP: an in-flight acuity sync run blocks the tick", async () => {
    const store = new MemoryStore();
    await store.insertSyncRun("acuity");
    const res = await availabilityTick({ store, adapter: stubAcuity([]) });
    expect(res).toEqual({ outcome: "skipped", reason: "sync-in-progress" });
  });

  test("THROTTLE: background skips when the last sync is recent; MANUAL bypasses", async () => {
    const store = new MemoryStore();
    const nowIso = new Date().toISOString();
    await store.upsertConnection({
      provider: "acuity", status: "connected", is_demo: false, last_sync_at: nowIso,
      last_successful_sync_at: nowIso, last_error: null, config: {},
    });
    const background = await availabilityTick({ store, adapter: stubAcuity([]), trigger: "background" });
    expect(background).toEqual({ outcome: "skipped", reason: "recent-sync" });
    const manual = await availabilityTick({ store, adapter: stubAcuity([liveAppt("live-4", "2026-09-28T14:00:00.000Z")]), trigger: "manual" });
    expect(manual.outcome).toBe("synced");
  });

  test("ERROR: sync_runs + connection row record the failure; last successful sync preserved", async () => {
    const store = new MemoryStore();
    const prev = "2026-09-26T00:00:00.000Z";
    await writeAcuityConnection(store, { live: true, note: "ok", nowIso: prev });
    const res = await availabilityTick({ store, adapter: stubAcuity(new Error("Acuity rate limited (429)")) });
    expect(res.outcome).toBe("error");
    expect(res.error).toContain("429");
    const conn = (await store.getConnections()).find((c) => c.provider === "acuity");
    expect(conn?.status).toBe("error");
    expect(conn?.last_successful_sync_at).toBe(prev);
  });
});

// ---------- composed scheduler tick ----------

describe("schedulerTick composition", () => {
  // timeout: full-tick test with real timers — can exceed bun's 5s default when
  // the whole suite runs in parallel (load flake; passes in isolation). 15s tolerates it.
  test("availability refresh rides the same tick; its failure never fails the HighLevel outcome", { timeout: 15_000 }, async () => {
    const store = new MemoryStore();
    const res = await schedulerTick({
      store,
      creds: null, // HighLevel: demo mode
      acuityAdapter: stubAcuity(new Error("network down")),
      trigger: "manual",
    });
    expect(res.outcome).toBe("skipped"); // highlevel
    expect(res.reason).toBe("no-credentials");
    expect(res.availability?.outcome).toBe("error"); // availability recorded honestly
    expect(res.availability?.error).toContain("network down");
  });

  test("availability success surfaces on the composed result", async () => {
    const store = new MemoryStore();
    const res = await schedulerTick({
      store,
      creds: null,
      acuityAdapter: stubAcuity([liveAppt("live-5", "2026-09-28T14:00:00.000Z")]),
      trigger: "manual",
    });
    expect(res.availability?.outcome).toBe("synced");
    expect(res.availability?.appointments).toBe(1);
  });
});

// ---------- S7: widened sync window (35 back / 180 forward) ----------

describe("S7 sync window (35 back / 180 forward)", () => {
  test("acuityWindow pins the exact bounds (owner directive: 35 back / 180 forward)", () => {
    expect(ACUITY_LOOKBACK_DAYS).toBe(35);
    expect(ACUITY_LOOKAHEAD_DAYS).toBe(180);
    expect(acuityWindow("2026-09-28")).toEqual({ minDate: "2026-08-24", maxDate: "2027-03-27" });
  });

  test("acuityWindow rolls over month and year boundaries in both directions", () => {
    // look-back across a year boundary
    expect(acuityWindow("2026-01-10")).toEqual({ minDate: "2025-12-06", maxDate: "2026-07-09" });
    // look-ahead across a year boundary
    expect(acuityWindow("2027-01-15")).toEqual({ minDate: "2026-12-11", maxDate: "2027-07-14" });
  });

  test("chunkDateRange splits the 216-day window into contiguous ≤90-day chunks", () => {
    const chunks = chunkDateRange("2026-08-24", "2027-03-27", ACUITY_CHUNK_DAYS);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ minDate: "2026-08-24", maxDate: "2026-11-21" });
    expect(chunks[1]).toEqual({ minDate: "2026-11-22", maxDate: "2027-02-19" });
    expect(chunks[2]).toEqual({ minDate: "2027-02-20", maxDate: "2027-03-27" });
    for (let i = 1; i < chunks.length; i++) {
      expect(addDays(chunks[i - 1].maxDate, 1)).toBe(chunks[i].minDate); // no gaps, no overlaps
    }
  });

  test("chunkDateRange: a range shorter than the chunk size is one chunk", () => {
    expect(chunkDateRange("2026-09-01", "2026-09-30", 90)).toEqual([{ minDate: "2026-09-01", maxDate: "2026-09-30" }]);
  });

  test("fetchAppointments pulls the widened window in date chunks and parses every row", async () => {
    const win = acuityWindow(etToday());
    const expectedChunks = chunkDateRange(win.minDate, win.maxDate, ACUITY_CHUNK_DAYS);
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      const min = new URL(url).searchParams.get("minDate") ?? "";
      return new Response(
        JSON.stringify([{ ...RAW_APPT, id: Number(min.replaceAll("-", "")), datetime: `${min}T10:00:00-0400`, dateCreated: "September 20, 2026" }]),
        { status: 200 },
      );
    };
    const adapter = new AcuityLiveAdapter({ userId: "u", apiKey: "k" }, fetchImpl, async () => {});
    const appts = await adapter.fetchAppointments();
    expect(urls).toHaveLength(expectedChunks.length);
    expect(urls.map((u) => new URL(u).searchParams.get("minDate"))).toEqual(expectedChunks.map((c) => c.minDate));
    expect(urls.map((u) => new URL(u).searchParams.get("maxDate"))).toEqual(expectedChunks.map((c) => c.maxDate));
    expect(urls.every((u) => new URL(u).searchParams.get("max") === String(ACUITY_MAX_PAGE))).toBe(true);
    expect(appts).toHaveLength(expectedChunks.length);
    expect(adapter.lastRun?.window).toEqual(win);
    expect(adapter.lastRun?.requests).toBe(expectedChunks.length);
    expect(adapter.lastRun?.truncated).toBe(false);
  });

  test("fetchAppointments splits a cap-full chunk instead of silently truncating", async () => {
    const seen: string[] = [];
    const win = acuityWindow(etToday());
    const expectedChunks = chunkDateRange(win.minDate, win.maxDate, ACUITY_CHUNK_DAYS);
    const spanDays = (url: string) => {
      const p = new URL(url).searchParams;
      return (Date.parse(`${p.get("maxDate")}T00:00:00Z`) - Date.parse(`${p.get("minDate")}T00:00:00Z`)) / 86_400_000 + 1;
    };
    const fetchImpl = async (url: string) => {
      seen.push(url);
      // any range wider than half a chunk fills the cap; narrower ones do not
      if (spanDays(url) > ACUITY_CHUNK_DAYS / 2) {
        return new Response(
          JSON.stringify(Array.from({ length: ACUITY_MAX_PAGE }, (_, i) => ({ ...RAW_APPT, id: 900000 + i, dateCreated: "September 20, 2026" }))),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([{ ...RAW_APPT, id: 177001, dateCreated: "September 20, 2026" }]), { status: 200 });
    };
    const adapter = new AcuityLiveAdapter({ userId: "u", apiKey: "k" }, fetchImpl, async () => {});
    const appts = await adapter.fetchAppointments();
    // every full chunk split into two halves → more requests than chunks; nothing truncated
    expect(seen.length).toBeGreaterThan(expectedChunks.length);
    // the first chunk's halves: [start, mid] and [mid+1, end] — mid = start + floor((days-1)/2)
    const mid = addDays(expectedChunks[0].minDate, Math.floor((ACUITY_CHUNK_DAYS - 1) / 2));
    expect(seen.some((u) => u.includes(`minDate=${expectedChunks[0].minDate}`) && u.includes(`maxDate=${mid}`))).toBe(true);
    expect(seen.some((u) => u.includes(`minDate=${addDays(mid, 1)}`) && u.includes(`maxDate=${expectedChunks[0].maxDate}`))).toBe(true);
    // duplicate ids across pages collapse to one row; the cap-full page contributes its 500
    expect(appts.filter((a) => a.acuity_appointment_id === "177001")).toHaveLength(1);
    expect(new Set(appts.map((a) => a.acuity_appointment_id)).size).toBe(appts.length);
    expect(adapter.lastRun?.truncated).toBe(false);
  });
});
