/**
 * Short-TTL in-process read cache for PgStore (PERF pass).
 *
 * WHY: every page load issues 15–30 queries against a REMOTE Postgres; each
 * query pays a ~60ms network round trip (plus payload transfer). The dashboard
 * is read-heavy and write-light (source syncs every ~10 min, occasional manual
 * corrections), so a 20-second TTL cache turns repeat page loads into
 * near-zero DB work without changing any query's semantics, filters, or
 * computed values.
 *
 * CORRECTNESS CONTRACT:
 *  - ANY store write calls bump() FIRST (each mutator's opening line), which
 *    invalidates every cached read. After a manual override, a settings save,
 *    or a sync/attribution tick completes, the next read always re-queries —
 *    cached aggregates can never serve pre-write values after the write
 *    completes.
 *  - TTL is 20s (within the owner-approved ≤30s staleness envelope for a
 *    10-min sync cadence dashboard).
 *  - NEVER cached (kept live by construction — the store simply does not wrap
 *    them): integration_connections (freshness/sync banners), running sync
 *    runs, audit rows, full contact materialization (sync-internal).
 *  - Values are cloned on store AND on hit (structuredClone) so no caller can
 *    mutate a cached array in place and poison later readers.
 *  - Keys are per method + JSON args; the map is size-capped (bulk-cleared) to
 *    bound memory.
 */
export const READ_CACHE_TTL_MS = 20_000;
const MAX_ENTRIES = 64;

interface Entry {
  gen: number;
  at: number;
  value: unknown;
}

export class TtlReadCache {
  private gen = 0;
  private map = new Map<string, Entry>();

  /** Invalidate every cached read. Called by every PgStore mutator. */
  bump(): void {
    this.gen++;
    this.map.clear();
  }

  get generation(): number {
    return this.gen;
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Serve `key` from cache when it was stored in the CURRENT generation and is
   * younger than the TTL; otherwise run `fn`, cache a clone, and hand the
   * first caller its OWN clone. EVERY value leaving wrap (hit or miss) is a
   * caller-owned copy — no caller can mutate a cached value, the underlying
   * read result, or another caller's copy.
   */
  async wrap<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit && hit.gen === this.gen && Date.now() - hit.at < READ_CACHE_TTL_MS) {
      return structuredClone(hit.value) as T;
    }
    const value = await fn();
    const stored = structuredClone(value);
    if (this.map.size >= MAX_ENTRIES) this.map.clear();
    this.map.set(key, { gen: this.gen, at: Date.now(), value: stored });
    return structuredClone(stored) as T;
  }
}
