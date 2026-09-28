# Historical Booking-Win Reconciliation — 2026-09-28 (rev 15)

The historical reconciliation pass for the deposit-paid Booking Win model
(owner directive, business-plan rev 12/15). Scope: verify every historical
metric surface derives from the win-date bucket (`booking_win_business_date`,
paid evidence only) and reconcile sampled days against the retained Acuity raw.

## 1. Metric-path audit — result

| Surface | Path | Status |
|---|---|---|
| Reps page (all ranges incl. week views) | `repsPageData` → `getAppointmentsByWinBusinessDateBetween` → `filterApptsInWinBucketRange` → `repRangeSummaries`/`bookingsByRep` | Already win-bucket + paid-evidence (PR #9) |
| Team page + Trends | `teamPageData` → `buildTeamRangeMetrics` + `buildTeamTrends` (win-bucket query + `filterApptsInWinBucketRange` per trend bucket) | Already win-bucket |
| Today | `todayPageData` → `buildTodayMetrics` (win-bucket queries for today/yesterday/WTD) | Already win-bucket |
| Daily Report | `dailyReportPageData` → `buildDailyReportMetrics` → `report-text.ts` passthrough | Already win-bucket; report-text is pure formatting, no date logic |
| Pending Payments drill-down | `todayPageData.pendingPayments` (derived `pending_payment` state, never counted) | Correct |
| Store selectors | `getAppointmentsByWinBusinessDateBetween` (pg + memory): win-date rows ∪ no-win-date rows by created date; metrics filter to paid wins | Correct |

Legacy remnants found — **none reachable by any metric path**:
- `store.getAppointmentsCreatedBusinessDateBetween` (pg.ts + memory.ts): orphaned
  created-date selector, zero production callers (kept as Store API surface).
- `compute.filterApptsCreatedInEtRange`: exported helper, used only by tests.
- `compute.countBookingsCreatedBetween`: legacy NAME; semantics are win-date
  (filters `isBookingWin` + `bookingWinBusinessDateOf`). Documented, not renamed
  (cosmetic churn across tests only).
- Routes render precomputed payloads only — no parallel booking math found.

Engine semantics untouched (attribution writer version stays 4).

## 2. Reconciliation sample (6 past business days, raw-evidence verified)

Method: for each day, the paid set was derived INDEPENDENTLY from the retained
Acuity raw (`paid:"yes"`, win date = ET date of a raw `paymentTimestamp` when
present, else the row's created ET business date) and compared to the
dashboard's win-date bucketing (`filterApptsInWinBucketRange` + `isBookingWin`
+ scope filter). Runner: `scratch/reconcile-historical-wins.ts` (live DB, 473
appointments, backfill window 2024-10-04 → 2026-09-28, all rows carry
`created_business_date`).

| Day | Raw-evidence paid | Dashboard wins | Online (paid, no rep) | Pending in bucket | Rep split |
|---|---|---|---|---|---|
| 2026-09-08 | 11 | 11 | 10 | 0 | Allison Wittner: 1 |
| 2026-09-15 | 11 | 11 | 0 | 0 | Allison Wittner: 9 · Jennifer Stitt: 1 · Laura Rivera: 1 |
| 2026-09-16 | 11 | 11 | 0 | 0 | Allison Wittner: 9 · Jennifer Stitt: 1 · Laura Rivera: 1 |
| 2026-09-22 | 12 | 12 | 0 | 0 | Allison Wittner: 11 · Laura Rivera: 1 |
| 2026-09-24 | 14 | 14 | 1 | 0 | Allison Wittner: 10 · Carmine Morgano: 3 |
| 2026-09-25 | 9 | 9 | 0 | 0 | Allison Wittner: 6 · Carmine Morgano: 3 |

**RESULT: PASS — 0 mismatches.** Notes:
- The large "online" share on 2026-09-08 is historical rows predating the
  attribution recompute window (no verdict rows exist by design); they count in
  TEAM totals only, per the online rule — never a rep's metrics.
- All 4 pendings (Jenna Van Deventer, Marybeth O'Keefe, Stefanie Korobkin,
  Brian Pacheco) carry NO win date and count nowhere (verified across the full
  population, not just the sample).

## 3. Acceptance gate re-baseline

`scratch/verify-acceptance-booking-wins.ts` updated to the rev-15 final state:
- Allison 8 = Nom, Emily, Korin, Jeanine, Maya + Jordyn (owner override) +
  Angela (owner override) + **Laurie Galbo (owner ruling 9/28 21:30 ET,
  `manual_override=true`, engine call evidence preserved)**.
- Carmine 2 (Jas, Stephanie). Mark Nadeau = the ONLY online (paid +
  unattributed) win — team totals only. Exactly 4 pendings, none counted.
- **RESULT: ACCEPTANCE PASS (0 failures, 1 drift).** The drift is `Laural`
  ($300, paid 2026-09-28) — arrived after the owner's snapshot,
  engine-attributed to Allison Wittner on window-interaction evidence. Owner
  review pending; it does not change any historical number (same-day win).

## 4. Regression coverage added

`src/server/__tests__/historical-win-aggregation.test.ts` (5 tests):
1. A win counts on its win-date only — created-date bucket 0, win bucket 1,
   range spanning both still exactly 1.
2. Persisted `booking_win_business_date` (write-once) beats a re-derived raw
   timestamp.
3. Online (paid + unattributed) wins count in team totals, never in
   `repRangeSummaries`/`bookingsByRep`.
4. Pendings (and cancelled rows) are invisible to team totals, trends, and the
   Daily Report's yesterday/WTD buckets.
5. Historical weekly aggregation buckets by win date — a week-1-created,
   week-2-paid booking shows 0 in the week-1 view and 1 in the week-2 view.
