/**
 * PASS-START DB WARMUP (store/db-warmup.ts) — MemoryStore-first tests, no live
 * DB needed. Pins the 2026-11-04 fast-fail contract:
 *   - a healthy ping is ONE call, zero retries (zero behavior change);
 *   - a refused connect (the incident's `write CONNECT_TIMEOUT host:port`
 *     shape) retries through the SAME withDbRetry engine — attempt 1/3 —
 *     and a persistent failure surfaces the ORIGINAL error;
 *   - a ping that NEVER SETTLES (the actual 30-minute wedge: a stale pooled
 *     connection with no driver-side bound) is raced off the shared connect
 *     budget and then retried identically;
 *   - stores without a ping (test fakes) are untouched — transport hardening
 *     is never a test-facing contract;
 *   - MemoryStore integrates (real Store instance).
 */
import { describe, expect, test } from "bun:test";
import { warmDbConnectionForRun, DbWarmupStalledError } from "../store/db-warmup";
import { DEFAULT_DB_CONNECT_TIMEOUT_MS } from "../store/db-pool-config";
import type { Store } from "../store/types";
import { MemoryStore } from "../store/memory";

/** The exact incident shape: postgres.js tags connection errors with the token. */
function incidentConnectError(): Error {
  const e = new Error("write CONNECT_TIMEOUT stbnavfcoc.k86199vsvs.tsdb.cloud.timescale.com:30629");
  (e as { code?: string }).code = "CONNECT_TIMEOUT";
  return e;
}

/** A Store-shaped minimal fake with an optional ping — casts keep it honest. */
function fakeStore(ping?: () => Promise<unknown>): Store {
  return { ping, insertSyncRun: async () => "run", finishSyncRun: async () => true } as unknown as Store;
}

describe("warmDbConnectionForRun — healthy path", () => {
  test("one ping, resolves, zero retries", async () => {
    let calls = 0;
    await warmDbConnectionForRun(fakeStore(async () => {
      calls++;
      return true;
    }));
    expect(calls).toBe(1);
  });

  test("MemoryStore integrates — the real Store surface resolves", async () => {
    await warmDbConnectionForRun(new MemoryStore());
  });

  test("store without a ping (test fakes) is a no-op — never a test-facing contract", async () => {
    await warmDbConnectionForRun(fakeStore(undefined));
  });
});

describe("warmDbConnectionForRun — refused connect (incident shape) retries 1/3", () => {
  test("transient CONNECT_TIMEOUT failures retry through the shared engine and succeed", async () => {
    let calls = 0;
    await warmDbConnectionForRun(
      fakeStore(async () => {
        calls++;
        if (calls <= 2) throw incidentConnectError();
        return true;
      }),
    );
    expect(calls).toBe(3); // 1 initial + 2 retries (RETRY_ATTEMPTS)
  });

  test("persistent dead host: the ORIGINAL error surfaces after the bounded attempts", async () => {
    let calls = 0;
    try {
      await warmDbConnectionForRun(
        fakeStore(async () => {
          calls++;
          throw incidentConnectError();
        }),
      );
      expect(true).toBe(false); // unreachable
    } catch (e) {
      expect((e as Error).message).toContain("stbnavfcoc.k86199vsvs.tsdb.cloud.timescale.com:30629");
      expect((e as { code?: string }).code).toBe("CONNECT_TIMEOUT");
    }
    expect(calls).toBe(3);
  });
});

describe("warmDbConnectionForRun — the stalled wedge (never settles) is raced off the budget", () => {
  test("stalled first attempt rejects with the budget cap; the retried attempt settles — pass continues", async () => {
    let calls = 0;
    let release: ((v: unknown) => void) | null = null;
    const store = fakeStore(
      () =>
        new Promise<unknown>((resolve) => {
          calls++;
          if (calls === 1) return; // attempt 1 parks forever — the wedge shape
          release = resolve; // attempt 2 settles when the test releases it
        }),
    );
    const run = warmDbConnectionForRun(store, { connectTimeoutMs: 30 });
    // wait for attempt 2 to be pending (stall cap 30ms + retry backoff ≤ 450ms)
    const deadline = Date.now() + 3_000;
    while (release == null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(release).not.toBeNull();
    release!(true);
    await run; // the warmup completes instead of wedging
    expect(calls).toBe(2);
  });

  test("persistently stalled ping: DbWarmupStalledError (CONNECT_TIMEOUT class) after the bounded attempts", async () => {
    let calls = 0;
    try {
      await warmDbConnectionForRun(
        fakeStore(
          () =>
            new Promise<unknown>(() => {
              calls++; // parks forever — every attempt
            }),
        ),
        { connectTimeoutMs: 20 },
      );
      expect(true).toBe(false); // unreachable
    } catch (e) {
      expect(e).toBeInstanceOf(DbWarmupStalledError);
      expect((e as { code?: string }).code).toBe("CONNECT_TIMEOUT");
      expect((e as Error).message).toContain("connect budget");
    }
    expect(calls).toBe(3); // the 1/3 pattern — same engine as the driver's own timeouts
  }, 10_000);

  test("the race cap derives from the shared budget (10s default) unless overridden", async () => {
    // a store whose ping resolves instantly cannot exceed any budget — this
    // only pins that the default budget is the shared one via the constant
    expect(DEFAULT_DB_CONNECT_TIMEOUT_MS).toBe(10_000);
    await warmDbConnectionForRun(fakeStore(async () => true));
  });
});
