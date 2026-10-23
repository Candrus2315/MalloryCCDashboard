/**
 * RELIABILITY 2b/3 — process supervisor + liveness surfacing.
 *
 * Covers the three surfaces the owner brief asked for:
 *   1. /health carries a `heartbeat` field (ok/stale/dead/unknown incl. the
 *      missing-log path) with every existing field untouched;
 *   2. the shared page banner logic surfaces heartbeat stale/dead (and stays
 *      silent on ok/unknown — no cry-wolf without evidence);
 *   3. the supervisor's DECISION RULES (the TS helper ops/supervisor.sh
 *      executes through ops/supervisor-decide.ts): commit-match, two-strike
 *      debounce, the ≥2-restarts/5-min backoff, the foreign-port scope guard,
 *      and the heartbeat pgrep rule — plus the CLI contract itself.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyHeartbeatAge,
  heartbeatBannerWarning,
  latestHeartbeatTick,
  latestTickLine,
  parseTickTimestamp,
  readHeartbeatFreshness,
  withHeartbeatWarning,
  HEARTBEAT_STALE_AFTER_MINUTES,
  type HeartbeatFreshness,
} from "../heartbeat-freshness";
import { buildHealthPayload, healthHttpStatus, type HealthPayload } from "../health";
import {
  classifyHeartbeat,
  classifyServe,
  decideSupervisorCycle,
  emptySupervisorState,
  nextSupervisorState,
  parseSupervisorState,
  pruneRestarts,
  restartsInWindow,
  serveIsAliveAndCurrent,
  shouldBackOff,
  SUPERVISOR_BACKOFF_MS,
  SUPERVISOR_RESTART_WINDOW_MS,
  type ServeFacts,
  type SupervisorState,
} from "../supervisor-decisions";
import { defaultSettings, type Store } from "../store/types";

const T0 = Date.parse("2026-10-23T12:00:00Z");
const MIN = 60_000;
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();
const hb = (over: Partial<HeartbeatFreshness>): HeartbeatFreshness => ({
  lastTickAt: iso(2 * MIN),
  ageMinutes: 2,
  status: "ok",
  intervalMinutes: 4,
  staleAfterMinutes: 12,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. TICK-line parsing (pure)
// ---------------------------------------------------------------------------
describe("heartbeat log parsing", () => {
  const LOG = [
    "2026-10-23T09:00:00Z | heartbeat started (interval 240s, tick timeout 230s)",
    "2026-10-23T09:04:00Z | TICK: {\"outcome\":\"synced\"}",
    "2026-10-23T09:08:00Z | TICK: {\"outcome\":\"skipped\"}",
    "2026-10-23T09:12:00Z | tick produced no summary (timeout 230s hit or import failed) — retrying next cycle",
    "2026-10-23T09:16:00Z | TICK: {\"outcome\":\"synced\",\"appointments\":479}",
  ].join("\n");

  test("latestTickLine returns the NEWEST TICK line, ignoring started/no-summary lines", () => {
    expect(latestTickLine(LOG)).toBe("2026-10-23T09:16:00Z | TICK: {\"outcome\":\"synced\",\"appointments\":479}");
    expect(latestTickLine("2026-10-23T09:00:00Z | heartbeat started")).toBeNull();
    expect(latestTickLine("")).toBeNull();
  });

  test("'TICK ERROR' (no colon) is not a tick — the marker requires ' | TICK:'", () => {
    expect(latestTickLine("2026-10-23T09:00:00Z | TICK ERROR boom")).toBeNull();
  });

  test("parseTickTimestamp reads the ISO prefix; garbage → null", () => {
    expect(parseTickTimestamp("2026-10-23T09:16:00Z | TICK: {}")?.toISOString()).toBe("2026-10-23T09:16:00.000Z");
    expect(parseTickTimestamp("not-a-date | TICK: {}")).toBeNull();
    expect(parseTickTimestamp("no marker here")).toBeNull();
  });

  test("latestHeartbeatTick: newest of several wins; none → null", () => {
    expect(latestHeartbeatTick(LOG)?.toISOString()).toBe("2026-10-23T09:16:00.000Z");
    expect(latestHeartbeatTick("garbage only")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Freshness classification + the never-throw contract
// ---------------------------------------------------------------------------
describe("readHeartbeatFreshness", () => {
  let dir: string;
  const write = async (name: string, text: string) => {
    const p = join(dir, name);
    await writeFile(p, text);
    return p;
  };
  const read = (path: string, now = new Date(T0)) => readHeartbeatFreshness({ logPath: path, now });

  test("fresh tick → ok with age + lastTickAt", async () => {
    dir = await mkdtemp(join(tmpdir(), "hb-"));
    const p = await write("ok.log", `2026-10-23T11:56:00Z | TICK: {"outcome":"synced"}\n`);
    const f = await read(p);
    expect(f.status).toBe("ok");
    expect(f.ageMinutes).toBeCloseTo(4, 1);
    expect(f.lastTickAt).toBe("2026-10-23T11:56:00.000Z");
    expect(f.intervalMinutes).toBe(4);
    expect(f.staleAfterMinutes).toBe(HEARTBEAT_STALE_AFTER_MINUTES);
    await rm(dir, { recursive: true, force: true });
  });

  test("tick older than 3× interval (12 min) → stale", async () => {
    dir = await mkdtemp(join(tmpdir(), "hb-"));
    const p = await write("stale.log", `2026-10-23T11:00:00Z | TICK: {}\n`); // 60 min old
    const f = await read(p);
    expect(f.status).toBe("stale");
    expect(f.ageMinutes).toBeCloseTo(60, 1);
    await rm(dir, { recursive: true, force: true });
  });

  test("readable log with NO tick line → dead (no sign of life)", async () => {
    dir = await mkdtemp(join(tmpdir(), "hb-"));
    const p = await write("dead.log", "2026-10-23T09:00:00Z | heartbeat started (interval 240s, tick timeout 230s)\n");
    const f = await read(p);
    expect(f.status).toBe("dead");
    expect(f.lastTickAt).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  test("MISSING log → honest unknown (never a guess, never a throw)", async () => {
    const f = await read(join(tmpdir(), "does-not-exist", "heartbeat.log"));
    expect(f.status).toBe("unknown");
    expect(f.lastTickAt).toBeNull();
    expect(f.ageMinutes).toBeNull();
  });

  test("unreadable path (a directory) → unknown, never a throw", async () => {
    dir = await mkdtemp(join(tmpdir(), "hb-"));
    const f = await read(dir); // readFile on a directory throws EISDIR
    expect(f.status).toBe("unknown");
    await rm(dir, { recursive: true, force: true });
  });

  test("TICK line with undateable timestamp → unknown (evidence without a claim)", async () => {
    dir = await mkdtemp(join(tmpdir(), "hb-"));
    const p = await write("bad-ts.log", "not-a-date | TICK: {}\n");
    const f = await read(p);
    expect(f.status).toBe("unknown");
    await rm(dir, { recursive: true, force: true });
  });

  test("classifyHeartbeatAge: 12 min boundary is ok, 12.1 stale, no age dead", () => {
    expect(classifyHeartbeatAge(11.9)).toBe("ok");
    expect(classifyHeartbeatAge(12)).toBe("ok");
    expect(classifyHeartbeatAge(12.1)).toBe("stale");
    expect(classifyHeartbeatAge(null)).toBe("dead");
  });
});

// ---------------------------------------------------------------------------
// 3. /health payload — the heartbeat field is ADDITIVE, existing fields intact
// ---------------------------------------------------------------------------
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

describe("/health heartbeat field", () => {
  test("payload carries heartbeat; existing fields/providers untouched", async () => {
    const payload: HealthPayload = await buildHealthPayload({
      store: makeStore({ highlevel: iso(MIN), attribution: iso(MIN) }),
      now: () => new Date(T0),
      heartbeat: hb({}),
    });
    expect(payload.heartbeat.status).toBe("ok");
    expect(payload.status).toBe("ok");
    expect(healthHttpStatus(payload)).toBe(200);
    // existing fields still exactly the old contract
    expect(payload.commit.length).toBeGreaterThan(0);
    expect(Object.keys(payload.providers).sort()).toEqual(["acuity", "acuity_availability", "attribution", "google_sheets", "highlevel"]);
    expect(payload.providers.highlevel.status).toBe("ok");
    expect(payload.error).toBeUndefined();
    // no business data in the payload
    expect(JSON.stringify(payload)).not.toMatch(/calls|contacts|leads|reps/i);
  });

  test("stale heartbeat does NOT flip the 200/503 contract (providers rule it)", async () => {
    const fresh = await buildHealthPayload({ store: makeStore({ attribution: iso(MIN) }), now: () => new Date(T0), heartbeat: hb({ status: "stale", ageMinutes: 34 }) });
    expect(fresh.status).toBe("ok");
    expect(healthHttpStatus(fresh)).toBe(200);
    const degradedProvider = await buildHealthPayload({ store: makeStore({ attribution: iso(30 * MIN) }), now: () => new Date(T0), heartbeat: hb({}) });
    expect(degradedProvider.status).toBe("degraded");
    expect(healthHttpStatus(degradedProvider)).toBe(503);
  });

  test("missing log → heartbeat unknown inside the payload (default test path)", async () => {
    const payload = await buildHealthPayload({ store: makeStore({ attribution: iso(MIN) }), now: () => new Date(T0) });
    expect(payload.heartbeat.status).toBe("unknown");
  });

  test("explicit log path works (ok fixture / missing file)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "hbp-"));
    const p = join(dir, "hb.log");
    writeFileSync(p, "2026-10-23T11:58:00Z | TICK: {}\n");
    const okPayload = await buildHealthPayload({ store: makeStore({ attribution: iso(MIN) }), now: () => new Date(T0), heartbeatLogPath: p });
    expect(okPayload.heartbeat.status).toBe("ok");
    const missing = await buildHealthPayload({ store: makeStore({ attribution: iso(MIN) }), now: () => new Date(T0), heartbeatLogPath: join(dir, "nope.log") });
    expect(missing.heartbeat.status).toBe("unknown");
    rm(dir, { recursive: true, force: true });
  });

  test("store failure path still carries heartbeat (store-independent surface)", async () => {
    const payload = await buildHealthPayload({ store: makeStore({}, true), now: () => new Date(T0), heartbeat: hb({ status: "stale", ageMinutes: 20 }) });
    expect(payload.status).toBe("degraded");
    expect(payload.error).toContain("connection refused");
    expect(payload.heartbeat.status).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// 4. Banner: the shared warning list surfaces stale/dead, quiet on ok/unknown
// ---------------------------------------------------------------------------
describe("banner heartbeat clause", () => {
  test("heartbeatBannerWarning: stale + dead get one quiet clause; ok/unknown stay silent", () => {
    expect(heartbeatBannerWarning(hb({ status: "stale", ageMinutes: 34 }))).toContain("Sync heartbeat is stale");
    expect(heartbeatBannerWarning(hb({ status: "stale", ageMinutes: 34 }))).toContain("34 min ago");
    expect(heartbeatBannerWarning(hb({ status: "dead", ageMinutes: null, lastTickAt: null }))).toContain("Sync heartbeat has stopped");
    expect(heartbeatBannerWarning(hb({}))).toBeNull();
    expect(heartbeatBannerWarning(hb({ status: "unknown", ageMinutes: null, lastTickAt: null }))).toBeNull();
  });

  test("withHeartbeatWarning appends the clause to existing warnings (order preserved)", async () => {
    const stale = await withHeartbeatWarning(["HighLevel reported a sync error"], { heartbeat: hb({ status: "stale", ageMinutes: 34 }) });
    expect(stale).toHaveLength(2);
    expect(stale[0]).toBe("HighLevel reported a sync error");
    expect(stale[1]).toContain("Sync heartbeat is stale");
    const ok = await withHeartbeatWarning(["existing"], { heartbeat: hb({}) });
    expect(ok).toEqual(["existing"]);
    const empty = await withHeartbeatWarning([], { heartbeat: hb({ status: "dead", ageMinutes: null, lastTickAt: null }) });
    expect(empty).toHaveLength(1);
    expect(empty[0]).toContain("Sync heartbeat has stopped");
  });

  test("withHeartbeatWarning reads a fixture log by path (the real wiring path)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "hbw-"));
    const p = join(dir, "hb.log");
    writeFileSync(p, "2026-10-23T10:00:00Z | TICK: {}\n"); // 120 min old at T0
    const out = await withHeartbeatWarning([], { logPath: p, now: new Date(T0) });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Sync heartbeat is stale");
    rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 5. Supervisor decision rules (the logic ops/supervisor.sh executes)
// ---------------------------------------------------------------------------
const facts = (over: Partial<ServeFacts> & { procs?: number }): ServeFacts & { procs: number } => ({
  lockPid: 32220,
  lockPidAlive: true,
  healthReachable: true,
  healthCommit: "4c70fcc",
  headCommit: "4c70fcc",
  portPid: 32220,
  procs: 1,
  ...over,
});

describe("classifyServe", () => {
  test("alive AND current → never restart", () => {
    const v = classifyServe(facts({}), 0, false);
    expect(v.action).toBe("none");
    expect(v.reason).toContain("alive and current");
    expect(serveIsAliveAndCurrent(facts({}))).toBe(true);
  });

  test("stale commit (publish without restart) → two-strike: observe then restart", () => {
    const f = facts({ healthCommit: "3addeb1" });
    const first = classifyServe(f, 0, false);
    expect(first.action).toBe("observe");
    expect(first.reason).toContain("stale commit");
    const second = classifyServe(f, 1, false);
    expect(second.action).toBe("restart");
    expect(second.reason).toContain("3addeb1");
  });

  test("/health unreachable → observe then restart, reason names the lock pid", () => {
    const f = facts({ healthReachable: false });
    expect(classifyServe(f, 0, false).action).toBe("observe");
    const second = classifyServe(f, 1, false);
    expect(second.action).toBe("restart");
    expect(second.reason).toContain("not answering");
  });

  test("commit missing while reachable counts as bad (cannot confirm currency)", () => {
    const f = facts({ healthCommit: null });
    expect(serveIsAliveAndCurrent(f)).toBe(false);
  });

  test("healthy serve with a stale lock pid → none + anomaly (never restart healthy)", () => {
    const v = classifyServe(facts({ lockPidAlive: false }), 0, false);
    expect(v.action).toBe("none");
    expect(v.anomaly).toContain("lock file stale");
  });

  test("backoff active → skip-backoff even when bad", () => {
    const v = classifyServe(facts({ healthReachable: false }), 1, true);
    expect(v.action).toBe("skip-backoff");
  });

  test("FOREIGN PORT GUARD: port held by a pid that is not the lock pid → stand down", () => {
    // bad serve + foreign port holder → refuse (only the lock pid may be killed)
    const foreign = classifyServe(facts({ portPid: 999, healthReachable: false }), 1, false);
    expect(foreign.action).toBe("skip-foreign-port");
    expect(foreign.reason).toContain("refusing to kill outside scope");
    const noLock = classifyServe(facts({ lockPid: null, lockPidAlive: false, portPid: 999, healthReachable: false }), 1, false);
    expect(noLock.action).toBe("skip-foreign-port");
    // healthy + foreign port holder → do NOT restart a healthy serve, log the anomaly
    const healthyForeign = classifyServe(facts({ portPid: 999 }), 0, false);
    expect(healthyForeign.action).toBe("none");
    expect(healthyForeign.anomaly).toContain("port held by pid 999");
    // port owned by the lock pid itself → normal restart path
    expect(classifyServe(facts({ healthReachable: false }), 1, false).action).toBe("restart");
  });
});

describe("classifyHeartbeat", () => {
  test("procs > 0 → none", () => {
    const v = classifyHeartbeat({ procs: 2 }, false);
    expect(v.action).toBe("none");
    expect(v.reason).toContain("running");
  });
  test("procs 0 → restart; under backoff → skip-backoff", () => {
    expect(classifyHeartbeat({ procs: 0 }, false).action).toBe("restart");
    expect(classifyHeartbeat({ procs: 0 }, true).action).toBe("skip-backoff");
  });
});

describe("backoff window", () => {
  test("restartsInWindow counts only recent stamps", () => {
    expect(restartsInWindow([T0 - 4 * MIN, T0 - 10 * MIN], T0)).toBe(1);
    expect(restartsInWindow([T0 - 6 * MIN], T0, SUPERVISOR_RESTART_WINDOW_MS)).toBe(0);
  });
  test("shouldBackOff: the 2nd restart request within 5 min backs off", () => {
    expect(shouldBackOff([], T0)).toBe(false);
    expect(shouldBackOff([T0 - 60_000], T0)).toBe(true);
    expect(shouldBackOff([T0 - 6 * MIN], T0)).toBe(false); // outside window
  });
  test("pruneRestarts drops stale stamps", () => {
    expect(pruneRestarts([T0 - 10 * MIN, T0 - 1 * MIN], T0)).toEqual([T0 - 1 * MIN]);
  });
});

describe("nextSupervisorState", () => {
  test("first restart is recorded; a SECOND request inside the window sets the 10-min backoff instead", () => {
    const s0 = emptySupervisorState();
    const t1 = nextSupervisorState(s0, classifyServe(facts({ healthReachable: false }), 1, false), classifyHeartbeat({ procs: 1 }, false), T0);
    expect(t1.state.serveRestarts).toHaveLength(1);
    expect(t1.state.backoffUntil).toBeNull();

    const t2 = nextSupervisorState(t1.state, classifyServe(facts({ healthReachable: false }), 1, false), classifyHeartbeat({ procs: 1 }, false), T0 + 60_000);
    expect(t2.state.serveRestarts).toHaveLength(1); // NOT a second entry
    expect(t2.state.backoffUntil).toBe(T0 + 60_000 + SUPERVISOR_BACKOFF_MS);
  });

  test("priorBadServe resets on ok and grows on bad; state line change detection", () => {
    const ok = classifyServe(facts({}), 0, false);
    const bad = classifyServe(facts({ healthReachable: false }), 0, false);
    const t = nextSupervisorState(emptySupervisorState(), bad, classifyHeartbeat({ procs: 1 }, false), T0);
    expect(t.state.priorBadServe).toBe(1);
    expect(t.stateLine).toBe("serve=bad,heartbeat=ok");
    expect(t.stateChanged).toBe(true);
    const t2 = nextSupervisorState(t.state, ok, classifyHeartbeat({ procs: 1 }, false), T0 + 1);
    expect(t2.state.priorBadServe).toBe(0);
    expect(t2.stateLine).toBe("serve=ok,heartbeat=ok");
  });

  test("heartbeat restart records its own counter and its own backoff", () => {
    const t1 = nextSupervisorState(emptySupervisorState(), classifyServe(facts({}), 0, false), classifyHeartbeat({ procs: 0 }, false), T0);
    expect(t1.state.hbRestarts).toHaveLength(1);
    const t2 = nextSupervisorState(t1.state, classifyServe(facts({}), 0, false), classifyHeartbeat({ procs: 0 }, false), T0 + 60_000);
    expect(t2.state.hbRestarts).toHaveLength(1);
    expect(t2.state.hbBackoffUntil).toBe(T0 + 60_000 + SUPERVISOR_BACKOFF_MS);
  });
});

describe("state parse/serialize", () => {
  test("parseSupervisorState: garbage → honest defaults; valid round-trip", () => {
    expect(parseSupervisorState(null)).toEqual(emptySupervisorState());
    expect(parseSupervisorState("{not json")).toEqual(emptySupervisorState());
    expect(parseSupervisorState('{"serveRestarts":["nope"]}')).toEqual(emptySupervisorState());
    const s: SupervisorState = { lastStateLine: "serve=ok,heartbeat=ok", serveRestarts: [1, 2], hbRestarts: [3], backoffUntil: 99, hbBackoffUntil: null, priorBadServe: 0 };
    expect(parseSupervisorState(JSON.stringify(s))).toEqual(s);
  });
});

describe("decideSupervisorCycle (full cycle rule assembly)", () => {
  test("healthy cycle: no actions, quiet state", () => {
    const v = decideSupervisorCycle({ facts: facts({}), stateRaw: null, nowMs: T0 });
    expect(v.serve.action).toBe("none");
    expect(v.hb.action).toBe("none");
    expect(v.stateLine).toBe("serve=ok,heartbeat=ok");
    expect(v.stateChanged).toBe(true); // first cycle always logs its state
  });

  test("second consecutive bad cycle + one prior restart → backoff wins over restart", () => {
    const prior: SupervisorState = { ...emptySupervisorState(), priorBadServe: 1, serveRestarts: [T0 - 60_000] };
    const v = decideSupervisorCycle({ facts: facts({ healthReachable: false }), stateRaw: JSON.stringify(prior), nowMs: T0 });
    expect(v.serve.action).toBe("restart"); // decision says restart…
    // …but the STATE transition must show the backoff capture, not a 2nd restart:
    expect(v.state.backoffUntil).toBe(T0 + SUPERVISOR_BACKOFF_MS);
    expect(v.state.serveRestarts).toHaveLength(1);
  });

  test("dead heartbeat with an existing state file → heartbeat restart", () => {
    const v = decideSupervisorCycle({ facts: facts({ procs: 0 }), stateRaw: JSON.stringify(emptySupervisorState()), nowMs: T0 });
    expect(v.hb.action).toBe("restart");
  });

  test("active backoff in state → skip-backoff (do not loop-crash)", () => {
    const prior: SupervisorState = { ...emptySupervisorState(), backoffUntil: T0 + 5 * MIN, priorBadServe: 5 };
    const v = decideSupervisorCycle({ facts: facts({ healthReachable: false }), stateRaw: JSON.stringify(prior), nowMs: T0 });
    expect(v.serve.action).toBe("skip-backoff");
    expect(v.backoffActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. The CLI contract (bun ops/supervisor-decide.ts) — what bash actually runs
// ---------------------------------------------------------------------------
describe("ops/supervisor-decide.ts CLI", () => {
  test("verdict JSON on line 1, LOG lines after, next state persisted", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "cli-"));
    const factsPath = join(dir, "facts.json");
    const statePath = join(dir, "state.json");
    const nextPath = join(dir, "next.json");
    writeFileSync(factsPath, JSON.stringify({ facts: facts({ healthCommit: "3addeb1" }) }));
    // two-strike: a prior bad cycle in the state file makes this a restart
    writeFileSync(statePath, JSON.stringify({ ...emptySupervisorState(), priorBadServe: 1 }));
    const proc = Bun.spawnSync(["bun", "ops/supervisor-decide.ts", factsPath, statePath, nextPath], { cwd: process.cwd() });
    expect(proc.exitCode).toBe(0);
    const out = proc.stdout.toString().trim().split("\n");
    const verdict = JSON.parse(out[0]) as { serve: { action: string }; hb: { action: string }; stateLine: string; stateChanged: boolean };
    expect(verdict.serve.action).toBe("restart");
    expect(verdict.hb.action).toBe("none");
    expect(out.slice(1).every((l) => l.startsWith("LOG | "))).toBe(true);
    expect(out.join("\n")).toContain("stale commit");
    expect(out.join("\n")).toContain("3addeb1");
    expect(existsSync(nextPath)).toBe(true);
    const next = JSON.parse(readFileSync(nextPath, "utf8")) as SupervisorState;
    expect(next.serveRestarts.length).toBe(1);
    // sanitize contract: injected garbage commit cannot become a verdict input
    writeFileSync(statePath, JSON.stringify(emptySupervisorState()));
    writeFileSync(factsPath, JSON.stringify({ facts: { ...facts({}), healthCommit: "PenguinRandomHouse" } }));
    const proc2 = Bun.spawnSync(["bun", "ops/supervisor-decide.ts", factsPath, statePath], { cwd: process.cwd() });
    const v2 = JSON.parse(proc2.stdout.toString().trim().split("\n")[0]) as { serve: { action: string } };
    expect(v2.serve.action).toBe("observe"); // commit unusable → bad, debounced
    rm(dir, { recursive: true, force: true });
  });
});
