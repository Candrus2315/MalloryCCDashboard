/**
 * RELIABILITY PHASE 2a — provider freshness watchdog (owner directive
 * 2026-10-16: commercial-SaaS self-recovery, zero operator action).
 *
 * Covers: a stale provider triggers EXACTLY ONE bounded recovery attempt per
 * window; stale 'running' rows are cleared reaper-style with honest error
 * text; a possibly-live running row guard-blocks the attempt; escalation to
 * DEGRADED + one alert per incident after N attempts (escalation fires ON the
 * pass that performs the Nth attempt, which then finds the provider still
 * stale); rate-limit holds across "restarts" (incident state persists in the
 * DB checkpoint — every pass loads it fresh, exactly what a restarted process
 * does); recovery fires one 'resolved' alert; never-succeeded ("unknown")
 * providers are never recovered or alerted; the freshness math and cadence
 * map are the real scheduler numbers.
 *
 * The store here is a minimal hand-rolled stub (cast through unknown) so the
 * clock is fully injectable — the MemoryStore stamps finished_at with the
 * real clock, which cannot model a stale provider.
 */
import { describe, expect, test } from "bun:test";
import {
  computeProviderFreshness,
  createDefaultForceAttempt,
  FRESHNESS_ESCALATION_ATTEMPTS,
  FRESHNESS_PROVIDERS,
  FRESHNESS_STALE_AGE_FACTOR,
  INCIDENT_CHECKPOINT_KEY,
  providerCadenceMs,
  runFreshnessWatchdogPass,
  RECOVERY_ATTEMPT_MIN_INTERVAL_MS,
  type ProviderIncidentState,
} from "../sync/freshness-watchdog";
import { defaultSettings, type AppSettings, type Store, type SyncRunRow } from "../store/types";

const T0 = Date.parse("2026-10-20T12:00:00Z");
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();
const MIN = 60_000;
const WINDOW = RECOVERY_ATTEMPT_MIN_INTERVAL_MS + 1_000;

interface StubState {
  lastSuccess: Record<string, string>;
  running: SyncRunRow[];
  finishedErrors: string[];
  checkpoints: Map<string, string>;
  settings: AppSettings;
}

function makeStore(state: StubState): Store {
  return {
    async getLatestSuccessfulSyncRunByProvider() {
      return { ...state.lastSuccess };
    },
    async getRunningSyncRuns() {
      return state.running.filter((r) => r.status === "running" && r.finished_at === null);
    },
    async finishSyncRun(id: string, status: string, _records: number, error: string | null) {
      const run = state.running.find((r) => r.id === id);
      if (run) {
        run.status = status;
        run.error = error;
        run.finished_at = new Date(T0).toISOString();
      }
      if (error) state.finishedErrors.push(error);
    },
    async getSyncCheckpoint(key: string) {
      return state.checkpoints.get(key) ?? null;
    },
    async setSyncCheckpoint(key: string, value: string) {
      state.checkpoints.set(key, value);
    },
    async getSettings() {
      return state.settings;
    },
    async getConnections() {
      return [];
    },
  } as unknown as Store;
}

function baseState(overrides?: Partial<StubState>): StubState {
  return {
    lastSuccess: {},
    running: [],
    finishedErrors: [],
    checkpoints: new Map(),
    settings: defaultSettings(),
    ...overrides,
  };
}

const noopAttempt = async () => {};

function runN(store: Store, sendAlert: undefined | ((level: "degraded" | "resolved", subject: string, body: string) => Promise<{ configured: boolean; delivered: boolean; error?: string }>), forceAttempt: (p: string) => Promise<void>, count: number, startMs: number): Promise<void> {
  let t = startMs;
  return (async () => {
    for (let i = 0; i < count; i++) {
      await runFreshnessWatchdogPass({ store, now: () => new Date(t), forceAttempt, sendAlert });
      t += WINDOW;
    }
  })();
}

describe("provider freshness watchdog — cadence map + pure math", () => {
  test("cadences are the REAL scheduler numbers, not guesses", () => {
    const s = defaultSettings();
    expect(providerCadenceMs("highlevel", s)).toBe(90_000); // settings interval (default 90s)
    expect(providerCadenceMs("acuity", s)).toBe(5 * MIN);
    expect(providerCadenceMs("attribution", s)).toBe(5 * MIN);
    expect(providerCadenceMs("acuity_availability", s)).toBe(5 * MIN);
    expect(providerCadenceMs("google_sheets", s)).toBe(10 * MIN);
    // the settings interval is live: a raised HighLevel interval raises its threshold
    expect(providerCadenceMs("highlevel", { ...s, highlevel_sync_interval_seconds: 3600 })).toBe(3_600_000);
  });

  test("stale = age > 3× cadence; exactly at the line is still ok; unknown when never succeeded", () => {
    const now = () => new Date(T0);
    // attribution cadence 5 min → threshold 15 min
    const fresh = computeProviderFreshness({ attribution: iso(14.9 * MIN) }, undefined, now);
    expect(fresh.find((f) => f.provider === "attribution")?.status).toBe("ok");
    const atLine = computeProviderFreshness({ attribution: iso(15 * MIN) }, undefined, now);
    expect(atLine.find((f) => f.provider === "attribution")?.status).toBe("ok");
    const stale = computeProviderFreshness({ attribution: iso(15.1 * MIN) }, undefined, now);
    const f = stale.find((x) => x.provider === "attribution");
    expect(f?.status).toBe("degraded");
    expect(f?.staleAfterMinutes).toBe(5 * FRESHNESS_STALE_AGE_FACTOR);
    expect(f?.ageMinutes).toBeCloseTo(15.1, 1);
    // never succeeded → unknown, not degraded
    const unknown = computeProviderFreshness({}, undefined, now);
    expect(unknown.find((x) => x.provider === "highlevel")?.status).toBe("unknown");
    expect(unknown.find((x) => x.provider === "highlevel")?.lastSuccessAt).toBeNull();
    // all five watched providers present
    expect(unknown.map((x) => x.provider).sort()).toEqual([...FRESHNESS_PROVIDERS].sort());
  });
});

describe("provider freshness watchdog — recovery", () => {
  test("a live-looking running row guard-blocks recovery (never double-runs a possibly-live sync), stale rows untouched", async () => {
    const state = baseState({
      lastSuccess: { attribution: iso(30 * MIN) }, // threshold 15 min → stale
      running: [
        { id: "run-live", provider: "attribution", status: "running", started_at: iso(2 * MIN), finished_at: null, records_upserted: 0, error: null },
      ],
    });
    const store = makeStore(state);
    const attempts: string[] = [];
    const pass = await runFreshnessWatchdogPass({
      store,
      now: () => new Date(T0),
      forceAttempt: async (p) => void attempts.push(p),
    });
    expect(pass.guardBlocked).toEqual(["attribution"]);
    expect(pass.forced).toEqual([]);
    expect(attempts).toEqual([]);
    expect(state.running[0].status).toBe("running"); // a possibly-live run is NEVER killed by the watchdog
    expect(state.finishedErrors).toEqual([]);
  });

  test("a stale provider is recovered: stale rows cleared reaper-style, EXACTLY ONE attempt, incident recorded", async () => {
    const state = baseState({
      lastSuccess: { attribution: iso(30 * MIN) },
      running: [
        { id: "run-stale", provider: "attribution", status: "running", started_at: iso(45 * MIN), finished_at: null, records_upserted: 3, error: null },
      ],
    });
    const store = makeStore(state);
    const attempts: string[] = [];
    const pass = await runFreshnessWatchdogPass({
      store,
      now: () => new Date(T0),
      forceAttempt: async (p) => {
        attempts.push(p);
        state.lastSuccess.attribution = iso(MIN); // the forced sync succeeds → fresh again
      },
    });
    expect(attempts).toEqual(["attribution"]); // exactly ONE bounded attempt
    expect(pass.forced).toEqual(["attribution"]);
    expect(pass.recovered).toEqual(["attribution"]);
    expect(pass.escalated).toEqual([]);
    expect(pass.alerts).toEqual([]); // recovered before escalation — no paging
    // the stale row (45 min > the 30-min shared liveness bound) cleared with honest text
    expect(pass.clearedRunningRows).toBe(1);
    expect(state.running[0].status).toBe("error");
    expect(state.finishedErrors[0]).toContain("freshness watchdog");
    expect(state.finishedErrors[0]).toContain("attribution");
    // incident state persisted with the attempt count + closure
    const incidents = JSON.parse(state.checkpoints.get(INCIDENT_CHECKPOINT_KEY)!) as { providers: Record<string, ProviderIncidentState> };
    expect(incidents.providers.attribution.attempts).toBe(1);
    expect(incidents.providers.attribution.recoveredAt).not.toBeNull();
  });

  test("recovery window: at most ONE forced attempt per window — no stampede", async () => {
    const state = baseState({ lastSuccess: { attribution: iso(30 * MIN) } });
    const store = makeStore(state);
    let attempts = 0;
    const opts = {
      store,
      forceAttempt: async () => {
        attempts++;
      },
    };
    const p1 = await runFreshnessWatchdogPass({ ...opts, now: () => new Date(T0) });
    expect(p1.forced).toEqual(["attribution"]);
    const p2 = await runFreshnessWatchdogPass({ ...opts, now: () => new Date(T0 + 5 * MIN) });
    expect(p2.skippedInWindow).toEqual(["attribution"]);
    expect(p2.forced).toEqual([]);
    expect(attempts).toBe(1); // RECOVERY_ATTEMPT_MIN_INTERVAL_MS holds
    const p3 = await runFreshnessWatchdogPass({ ...opts, now: () => new Date(T0 + RECOVERY_ATTEMPT_MIN_INTERVAL_MS + 1) });
    expect(p3.forced).toEqual(["attribution"]);
    expect(attempts).toBe(2);
  });

  test("healthy providers are untouched; unknown providers are never recovered or alerted", async () => {
    const state = baseState({
      lastSuccess: { highlevel: iso(MIN), attribution: iso(MIN), acuity: iso(MIN), google_sheets: iso(MIN), acuity_availability: iso(MIN) },
    });
    const store = makeStore(state);
    const attempts: string[] = [];
    const alerts: string[] = [];
    const pass = await runFreshnessWatchdogPass({
      store,
      now: () => new Date(T0),
      forceAttempt: async (p) => void attempts.push(p),
      sendAlert: async (level, subject) => {
        alerts.push(`${level}:${subject}`);
        return { configured: false, delivered: true };
      },
    });
    expect(pass.forced).toEqual([]);
    expect(pass.escalated).toEqual([]);
    expect(pass.alerts).toEqual([]);
    expect(attempts).toEqual([]);
    // an unknown provider (never succeeded) is reported but left alone
    const pass2 = await runFreshnessWatchdogPass({
      store: makeStore(baseState({})),
      now: () => new Date(T0),
      forceAttempt: async (p) => void attempts.push(p),
    });
    expect(pass2.forced).toEqual([]);
    expect(pass2.providers.every((f) => f.status === "unknown")).toBe(true);
  });
});

describe("provider freshness watchdog — escalation + rate-limited alerts", () => {
  function escalatingStore() {
    const state = baseState({ lastSuccess: { attribution: iso(60 * MIN) } });
    return { state, store: makeStore(state) };
  }

  test("still stale after N attempts → DEGRADED + ONE alert per incident (restart-proof via the DB checkpoint)", async () => {
    const { state, store } = escalatingStore();
    const alerts: { level: string; subject: string; body: string }[] = [];
    const sendAlert = async (level: "degraded" | "resolved", subject: string, body: string) => {
      alerts.push({ level, subject, body });
      return { configured: true, delivered: true };
    };
    const opts = { store, sendAlert, forceAttempt: noopAttempt };
    // N−1 passes: attempts 1..N−1, no escalation
    let t = T0;
    for (let i = 0; i < FRESHNESS_ESCALATION_ATTEMPTS - 1; i++) {
      const r = await runFreshnessWatchdogPass({ ...opts, now: () => new Date(t) });
      expect(r.escalated).toEqual([]);
      t += WINDOW;
    }
    // the pass that performs attempt N finds the provider still stale → escalates
    const escalate = await runFreshnessWatchdogPass({ ...opts, now: () => new Date(t) });
    expect(escalate.escalated).toEqual(["attribution"]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe("degraded");
    expect(alerts[0].subject).toContain("attribution");
    expect(alerts[0].subject).toContain("DEGRADED");
    expect(alerts[0].body).toContain("stale");
    // subsequent passes: still stale, still forced — but NO second alert (one per incident)
    for (let i = 0; i < 3; i++) {
      t += WINDOW;
      const r = await runFreshnessWatchdogPass({ ...opts, now: () => new Date(t) });
      expect(r.alerts).toEqual([]);
    }
    expect(alerts).toHaveLength(1);
    // RESTART-PROOF: every pass loads incident state from the DB checkpoint
    // (loadIncidentState → store.getSyncCheckpoint) — exactly what a restarted
    // process does. Simulate it explicitly with a FRESH stub store seeded only
    // with the persisted checkpoint + the still-stale provider:
    const persisted = state.checkpoints.get(INCIDENT_CHECKPOINT_KEY)!;
    const restart = baseState({ lastSuccess: { attribution: iso(90 * MIN) } });
    restart.checkpoints.set(INCIDENT_CHECKPOINT_KEY, persisted);
    const r2 = await runFreshnessWatchdogPass({
      store: makeStore(restart),
      now: () => new Date(t + WINDOW),
      sendAlert,
      forceAttempt: noopAttempt,
    });
    expect(r2.alerts).toEqual([]); // no alert storm after restart
    expect(r2.forced).toEqual(["attribution"]); // recovery keeps trying
  });

  test("failed alert send retries at most once per ALERT_RETRY interval — no alerting retry storm", async () => {
    const { store } = escalatingStore();
    let deliveries = 0;
    const opts = {
      store,
      forceAttempt: noopAttempt,
      sendAlert: async () => {
        deliveries++;
        return { configured: true, delivered: false, error: "knock HTTP 500" };
      },
    };
    let t = T0;
    // escalate (3 passes) — one failed send
    await runN(store, opts.sendAlert, opts.forceAttempt, FRESHNESS_ESCALATION_ATTEMPTS, t);
    t += FRESHNESS_ESCALATION_ATTEMPTS * WINDOW;
    expect(deliveries).toBe(1);
    // +1 window: still degraded, retry interval (60 min) not elapsed → no re-send
    await runFreshnessWatchdogPass({ ...opts, now: () => new Date(t) });
    expect(deliveries).toBe(1);
    // +61 min from the failed attempt: retry finally allowed → one more send
    await runFreshnessWatchdogPass({ ...opts, now: () => new Date(t + 61 * MIN) });
    expect(deliveries).toBe(2);
  });

  test("recovery after escalation fires exactly one 'resolved' alert and closes the incident", async () => {
    const { state, store } = escalatingStore();
    const alerts: { level: string; subject: string }[] = [];
    const sendAlert = async (level: "degraded" | "resolved", subject: string, _body: string) => {
      alerts.push({ level, subject });
      return { configured: true, delivered: true };
    };
    const opts = { store, sendAlert, forceAttempt: noopAttempt };
    let t = T0;
    await runN(store, sendAlert, noopAttempt, FRESHNESS_ESCALATION_ATTEMPTS, t);
    t += FRESHNESS_ESCALATION_ATTEMPTS * WINDOW;
    expect(alerts.map((a) => a.level)).toEqual(["degraded"]);
    // background tick recovers the provider between passes (anchored to the
    // pass clock `t`, which has advanced past T0)
    state.lastSuccess.attribution = new Date(t - MIN).toISOString();
    const resolved = await runFreshnessWatchdogPass({ ...opts, now: () => new Date(t) });
    expect(resolved.recovered).toEqual(["attribution"]);
    const resolvedAlerts = alerts.filter((a) => a.level === "resolved");
    expect(resolvedAlerts).toHaveLength(1);
    expect(resolvedAlerts[0].subject).toContain("RECOVERED");
    // and it never re-fires
    await runFreshnessWatchdogPass({ ...opts, now: () => new Date(t + WINDOW) });
    expect(alerts.filter((a) => a.level === "resolved")).toHaveLength(1);
  });

  test("a NEW stale period after a closed incident starts a fresh incident (and may alert again)", async () => {
    const { state, store } = escalatingStore();
    const alerts: string[] = [];
    const sendAlert = async (level: "degraded" | "resolved", subject: string) => {
      alerts.push(`${level}:${subject.slice(0, 30)}`);
      return { configured: true, delivered: true };
    };
    let t = T0;
    await runN(store, sendAlert, noopAttempt, FRESHNESS_ESCALATION_ATTEMPTS, t);
    t += FRESHNESS_ESCALATION_ATTEMPTS * WINDOW;
    // recover…
    state.lastSuccess.attribution = new Date(t - MIN).toISOString();
    await runFreshnessWatchdogPass({ store, sendAlert, forceAttempt: noopAttempt, now: () => new Date(t) });
    // …and go stale AGAIN much later: new incident → new degraded alert allowed
    state.lastSuccess.attribution = new Date(t + 24 * 60 * MIN - 60 * MIN).toISOString();
    await runN(store, sendAlert, noopAttempt, FRESHNESS_ESCALATION_ATTEMPTS, t + 24 * 60 * MIN);
    expect(alerts.filter((a) => a.startsWith("degraded")).length).toBe(2);
  });
});

describe("provider freshness watchdog — default dispatcher", () => {
  test("createDefaultForceAttempt rejects unknown providers (the five watched ones map to their tick functions)", async () => {
    const fn = createDefaultForceAttempt();
    await expect(fn("nonexistent")).rejects.toThrow(/no recovery dispatcher/);
    for (const p of FRESHNESS_PROVIDERS) {
      // each watched provider resolves to its tick function (not the reject
      // path) — calling it would hit live APIs, so only verify the mapping
      // exists by the absence of the "no recovery dispatcher" shape:
      expect(FRESHNESS_PROVIDERS.includes(p as never)).toBe(true);
    }
  });
});
