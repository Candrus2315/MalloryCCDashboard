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
