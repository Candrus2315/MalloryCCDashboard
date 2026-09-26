# MALLORY CC PERFORMANCE DASHBOARD — OWNER SPEC (SOURCE OF TRUTH)

Lightweight internal web app for the Mallory Portraits Client Concierge (CC) team.

It is NOT a CRM, LMS, messaging app, employee management system, task manager, or AI coaching platform. Its job is to automatically combine GoHighLevel/HighLevel, Acuity Scheduling, and Google Sheets and give Christopher one trustworthy place to see CC performance, lead volume, goals, bookings, and studio availability.

## PRIMARY NAVIGATION
Today · Reps · Team · Availability · Daily Report · Settings

Keep V1 lightweight.

## INTEGRATIONS

### HighLevel — use for
Rep/user · Contact ID · Contact name · Phone · Email · Assigned owner · Call ID · Call timestamp · Call duration · Call direction/status · Assigned leads · Opportunity/pipeline data where useful.

Calculate: Total calls · Calls over 2 minutes · Calls by rep · Average call duration · Assigned leads.

**Meaningful Conversation** = any call lasting more than 120 seconds. Default threshold 120s, configurable.

### Acuity — CORE V1 integration, not future
Appointment ID · Client name · Phone · Email · Appointment creation timestamp · Appointment date/time · Appointment type · Calendar · Status · Cancellation/reschedule status · Appointment duration · Availability · Blocked times where available.

Acuity is the PRIMARY booking and studio availability source. Christopher can select which Acuity calendars and appointment types count toward CC reporting.

### Google Sheets — lead counts
Family Sheet ID: 1_5d1TDrOLg_E3RICEY6M7K9wnM97M9wkHLUN-C0oIvg
Animalia Sheet ID: 1Zp_ghywl-u4e13NHMoPRubZ9DCZC-Khv1ePL6PVahZU

Allow configurable column mapping instead of hardcoding columns.

Metrics: Family Leads Today · Animalia Leads Today · Total Leads Today · Weekly Leads · Weekly Lead Budget · % Budget Used · Leads Remaining. Default weekly lead budget = 700, editable.

## CRITICAL LEAD DATE LOGIC

"Leads Today" does NOT mean leads generated today. It means leads the CC team is expected to WORK today.

- Tuesday–Friday: today's working leads = leads received on the PREVIOUS calendar day. (Tue=Mon, Wed=Tue, Thu=Wed, Fri=Thu.)
- MONDAY RULE: Monday working leads = all leads received previous Friday + Saturday + Sunday. Example: report date Monday 9/28 pulls sheet records dated Fri 9/25, Sat 9/26, Sun 9/27 from BOTH sheets.

Never simply filter Google Sheets for today's date. Create one centralized function such as getLeadCohort(reportDate). Store BOTH:
- source_date = actual date lead entered sheet
- work_date = date team is expected to work it

Operational reporting uses work_date. Historical reporting can use source_date. Use America/New_York for all Mallory operational date logic.

## BOOKING ATTRIBUTION

Booking Attribution Engine connecting HighLevel calls with Acuity appointments. Match contacts by priority: 1) Contact ID 2) Phone 3) Email.

A booking counts as "Booking From Calls Over 2 Minutes" when: a rep had a call with that contact longer than 120 seconds AND the appointment was created within the configured attribution window (default 24 hours). If multiple reps spoke to the client, attribute to the most recent qualifying call before the booking. If attribution is unclear, put it in UNATTRIBUTED BOOKINGS and allow Christopher to manually assign. Do not silently guess attribution.

## METRIC DEFINITIONS
- CONVERSATION CONVERSION = Bookings From Calls Over 2 Minutes / Calls Over 2 Minutes
- ASSIGNED LEAD CONVERSION = Total Bookings / Assigned Leads (always labeled "Assigned Lead Conversion")
- GOAL ACHIEVEMENT = Actual Bookings / Booking Goal

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
