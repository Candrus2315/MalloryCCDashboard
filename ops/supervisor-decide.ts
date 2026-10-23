/**
 * SUPERVISOR DECISION CLI — the thin glue between ops/supervisor.sh (facts +
 * actions) and src/server/supervisor-decisions.ts (the test-covered rules).
 *
 * Usage: bun ops/supervisor-decide.ts <facts.json> <state-file> [next-state-file]
 *
 *   facts.json         — the raw facts bash collected, sanitized to numbers/bools
 *   state-file         — .run/supervisor-state.json (may not exist yet)
 *   next-state-file    — where the NEXT state is written (bash then mv's it
 *                        over the state file; omitted = dry, nothing persisted)
 *
 * STDOUT line 1:      verdict JSON (actions + next state) — bash parses this
 * STDOUT line 2..n:   "LOG | <human one-liner>" — bash appends verbatim to the
 *                     supervisor log, so every decision reason is recorded.
 * Exit 0 always (a decision failure must never kill the loop; bash treats an
 * unparsable verdict as "no action this cycle" and logs it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { decideSupervisorCycle, readStateFile, type ServeFacts } from "../src/server/supervisor-decisions";

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // Commits are short hex hashes (or "unknown") — anything else is treated as
  // absent so injected garbage can never smuggle a verdict past the compare.
  const s = v.trim().toLowerCase();
  return /^[0-9a-f]{4,40}$|^unknown$/.test(s) ? s : null;
}

const raw = JSON.parse(readFileSync(process.argv[2] ?? "-", "utf8")) as Record<string, unknown>;
// bash writes the facts FLAT ({"lockPid":...}) — accept either that shape or a
// {"facts":{...}} envelope, so a writer/reader contract drift can never blank
// every field and produce a phantom "serve dead" verdict. (The flat file read
// through the old `raw.facts ?? {}` came back as {} — the 2026-10-23 seam bug.)
const f = ((raw.facts ?? raw) ?? {}) as Record<string, unknown>;
const facts: ServeFacts & { procs: number } = {
  lockPid: num(f.lockPid),
  lockPidAlive: f.lockPidAlive === true || f.lockPidAlive === "1",
  healthReachable: f.healthReachable === true || f.healthReachable === "1",
  healthCommit: str(f.healthCommit),
  headCommit: str(f.headCommit),
  portPid: num(f.portPid),
  procs: Math.max(0, Math.floor(typeof f.procs === "number" ? f.procs : Number.parseInt(String(f.procs ?? "0"), 10) || 0)),
};

const statePath = process.argv[3] ?? "";
const stateRaw = statePath.length > 0 ? readStateFile(statePath) : null;
const v = decideSupervisorCycle({ facts, stateRaw, nowMs: Date.now() });

console.log(
  JSON.stringify({
    serve: { action: v.serve.action, state: v.serve.state },
    hb: { action: v.hb.action, state: v.hb.state },
    stateLine: v.stateLine,
    stateChanged: v.stateChanged,
    backoffActive: v.backoffActive,
    hbBackoffActive: v.hbBackoffActive,
    state: v.state,
  }),
);
console.log(`LOG | serve: ${v.serve.action} — ${v.serve.reason}`);
if (v.serve.anomaly) console.log(`LOG | serve anomaly: ${v.serve.anomaly}`);
console.log(`LOG | heartbeat: ${v.hb.action} — ${v.hb.reason}`);
console.log(`LOG | state: ${v.stateLine}${v.stateChanged ? " (changed)" : " (unchanged, quiet)"}`);

const nextStatePath = process.argv[4] ?? "";
if (nextStatePath.length > 0) {
  try {
    writeFileSync(nextStatePath, `${JSON.stringify(v.state)}\n`);
  } catch (e) {
    console.log(`LOG | WARNING: could not persist next state: ${e instanceof Error ? e.message : String(e)}`);
  }
}
