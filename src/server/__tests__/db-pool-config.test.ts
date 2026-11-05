/**
 * SHARED DB CONNECTION BUDGET (db-pool-config.ts) — no live DB needed.
 *
 * 1. The config builder: default connect budget, env override, clamps, and
 *    the seconds conversion postgres.js's option speaks (the 2026-11-04
 *    incident: unbounded/hung connects wedged sync passes for the 30-minute
 *    stale-run reap window).
 * 2. GREP-PIN: every postgres() construction site in the repo (app pool +
 *    secondary script pools) imports the shared budget — no scattered
 *    connect_timeout/idle/statement literals can return.
 * 3. SEAM PIN: every sync pass-start (`await store.insertSyncRun(`) is
 *    immediately followed by the bounded warmup, so a new pass cannot
 *    reintroduce the wedge by skipping it.
 * 4. Retry classification of the exact incident error text — the same
 *    transient CONNECT_TIMEOUT class the driver's own connect timeouts get.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DB_CONNECT_TIMEOUT_MS,
  DB_CONNECT_TIMEOUT_MS_ENV,
  DB_CONNECT_TIMEOUT_MS_MIN,
  DB_CONNECT_TIMEOUT_MS_MAX,
  DB_STATEMENT_TIMEOUT_MS,
  DB_IDLE_TIMEOUT_SECONDS,
  DB_MAX_LIFETIME_SECONDS,
  dbConnectTimeoutMs,
  dbConnectTimeoutSeconds,
  dbConnectionBudget,
} from "../store/db-pool-config";
import { isTransientDbError, RETRY_ATTEMPTS } from "../store/pg-retry";

const ROOT = join(import.meta.dir, "../../..");

describe("db connection budget — the shared config builder", () => {
  test("default is the safe 10s without env", () => {
    expect(DEFAULT_DB_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(dbConnectTimeoutMs(undefined)).toBe(10_000);
    expect(dbConnectTimeoutMs("")).toBe(10_000);
    // garbage / zero / negative fall back to the default — never 0 (which in
    // postgres.js means "wait indefinitely", the exact wedge this closes)
    expect(dbConnectTimeoutMs("not-a-number")).toBe(10_000);
    expect(dbConnectTimeoutMs("0")).toBe(10_000);
    expect(dbConnectTimeoutMs("-4000")).toBe(10_000);
  });

  test("env DB_CONNECT_TIMEOUT_MS overrides (validated, rounded, clamped 1s–60s)", () => {
    expect(dbConnectTimeoutMs("4000")).toBe(4_000);
    expect(dbConnectTimeoutMs("30000")).toBe(30_000); // e.g. restore the old 30s patience
    // fractional ms rounds; sub-1s clamps UP to the floor; over-1min clamps DOWN
    expect(dbConnectTimeoutMs("1500.7")).toBe(1_501);
    expect(dbConnectTimeoutMs(String(DB_CONNECT_TIMEOUT_MS_MIN - 1))).toBe(DB_CONNECT_TIMEOUT_MS_MIN);
    expect(dbConnectTimeoutMs(String(DB_CONNECT_TIMEOUT_MS_MAX + 1))).toBe(DB_CONNECT_TIMEOUT_MS_MAX);
    expect(DB_CONNECT_TIMEOUT_MS_MIN).toBe(1_000);
    expect(DB_CONNECT_TIMEOUT_MS_MAX).toBe(60_000);
  });

  test("seconds conversion — postgres.js speaks seconds; never 0", () => {
    expect(dbConnectTimeoutSeconds("10000")).toBe(10);
    expect(dbConnectTimeoutSeconds("1500")).toBe(2); // ceil — 1s would under-bound
    expect(dbConnectTimeoutSeconds("1000")).toBe(1);
    expect(dbConnectTimeoutSeconds(undefined)).toBe(10);
    expect(dbConnectTimeoutSeconds("garbage")).toBe(10);
  });

  test("the shared statement/idle/lifetime bounds (pool config carries the full budget)", () => {
    expect(DB_STATEMENT_TIMEOUT_MS).toBe(300_000); // the 2026-10-12 server-side cap, now shared
    expect(DB_IDLE_TIMEOUT_SECONDS).toBe(60);
    expect(DB_MAX_LIFETIME_SECONDS).toBe(1800);
    expect(dbConnectionBudget()).toEqual({
      connect_timeout: 10,
      idle_timeout: 60,
      max_lifetime: 1800,
      connection: { statement_timeout: 300_000 },
    });
    // the connect figure follows the env budget
    expect(dbConnectionBudget().connect_timeout).toBe(dbConnectTimeoutSeconds());
  });

  test("the app pool's PgStore constructor option carries the shared budget (no literal)", () => {
    const pg = readFileSync(join(ROOT, "src/server/store/pg.ts"), "utf8");
    expect(pg).toContain("connect_timeout: dbConnectTimeoutSeconds()");
    expect(pg).toContain("statement_timeout: DB_STATEMENT_TIMEOUT_MS");
    // the old literals are gone
    expect(pg).not.toMatch(/connect_timeout:\s*30\b/);
    expect(pg).not.toMatch(/statement_timeout:\s*300_000\b/);
  });
});

// ---------------------------------------------------------------------------
// GREP-PIN: every postgres( construction site uses the shared budget.
// Scanning (not listing) keeps NEW sites honest automatically; the expected
// list below makes the current set visible so drift shows as a diff.
// ---------------------------------------------------------------------------
function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", "scratch", ".git", "design", "docs"].includes(e.name)) continue;
      walkTsFiles(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Lines that CONSTRUCT a postgres.js pool/client (not imports/types/comments). */
function postgresConstructionLines(src: string): string[] {
  return src.split("\n").filter((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
    if (/^\s*import\s/.test(line)) return false;
    if (/ReturnType<typeof postgres>/.test(line)) return false;
    return /\bpostgres\s*\(/.test(line);
  });
}

describe("grep-pin — every postgres() construction site carries the shared budget", () => {
  const files = walkTsFiles(ROOT)
    .map((f) => f.slice(ROOT.length + 1))
    .sort();

  const expected = [
    "scripts/commission-cycle-create.ts",
    "scripts/creation-source-report.ts",
    "scripts/dead-contact-repair.ts",
    "scripts/internal-clients-backfill.ts",
    "scripts/lead-counts.ts",
    "scripts/pip-prod-probe.ts",
    "scripts/pip-prod-purge.ts",
    "scripts/recon-snapshot.ts",
    "scripts/retention-chain-proof.ts",
    "scripts/run-harvest-targeted.ts",
    "scripts/run-harvest.ts",
    "src/server/store/pg.ts",
    "src/server/sync/scheduler-lease.ts",
  ];

  test("the construction-site set is exactly the known list (new sites must join)", () => {
    const discovered = files.filter((f) => postgresConstructionLines(readFileSync(join(ROOT, f), "utf8")).length > 0);
    expect(discovered).toEqual(expected);
  });

  for (const f of expected) {
    test(`${f} imports db-pool-config and carries no bare connect literal`, () => {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src).toContain("db-pool-config");
      const construction = postgresConstructionLines(src);
      expect(construction.length).toBeGreaterThan(0);
      // every construction site's options reference the shared builder — on
      // the line itself (single-line options) or within the options block that
      // follows (multiline options)
      const allLines = src.split("\n");
      for (const line of construction) {
        const start = allLines.indexOf(line);
        // 30 lines: the app pool's options block carries a long rationale comment
        const block = allLines.slice(start, start + 30).join("\n");
        expect(
          block.includes("dbConnectionBudget()") || block.includes("dbConnectTimeoutSeconds()"),
        ).toBe(true);
      }
      // the scattered literals stay gone (db-pool-config.ts itself is the only
      // place a bare number may live)
      expect(src).not.toMatch(/connect_timeout:\s*\d/);
    });
  }
});

// ---------------------------------------------------------------------------
// SEAM PIN: every sync pass-start warms the pool through the bounded warmup.
// ---------------------------------------------------------------------------
describe("grep-pin — every sync pass-start routes its first DB touch through the warmup", () => {
  const syncDir = join(ROOT, "src/server/sync");
  const syncFiles = readdirSync(syncDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const seams: { file: string; guarded: boolean }[] = [];

  for (const f of syncFiles) {
    const src = readFileSync(join(syncDir, f), "utf8");
    // only real pass starts: the run-row INSERT (comments excluded); both the
    // sync_runs and availability_sync_runs flavors count — each is a pass start
    // (the availability feed opens TWO rows for ONE pass — one warmup covers both)
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith("//") || t.startsWith("*")) continue;
      if (!/store\.(insertSyncRun|insertAvailabilitySyncRun)\(/.test(lines[i])) continue;
      // the warmup must appear within the next 25 lines (inside the try that follows)
      const window = lines.slice(i, i + 25).join("\n");
      seams.push({ file: f, guarded: window.includes("warmDbConnectionForRun(store)") });
    }
  }

  test("all pass starts found and guarded (8 seams: full-sync runProvider, attribution tick ×2, highlevel tick, acuity, sheets, availability ×2 rows)", () => {
    const total = seams.length;
    const guarded = seams.filter((s) => s.guarded).length;
    expect(total).toBe(8);
    expect(guarded).toBe(8);
    // the incident's two wedged passes must be among them
    const files = new Set(seams.map((s) => s.file));
    expect(files.has("scheduler.ts")).toBe(true); // highlevel incremental + attribution run
    expect(files.has("attribution-tick.ts")).toBe(true);
    expect(files.has("run.ts")).toBe(true);
    expect(files.has("acuity-live.ts")).toBe(true);
    expect(files.has("sheets-tick.ts")).toBe(true);
    expect(files.has("availability-feed.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retry classification of the incident's error text — the connect budget's
// failures must ride the SAME transient class as the driver's own timeouts.
// ---------------------------------------------------------------------------
describe("retry classification — the 2026-11-04 incident error shapes", () => {
  test("postgres.js connect-timeout shape (write CONNECT_TIMEOUT host:port) is transient", () => {
    const e = new Error("write CONNECT_TIMEOUT stbnavfcoc.k86199vsvs.tsdb.cloud.timescale.com:30629");
    (e as { code?: string }).code = "CONNECT_TIMEOUT";
    expect(isTransientDbError(e)).toBe(true);
  });

  test("the warmup's stalled-ping error is classified identically (CONNECT_TIMEOUT code)", async () => {
    const { DbWarmupStalledError } = await import("../store/db-warmup");
    const e = new DbWarmupStalledError(10_000);
    expect((e as { code?: string }).code).toBe("CONNECT_TIMEOUT");
    expect(isTransientDbError(e)).toBe(true);
    expect(e.message).toContain("connect budget");
  });

  test("business errors stay non-transient (never retried)", () => {
    expect(isTransientDbError(new Error("duplicate key value violates unique constraint"))).toBe(false);
  });

  test("RETRY_ATTEMPTS is the 1/3 backoff pattern the warmup inherits", () => {
    expect(RETRY_ATTEMPTS).toBe(3);
  });
});
