/**
 * Store selection: probe Postgres once per process; fall back to the
 * in-memory demo store when DATABASE_URL is missing or unreachable, so the
 * dashboard always renders. The probe retries periodically so a fixed
 * DATABASE_URL (or restored DB) activates Postgres mode without a deploy.
 */
import { PgStore } from "./pg";
import { MemoryStore } from "./memory";
import type { Store } from "./types";
import { getSecret } from "../env";

export type DbStatus =
  | { mode: "postgres"; ok: true }
  | { mode: "memory"; ok: false; reason: string };

let cached: { store: Store; probedAt: number } | null = null;
let lastError: string | null = null;
const PROBE_TTL_MS = 60_000;

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
  const pg = new PgStore(url);
  try {
    await pg.ensureSchema();
    return pg;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/** Get the best available store, caching the probe for 60s. */
export async function getStore(): Promise<Store> {
  if (cached && Date.now() - cached.probedAt < PROBE_TTL_MS) return cached.store;
  if (cached && cached.store.mode === "postgres") return cached.store; // sticky once healthy
  const pg = await probePg();
  if (pg) {
    cached = { store: pg, probedAt: Date.now() };
    lastError = null;
    return pg;
  }
  if (!cached) cached = { store: new MemoryStore(), probedAt: Date.now() };
  cached.probedAt = Date.now();
  return cached.store;
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
