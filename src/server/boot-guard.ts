/**
 * SECOND-INSTANCE BOOT GUARD (outage hardening, 2026-10-09)
 *
 * The Oct-8 outage chain: repeated `bun run start` restarts STACKED server
 * processes — each opens a DB pool (then max 12 warm connections) plus the
 * in-process sync scheduler — and pg_stat_activity showed ~37 connections
 * (~2.5 processes × 12 warm conns; vite-dev SSR + prod servers). New boots
 * then hung minutes in the ensureSchema DDL sweep, publish.sh's 10-second
 * health window expired, and the wedged old runtime stayed live serving 500s.
 *
 * This module gives serve.ts three pieces, all DB-free and dependency-free:
 *
 *   1. PORT PRE-CHECK  — listenerPidsOnPort() finds whoever already listens
 *      on :3000 (sudo lsof, same cross-user pattern serve.ts already uses).
 *   2. CLASSIFIER      — classifyExistingListener() decides whether this boot
 *      should EXIT CLEANLY (a healthy server already owns the port, or a
 *      boot is still inside its grace window) or TAKE OVER (publish supersedes
 *      the old build via SERVE_SUPERSEDE=1; a long-wedged listener is replaced
 *      by a manual restart). Exiting BEFORE bind means the duplicate never
 *      opens a pool and never starts a scheduler — stacking is structurally
 *      impossible for plain `bun run start` runs.
 *   3. LOCKFILE        — .run/server.lock (gitignored) records the pid/port/
 *      boot time of the server that won the bind; the duplicate-exit message
 *      reports it so an operator can see who owns the port.
 *
 * Decision rules (documented for the outage post-mortem):
 *   - SERVE_SUPERSEDE=1 (publish.sh) → ALWAYS takeover: a deploy must replace
 *     the serving build even when it is perfectly healthy.
 *   - Probe of GET / answers 2xx/3xx/401 (the same "server is up" set
 *     publish.sh accepts) → exit-duplicate. A healthy server is already
 *     serving; a second pool would only saturate the DB.
 *   - No healthy answer BUT the listener process is young (< BOOT_GRACE_
 *     SECONDS) → exit-duplicate. A boot inside its grace window may still be
 *     working through ensureSchema (65s measured on a healthy DB; minutes
 *     when the DB is degraded) — killing it would restart-storm the boot,
 *     which is exactly how the outage escalated.
 *   - No healthy answer and the listener is OLD (or its age is unknowable)
 *     → takeover: a long-wedged runtime is what a manual restart exists to
 *     replace. The existing free-port + retry bind loop in serve.ts handles
 *     the eviction.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A boot younger than this is treated as "still starting" — never killed by a duplicate start. */
export const BOOT_GRACE_SECONDS = 180;

/** HTTP statuses that prove a server process is up and serving (mirrors publish.sh). */
export function isHealthyBootStatus(status: number | null): boolean {
  if (status == null) return false;
  return (status >= 200 && status < 400) || status === 401;
}

export type BootVerdict = "exit-duplicate" | "takeover";

/**
 * Pure decision for the case where a listener ALREADY exists on the port.
 * (No listener → the caller just binds; not modeled here.)
 */
export function classifyExistingListener(input: {
  probeStatus: number | null;
  listenerAgeSeconds: number | null;
  supersede: boolean;
  bootGraceSeconds?: number;
}): BootVerdict {
  if (input.supersede) return "takeover";
  if (isHealthyBootStatus(input.probeStatus)) return "exit-duplicate";
  // Unhealthy or unanswerable: a listener inside its boot grace is presumed
  // to be finishing schema bootstrap — never kill a boot in progress.
  const grace = input.bootGraceSeconds ?? BOOT_GRACE_SECONDS;
  if (input.listenerAgeSeconds != null && input.listenerAgeSeconds < grace) {
    return "exit-duplicate";
  }
  // Old and unhealthy → wedged (replace it); age unknowable → treat as old
  // (the probe already failed to get an answer; failing open here would leave
  // a wedged runtime un-restartable by hand).
  return "takeover";
}

/** GET the URL once; resolve the HTTP status, or null when it never answered. */
export async function probeHttp(url: string, timeoutMs: number, fetchImpl?: typeof fetch): Promise<number | null> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    // Drain/cancel the body so the socket is released immediately.
    try {
      await res.arrayBuffer();
    } catch {
      // body read failure does not change the verdict — the status already arrived
    }
    return res.status;
  } catch {
    return null;
  }
}

/**
 * PIDs of processes LISTENING on the port — sudo so cross-user listeners
 * (the published server runs as another sandbox user) are visible, exactly
 * like serve.ts's port-freeing loop. Empty on any lsof failure: the guard
 * fails OPEN (the existing EADDRINUSE retry bind loop remains the backstop).
 */
export async function listenerPidsOnPort(port: number): Promise<number[]> {
  for (const useSudo of [true, false]) {
    try {
      const proc = useSudo
        ? Bun.$`sudo sh -c ${`lsof -t -iTCP:${String(port)} -sTCP:LISTEN 2>/dev/null`}`.quiet().nothrow()
        : Bun.$`lsof -t -iTCP:${String(port)} -sTCP:LISTEN 2>/dev/null`.quiet().nothrow();
      const out = await proc;
      if (out.exitCode === 0) {
        const pids = out.stdout
          .toString()
          .split(/\s+/)
          .map((s) => Number(s))
          .filter((n) => Number.isInteger(n) && n > 0);
        if (pids.length > 0) return [...new Set(pids)];
        // lsof answered but saw nothing → genuinely no listener
        if (useSudo) return [];
      }
    } catch {
      // fall through to the next attempt
    }
  }
  return [];
}

/** Seconds the listener process has been alive (ps etimes), or null if unknowable. */
export async function listenerAgeSeconds(pid: number): Promise<number | null> {
  try {
    const out = await Bun.$`ps -o etimes= -p ${String(pid)}`.quiet().nothrow();
    if (out.exitCode !== 0) return null;
    const n = Number(out.stdout.toString().trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

// ---------- lockfile (.run/server.lock — gitignored) ----------

export interface ServerLockInfo {
  pid: number;
  port: number;
  started_at: string;
}

/** Write the lock atomically (tmp file + rename). Best-effort: a lock write failure never blocks serving. */
export async function writeServerLockfile(lockPath: string, info: ServerLockInfo): Promise<void> {
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    const tmp = `${lockPath}.tmp.${String(process.pid)}`;
    await writeFile(tmp, `${JSON.stringify(info)}\n`);
    await rename(tmp, lockPath);
  } catch {
    // observability only — never block the boot on a lockfile error
  }
}

/** Tolerant read: missing or corrupt lock → null (the port pre-check is the real guard). */
export function readServerLockfile(lockPath: string): ServerLockInfo | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ServerLockInfo>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.port === "number" &&
      Number.isInteger(parsed.port) &&
      typeof parsed.started_at === "string"
    ) {
      return { pid: parsed.pid, port: parsed.port, started_at: parsed.started_at };
    }
    return null;
  } catch {
    return null;
  }
}
