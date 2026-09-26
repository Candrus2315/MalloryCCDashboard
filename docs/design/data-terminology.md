# Data Terminology & Eligibility Rules (owner, 2026-09-26)

Standing rules. Every page, endpoint, export, and report must use these terms and semantics. Immutable-source guarantee applies to all of it.

## Call ownership buckets — three, mutually exclusive

1. **Roster Calls** — call rows whose HighLevel user maps to one of the five CC reps. Counted in rep metrics, team metrics, conversions, goal progress, coaching logic.
2. **Non Roster Calls** — rows with a VALID HighLevel user ID that belongs to a user outside the CC roster (e.g. WTD 9/21–26: Christy West 100, Annah Kniphfer 22, Emily Abney 20, Amy Clark 8, Brand Locus 7, Katelynn Todorov 4, Lexa Brandis 1). Label EXACTLY "Non Roster Calls" — never "Unassigned". Fully visible and auditable, but EXCLUDED from: CC rep metrics, CC team metrics, conversion calculations, goal progress, coaching/attention logic — unless that HighLevel user is later explicitly mapped to the CC roster.
3. **Unattributed Calls** — reserved EXCLUSIVELY for legitimate call records where ownership genuinely cannot be determined (e.g. rows with no HL user id: WTD null = 1). Never used for non-roster users.

## Roster mapping drives eligibility — source records immutable

- Mapping a HighLevel user to a CC rep (Settings, manual, owner-driven) makes ALL historical calls under that original HL user ID automatically eligible for that rep's historical performance and the appropriate historical CC team totals. No re-import, no backfill job needed — eligibility is computed from the mapping at query time.
- NEVER delete, replace, or permanently discard: original HighLevel user ID, message ID, conversation ID, timestamp, duration, or the historical call record itself. The roster mapping determines REPORTING ELIGIBILITY only — it must not alter the original source record.

## New rep activity status — call_start_date

- Reps carry an explicit activation field (`call_start_date` or equivalent).
- Before that date the rep stays visible in the roster with operating state **"Not Yet Active"**:
  - Do not flag zero calls
  - Do not create coaching alerts
  - Do not identify as underperforming
  - Do not include in zero-activity exception logic
  - Do not create negative performance messaging
- From the call_start_date onward, normal performance monitoring begins.
- Exception/coaching logic ONLY — never fabricate activity, hide the rep, or alter historical records because the start date hasn't arrived.
- Worked example (owner): Dan McKillop is rostered now but begins calling Monday 2026-09-28. Before Monday: visible, 0 calls expected, no alerts. From Monday: active for call-performance monitoring.
