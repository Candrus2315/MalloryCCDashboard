# S7 REPORT — Widen Acuity sync window + backfill (engineer, 2026-09-28)

**Commit `eaaeea5`, pushed to `main` (d69a326..eaaeea5). NO PUBLISH (lead publishes + re-verifies live).**
Status: **FULLY COMPLETE.** `bun test src/server` **433/0** (427 baseline + 6 new S7 tests, typecheck tripwire green).

## 1. Files changed
- `src/server/sync/acuity-live.ts` — window constants + chunked pagination in `fetchAppointments()` (the ONE pull both SYNC NOW and the scheduled tick share).
- `src/server/__tests__/acuity-sync.test.ts` — new `S7 sync window` describe (6 tests).
- Scratch (untracked, per team practice): `s7-backfill.ts` (one-shot backfill + verify), `s7-verify.ts` (acceptance counts), `s7-tick-check.ts` (live tick + idempotency + sync_runs), `s7-report.md` (this file).

## 2. Window constants (acuity-live.ts, test-pinned)
- `ACUITY_LOOKBACK_DAYS = 35`, `ACUITY_LOOKAHEAD_DAYS = 180` — pure `acuityWindow(today)` over ET calendar dates (e.g. today 2026-09-28 → 2026-08-24 … 2027-03-27).
- `ACUITY_CHUNK_DAYS = 90` — the 216-day window pulls in **3 contiguous date chunks** (no gaps/overlaps), merged by appointment id. `ACUITY_MAX_PAGE = 500`: a chunk that still fills Acuity's response cap splits in half recursively (`fetchRange`); only a full **single-day** page is flagged `truncated` (never silently short).
- Probe first (per brief): Acuity **accepts maxDate 180 days out** — full widened window `2026-08-23 → 2027-03-26` returns **458 rows** in 3 chunks, `truncated=false`, 0 warnings. (458 is close to the 500 cap, so chunking was mandatory, not optional.)
- Tick cost: 1 → 3 paced requests (~2.2 s extra per ≥5-min tick; Acuity limit 1 req/s). Duplicate-safe upsert by `acuity_appointment_id` and cancellation-in-place semantics untouched. No watermark added — re-upserting 458 rows/tick is cheap and idempotent (verified live).

## 3. Backfill (before → after, live production DB)
| measure | before | after | Acuity truth |
|---|---|---|---|
| appointments rows | 134 | **458** | 458 (widened window) |
| session-datetime span | 2026-09-25T12:00Z → 2026-10-11T21:30Z | **2026-08-23T12:00Z → 2027-03-20T15:00Z** | same |
| sessions Sep 25 → Jan 31 | (partial) | **212** | **212 exact** |
| sessions before Sep 25 (held history) | 0 | **245** (back to Aug 23) | — |
| created Sep 21–25 | 25 | **63** (15/13/12/14/9 by stored created date) | **63 exact** |
| Sep 21–24 **session** rows (owner's held sessions) | — | **23 exist** (ET dates 09-21: 9, 09-22: 7, 09-23: 7) | — |
| cancelled rows | — | 0 (matches source) | — |

All 134 pre-existing rows updated in place (no duplicates: 458 unique ids fetched = 458 stored).

## 4. Acceptance gate on the grown cohort (scratch/s6-engine-gate.json, re-run as instructed)
- **New split: 410 = 126 attributed + 14 ambiguous + 270 unattributed.** Invariant **Total = A + Am + U holds** (126+14+270=410; ambiguous never folded into unattributed).
- **Per-row: failures = 0.** Every S5/S6-era verdict reproduces exactly on the bigger cohort (checked71=71, newly30=30, checked46=46; the old 79 attributed + 4 ambiguous all kept their verdicts). Frozen rules intact — the growth only ADDED verdicts (+47 attributed, +10 ambiguous, +229 unattributed).
- **>2-minute count: 49 → 76** (was window-limited, as the brief anticipated).
- `gatePass=false` **only** because the script pins the old magnitudes (EXPECTED 124/79/4/41/49) — the documented "changed numbers are not a failure" case. **No degradation-guard refusal** (it protects against stripping, not growth), no `force` used, no error sync_runs.

## 5. Tick post-change behavior (verified live, scratch/s7-tick-check.ts)
- Manual `availabilityTick` post-change: **outcome "synced", 458 appointments**, idempotent (458 before → 458 after re-upsert).
- Connection row note now reads: `window 2026-08-23 → 2027-03-26 · 458 appointments` (visible in Settings Sync Center).
- sync_runs history: background ticks at 13:18/13:24/13:30/13:36 (pre-change build) upserted 125 repeatedly; the post-change tick upserted 458, status success, error null. **After the lead publishes, the scheduled tick widens automatically** (the dev server was still running the pre-S7 build during those 125-row ticks).

## 6. ⚠ Flag for the lead (pre-existing, NOT changed — outside S7 scope per brief)
Acuity's `dateCreated` is a **date-only** string ("September 21, 2026"). `parseAcuityInstant` parses it to **midnight UTC**, so ET-dating those instants lands on the **previous calendar day**. Consequence: dashboard created-based windows that ET-date `created_at` count the Sep 21–25 cohort as **48**, not 63 (the 15 bookings created "Sep 21" land on ET Sep 20). Verified: counting rows by the **raw created date (created_at UTC date) gives exactly 63** — all 63 rows are in the DB. This shift predates S7 (same parser produced the old 134 rows) and touches metric definitions, so I did not change it. If the owner's "≈57–63 per week" expectation still reads low after publish, this is the remaining gap — a deliberate decision for the lead/owner (e.g., treat date-only `dateCreated` as an ET date when parsing), to be made explicitly.

## 7. Tests
- 6 new tests in the `S7 sync window` describe: exact 35/180 bounds; month/year rollover both directions; 216-day → 3 contiguous ≤90-day chunks (no gaps/overlaps); short range → 1 chunk; chunked pull plumbing (3 requests, correct minDate/maxDate sequence, max=500, window report); cap-full chunk splits recursively with id-merge dedupe and no silent truncation.
- `bun test src/server` = **433/0** (was 427). Components untouched (153/0 at d69a326). No publish performed.
