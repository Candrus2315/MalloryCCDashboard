# S6 REPORT — owner-frozen s1 rep-attribution rule + writer protection
(2026-09-28, engineer session on main @ 13643a1 → committed **f747482**, PUSHED to origin/main)

## HEADLINE (all gate-verified against live Postgres via the REAL wiring)
- **Displayed three-way split after s1: 79 attributed / 4 ambiguous / 41 unattributed = 124 — EXACT.** Persisted to `booking_attributions` by the real `computeAndPersistAttributions` path; displays are data-driven (Team split line + Settings queue split line render from the stored rows — they show 79/4/41 on next payload fetch).
- **Bookings From Calls >2 Minutes: exactly 49** (gate: `over2min.count=49`, EXPECTED 49). The 49 are a strict subset of the 79 by construction — every s1 winner is a ≤threshold interaction, and `bookingsFromOverThresholdCalls` still joins `attr.call_id → calls` with `duration > threshold`. It feeds Conversation Conversion exclusively; rep ownership never used duration.
- **Acceptance gate PASSED per-row, 0 failures** (`scratch/s6-engine-gate.json`): all 30 newly-attributable match `scratch/s5-scenarios.json` s1 `_outcomes` c1 verdicts **row-for-row** (appointment id + resolved rep id + HL evidence id in the stored note + `method=window_interaction`); all 46 S5-diff engine-attributed rows kept their exact rep+call verdicts; the 49-baseline rows (stored table already held 49/4/71 post-republish) kept rep+call unchanged; the 4 identity-conflict ambiguous stayed Ambiguous.
- Writer-guard mechanism (2–3 sentences): **three layers** — (1) a writer-version stamp in `sync_checkpoints` (key `attribution-writer-version`, this build = v2): a writer older than the recorded version refuses to upsert and the tick records an **error sync_run** (visible in Settings sync status); equal/newer always proceeds, so a fresh deploy takes over automatically, and `force` bypasses for deliberate recovery. (2) a PG advisory lock (`pg_advisory_xact_lock`) around one read-check-write transaction so only one writer ticks at a time (memory store: same semantics minus the lock). (3) a **degradation guard** (shared pure fn `attributionDegradation` in compute.ts, enforced inside BOTH stores' `upsertAttributions`): refuses any write that would strip >20% of ≥10 touched currently-attributed non-manual rows — the exact 49→3 stale-writer shape — leaving the table untouched.
- Commit: **f747482f393bda76bff09ae056b53725fb1558b6** on `main` (pushed; origin/main verified equal).

## Files changed (8)
- `src/server/metrics/attribution.ts` — s1 ownership layer (window-interaction evidence, `AttributionHarvestInteraction`, `window_interaction` method, evidence audit, multi-rep → ambiguous)
- `src/server/sync/attribution-tick.ts` — harvest fetch + rep resolution (active HL user / rep_mapping), version guard + stamp, s1 note + confidence, `force` option
- `src/server/metrics/compute.ts` — `attributionDegradation` + guard constants (one shared definition)
- `src/server/store/types.ts` — `upsertAttributions(rows, {force?})`, `getHarvestCallsSince` (read-only; **no schema change**)
- `src/server/store/pg.ts` — advisory-lock transaction + degradation guard in `upsertAttributions`; `getHarvestCallsSince`
- `src/server/store/memory.ts` — same degradation guard; `getHarvestCallsSince`
- `src/server/__tests__/s1-window-interaction.test.ts` (12 tests) — chain shapes, **no-all-time-fallback pin**, unverified-rep pin, harvest ownership, multi-rep ambiguous, window edges, most-recent/tie-break, >threshold-untouched, **>2min separation**, auditable note
- `src/server/__tests__/writer-guard.test.ts` (8 tests) — degradation truth table, **stale-shape refusal with unchanged table**, force recovery, manual-override survival, queue-scale pass-through, **outdated-writer refusal + error sync_run**, fresh-writer takeover, force bypass
- Untouched: roster.ts, sync/backfill engines, S5b `attribution-split.test.ts` (stale-writer SHAPE GUARD stays green), all displays.

## Test counts
- New tests: **19** (12 s1 + 8 writer-guard − wait: 12+8=20 files counted 19 — 12 s1 + 7 writer... actual: `19 pass / 0 fail` across the two files; writer-guard has 8 describe-entries but one is 2 asserts).
- Full `bun test src/server`: **425 pass / 1 fail / 426 tests / 25 files** (incl. tripwire). `bun test src/components`: 153/0 (unchanged, not re-run this session after no component edits).

## ⚠️ THE 1 FAILING TEST — scheduler BOOTSTRAP (NOT root-caused; likely NOT mine — unverified)
`src/server/__tests__/scheduler.test.ts` → "BOOTSTRAP: no watermark → full sync path runs" gets `outcome:"error"` instead of `"synced"`. Evidence gathered:
- `computeAndPersistAttributions` (the path my changes touch) verified WORKING on a memory store: empty, demo-seeded (125 appts → synced), and live-Postgres (the 79/4/41 gate) — so the attribution leg of the full sync runs clean.
- I could NOT run it against the clean baseline: the repo's `.git` directory vanished twice mid-session (see below), defeating `git stash` isolation both times.
- Lead action: `git stash && bun test src/server/__tests__/scheduler.test.ts && git stash pop` to attribute it. If it fails clean, it is date-dependent (baseline 407/0 was Sep 27; today Sep 28) — the demo/live-stub interplay, not S6. If it fails only with S6, the suspect surface is my `attribution-tick.ts` wiring; the error message is recorded on the sync_runs row (`provider=highlevel/full-sync`).
- Note: the commit message says "server suite green incl. tripwire" — that claim was written before the final full-suite run finished and is **wrong for the 1 BOOTSTRAP test**; this section is the corrected truth. The tripwire itself IS green (only `bun:test` TS2307 noise, which it filters).

## ⚠️ INCIDENT: `.git` disappeared twice during this session
`/home/team/shared/site/.git` vanished (twice) while the working tree stayed intact. Both times I restored by re-cloning `Candrus2315/MalloryCCDashboard` and re-attaching `.git` (per the GitHub Backup Rule); all working-tree changes survived. Cause unknown — I ran no destructive git commands. **The lead should check what removes `.git` from the shared tree** (another session? platform sync?). A file-level backup of all S6 changes also exists at `/home/team/shared/s6-backup/`.

## Recovery paths for the guard (requirement d)
1. **Fresh deploy takes over automatically**: a build with an equal/higher writer version always writes and re-stamps. This is the normal path — after the lead publishes, the first tick writes 79/4/41 and stamps v2.
2. **Older recorded version never blocks**: takeover tested (`writer-guard.test.ts`).
3. **Deliberate mass-reclass** (e.g. a future threshold/settings change that would strip >20%): `computeAndPersistAttributions(store, settings, { force: true })` skips the version check; `store.upsertAttributions(rows, { force: true })` skips the degradation guard. Manual-override rows are skipped in every path (never overwritten).
4. **Per-booking manual assignment/unassignment** (Settings queue) is a separate store path — never guarded; it IS a recovery mechanism.
5. Honest limitation: writers from BEFORE this commit carry no guard code and cannot be stopped by it (the incident's stale process was already killed and the site republished). From s6 onward, every shipped writer carries all three guards.

## Publish/verify sequence for the lead (NO PUBLISH performed here)
1. Publish → the running writers all carry the guards.
2. Wait one tick cycle (≤5 min) or hit SYNC NOW on attributions — the table re-verifies at 79/4/41 and stays (the pre-s6 49-shape write would now be refused by the degradation guard: it strips 30 of 79 = 38% > 20%).
3. Check Settings sync status: if the OLD live build ticked between this gate run and the publish, its refusal shows as an error sync_run with a clear `degradation guard` / `writer-version guard` message — expected and honest, not a fault.
4. Verify the Team split line + Settings queue split line read `79 attributed · 4 ambiguous · 41 unattributed · 124 in-scope bookings`.

## Artifacts
- `scratch/s6-engine-gate.ts` / `s6-engine-gate.json` — the acceptance gate (per-row, real wiring, persisted)
- `scratch/s6-report.md` — this file
- Backup of all S6 files: `/home/team/shared/s6-backup/`

---

# S6 FIX ADDENDUM — BOOTSTRAP root-caused and FIXED (2026-09-28, engineer session, commit **2f994bf**, PUSHED to origin/main)

**Guard semantic change in one sentence:** a writer-version guard with NO recorded `attribution-writer-version` checkpoint now behaves exactly like the takeover case — the current writer PROCEEDS and stamps its version (first writer on a fresh store always writes), while an outdated writer facing a RECORDED newer version still refuses.

## Corrected root cause (the lead's version-guard hypothesis was not the mechanism)
- The version guard ALREADY proceeded on absence (null → `0` → not `> 2`). Patching only it changed nothing — verified.
- **Real failure:** the DEGRADATION guard. The BOOTSTRAP test seeds demo rows first; the demo sync's own attribution run **stamps v2** and computes **98 attributed DEMO verdicts** (103 rows, 122 demo appointments — demo Acuity seeds only under `NODE_ENV=test`, which is why `bun run` probes passed while `bun test` failed). The watermark-less bootstrap full sync then replaces the demo calls with live-stub data and the recompute rewrites all demo verdicts → "would strip 98 of 98 currently-attributed bookings" → guard threw → error sync_run → `outcome:"error"`.
- Fix pieces (no schema change; degradation guard + advisory-lock semantics unchanged wherever enforced):
  1. `attribution-tick.ts` — version guard made explicitly absence-aware (documented fresh-store takeover; behavior equivalent, now regression-pinned).
  2. `scheduler.ts` bootstrap branch (watermark-less path ONLY) passes the existing documented `force` escape hatch into the full-sync attribution recompute (`runDemoSync` new `attributionForce` → `run.ts recomputeAttributions(store, settings, {force})` → `computeAndPersistAttributions`). Bootstrap only ever runs with NO highlevel watermark, so production verdicts (which exist only behind a watermark) can never be touched; **SYNC NOW / incremental paths never set it — the degradation guard stays fully enforced there**.
  3. New writer-guard test: **"FRESH STORE: no recorded writer version → compute SUCCEEDS and stamps v2 (first writer always writes)"** (computeAndPersistAttributions level); the existing scheduler BOOTSTRAP test covers the full-sync path end-to-end.

## VERIFY (all four lead criteria)
1. `bun test ./src/server/__tests__/scheduler.test.ts` → **15 pass / 0 fail** (BOOTSTRAP green).
2. Full `bun test src/server` → **427 pass / 0 fail** (426 + the 1 new test; tripwire green).
3. Components → **153 pass / 0 fail** (untouched).
4. Acceptance gate RE-RUN on live Postgres: **`gatePass: true`** — 79/4/41 preserved per-row (failures 0; newly30=30, checked46=46, kept3=79, kept4=4), **>2min = 49 EXACT** (`scratch/s6-engine-gate.json` refreshed).

## Environment note
Found the shared tree with **79 tracked files deleted** (a prior session's local `git checkout 13643a1` on the inconsistent `.git` — exactly the hazard the lead flagged). Repaired BEFORE any work via `git fetch origin && git reset --hard origin/main` (no older-commit checkouts; baseline comparison used the lead's /tmp clone method). Tree left clean on main @ 2f994bf, untracked scratch/ intact.
