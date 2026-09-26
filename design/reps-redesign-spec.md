# Reps Page Redesign — OWNER SPEC (2026-09-26)

> Verbatim owner brief. Redesign ONLY the Reps tab. This is primarily UX/presentation with two reporting clarifications (goal logic + team-average precision). Status: QUEUED — do not start until the Phase 3 finishing pass lands.

## Redesign ONLY the Reps tab of the Mallory Portraits CC Performance Dashboard.

IMPORTANT: Preserve all working backend logic, integrations, database queries, attribution logic, provider connections, and business rules unless specifically instructed below.

Do not modify: HighLevel integration, Acuity integration, Google Sheets integration, Tiger Cloud/database architecture, Lead work date logic, Booking attribution, Metric formulas.

This is primarily a UX and presentation redesign, with two specific reporting clarifications described below.

The Reps page should visually match the redesigned Today page so the application feels like one cohesive internal operating system.

## PRIMARY PURPOSE

The Reps tab should allow Christopher to select any Client Concierge and immediately understand:

1. How much activity the rep produced
2. How many meaningful conversations they had
3. How effectively those conversations converted
4. How many bookings they generated
5. Their lead conversion
6. Their weekly goal progress
7. How they compare with the rest of the team
8. What specifically may require coaching attention

Fast to scan; useful during coaching and 1-on-1 conversations.

## DESIGN LANGUAGE

Same visual system as the redesigned Today tab: warm white / soft off-white background, dark charcoal typography, restrained accent colors, compact operational layout, strong hierarchy, minimal borders, high information density, premium internal dashboard feel.

Avoid: generic SaaS styling, excessive cards, large empty spaces, tiny gray labels everywhere, overly colorful performance indicators, AI-themed styling.

## PAGE HEADER

Show: "Reps" + "Individual Rep Performance", then selected date range + operational timezone, e.g. "Today · Fri, Sep 25 · America/New_York".

Keep existing date controls (Today, Yesterday, This Week, Last Week, This Month, Custom Range) — redesigned as a compact segmented filter control, not oversized buttons.

## REP SELECTOR

Polish the current left-side rep list into a compact Rep Selector panel. Each row: Rep Name + Bookings + Calls, e.g. "Alexis Moore — 1 booking · 10 calls".

Do NOT make the selected rep a giant solid black block; use a refined selected state consistent with the Today page.

Optionally show a real-metric performance status per row (Above Pace / Below Pace / Goal Hit / Low Conversion) — statuses must be based on real metrics, not arbitrary scoring. Selector must stay scannable as the team grows.

## REP PERFORMANCE SUMMARY

Selected rep gets a clear summary header (e.g. "Alexis Moore — Today Performance"). Organize metrics into logical groups with unequal visual weight:

PRIMARY PERFORMANCE METRICS (stronger typography): Total Bookings, Conversation Conversion, Assigned Lead Conversion, Weekly Goal Progress.

SECONDARY ACTIVITY METRICS: Total Calls, Calls Over 2 Minutes, Bookings From Calls Over 2 Minutes, Average Call Duration.

## IMPORTANT GOAL LOGIC CLARIFICATION

Rep booking goals are WEEKLY goals. Do NOT compare only the selected day's bookings against the full weekly goal.

If filter = Today: activity metrics show today's Calls / Calls Over 2 Min / Bookings / Conversion / Avg Duration — BUT Goal Progress shows: Bookings WTD, Weekly Goal, Bookings Remaining, Weekly Goal Achievement %.

Example: today bookings 1; WTD 8; weekly goal 12 → Achievement 66.7%; Remaining 4. Never show 1/12 = 8.33%.

Clearly separate SELECTED RANGE PERFORMANCE from WEEKLY GOAL PROGRESS. If the filter is This Week, selected-range bookings and WTD bookings naturally match.

## GOAL PROGRESS COMPONENT

Compact visual component: Bookings WTD, Weekly Goal, Remaining, Goal Achievement %. E.g. "8 / 12 bookings · 67% of weekly goal · 4 remaining". A simple progress bar is appropriate. Not overly decorative.

## DIFFERENCE FROM GOAL

Avoid a giant red negative number like "-11" without context. Show "4 bookings remaining" or "2 above goal" in plain operational language. Negative red only where it genuinely improves understanding.

## TEAM COMPARISON

Keep the Performance Compared With Team Average section; redesign as a cleaner comparison table. Columns: Metric | Rep | Team Average | Difference. Metrics: Total Calls, Calls Over 2 Minutes, Bookings From Calls Over 2 Minutes, Conversation Conversion, Total Bookings, Assigned Lead Conversion, Average Call Duration.

## TEAM AVERAGE DISPLAY PRECISION

Do not visually round team averages so aggressively that displayed values no longer explain the difference calculation. If actual team avg calls = 5.6, display "Team Avg: 5.6", not "6" next to "+78.6%".

- Count-based averages: one decimal place when needed.
- Percentages: one decimal place.
- Percentage-rate differences: percentage points (e.g. Rep 16.7%, Team 72.0%, Difference −55.3 pp).
- Call duration: minutes and seconds.

## TEAM AVERAGE RULE

Preserve existing behavior: selected rep is EXCLUDED from the team average. Make that clear but subtle — small note: "Team average excludes the selected rep."

## COACHING INSIGHT PANEL

Add a compact section above the comparison table called "Coaching Focus". Rule-based from existing metrics — NO fake AI analysis. Up to 3 relevant observations, e.g.:

- "Conversation conversion is 12.4 percentage points below team average."
- "Call volume is above team average but booking conversion is below average."
- "Rep is 3 bookings behind weekly pace."
- "Meaningful conversation volume is strong."
- "Assigned lead conversion is above team average."

If nothing noteworthy: "No major performance flags for the selected period."

Purpose: help Christopher quickly identify what to coach.

## VISUAL PRIORITY

1. Bookings
2. Conversation Conversion
3. Assigned Lead Conversion
4. Goal Progress
5. Calls Over 2 Minutes

Total Calls and Average Call Duration are supporting metrics — visible but not dominant.

## LAYOUT

Desktop: top = page header + date controls. Main = left narrow column (rep selector) + right main column (selected rep summary, primary performance metrics, weekly goal progress, secondary activity metrics). Below: Coaching Focus, then Performance Compared With Team Average.

Reduce vertical scrolling vs current layout; the main rep performance story should fit primarily above the fold.

## RESPONSIVE BEHAVIOR

Desktop first. Smaller screens: rep selector becomes dropdown/horizontal selector; KPI grids stack intelligently; comparison table may horizontally scroll.

## DO NOT ADD

No AI scoring, letter grades, employee rankings, gamification, call transcription, CRM functionality, training modules, messaging, or tasks. This page is for rep performance analysis and coaching visibility.

## SUCCESS STATE

Christopher selects a rep and within ~10 seconds understands: activity produced, meaningful conversations, bookings generated, conversation conversion efficiency, assigned-lead conversion efficiency, weekly goal progress, team comparison, and what to coach.

Make the Reps page feel like the natural second page of the same design system established on Today.
