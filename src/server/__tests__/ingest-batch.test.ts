/**
 * INGEST BATCHING + RUN DEADLINE + HONEST finishSyncRun (10/23 wedge fix).
 *
 * Pins the three MUST-SHIP behaviors that killed the sheets/attribution wedge
 * class (scratch/sheets-wedge-forensics.md §7):
 *   (i)   batching preserves semantics — chunk boundaries exact, no row
 *         dropped/duplicated/reordered; duplicate conflict keys dedupe
 *         LAST-WINS (what the per-row loop's sequential execution produced);
 *   (ii)  the per-run wall-clock deadline fires on a hung ingest loop (with an
 *         injectable clock — no sleeping) and does NOT fire on healthy runs;
 *   (iii) finishSyncRun is HONEST: it applies only while the run's status is
 *         still 'running' — a late detached zombie's finish can no longer
 *         overwrite the reaper's 'error' record (the 16:05 false recovery).
 */
import { describe, expect, test } from "bun:test";
import {
  INGEST_CHUNK_SIZE,
  INGEST_RUN_DEADLINE_MS,
  RunDeadlineExceeded,
  chunkRows,
  dedupeLast,
  makeRunDeadline,
} from "../store/ingest-batch";
import { MemoryStore } from "../store/memory";
import type { RunDeadline } from "../store/ingest-batch";

describe("chunkRows (ingest batching)", () => {
  test("INGEST_CHUNK_SIZE is 500 (3,860-row sheets run collapses to ~8 statements)", () => {
    expect(INGEST_CHUNK_SIZE).toBe(500);
  });

  test("empty payload -> no chunks", () => {
    expect(chunkRows([])).toEqual([]);
  });

  test("single row stays ONE chunk (single-row path semantics unchanged)", () => {
    const chunks = chunkRows([{ id: 1 }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([{ id: 1 }]);
  });

  test("boundaries: 499, 500, 501 rows", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
    expect(chunkRows(mk(499))).toHaveLength(1);
    expect(chunkRows(mk(500))).toHaveLength(1);
    expect(chunkRows(mk(501))).toHaveLength(2);
    expect(chunkRows(mk(501))[0]).toHaveLength(500);
    expect(chunkRows(mk(501))[1]).toHaveLength(1);
  });

  test("just-over and multi-chunk: no row dropped, duplicated, or reordered", () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ i }));
    const chunks = chunkRows(rows);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 1]);
    const flat = chunks.flat();
    expect(flat).toHaveLength(1001);
    expect(flat.map((r) => r.i)).toEqual(rows.map((r) => r.i));
  });

  test("custom size works (smaller than default)", () => {
    const rows = [1, 2, 3, 4, 5];
    const chunks = chunkRows(rows, 2);
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(chunks.flat()).toEqual(rows);
  });

  test("size < 1 is rejected (config typo cannot silently wedge the loop)", () => {
    expect(() => chunkRows([1], 0)).toThrow(/size must be >= 1/);
  });
});

describe("dedupeLast (multi-row ON CONFLICT safety)", () => {
  test("keeps the LAST occurrence per key — same final state as the per-row loop", () => {
    const rows = [
      { k: "a", v: 1 },
      { k: "b", v: 2 },
      { k: "a", v: 3 },
    ];
    expect(dedupeLast(rows, (r) => r.k)).toEqual([
      { k: "a", v: 3 },
      { k: "b", v: 2 },
    ]);
  });

  test("no duplicates -> identical payload, original order preserved", () => {
    const rows = [{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "c", v: 3 }];
    expect(dedupeLast(rows, (r) => r.k)).toEqual(rows);
  });

  test("empty payload -> empty", () => {
    expect(dedupeLast([], (r: { k: string }) => r.k)).toEqual([]);
  });

  test("keyOf composes (provider + source_id null-byte separator)", () => {
    const rows = [
      { provider: "p", source_id: "x", v: 1 },
      { provider: "px", source_id: "", v: 2 },
    ];
    const key = (r: { provider: string; source_id: string }) => r.provider + "\u0000" + r.source_id;
    expect(dedupeLast(rows, key)).toHaveLength(2); // separator prevents cross-collision
  });
});

describe("makeRunDeadline (per-run wall-clock deadline)", () => {
  test("INGEST_RUN_DEADLINE_MS = 40 min (reap bound 30 min + margin)", () => {
    expect(INGEST_RUN_DEADLINE_MS).toBe(40 * 60_000);
  });

  test("does NOT fire on a healthy run (elapsed under the limit)", () => {
    let clock = 0;
    const deadline: RunDeadline = makeRunDeadline({ label: "sheets", now: () => clock, limitMs: 40 * 60_000 });
    // a legit run observed max 21.5 min — walk well past that, under the cap
    for (const minute of [0, 5, 10, 20, 21.5, 30, 39].map((m) => m * 60_000)) {
      clock = minute;
      expect(() => deadline.check()).not.toThrow();
    }
  });

  test("FIRES (throws RunDeadlineExceeded) once the budget is exhausted — injectable clock, no sleep", () => {
    let clock = 0;
    const deadline: RunDeadline = makeRunDeadline({ label: "google_sheets", now: () => clock });
    expect(() => deadline.check()).not.toThrow(); // t=0
    clock = 40 * 60_000 - 1;
    expect(() => deadline.check()).not.toThrow(); // still under
    clock = 40 * 60_000;
    try {
      deadline.check();
      throw new Error("expected RunDeadlineExceeded");
    } catch (e) {
      expect(e).toBeInstanceOf(RunDeadlineExceeded);
      expect((e as RunDeadlineExceeded).name).toBe("RunDeadlineExceeded");
      expect((e as RunDeadlineExceeded).label).toBe("google_sheets");
      expect((e as RunDeadlineExceeded).elapsedMs).toBe(40 * 60_000);
      expect((e as RunDeadlineExceeded).limitMs).toBe(40 * 60_000);
      expect((e as Error).message).toContain("google_sheets");
    }
  });

  test("per-chunk check bounds a detached zombie: it stops at the NEXT chunk boundary, not after hours", () => {
    let clock = 0;
    const deadline: RunDeadline = makeRunDeadline({ label: "attribution", now: () => clock });
    const chunkMs = 60_000; // one chunk per minute under a flare
    const chunkCount = INGEST_RUN_DEADLINE_MS / chunkMs; // 40
    let executed = 0;
    expect(() => {
      for (let c = 0; c < chunkCount + 25; c++) {
        deadline.check(); // zombie keeps calling for 65 chunks
        executed += 1;
        clock += chunkMs;
      }
    }).toThrow(RunDeadlineExceeded);
    expect(executed).toBe(chunkCount); // stopped at the boundary, not 25 later
  });

  test("startedAtMs anchors at RUN START (not call time) and custom limitMs is honored", () => {
    const runStart = 1_000_000;
    let clock = runStart + 10 * 60_000; // 10 min into the run
    const deadline: RunDeadline = makeRunDeadline({ label: "acuity", startedAtMs: runStart, limitMs: 15 * 60_000, now: () => clock });
    expect(() => deadline.check()).not.toThrow();
    clock = runStart + 15 * 60_000;
    expect(() => deadline.check()).toThrow(RunDeadlineExceeded);
  });

  test("default clock is Date.now (default-constructed deadline is immediately valid)", () => {
    const deadline: RunDeadline = makeRunDeadline({ label: "ingest" });
    expect(deadline.startedAtMs).toBeLessThanOrEqual(Date.now());
    expect(deadline.limitMs).toBe(INGEST_RUN_DEADLINE_MS);
    expect(() => deadline.check()).not.toThrow();
  });
});

describe("finishSyncRun is HONEST (conditional on status = 'running')", () => {
  test("applies to a running run: returns true and transitions the row", async () => {
    const store = new MemoryStore();
    const id = await store.insertSyncRun("google_sheets");
    await expect(store.finishSyncRun(id, "success", 3860, null)).resolves.toBe(true);
    const [run] = await store.getSyncRuns(10);
    expect(run.id).toBe(id);
    expect(run.status).toBe("success");
    expect(run.records_upserted).toBe(3860);
    expect(run.error).toBeNull();
    expect(run.finished_at).not.toBeNull();
  });

  test("REJECTS a late finish after the run already finished — returns false, row untouched", async () => {
    const store = new MemoryStore();
    const id = await store.insertSyncRun("google_sheets");
    await store.finishSyncRun(id, "success", 100, null);
    // the detached zombie finally drains and calls finish again — must NOT win
    await expect(store.finishSyncRun(id, "success", 3860, null)).resolves.toBe(false);
    const [run] = await store.getSyncRuns(10);
    expect(run.status).toBe("success");
    expect(run.records_upserted).toBe(100); // the FIRST finish's record stands
  });

  test("REJECTS a late finish after the reaper marked the row 'error' — no false recovery (the 16:05 bug)", async () => {
    const store = new MemoryStore();
    const id = await store.insertSyncRun("attribution");
    // the reaper closes the stale row honestly
    await store.finishSyncRun(id, "error", 0, "stale: reaped after 30 min");
    const reapRows = await store.getSyncRuns(10);
    expect(reapRows[0].status).toBe("error");
    expect(reapRows[0].error).toContain("stale:");
    // 40 min later the zombie chain drains and reports "success"
    await expect(store.finishSyncRun(id, "success", 3857, null)).resolves.toBe(false);
    const [run] = await store.getSyncRuns(10);
    expect(run.status).toBe("error"); // reaper's record stands
    expect(run.records_upserted).toBe(0); // zombie's inflated count discarded
    expect(run.error).toContain("stale:");
  });

  test("unknown id -> false (no crash, nothing written)", async () => {
    const store = new MemoryStore();
    await expect(store.finishSyncRun("sync_missing", "success", 5, null)).resolves.toBe(false);
  });
});
