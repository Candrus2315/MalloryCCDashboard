# docs/audits/ — permanent audit & forensic artifacts

Previously these lived as the only TRACKED files under `scratch/` (now fully
gitignored — see `.gitignore`, backlog 91c47cdd). On 2026-10-28 the tracked
scratch debris was classified: permanent audit/forensic artifacts moved here,
disposable one-shot investigation scripts were removed from the repository
(still recoverable from git history). Basenames are preserved so the stage
reports' internal citations remain legible.

## Stage reports (narrative audit records)

| File | What it records |
| --- | --- |
| `s5-final-report.md` | Attribution-split investigation (S5): engine-gate reproduction 49/4/71, stale-writer diagnosis, Task-2 116,168-vs-116,155 evidence |
| `s5b-report.md` | S5b: three-way attributed/ambiguous/unattributed metric + UI surfacing + `assertBookingInvariant` |
| `s6-report.md` | S6: window-interaction ownership layer + writer guard (version stamp, advisory lock, degradation guard) |
| `s7-report.md` | S7 stage report (backfill + tick verification chain) |
| `s7c-report.md` | S7c stage report (verification chain) |

## Evidence chains cited by the reports (scripts + their JSON outputs)

- S5 gate/diag: `s5-engine-gate.ts` + `.json`, `s5-diag-attr.ts`, `s5-diag.json`,
  `s5-diag-postfix.json`, `s5-probe-46.ts` + `.json`, `s5-scenarios.ts` + `.json`,
  `s5-task2-contacts.ts` + `s5-task2.json`, `s5-report.json`
- S5 attribution evidence dump: `s5-attrib-evidence.ts` + `s5-attrib-results.json`
- S5b live verification: `s5b-verify.ts`
- S6 acceptance gate: `s6-engine-gate.ts` + `.json`
- S7 chain: `s7-backfill.ts`, `s7-tick-check.ts`, `s7-verify.ts`
- S7c chain: `s7c-verify.ts` + `s7c-verify.json`
- S4 evidence: `s4-live-verify.ts` + `s4-verify.json`

## Regression provenance & kept probe tooling

These are kept **working** — relative imports adjusted one level deeper
(`../src/…` → `../../src/…`); path resolution is re-verified on every CI run by
the typecheck tripwire (`tsc --noEmit`, TS2307 fails the gate).

- `s4b-baseline-dump.ts` — generated the exact scenario matrix pinned by
  `src/server/__tests__/s4b-reason.test.ts` (comment pointers updated to this path)
- `s4b-invariance-check.ts` — pairs with the baseline dump
- `s8-live-verify.ts` — S8 live verification probe
- `step5-allreps-probe.ts` — the force-added kept artifact named in WORKFLOW.md
  (formerly `scratch/step5-allreps-probe.ts`)

Run any probe from the repo root, e.g. `bun docs/audits/s4b-invariance-check.ts`.
Note: live probes read production data and may need the usual environment; the
untracked probe toolkit that was always local-only still lives in `scratch/`
(gitignored, unchanged).

## Removed as disposable (still in git history)

59 one-shot investigation files: the `lead-*` (22) / `ambig-*` (6) lead-pipeline
probes, `s3-*` attribution-stage probes (5), `s4-*` census/phase/purge/tick
probes (5), `s4b-probe.ts` + `.json` (superseded by `s4b-baseline-dump.ts`),
`s5-diag-now.json` (superseded by `s5-diag-postfix.json`), `s7c-backfill.ts`,
`s7c-parse-debug.ts`, `s7c-probe{1,2,3}.ts`, `s8-appt-probe.ts`,
`s8-two-block-config.ts`, `backfill-opps-live.ts`, `probe-appts.ts`,
`ruleb-probe.ts`, `ruleb-restore.ts`, and the raw `.err`/`.out` logs whose data
is captured in the kept `.json` outputs. No production import, test read, script,
or package.json entry referenced any of them (grep-verified before removal);
reference-check evidence is in the PR body.
