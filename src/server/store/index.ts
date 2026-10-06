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

async function probePg(): Promise<Store | null> {
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
  const pg = new PgStore(url);
  try {
    await pg.ensureSchema();
    pgRegistry().set(url, pg);
    return pg;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    // Abandoned-probe pool: close it. A probe that connected but failed DDL
    // (e.g. during a slot-exhaustion window) must not hold connections until
    // process exit — that accumulation was part of the transient-500 pool leak.
    try {
      await pg.close();
    } catch {
      // close is best-effort; the pool is unreachable either way
    }
    return null;
  }
}

/** Get the best available store, caching the probe for 60s. In-flight probes are shared. */
export async function getStore(): Promise<Store> {
  if (cached && Date.now() - cached.probedAt < PROBE_TTL_MS) return cached.store;
  if (cached && cached.store.mode === "postgres") return cached.store; // sticky once healthy
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const pg = await probePg();
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

/** Force a re-probe (used by SYNC NOW). */
export async function reprobe(): Promise<Store> {
  if (cached?.store.mode === "postgres") return cached.store;
  cached = null;
  return getStore();
}

export type { Store } from "./types";
