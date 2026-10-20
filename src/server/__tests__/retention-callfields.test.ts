/**
 * REGRESSION PIN — call direction/call_status must ride EVERY store read path
 * (2026-10-20 stage-3a live-fire outage): pg's getCallsBetween/getAllCallsSince
 * SELECTs omitted the direction + call_status columns, so the retention
 * compute saw `direction: undefined` on every call, attributeCall bailed to
 * "unattributed" for EVERY call, and the live-fire wrote 0 attempts / 0
 * classes while the chain-proof gate had proven ≥15 in-window attributed
 * calls on the same data. The failure was invisible to bun (no type-check)
 * and to memory-store tests (which seed full rows), so it is pinned here at
 * the STORE read-path level, in both stores:
 *   - MemoryStore: rows normalized to always-present (null when absent).
 *   - PgStore (TEST_DATABASE_URL gated): every live row carries BOTH keys.
 * A read path that drops either key fails this file before it can zero the
 * retention engine again.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { CallRow } from "../metrics/compute";

const base = {
  id: "",
  rep_id: null,
  contact_id: null,
  started_at: "2026-10-19T15:00:00Z",
  duration_seconds: 30,
  over_two_minutes: false,
} as unknown as CallRow;

describe("call read paths carry direction/call_status (zero-attempt outage pin)", () => {
  test("MemoryStore: getCallsBetween/getAllCallsSince normalize both keys (null when absent)", async () => {
    const store = new MemoryStore();
    await store.upsertCalls([
      // Row WITH direction/status (the harvest always writes them):
      { ...base, provider: "highlevel", external_call_id: "CF1", direction: "outbound", call_status: "voicemail" },
      // Row WITHOUT them (legacy fixture shape): must surface as null, never undefined.
      { ...base, provider: "highlevel", external_call_id: "CF2" },
    ] as never);
    for (const rows of [await store.getCallsBetween("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), await store.getAllCallsSince("2026-01-01T00:00:00Z")]) {
      expect(rows.length).toBe(2);
      for (const r of rows) {
        expect(Object.prototype.hasOwnProperty.call(r, "direction")).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(r, "call_status")).toBe(true);
        expect(r.direction).not.toBeUndefined();
        expect(r.call_status).not.toBeUndefined();
      }
      const with_ = rows.find((r) => r.external_call_id === "CF1");
      const without = rows.find((r) => r.external_call_id === "CF2");
      expect(with_!.direction).toBe("outbound");
      expect(with_!.call_status).toBe("voicemail");
      expect(without!.direction).toBeNull();
      expect(without!.call_status).toBeNull();
    }
  });
});

import { PgStore } from "../store/pg";
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("call read paths — PgStore (real Postgres)", () => {
  test("getCallsBetween/getAllCallsSince rows carry direction + call_status (live)", async () => {
    const store = new PgStore(TEST_DATABASE_URL!);
    const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    for (const rows of [await store.getAllCallsSince(since), await store.getCallsBetween(since, new Date().toISOString())]) {
      expect(rows.length).toBeGreaterThan(0); // the live DB has 60d of calls
      for (const r of rows) {
        expect(Object.prototype.hasOwnProperty.call(r, "direction")).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(r, "call_status")).toBe(true);
        expect(r.direction).not.toBeUndefined();
        expect(r.call_status).not.toBeUndefined();
      }
    }
  }, 120_000);
});
