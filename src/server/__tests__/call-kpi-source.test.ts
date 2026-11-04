/**
 * W3 CALL-KPI SOURCE SWITCH (owner directive 2026-11-04) — the KPI read path
 * moves from the legacy `calls` mirror to the RAW hl_call_records export.
 *
 * Pins:
 *  - PARITY: for a fixture day where both tables hold the SAME calls, the new
 *    source produces digit-identical Total/Over-2-Min/avg duration to the
 *    legacy table (same definition, new source — "attempts included").
 *  - The Nov-1 backfill-floor partition: pre-floor windows still draw the
 *    legacy mirror's rows, [floor..) draws hl_call_records, and the SAME call
 *    present in BOTH tables never double-counts.
 *  - TYPE_IVR_CALL excluded from rep AND team totals everywhere.
 *  - Null-user records: TEAM-level inbound bucket — counted in team totals
 *    (applyTeamCallScope), never a rep (applyRosterEligibility drops them);
 *    a KNOWN non-roster user's rows still drop from both.
 *  - ET day bucketing: a 23:00 ET record belongs to its ET date, never the
 *    next UTC day (America/New_York, November = EST).
 *  - Duration/talk-time math: null talk time = 0 (attempt), total/avg/unique
 *    leads/calls-per-lead/connect-rate exactly per the owner's KPI list.
 * MemoryStore-first: no DB, no clock, no network.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { CallRow, UserRow } from "../store/types";
import {
  applyTeamCallScope,
  callsPerBooking,
  filterCallRecordRowsInEtRange,
  hlCallRecordsToCallRows,
  HL_CALL_RECORDS_FLOOR_ISO,
  ivrCallRecords,
  loadCallKpiRows,
  summarizeCallRecordKpis,
  typeCallRecords,
} from "../metrics/call-records";
import { summarizeCalls, filterCallsInEtRange, pickupRateForDay } from "../metrics/compute";
import { applyRosterEligibility, buildRosterEligibility, type RosterEligibility } from "../roster";
import { etDayEndUtc, etDayStartUtc } from "../date-logic";

const TH = 120;

const user = (id: string, externalId: string, isActive = true): UserRow => ({
  id,
  provider: "highlevel",
  external_id: externalId,
  name: id,
  email: `${id}@example.com`,
  is_active: isActive,
  call_start_date: null,
});

const record = (
  messageId: string,
  dateAdded: string,
  opts: {
    userId?: string | null;
    duration?: number | null;
    status?: string | null;
    direction?: string | null;
    type?: string;
    contact?: string | null;
  } = {},
) => ({
  message_id: messageId,
  user_external_id: opts.userId ?? null,
  contact_external_id: opts.contact !== undefined ? opts.contact : `cnt_${messageId}`,
  conversation_id: `conv_${messageId}`,
  direction: opts.direction !== undefined ? opts.direction : "outbound",
  call_status: opts.status !== undefined ? opts.status : "completed",
  duration_seconds: opts.duration ?? 0,
  date_added: dateAdded,
  message_type: opts.type ?? "TYPE_CALL",
  source: "calls",
  from_number: "+19175550001",
  to_number: "+19175550002",
  raw: null,
});

const legacyCall = (r: {
  id: string;
  startedAt: string;
  duration: number;
  repId: string | null;
  userId?: string | null;
  contact?: string | null;
  direction?: string | null;
  status?: string | null;
}): CallRow & { provider: string; external_call_id: string } => ({
  id: r.id,
  rep_id: r.repId,
  contact_id: r.contact !== undefined ? r.contact : `cnt_${r.id}`,
  started_at: r.startedAt,
  duration_seconds: r.duration,
  over_two_minutes: r.duration > TH,
  external_call_id: r.id,
  provider_rep_external_id: r.userId !== undefined ? r.userId : null,
  conversation_id: `conv_${r.id}`,
  provider: "highlevel",
  direction: r.direction !== undefined ? r.direction : "outbound",
  call_status: r.status !== undefined ? r.status : "completed",
});

const ET_DAY = "2026-11-04"; // after the Nov-1 floor; EST (UTC-5)

async function seededBothSources() {
  const store = new MemoryStore();
  await store.upsertUsers([user("rep_allison", "Pf0rllLIswGz28ljL5pZ")]);
  // The SAME three calls land in BOTH tables (same definition fixture):
  // 240s completed outbound, 45s completed outbound, 0s no-answer attempt.
  const legacy = [
    legacyCall({ id: "msg_a", startedAt: "2026-11-04T14:00:00.000Z", duration: 240, repId: "rep_allison", userId: "Pf0rllLIswGz28ljL5pZ", status: "completed" }),
    legacyCall({ id: "msg_b", startedAt: "2026-11-04T15:30:00.000Z", duration: 45, repId: "rep_allison", userId: "Pf0rllLIswGz28ljL5pZ", status: "completed" }),
    legacyCall({ id: "msg_c", startedAt: "2026-11-04T18:10:00.000Z", duration: 0, repId: "rep_allison", userId: "Pf0rllLIswGz28ljL5pZ", status: "no-answer", contact: "cnt_b" }),
  ];
  await store.upsertCalls(legacy);
  await store.upsertHlCallRecords([
    record("msg_a", "2026-11-04T14:00:00.000Z", { userId: "Pf0rllLIswGz28ljL5pZ", duration: 240, status: "completed" }),
    record("msg_b", "2026-11-04T15:30:00.000Z", { userId: "Pf0rllLIswGz28ljL5pZ", duration: 45, status: "completed" }),
    record("msg_c", "2026-11-04T18:10:00.000Z", { userId: "Pf0rllLIswGz28ljL5pZ", duration: 0, status: "no-answer", contact: "cnt_b" }),
  ]);
  const users = await store.getAllUsers();
  return { store, users };
}

describe("W3 KPI SOURCE — parity (old calls table vs new hl_call_records)", () => {
  test("same fixture data → digit-identical Total / Over-2-Min / avg duration", async () => {
    const { store, users } = await seededBothSources();
    const start = etDayStartUtc(ET_DAY);
    const end = etDayEndUtc(ET_DAY);
    const kpiRows = await loadCallKpiRows({ store, users, startUtc: start, endUtc: end });
    const legacyRows = filterCallsInEtRange(await store.getCallsBetween(start, end), ET_DAY, ET_DAY);

    expect(kpiRows).toHaveLength(3); // IVR excluded, but none seeded here
    const fromNew = summarizeCalls(kpiRows, TH);
    const fromOld = summarizeCalls(legacyRows, TH);
    expect(fromNew).toEqual(fromOld);
    expect(fromNew.total).toBe(3);
    expect(fromNew.overThreshold).toBe(1); // only the 240s call
    expect(fromNew.avgDurationSeconds).toBe(Math.round((240 + 45 + 0) / 3));

    // Pickup Rate keeps its formula over the new source: (over + under) / total
    const pickup = pickupRateForDay(kpiRows, ET_DAY, TH);
    expect(pickup.totalCalls).toBe(3);
    expect(pickup.overTwoMin).toBe(1);
    expect(pickup.underTwoMin).toBe(1); // the 45s call
    expect(pickup.rate).toBeCloseTo(2 / 3);
  });

  test("rep attribution: hl userId → users.external_id → the rep's rows only", async () => {
    const { store, users } = await seededBothSources();
    const rows = await loadCallKpiRows({
      store,
      users,
      startUtc: etDayStartUtc(ET_DAY),
      endUtc: etDayEndUtc(ET_DAY),
    });
    const elig = buildRosterEligibility(await store.getUsers(), []);
    const repRows = applyRosterEligibility(rows, elig);
    expect(repRows).toHaveLength(3);
    // MemoryStore assigns its own canonical ids on upsert — read the rep id
    // back from the store, never assume the seed id.
    const allisonId = (await store.getAllUsers()).find((u) => u.external_id === "Pf0rllLIswGz28ljL5pZ")!.id;
    expect(repRows.every((r) => r.rep_id === allisonId)).toBe(true);
    // the raw HL user id is preserved verbatim on every row (immutable source)
    expect(repRows.every((r) => r.provider_rep_external_id === "Pf0rllLIswGz28ljL5pZ")).toBe(true);
  });
});

describe("W3 KPI SOURCE — the Nov-1 backfill-floor partition", () => {
  test("pre-floor window reads the legacy mirror; [floor..) reads hl_call_records; no double count", async () => {
    const store = new MemoryStore();
    await store.upsertUsers([user("rep_allison", "Pf0rllLIswGz28ljL5pZ")]);
    // Legacy mirror has rows BOTH before and after the floor (it keeps syncing).
    await store.upsertCalls([
      legacyCall({ id: "old_1", startedAt: "2026-10-31T15:00:00.000Z", duration: 60, repId: "rep_allison", userId: "Pf0rllLIswGz28ljL5pZ" }),
      legacyCall({ id: "new_1", startedAt: "2026-11-02T15:00:00.000Z", duration: 60, repId: "rep_allison", userId: "Pf0rllLIswGz28ljL5pZ" }),
    ]);
    // hl_call_records only exists from the floor onward.
    await store.upsertHlCallRecords([
      record("new_1", "2026-11-02T15:00:00.000Z", { userId: "Pf0rllLIswGz28ljL5pZ", duration: 60 }),
      record("new_2", "2026-11-02T16:00:00.000Z", { userId: "Pf0rllLIswGz28ljL5pZ", duration: 30 }),
    ]);

    // Window straddling the floor: Oct 31 legacy row + 2 hl rows (the legacy
    // Nov-2 twin of new_1 is dropped — instant-partitioned, never double-counted).
    const straddle = await loadCallKpiRows({
      store,
      users: await store.getAllUsers(),
      startUtc: etDayStartUtc("2026-10-31"),
      endUtc: etDayEndUtc("2026-11-02"),
    });
    const ext = (rows: CallRow[]) => rows.map((r) => r.external_call_id ?? r.id).sort();
    expect(ext(straddle)).toEqual(["new_1", "new_2", "old_1"]);

    // Fully pre-floor window: everything from the legacy mirror.
    const oct = await loadCallKpiRows({
      store,
      users: await store.getAllUsers(),
      startUtc: etDayStartUtc("2026-10-31"),
      endUtc: etDayEndUtc("2026-10-31"),
    });
    expect(ext(oct)).toEqual(["old_1"]);

    // Fully post-floor window: hl rows only.
    const nov = await loadCallKpiRows({
      store,
      users: await store.getAllUsers(),
      startUtc: etDayStartUtc("2026-11-02"),
      endUtc: etDayEndUtc("2026-11-02"),
    });
    expect(ext(nov)).toEqual(["new_1", "new_2"]);
  });

  test("the floor constant matches the backfill script's owner-set floor", () => {
    // scripts/backfill-hl-call-records.ts BACKFILL_FLOOR_ISO = 2026-11-01T00:00:00-05:00
    expect(HL_CALL_RECORDS_FLOOR_ISO).toBe("2026-11-01T05:00:00.000Z");
    expect(Date.parse(HL_CALL_RECORDS_FLOOR_ISO)).toBe(Date.parse("2026-11-01T00:00:00-05:00"));
  });
});

describe("W3 KPI SOURCE — TYPE_IVR_CALL exclusion + null-user team bucket", () => {
  test("IVR records never reach the KPI rows; ivrCallRecords surfaces them separately", async () => {
    const store = new MemoryStore();
    await store.upsertUsers([user("rep_allison", "Pf0rllLIswGz28ljL5pZ")]);
    await store.upsertHlCallRecords([
      record("ivr_1", "2026-11-04T14:00:00.000Z", { type: "TYPE_IVR_CALL", duration: 90, status: "completed", userId: null }),
      record("call_1", "2026-11-04T14:05:00.000Z", { userId: "Pf0rllLIswGz28ljL5pZ", duration: 60 }),
    ]);
    const raw = await store.getHlCallRecordsBetween(etDayStartUtc(ET_DAY), etDayEndUtc(ET_DAY));
    expect(typeCallRecords(raw)).toHaveLength(1);
    expect(ivrCallRecords(raw)).toHaveLength(1);
    const kpiRows = await loadCallKpiRows({ store, users: await store.getAllUsers(), startUtc: etDayStartUtc(ET_DAY), endUtc: etDayEndUtc(ET_DAY) });
    expect(kpiRows.map((r) => r.id)).toEqual(["call_1"]); // IVR excluded everywhere
  });

  test("null-user records: team scope KEEPS them, rep scope drops them; non-roster user drops from both", async () => {
    const store = new MemoryStore();
    await store.upsertUsers([
      user("rep_allison", "Pf0rllLIswGz28ljL5pZ"),
      user("nonroster", "ext_nonroster", false), // known HL user NOT on the roster
    ]);
    const rows = hlCallRecordsToCallRows(
      [
        record("rep_1", "2026-11-04T14:00:00.000Z", { userId: "Pf0rllLIswGz28ljL5pZ", duration: 60 }),
        record("team_1", "2026-11-04T14:01:00.000Z", { userId: null, duration: 30, direction: "inbound" }),
        record("other_1", "2026-11-04T14:02:00.000Z", { userId: "ext_nonroster", duration: 30 }),
        record("unknown_1", "2026-11-04T14:03:00.000Z", { userId: "ext_nobody", duration: 30 }),
      ],
      await store.getAllUsers(),
    );
    const elig = buildRosterEligibility(await store.getUsers(), []);
    const team = applyTeamCallScope(rows, elig);
    // roster rep + the null-user inbound bucket; non-roster and unknown users drop
    expect(team.map((r) => r.id).sort()).toEqual(["rep_1", "team_1"]);
    const repScope = applyRosterEligibility(rows, elig);
    expect(repScope.map((r) => r.id)).toEqual(["rep_1"]); // never a rep
    // the team bucket row keeps rep_id NULL (counted, never attributed)
    expect(team.find((r) => r.id === "team_1")?.rep_id).toBeNull();
  });

  test("mapping-driven eligibility still applies to hl rows (mapped user → eligible rep)", async () => {
    const store = new MemoryStore();
    await store.upsertUsers([user("rep_allison", "Pf0rllLIswGz28ljL5pZ")]);
    const rows = hlCallRecordsToCallRows(
      [record("mapped_1", "2026-11-04T14:00:00.000Z", { userId: "ext_legacy_user", duration: 60 })],
      await store.getAllUsers(), // no user row for ext_legacy_user
    );
    expect(rows[0].rep_id).toBeNull();
    expect(rows[0].provider_rep_external_id).toBe("ext_legacy_user");
    // the owner maps that HL user to Allison in Settings → the row becomes hers
    // (RosterEligibility contract: activeIds + HL external id → rep id)
    const allisonId2 = (await store.getAllUsers()).find((u) => u.external_id === "Pf0rllLIswGz28ljL5pZ")!.id;
    const elig: RosterEligibility = { activeIds: new Set([allisonId2]), mapping: new Map([["ext_legacy_user", allisonId2]]) };
    const team = applyTeamCallScope(rows, elig);
    expect(team).toHaveLength(1);
    expect(team[0].rep_id).toBe(allisonId2);
  });
});

describe("W3 KPI SOURCE — ET business-day bucketing (no UTC drift)", () => {
  test("a 23:00 ET record buckets to its ET date, never the next UTC day", async () => {
    const store = new MemoryStore();
    // 23:00 ET on Nov 4 (EST, UTC-5) = 2026-11-05T04:00:00Z — the NEXT UTC day.
    const late = record("late_1", "2026-11-05T04:00:00.000Z", { userId: "Pf0rllLIswGz28ljL5pZ", duration: 60 });
    const nextDay = record("next_1", "2026-11-05T15:00:00.000Z", { userId: "Pf0rllLIswGz28ljL5pZ", duration: 60 });
    const rows = hlCallRecordsToCallRows([late, nextDay], [user("rep_allison", "Pf0rllLIswGz28ljL5pZ")]);
    expect(filterCallRecordRowsInEtRange(rows, "2026-11-04", "2026-11-04").map((r) => r.id)).toEqual(["late_1"]);
    expect(filterCallRecordRowsInEtRange(rows, "2026-11-05", "2026-11-05").map((r) => r.id)).toEqual(["next_1"]);

    // and the store-level KPI load agrees (the SQL bounds are the same instants)
    await store.upsertUsers([user("rep_allison", "Pf0rllLIswGz28ljL5pZ")]);
    await store.upsertHlCallRecords([late, nextDay]);
    const day4 = await loadCallKpiRows({ store, users: await store.getAllUsers(), startUtc: etDayStartUtc("2026-11-04"), endUtc: etDayEndUtc("2026-11-04") });
    expect(day4.map((r) => r.id)).toEqual(["late_1"]);
  });
});

describe("W3 KPI set — the owner's numbers (directive 11/4)", () => {
  test("total/outbound/inbound/connected/no-answer/failed/missed/talk-time/unique-leads/calls-per-lead/connect-rate", () => {
    const rows = hlCallRecordsToCallRows(
      [
        record("a", "2026-11-04T14:00:00.000Z", { userId: "u", duration: 300, status: "completed", direction: "outbound", contact: "c1" }),
        record("b", "2026-11-04T14:05:00.000Z", { userId: "u", duration: 44, status: "completed", direction: "outbound", contact: "c1" }),
        record("c", "2026-11-04T14:10:00.000Z", { userId: "u", duration: 0, status: "no-answer", direction: "outbound", contact: "c2" }),
        record("d", "2026-11-04T14:15:00.000Z", { userId: "u", duration: 0, status: "failed", direction: "inbound", contact: "c3" }),
        record("e", "2026-11-04T14:20:00.000Z", { userId: "u", duration: null, status: "voicemail", direction: "inbound", contact: "c3" }),
        record("f", "2026-11-04T14:25:00.000Z", { userId: "u", duration: 120, status: "busy", direction: "inbound", contact: "c4" }),
        record("g", "2026-11-04T14:30:00.000Z", { userId: "u", duration: 0, status: "ringing", direction: null, contact: null }),
      ],
      [user("rep", "u")],
    );
    const k = summarizeCallRecordKpis(rows);
    expect(k.total).toBe(7);
    expect(k.outbound).toBe(3);
    expect(k.inbound).toBe(3);
    expect(k.otherStatus).toBe(1); // ringing + null direction
    expect(k.connected).toBe(2);
    expect(k.noAnswer).toBe(1);
    expect(k.failed).toBe(1);
    expect(k.busy).toBe(1);
    expect(k.voicemail).toBe(1);
    expect(k.missed).toBe(3); // no-answer + busy + voicemail
    expect(k.totalTalkSeconds).toBe(300 + 44 + 0 + 0 + 0 + 120 + 0); // null talk time = 0
    expect(k.avgTalkSeconds).toBe(Math.round(464 / 7));
    expect(k.uniqueLeadsContacted).toBe(4); // c1 c2 c3 c4 (null contact never counted)
    expect(k.callsPerLead).toBeCloseTo(7 / 4);
    expect(k.connectRate).toBeCloseTo(2 / 7);
  });

  test("zero denominators render null (—), never a fabricated 0", () => {
    expect(summarizeCallRecordKpis([]).avgTalkSeconds).toBeNull();
    expect(summarizeCallRecordKpis([]).connectRate).toBeNull();
    expect(summarizeCallRecordKpis([]).callsPerLead).toBeNull();
    expect(callsPerBooking(50, 0)).toBeNull();
    expect(callsPerBooking(50, 4)).toBe(12.5);
  });
});

describe("W3 store reads — instant bounds on hl_call_records", () => {
  test("getHlCallRecordsBetween is [start, end) — the same shape as getCallsBetween", async () => {
    const store = new MemoryStore();
    await store.upsertHlCallRecords([
      record("in_1", "2026-11-04T14:00:00.000Z"),
      record("in_2", "2026-11-04T20:00:00.000Z"),
      record("out_before", "2026-11-03T20:00:00.000Z"),
      record("out_after", "2026-11-05T05:00:00.000Z"), // 00:00 ET Nov 5 — outside
    ]);
    const rows = await store.getHlCallRecordsBetween(etDayStartUtc(ET_DAY), etDayEndUtc(ET_DAY));
    expect(rows.map((r) => r.message_id).sort()).toEqual(["in_1", "in_2"]);
    const since = await store.getAllHlCallRecordsSince("2026-11-04T00:00:00.000Z");
    expect(since.map((r) => r.message_id).sort()).toEqual(["in_1", "in_2", "out_after"]);
  });
});
