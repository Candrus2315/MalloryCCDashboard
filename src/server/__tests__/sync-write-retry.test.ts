/**
 * SYNC WRITE RESILIENCE pin tests (2026-10-12) — no live DB needed.
 *
 * The sync layer's write paths now retry transient connection-class DB
 * failures (the 10/11 provider degradation: post-cap CONNECT_TIMEOUTs while
 * raw TCP was fine). These tests pin, at the MemoryStore level, that:
 *
 *  1. an IDEMPOTENT sync write (content-keyed upsert) retried after a
 *     transient failure succeeds and is applied EXACTLY ONCE;
 *  2. a NON-IDEMPOTENT / excluded sync write (plain-INSERT sync-run rows;
 *     the counter-incrementing markHarvestVisited) is NOT retried — it
 *     fails through immediately with the original error;
 *  3. a write that exhausts its bounded attempts FAILS HONESTLY with the
 *     original error (no silent swallowing, no fabricated success);
 *  4. business-path writes (commission adjustments, settings) and the
 *     allowlist surface itself never change: excluded members are absent
 *     from the allowlist, and wrapping is a no-op on already-wrapped stores.
 *
 * Reuses the read-path engine (store/pg-retry.ts) — same transient-error
 * classification, same bounded constants (3 attempts, 150/450ms + jitter).
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { Store } from "../store/types";
import {
  RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
} from "../store/pg-retry";
import {
  SYNC_WRITE_RETRYABLE_METHODS,
  isSyncWriteRetryWrapped,
  withSyncWriteRetry,
} from "../store/sync-write-retry";

/** Injects transient DB failures (57P01 admin termination) on demand. */
class FlakyMemoryStore extends MemoryStore {
  failuresLeft = 0;
  calls: Record<string, number> = {};

  private transientError(): Error {
    const e = new Error("terminating connection due to administrator command");
    (e as { code?: string }).code = "57P01"; // admin termination — transient per pg-retry.ts
    return e;
  }
  /** Count the call, then fail transiently while failures remain. */
  private instrumented(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.transientError();
    }
  }
  override async upsertLeads(rows: Parameters<Store["upsertLeads"]>[0]): Promise<number> {
    this.instrumented("upsertLeads");
    return super.upsertLeads(rows);
  }
  override async upsertContacts(rows: Parameters<Store["upsertContacts"]>[0]): Promise<number> {
    this.instrumented("upsertContacts");
    return super.upsertContacts(rows);
  }
  override async insertSyncRun(provider: string): Promise<string> {
    this.instrumented("insertSyncRun");
    return super.insertSyncRun(provider);
  }
  override async insertAvailabilitySyncRun(scope: Record<string, unknown>): Promise<string> {
    this.instrumented("insertAvailabilitySyncRun");
    return super.insertAvailabilitySyncRun(scope);
  }
  override async markHarvestVisited(
    convIds: string[],
    callsFoundByConv: Record<string, number>,
    messagesScannedByConv?: Record<string, number>,
  ): Promise<void> {
    this.instrumented("markHarvestVisited");
    return super.markHarvestVisited(convIds, callsFoundByConv, messagesScannedByConv);
  }
  override async insertCommissionAdjustment(
    row: Parameters<Store["insertCommissionAdjustment"]>[0],
  ): Promise<unknown> {
    this.instrumented("insertCommissionAdjustment");
    return super.insertCommissionAdjustment(row);
  }
}

/** No-op sleep + retry observer (pool-retry.test.ts pattern). */
const noopSleep = { fn: (_ms: number) => Promise.resolve(), calls: [] as number[] };
const observations: { attempt: number; delayMs: number }[] = [];
const retryOpts = {
  sleep: (ms: number) => noopSleep.fn(ms),
  onRetry: (attempt: number, _e: unknown, delayMs: number) => {
    observations.push({ attempt, delayMs });
  },
};
function resetHarness(): void {
  noopSleep.calls = [];
  observations.length = 0;
}

const leadRow = (): Parameters<Store["upsertLeads"]>[0][number] => ({
  id: "l-resilience-1",
  lead_type: "family",
  source_date: "2026-10-08",
  work_date: "2026-10-09",
  contact_id: "k-resilience-1",
  assigned_rep_id: "rep-resilience-1",
  source_sheet: "family",
  source_id: "gs2#family#d2026-10-08#resilience-1",
  provider: "sheets",
});

describe("sync-write-retry — allowlist surface", () => {
  test("every allowlisted method is a real Store method (no stale names)", () => {
    const probe = new MemoryStore() as unknown as Record<string, unknown>;
    for (const method of SYNC_WRITE_RETRYABLE_METHODS) {
      expect(typeof probe[method]).toBe("function");
    }
  });

  test("NON-IDEMPOTENT sync writes are excluded (double-apply hazard)", () => {
    const listed = new Set<string>(SYNC_WRITE_RETRYABLE_METHODS);
    // plain INSERTs — a committed-but-unacknowledged attempt + retry would
    // create a SECOND sync-run row
    expect(listed.has("insertSyncRun")).toBe(false);
    expect(listed.has("insertAvailabilitySyncRun")).toBe(false);
    // counter INCREMENT (messages_scanned = messages_scanned + N) — a retry
    // after an unacknowledged commit would double-count
    expect(listed.has("markHarvestVisited")).toBe(false);
    // business paths — commission stored-week money and settings never retry
    expect(listed.has("insertCommissionAdjustment")).toBe(false);
    expect(listed.has("saveSettings")).toBe(false);
  });
});

describe("sync-write-retry — idempotent writes retry + apply exactly once", () => {
  test("content-keyed lead upsert: transient failure retried, one row stored", async () => {
    resetHarness();
    const flaky = new FlakyMemoryStore();
    flaky.failuresLeft = 1; // first attempt fails, second succeeds
    const wrapped = withSyncWriteRetry(flaky, retryOpts);
    const n = await wrapped.upsertLeads([leadRow()]);
    expect(n).toBe(1);
    // exactly-once EFFECT: one content-keyed lead row after fail+retry
    expect(await wrapped.countLeads("sheets")).toBe(1);
    // bounded retry shape: two attempts total, one backoff step
    expect(flaky.calls.upsertLeads).toBe(2);
    expect(observations).toEqual([{ attempt: 1, delayMs: expect.any(Number) }]);
  });

  test("exhausted attempts: the write fails HONESTLY with the original error", async () => {
    resetHarness();
    const flaky = new FlakyMemoryStore();
    flaky.failuresLeft = RETRY_ATTEMPTS; // every attempt fails
    const wrapped = withSyncWriteRetry(flaky, retryOpts);
    await expect(wrapped.upsertLeads([leadRow()])).rejects.toThrow(
      "terminating connection due to administrator command",
    );
    // bounded: exactly RETRY_ATTEMPTS attempts, no silent swallowing
    expect(flaky.calls.upsertLeads).toBe(RETRY_ATTEMPTS);
    expect(await wrapped.countLeads("sheets")).toBe(0); // nothing fabricated
    expect(observations.length).toBe(RETRY_ATTEMPTS - 1);
  });

  test("healthy store: zero behavior change — one call, no retries", async () => {
    resetHarness();
    const plain = new FlakyMemoryStore();
    const wrapped = withSyncWriteRetry(plain, retryOpts);
    await wrapped.upsertLeads([leadRow()]);
    expect(plain.calls.upsertLeads).toBe(1);
    expect(observations.length).toBe(0);
    expect(await wrapped.countLeads("sheets")).toBe(1);
  });

  test("business error (non-connection class) is never retried", async () => {
    resetHarness();
    const store = new MemoryStore();
    let calls = 0;
    const broken = withSyncWriteRetry(
      new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === "upsertLeads") {
            return async () => {
              calls += 1;
              const e = new Error('duplicate key value violates unique constraint "leads_pkey"');
              (e as { code?: string }).code = "23505";
              throw e;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as Store,
      retryOpts,
    );
    await expect(broken.upsertLeads([leadRow()])).rejects.toThrow("duplicate key");
    expect(calls).toBe(1); // constraint errors never retry
  });
});

describe("sync-write-retry — excluded writes never retry", () => {
  test("insertSyncRun (plain INSERT): fails through on the first attempt", async () => {
    resetHarness();
    const flaky = new FlakyMemoryStore();
    flaky.failuresLeft = 1;
    const wrapped = withSyncWriteRetry(flaky, retryOpts);
    await expect(wrapped.insertSyncRun("highlevel")).rejects.toThrow(
      "terminating connection due to administrator command",
    );
    expect(flaky.calls.insertSyncRun).toBe(1); // NOT retried — double-apply hazard
    expect(observations.length).toBe(0);
  });

  test("insertAvailabilitySyncRun (plain INSERT): not retried", async () => {
    resetHarness();
    const flaky = new FlakyMemoryStore();
    flaky.failuresLeft = 1;
    const wrapped = withSyncWriteRetry(flaky, retryOpts);
    await expect(wrapped.insertAvailabilitySyncRun({ calendar_id: "c1" })).rejects.toThrow(
      "terminating connection due to administrator command",
    );
    expect(flaky.calls.insertAvailabilitySyncRun).toBe(1);
    expect(observations.length).toBe(0);
  });

  test("markHarvestVisited (counter increment): not retried", async () => {
    resetHarness();
    const flaky = new FlakyMemoryStore();
    flaky.failuresLeft = 1;
    const wrapped = withSyncWriteRetry(flaky, retryOpts);
    await expect(wrapped.markHarvestVisited([], {}, {})).rejects.toThrow(
      "terminating connection due to administrator command",
    );
    expect(flaky.calls.markHarvestVisited).toBe(1);
    expect(observations.length).toBe(0);
  });

  test("insertCommissionAdjustment (business/money path): not retried", async () => {
    resetHarness();
    const flaky = new FlakyMemoryStore();
    flaky.failuresLeft = 1;
    const wrapped = withSyncWriteRetry(flaky, retryOpts);
    await expect(
      wrapped.insertCommissionAdjustment({
        cycle_id: "cycle",
        user_id: "user",
        target: "weekly_record",
        target_id: "x",
        field: "manual_adjustment",
        old_value: "0",
        new_value: "-25",
        reason: "pin test",
        changed_by: "Manager",
      } as Parameters<Store["insertCommissionAdjustment"]>[0]),
    ).rejects.toThrow("terminating connection due to administrator command");
    expect(flaky.calls.insertCommissionAdjustment).toBe(1);
    expect(observations.length).toBe(0);
  });
});

describe("sync-write-retry — wrapper hygiene", () => {
  test("double-wrap is a no-op (retries never stack)", () => {
    const wrapped = withSyncWriteRetry(new MemoryStore(), retryOpts);
    expect(isSyncWriteRetryWrapped(wrapped)).toBe(true);
    expect(withSyncWriteRetry(wrapped, retryOpts)).toBe(wrapped);
  });

  test("reads and pass-through members keep working (mode, getSettings)", async () => {
    const wrapped = withSyncWriteRetry(new MemoryStore(), retryOpts);
    expect(wrapped.mode).toBe("memory");
    const settings = await wrapped.getSettings();
    expect(typeof settings).toBe("object");
  });

  test("engine constants are the shared pg-retry ones (no fork)", () => {
    // the wrapper reuses withDbRetry — same attempts + base delay, so worst
    // added latency stays the documented ≲750ms window
    expect(RETRY_ATTEMPTS).toBe(3);
    expect(RETRY_BASE_DELAY_MS).toBe(150);
  });
});
