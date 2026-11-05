/**
 * SSR PAGE-RENDER DEADLINE (2026-11-04 live wedges) — repro + fix pins.
 *
 * THE STUCK STATE (deterministic repro, no DB, no network): every page render
 * funnels through loadPageMeta → ensureDemoData, whose module-level
 * `seedInflight` memo is ADOPTED by every later caller. Nothing bounded the
 * memo's inner chain against a never-settling await — postgres.js has NO pool
 * acquire timeout, so one hung checkout (a detached zombie scheduler tick
 * holding its connection) parks every later getUsers() in the acquire queue
 * forever; the memo's clearing finally only runs when the promise settles,
 * which it never does → EVERY page hangs until restart while /health (which
 * never calls ensureDemoData) answers instantly. Six restarts in one night.
 *
 * RED-WITHOUT-FIX / GREEN-WITH-FIX: with the deadline (fix), the memo itself
 * settles within the cap with an honest PageRenderDeadlineError and is CLEARED
 * (the next call starts a fresh inner and can succeed); without it, the first
 * call never settles (and the second adopts the same poisoned promise) — the
 * per-call TEST WATCHDOG races each call so the un-fixed failure surfaces as a
 * fast, deterministic assertion failure instead of a hung suite.
 *
 * All tests offline: the store comes through ensureDemoData's getStoreImpl
 * seam (a MemoryStore whose getUsers is overridden), never the real getStore.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../store/memory";
import type { UserRow } from "../store/types";
import {
  ensureDemoData,
  type EnsureDemoDataOpts,
} from "../sync/run";
import {
  PageRenderDeadlineError,
  isPageRenderDeadlineError,
  racePageRenderDeadline,
  withPageRenderDeadline,
} from "../render-deadline";
import {
  DEFAULT_PAGE_RENDER_TIMEOUT_MS,
  PAGE_RENDER_TIMEOUT_MS_MAX,
  PAGE_RENDER_TIMEOUT_MS_MIN,
  pageRenderTimeoutMs,
} from "../store/db-pool-config";

/** A store whose getUsers() never settles — the hung pool-acquire await. */
function hungStore(): MemoryStore {
  const s = new MemoryStore();
  (s as unknown as { getUsers: () => Promise<UserRow[]> }).getUsers = () => new Promise<UserRow[]>(() => {});
  return s;
}

/** A store whose getUsers() resolves one active user (no demo-seed path). */
function healthyStore(): MemoryStore {
  const s = new MemoryStore();
  (s as unknown as { getUsers: () => Promise<UserRow[]> }).getUsers = async () =>
    [{ id: "u1" } as unknown as UserRow];
  return s;
}

/** Map a call to its settled outcome (value or error) under a hard wall clock. */
function settled<T>(p: Promise<T>, wallMs: number): Promise<T | Error> {
  return Promise.race([
    p.then(
      (v) => v,
      (e) => (e instanceof Error ? e : new Error(String(e))),
    ),
    new Promise<Error>((_, reject) =>
      setTimeout(() => reject(new Error("TEST WATCHDOG: the call never settled — the seed memo is poisoned (red-without-fix)")), wallMs),
    ),
  ]) as Promise<T | Error>;
}

type CallOpts = Pick<EnsureDemoDataOpts, "getStoreImpl" | "renderTimeoutMs">;

describe("ensureDemoData page-render deadline — the poisoned-memo repro", () => {
  test("a never-settling first render settles at the deadline and CANNOT poison later calls", async () => {
    const opts: CallOpts = { getStoreImpl: async () => hungStore(), renderTimeoutMs: 60 };
    const e1 = await settled(ensureDemoData(opts), 2_000);
    expect(isPageRenderDeadlineError(e1)).toBe(true);
    // The heart of the wedge: WITHOUT the deadline, call 2 adopts call 1's
    // still-pending memo and hangs forever (wall-clock watchdog = red).
    const e2 = await settled(ensureDemoData(opts), 2_000);
    expect(isPageRenderDeadlineError(e2)).toBe(true);
    // Healing: the memo was cleared by the deadline rejection, so a healthy
    // store renders — the next request works, no restart needed.
    const ok = await settled(ensureDemoData({ getStoreImpl: async () => healthyStore(), renderTimeoutMs: 5_000 }), 2_000);
    expect(ok).toEqual({ seeded: false, mode: "memory" });
  }, 10_000);

  test("callers concurrent with the stuck render all settle with the same honest error", async () => {
    const opts: CallOpts = { getStoreImpl: async () => hungStore(), renderTimeoutMs: 60 };
    const [a, b] = await Promise.all([
      settled(ensureDemoData(opts), 2_000),
      settled(ensureDemoData(opts), 2_000),
    ]);
    // Both adopt the one memo (single-flight preserved) — both get the honest
    // deadline error instead of one hang shared by every page.
    expect(isPageRenderDeadlineError(a)).toBe(true);
    expect(isPageRenderDeadlineError(b)).toBe(true);
  }, 10_000);

  test("single-flight is preserved on the healthy path: concurrent calls share ONE inner", async () => {
    let implCalls = 0;
    let getUsersCalls = 0;
    const opts: CallOpts = {
      getStoreImpl: () => {
        implCalls++;
        const s = healthyStore();
        const orig = s.getUsers.bind(s);
        (s as unknown as { getUsers: () => Promise<UserRow[]> }).getUsers = () => {
          getUsersCalls++;
          return orig();
        };
        return Promise.resolve(s);
      },
      renderTimeoutMs: 5_000,
    };
    const [r1, r2] = await Promise.all([ensureDemoData(opts), ensureDemoData(opts)]);
    expect(r1).toEqual({ seeded: false, mode: "memory" });
    expect(r2).toEqual({ seeded: false, mode: "memory" });
    expect(implCalls).toBe(1); // one store, one memo — the seed mutex still dedupes
    expect(getUsersCalls).toBe(1);
  }, 10_000);

  test("the healthy path still settles far inside the deadline and clears the memo after each call", async () => {
    const opts: CallOpts = { getStoreImpl: async () => healthyStore(), renderTimeoutMs: 5_000 };
    // Two SEQUENTIAL healthy calls each run a fresh inner (memo cleared by the
    // first caller's finally on settle) — no adoption of a dead promise.
    const r1 = await settled(ensureDemoData(opts), 2_000);
    expect(r1).toEqual({ seeded: false, mode: "memory" });
    const r2 = await settled(ensureDemoData(opts), 2_000);
    expect(r2).toEqual({ seeded: false, mode: "memory" });
  }, 10_000);
});

describe("racePageRenderDeadline / withPageRenderDeadline", () => {
  test("passthrough when the work settles first — value and identity of the error path untouched", async () => {
    const v = await withPageRenderDeadline(async () => "payload", { timeoutMs: 1_000 });
    expect(v).toBe("payload");
    const err = await withPageRenderDeadline(async () => {
      throw new Error("boom");
    }, { timeoutMs: 1_000 }).then(
      () => null,
      (e) => e,
    );
    expect((err as Error).message).toBe("boom");
    expect(isPageRenderDeadlineError(err)).toBe(false);
  });

  test("rejects with a named, honest PageRenderDeadlineError when the cap fires", async () => {
    const t0 = Date.now();
    const err = await withPageRenderDeadline(() => new Promise<string>(() => {}), { timeoutMs: 40 }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(PageRenderDeadlineError);
    expect(isPageRenderDeadlineError(err)).toBe(true);
    expect((err as PageRenderDeadlineError).timeoutMs).toBe(40);
    expect((err as Error).message).toContain("page render deadline");
    expect((err as Error).message).toContain("40ms");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(Date.now() - t0).toBeLessThan(2_000); // bounded, not hung
  });

  test("timeoutMs <= 0 disables the race (same convention as the probe backstop)", async () => {
    const v = await racePageRenderDeadline(Promise.resolve("raw"), 0);
    expect(v).toBe("raw");
  });

  test("the timer is cleared when the work wins — no lingering deadline rejection later", async () => {
    // A settled race must not reject afterwards when the (cleared) timer would
    // have fired; awaiting well past the cap proves the clear happened.
    const v = await racePageRenderDeadline(Promise.resolve("ok"), 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(v).toBe("ok");
  });
});

describe("pageRenderTimeoutMs — the env-clamped 8s default", () => {
  test("default is 8000 without env; invalid/0/negative falls back to it", () => {
    expect(DEFAULT_PAGE_RENDER_TIMEOUT_MS).toBe(8_000);
    expect(pageRenderTimeoutMs(undefined)).toBe(8_000);
    expect(pageRenderTimeoutMs("")).toBe(8_000);
    expect(pageRenderTimeoutMs("not-a-number")).toBe(8_000);
    expect(pageRenderTimeoutMs("0")).toBe(8_000);
    expect(pageRenderTimeoutMs("-5")).toBe(8_000);
  });

  test("env values are honored inside the clamp band and clamped outside it", () => {
    expect(pageRenderTimeoutMs("15000")).toBe(15_000);
    expect(pageRenderTimeoutMs("250")).toBe(PAGE_RENDER_TIMEOUT_MS_MIN);
    expect(PAGE_RENDER_TIMEOUT_MS_MIN).toBe(1_000);
    expect(pageRenderTimeoutMs("999999")).toBe(PAGE_RENDER_TIMEOUT_MS_MAX);
    expect(PAGE_RENDER_TIMEOUT_MS_MAX).toBe(60_000);
  });
});
