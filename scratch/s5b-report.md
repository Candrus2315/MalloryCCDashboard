# S5B REPORT — THREE-WAY ATTRIBUTION DISPLAY (owner directive 2026-09-27)

## HEADLINE
**The three displayed numbers on the current data: 49 attributed · 4 ambiguous · 71 unattributed = 124.**
Verified against live Postgres through the shipped metrics function (`bookingAttributionSplit` over the tick's exact scope):
`{"total":124,"attributed":49,"ambiguous":4,"unattributed":71,"withoutVerdict":0}` — invariant PASS, 49/4/71=124 PASS.
(Previously Ambiguous(4) was folded inside Unattributed(75); now the same data reads three separate states.)

## WHAT CHANGED (commit on main; engine/sync FROZEN — zero changes to sync/*, engine semantics, roster, schema, backfills)
1. **Metrics layer (one place)** — `src/server/metrics/compute.ts`:
   - `BookingCoverage` is now THREE-way: `{ total, attributed, ambiguous, unattributed }` — Ambiguous is its own state, mutually exclusive by construction.
   - New `attributionStateOf(row)` — THE stored-row → state classifier: `rep_id` set → attributed (manual included, note never downgrades); note starting with the new `AMBIGUOUS_NOTE_PREFIX` ("ambiguous") → ambiguous; else unattributed. The prefix is exactly what `toAttributionRows` writes for engine-ambiguous verdicts.
   - New `bookingAttributionSplit(appts, attributions)` → display-facing split incl. honest `withoutVerdict` (a booking with no stored verdict row is never silently called unattributed): Total = A + Am + U + withoutVerdict.
   - `assertBookingInvariant` now enforces **Attributed + Ambiguous + Unattributed === Total** (the two-way engine-verdicts conservation check is unchanged and still passes — sync/attribution-tick.ts NOT touched).
2. **Display surfaces**:
   - **Team page** (`team.tsx` + `page-data.ts` payload `bookingSplit` + `team-views.bookingSplitLine`): new split line directly under the Total Bookings hero — "N attributed · N ambiguous · N unattributed · N total bookings in range", with "· N without a verdict yet" appended honestly when a booking predates the verdict coverage.
   - **Settings manual-assignment queue** (`settings.tsx` + `queries.ts` payload `attributionSplit` + `settings-views.queueRowState`/`QUEUE_STATE_LABELS`): split line "49 attributed · 4 ambiguous · 71 unattributed · 124 in-scope bookings", an honest count of rows needing a manual decision, and a per-row state chip (amber "Ambiguous" vs neutral "Unattributed"). The queue's assign/unassign behavior is UNCHANGED — the 4 ambiguous identity-conflict rows ("email resolves a different contact than the stored contact id") stay Ambiguous until Christopher assigns.
   - **DetailDrawer §16 / daily-report**: checked — neither surfaces an attributed/unattributed booking count (§16 lines reconcile chart-vs-record counts; daily report shows bookings/pace only), so no change needed there (brief's conditional).
3. **Tests**:
   - NEW `src/server/__tests__/attribution-split.test.ts` (11 tests): classifier truth table; three-way disjointness + invariant; withoutVerdict honesty; assertBookingInvariant three-way; cancelled excluded; **stale-writer shape guard** — every engine verdict's row written by the production `toAttributionRows` classifies back to the SAME state (ambiguous always carries the note prefix + rep NULL; attributed rows can never be misread as ambiguous) so an older build can't misinterpret the shape destructively; **live-data invariant test** (Postgres-gated, skips in demo/memory mode): Total = A + Am + U on the CURRENT data, ambiguous rows never counted inside unattributed.
   - Updated `call-contact-backfill.test.ts` two-way pin to the three-way shape.
   - Component tests: +3 `bookingSplitLine`, +2 `queueRowState`/labels.

## GATE
- `bun test src/server`: **407 pass / 0 fail** (baseline 396 + 11 new; typecheck tripwire green).
- `bun test src/components`: **153 pass / 0 fail** (148 + 5 new).
- One intermediate tripwire failure (formatInt unimported in settings.tsx — the exact class the tripwire exists for) fixed before commit.

## FILES
src/server/metrics/compute.ts · src/server/queries.ts · src/server/page-data.ts · src/components/team-views.ts · src/components/settings-views.ts · src/routes/team.tsx · src/routes/settings.tsx · src/server/__tests__/attribution-split.test.ts (new) · src/server/__tests__/call-contact-backfill.test.ts · src/components/__tests__/{team-views,settings-views}.test.ts

Scratch (untracked, per convention): s5b-verify.ts (the live verification above).

## NOTES FOR THE LEAD
- NO PUBLISH (per brief) — you publish after verifying the merge.
- The stale writer (bun run serve.ts PID 12874/12878) was stopped in the shared terminal earlier; stored booking_attributions now read 49/4/71 (post-republish tick at 02:54Z confirmed via s5-diag-postfix.json).
- The committed live test asserts the STRUCTURAL invariant on current data (not the exact 49/4/71 pin — that would break the moment Christopher manually assigns an ambiguous booking). Exact numbers were verified this session and are recorded above.
- S6 remains gated exactly as before: the engine, window, evidence methods, and sync are untouched; the owner still picks the rep-ownership rule from the S5 matrix.
