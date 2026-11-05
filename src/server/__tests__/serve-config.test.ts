/**
 * SERVE CONFIG — env-driven listen address + managed-mode boot plan
 * (portability 2026-11-05, PART 1 deliverables 1–2).
 *
 * Pins the entire pure surface serve.ts branches on:
 *   - resolveServeAddress: unset → 3000/0.0.0.0; PORT=4599 honored; HOST
 *     honored; invalid PORT → NAMED ServeConfigError (never silently default);
 *   - isManagedServe: SERVE_MANAGED must be EXACTLY "1";
 *   - planServeBoot: managed → NO second-instance guard, NO port-eviction
 *     command (the Bun.$ kill loop is never even constructed); unmanaged →
 *     the sandbox behavior unchanged;
 *   - isAddressInUseError + managedEaddrinuseLogLine: the one-line exit-1
 *     contract (lockfile holder when readable, nothing claimed otherwise).
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  ServeConfigError,
  isAddressInUseError,
  isManagedServe,
  resolveServeAddress,
} from "../serve-config";
import {
  managedEaddrinuseLogLine,
  planServeBoot,
  portEvictionCommand,
  type ServerLockInfo,
} from "../boot-guard";

describe("resolveServeAddress — env-driven listen address (deliverable 1)", () => {
  test("unset PORT/HOST → the documented defaults 3000 / 0.0.0.0", () => {
    expect(resolveServeAddress({})).toEqual({ port: 3000, host: "0.0.0.0" });
    expect(resolveServeAddress({ PORT: undefined, HOST: undefined })).toEqual({ port: 3000, host: "0.0.0.0" });
    expect(resolveServeAddress({ PORT: "", HOST: "" })).toEqual({ port: 3000, host: "0.0.0.0" });
    expect(DEFAULT_SERVE_PORT).toBe(3000);
    expect(DEFAULT_SERVE_HOST).toBe("0.0.0.0");
  });

  test("PORT=4599 → 4599; HOST=127.0.0.1 honored", () => {
    expect(resolveServeAddress({ PORT: "4599", HOST: "127.0.0.1" })).toEqual({ port: 4599, host: "127.0.0.1" });
    expect(resolveServeAddress({ PORT: "8080" }).port).toBe(8080);
    expect(resolveServeAddress({ HOST: "127.0.0.1" })).toEqual({ port: 3000, host: "127.0.0.1" });
  });

  test("invalid PORT → named ServeConfigError (never a silent default)", () => {
    for (const bad of ["abc", "12.5", "30o0", "-1", "0", "65536", "999999"]) {
      let err: unknown = null;
      try {
        resolveServeAddress({ PORT: bad });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ServeConfigError);
      expect((err as Error).name).toBe("ServeConfigError");
      expect((err as Error).message).toContain("PORT");
      expect((err as Error).message).toContain(JSON.stringify(bad));
    }
  });

  test("the sandbox posture (no PORT/HOST in env) resolves byte-identically to the old hard-pin", () => {
    // The CTO sandbox sets neither variable — the site stays on :3000/0.0.0.0.
    expect(resolveServeAddress({ SERVE_MANAGED: undefined })).toEqual({ port: 3000, host: "0.0.0.0" });
  });
});

describe("isManagedServe — SERVE_MANAGED=1 exactly (deliverable 2)", () => {
  test("unset → false; '1' → true; any other value → false", () => {
    expect(isManagedServe({})).toBe(false);
    expect(isManagedServe({ SERVE_MANAGED: undefined })).toBe(false);
    expect(isManagedServe({ SERVE_MANAGED: "" })).toBe(false);
    expect(isManagedServe({ SERVE_MANAGED: "1" })).toBe(true);
    expect(isManagedServe({ SERVE_MANAGED: "0" })).toBe(false);
    expect(isManagedServe({ SERVE_MANAGED: "true" })).toBe(false);
    expect(isManagedServe({ SERVE_MANAGED: "yes" })).toBe(false);
  });
});

describe("planServeBoot — the managed-mode decision (deliverable 2)", () => {
  test("managed plan skips BOTH the second-instance guard and the port eviction", () => {
    const plan = planServeBoot({ managed: true });
    expect(plan).toEqual({ managed: true, runSecondInstanceGuard: false, runPortEviction: false });
  });

  test("unmanaged plan keeps the full sandbox behavior (guard + eviction)", () => {
    expect(planServeBoot({ managed: false })).toEqual({
      managed: false,
      runSecondInstanceGuard: true,
      runPortEviction: true,
    });
  });

  test("under a managed plan the kill-loop command is NEVER constructed (no Bun.$ reachable)", () => {
    // serve.ts builds the eviction command ONLY when plan.runPortEviction is
    // true — pin the guard expression itself:
    const plan = planServeBoot({ managed: true });
    const freePort = plan.runPortEviction ? portEvictionCommand(3000) : null;
    expect(freePort).toBeNull();
    // …and the guard pre-check is skipped the same way:
    const existingPids = plan.runSecondInstanceGuard ? [123] : [];
    expect(existingPids).toEqual([]);
  });

  test("the unmanaged eviction command keeps its exact shape (sandbox byte-compat)", () => {
    const cmd = portEvictionCommand(3000);
    expect(cmd).toContain("lsof -t -iTCP:3000 -sTCP:LISTEN");
    expect(cmd).toContain("kill $pids");
    expect(cmd).toContain("seq 1 25");
    expect(cmd.startsWith("for _ in")).toBe(true);
  });
});

describe("managed EADDRINUSE handling — one clear line + exit 1", () => {
  test("isAddressInUseError recognizes the code and the message, nothing else", () => {
    const e = Object.assign(new Error("listen EADDRINUSE: address already in use 0.0.0.0:3000"), { code: "EADDRINUSE" });
    expect(isAddressInUseError(e)).toBe(true);
    expect(isAddressInUseError(new Error("Failed to start the HTTP server — address in use"))).toBe(true);
    expect(isAddressInUseError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isAddressInUseError(new Error("some other bind failure"))).toBe(false);
    expect(isAddressInUseError("not an error object")).toBe(false);
  });

  test("the exit-1 line names the lockfile holder when readable", () => {
    const lock: ServerLockInfo = { pid: 4242, port: 3000, started_at: "2026-11-05T09:00:00.000Z" };
    const line = managedEaddrinuseLogLine(lock);
    expect(line).toContain("EADDRINUSE");
    expect(line).toContain("SERVE_MANAGED=1");
    expect(line).toContain("exiting 1");
    expect(line).toContain("pid 4242");
    expect(line).toContain("2026-11-05T09:00:00.000Z");
  });

  test("no readable lockfile → the line claims NOTHING about a holder", () => {
    const line = managedEaddrinuseLogLine(null);
    expect(line).toContain("no readable port-owner lockfile");
    expect(line).not.toContain("pid");
  });
});
