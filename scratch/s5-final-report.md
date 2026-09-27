# S5 FINAL REPORT — reconciled production baseline, scenarios, diag, Task 2
(2026-09-27, session after 788b9dde. All analysis READ-ONLY; zero production changes; no commits.)

## HEADLINE NUMBERS (all verified against the live Postgres via `Database_URL`)

**Reconciled production-faithful baseline (GATE PASSED — exact):**
| state | count |
|---|---|
| Attributed (rep-attributable under the production >120s window rule) | **49** |
| Ambiguous (manual queue) | **4** |
| Unattributed (no-qualifying-call) | **71** |
| **Total in-scope non-cancelled** | **124** |

**Scenarios over the reconciled baseline (each sums to 124):**
- **s1** = c1 within-window most-recent roster-rep interaction (ANY duration): **79 attributed / 4 ambiguous / 41 unattributed = 124**
- **s2** = c1 + c2 all-time most-recent: **88 attributed / 4 ambiguous / 32 unattributed = 124**
- The real 49 are a strict subset of both 79 and 88 — **no violations**.

**Task 2 root cause (one-liner):** the 13-contact gap is a **moving source, not a walk defect** — the backfill walk completed all 1,163 pages with zero failed pages (checkpoint `failedPages: []`), but HL contacts were being created while the walk ran (source total was 116,168 at walk time, **116,173 when re-queried via API meta during this session**); DB = 116,155 rows = 116,155 distinct HL ids (no duplicate collapse, no filter exclusions), and **zero** of the 124 in-scope bookings or 307 unresolved calls reference a missing contact.

---

## 1. STEP 1 — how the gate was reconciled (what was wrong before)

My prior walk compared its own a–e re-derivation against the **stored** `booking_attributions` table (3 attributed). Both halves were wrong:

1. **Baseline source was wrong.** The live metric does not show 3. The production engine — `matchAppointmentsToCalls` (`src/server/metrics/attribution.ts`) invoked with EXACTLY the `computeAndPersistAttributions` wiring (same scope filter `appointmentInScope` + non-cancelled, same `meaningful_call_threshold_seconds`, same date-granularity window, same users, same `settings.rep_mappings`) — yields **49 attributed (all method=contact_id) / 4 ambiguous / 71 no-qualifying-call over the same 124**. Re-run saved as `scratch/s5-engine-gate.json`. That is an exact reproduction of the lead's 49/4/71 — the gate passes on the production engine itself, not on a re-derivation.
2. **Rep resolution was never the problem — and the lead's suspicion #4 is now provably excluded.** `settings.rep_mappings` really is `[]` (confirmed twice), but the production machinery (`buildRosterEligibility` + `eligibleRepId` from `roster.ts`, reused verbatim) degrades to activeIds via `rep_id` linkage with an empty mapping — the 49 were computed through exactly that machinery, so the empty mapping cannot explain 3-vs-49. `contacts.assigned_rep` contributes **zero** attributions: the engine never reads `assigned_rep_id`, the rewired walk never reads it, and all 49 attribute via call `rep_id` (workflow evidence). The prior walk's `e-assignment` method is gone.
3. **The stored table is written by a STALE deployed build.** `booking_attributions` persistently holds 3 attributed / 121 `none` (71 `no-qualifying-call…`, 4 `ambiguous —…`, 46 window-marker-only notes), rewritten every ~2–5 min by attribution ticks (`sync_runs`: all success, 124 upserted each). The **46 window-note rows are engine-ATTRIBUTED bookings stored as `none`** — per-row diff in `s5-engine-gate.json` (diffCount=46: engine says attributed/method=contact_id/repId set; stored says method='none', rep NULL, note = the attributed-branch window format). NO committed version of `toAttributionRows` can produce that combination (verified `git show` on 32b40be and 953cad1; 953cad1 is byte-identical to HEAD for both attribution files) — the running writer is an intermediate build published between the two commits' semantics. **Fix (production change, NOT made here): republish current main; within one tick cycle the upsert rewrites all 124 rows to the engine verdicts (49/4/71).** No manual_override rows exist, so nothing blocks the rewrite.
4. **The 4 ambiguous are identity-conflicts, kept Ambiguous everywhere** (note: `ambiguous — email resolves a different contact than the stored contact id`). Multi-rep ambiguity among the 75 not-attributed is **0** — a real finding (no booking's interaction evidence spans >1 distinct roster rep), not a contradiction: the queue's 4 are identity-axis ambiguity, and they stay Ambiguous in every scenario (never silently picked).

## 2. STEP 2 — scenarios, matrix, chains, exclusions

**Decision matrix by first-success method over the 75 not-attributed-under-production-rule bookings** (71 no-qualifying-call re-evaluated + 4 engine-ambiguous kept as their own row) — **sums to 75**:
| method | n |
|---|---|
| c1 — single roster rep within window (ANY duration) | 30 |
| c2 — single roster rep all-time (c1 empty) | 9 |
| Ambiguous — identity conflict (engine queue, stays) | 4 |
| Ambiguous — multi-rep workflow evidence | 0 |
| none — no workflow evidence at all | 32 |
| **sum** | **75** |

**Arithmetic flag (must-read):** the brief asked for a matrix summing to 79 over "the 79 not-attributed". 124 − 49 = **75** (4 + 71); 79 would double-count the 4 ambiguous (49 + 79 = 128 ≠ 124). I delivered the honest 75. (Possible source of the 79: s1's Rep-Attributed is exactly 79.)

**Scenario totals** (both include the production 49 as-is; the 71 are re-classified; the 4 stay Ambiguous):
- s1 (c1 within-window): Rep-Attributed **79** (49 + 30 newly), Ambiguous **4**, Unattributed **41**, sum **124**
- s2 (c1 + c2 all-time): Rep-Attributed **88** (49 + 39 newly), Ambiguous **4**, Unattributed **32**, sum **124**

**>2-min recheck (c):** the real 49 sit inside s1's 79 and s2's 88 by construction; every one of the 49 carries a >120s in-window call (`s5-engine-gate.json` attributed rows show durations 362/273/202s etc.); **violations: none**.

**Evidence chains (d)** — 5 newly attributable, full chain in `scratch/s5-scenarios.json` (`.chains`), shape: source call/message id → contact (HL id + normalized phone/email) → rep. Examples:
1. call `VFRcnuopLWWBryhNSn03` (calls table, 2026-09-22T17:12:50Z, 30s) → contact `wvVWF4U5FxqyQr6NVe8W` / 4848181587 / matyldazaklicki@gmail.com → **Allison Wittner** (c1 in-window)
2. call `pO6BEbZgu4av5L8LugE` (calls, 2026-09-18T15:55:12Z, 0s) → contact `vEBZ0PSPQj6MZCGhvZXp` / 2074235748 / nconley13@yahoo.com → **Allison Wittner** (c2 all-time)
3. call `LUYM2jmS6ZM4Y8MOXpbA` (calls, 2026-09-26T19:51:18Z, 0s) → contact `HbwBP0Zq0CZaD6Th04lp` / 6179552510 / chhayhong8@yahoo.com → **Allison Wittner** (c2)
4. call `8QvB3nqzUPi9sBVkukuD` (calls, 2026-09-22T17:11:07Z, 28s) → contact `oF5l4x2K17yPyfFWjycr` / 4133350755 / keshia.a.maxwell@gmail.com → **Allison Wittner** (c1)
5. call `Lz577EcTZtqdwGEYJrqn` (calls, 2026-09-18T14:13:14Z, 27s) → contact `eeJS8UQTDGhAZa8vMaqu` / 2074236122 / andmck87r@yahoo.com → **Carmine Morgano** (c1)

**Exclusions (e):** engine no-qualifying-call **71**; newly reachable ONLY without the 120s threshold **39**; identity-ambiguous (queue) **4**; multi-rep conflicts **0**; no workflow evidence at all **32**; fuzzy-identity-only **0** (no booking was resolved by fuzzy matching — identity tiers are contact_id/phone/email exact only).

## 3. STEP 3 — s5-diag-attr.ts: purpose, fix, result

**Purpose:** answer "what rewrites the stored attributions?" — recent `sync_runs` history, per-method and per-note-head stats over `booking_attributions`, latest write timestamps, and the 3 attributed rows' payloads.
**Fix:** SQL referenced a non-existent `records` column on `sync_runs`; the real column is **`records_upserted`** (pg.ts:210). One-word fix, file left in scratch (uncommitted, per brief).
**Result** (`scratch/s5-diag.json`): attribution ticks succeed every ~2–5 min, each rewriting all 124 rows; stored split is stubbornly 3 attributed / 121 none (71 + 4 + 46 note-shapes); the 3 attributed rows are Allison Wittner via >120s calls (362s/273s/202s). This output is what exposed the stale-writer mechanism in §1.3.

## 4. STEP 4 — Task 2: 116,168 vs 116,155 (full evidence in `scratch/s5-task2.json`)

| measure | value |
|---|---|
| HL API `meta.total` NOW (fresh query, HTTP 200) | **116,173** |
| Source total recorded by the walk (checkpoint `sourceTotal`) | 116,168 |
| Walk progress (checkpoint `pagesDone` / `failedPages` / `nextPageUrl`) | **1,163 / [] (empty) / null — complete** |
| Checkpoint `upserted` at walk end | 116,152 |
| DB rows / distinct `external_id` / NULL ids | **116,155 / 116,155 / 0** |

**Mechanism (proven):** upsert-by-id collapsing duplicates is excluded (rows = distinct ids, 0 NULLs). API-filter exclusions are excluded (the walk followed `meta.nextPageUrl` verbatim to exhaustion with no exclusion params; `meta.total` counts the whole location). **Source changed during/after the walk is confirmed**: the source grew 116,168 → 116,173 (+5) since the walk, and the DB gained 3 rows since the checkpoint's 116,152 (incremental contact sync), leaving 18 unreconciled now vs 13 at walk time. A paging walk over a growing list necessarily lands short by inserts that sort ahead of the cursor; the walk is checkpointed and upsert-only, so nothing was lost or duplicated.
**Identity of the 13:** not cheaply determinable without a second 1,163-page pass (deliberately not run, per brief). 
**Risk to the 124 + 42 unresolved calls: none.** All 124 in-scope bookings' `contact_id`s resolve to DB contacts (0 missing); all 4,552 call→contact references resolve (0 missing); all 307 rep-less calls have contact linkage present (0 missing). The unreconciled contacts are net-new HL records referenced by no stored booking or call. (Note: unresolved-no-rep calls total 307 in the raw calls table; the 42 figure from the brief corresponds to the earlier attribution-scope subset — both populations have zero missing contacts.)

## 5. Artifacts (all in `/home/team/shared/site/scratch/`, untracked, nothing committed)
- `s5-engine-gate.ts` / `s5-engine-gate.json` — STEP 1 gate: production engine run, 49/4/71, per-row 46-diff
- `s5-scenarios.ts` / `s5-scenarios.json` — STEP 2: scenarios, matrix, chains, exclusions
- `s5-diag-attr.ts` (fixed: `records_upserted`) / `s5-diag.json` — STEP 3
- `s5-task2-contacts.ts` / `s5-task2.json` — Task 2 (one live API call, no backfill)
- `s5-probe-46.ts` / `s5-probe-46.json` — the 46 stale rows' payload proof
- `s5-final-report.md` — this file

## 6. For the lead (no action taken, per brief)
1. **Republish current main** to make the persisted attributions match the production engine (49/4/71) — the stale deployed build is the only thing keeping the stored table at 3.
2. The rep-ownership decision matrix for S6: s1 (+30) vs s2 (+39) over the reconciled 49 — the owner picks.
3. Optional hygiene: an incremental contact-sync pass would close the now-18-contact drift; not needed for any displayed metric today.
