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
 *
 * FRESH-CLONE TOLERANCE (E5, 2026-09-26): `src/routeTree.gen.ts` is gitignored
 * and only exists after a build. A fresh clone running `bun test src/server`
 * pre-build used to false-fail on exactly one dangling-class error:
 *   src/router.tsx(x,y): error TS2307: Cannot find module './routeTree.gen' ...
 * This test now (a) TRIES to generate the file first via the TanStack Router
 * CLI when it is missing (`node_modules/.bin/tsr generate`, if installed), and
 * (b) while the file is absent, tolerates ONLY the narrowly-scoped
 * routeTree.gen TS2307 diagnostics — every other dangling reference still
 * fails. To keep that path exercised on EVERY gate run, the test simulates a
 * fresh clone when the file exists: it renames it away for the tsc spawn and
 * restores it afterwards (verified below).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const projRoot = join(import.meta.dir, "../../..");
const ROUTE_TREE = join(projRoot, "src/routeTree.gen.ts");
const ROUTE_TREE_BAK = join(projRoot, "src/routeTree.gen.ts.typecheck-bak");
const DANGLING_REFERENCE_CODES = new Set(["TS2304", "TS2305", "TS2307", "TS2551"]);

/**
 * TRUE for the one diagnostic class the missing generated route tree produces.
 * Narrowly scoped: a TS2307 whose module path mentions routeTree.gen. Any
 * other dangling reference (including inside files that import it) still
 * fails the gate.
 */
export function isMissingRouteTreeGenDiagnostic(line: string): boolean {
  const m = line.match(/error (TS\d+)/);
  return m !== null && m[1] === "TS2307" && line.includes("routeTree.gen");
}

/**
 * Best-effort generation of the gitignored route tree on a fresh clone via
 * the router CLI, when installed (`tsr generate`). Absent CLI → return false
 * and the tolerance path below keeps the gate green; `vite build` (publish)
 * always regenerates the real file.
 */
function tryGenerateRouteTree(): boolean {
  const tsr = join(projRoot, "node_modules/.bin/tsr");
  if (!existsSync(tsr)) return false;
  const res = spawnSync(tsr, ["generate"], { cwd: projRoot, encoding: "utf8", timeout: 60_000 });
  return res.status === 0 && existsSync(ROUTE_TREE);
}

describe("typecheck tripwire", () => {
  test("no unresolvable identifiers anywhere (the class that 500'd /settings)", () => {
    // Recover from a crashed earlier run (bak file left behind).
    if (!existsSync(ROUTE_TREE) && existsSync(ROUTE_TREE_BAK)) renameSync(ROUTE_TREE_BAK, ROUTE_TREE);

    // Simulate a FRESH PRE-BUILD clone: the generated route tree is absent for
    // the tsc spawn, whatever the local state was, so the tolerance path is
    // exercised on every run (and a stale .gen file can never mask it).
    const existedBefore = existsSync(ROUTE_TREE);
    if (existedBefore) renameSync(ROUTE_TREE, ROUTE_TREE_BAK);

    try {
      let generated = false;
      if (!existsSync(ROUTE_TREE)) generated = tryGenerateRouteTree();
      // Tolerate the missing-module diagnostics ONLY while the file is absent
      // and generation did not produce it.
      const tolerateRouteTree = !existsSync(ROUTE_TREE) && !generated;

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
        .filter((line) => !(tolerateRouteTree && isMissingRouteTreeGenDiagnostic(line)))
        .filter((line) => {
          const m = line.match(/error (TS\d+)/);
          return m !== null && DANGLING_REFERENCE_CODES.has(m[1]);
        });
      expect(dangling, `Unresolvable identifiers found (these compile but throw ReferenceError at runtime):\n${dangling.join("\n")}\n\nFull tsc output:\n${output}`).toEqual([]);
    } finally {
      // Restore whatever the workspace had — the tree must look untouched.
      if (existedBefore && existsSync(ROUTE_TREE_BAK)) renameSync(ROUTE_TREE_BAK, ROUTE_TREE);
    }

    expect(existsSync(ROUTE_TREE)).toBe(existedBefore);
  }, 60_000);

  test("tolerance predicate: only the routeTree.gen module-not-found class matches", () => {
    expect(
      isMissingRouteTreeGenDiagnostic(
        "src/router.tsx(3,27): error TS2307: Cannot find module './routeTree.gen' or its corresponding type declarations.",
      ),
    ).toBe(true);
    // A REAL dangling import is never tolerated:
    expect(
      isMissingRouteTreeGenDiagnostic(
        "src/server/queries.ts(12,20): error TS2307: Cannot find module './date-logic'",
      ),
    ).toBe(false);
    // Other codes are never tolerated, even when routeTree.gen is mentioned:
    expect(
      isMissingRouteTreeGenDiagnostic(
        "src/router.tsx(5,10): error TS2305: Module './routeTree.gen' has no exported member 'createFileRoute'.",
      ),
    ).toBe(false);
    expect(isMissingRouteTreeGenDiagnostic("src/a.ts(1,1): error TS2304: Cannot find name 'foo'")).toBe(false);
    expect(isMissingRouteTreeGenDiagnostic("plain output line")).toBe(false);
  });
});
