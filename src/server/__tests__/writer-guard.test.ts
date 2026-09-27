/**
 * S6 WRITER PROTECTION tests (owner directive 2026-09-27) — an outdated or
 * duplicate writer must never silently rewrite booking_attributions.
 * Layers under test:
 *  1. DEGRADATION GUARD (attributionDegradation + both stores' upsert): a
 *     write that would strip a large share of currently-attributed rows (the
 *     49→3 stale-writer shape) is REFUSED — table untouched, error thrown.
 *  2. WRITER-VERSION GUARD (computeAndPersistAttributions): a writer whose
 *     version is OLDER than the recorded latest refuses to upsert and the
 *     tick records an ERROR sync_run (visible, never silent); an equal or
 *     newer writer always proceeds (fresh deploy takes over — the recovery
 *     path); force bypasses for deliberate recovery.
 *  3. Small human-scale edits (queue-shaped, touched < 10 attributed rows)
 *     are never guarded — manual assignment stays the recovery mechanism.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import {
  ATTRIBUTION_WRITER_VERSION,
  ATTRIBUTION_WRITER_VERSION_KEY,
  attributionTick,
  computeAndPersistAttributions,
  resetAttributionThrottle,
} from "../sync/attribution-tick";
import { attributionDegradation, ATTRIBUTION_DEGRADE_MIN_TOUCHED } from "../metrics/compute";
import type { AttributionRow } from "../metrics/compute";

const NOW = new Date("2026-09-28T15:00:00Z");
const now = () => NOW;
const H = 3_600_000;
const iso = (hAgo: number) => new Date(NOW.getTime() - hAgo * H).toISOString();

let seq = 0;
const attr = (rep_id: string | null, over: Partial<AttributionRow> = {}): AttributionRow => {
  seq += 1;
  return {
    id: `attr-${seq}`,
    appointment_id: `appt-${seq}`,
    call_id: null,
    rep_id,
    method: rep_id ? "contact_id" : "none",
    confidence: rep_id ? 1 : 0,
    manual_override: false,
    ...over,
  };
};

async function seedUsersContactCallBooking(store: MemoryStore) {
  await store.upsertUsers([
    { id: "", provider: "highlevel", external_id: "usr_rep", name: "Alex Morgan", email: "alex@mallory.test", is_active: true, call_start_date: null },
  ]);
  const rep = (await store.getAllUsers()).find((u) => u.external_id === "usr_rep")!.id;
  await store.upsertContacts([
    { id: "", provider: "highlevel", external_id: "cnt_1", name: "Emma Carter", phone: "+19175550142", email: "emma@example.test", assigned_rep_id: rep },
  ]);
  const contact = (await store.getContacts()).find((c) => c.external_id === "cnt_1")!.id;
  await store.upsertCalls([
    { provider: "highlevel", external_call_id: "call_ext_1", rep_id: rep, provider_rep_external_id: "usr_rep", contact_id: contact, started_at: iso(3), duration_seconds: 300, over_two_minutes: true, direction: "outbound", call_status: "completed" },
  ]);
  await store.upsertAppointments([
    { id: "", contact_id: contact, calendar_id: "1335091", calendar_name: "MALLORY PORTRAITS", appointment_type: "Consult", appointment_datetime: iso(1), created_at: iso(3), duration_minutes: 60, status: "scheduled", cancelled: false, acuity_appointment_id: "acuity_1", client_name: "Emma Carter", client_phone: "19175550142", client_email: "emma@example.test" },
  ]);
  return rep;
}

describe("degradation guard (pure)", () => {
  test("strips over the floor → refuse; small touches → allow; manual rows skipped", () => {
    const existing = Array.from({ length: ATTRIBUTION_DEGRADE_MIN_TOUCHED }, () => attr("rep-1"));
    const stripAll = existing.map((r) => attr(null, { appointment_id: r.appointment_id }));
    expect(attributionDegradation(existing, stripAll)).toEqual({ stripped: 10, touched: 10 });
    // fewer touched attributed rows than the minimum → never guarded
    expect(attributionDegradation(existing.slice(0, 9), stripAll.slice(0, 9))).toBeNull();
    // upgrades (no strip) pass
    const same = existing.map((r) => attr("rep-2", { appointment_id: r.appointment_id }));
    expect(attributionDegradation(existing, same)).toBeNull();
    // manual_override rows are never strippable evidence
    const withManual = [...existing, attr("rep-1", { manual_override: true })];
    const stripNonManual = withManual.map((r) => attr(null, { appointment_id: r.appointment_id }));
    expect(attributionDegradation(withManual, stripNonManual)).toEqual({ stripped: 10, touched: 10 });
  });
});

describe("degradation guard (store upsert — memory store; PG shares the same pure fn)", () => {
  test("STALE-WRITER SHAPE: a 49→3-style rewrite is refused and the table keeps its verdicts", async () => {
    const store = new MemoryStore();
    const good = Array.from({ length: 12 }, () => attr("rep-1")).concat(Array.from({ length: 8 }, () => attr(null)));
    await store.upsertAttributions(good);
    const stale = good.map((r) => attr(r.rep_id === "rep-1" ? null : null, { appointment_id: r.appointment_id }));
    let threw = "";
    try {
      await store.upsertAttributions(stale); // would strip 10 of 12 attributed
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toContain("degradation guard");
    const after = await store.getAttributions();
    expect(after.filter((r) => r.rep_id != null)).toHaveLength(12); // UNCHANGED
    expect(after.filter((r) => r.rep_id == null)).toHaveLength(8);
  });

  test("force bypasses the guard (documented recovery), manual_override rows still skipped", async () => {
    const store = new MemoryStore();
    const good = Array.from({ length: 12 }, () => attr("rep-1"));
    const manual = attr("rep-9", { manual_override: true, method: "manual" });
    await store.upsertAttributions([...good, manual]);
    const stale = [...good, manual].map((r) => attr(null, { appointment_id: r.appointment_id }));
    await store.upsertAttributions(stale, { force: true });
    const after = await store.getAttributions();
    const manualRow = after.find((r) => r.appointment_id === manual.appointment_id)!;
    expect(manualRow.rep_id).toBe("rep-9"); // manual NEVER overwritten, even forced
    expect(after.filter((r) => r.rep_id === "rep-9")).toHaveLength(1);
  });

  test("small human-scale edits (touched < minimum) pass — the queue is never blocked", async () => {
    const store = new MemoryStore();
    const two = [attr("rep-1"), attr("rep-2")];
    await store.upsertAttributions(two);
    await store.upsertAttributions(two.map((r) => attr(null, { appointment_id: r.appointment_id }))); // strip 2 of 2
    expect((await store.getAttributions()).every((r) => r.rep_id === null)).toBe(true);
  });
});

describe("writer-version guard (computeAndPersistAttributions)", () => {
  test("OUTDATED WRITER: a writer older than the recorded version refuses; error sync_run; table untouched", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    const rep = await seedUsersContactCallBooking(store);
    await store.setSyncCheckpoint(ATTRIBUTION_WRITER_VERSION_KEY, String(ATTRIBUTION_WRITER_VERSION + 1));
    const settings = await store.getSettings();
    const res = await attributionTick({ store, settings, now, trigger: "manual" });
    expect(res.outcome).toBe("error");
    expect(res.error ?? "").toContain("writer-version guard");
    expect(await store.getAttributions()).toHaveLength(0); // NO upsert happened
    const runs = await store.getSyncRuns(5);
    const errRun = runs.find((r) => r.provider === "attribution" && r.status === "error");
    expect(errRun).toBeDefined(); // the refusal is VISIBLE in sync status
    expect(errRun?.error ?? "").toContain("writer-version guard");
    void rep;
  });

  test("EQUAL version writes and stamps; OLDER recorded version → fresh writer TAKES OVER (recovery)", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    await seedUsersContactCallBooking(store);
    const settings = await store.getSettings();
    await attributionTick({ store, settings, now, trigger: "manual" });
    expect(await store.getSyncCheckpoint(ATTRIBUTION_WRITER_VERSION_KEY)).toBe(String(ATTRIBUTION_WRITER_VERSION));
    expect((await store.getAttributions()).filter((r) => r.rep_id != null)).toHaveLength(1);
    // a recorded OLDER version (previous build) never blocks the fresh writer
    await store.setSyncCheckpoint(ATTRIBUTION_WRITER_VERSION_KEY, "1");
    const res2 = await computeAndPersistAttributions(store, settings, { now });
    expect(res2.outcome).toBe("synced");
    expect(await store.getSyncCheckpoint(ATTRIBUTION_WRITER_VERSION_KEY)).toBe(String(ATTRIBUTION_WRITER_VERSION));
  });

  test("force bypasses the version guard (deliberate owner-directed recompute)", async () => {
    resetAttributionThrottle();
    const store = new MemoryStore();
    await seedUsersContactCallBooking(store);
    await store.setSyncCheckpoint(ATTRIBUTION_WRITER_VERSION_KEY, String(ATTRIBUTION_WRITER_VERSION + 5));
    const settings = await store.getSettings();
    const res = await computeAndPersistAttributions(store, settings, { now, force: true });
    expect(res.outcome).toBe("synced");
    expect((await store.getAttributions()).filter((r) => r.rep_id != null)).toHaveLength(1);
  });
});
