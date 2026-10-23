/**
 * SUPERVISOR DECISION LOGIC (Reliability 2b/3) — the pure, test-covered core
 * of ops/supervisor.sh. The bash script collects raw FACTS (lock pid liveness,
 * /health answer + commit, git HEAD, heartbeat process count, port owner) and
 * hands them to ops/supervisor-decide.ts, which runs THIS module and prints a
 * verdict; bash then executes only what the verdict says. Keeping the rules
 * here means bun tests pin the exact restart/backoff semantics the production
 * loop enforces.
 *
 * Rules (owner brief):
 *   serve     — restart exactly per the runbook when the serve is DOWN or
 *               STALE-COMMIT (publish swaps files but never restarts; /health's
 *               commit is cached per process at boot, so serving-commit vs git
 *               HEAD is the honest "is the running code current" test). A serve
 *               that is alive AND current is never restarted.
 *   debounce  — a serve seen bad must be seen bad on TWO consecutive cycles
 *               before a restart: /health can blip once (slow store moment)
 *               and a restart during a DB slowdown would re-run the ensureSchema
 *               sweep — the Oct-8 outage chain. 60s later the second strike
 *               confirms; the heartbeat keeps ticking meanwhile.
 *   backoff   — a SECOND restart request within 5 min of the last one means
 *               the restarts are not sticking: log it, back off 10 min, do not
 *               loop-crash. (≥2 restarts/5 min is exactly the crash-loop the
 *               owner brief forbids.)
 *   heartbeat — pgrep-deterministic, no debounce: not running → start it,
 *               same backoff window applies to repeated heartbeat starts.
 *   scope     — the supervisor only ever kills the serve PID from
 *               .run/server.lock and starts/stops the heartbeat script. If the
 *               port is held by a pid that is NOT the lock pid, it refuses and
 *               logs — killing an unknown process is outside its mandate.
 */
import { readFileSync } from "node:fs";

/** Restart-rate window (ms) — "within 5 min". */
export const SUPERVISOR_RESTART_WINDOW_MS = 5 * 60_000;
/** More than ONE restart per window (i.e. a 2nd request) triggers backoff. */
export const SUPERVISOR_MAX_RESTARTS_PER_WINDOW = 2;
/** Backoff duration (ms) — "log and back off 10 min". */
export const SUPERVISOR_BACKOFF_MS = 10 * 60_000;
/** Consecutive bad cycles required before a serve restart. */
export const SERVE_BAD_STRIKES_BEFORE_RESTART = 2;

// ---------------------------------------------------------------------------
// FACTS + STATE (plain serializable shapes — bash builds the JSON)
// ---------------------------------------------------------------------------

export interface ServeFacts {
  /** PID from .run/server.lock (null: no/unreadable lock). */
  lockPid: number | null;
  lockPidAlive: boolean;
  /** /health answered with parseable JSON. */
  healthReachable: boolean;
  /** commit field from /health (null when absent/unparseable). */
  healthCommit: string | null;
  /** `git rev-parse --short HEAD` (null when git fails). */
  headCommit: string | null;
  /** PID currently LISTENing on the serve port (null when free/unknown). */
  portPid: number | null;
}

export interface HeartbeatFacts {
  /** `pgrep -fc sync-heartbeat.sh` — 0 means not running. */
  procs: number;
}

export interface SupervisorState {
  lastStateLine: string | null;
  serveRestarts: number[];
  hbRestarts: number[];
  backoffUntil: number | null;
  hbBackoffUntil: number | null;
  priorBadServe: number;
}

export function emptySupervisorState(): SupervisorState {
  return { lastStateLine: null, serveRestarts: [], hbRestarts: [], backoffUntil: null, hbBackoffUntil: null, priorBadServe: 0 };
}

/** Parse the state file's contents — never throws, honest defaults on garbage. */
export function parseSupervisorState(raw: string | null): SupervisorState {
  if (!raw) return emptySupervisorState();
  try {
    const p = JSON.parse(raw) as Partial<SupervisorState>;
    return {
      lastStateLine: typeof p.lastStateLine === "string" ? p.lastStateLine : null,
      serveRestarts: Array.isArray(p.serveRestarts) ? p.serveRestarts.filter((n): n is number => typeof n === "number" && Number.isFinite(n)) : [],
      hbRestarts: Array.isArray(p.hbRestarts) ? p.hbRestarts.filter((n): n is number => typeof n === "number" && Number.isFinite(n)) : [],
      backoffUntil: typeof p.backoffUntil === "number" ? p.backoffUntil : null,
      hbBackoffUntil: typeof p.hbBackoffUntil === "number" ? p.hbBackoffUntil : null,
      priorBadServe: typeof p.priorBadServe === "number" ? p.priorBadServe : 0,
    };
  } catch {
    return emptySupervisorState();
  }
}

// ---------------------------------------------------------------------------
// SERVE CLASSIFICATION
// ---------------------------------------------------------------------------

export type ServeAction = "none" | "observe" | "restart" | "skip-backoff" | "skip-foreign-port";

export interface ServeVerdict {
  action: ServeAction;
  /** Human one-liner — the supervisor logs it. */
  reason: string;
  /** Coarse state for the quiet state line (logged only on change). */
  state: "ok" | "bad" | "restarting" | "backoff" | "blocked";
  /** Non-fatal oddity worth one log line (e.g. stale lock while healthy). */
  anomaly: string | null;
}

/** True when /health answered AND the served commit matches git HEAD. */
export function serveIsAliveAndCurrent(f: ServeFacts): boolean {
  return f.healthReachable && f.healthCommit != null && f.headCommit != null && f.healthCommit === f.headCommit;
}

function serveBadReason(f: ServeFacts): string {
  if (!f.healthReachable) return `/health not answering (lock pid ${f.lockPid ?? "none"} ${f.lockPidAlive ? "alive" : "gone"})`;
  if (f.healthCommit == null || f.headCommit == null) return `/health answered but commit unknown (serving=${f.healthCommit ?? "?"} HEAD=${f.headCommit ?? "?"})`;
  return `stale commit: serving ${f.healthCommit}, HEAD ${f.headCommit} (publish restarted?)`;
}

/**
 * Decide the serve action. `priorBadServe` = consecutive bad cycles BEFORE
 * this one; `backoffActive` = still inside a 10-min restart backoff.
 */
export function classifyServe(f: ServeFacts, priorBadServe: number, backoffActive: boolean): ServeVerdict {
  if (serveIsAliveAndCurrent(f)) {
    let anomaly: string | null = null;
    if (!f.lockPidAlive) {
      anomaly = `lock file stale (pid ${f.lockPid ?? "none"} gone) but /health is healthy and current — not restarting a healthy serve`;
    } else if (f.portPid != null && f.lockPid != null && f.portPid !== f.lockPid) {
      anomaly = `port held by pid ${f.portPid}, lock says ${f.lockPid} — healthy and current, not touching either`;
    }
    return { action: "none", reason: "serve alive and current", state: "ok", anomaly };
  }
  const why = serveBadReason(f);
  if (backoffActive) {
    return { action: "skip-backoff", reason: `${why} — restart backoff active, waiting it out`, state: "backoff", anomaly: null };
  }
  // Foreign-port guard: only ever touch the lock pid. If the port is held by
  // someone else (lock gone or a different pid), killing/starting is outside
  // scope — log it honestly and stand down.
  if (f.portPid != null && (f.lockPid == null || f.portPid !== f.lockPid)) {
    return {
      action: "skip-foreign-port",
      reason: `${why} — port held by pid ${f.portPid}, not the lock pid ${f.lockPid ?? "none"}; refusing to kill outside scope`,
      state: "blocked",
      anomaly: null,
    };
  }
  if (priorBadServe + 1 < SERVE_BAD_STRIKES_BEFORE_RESTART) {
    return { action: "observe", reason: `${why} (strike ${priorBadServe + 1}/${String(SERVE_BAD_STRIKES_BEFORE_RESTART)} — confirming next cycle)`, state: "bad", anomaly: null };
  }
  return { action: "restart", reason: `restarting serve: ${why}`, state: "restarting", anomaly: null };
}

// ---------------------------------------------------------------------------
// HEARTBEAT CLASSIFICATION
// ---------------------------------------------------------------------------

export type HeartbeatAction = "none" | "restart" | "skip-backoff";

export interface HeartbeatVerdict {
  action: HeartbeatAction;
  reason: string;
  state: "ok" | "starting" | "backoff";
}

/** pgrep is deterministic — no debounce, just the backoff guard. */
export function classifyHeartbeat(f: HeartbeatFacts, backoffActive: boolean): HeartbeatVerdict {
  if (f.procs > 0) return { action: "none", reason: `heartbeat running (${String(f.procs)} process${f.procs === 1 ? "" : "es"})`, state: "ok" };
  if (backoffActive) return { action: "skip-backoff", reason: "heartbeat not running — start backoff active, waiting it out", state: "backoff" };
  return { action: "restart", reason: "heartbeat not running — starting sync-heartbeat.sh (nohup)", state: "starting" };
}

// ---------------------------------------------------------------------------
// BACKOFF WINDOW
// ---------------------------------------------------------------------------

/** Restarts inside the lookback window ending at nowMs. */
export function restartsInWindow(stamps: number[], nowMs: number, windowMs: number = SUPERVISOR_RESTART_WINDOW_MS): number {
  return stamps.filter((t) => t <= nowMs && nowMs - t < windowMs).length;
}

/**
 * True when a restart requested NOW would be the ≥2nd inside the window —
 * the crash-loop the brief forbids; the caller backs off instead.
 */
export function shouldBackOff(stamps: number[], nowMs: number, windowMs: number = SUPERVISOR_RESTART_WINDOW_MS, max: number = SUPERVISOR_MAX_RESTARTS_PER_WINDOW): boolean {
  return restartsInWindow(stamps, nowMs, windowMs) >= max - 1;
}

/** Keep only timestamps still inside the window (state-file hygiene). */
export function pruneRestarts(stamps: number[], nowMs: number, windowMs: number = SUPERVISOR_RESTART_WINDOW_MS): number[] {
  return stamps.filter((t) => nowMs - t < windowMs);
}

// ---------------------------------------------------------------------------
// STATE TRANSITION (pure — the CLI applies it, bash persists it)
// ---------------------------------------------------------------------------

export interface SupervisorTransition {
  state: SupervisorState;
  stateLine: string;
  stateChanged: boolean;
}

const serveStateLabel: Record<ServeVerdict["state"], string> = { ok: "ok", bad: "bad", restarting: "restarting", backoff: "backoff", blocked: "blocked" };
const hbStateLabel: Record<HeartbeatVerdict["state"], string> = { ok: "ok", starting: "starting", backoff: "backoff" };

export function nextSupervisorState(prev: SupervisorState, serve: ServeVerdict, hb: HeartbeatVerdict, nowMs: number): SupervisorTransition {
  const state: SupervisorState = {
    lastStateLine: prev.lastStateLine,
    serveRestarts: pruneRestarts(prev.serveRestarts, nowMs),
    hbRestarts: pruneRestarts(prev.hbRestarts, nowMs),
    backoffUntil: prev.backoffUntil != null && nowMs < prev.backoffUntil ? prev.backoffUntil : null,
    hbBackoffUntil: prev.hbBackoffUntil != null && nowMs < prev.hbBackoffUntil ? prev.hbBackoffUntil : null,
    priorBadServe: serve.state === "ok" ? 0 : prev.priorBadServe + 1,
  };
  if (serve.action === "restart") {
    if (shouldBackOff(state.serveRestarts, nowMs)) {
      state.backoffUntil = nowMs + SUPERVISOR_BACKOFF_MS;
    } else {
      state.serveRestarts = [...state.serveRestarts, nowMs];
    }
  }
  if (hb.action === "restart") {
    if (shouldBackOff(state.hbRestarts, nowMs)) {
      state.hbBackoffUntil = nowMs + SUPERVISOR_BACKOFF_MS;
    } else {
      state.hbRestarts = [...state.hbRestarts, nowMs];
    }
  }
  const stateLine = `serve=${serveStateLabel[serve.state]},heartbeat=${hbStateLabel[hb.state]}`;
  const stateChanged = stateLine !== prev.lastStateLine;
  state.lastStateLine = stateLine;
  return { state, stateLine, stateChanged };
}

// ---------------------------------------------------------------------------
// VERDICT ENVELOPE (what the CLI prints; bash switches on the actions)
// ---------------------------------------------------------------------------

export interface SupervisorVerdict {
  serve: ServeVerdict;
  hb: HeartbeatVerdict;
  stateLine: string;
  stateChanged: boolean;
  state: SupervisorState;
  backoffActive: boolean;
  hbBackoffActive: boolean;
}

export function decideSupervisorCycle(input: { facts: ServeFacts & HeartbeatFacts; stateRaw: string | null; nowMs: number }): SupervisorVerdict {
  const state = parseSupervisorState(input.stateRaw);
  const backoffActive = state.backoffUntil != null && input.nowMs < state.backoffUntil;
  const hbBackoffActive = state.hbBackoffUntil != null && input.nowMs < state.hbBackoffUntil;
  const serve = classifyServe(input.facts, state.priorBadServe, backoffActive);
  const hb = classifyHeartbeat({ procs: input.facts.procs }, hbBackoffActive);
  const t = nextSupervisorState(state, serve, hb, input.nowMs);
  return {
    serve,
    hb,
    stateLine: t.stateLine,
    stateChanged: t.stateChanged,
    state: t.state,
    backoffActive,
    hbBackoffActive,
  };
}

/** CLI helper — reads a file best-effort (state file may not exist yet). */
export function readStateFile(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
