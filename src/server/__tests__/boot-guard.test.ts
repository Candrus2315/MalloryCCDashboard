/**
 * BOOT GUARD tests (2026-10-09 outage hardening) — no live DB, no network.
 *
 * The Oct-8 outage chain: repeated `bun run start` restarts stacked server
 * processes, each holding a warm DB pool (~37 connections observed) until
 * boots hung in ensureSchema and publish.sh's health window expired with the
 * wedged old runtime still live. The guard's classifier + lockfile are the
 * tested surface; serve.ts wires them before any pool or scheduler exists.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_GRACE_SECONDS,
  classifyExistingListener,
  isHealthyBootStatus,
  readServerLockfile,
  writeServerLockfile,
  type ServerLockInfo,
} from "../boot-guard";
import { POOL_PROFILES } from "../store/pg";
import { SCHEDULER_MAX_CONCURRENT_TICKS } from "../sync/scheduler";

describe("isHealthyBootStatus — the same 'server is up' set publish.sh accepts", () => {
  test("2xx/3xx and the 401 passphrase-gate answer are healthy", () => {
    for (const code of [200, 201, 202, 204, 301, 302, 303, 307, 308, 401]) {
      expect(isHealthyBootStatus(code)).toBe(true);
    }
  });
  test("no answer, 4xx-not-401, and any 5xx are NOT healthy", () => {
    for (const code of [null, 0, 404, 429, 500, 502, 503]) {
      expect(isHealthyBootStatus(code)).toBe(false);
    }
  });
});

describe("classifyExistingListener — the second-instance decision", () => {
  const healthy: Parameters<typeof classifyExistingListener>[0] = {
    probeStatus: 200,
    listenerAgeSeconds: 7200,
    supersede: false,
  };

  test("a healthy listener owns the port — a duplicate start exits cleanly (no second pool)", () => {
    expect(classifyExistingListener(healthy)).toBe("exit-duplicate");
    expect(classifyExistingListener({ ...healthy, probeStatus: 401 })).toBe("exit-duplicate"); // gated site
    expect(classifyExistingListener({ ...healthy, probeStatus: 302 })).toBe("exit-duplicate");
    expect(classifyExistingListener({ ...healthy, listenerAgeSeconds: null })).toBe("exit-duplicate");
  });

  test("supersede (SERVE_SUPERSEDE=1, what publish.sh sets) always takes over — deploys replace the build", () => {
    expect(classifyExistingListener({ ...healthy, supersede: true })).toBe("takeover");
    expect(classifyExistingListener({ probeStatus: null, listenerAgeSeconds: null, supersede: true })).toBe("takeover");
  });

  test("unhealthy + listener inside the boot grace → exit-duplicate (never kill a boot in progress)", () => {
    expect(classifyExistingListener({ probeStatus: null, listenerAgeSeconds: 5, supersede: false })).toBe("exit-duplicate");
    expect(classifyExistingListener({ probeStatus: 500, listenerAgeSeconds: BOOT_GRACE_SECONDS - 1, supersede: false })).toBe("exit-duplicate");
  });

  test("unhealthy + old listener → takeover (a long-wedged runtime is what a restart replaces)", () => {
    expect(classifyExistingListener({ probeStatus: null, listenerAgeSeconds: BOOT_GRACE_SECONDS, supersede: false })).toBe("takeover");
    expect(classifyExistingListener({ probeStatus: 500, listenerAgeSeconds: 3600, supersede: false })).toBe("takeover");
    // Age unknowable + no healthy answer → treat as wedged (fail toward recovery,
    // not toward leaving a dead runtime un-restartable).
    expect(classifyExistingListener({ probeStatus: null, listenerAgeSeconds: null, supersede: false })).toBe("takeover");
  });

  test("boot grace window is minutes, not seconds — boots take ~65s+ on a healthy DB", () => {
    expect(BOOT_GRACE_SECONDS).toBeGreaterThanOrEqual(120);
  });
});

describe("server lockfile — who owns the port", () => {
  const dir = mkdtempSync(join(tmpdir(), "bootguard-"));
  const lockPath = join(dir, "server.lock");
  const info: ServerLockInfo = { pid: 4242, port: 3000, started_at: "2026-10-09T20:10:00.000Z" };

  test("write → read round-trips", async () => {
    await writeServerLockfile(lockPath, info);
    expect(readServerLockfile(lockPath)).toEqual(info);
  });

  test("missing or corrupt lock reads as null (the port pre-check is the real guard)", () => {
    expect(readServerLockfile(join(dir, "does-not-exist.lock"))).toBeNull();
    writeFileSync(join(dir, "corrupt.lock"), "{not json");
    expect(readServerLockfile(join(dir, "corrupt.lock"))).toBeNull();
  });

  test("write into a missing directory creates it (bare `bun run start` without publish.sh's mkdir)", async () => {
    const nested = join(dir, "sub", "server.lock");
    await writeServerLockfile(nested, info);
    expect(readServerLockfile(nested)).toEqual(info);
  });

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("outage-hardening config pins", () => {
  test("web pool cap stays at the hardened value (5) — PR #43 one-pool-per-process rule", () => {
    expect(POOL_PROFILES.web.max).toBe(5);
  });
  test("scheduler runs at most one tick per process", () => {
    expect(SCHEDULER_MAX_CONCURRENT_TICKS).toBe(1);
  });
});
