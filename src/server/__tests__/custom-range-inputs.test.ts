/**
 * A CUSTOM DATE RANGE can actually be STARTED (owner-reported 11/2, lead
 * reproduced in the browser). Root cause: the From/To date inputs + Apply
 * rendered ONLY when the SERVER-RESOLVED range mode was "custom" — but with
 * empty dates the server falls back to Today, so the boxes were hidden
 * exactly when they were needed (click the pill → inputs never appear → a
 * custom range could never be started fresh; chicken-and-egg).
 *
 * Route-source pins (the repo's pattern for render-gate contracts): the input
 * row must be gated on the URL SEARCH PARAM (range=custom — true the moment
 * the pill is clicked), never on the resolved mode. Behavior pins for the
 * softened resolveRange fallback (absent dates → silent Today; invalid →
 * warned Today) live in reps.test.ts.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPS_SOURCE = readFileSync(join(import.meta.dir, "../../routes/reps.tsx"), "utf8");
const TEAM_SOURCE = readFileSync(join(import.meta.dir, "../../routes/team.tsx"), "utf8");

test("the From/To input row is gated on the URL search param (range=custom) — both pages", () => {
  expect(REPS_SOURCE).toContain('{search.range === "custom" && (');
  expect(TEAM_SOURCE).toContain('{search.range === "custom" && (');
});

test("the input row is NOT gated on the server-resolved range mode (the chicken-and-egg gate is gone)", () => {
  expect(REPS_SOURCE).not.toContain('data.range.mode === "custom" && (');
  expect(TEAM_SOURCE).not.toContain('data.range.mode === "custom" && (');
});

test("both pages still own an Apply handler that navigates with from/to for the server to validate", () => {
  expect(REPS_SOURCE).toContain("from: customFrom || undefined");
  expect(REPS_SOURCE).toContain("to: customTo || undefined");
  expect(TEAM_SOURCE).toContain("from: customFrom || undefined");
  expect(TEAM_SOURCE).toContain("to: customTo || undefined");
});
