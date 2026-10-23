/**
 * Store selection: probe Postgres once per process; fall back to the
 * in-memory demo store when DATABASE_URL is missing or unreachable, so the
 * dashboard always renders. The probe retries periodically so a fixed
 * DATABASE_URL (or restored DB) activates Postgres mode without a deploy.
 *
 * ONE POOL PER PROCESS (pool hardening 2026-10-06): `cached` is the module
 * singleton, but two holes used to create EXTRA pools in the same process:
 *   - vite dev HMR re-executes this module → a fresh module closure → a fresh
 *     PgStore (pool) while the previous generation's pool lingers until its
 *     conns idle out — several generations × up to `max` warm conns each;
 *   - concurrent getStore() calls while no cache existed each ran their own
 *     probe → the loser's pool was orphaned at up to `max` conns.
 * Both are closed here: a globalThis registry (survives module re-execution)
 * keeps ONE PgStore per DATABASE_URL per process, and the probe is
 * in-flight-deduped so parallel callers share one probe. Failed probes close
 * their constructed pool so a rejected probe can never leak connections.
 */
import { PgStore } from "./pg";
import { MemoryStore } from "./memory";
import type { Store } from "./types";
import { getSecret } from "../env";

export type DbStatus =
  | { mode: "postgres"; ok: true }
  | { mode: "memory"; ok: false; reason: string };

let cached: { store: Store; probedAt: number } | null = null;
let inFlight: Promise<Store> | null = null;
let lastError: string | null = null;
const PROBE_TTL_MS = 60_000;

/**
 * BOOT PROBE BACKSTOP (reliability 2b/3, forensics §3 scenario ③): the probe
 * chain had NO timeout — a hung ensureSchema wedged every concurrent
 * getStore() caller forever (the in-flight dedup shares the one hung promise),
 * so the process never fell back to memory and every page just hung (the
 * 10/20-21 boot wedges). The PgStore per-statement cap
 * (DEFAULT_SCHEMA_STMT_TIMEOUT_MS) already bounds ONE hung statement; this
 * backstop bounds the WHOLE probe so getStore can never hang even when that
 * cap is disabled, and the fallback to the memory store is HONEST: lastError
 * names the timeout and getDbStatus surfaces it in the sync banner. Default
 * 300s — 4×+ the healthy fresh-DB sweep (~65s), so the healthy path is
 * byte-identical. 0/negative disables the backstop.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 300_000;

/** Honest, name-set error when the whole-probe backstop fires. */
export class ProbeTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    const rendered = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
    super(`schema probe timeout after ${rendered} — boot DDL did not settle (hung DDL/lock/stall); falling back to in-memory store`);
    this.name = "ProbeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Knobs for probePg/getStore — optional, so every existing caller is unchanged. */
export interface ProbeOptions {
  /** Whole-probe cap in ms (default DEFAULT_PROBE_TIMEOUT_MS; 0 disables). */
  probeTimeoutMs?: number;
  /**
   * TEST SEAM (forensics §3 "missing seam"): build the PgStore yourself —
   * inject a stubbed/hung sql via PgStore's sql option so the probe path is
   * testable with no real connection.
   */
  storeFactory?: (url: string) => PgStore;
}

/** Race the probe against the whole-probe backstop (same pattern as fetch-timeout.ts). */
function raceProbe(p: Promise<void>, timeoutMs: number): Promise<void> {
  if (!(timeoutMs > 0)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Timer is cleared in the RACE's finally — a synchronous finally here would
  // clear it before it ever fires (the probe backstop would never fire).
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<void>;
}

/**
 * Process-wide PgStore registry, keyed by DATABASE_URL. Lives on globalThis
 * (NOT the module closure) so it survives vite-dev HMR module re-execution —
 * the second module generation reuses the first generation's pool instead of
 * opening a second one. Never logs or serializes the key (it is a secret URL).
 */
const REGISTRY_KEY = "__malloryPgStores";
function pgRegistry(): Map<string, PgStore> {
  const g = globalThis as unknown as Record<string, Map<string, PgStore> | undefined>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY];
}

/** Probe Postgres once; exported for the boot-seed-wedge regression tests (the seam). */
export async function probePg(opts?: ProbeOptions): Promise<Store | null> {
  // Resolved via the centralized secret resolver: canonical ALL-CAPS name
  // first, case-insensitive fallback second — so a secret saved as
  // "Database_URL" still activates Postgres mode.
  const url = getSecret("DATABASE_URL");
  if (!url) {
    lastError = "DATABASE_URL is not set";
    return null;
  }
  // Reject obviously incomplete URLs (e.g. missing password) fast.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    lastError = "DATABASE_URL is not a valid postgres:// URL";
    return null;
  }
  if (!parsed.password) {
    lastError = "DATABASE_URL has no password (check the saved secret)";
    return null;
  }
  const existing = pgRegistry().get(url);
  if (existing) return existing; // one pool per process per URL — reuse it
  const pg = (opts?.storeFactory ?? ((u: string) => new PgStore(u)))(url);
  try {
    // BACKSTOP: bound the WHOLE probe. The PgStore per-statement cap already
    // bounds one hung statement; this bounds the sweep so a disabled cap (or
    // any other hang) can never wedge getStore — it falls back to memory
    // instead, honestly (lastError names the failure).
    await raceProbe(pg.ensureSchema(), opts?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    pgRegistry().set(url, pg);
    return pg;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    // HONEST DEGRADATION (forensics §3 scenario ③): the fallback must be
    // visible, never silent — one line to the boot log naming the failure;
    // the banner reads the same reason via getDbStatus.
    console.warn(`[store] postgres probe failed — serving from in-memory store: ${lastError}`);
    // Abandoned-probe pool: close it. A probe that connected but failed DDL
    // (or timed out on it) must not hold connections until process exit —
    // that accumulation was part of the transient-500 pool leak.
    try {
      await pg.close();
    } catch {
      // close is best-effort; the pool is unreachable either way
    }
    return null;
  }
}

/** Get the best available store, caching the probe for 60s. In-flight probes are shared. */
export async function getStore(opts?: ProbeOptions): Promise<Store> {
  if (cached && Date.now() - cached.probedAt < PROBE_TTL_MS) return cached.store;
  if (cached && cached.store.mode === "postgres") return cached.store; // sticky once healthy
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const pg = await probePg(opts);
      if (pg) {
        cached = { store: pg, probedAt: Date.now() };
        lastError = null;
        return pg;
      }
      if (!cached) cached = { store: new MemoryStore(), probedAt: Date.now() };
      cached.probedAt = Date.now();
      return cached.store;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function getDbStatus(): DbStatus {
  if (cached?.store.mode === "postgres") return { mode: "postgres", ok: true };
  return { mode: "memory", ok: false, reason: lastError ?? "database unreachable" };
}

/**
 * TEST SEAM (boot-seed-wedge regression): reset the module-level probe cache
 * so a test observes THIS test's probe, not a store cached by an earlier test
 * file (bun test shares one process; getStore's sticky rule would otherwise
 * hide the fallback path). Not for production use.
 */
export function __resetStoreProbeStateForTests(): void {
  cached = null;
  inFlight = null;
  lastError = null;
}

/** Force a re-probe (used by SYNC NOW). */
export async function reprobe(): Promise<Store> {
  if (cached?.store.mode === "postgres") return cached.store;
  cached = null;
  return getStore();
}

export type { Store } from "./types";
