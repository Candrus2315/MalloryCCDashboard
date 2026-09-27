# S7c-FINISH Report — Authoritative Creation Timestamp: remaining ~40% completed

Date: 2026-09-28 · Engineer session · NO PUBLISH (lead verifies + owner reviews first)

## Starting state (corrected from the brief)

The brief said "no commit; tree = modified acuity-live.ts only." Ground truth: the prior
S7c session had already made a LOCAL commit `66eb4ff` (unpushed — the lead checked
`origin/main`, which is why it read as "no commit") containing the ingestion change,
metrics bucketing, engine window, and 15 tests (448/0). The working tree held a 1-line
delta on top. The remaining work this session: verify every claim, finish the 1-line
delta, fix one real bug it exposed, run the old-124 enumeration, update + re-run the
gate, tests, commit, push, report.

## 1. Ingestion change — reviewed, finished, committed

- `parseAcuityAppointment` (committed in 66eb4ff): `datetimeCreated` (ISO 8601, stated
  offset) → `created_at` true UTC instant; original string → `created_time_source`;
  `created_business_date` = instant in America/New_York; `created_time_precision`
  full/date_only/session_fallback; date-only `dateCreated` parsed AS A CALENDAR DATE
  (never UTC-shifted); full provider object → `raw`.
- Working-tree delta (kept): `dateCreatedInstant` fallback now requires the string to
  contain "T" — a date-only `dateCreated` ("September 21, 2026") must never go through
  `Date.parse` (implementation-defined TZ) — it falls to the calendar parser instead.
- Upsert: `upsertAcuityAppointments` writes created_business_date / created_time_source /
  created_time_precision / raw; pg `upsertAppointments` ON CONFLICT updates all of them;
  schema ensure has the columns + index (`appt_created_bdate_idx`).

## 2. BUG FOUND AND FIXED: pg `date` normalization (apptRow)

postgres.js parses `created_business_date` (a pg `date`) into a JS **Date** object.
`apptRow` did `String(v).slice(0,10)` → **"Tue Sep 08"** — every downstream
`DATE_ONLY_RE` check failed, so the pg metrics path silently ignored the COLUMN and fell
back to deriving from `created_at` (numbers happened to stay right post-re-stamp, but the
column-read directive was not actually served). Fixed with exported
`normalizePgBusinessDate()` (Date→ISO calendar date, string pass-through, garbage→null)
+ pinned by test. After the fix the live pg path reads the column and the engine/metrics
anchors land on `created_business_date`.

## 3. Explicit engine window — verified

`bookingCreationDateEt` reads `created_business_date` (anchoredOn "created_business_date")
when present; window = `attributionWindowDates(date)` = **[cbd−1, cbd]** ET. Pinned by
tests (enter/leave/never-widened + legacy fallback).

**Rerun stability (owner stop-condition): full-table before/after diff over ALL 410
rows in the gate rerun: changed = 0.** Stored verdicts stayed EXACTLY as they were.

## 4. OLD-124 ROW-FOR-ROW ENUMERATION (owner gate)

Enumerated vs baseline artifacts (S6-gate logic, owner-verified):
- 71 `_outcomes` rows by `c1Reps` (30 expected newly-attributed with exact rep+evidence,
  41 expected unattributed) — **zero diffs**;
- 46 `_allDiff` engine rows (expected rep + call, external→internal resolved) — **zero diffs**;
- 4 `fourCurrentlyAmbiguousBecome` rows — all still ambiguous — **zero diffs**;
- = 121 distinct apptIds, expected 76A + 4Am + 41U, **changed: 0**;
- kept-3 (the 3 pre-S5 stored window rows, not re-listed in the S5 artifacts): verified
  row-for-row at the S6 gate and the S7 gate (kept3 check, failures=0 both, committed
  evidence), all currently-attributed rows survived this session's rerun unchanged
  (kept3=126 before/after identity), and the aggregate split never moved.

**Statement: ZERO silent changes, enumerated: none** (121 rows enumerated directly from
artifacts with zero diffs; 3 kept-3 verified unchanged by gate row-checks + rerun
before/after identity + frozen aggregate split).

## 5. Gate pins updated + re-run on live Postgres

`scratch/s6-engine-gate.ts` EXPECTED: total 410, 126/14/270; over2min EXPECTED 76;
gatePass additionally requires rerunChanged=0. Result (scratch/s6-engine-gate.json refreshed):
- storedSplit 410 = 126/14/270 = EXPECTED
- rerunStability changed=0; perRow checked71=71, newly30=30, checked46=46, kept3=126,
  kept4=14, failures=0
- over2min 76 = EXPECTED 76 (re-verified live, still 76)
- **gatePass: true**

## 6. Reconciliation tables (live pg, read-only verify: scratch/s7c-verify.json)

Sep21–25 by-day (non-cancelled; both bucketings identical):

| ET date  | raw stated-offset local date | created_business_date |
|----------|------------------------------|-----------------------|
| 09-21    | 15                           | 15                    |
| 09-22    | 13                           | 13                    |
| 09-23    | 12                           | 12                    |
| 09-24    | 14                           | 14                    |
| 09-25    | 9                            | 9                     |
| **week Sep21–27** | —                   | **63 EXACT**          |

- Cohort: 410 = **126 attributed / 14 ambiguous / 270 unattributed**.
- **>2min: 76** (re-verified live via the gate formula).
- Precision: full ×458; created_time_source missing: 0; raw payload missing: 0.

## 7. Timezone statement

**Full precision everywhere**: all 458 appointments have `created_time_precision='full'`
(real datetimeCreated instants), offsets **-0500×451 / -0600×7**. **Zero edge flips**:
0 of 458 rows have ET business date ≠ stated-offset local date. The 7 -0600 rows
(all flip-free, id / source / stated-local / ET):

1. 1578171342 · 2025-11-21T17:54:48-0600 · 2025-11-21 · 2025-11-21
2. 1605726357 · 2025-12-29T09:05:19-0600 · 2025-12-29 · 2025-12-29
3. 1645551350 · 2026-02-25T14:35:35-0600 · 2026-02-25 · 2026-02-25
4. 1601124340 · 2025-12-18T16:01:05-0600 · 2025-12-18 · 2025-12-18
5. 1617278540 · 2026-01-15T11:29:55-0600 · 2026-01-15 · 2026-01-15
6. 1653848705 · 2026-03-03T17:59:05-0600 · 2026-03-03 · 2026-03-03
7. 1634614736 · 2026-02-11T14:16:22-0600 · 2026-02-11 · 2026-02-11

## 8. Tests + gates

- `bun test src/server`: **449 pass / 0 fail** (448 + 1 new pg-normalization test; includes
  the typecheck tripwire) — covers both offsets, 11 PM edge + DST winter edge, -0600,
  date-only calendar fallback, session fallback, business-date bucketing (63-shape),
  explicit window enter/leave, three-way split, pg date normalization.
- `bun test src/components`: **153 pass / 0 fail** (untouched).

## 9. Commits

- `66eb4ff` (prior session, verified this session, unpushed) — S7c ingestion + metrics + engine + tests.
- (new, this session) — finishes ingestion delta (dateCreated "T" guard), FIXES pg
  `created_business_date` normalization (Date→"Tue Sep 08" corruption), adds the
  normalization test.
- Both pushed to `origin/main`. NO PUBLISH — lead verifies, owner reviews the package.
