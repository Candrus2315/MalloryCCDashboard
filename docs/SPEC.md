# MALLORY CC PERFORMANCE DASHBOARD — OWNER SPEC (SOURCE OF TRUTH)

Internal web app for the Mallory Portraits Client Concierge (CC) team.

It is NOT a CRM, LMS, messaging app, employee management system, task manager, or AI coaching platform. Its job is to automatically combine GoHighLevel/HighLevel, Acuity Scheduling, and Google Sheets and give Christopher one trustworthy place to see CC performance, lead volume, goals, bookings, and studio availability.

> **DOC STATUS (updated 2026-10-28).** This file carries the owner's original spec
> forward as present-tense truth. The original V1 wording is kept where it is still
> the rationale for a behavior; passages the product has outgrown are marked
> **SUPERSEDED** with the current rule inline. Nothing here rewrites history —
> superseded text is preserved so the *why* behind each change stays auditable.

## PRIMARY NAVIGATION
Today · Reps · Team · Availability · Daily Report · Weekly · Performance · Retention · Settings · Audit · Status

**SUPERSEDED (2026-09→10).** The original nav was the six V1 tabs "Today · Reps · Team · Availability · Daily Report · Settings". Four management modules have since been added — Weekly (owner's Monday leadership report, 2026-09-29), Performance (PIP module), Retention, and the ops pair Audit + Status — and the six originals all shipped as specified. "Keep V1 lightweight" was the build-order directive for V1 and remains the design discipline for every addition (reporting + management documentation only; the DO NOT ADD list still governs).

## CURRENT SCOPE (2026-10-28)
The app is no longer the original lightweight six-tab build; it is a complete management module set on the same single-store, single-metrics-source core:

- **Reporting pages** — Today, Reps, Team, Availability, Daily Report, Weekly. Weekly answers the owner's four operational questions (Weekly Leads / Gross Bookings / Cancellations / Net Bookings) and nothing else by design.
- **Performance module** — PIPs (performance improvement plans) with evidence snapshots, check-ins, templates, and an event log; both stores implement identical semantics.
- **Retention module** — identity chain, attempt ledger + outcomes, cancellations/no-show/transfers ledgers, append-if-new scorecards, read-only owner history. Live on the dashboard.
- **Audit module** — record-level booking reconciliation views (see also `docs/audits/` for preserved audit artifacts, e.g. `audit-79v84` for the 84/5/79 booking audit).
- **Status** — read-only health view: per-provider sync freshness, sync heartbeat, supervisor/boot/running guards, recent sync runs with errors verbatim.
- **Commissions are MANUAL by owner directive (2026-10-19)** — tracked outside the app; no commission-calculation feature is to be built.

## INTEGRATIONS

### HighLevel — use for
Rep/user · Contact ID · Contact name · Phone · Email · Assigned owner · Call ID · Call timestamp · Call duration · Call direction/status · Assigned leads · Opportunity/pipeline data where useful.

Calculate: Total calls · Calls over 2 minutes · Calls by rep · Average call duration · Assigned leads.

**Meaningful Conversation** = any call lasting more than 120 seconds. Default threshold 120s, configurable.

### Acuity — CORE V1 integration, not future
Appointment ID · Client name · Phone · Email · Appointment creation timestamp · Appointment date/time · Appointment type · Calendar · Status · Cancellation/reschedule status · Appointment duration · Availability · Blocked times where available.

Acuity is the PRIMARY booking and studio availability source. Christopher can select which Acuity calendars and appointment types count toward CC reporting.

### Google Sheets — lead counts
Genre lead-ads sheets (three; lead_type text first, sheet-identity fallback for Fairyland's "Fairies" campaign):
Family Sheet ID: 1_5d1TDrOLg_E3RICEY6M7K9wnM97M9wkHLUN-C0oIvg
Animalia Sheet ID: 1Zp_ghywl-u4e13NHMoPRubZ9DCZC-Khv1ePL6PVahZU
Fairyland Sheet ID: configured via Settings integration (not hardcoded here). **SETTLED — owner option B (final 2026-10-29):** the Fairyland spreadsheet's un-ingested `LEADS` tab (~24,437 rows of 2020–2024 history, zero overlap with stored leads) stays **EXCLUDED from ingest permanently**; Fairyland lead reporting is tied to the `2026 fairies` tab only. Options survey retained in the team's `shared/fairyland-leads-survey.md`.

**Forms Data — Mallory Portraits workbook** (added per owner directive 2026-10-27; four tabs = four independent lead sources through the SAME pipeline as the genre sheets, identical count/dedupe rules):
Workbook ID: 1ePTLKCpHVzvYo7zRUoAbE-rL3adXtkgjIsWXWtdf8Ms — tabs: Auction Register Certificate · Google Ads Leads · Alliance Activate Certificate · Website Applications.

Allow configurable column mapping instead of hardcoding columns.

Metrics: per-source leads (all seven sources) · Total Leads Today · Weekly Leads · Weekly Lead Budget · % Budget Used · Leads Remaining. Default weekly lead budget = 700, editable.

**SUPERSEDED (2026-09→10).** The original integration listed only the Family and Animalia sheets and the per-metric list "Family Leads Today · Animalia Leads Today". Five further sources (Fairyland + the four workbook tabs) were added by owner directive; every downstream lead consumer now carries them as named buckets.

## CRITICAL LEAD DATE LOGIC

"Leads Today" does NOT mean leads generated today. It means leads the CC team is expected to WORK today.

- Tuesday–Friday: today's working leads = leads received on the PREVIOUS calendar day. (Tue=Mon, Wed=Tue, Thu=Wed, Fri=Thu.)
- MONDAY RULE: Monday working leads = all leads received previous Friday + Saturday + Sunday. Example: report date Monday 9/28 pulls sheet records dated Fri 9/25, Sat 9/26, Sun 9/27 from BOTH sheets.

Never simply filter Google Sheets for today's date. Create one centralized function such as getLeadCohort(reportDate). Store BOTH:
- source_date = actual date lead entered sheet
- work_date = date team is expected to work it

Operational reporting uses work_date. Historical reporting can use source_date. Use America/New_York for all Mallory operational date logic.

### WEEKLY LEAD LOGIC (current, 2026-10-28)
- The **operational lead count uses `work_date`** — every weekly/operational lead number is a work-date cohort, never a raw source-date slice.
- The Mallory weekly lead cohort follows the **existing Friday-through-Thursday source-date cadence that maps into the Mon–Fri work-date week**: `getWorkDate` maps a Fri/Sat/Sun source lead to Monday (Fri +3, Sat +2, Sun +1) and Mon–Thu source leads to the next calendar day (Tue–Fri). A lead's *work week* is therefore the Mon–Sun window containing its `work_date`, and the source dates feeding that work week are always the preceding Fri–Thu window.
- **Explicitly NOT raw Mon–Sun `source_date` filtering.** A lead received Friday belongs to the *following* work week even though its source_date may fall inside the label week. (The weekly report's cohort slice is `work_date IN [weekStart..weekEnd]` — see `src/server/page-data.ts`, "WORK-DATE COHORT slice".)
- `getWorkDate` and `getLeadCohort` (in `src/server/date-logic.ts`) are THE centralized functions; pages must never re-derive or filter sheets by "today".

## BOOKING ATTRIBUTION

Booking Attribution Engine connecting HighLevel calls with Acuity appointments. Match contacts by priority: 1) Contact ID 2) Phone 3) Email.

A booking counts as "Booking From Calls Over 2 Minutes" when: a rep had a call with that contact longer than 120 seconds AND the appointment was created within the configured attribution window (default 24 hours). If multiple reps spoke to the client, attribute to the most recent qualifying call before the booking. If attribution is unclear, put it in UNATTRIBUTED BOOKINGS and allow Christopher to manually assign. Do not silently guess attribution.

## WEEKLY BOOKING PRODUCTION (current — Final Booking Logic, owner directive 2026-10-28; shipped + live-verified)
The Weekly dashboard's hero answers four operational questions: **Weekly Leads · Gross Bookings · Cancellations · Net Bookings.**

- **Gross Bookings** = every qualifying (paid-deposit) booking **originally created** during the selected Mon–Sun report week, identity-deduped, **cancellations included**. The **original booking-creation week owns the production credit permanently** — a booking is never re-bucketed by later reschedules, and its credit never moves between weeks.
- **Cancellations** are displayed separately: the **true cancellations among that gross** (same-week cancel-and-rebook dedupes to a reschedule, not a cancellation).
- **Net Bookings = Gross − true cancellations.**
- **Reschedules never move production credit between weeks, and the session date is NOT the booking-production date.** Production follows the original `created_at` / `created_business_date` (deposit/creation business date).
- **Why this is safe (reschedule-lineage audit, 2026-10-28; tests: `src/server/__tests__/reschedule-lineage.test.ts`, 7 regression tests):** Acuity's only reschedule mechanism is `PUT /appointments/{id}/reschedule` — an **in-place same-ID update** of the appointment object; there is no reschedule that mints a new appointment, and the raw payload carries no lineage/`datetimeChanged` metadata. Our sync upserts by `acuity_appointment_id`, so a reschedule UPDATEs the stored row in place while `created_at`/`created_business_date` re-derive from the payload's `datetimeCreated`, which a reschedule never changes — the creation week is stable by construction. **Cancelled is terminal** in Acuity's model, so a same-ID row cannot come back from cancelled in a later week. Live verification: 825 stored appointments, 0 duplicate `acuity_appointment_id` rows.

## COHORT METRICS — do not confuse weekly production with cohort conversion
**Cohort-produced conversion** (of the week's lead cohort, how many leads produced a booking: cohort bookings ÷ cohort leads) exists internally and on rep-level analysis where still required (e.g. the Reps page's assigned-lead conversion per the standing rep-cohort directive). It is **NOT the Weekly headline production number**: Weekly Gross/Cancellations/Net are booked-week production figures, not cohort-produced figures, and cohort-produced machinery is deliberately off the Weekly UI. When reading any bookings-per-leads number, first ask which basis it is on — lead-cohort-produced vs booking-week-produced — and label it.

## METRIC DEFINITIONS
- CONVERSATION CONVERSION = Bookings From Calls Over 2 Minutes / Calls Over 2 Minutes
- ASSIGNED LEAD CONVERSION = Total Bookings / Assigned Leads (always labeled "Assigned Lead Conversion")
- GOAL ACHIEVEMENT = Actual Bookings / Booking Goal

These are **rep-level conversion metrics** (calls/leads → bookings). The Weekly page's production block (Gross/Cancellations/Net) is a different basis — see COHORT METRICS above — and one must never be presented as the other. See also WORK-DATE ALIGNMENT: weekly leads cohort on the Fri–Thu source cadence → Mon–Fri work-date week (above).

## TODAY DASHBOARD
Landing page answers the most important questions within seconds. Show: Today's Bookings · Yesterday's Bookings · Bookings WTD · Weekly Booking Goal · Bookings Remaining · Daily Pace Needed · Today's Total Calls · Today's Calls Over 2 Minutes · Today's Conversation Conversion · Today's Assigned Lead Conversion · Average Call Duration · Family Leads Today · Animalia Leads Today · Total Leads Today · Weekly Leads · Weekly Lead Budget · % Lead Budget Used · Open Studio Slots Today · Open Studio Slots Tomorrow.

Rep performance table (sortable): Rep · Total Calls · Calls >2 Min · Bookings From >2 Min Calls · Total Bookings · Conversation Conversion · Assigned Lead Conversion · Avg Call Duration · Goal · Actual · Goal %.

Default weekly team booking goal = 79, editable by week.

## INDIVIDUAL REP PERFORMANCE (Reps page)
Filters: Today · Yesterday · This Week · Last Week · This Month · Custom Range.
Metrics: Total Calls · Calls Over 2 Minutes · Bookings From Calls Over 2 Minutes · Conversation Conversion · Total Bookings · Assigned Lead Conversion · Average Call Duration · Booking Goal · Actual · Goal Achievement · Difference From Goal · Performance Compared With Team Average.

Example comparison format: Calls: Rep 74 / Team Avg 68 / Difference +8.8% · Calls >2 Min: Rep 14 / Team 11 / +27.3% · Conversation Conversion: Rep 57.1% / Team 54.5% / +2.6 percentage points.

No AI scores or employee grades.

## TEAM PERFORMANCE (Team page)
Total Team Calls · Total Calls Over 2 Minutes · Bookings From Calls Over 2 Minutes · Team Conversation Conversion · Total Bookings · Assigned Lead Conversion · Average Call Duration · Weekly Goal · Actual · Bookings Remaining · Goal Achievement · Daily Pace Needed. Simple trends for: Bookings · Calls · Calls Over 2 Minutes · Conversation Conversion · Assigned Lead Conversion · Average Call Duration · Lead Volume. Support selected date ranges.

## ACUITY AVAILABILITY (Availability page)
By selected date: Total Capacity · Booked Slots · Open Slots · Utilization % · Specific Open Times. Example: Saturday — Capacity 18, Booked 14, Available 4, Utilization 77.8%, Open: 10:00 AM, 12:30 PM, 3:00 PM, 5:30 PM.

Add COPY AVAILABILITY producing e.g. "Saturday Availability — 4 appointments remaining: 10:00 AM, 12:30 PM, 3:00 PM, 5:30 PM".

If Acuity directly provides availability use it; else calculate from business hours, appointment duration, slot interval, existing appointments, blocked times, padding. Rules editable in Settings.

## DAILY CC REPORT (Daily Report page)
Prepares Christopher's morning report automatically. Primarily YESTERDAY'S performance plus CURRENT WEEK progress. Show: Bookings Yesterday · Bookings WTD · Weekly Booking Goal · Bookings Left · Daily Bookings Needed · Conversation Conversion · Assigned Lead Conversion · Goal Achievement %. LEADS: Weekly Lead Budget · Leads Today (work-date logic!) · Family Leads Today · Animalia Leads Today · Weekly Leads · % Lead Budget Used · Leads Remaining · Daily Leads Needed.

BIG 3: three manual daily priority fields (1, 2, 3), saved by date.

Buttons: COPY REPORT · COPY FOR EMAIL · COPY FOR SLACK. Example output:
```
Daily CC Report
Bookings: 11
Bookings for the Week: 37
Key Driver: 79
Left: 42
Daily: 21
Conversion of Calls Over 2 Mins: 63.63%
Conversion of Assigned Leads: 13.18%
% of Appt Achieved: 53.16%

Leads:
Weekly Lead Budget: 700
Leads Today: 80
Family: 27
Animalia: 53
Total Weekly Leads: 594
% of Budget Used: 84.86%
Leads Remaining: 106

Big 3:
1. Morning Rev
2. Candidate follow up
3. 1 on 1s
```
Christopher should not have to manually calculate report metrics.

## DATA MODEL (normalized)
users · contacts · calls · appointments · booking_attributions · leads · rep_goals · team_goals · availability_rules · blocked_times · daily_priorities · integration_connections · manual_overrides.

Important fields:
- calls: external_call_id · rep_id · contact_id · started_at · duration_seconds · over_two_minutes
- appointments: acuity_appointment_id · contact_id · calendar_id · appointment_type · appointment_datetime · created_at · status · cancelled
- leads: source_id · lead_type · source_date · work_date · phone · email · source_sheet
- booking_attributions: appointment_id · call_id · rep_id · method · confidence · manual_override

## SYNC / DATA QUALITY
Background syncs for: HighLevel calls/contact activity · Acuity appointments/availability · Google Sheets leads. Provide SYNC NOW. Show Connection Status · Last Sync · Last Successful Sync · Sync Errors.

Do not make live provider API calls every page load. Use provider IDs to prevent duplicates. If Acuity changes/cancels an appointment, update the existing record instead of creating duplicates. Cancelled appointments remain historically but do not count as active bookings. If provider data is stale or unavailable, clearly warn the user. Do not display incomplete metrics as though they are current.

## MANUAL OVERRIDES
Christopher can manually correct: booking attribution · rep goal · team goal · lead count · lead work date · availability block. Track: previous value · new value · who changed it · timestamp.

## SETTINGS
Weekly Booking Goal · Weekly Lead Budget · Meaningful Call Threshold · Booking Attribution Window · Operational Time Zone · HighLevel Connection · Acuity Connection · Google Sheets Connection · Sheet Column Mapping · Acuity Calendars Included · Acuity Appointment Types Included · Studio Hours · Appointment Duration · Slot Interval · Padding · Recurring Blocked Times.

## DESIGN
Clean, premium internal operations dashboard. NOT a generic SaaS admin template. Warm white/light background · dark charcoal typography · large KPI numbers · compact tables · strong hierarchy · minimal borders · restrained brand accents · simple charts · excellent spacing. Desktop first but responsive. Today page understandable in ~10 seconds.

## DO NOT ADD
CRM · Messaging · Training · LMS · AI coaching · Call transcription · Payroll · Employee scheduling · Task management · Marketing automation · Lead generation · Document storage.

## V1 SUCCESS
Christopher opens the app each morning and quickly sees: yesterday's bookings · bookings WTD · weekly goal · bookings remaining · daily pace · calls · calls over 2 minutes · conversation conversion · assigned lead conversion · individual rep performance · team performance · leads the team actually has to work today · Family vs Animalia lead volume · lead budget usage · available Acuity appointment slots. Then clicks COPY REPORT and pastes the completed Daily CC Report into Slack or email.

PRIORITY: Build the integration, attribution, work-date logic, and metric calculations correctly BEFORE over-designing the interface. There must be one source of truth for every KPI.
