/**
 * RELIABILITY PHASE 2a — the /health payload + HTTP contract.
 *
 * Covers: payload shape (version/commit/now + the five tracked providers with
 * lastSuccessAt/ageMinutes/status); 200 when every provider is ok, 503 when
 * ANY is degraded (healthHttpStatus — the exact rule serve.ts applies); a
 * never-succeeded provider reports "unknown" WITHOUT flipping overall to
 * degraded; an unreachable store fails HONESTLY (degraded + error, never a
 * plausible ok). Freshness math is the same pure function the watchdog uses.
 */
import { describe, expect, test } from "bun:test";
import { buildHealthPayload, HealthDeadlineError, healthHttpStatus, resolveGitCommit, withHealthDeadline } from "../health";
import { defaultSettings, type Store } from "../store/types";

const T0 = Date.parse("2026-10-20T12:00:00Z");
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();
const MIN = 60_000;

function makeStore(lastSuccess: Record<string, string>, fail = false): Store {
  return {
    async getLatestSuccessfulSyncRunByProvider() {
      if (fail) throw new Error("connection refused");
      return lastSuccess;
    },
    async getSettings() {
      if (fail) throw new Error("connection refused");
      return defaultSettings();
    },
  } as unknown as Store;
}

describe("/health — payload shape", () => {
  test("healthy dashboard: ok, all five providers reported with the real shape", async () => {
    const payload = await buildHealthPayload({
      store: makeStore({
        highlevel: iso(MIN),
        acuity: iso(MIN),
        google_sheets: iso(2 * MIN),
        acuity_availability: iso(MIN),
        attribution: iso(MIN),
      }),
      now: () => new Date(T0),
    });
    expect(payload.status).toBe("ok");
    expect(Object.keys(payload.providers).sort()).toEqual(["acuity", "acuity_availability", "attribution", "google_sheets", "highlevel"]);
    const hl = payload.providers.highlevel;
    expect(hl.status).toBe("ok");
    expect(hl.lastSuccessAt).toBe(iso(MIN));
    expect(hl.ageMinutes).toBeCloseTo(1, 1);
    expect(hl.cadenceMinutes).toBe(1.5); // default settings interval 90s
    expect(hl.staleAfterMinutes).toBe(4.5); // 3× cadence
    expect(typeof payload.version).toBe("string");
    expect(payload.version.length).toBeGreaterThan(0);
    expect(typeof payload.commit).toBe("string");
    expect(payload.commit.length).toBeGreaterThan(0);
    expect(payload.now).toBe(new Date(T0).toISOString());
    expect(payload.error).toBeUndefined();
    // JSON only, no business data: no counts, no rep names anywhere
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/calls|contacts|leads|reps/i);
  });

  test("one stale provider → overall degraded + that provider degraded, others still ok", async () => {
    const payload = await buildHealthPayload({
      store: makeStore({ attribution: iso(30 * MIN) }), // threshold 15 min → stale; others never succeeded (unknown)
      now: () => new Date(T0),
    });
    expect(payload.status).toBe("degraded");
    expect(healthHttpStatus(payload)).toBe(503);
    expect(payload.providers.attribution.status).toBe("degraded");
    expect(payload.providers.attribution.ageMinutes).toBeCloseTo(30, 1);
    expect(payload.providers.highlevel.status).toBe("unknown");
    // unknown providers do NOT flip overall status on their own:
    const onlyUnknown = await buildHealthPayload({ store: makeStore({}), now: () => new Date(T0) });
    expect(onlyUnknown.status).toBe("ok");
    expect(healthHttpStatus(onlyUnknown)).toBe(200);
  });

  test("healthy → 200 (the exact contract the external ping polls)", async () => {
    const payload = await buildHealthPayload({ store: makeStore({ attribution: iso(MIN) }), now: () => new Date(T0) });
    expect(healthHttpStatus(payload)).toBe(200);
    expect(payload.status).toBe("ok");
  });

  test("unreachable store: honest degraded + error — never a plausible ok", async () => {
    const payload = await buildHealthPayload({ store: makeStore({}, true), now: () => new Date(T0) });
    expect(payload.status).toBe("degraded");
    expect(healthHttpStatus(payload)).toBe(503);
    expect(payload.error).toContain("connection refused");
    expect(Object.keys(payload.providers)).toHaveLength(5);
    expect(Object.values(payload.providers).every((p) => p.status === "unknown")).toBe(true);
  });

  test("resolveGitCommit returns a non-empty short hash (or the honest 'unknown')", () => {
    const c = resolveGitCommit();
    expect(typeof c).toBe("string");
    expect(c.length).toBeGreaterThan(0);
    expect(c === "unknown" || /^[0-9a-f]+$/.test(c)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PART 2 (2026-11-05) — /health as the AUTHORITATIVE production check:
// identity (boot age), the one-fast-probe database report, the scheduler
// lease state, and deadline behavior on a slow store.
// ---------------------------------------------------------------------------

describe("/health — PART 2 authoritative fields", () => {
  const T2 = Date.parse("2026-11-05T12:00:00Z");
  const BOOT = new Date(T2 - 90_000);
  const iso2 = (msAgo: number) => new Date(T2 - msAgo).toISOString();
  const okStore = () =>
    makeStore({
      highlevel: iso2(MIN),
      acuity: iso2(MIN),
      google_sheets: iso2(MIN),
      acuity_availability: iso2(MIN),
      attribution: iso2(MIN),
    });
  const LEASE_NAME = 'postgres-advisory:1296911676 (0x4D414C4C "MALL")';

  test("identity fields: bootedAt + uptimeSeconds next to version/commit", async () => {
    const payload = await buildHealthPayload({
      store: okStore(),
      now: () => new Date(T2),
      bootedAt: BOOT,
      scheduler: { role: "holder", tickInFlight: false, leaseName: LEASE_NAME },
    });
    expect(payload.bootedAt).toBe(BOOT.toISOString());
    expect(payload.uptimeSeconds).toBe(90);
    expect(typeof payload.version).toBe("string");
    expect(typeof payload.commit).toBe("string");
    // still no business data anywhere in the JSON
    expect(JSON.stringify(payload)).not.toMatch(/calls|contacts|leads|reps/i);
  });

  test("database report: reachable with latency when the store answers", async () => {
    let pinged = 0;
    const store = {
      ...okStore(),
      async ping() {
        pinged++;
        return true;
      },
    } as unknown as Store;
    const payload = await buildHealthPayload({ store, now: () => new Date(T2), bootedAt: BOOT });
    expect(payload.status).toBe("ok");
    expect(payload.database.reachable).toBe(true);
    expect(payload.database.error).toBeUndefined();
    expect(typeof payload.database.latencyMs).toBe("number");
    expect((payload.database.latencyMs as number) >= 0).toBe(true);
    expect(pinged).toBe(1); // ONE fast probe query — never more
  });

  test("database report: stores without a ping surface (test fakes) stay reachable, latency null", async () => {
    const payload = await buildHealthPayload({ store: okStore(), now: () => new Date(T2), bootedAt: BOOT });
    expect(payload.database).toEqual({ reachable: true, latencyMs: null });
    expect(payload.status).toBe("ok");
  });

  test("an unreachable database degrades the check even when the reads squeak by", async () => {
    const store = {
      ...okStore(),
      ping: () => Promise.reject(new Error("db connection refused")),
    } as unknown as Store;
    const payload = await buildHealthPayload({ store, now: () => new Date(T2), bootedAt: BOOT });
    expect(payload.database.reachable).toBe(false);
    expect(payload.database.error).toContain("db connection refused");
    expect(payload.status).toBe("degraded");
    expect(healthHttpStatus(payload)).toBe(503);
  });

  test("scheduler lease-state field: holder/standby/stopped, query-free", async () => {
    const holder = await buildHealthPayload({
      store: okStore(),
      now: () => new Date(T2),
      bootedAt: BOOT,
      scheduler: { role: "holder", tickInFlight: true, leaseName: LEASE_NAME },
    });
    expect(holder.scheduler.role).toBe("holder");
    expect(holder.scheduler.tickInFlight).toBe(true);
    expect(holder.scheduler.leaseName).toBe(LEASE_NAME);
    const standby = await buildHealthPayload({
      store: okStore(),
      now: () => new Date(T2),
      bootedAt: BOOT,
      scheduler: { role: "standby", tickInFlight: false, leaseName: LEASE_NAME },
    });
    expect(standby.scheduler.role).toBe("standby");
    // default: the live module mirror — no scheduler started in this test
    // process, so the role is one of the three and the shape is honest.
    const live = await buildHealthPayload({ store: okStore(), now: () => new Date(T2), bootedAt: BOOT });
    expect(["holder", "standby", "stopped"]).toContain(live.scheduler.role);
    expect(live.scheduler.leaseName === null || typeof live.scheduler.leaseName === "string").toBe(true);
    expect(typeof live.scheduler.tickInFlight).toBe("boolean");
  });

  test("DEADLINE: a store read that never settles cannot hang /health — honest degraded within the deadline", async () => {
    const t0 = Date.now();
    const store = {
      async ping() {
        return true;
      },
      async getSettings() {
        return new Promise(() => {}); // never settles — the wedge shape
      },
      async getLatestSuccessfulSyncRunByProvider() {
        return {};
      },
    } as unknown as Store;
    const payload = await buildHealthPayload({ store, now: () => new Date(T2), bootedAt: BOOT, deadlineMs: 60 });
    expect(payload.status).toBe("degraded");
    expect(healthHttpStatus(payload)).toBe(503);
    expect(payload.error).toContain("health deadline");
    expect(payload.error).toContain("settings read");
    expect(Object.values(payload.providers).every((p) => p.status === "unknown")).toBe(true);
    expect(payload.database.reachable).toBe(true); // the probe itself passed
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("DEADLINE: a wedged probe is reported as an unreachable database", async () => {
    const store = {
      ping: () => new Promise(() => {}), // never settles
      async getSettings() {
        return defaultSettings();
      },
      async getLatestSuccessfulSyncRunByProvider() {
        return { attribution: iso2(MIN) };
      },
    } as unknown as Store;
    const payload = await buildHealthPayload({ store, now: () => new Date(T2), bootedAt: BOOT, deadlineMs: 60 });
    expect(payload.database.reachable).toBe(false);
    expect(payload.database.error).toContain("health deadline");
    expect(payload.database.error).toContain("database probe");
    expect(payload.status).toBe("degraded");
    expect(healthHttpStatus(payload)).toBe(503);
  });

  test("withHealthDeadline: winner passes through, loser surfaces HealthDeadlineError", async () => {
    const fast = await withHealthDeadline(Promise.resolve("ok"), 500, "fast read");
    expect(fast).toBe("ok");
    await expect(withHealthDeadline(new Promise(() => {}), 40, "hung read")).rejects.toThrow(HealthDeadlineError);
    await expect(withHealthDeadline(new Promise(() => {}), 40, "hung read")).rejects.toThrow(/hung read/);
  });
});
