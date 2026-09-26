/**
 * Regression net for the class of bug that 500'd the published /settings page
 * (2026-09): a server module referenced an identifier (`formatDateHuman`) that
 * was never imported. Vite/esbuild do NOT type-check, so the dangling name
 * compiled fine and only threw `ReferenceError` when the loader ran in prod —
 * invisible to dev-only checks and to logic tests.
 *
 * This test runs `tsc --noEmit` and fails on the dangling-reference class:
 *   TS2304 "Cannot find name"      — used but never defined/imported
 *   TS2305 "has no exported member"— named import that doesn't exist
 *   TS2307 "Cannot find module"    — import path that doesn't resolve
 *   TS2551 "Did you mean"          — typo'd name
 * It deliberately tolerates other strictness noise (implicit-any TS7006,
 * Bun-runtime types in serve.ts) so it stays green while remaining a hard
 * tripwire for unresolvable identifiers anywhere in src/.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const DANGLING_REFERENCE_CODES = new Set(["TS2304", "TS2305", "TS2307", "TS2551"]);

describe("typecheck tripwire", () => {
  test("no unresolvable identifiers anywhere (the class that 500'd /settings)", () => {
    const projRoot = join(import.meta.dir, "../../..");
    const res = spawnSync(join(projRoot, "node_modules/.bin/tsc"), ["--noEmit"], {
      cwd: projRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const dangling = output
      .split("\n")
      // "Cannot find module 'bun:test'" is a known benign false positive:
      // bun resolves it at runtime, but @types/bun isn't installed so tsc can't.
      .filter((line) => !line.includes("Cannot find module 'bun:test'"))
      .filter((line) => {
        const m = line.match(/error (TS\d+)/);
        return m !== null && DANGLING_REFERENCE_CODES.has(m[1]);
      });
    expect(dangling, `Unresolvable identifiers found (these compile but throw ReferenceError at runtime):\n${dangling.join("\n")}\n\nFull tsc output:\n${output}`).toEqual([]);
  }, 60_000);
});
