# Reconciliation Report — 2026-09-26 (operative-window harvest, part 1b)

**Prepared for:** Christopher (owner) · **Prepared by:** engineer session, team Mallory CC Performance Dashboard
**Verdict: RECONCILED.** For all five roster reps and every window checked, the harvest ledger and the dashboard database agree exactly, the dashboard pages render those same numbers from one metrics engine, and the working site has been republished with the corrected data.

All dates/times America/New_York (ET). Windows: **9/25** = 9/25 00:00–23:59 ET; **WTD** = Mon 9/21 00:00 ET → now; **prev week** = Mon 9/14 → Sun 9/20 ET.

---

## 1. Final per-rep matrix — calls / calls over 2 min

| Rep | 9/25 before* | 9/25 after (DB) | 9/25 ledger recount | 9/25 match | WTD before* | WTD after (DB) | WTD ledger recount | WTD match |
|---|---|---|---|---|---|---|---|---|
| Allison Wittner | 60/10 | **102/12** | 102/12 | ✓ | 131/12 | **620/57** | 620/57 | ✓ |
| Carmine Morgano | 96/4 | **133/5** | 133/5 | ✓ | 202/9 | **685/31** | 685/31 | ✓ |
| Dan McKillop | 0/0 | **0/0** | 0/0 | ✓ | 0/0 | **0/0** | 0/0 | ✓ |
| Jennifer Stitt | 77/1 | **134/4** | 134/4 | ✓ | 87/1 | **549/10** | 549/10 | ✓ |
| Laura Rivera | 39/0 | **44/0** | 44/0 | ✓ | 76/1 | **151/8** | 151/8 | ✓ |
| **Team (five reps)** | 272/15 | **413/21** | 413/21 | ✓ | 496/23 | **2005/106** | 2005/106 | ✓ |

\* "before" = dashboard DB mid-pass at 15:20 UTC (from harvest-recon-2026-09-26.txt), when the harvest had visited only 245 of 2,155 in-window conversations. The DB was undercounting because the old incremental sync had missed most call messages; the harvest repaired it (final team WTD calls 2005 vs 496 before — roughly 4× more call history recovered).

**Team-total cross-check (all HighLevel users, not just the five):**
- 9/25: ledger 423/22 = dashboard 423/22 (10 calls from non-roster HL users → held as unassigned, never guessed onto a rep)
- WTD: ledger 2168/136 = dashboard 2168/136 (163 unassigned: Christy West 100, Annah Kniphfer 22, Emily Abney 20, Amy Clark 8, Brand Locus 7, Katelynn Todorov 4, Lexa Brandis 1, no-user 1)
- 2168 − 163 unassigned = 2005 = the five-rep team total shown on the Team page. No call escapes and none is double-counted.

## 2. THE DAN FINDING — Dan McKillop's 0/0 is genuine

Checked four independent ways; there is **no missing bucket and no mapping gap**:

1. **His conversations contain no calls.** Dan has 5 conversations with last activity on 9/25 ET; all 5 were message-visited, and every one is email only (`TYPE_EMAIL`, zero `TYPE_CALL` messages). Per HighLevel, Dan's activity that day was email outreach, not phone.
2. **Zero call messages all week.** `harvest_calls` (the per-call-message ledger keyed by HL's own message userId) has **zero rows for Dan's HL userId across the entire 13-day window** (9/14 → now), not just 9/25.
3. **Exactly one HL account.** No duplicate/second Dan or McKillop user exists that calls could have landed under.
4. **No hidden users.** Every call row in the ledger maps to a known HL user; the non-roster remainder (Christy West etc.) is fully accounted for in the unassigned counts above. Nothing anywhere adds up to "Dan's calls."

Conclusion: HighLevel genuinely shows zero call messages for Dan McKillop in the operative window. The dashboard displays 0/0 because the source says 0. If the owner expects Dan to be calling, that is an HL-side data/usage question (e.g., calls made outside HL-Dialer aren't captured), not a dashboard defect.

## 3. Harvest coverage (message-visit coverage per window)

| Window | Conversations listed | Visited | Coverage |
|---|---|---|---|
| Prev week 9/14–9/20 ET | 874 | 874 | **100.0%** |
| WTD 9/21–9/26 ET | 1,540 | 1,540 | **100.0%** |
| 9/25 ET | 602 | 602 | **100.0%** |

The owner's MUST-GATE (100% for 9/25 and WTD) is met — and the previous week finished sweeping to 100% as well. All 2,414 in-window conversations were message-visited.

**Pages/records fetched (run started 15:13 UTC, budget 75 min):** 2,800 conversation-list requests → 8,303 conversations listed this run; **2,414 conversations message-visited**; **35,927 messages scanned**; **8,946 call messages found** (upsert-safe by HL message id; the window total in the ledger is 2,168 WTD + prev-week rows). Earlier partial runs' work was reclaimed and resumed from DB cursors — no duplicate calls (ledger keyed by message id).

## 4. Methodology (source = DB = displayed)

- **Source:** HighLevel conversations API. Every conversation with last activity ≥ Mon 9/14 00:00 ET was listed, then its messages fetched (visit). Call-type messages become ledger rows in `harvest_calls` keyed by HL message id, attributed by the call message's own HL userId.
- **DB:** the same visit upserts into the dashboard `calls` table (normalized, `provider_rep_external_id` preserved; rep assigned only for the owner-configured active roster).
- **Recount:** `scripts/recon-snapshot.ts` recounts both sides per rep per ET window and diffs them. The tool's COVERAGE line had a ~1-day-off hardcoded epoch constant (1789467600000 ≈ 9/15 06:20 ET); fixed to the true window start (1789358400000 = 9/14 00:00 ET) and extended to print coverage per window (prev week / WTD / 9/25).
- **Display:** all six pages read the one metrics engine (`src/server/queries.ts`) over the `calls` table. Verified live from the server-rendered payloads: Reps page (range=yesterday) shows Allison **102 total / 12 over-threshold** and Morgano **133/5** — identical to the DB; roster strip shows Dan 0; Team page WTD totals **2005 calls / 106 over 2 min** — identical to the five-rep ledger sum; Daily Report shows Bookings Yesterday 9, WTD 51, Goal 79, Left 28. No page computes its own numbers.

## 5. Ship status

- `bun test src/server`: **225 pass / 0 fail** (incl. typecheck tripwire) before publish.
- Published the working site with the corrected data and the recon-tool fix; live check below.
- Commit: recon-snapshot epoch fix + this report; scratch files (probe scripts) remain untracked and were removed from the tree after use.

## 6. Notes for the owner

- "Calls" = call-type messages in HighLevel conversations (dialer/voicemail included; duration from HL). Non-roster HL users' calls are preserved and visible for manual assignment, never attributed to a rep silently.
- Daily Report lead fields show Leads Today 0 / budget 681 used — Sheets sync state is unchanged by this pass (see separate Sheets-API status).
- Conversion percentages on Daily Report depend on the booking-attribution engine (Acuity); the call counts verified here are its numerator/denominator inputs.

---

# Part 2 — Full per-day matrix, audit view, unassigned visibility (accuracy pass 2)

**Run:** `bun scripts/recon-snapshot.ts --matrix` at 2026-09-26T16:38 UTC · recount per rep × per ET day from the `harvest_calls` ledger vs the dashboard `calls` table, window **Mon 9/14 00:00 ET → today**. Both sides read inside one transaction; over-2-min threshold 120 s on both sides. Roster = the owner's five reps; every other HighLevel user (and the calls with no user) is held **unassigned**.

## Verdict

**RECONCILED — 163 of 169 compared cells match exactly; every one of the 6 mismatch cells is on TODAY (2026-09-26, in-flight) and is explained (below). Through 9/25 ET the ledger and the database agree cell-for-cell, every day, every user, calls and over-2-min.**

- Cells compared: 13 ET days × (5 roster users + 8 unassigned users) = 169 user×day cells, plus per-day UNASSIGNED and TEAM(roster) aggregates.
- Zero ledger-only rows anywhere: nothing the harvest saw is missing from the dashboard DB.
- Per-ext window totals: 9 OK, 4 "MISMATCH" — all four are carried entirely by today's 8 in-flight messages (same rows, same explanation).

## Day-by-day matrix — calls / over-2-min (ledger vs DB; `A≠B` = ledger≠DB)

```
ET day      | Allison      | Carmine      | Dan          | Jennifer     | Laura        | UNASSIGNED   | TEAM(roster) | verdict
2026-09-14 | 168/19       | 144/7        | 0/0          | 153/4        | 41/3         | 22/6         | 506/33       | OK
2026-09-15 | 120/13       | 133/1        | 0/0          | 143/4        | 32/3         | 31/6         | 428/21       | OK
2026-09-16 | 108/9        | 133/5        | 0/0          | 123/4        | 23/1         | 24/4         | 387/19       | OK
2026-09-17 | 112/10       | 113/3        | 0/0          | 145/3        | 28/1         | 34/6         | 398/17       | OK
2026-09-18 | 108/6        | 143/4        | 0/0          | 137/5        | 26/4         | 47/11        | 414/19       | OK
2026-09-19 | 0/0          | 0/0          | 0/0          | 0/0          | 2/0          | 7/0          | 2/0          | OK
2026-09-20 | 6/1          | 1/0          | 0/0          | 0/0          | 1/0          | 11/0         | 8/1          | OK
2026-09-21 | 161/25       | 150/8        | 0/0          | 143/2        | 21/5         | 29/2         | 475/40       | OK
2026-09-22 | 128/5        | 142/7        | 0/0          | 4/0          | 31/1         | 59/12        | 305/13       | OK
2026-09-23 | 119/8        | 107/6        | 0/0          | 132/1        | 23/1         | 30/7         | 381/16       | OK
2026-09-24 | 111/7        | 153/5        | 0/0          | 136/3        | 30/1         | 27/6         | 430/16       | OK
2026-09-25 | 102/12       | 133/5        | 0/0          | 134/4        | 44/0         | 13/1         | 413/21       | OK
2026-09-26 | 4/0≠5/0      | 0/0≠1/0      | 0/0          | 0/0          | 2/0          | 9/2≠15/2     | 6/0≠8/0      | MISMATCH (explained)
```

Per-user window totals (calls/over-2-min, ledger vs DB):

```
Allison Wittner        ledger=1247/115  db=1248/115   (today +1, explained)
Carmine Morgano        ledger=1352/51   db=1353/51    (today +1, explained)
Dan McKillop           ledger=0/0       db=0/0        OK (verified genuine in Part 1)
Jennifer Stitt         ledger=1250/30   db=1250/30    OK
Laura Rivera           ledger=304/20    db=304/20     OK
Christy West           ledger=232/40    db=232/40     OK
Emily Abney            ledger=43/8      db=43/8       OK
Annah Kniphfer         ledger=29/3      db=34/3       (today +5, explained)
Amy Clark              ledger=21/8      db=21/8       OK
Brand Locus            ledger=7/1       db=7/1        OK
Katelynn Todorov       ledger=6/2       db=7/2        (today +1, explained)
(none)                 ledger=3/0       db=3/0        OK
Lexa Brandis           ledger=2/1       db=2/1        OK
```

Unassigned per day sums the non-roster users above; TEAM(roster) sums the five reps — matching what the Reps/Team pages show (unassigned is displayed but never merged into roster/team numbers).

## The 6 mismatch cells — all on 2026-09-26, all one cause, all explained

Every mismatch is `db ≥ ledger` for TODAY only, and a message-level diff finds **8 DB-only call rows and 0 ledger-only rows**:

| HL message id | user | duration |
|---|---|---|
| rfYwrOAiwRScYY11TS0o | Allison Wittner | 0 s |
| 4NX3Hi7mQNvQ9L4aii2e | Carmine Morgano | 0 s |
| IJghywvzN4oovfOfgyvW, BHNU8dGPkhZjJdGs5x79, h8LabP8y849muEIQHoA0, YuilW53vl9m7u17SAFkk, iTldDtuBZtFlJI51GPCA | Annah Kniphfer (5 rows) | 0–34 s |
| hrXra0cM11EB7tVyWlHw | Katelynn Todorov | 86 s |

**Explanation:** these 8 call messages were ingested by the **incremental HighLevel sync** (the 90 s scheduler path), which reads call messages directly from the conversations/messages search — but for these messages HighLevel returned **no conversation id** (`conversation_id = null`). The harvest **ledger** counts calls by *visiting conversations*, so a message with no conversation can never be ledgered, while the dashboard `calls` table (keyed by message id) correctly stores it once. This is a one-way ledger blind spot on the in-flight day, not a dashboard error: the DB holds a strict superset, nothing is duplicated, and no call is double-counted or lost. Yesterday (9/25) and every earlier day reconcile exactly.

## What ships with Part 2 (so the owner can re-verify any cell)

- **Audit view** — `/audit` page + read-only `GET /api/audit?rep=<repId|all|unassigned>&date=YYYY-MM-DD` (ET day boundaries via the centralized helpers): every raw DB call row for a rep × day with HL message id, conversation id, HL user id, direction, duration, over-threshold flag (live settings threshold, same rule as the metrics engine), rep and contact identity. DB reads only — no live harvesting on page load.
- **Unassigned on the Reps page** — a clearly separated section under the roster list showing the selected window's unassigned calls / over-threshold per non-roster HL user (names where known, HL user id otherwise), with the note that assignment happens via the upcoming booking-attribution/manual-assignment work. Never merged into roster or team totals.
- **Matrix tooling** — `scripts/recon-snapshot.ts --matrix` re-runs this whole recount on demand.

**Final status: RECONCILED.** Zero unexplained mismatches; the operative window 9/14 00:00 ET → 9/25 23:59 ET matches cell-for-cell, and today's 6 cells are accounted for by the 8 documented conversation-less messages above (they will reconcile in the ledger's day view only if HighLevel starts returning conversation ids for them — the dashboard counts stand on their own either way).
