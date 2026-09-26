# Week Cadence Lock-In (owner, 2026-09-26) — PRESERVE, VERIFY, TEST

## DIRECTIVE
Do NOT redesign or replace the existing week/date architecture. Preserve current implementation; add explicit validation so it cannot regress. Existing behavior (verified in code review) is CORRECT.

## THE OFFICIAL MALLORY OPERATING WEEK (must remain)
- Monday 12:00 AM → Sunday 11:59:59 PM, America/New_York, regardless of browser/local timezone.
- Working days for pace: Mon–Fri only; Sat/Sun never count as remaining working days for Daily Pace Needed.

## MONDAY PERFORMANCE RESET (must remain)
- WTD metrics are NOT stored counters. Computed live from persisted raw records where record date >= current Monday AND <= current reporting time/date.
- Applies to: Total Calls, Calls Over 2 Minutes, Bookings From Calls Over 2 Minutes, Total Bookings, Conversation Conversion, Assigned Lead Conversion, Average Call Duration, Rep Goal Progress, Team Goal Progress.
- Monday 12:00 AM ET: new WTD window begins; zero activity → zero WTD.

## HISTORICAL DATA (must remain)
- Week rollover NEVER deletes/overwrites: calls, appointments, leads, prior goals, raw records, prior-week metrics. New week = new reporting window over the same permanent raw history.
- Historical access must keep working: Last Week, Last 7 Days, Last 30 Days, This Month, Custom Range, trend charts, historical reports.

## WEEK-SPECIFIC GOALS (must remain)
- team_goals keyed by week_start; rep_goals keyed by rep_id + week_start. Changing current/future week's goal never rewrites another week. Historical reports use the goal that belonged to that week (Week 1=79 stays 79 even after Week 2=85).

## LEAD COHORT (must remain)
- Centralized logic only: Monday = prev Fri+Sat+Sun; Tue–Fri = previous calendar day. Weekend days show the upcoming Monday's cohort (documented).
- Example: Mon Sep 28 work_date includes source dates Fri Sep 25, Sat Sep 26, Sun Sep 27 — they belong to the NEW operating week, NOT the prior week's operational totals.
- source_date AND work_date both preserved; operational reporting uses work_date; historical received-date analysis may use source_date; never overwrite source_date.

## CENTRALIZED WEEK LOGIC (must remain)
- No page may invent its own weekly boundaries. Today/Reps/Team/Daily Report/lead reporting/trend reporting all use the same resolveRange(), weekStart(), getLeadCohort(), getWorkDate() (or existing centralized equivalents).

## HISTORICAL ACCURACY (must remain)
- Historical KPIs recomputed from persisted raw records, NOT frozen summary snapshots. If a provider record is later backfilled/corrected, historical reporting becomes more accurate — never preserve an inaccurate total just because it was displayed. Preserve: raw records, original event dates, historical goals, audit trail.

## RECONCILIATION (continue as in progress)
- Fully backfill + reconcile Today, Yesterday, Current week, Previous week (earlier truncation affected history); older periods continue as planned. A week is "trustworthy" only once its raw provider records are completely ingested + reconciled.

## WORK TO ADD
1. Week-Boundary Verification section in the reconciliation report, verified with REAL data:
   a. Monday WTD rollover (Sunday's WTD stays historically available; Monday starts fresh)
   b. Prior-week preservation (Last Week complete after Monday begins)
   c. Goal independence (changing one week's goal doesn't touch another week's)
   d. Weekend lead routing (Fri/Sat/Sun source leads get Monday work_date, count toward Monday's new week)
   e. Page consistency (Reps/Team/Daily Report/trends resolve to same underlying records for the same week)
2. Automated/documented acceptance test of the sequence: FRIDAY (WTD totals present) → SAT/SUN (week numbers intact; weekend leads assigned upcoming-Monday work_date) → MONDAY 12AM ET (fresh WTD; prior raw records untouched; Last Week full; Fri–Sun leads in Monday's cohort; new week's goals used) → TUESDAY (Leads Today = Monday source leads; Monday in current WTD).
3. Historical navigation: keep This Week/Last Week/Custom Range; add selecting a specific prior week ("Week of Sep 21", "Week of Sep 28"…) retrieving that week's rep performance, team performance, goal, lead volume, conversions, call activity, bookings — without affecting the current week.

## HISTORICAL WEEK SELECTOR — WHOLE-PAGE CONTEXT (owner, 2026-09-26)
- Selecting a prior "Week of" must change the ENTIRE page context together: rep metrics, team metrics, weekly goal, lead budget, lead volume, bookings, calls, conversions, AND trend data all resolve to that selected historical week. A prior-week selector must NEVER update some widgets while others still show current-week data.
- Implementation shape: the selected week drives the ONE resolved range at the page/loader level (same resolveRange mechanics), passed to the single metrics engine — not per-widget state.
- Clear live-state indicator: when viewing the live operating week, show an explicit "Current Week" state (obvious live context, with freshness/sync status); when viewing a historical week, show an unmistakable historical label (e.g. "Historical · Week of Sep 21") so live vs historical is never ambiguous.
