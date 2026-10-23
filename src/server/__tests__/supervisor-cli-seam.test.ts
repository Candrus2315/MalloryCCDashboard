/**
 * SUPERVISOR CLI SEAM — pins the bash↔CLI contract the pure-rules tests can't
 * see. ops/supervisor.sh writes the facts file FLAT ({"lockPid":...}); the
 * decide CLI must read that AS the facts. The 2026-10-23 seam bug: a perfectly
 * healthy flat file read through `raw.facts ?? {}` came back as {} → every
 * field null/false → a phantom "serve dead" verdict from a healthy machine.
 * Spawned-process tests because the contract being pinned is the CLI's
 * argv + JSON parsing, not the decision rules (those have their own suite).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(ROOT, "ops", "supervisor-decide.ts");

function runDecide(facts: Record<string, unknown>, stateArg = "", nextArg = ""): { stdout: string; exit: number } {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-seam-"));
  const factsPath = join(dir, "facts.json");
  writeFileSync(factsPath, JSON.stringify(facts));
  const proc = Bun.spawnSync(["bun", CLI, factsPath, stateArg, nextArg], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { stdout: new TextDecoder().decode(proc.stdout), exit: proc.exitCode };
}

function firstLineVerdict(stdout: string): { serve: { action: string; state: string }; hb: { action: string; state: string } } {
  return JSON.parse(stdout.split("\n")[0] ?? "{}");
}

/** Exactly what ops/supervisor.sh's printf writes on a healthy machine. */
const HEALTHY_FLAT = {
  lockPid: 32220,
  lockPidAlive: true,
  healthReachable: true,
  healthCommit: "4c70fcc",
  headCommit: "4c70fcc",
  portPid: "32220",
  procs: 2,
};

describe("supervisor decide CLI — bash seam (flat facts file)", () => {
  test("healthy FLAT facts (the real bash shape) → serve alive and current, no actions", () => {
    const { stdout, exit } = runDecide(HEALTHY_FLAT);
    expect(exit).toBe(0);
    const verdict = firstLineVerdict(stdout);
    expect(verdict.serve.action).toBe("none");
    expect(verdict.serve.state).toBe("ok");
    expect(verdict.hb.action).toBe("none");
    expect(verdict.hb.state).toBe("ok");
  });

  test("envelope shape ({facts:{...}}) still parses — contract accepts both", () => {
    const { stdout } = runDecide({ facts: HEALTHY_FLAT });
    const verdict = firstLineVerdict(stdout);
    expect(verdict.serve.action).toBe("none");
    expect(verdict.serve.state).toBe("ok");
  });

  test("dead-serve flat facts → strike-observe (never a first-strike restart), heartbeat restart", () => {
    const { stdout } = runDecide({
      lockPid: null,
      lockPidAlive: false,
      healthReachable: false,
      healthCommit: null,
      headCommit: "4c70fcc",
      portPid: null,
      procs: 0,
    });
    const verdict = firstLineVerdict(stdout);
    expect(verdict.serve.action).toBe("observe");
    expect(verdict.serve.state).toBe("bad");
    expect(verdict.hb.action).toBe("restart");
  });

  test("garbage facts fields are sanitized — can never smuggle a healthy verdict", () => {
    const { stdout } = runDecide({
      lockPid: "DROP TABLE sync_runs",
      lockPidAlive: "yes",
      healthReachable: "true",
      healthCommit: "not-a-hash",
      headCommit: "",
      portPid: -1,
      procs: "many",
    });
    const verdict = firstLineVerdict(stdout);
    // healthReachable "true" (string) is NOT accepted → serve must not read ok
    expect(verdict.serve.state).not.toBe("ok");
    // heartbeat count "many" is not a number → treated as not running
    expect(verdict.hb.action).toBe("restart");
  });
});
