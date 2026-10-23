/**
 * SYNC-HEARTBEAT LIVENESS (Reliability 2b/3, owner directive: /health + the
 * in-app banner are the ONLY outage surfaces — no push, no email).
 *
 * The 24/7 sync heartbeat (~/heartbeat/sync-heartbeat.sh, 240s tick) is what
 * drives every background sync — if it dies, providers go stale within
 * minutes. Its one observed failure mode (2026-10-22 23:55) was silent: the
 * nohup wrapper died with its parent terminal session and nothing noticed
 * until a human looked. This module classifies heartbeat liveness from the
 * newest "TICK:" line in its log — the same evidence an operator reads — and
 * NEVER throws: a missing or unreadable log is the honest "unknown", never a
 * guess.
 *
 * Statuses:
 *   ok      — newest TICK is inside the threshold (3 × interval = 12 min)
 *   stale   — newest TICK is older than the threshold (heartbeat stuck/slow)
 *   dead    — log readable but holds NO TICK line at all (never ticked, or
 *             every tick failed — the "tick produced no summary" case)
 *   unknown — log missing/unreadable, or a TICK line whose timestamp cannot
 *             be parsed: no evidence, so no claim (and no banner cry-wolf)
 *
 * Path contract (the sheets-adapter bar — no boot-frozen snapshots):
 * HEARTBEAT_LOG_PATH is read PER CALL. Under `bun test` the default resolves
 * to a nonexistent path so page/health tests stay deterministic regardless of
 * the real heartbeat's mood; tests that exercise this module pass explicit
 * fixture paths.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

/** The heartbeat's tick cadence (seconds) — keep in sync with sync-heartbeat.sh. */
export const HEARTBEAT_INTERVAL_SECONDS = 240;
/** 3 × interval — the same 3× rule every /health provider freshness uses. */
export const HEARTBEAT_STALE_AFTER_MINUTES = (HEARTBEAT_INTERVAL_SECONDS * 3) / 60;

export interface HeartbeatFreshness {
  /** Newest TICK timestamp, ISO — null when no parseable TICK exists. */
  lastTickAt: string | null;
  /** Minutes since the newest TICK — null when undatable. */
  ageMinutes: number | null;
  status: "ok" | "stale" | "dead" | "unknown";
  intervalMinutes: number;
  staleAfterMinutes: number;
}

/** Default log path; `bun test` gets a nonexistent path (see module doc). */
export function defaultHeartbeatLogPath(): string {
  if (process.env.HEARTBEAT_LOG_PATH) return process.env.HEARTBEAT_LOG_PATH;
  if (process.env.NODE_ENV === "test") return "/nonexistent/heartbeat.log";
  return `${homedir()}/heartbeat/heartbeat.log`;
}

/**
 * Pure: the NEWEST log line carrying a "TICK:" marker (the tick summary), or
 * null when the log holds none. "TICK ERROR" lines do not match (the colon is
 * required). Log lines look like "2026-10-23T00:33:13Z | TICK: {…}".
 */
export function latestTickLine(logText: string): string | null {
  const lines = logText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(" | TICK:")) return lines[i];
  }
  return null;
}

/** Pure: the ISO timestamp prefix of a TICK line, or null when undateable. */
export function parseTickTimestamp(line: string): Date | null {
  const marker = line.indexOf(" | TICK:");
  if (marker === -1) return null;
  const ts = new Date(line.slice(0, marker).trim());
  return Number.isNaN(ts.getTime()) ? null : ts;
}

/** Pure: the newest parseable TICK timestamp, or null (no tick / undateable). */
export function latestHeartbeatTick(logText: string): Date | null {
  const line = latestTickLine(logText);
  return line ? parseTickTimestamp(line) : null;
}

/** Pure: classify a tick age against the 3× interval threshold. */
export function classifyHeartbeatAge(ageMinutes: number | null, staleAfterMinutes: number = HEARTBEAT_STALE_AFTER_MINUTES): "ok" | "stale" | "dead" {
  if (ageMinutes == null) return "dead";
  return ageMinutes <= staleAfterMinutes ? "ok" : "stale";
}

function emptyFreshness(): HeartbeatFreshness {
  return {
    lastTickAt: null,
    ageMinutes: null,
    status: "unknown",
    intervalMinutes: HEARTBEAT_INTERVAL_SECONDS / 60,
    staleAfterMinutes: HEARTBEAT_STALE_AFTER_MINUTES,
  };
}

/**
 * Read the heartbeat log fresh and classify it. NEVER throws — every failure
 * (missing file, unreadable dir, garbage bytes) lands in the honest states.
 */
export async function readHeartbeatFreshness(opts?: { logPath?: string; now?: Date }): Promise<HeartbeatFreshness> {
  const now = opts?.now ?? new Date();
  const path = opts?.logPath ?? defaultHeartbeatLogPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return emptyFreshness(); // missing / unreadable → unknown, never a guess
  }
  const line = latestTickLine(text);
  if (!line) {
    // Readable log, no TICK marker at all: the heartbeat holds no sign of life.
    return { ...emptyFreshness(), status: "dead" };
  }
  const tick = parseTickTimestamp(line);
  if (!tick) {
    // A TICK exists but cannot be dated — evidence without a claim → unknown.
    return emptyFreshness();
  }
  const ageMinutes = Math.max(0, Math.round(((now.getTime() - tick.getTime()) / 60_000) * 10) / 10);
  return {
    lastTickAt: tick.toISOString(),
    ageMinutes,
    status: classifyHeartbeatAge(ageMinutes),
    intervalMinutes: HEARTBEAT_INTERVAL_SECONDS / 60,
    staleAfterMinutes: HEARTBEAT_STALE_AFTER_MINUTES,
  };
}

/**
 * Pure: the one banner clause for a heartbeat that needs attention, in the
 * shared quiet warning language (WarningList renders it with the existing
 * banner styling). "unknown" deliberately produces NO clause — no evidence,
 * no cry-wolf; /health still reports it.
 */
export function heartbeatBannerWarning(hb: HeartbeatFreshness): string | null {
  if (hb.status === "stale") {
    return `Sync heartbeat is stale — last tick ${hb.ageMinutes ?? "?"} min ago (fresh every ${hb.intervalMinutes} min); background syncs may have stopped.`;
  }
  if (hb.status === "dead") {
    return "Sync heartbeat has stopped — no tick in its log; background syncs may have stopped.";
  }
  return null;
}

/**
 * Append the heartbeat clause to a page's shared warning list (the
 * syncStaleWarnings flow every page feeds its banner from). Async only
 * because it reads the log fresh per call; never throws, never reorders
 * the existing warnings.
 */
export async function withHeartbeatWarning(warnings: string[], opts?: { logPath?: string; heartbeat?: HeartbeatFreshness; now?: Date }): Promise<string[]> {
  const hb = opts?.heartbeat ?? (await readHeartbeatFreshness(opts?.logPath ? { logPath: opts.logPath, now: opts.now } : { now: opts?.now }));
  const clause = heartbeatBannerWarning(hb);
  return clause ? [...warnings, clause] : warnings;
}
