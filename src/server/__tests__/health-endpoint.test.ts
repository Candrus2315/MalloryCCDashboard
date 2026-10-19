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
import { buildHealthPayload, healthHttpStatus, resolveGitCommit, type HealthPayload } from "../health";
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
