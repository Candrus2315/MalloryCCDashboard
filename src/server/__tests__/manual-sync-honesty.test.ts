/**
 * MANUAL-SYNC HONESTY (portability 2026-11-05, PART 2 deliverable 2) — the
 * two manual sync actions may never display a success the pass did not earn.
 *
 * Pins, per the owner directive:
 *   • fail → timestamp unchanged + error surfaced (visible note / FAILED line);
 *   • success → timestamp advances (the post-pass store read);
 *   • skipped / stale source data → NO success display (skip note + previous
 *     status preserved; provider errors render as FAILED, never "complete").
 *
 * The timestamp rule itself is enforced at the source: both actions AWAIT the
 * real pass and re-read their stamps from the store, which stamps
 * last_successful_sync_at on SUCCESS only — these tests pin the display rules
 * that sit on top of that.
 */
import { describe, expect, test } from "bun:test";
import {
  freshnessAfterTick,
  noteFromThrownSync,
  syncCenterReport,
  type FreshnessResponse,
  type FreshnessStateSnapshot,
} from "../sync/manual-sync-report";

const T0 = Date.parse("2026-11-05T12:00:00Z");
const OLD = new Date(T0 - 7 * 60_000).toISOString(); // previous success stamp
const NEW = new Date(T0 - 30_000).toISOString(); // the pass's fresh stamp

const prev: FreshnessStateSnapshot = {
  status: "connected",
  lastSyncAt: OLD,
  lastSuccessAt: OLD,
  newestSuccessAt: OLD,
  lastError: null,
};

const res = (tick: FreshnessResponse["tick"], overrides: Partial<FreshnessResponse> = {}): FreshnessResponse => ({
  tick,
  lastSyncAt: NEW,
  lastSuccessAt: NEW,
  newestSuccessAt: NEW,
  lastError: null,
  running: false,
  serverNow: new Date(T0).toISOString(),
  ...overrides,
});

describe("manual SYNC NOW — the Sync Center status line", () => {
  test("all providers ok → the exact success line (byte-identical to the pre-P2 format)", () => {
    const r = syncCenterReport({
      mode: "postgres",
      providers: [
        { provider: "highlevel", count: 12, error: null },
        { provider: "acuity", count: 5, error: null },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.message).toBe("Sync complete (postgres): highlevel 12, acuity 5");
  });

  test("FAIL → provider error surfaced, no 'complete' anywhere, completed providers still listed", () => {
    const r = syncCenterReport({
      mode: "postgres",
      providers: [
        { provider: "highlevel", count: 0, error: "HighLevel 503 after 3 attempts" },
        { provider: "acuity", count: 5, error: null },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("complete");
    expect(r.message).toContain("Sync FAILED (postgres)");
    expect(r.message).toContain("highlevel: HighLevel 503 after 3 attempts");
    expect(r.message).toContain("ok: acuity 5");
  });

  test("stale source data (every provider errored) → no success display at all", () => {
    const r = syncCenterReport({
      mode: "postgres",
      providers: [
        { provider: "highlevel", count: 0, error: "connection refused" },
        { provider: "acuity", count: 0, error: "timeout" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("complete");
    expect(r.message).toContain("highlevel: connection refused");
    expect(r.message).toContain("acuity: timeout");
  });

  test("no provider ran → honest failure, never a fake complete", () => {
    const r = syncCenterReport({ mode: "memory", providers: [] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Sync FAILED (memory)");
    expect(r.message).toContain("no provider ran");
  });
});

describe("manual REFRESH — the shell freshness chip", () => {
  test("SUCCESS → timestamp advances, connected, note cleared", () => {
    const r = freshnessAfterTick(prev, res({ outcome: "synced" }));
    expect(r.ok).toBe(true);
    expect(r.note).toBeNull();
    expect(r.next.status).toBe("connected");
    expect(r.next.lastSuccessAt).toBe(NEW); // advanced past OLD
    expect(r.next.newestSuccessAt).toBe(NEW);
    expect(NEW !== prev.lastSuccessAt).toBe(true);
  });

  test("FAIL → timestamp unchanged (store never stamped a success) + VISIBLE error", () => {
    const err = "HighLevel pass failed: 503 after 3 attempts";
    const r = freshnessAfterTick(
      prev,
      res({ outcome: "error", error: err }, { lastSyncAt: OLD, lastSuccessAt: OLD, newestSuccessAt: OLD, lastError: err }),
    );
    expect(r.ok).toBe(false);
    expect(r.note).toContain("Sync failed");
    expect(r.note).toContain(err); // the visible note carries the real error
    expect(r.next.status).toBe("error");
    expect(r.next.lastSuccessAt).toBe(OLD); // unchanged — no optimistic stamp
    expect(r.next.newestSuccessAt).toBe(OLD);
    expect(r.next.lastError).toBe(err);
  });

  test("FAIL without a stored error still surfaces a visible note", () => {
    const r = freshnessAfterTick(prev, res({ outcome: "error" }, { lastSyncAt: OLD, lastSuccessAt: OLD, newestSuccessAt: OLD, lastError: null }));
    expect(r.ok).toBe(false);
    expect(r.note).toContain("Sync failed");
    expect(r.next.lastSuccessAt).toBe(OLD);
  });

  test("SKIPPED (another run in progress) → NO success display; previous status preserved", () => {
    const erroredPrev: FreshnessStateSnapshot = { ...prev, status: "error", lastError: "earlier failure" };
    const r = freshnessAfterTick(
      erroredPrev,
      res({ outcome: "skipped", reason: "another run in progress" }, { lastSyncAt: OLD, lastSuccessAt: OLD, newestSuccessAt: OLD }),
    );
    expect(r.ok).toBe(false);
    expect(r.note).toBe("Sync skipped — another run in progress");
    expect(r.next.status).toBe("error"); // a skip never erases the error dot
    expect(r.next.lastError).toBe("earlier failure");
    expect(r.next.lastSuccessAt).toBe(OLD); // unchanged
  });

  test("SKIPPED without a reason → default honest skip text", () => {
    const r = freshnessAfterTick(prev, res({ outcome: "skipped" }, { lastSyncAt: OLD, lastSuccessAt: OLD, newestSuccessAt: OLD }));
    expect(r.note).toBe("Sync skipped — another sync is already running");
    expect(r.next.lastSuccessAt).toBe(OLD);
  });

  test("the action itself throwing → visible note, and the rule is message-shaped", () => {
    const note = noteFromThrownSync(new Error("DB connect timeout"));
    expect(note).toBe("Sync failed — DB connect timeout");
    expect(noteFromThrownSync("boom")).toBe("Sync failed — boom");
  });
});
