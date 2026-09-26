# Availability Tab — Functional + UX Specification (owner, 2026-09-26)

Authoritative spec from the owner. Build order: Acuity integration + availability calculation FIRST, then render per this design. This page has not been fully built yet.

## HARD CONSTRAINTS
- Use the same visual language as redesigned Today / Reps / Team pages.
- Do NOT modify unrelated backend logic, HighLevel logic, Google Sheets logic, existing metric formulas, or existing dashboard pages.
- Acuity Scheduling is the PRIMARY source of truth for studio appointment availability. Use REAL Acuity data once connected (ACUITY_USER_ID, ACUITY_API_KEY already saved as secrets). Do not expose credentials in the UI.
- Do not fabricate availability. Do not mix demo slots with live Acuity data once live mode is enabled.
- All availability calculations in America/New_York. Never browser/Christopher's local/UTC. Display times in ET.

## PURPOSE (operational tool, not a calendar viewer)
1. How many appointment openings today?
2. Openings over the next several days?
3. Which dates most need filling?
4. Exact open appointment times?
5. Studio capacity vs booked capacity?
6. Which appointment types/calendars have availability?
7. What should the CC team push right now?

## ACUITY INTEGRATION
Pull: Appointment ID, client info where necessary, created timestamp, appointment date, start time, end time, duration, appointment type + type ID, calendar + calendar ID, status, cancellation status, reschedule status, blocked times, available appointment times where the API exposes them.
Configure: studio hours, appointment duration, slot interval, padding before/after, included calendars, included appointment types (Settings-configurable; never guess business hours or durations).

## SOURCE OF TRUTH
Acuity authoritative for: existing appointments, status, cancellations, reschedules, appointment types, calendars. If Acuity exposes availability directly, use it. Otherwise calculate from: configured studio hours + included calendars + appointment duration + slot interval + existing Acuity appointments + blocked periods + recurring blocks + padding rules.

## EQUATION (accuracy standard)
Acuity appointments + availability rules + blocked periods = displayed availability.
No phantom openings. No double bookings. No slots during blocked times. No wrong timezone. No stale cancelled appointments occupying capacity.

## PAGE HEADER
"Availability" / "Studio Appointment Availability". Context: "Today · Sat, Sep 26 · America/New_York". Date controls: Today, Tomorrow, This Week, Next 7 Days, Custom Range. Filters: Acuity Calendar, Appointment Type (compact, consistent with other tabs).

## TOP SUMMARY KPIs (hierarchy — Open Today / Open Tomorrow dominant)
Open Slots Today, Open Slots Tomorrow, Open Slots Next 7 Days, Total Capacity, Booked Slots, Utilization %.

## AVAILABILITY STRIP (next 5–7 operational days)
Per day: Day, Date, Open slot count, Booked/total capacity, Utilization %. Subtle visual emphasis for opportunity (Nearly Full vs Needs Bookings) — NO aggressive red/green. Clicking a day updates the detail panel. Horizontally scrollable on mobile.

## DAY DETAIL PANEL (for selected day)
Date, Total Capacity, Booked, Open, Utilization; then OPEN TIMES as compact chips (e.g. 10:00 AM, 11:30 AM, 1:00 PM...). No booking functionality in V1 — visibility tool.

## BOOKED VS OPEN TIMELINE (optional but wanted)
Compact day timeline: 9:00 BOOKED · 10:00 OPEN · ... — simple scan layout, not a full calendar UI.

## BOOKING OPPORTUNITIES / DATES TO PUSH
Rule-based panel from ACTUAL availability numbers (NOT AI): dates sorted by open capacity/utilization. e.g. "Sun Sep 27 — 8 openings".

## CAPACITY STATUS LABELS (configurable thresholds, no letter grades)
Full: 100% · Nearly Full: 85%+ · Healthy: 60–84% · Needs Bookings: <60%.

## COPY ACTIONS
COPY AVAILABILITY (selected date): "Saturday Availability / 5 appointments remaining: 10:00 AM / 11:30 AM / ...". Also COPY FOR SLACK multi-day summary: per-day openings + "Best dates to push" (from actual open capacity).

## FILTERS
All/specific Included Calendars; all/specific Included Appointment Types. If types have different durations, availability must respect the selected type's duration.

## CANCELLATIONS / RESCHEDULES / BLOCKS
Cancelled → slot available again (if rules allow); never count cancelled as booked. Rescheduled → free old slot, occupy new. Dedupe appointments. Respect Acuity blocks, manual blocks, recurring blocks, closed periods, padding — blocked periods NEVER appear as open.

## DATA FRESHNESS
Subtle Acuity status: Connected · Last synced Xm ago; Refresh/Sync Now; "Updating availability..." while syncing; "Availability may be outdated." when stale; "Acuity connection required." + NO fake slots when disconnected.
Near real-time: background sync (not per-page-load hammering); manual Sync Now.

## AVAILABILITY AUDIT (admin/debug)
Per selected day: Configured Capacity / Acuity Booked Appointments / Blocked Slots / Calculated Open Slots + source appointment IDs and calculated times. Admin/debug view, not prominent.

## LAYOUT (desktop first, info above the fold)
Header + date/filter controls → Top KPI summary → 7-day availability strip → Selected Day Detail (open slots + booked/capacity) → Booking Opportunities → optional timeline. Minimal scrolling.
Responsive: strip h-scrolls, slots wrap, filters collapse, day detail stacks.

## DESIGN LANGUAGE
Warm white / soft off-white background; dark charcoal type; restrained accents; minimal borders; strong hierarchy; high density; premium internal dashboard. AVOID: generic SaaS calendar, huge empty cards, rainbow colors, over-rounded consumer styling, excessive gradients, AI-themed visuals.

## DO NOT ADD
CRM, client messaging, employee scheduling, complex appointment editing, AI recommendations, payments/revenue, full Acuity replacement, large calendar management.

## SUCCESS STATE (≈10 seconds)
Open today? Open tomorrow? Days with most room? Days nearly full? Exact remaining times? Which dates to push?
