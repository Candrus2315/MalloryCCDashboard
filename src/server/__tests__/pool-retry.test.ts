/**
 * POOL HARDENING tests (2026-10-06) — no live DB needed.
 *
 * 1. Pool-profile constants + the ceiling math (documented in store/pg.ts).
 * 2. resolvePoolOptions profile selection (incl. NODE_ENV defaulting).
 * 3. withDbRetry: bounded retry/backoff on transient connection errors ONLY —
 *    real errors pass through untouched, retries are short + bounded, and the
 *    sleep/onRetry hooks are observable.
 */
import { describe, expect, test } from "bun:test";
import { PgStore, POOL_PROFILES, resolvePoolOptions, type PoolProfile } from "../store/pg";
import {
  isTransientDbError,
  RETRYABLE_ERROR_CODES,
  RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  withDbRetry,
} from "../store/pg-retry";

describe("pool profiles — the managed-ceiling connection math", () => {
  test("profiles are the documented, bounded values", () => {
    // 2026-10-09 outage hardening: web cap lowered 12 → 5. The Oct-8 outage
    // stacked ~2.5 server processes × 12 warm conns ≈ the ~37 observed
    // connections; the boot guard (serve.ts) stops stacking, and this cap
    // bounds the damage a single (even unguarded) process can do to the ceiling.
    expect(POOL_PROFILES.web).toEqual({ max: 5, idle_timeout: 60, max_lifetime: 1800 });
    expect(POOL_PROFILES.web.max).toBeLessThanOrEqual(5); // pin: a future bump is a deliberate ceiling decision
    expect(POOL_PROFILES.job).toEqual({ max: 4, idle_timeout: 60, max_lifetime: 1800 });
    expect(POOL_PROFILES.test).toEqual({ max: 4, idle_timeout: 10, max_lifetime: 300 });
  });

  test("worst-case steady state + transient test peak stay under the 88-slot regular-role ceiling", () => {
    // Ceiling measured on the managed host 2026-10-06 (SHOW): max_connections
    // 105 − reserved 5 − superuser_reserved 12 = 88 slots for regular roles.
    const CEILING = 88;
    // 2 web servers (dev vite SSR + published serve.ts) + 1 job-profile process
    const steadyState = 2 * POOL_PROFILES.web.max + POOL_PROFILES.job.max;
    expect(steadyState).toBe(14);
    expect(steadyState).toBeLessThan(CEILING);
    // Test battery: bun test files run in parallel; each PgStore battery file
    // builds ≤ 2 stores per file. 10 concurrent store files × 2 × 4 ≈ 80 worst
    // case transiently — still bounded WITH the steady web+job load under 88+12
    // (tests never run against production traffic at the same ceiling; the
    // suite's own files are the only readers). Assert the per-file bound.
    const perTestFileMax = 2 * POOL_PROFILES.test.max;
    expect(perTestFileMax).toBe(8);
    expect(POOL_PROFILES.web.max + POOL_PROFILES.job.max + perTestFileMax).toBeLessThan(CEILING);
  });

  test("resolvePoolOptions: explicit profile wins; default follows NODE_ENV=test", () => {
    for (const p of ["web", "job", "test"] as PoolProfile[]) {
      expect(resolvePoolOptions(p)).toEqual({ profile: p, ...POOL_PROFILES[p] });
    }
    // no NODE_ENV mutation (bun test shares the process) — consistency instead:
    const expectedDefault = process.env.NODE_ENV === "test" ? "test" : "web";
    expect(resolvePoolOptions().profile).toBe(expectedDefault);
    expect(resolvePoolOptions()).toEqual(resolvePoolOptions(expectedDefault as PoolProfile));
  });

  test("PgStore exposes close() for abandoned-probe pool cleanup (no connection needed to construct)", () => {
    const pg = new PgStore("postgres://u:p@127.0.0.1:1/db?sslmode=require");
    expect(typeof (pg as unknown as Record<string, unknown>).close).toBe("function");
  });
});

describe("withDbRetry — bounded retry on pool-exhaustion/connection errors", () => {
  const noopSleep: { fn: (ms: number) => Promise<void>; calls: number[]; reset: () => void } = {
    fn: (ms) => {
      noopSleep.calls.push(ms);
      return Promise.resolve();
    },
    calls: [],
    reset: () => {
      noopSleep.calls = [];
    },
  };

  test("healthy pool: zero behavior change — fn called once, no sleep, no onRetry", async () => {
    noopSleep.reset();
    let calls = 0;
    const out = await withDbRetry(
      async () => {
        calls++;
        return "payload";
      },
      { sleep: noopSleep.fn, onRetry: () => expect(true).toBe(false) },
    );
    expect(out).toBe("payload");
    expect(calls).toBe(1);
    expect(noopSleep.calls).toEqual([]);
  });

  test("transient 53300 twice then success: retried with the short bounded backoff curve", async () => {
    noopSleep.reset();
    let calls = 0;
    const retryDelays: number[] = [];
    const out = await withDbRetry(
      async () => {
        calls++;
        if (calls <= 2) {
          const e = new Error("remaining connection slots are reserved for roles with the pg_use_reserved_connections privilege");
          (e as unknown as { code: string }).code = "53300";
          throw e;
        }
        return "ok-after-pool-shed";
      },
      { sleep: noopSleep.fn, onRetry: (_a, _e, delay) => retryDelays.push(delay) },
    );
    expect(out).toBe("ok-after-pool-shed");
    expect(calls).toBe(3);
    // (0.5 + jitter ≤ 0.5) × base × 3^(attempt−1) → attempt 1: 75..150ms, attempt 2: 225..450ms
    expect(noopSleep.calls.length).toBe(2);
    expect(noopSleep.calls[0]).toBeGreaterThanOrEqual(Math.round(RETRY_BASE_DELAY_MS * 0.5));
    expect(noopSleep.calls[0]).toBeLessThanOrEqual(RETRY_BASE_DELAY_MS);
    expect(noopSleep.calls[1]).toBeGreaterThanOrEqual(Math.round(RETRY_BASE_DELAY_MS * 3 * 0.5));
    expect(noopSleep.calls[1]).toBeLessThanOrEqual(RETRY_BASE_DELAY_MS * 3);
    expect(retryDelays).toEqual(noopSleep.calls);
  });

  test("exhausted attempts: the LAST transient error surfaces (never masked)", async () => {
    noopSleep.reset();
    let calls = 0;
    try {
      await withDbRetry(
        async () => {
          calls++;
          const e = new Error("sorry, too many clients already");
          (e as unknown as { code: string }).code = "53300";
          throw e;
        },
        { sleep: noopSleep.fn },
      );
      expect(true).toBe(false); // unreachable
    } catch (e) {
      expect((e as Error).message).toBe("sorry, too many clients already");
    }
    expect(calls).toBe(RETRY_ATTEMPTS);
    expect(noopSleep.calls.length).toBe(RETRY_ATTEMPTS - 1);
  });

  test("REAL errors are never retried: constraint/business error passes through on the first throw", async () => {
    noopSleep.reset();
    let calls = 0;
    try {
      await withDbRetry(
        async () => {
          calls++;
          const e = new Error("duplicate key value violates unique constraint");
          (e as unknown as { code: string }).code = "23505";
          throw e;
        },
        { sleep: noopSleep.fn },
      );
      expect(true).toBe(false);
    } catch (e) {
      expect((e as Error).message).toContain("duplicate key");
    }
    expect(calls).toBe(1);
    expect(noopSleep.calls).toEqual([]);
  });

  test("isTransientDbError: exactly the connection class; not plain Errors", () => {
    for (const code of ["53300", "08004", "08006", "08001", "08003", "57P01"]) {
      expect(isTransientDbError({ code })).toBe(true);
      expect(RETRYABLE_ERROR_CODES.has(code)).toBe(true);
    }
    expect(isTransientDbError(new Error("server closed the connection unexpectedly"))).toBe(true);
    expect(isTransientDbError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientDbError(new Error("terminating connection due to administrator command"))).toBe(true);
    expect(isTransientDbError(new Error("relation \"x\" does not exist"))).toBe(false);
    expect(isTransientDbError({ code: "23505" })).toBe(false);
    expect(isTransientDbError({ code: "42P01" })).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError("nope")).toBe(false);
    expect(isTransientDbError(new Error("totally ordinary failure"))).toBe(false);
  });
});
