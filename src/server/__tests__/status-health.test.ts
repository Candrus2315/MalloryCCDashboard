/**
 * STATUS / HEALTH PAGE DATA — the in-app Status view's read-only page-data
 * function (reliability item). Pins:
 *
 *   • the payload IS the /health payload (buildHealthPayload, unchanged) —
 *     provider shape, statuses, heartbeat — never a fork;
 *   • the same banner warning clauses other pages show (sync + heartbeat),
 *     with a store-read failure landing in warningsError, never a crash;
 *   • running-guard views: honest ages, the reaper's own bound flagging hung
 *     rows, unparsable timestamps staying null (never a guess);
 *   • recent-run views: duration null when unfinished/unparsable;
 *   • supervisor + server-lock views: real state files parsed, missing files
 *     honestly unavailable, garbage files falling back to empty defaults,
 *     window counts and backoff flags computed against the injected clock;
 *   • every store-read failure is contained to its own section's error field;
 *   • the surfaced configuration constants are the shipped ones.
 *
 * All clocks injected; all supervisor/lock paths are explicit fixture files.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultServerLockPath,
  defaultSupervisorStatePath,
  formatAgeMinutes,
  minutesSince,
  statusHealthPageData,
} from "../status-health";
import type { HealthPayload } from "../health";
import { defaultSettings, STALE_RUN_REAP_MINUTES, type ConnectionRow, type Store, type SyncRunRow } from "../store/types";

const T0 = Date.parse("2026-10-28T12:00:00Z");
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();
const MIN = 60_000;

function conn(provider: string, over: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    provider,
    status: "connected",
    is_demo: false,
    last_sync_at: iso(MIN),
    last_successful_sync_at: iso(MIN),
    last_error: null,
    config: {},
    ...over,
  } as ConnectionRow;
}

interface StoreShape {
  getLatestSuccessfulSyncRunByProvider?: () => Promise<Record<string, string>>;
  getSettings?: () => Promise<ReturnType<typeof defaultSettings>>;
  getConnections?: () => Promise<ConnectionRow[]>;
  getRunningSyncRuns?: () => Promise<SyncRunRow[]>;
  getSyncRuns?: (limit: number) => Promise<SyncRunRow[]>;
  /** Thrown on any read when fail is set. */
  fail?: string;
}

function makeStore(shape: StoreShape = {}): Store {
  const failReads = () => {
    if (shape.fail) throw new Error(shape.fail);
  };
  return {
    async getLatestSuccessfulSyncRunByProvider() {
      failReads();
      return shape.getLatestSuccessfulSyncRunByProvider ? shape.getLatestSuccessfulSyncRunByProvider() : {};
    },
    async getSettings() {
      failReads();
      return defaultSettings();
    },
    async getConnections() {
      failReads();
      return shape.getConnections ? shape.getConnections() : [];
    },
    async getRunningSyncRuns() {
      failReads();
      return shape.getRunningSyncRuns ? shape.getRunningSyncRuns() : [];
    },
    async getSyncRuns(limit: number) {
      failReads();
      return shape.getSyncRuns ? shape.getSyncRuns(limit) : [];
    },
  } as unknown as Store;
}

function runRow(over: Partial<SyncRunRow>): SyncRunRow {
  return { id: "r1", provider: "highlevel", status: "running", started_at: iso(MIN), finished_at: null, records_upserted: 0, error: null, ...over };
}

const NO_FILES = { supervisorStatePath: "/nonexistent/supervisor-state.json", serverLockPath: "/nonexistent/server.lock" };

// ---------------------------------------------------------------------------
// The health payload passthrough
// ---------------------------------------------------------------------------

describe("statusHealthPageData — /health payload passthrough", () => {
  test("healthy store: ok status, all five providers, heartbeat object, no errors", async () => {
    const data = await statusHealthPageData({
      store: makeStore({
        getLatestSuccessfulSyncRunByProvider: () => ({
          highlevel: iso(MIN),
          acuity: iso(MIN),
          google_sheets: iso(2 * MIN),
          acuity_availability: iso(MIN),
          attribution: iso(MIN),
        }),
      }),
      now: () => new Date(T0),
      ...NO_FILES,
    });
    expect(data.health.status).toBe("ok");
    expect(Object.keys(data.health.providers).sort()).toEqual(["acuity", "acuity_availability", "attribution", "google_sheets", "highlevel"]);
    expect(data.health.providers.highlevel.status).toBe("ok");
    expect(data.health.providers.highlevel.cadenceMinutes).toBe(1.5); // default settings interval
    expect(data.heartbeat).toBe(data.health.heartbeat); // render convenience IS the payload's object
    expect(data.warnings).toEqual([]);
    expect(data.warningsError).toBeNull();
    expect(data.runningError).toBeNull();
    expect(data.recentError).toBeNull();
    expect(data.supervisorError).toBeNull();
    // surfaced configuration = the shipped constants, verbatim
    expect(data.reapBoundMinutes).toBe(STALE_RUN_REAP_MINUTES);
    expect(data.ingestDeadlineMinutes).toBe(40);
    expect(data.recentLimit).toBe(12);
  });

  test("stale provider flows through degraded unchanged (never re-classified)", async () => {
    const data = await statusHealthPageData({
      store: makeStore({ getLatestSuccessfulSyncRunByProvider: () => ({ attribution: iso(30 * MIN) }) }),
      now: () => new Date(T0),
      ...NO_FILES,
    });
    expect(data.health.status).toBe("degraded");
    expect(data.health.providers.attribution.status).toBe("degraded");
    expect(data.health.providers.highlevel.status).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Banner warnings
// ---------------------------------------------------------------------------

describe("statusHealthPageData — banner warnings", () => {
  test("connection errors produce the same clause other pages' banners show", async () => {
    const data = await statusHealthPageData({
      store: makeStore({
        getConnections: () => [conn("highlevel", { status: "error", last_error: "rate limited" })],
      }),
      now: () => new Date(T0),
      ...NO_FILES,
    });
    expect(data.warnings).toEqual(["HighLevel reported a sync error — its numbers may be incomplete; check the Sync Center in Settings."]);
  });

  test("a store connections failure lands in warningsError — page still renders", async () => {
    const data = await statusHealthPageData({
      store: makeStore({ getConnections: () => { throw new Error("connection refused"); } }),
      now: () => new Date(T0),
      ...NO_FILES,
    });
    expect(data.warnings).toEqual([]);
    expect(data.warningsError).toContain("could not read sync connections");
    expect(data.warningsError).toContain("connection refused");
    expect(data.health.status).toBe("ok"); // /health contract untouched by the banner read
  });
});

// ---------------------------------------------------------------------------
// Running guard + recent runs
// ---------------------------------------------------------------------------

describe("statusHealthPageData — running guard", () => {
  test("young in-flight row: running, not beyond the reap bound", async () => {
    const data = await statusHealthPageData({
      store: makeStore({ getRunningSyncRuns: () => [runRow({ started_at: iso(5 * MIN) })] }),
      now: () => new Date(T0),
      ...NO_FILES,
    });
    expect(data.runningRuns).toHaveLength(1);
    const r = data.runningRuns![0];
    expect(r.provider).toBe("highlevel");
    expect(r.ageMinutes).toBeCloseTo(5, 1);
    expect(r.beyondReapBound).toBe(false);
  });

  test("row older than STALE_RUN_REAP_MINUTES is flagged beyond the reap bound (the reaper's own rule)", async () => {
    const data = await statusHealthPageData({
      store: makeStore({ getRunningSyncRuns: () => [runRow({ started_at: iso((STALE_RUN_REAP_MINUTES + 7) * MIN) })] }),
      now: () => new Date(T0),
      ...NO_FILES,
    });
    const r = data.runningRuns![0];
    expect(r.beyondReapBound).toBe(true);
    expect(r.ageMinutes).toBeCloseTo(STALE_RUN_REAP_MINUTES + 7, 1);
  });

  test("unparsable started_at → age null, never flagged, never a crash", async () => {
    const data = await statusHealthPageData({
      store: makeStore({ getRunningSyncRuns: () => [runRow({ started_at: "not-a-date" })] }),
      now: () => new Date(T0),
      ...NO_FILES,
    });
    const r = data.runningRuns![0];
    expect(r.ageMinutes).toBeNull();
    expect(r.beyondReapBound).toBe(false);
  });

  test("empty in-flight list stays an honest empty array", async () => {
    const data = await statusHealthPageData({ store: makeStore(), now: () => new Date(T0), ...NO_FILES });
    expect(data.runningRuns).toEqual([]);
  });

  test("a running-read failure is contained: runningError set, health + recent still served", async () => {
    const data = await statusHealthPageData({
      store: makeStore({
        getRunningSyncRuns: () => { throw new Error("store down"); },
        getSyncRuns: () => [runRow({ status: "success", finished_at: iso(0), records_upserted: 42 })],
      }),
      now: () => new Date(T0),
      ...NO_FILES,
    });
    expect(data.runningRuns).toBeNull();
    expect(data.runningError).toContain("could not read running sync runs");
    expect(data.runningError).toContain("store down");
    expect(data.recentRuns).not.toBeNull();
    expect(data.health.status).toBe("ok");
  });
});

describe("statusHealthPageData — recent runs", () => {
  test("finished run: duration computed; unfinished run: honest null duration", async () => {
    const data = await statusHealthPageData({
      store: makeStore({
        getSyncRuns: () => [
          runRow({ id: "a", status: "success", started_at: iso(10 * MIN), finished_at: iso(4 * MIN), records_upserted: 7 }),
          runRow({ id: "b", status: "error", started_at: iso(2 * MIN), finished_at: null, error: "reaped: stale running row" }),
        ],
      }),
      now: () => new Date(T0),
      ...NO_FILES,
    });
    const [a, b] = data.recentRuns!;
    expect(a.durationMinutes).toBe(6);
    expect(a.recordsUpserted).toBe(7);
    expect(b.durationMinutes).toBeNull();
    expect(b.error).toBe("reaped: stale running row");
  });

  test("recentLimit is passed through to the store read", async () => {
    let seen: number | null = null;
    const data = await statusHealthPageData({
      store: makeStore({ getSyncRuns: (limit) => { seen = limit; return []; } }),
      now: () => new Date(T0),
      recentLimit: 5,
      ...NO_FILES,
    });
    expect(seen).toBe(5);
    expect(data.recentLimit).toBe(5);
    expect(data.recentRuns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Supervisor state + server lock (explicit fixture files)
// ---------------------------------------------------------------------------

function withTempFiles(state: string | null, lock: string | null): { supervisorStatePath: string; serverLockPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "status-health-"));
  const supervisorStatePath = join(dir, "supervisor-state.json");
  const serverLockPath = join(dir, "server.lock");
  if (state != null) writeFileSync(supervisorStatePath, state);
  if (lock != null) writeFileSync(serverLockPath, lock);
  return { supervisorStatePath, serverLockPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("statusHealthPageData — supervisor + server lock", () => {
  test("real state file: state line, window counts, backoff flags against the injected clock", async () => {
    const files = withTempFiles(
      JSON.stringify({
        lastStateLine: "serve=ok,heartbeat=ok",
        serveRestarts: [T0 - 2 * MIN],
        hbRestarts: [],
        backoffUntil: T0 + 5 * MIN,
        hbBackoffUntil: null,
        priorBadServe: 1,
      }),
      null,
    );
    try {
      const data = await statusHealthPageData({ store: makeStore(), now: () => new Date(T0), ...files });
      expect(data.supervisor.available).toBe(true);
      expect(data.supervisor.stateLine).toBe("serve=ok,heartbeat=ok");
      expect(data.supervisor.serveRestartsInWindow).toBe(1);
      expect(data.supervisor.hbRestartsInWindow).toBe(0);
      expect(data.supervisor.serveBackoffActive).toBe(true);
      expect(data.supervisor.hbBackoffActive).toBe(false);
    } finally {
      files.cleanup();
    }
  });

  test("missing state file → honestly unavailable with — semantics, no error", async () => {
    const data = await statusHealthPageData({
      store: makeStore(),
      now: () => new Date(T0),
      supervisorStatePath: join(tmpdir(), "definitely-missing-supervisor-state.json"),
      serverLockPath: join(tmpdir(), "definitely-missing-server.lock"),
    });
    expect(data.supervisor.available).toBe(false);
    expect(data.supervisor.stateLine).toBeNull();
    expect(data.supervisor.serveRestartsInWindow).toBeNull();
    expect(data.supervisor.serveBackoffActive).toBeNull();
    expect(data.supervisorError).toBeNull();
    expect(data.serverLock.available).toBe(false);
  });

  test("garbage state file → parses to empty defaults (honest), not a crash", async () => {
    const files = withTempFiles("{not json", null);
    try {
      const data = await statusHealthPageData({ store: makeStore(), now: () => new Date(T0), ...files });
      expect(data.supervisor.available).toBe(true);
      expect(data.supervisor.stateLine).toBeNull();
      expect(data.supervisor.serveRestartsInWindow).toBe(0);
    } finally {
      files.cleanup();
    }
  });

  test("server lock: pid/port/boot age surfaced; stale-restart timestamps outside the window not counted", async () => {
    const files = withTempFiles(
      JSON.stringify({ serveRestarts: [T0 - 30 * MIN] }), // outside the 5-min window
      JSON.stringify({ pid: 1234, port: 3000, started_at: iso(90 * MIN) }),
    );
    try {
      const data = await statusHealthPageData({ store: makeStore(), now: () => new Date(T0), ...files });
      expect(data.supervisor.serveRestartsInWindow).toBe(0);
      expect(data.serverLock.available).toBe(true);
      expect(data.serverLock.pid).toBe(1234);
      expect(data.serverLock.port).toBe(3000);
      expect(data.serverLock.ageMinutes).toBeCloseTo(90, 1);
    } finally {
      files.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helpers + test-default path contract
// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  test("minutesSince: honest nulls, clamped at zero", () => {
    expect(minutesSince(null, T0)).toBeNull();
    expect(minutesSince("garbage", T0)).toBeNull();
    expect(minutesSince(iso(90_000), T0)).toBeCloseTo(1.5, 1);
    expect(minutesSince(iso(0), T0)).toBe(0);
    expect(minutesSince(new Date(T0 + 60_000).toISOString(), T0)).toBe(0); // future timestamp clamps, never negative
  });

  test("formatAgeMinutes: — for missing, <1 min for a real zero, hours over 120", () => {
    expect(formatAgeMinutes(null)).toBe("—");
    expect(formatAgeMinutes(Number.NaN)).toBe("—");
    expect(formatAgeMinutes(0)).toBe("<1 min");
    expect(formatAgeMinutes(0.4)).toBe("<1 min");
    expect(formatAgeMinutes(45)).toBe("45 min");
    expect(formatAgeMinutes(90)).toBe("90 min");
    expect(formatAgeMinutes(150)).toBe("2h 30m");
    expect(formatAgeMinutes(120)).toBe("2h");
  });

  test("test defaults for the .run paths are nonexistent (deterministic under bun test)", () => {
    expect(defaultSupervisorStatePath()).toContain("nonexistent");
    expect(defaultServerLockPath()).toContain("nonexistent");
  });
});

// ---------------------------------------------------------------------------
// The payload shape contract (guards an accidental fork of /health)
// ---------------------------------------------------------------------------

describe("statusHealthPageData — payload-shape guard", () => {
  test("health object carries the exact /health fields (version, commit, now, providers, heartbeat)", async () => {
    const data = await statusHealthPageData({ store: makeStore(), now: () => new Date(T0), ...NO_FILES });
    const h: HealthPayload = data.health;
    expect(Object.keys(h).sort()).toEqual(["commit", "heartbeat", "now", "providers", "status", "version"]);
  });
});
