/**
 * STATUS / HEALTH PAGE DATA (reliability item: the in-app Status view).
 *
 * ONE read-only page that surfaces the reliability stack's EXISTING signals in
 * one place — it reads them, it never rebuilds or re-classifies them:
 *
 *   • /health payload          — the SAME buildHealthPayload() serve.ts answers
 *                                with (providers, heartbeat, version/commit).
 *                                Rendering it in-app is definitionally the
 *                                /health payload, never a fork of it.
 *   • Provider sync freshness  — already inside the payload (5 tracked
 *                                providers, last success / age / status).
 *   • Banner warnings          — the same syncStaleWarnings + heartbeat clause
 *                                every other page's banner shows.
 *   • Running guard            — store.getRunningSyncRuns(): every in-flight
 *                                sync_runs row; rows older than the reaper's
 *                                STALE_RUN_REAP_MINUTES bound are flagged
 *                                "beyond reap bound" (the reaper's own rule —
 *                                a hung run, not a live one).
 *   • Ingest wedge bounds      — the two shipped constants (reap bound, ingest
 *                                deadline) surfaced as configuration, plus
 *                                recent sync_runs rows where a reap/deadline
 *                                error would honestly appear.
 *   • Supervisor               — ops/supervisor.sh's persisted state file
 *                                (.run/supervisor-state.json) read through the
 *                                SAME readStateFile + parseSupervisorState the
 *                                supervisor CLI uses; missing file = honest
 *                                "—" (no state yet), never a guess.
 *   • Server lock (boot guard) — .run/server.lock via readServerLockfile.
 *
 * ADDITIVE by construction: no sync internals, matching engine, or date logic
 * is touched; every read is best-effort and each failure lands in an honest
 * error field for its own section (one dead signal never blanks the page).
 *
 * Path contract (the heartbeat-freshness bar — no boot-frozen snapshots):
 * supervisor/lock paths are read PER CALL; under `bun test` the defaults
 * resolve to nonexistent paths so page tests stay deterministic regardless of
 * the real .run/ state; tests pass explicit fixture paths.
 */
import { join } from "node:path";
import { buildHealthPayload, type HealthPayload } from "./health";
import { withHeartbeatWarning, type HeartbeatFreshness } from "./heartbeat-freshness";
import { parseSupervisorState, readStateFile, type SupervisorState } from "./supervisor-decisions";
import { readServerLockfile, type ServerLockInfo } from "./boot-guard";
import { syncStaleWarnings } from "./queries";
import { getStore, type Store } from "./store";
import { STALE_RUN_REAP_MINUTES, type SyncRunRow } from "./store/types";
import { INGEST_RUN_DEADLINE_MS } from "./store/ingest-batch";

// ---------------------------------------------------------------------------
// View shapes (plain serializable — the route renders them directly)
// ---------------------------------------------------------------------------

/** One in-flight sync_runs row with the reaper's own bound applied as a flag. */
export interface RunningRunView {
  id: string;
  provider: string;
  startedAt: string;
  /** Minutes since started_at — null when the timestamp is unparsable (honest). */
  ageMinutes: number | null;
  /** True when age exceeds STALE_RUN_REAP_MINUTES — the reaper's own "hung, not live" rule. */
  beyondReapBound: boolean;
}

/** One recent sync_runs row for the wedge-evidence list. */
export interface RecentRunView {
  id: string;
  provider: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  /** finished − started in minutes; null when unfinished or unparsable (honest). */
  durationMinutes: number | null;
  recordsUpserted: number;
  error: string | null;
}

/** ops/supervisor.sh's persisted state — absent file = honest unavailable. */
export interface SupervisorView {
  /** True when the state file existed (even if it parsed to empty defaults). */
  available: boolean;
  /** The quiet state line, e.g. "serve=ok,heartbeat=ok" — null when absent. */
  stateLine: string | null;
  /** Serve restarts recorded inside the supervisor's 5-min window (null when no state). */
  serveRestartsInWindow: number | null;
  /** Heartbeat starts recorded inside the window (null when no state). */
  hbRestartsInWindow: number | null;
  /** A serve-restart backoff is active right now (null when no state). */
  serveBackoffActive: boolean | null;
  /** A heartbeat-start backoff is active right now (null when no state). */
  hbBackoffActive: boolean | null;
}

/** The serving process's lock file (.run/server.lock) — the boot guard's record. */
export interface ServerLockView {
  available: boolean;
  pid: number | null;
  port: number | null;
  startedAt: string | null;
  /** Minutes since the lock's boot time — null when unparsable (honest). */
  ageMinutes: number | null;
}

export interface StatusHealthPageData {
  /** THE /health payload — the exact object serve.ts answers with. */
  health: HealthPayload;
  /** Same freshness object as health.heartbeat (render convenience). */
  heartbeat: HeartbeatFreshness;
  /** The same warning clauses every page's banner shows (sync + heartbeat). */
  warnings: string[];
  /** Connection-read failure lands here — never a silent empty list. */
  warningsError: string | null;
  runningRuns: RunningRunView[] | null;
  runningError: string | null;
  recentRuns: RecentRunView[] | null;
  recentError: string | null;
  supervisor: SupervisorView;
  supervisorError: string | null;
  serverLock: ServerLockView;
  /** Surfaced configuration — the shipped reliability constants, verbatim. */
  reapBoundMinutes: number;
  ingestDeadlineMinutes: number;
  /** The recent-runs window actually requested. */
  recentLimit: number;
}

// ---------------------------------------------------------------------------
// Defaults (per-call reads; `bun test` gets nonexistent paths — deterministic)
// ---------------------------------------------------------------------------

/** Default supervisor state path; `bun test` gets a nonexistent path. */
export function defaultSupervisorStatePath(): string {
  if (process.env.SUPERVISOR_STATE_PATH) return process.env.SUPERVISOR_STATE_PATH;
  if (process.env.NODE_ENV === "test") return "/nonexistent/supervisor-state.json";
  return join(process.cwd(), ".run", "supervisor-state.json");
}

/** Default server lock path; `bun test` gets a nonexistent path. */
export function defaultServerLockPath(): string {
  if (process.env.SERVER_LOCK_PATH) return process.env.SERVER_LOCK_PATH;
  if (process.env.NODE_ENV === "test") return "/nonexistent/server.lock";
  return join(process.cwd(), ".run", "server.lock");
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-pinned; defined in the dependency-free status-format.ts —
// the route's component imports them from THERE, because importing this
// module from the client would drag the store graph into the browser bundle)
// ---------------------------------------------------------------------------

export { formatAgeMinutes, minutesSince } from "./status-format";
import { minutesSince } from "./status-format";

export const emptySupervisorView = (): SupervisorView => ({
  available: false,
  stateLine: null,
  serveRestartsInWindow: null,
  hbRestartsInWindow: null,
  serveBackoffActive: null,
  hbBackoffActive: null,
});

export const emptyServerLockView = (): ServerLockView => ({
  available: false,
  pid: null,
  port: null,
  startedAt: null,
  ageMinutes: null,
});

/** Read + classify the supervisor state file (pure over its inputs). */
export function readSupervisorView(statePath: string, nowMs: number, windowMs: number): { view: SupervisorView; error: string | null } {
  try {
    const raw = readStateFile(statePath);
    if (raw == null) return { view: emptySupervisorView(), error: null };
    const state: SupervisorState = parseSupervisorState(raw);
    return {
      view: {
        available: true,
        stateLine: state.lastStateLine,
        serveRestartsInWindow: state.serveRestarts.filter((t) => t <= nowMs && nowMs - t < windowMs).length,
        hbRestartsInWindow: state.hbRestarts.filter((t) => t <= nowMs && nowMs - t < windowMs).length,
        serveBackoffActive: state.backoffUntil != null && nowMs < state.backoffUntil,
        hbBackoffActive: state.hbBackoffUntil != null && nowMs < state.hbBackoffUntil,
      },
      error: null,
    };
  } catch (e) {
    return { view: emptySupervisorView(), error: e instanceof Error ? e.message : String(e) };
  }
}

/** Read + classify the server lock file (pure over its inputs). */
export function readServerLockView(lockPath: string, nowMs: number): { view: ServerLockView; error: string | null } {
  try {
    const lock: ServerLockInfo | null = readServerLockfile(lockPath);
    if (lock == null) return { view: emptyServerLockView(), error: null };
    return {
      view: {
        available: true,
        pid: lock.pid,
        port: lock.port,
        startedAt: lock.started_at,
        ageMinutes: minutesSince(lock.started_at, nowMs),
      },
      error: null,
    };
  } catch (e) {
    return { view: emptyServerLockView(), error: e instanceof Error ? e.message : String(e) };
  }
}

function toRunningRunView(row: SyncRunRow, nowMs: number): RunningRunView {
  const ageMinutes = minutesSince(row.started_at, nowMs);
  return {
    id: row.id,
    provider: row.provider,
    startedAt: row.started_at,
    ageMinutes,
    beyondReapBound: ageMinutes != null && ageMinutes > STALE_RUN_REAP_MINUTES,
  };
}

function toRecentRunView(row: SyncRunRow): RecentRunView {
  let durationMinutes: number | null = null;
  if (row.finished_at) {
    const s = Date.parse(row.started_at);
    const f = Date.parse(row.finished_at);
    if (Number.isFinite(s) && Number.isFinite(f)) durationMinutes = Math.max(0, Math.round(((f - s) / 60_000) * 10) / 10);
  }
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMinutes,
    recordsUpserted: row.records_upserted,
    error: row.error,
  };
}

// ---------------------------------------------------------------------------
// THE page-data function (read-only; every section fails honestly on its own)
// ---------------------------------------------------------------------------

export async function statusHealthPageData(deps?: {
  store?: Store;
  now?: () => Date;
  /** Injected heartbeat freshness (tests) — forwarded to buildHealthPayload. */
  heartbeat?: HeartbeatFreshness;
  /** Override the heartbeat log path (tests) — forwarded to buildHealthPayload. */
  heartbeatLogPath?: string;
  supervisorStatePath?: string;
  serverLockPath?: string;
  /** How many recent sync_runs rows to list (default 12, newest first). */
  recentLimit?: number;
}): Promise<StatusHealthPageData> {
  const now = deps?.now ?? (() => new Date());
  const nowMs = now().getTime();
  const recentLimit = deps?.recentLimit ?? 12;
  const windowMs = 5 * 60_000; // the supervisor's own restart window (SUPERVISOR_RESTART_WINDOW_MS)

  const health = await buildHealthPayload({
    ...(deps?.store ? { store: deps.store } : {}),
    now,
    ...(deps?.heartbeat ? { heartbeat: deps.heartbeat } : {}),
    ...(deps?.heartbeatLogPath ? { heartbeatLogPath: deps.heartbeatLogPath } : {}),
  });

  // Banner warnings — the exact clauses every other page shows. The heartbeat
  // clause reuses the payload's freshness object (no second log read).
  let warnings: string[] = [];
  let warningsError: string | null = null;
  try {
    const store = deps?.store ?? (await getStore());
    const connWarnings = syncStaleWarnings(await store.getConnections());
    warnings = await withHeartbeatWarning([...connWarnings], { heartbeat: health.heartbeat, now: now() });
  } catch (e) {
    warningsError = `could not read sync connections: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Running guard — every in-flight row, any age; the reaper's bound flags hung ones.
  let runningRuns: RunningRunView[] | null = null;
  let runningError: string | null = null;
  try {
    const store = deps?.store ?? (await getStore());
    runningRuns = (await store.getRunningSyncRuns()).map((r) => toRunningRunView(r, nowMs));
  } catch (e) {
    runningError = `could not read running sync runs: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Recent runs — the wedge evidence window (reaps/deadline errors appear here).
  let recentRuns: RecentRunView[] | null = null;
  let recentError: string | null = null;
  try {
    const store = deps?.store ?? (await getStore());
    recentRuns = (await store.getSyncRuns(recentLimit)).map(toRecentRunView);
  } catch (e) {
    recentError = `could not read recent sync runs: ${e instanceof Error ? e.message : String(e)}`;
  }

  const sup = readSupervisorView(deps?.supervisorStatePath ?? defaultSupervisorStatePath(), nowMs, windowMs);
  const lock = readServerLockView(deps?.serverLockPath ?? defaultServerLockPath(), nowMs);

  return {
    health,
    heartbeat: health.heartbeat,
    warnings,
    warningsError,
    runningRuns,
    runningError,
    recentRuns,
    recentError,
    supervisor: sup.view,
    supervisorError: sup.error,
    serverLock: lock.view,
    reapBoundMinutes: STALE_RUN_REAP_MINUTES,
    ingestDeadlineMinutes: INGEST_RUN_DEADLINE_MS / 60_000,
    recentLimit,
  };
}
