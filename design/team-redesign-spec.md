# Team Page Redesign — OWNER SPEC (2026-09-26) — "Phase 6"

> Verbatim owner brief. Redesign ONLY the Team tab. UX/presentation only. Status: QUEUED — runs after the Reps page redesign.

## Scope guardrails

Redesign ONLY the Team tab. Do NOT change backend logic, database structure, integrations, API wiring, business rules, or metric calculations unless explicitly stated below for presentation clarity. Do NOT modify: HighLevel integration, Acuity integration, Google Sheets integration, Tiger Cloud or database architecture, Lead work date logic, Booking attribution logic, Meaningful call threshold logic, Goal formulas, Trend formulas.

The current page feels too flat, too spaced out, and too much like a raw analytics wireframe. It needs to feel like an executive team performance dashboard that helps Christopher quickly understand how the CC team is performing this week and what needs attention. Visually match the redesigned Today and Reps pages so the product feels like one cohesive internal operating system.

## PRIMARY PURPOSE

1. How the team is performing overall
2. Whether the team is on pace for the weekly booking goal
3. How calls and meaningful conversations are trending
4. How bookings and conversion are trending
5. Whether lead volume is healthy relative to budget pace
6. Which reps are driving results
7. Where the team may need management attention

This page should function as the executive team summary view.

## DESIGN LANGUAGE

Same visual language as Today and Reps: warm white / soft off-white background, dark charcoal typography, restrained accent color, minimal borders, strong hierarchy, high information density, clean premium internal dashboard feel, clear section grouping, compact but readable charts and tables.

Avoid: generic SaaS template styling, too much empty space, excessive all-caps gray labels, overly colorful visuals, heavy gradients, AI-themed styling, overdesigned decorative charts.

## PAGE HEADER

"Team" + "Team Performance", with contextual subheader: selected date range + operational timezone, e.g. "This Week · Mon, Sep 21 to Fri, Sep 25 · America/New_York".

Keep existing date controls (Today, Yesterday, This Week, Last Week, Last 7 Days, Last 30 Days, This Month, Custom Range) — redesigned as a tighter segmented filter control consistent with the rest of the app.

## ALERT / DATA STATE TREATMENT

Keep the logic of the Assigned Lead Conversion unavailable warning but make it cleaner and more integrated: a compact inline notice near that metric or in a subtle alert area. Plain language: "Assigned Lead Conversion unavailable for this range because no assigned leads were worked." Never louder than the page's actual performance story.

## PAGE STRUCTURE (in this order)

1. Header and date controls
2. Team performance summary
3. Goal pacing summary
4. Trends
5. Lead volume and lead budget pacing
6. Team by rep table
7. Team attention or key takeaways

## 1. TEAM PERFORMANCE SUMMARY

Top visual summary. Primary team metrics: Total Bookings, Total Team Calls, Calls Over 2 Minutes, Bookings From Calls Over 2 Minutes, Team Conversation Conversion, Assigned Lead Conversion, Average Call Duration.

Do NOT make all KPIs equal in visual weight. Primary visually dominant: Total Bookings, Goal Achievement, Bookings Remaining, Daily Pace Needed. Secondary but important: Total Team Calls, Calls Over 2 Minutes, Team Conversation Conversion, Assigned Lead Conversion, Average Call Duration. Use concise supporting subtext where helpful.

## 2. GOAL PACING SUMMARY

Stronger dedicated weekly goal progress section answering: How close are we to 79? How many bookings remain? How many bookings per remaining working day are needed?

Show: Booking Goal, Actual, Bookings Remaining, Goal Achievement, Daily Pace Needed. Example: "51 of 79 bookings · 64.6% achieved · 28 remaining · 28 needed today". If only one working day remains, make the pace message obvious but elegant. Simple progress bar appropriate. Actual/Remaining/Achievement/Pace should feel like ONE weekly pace module, not isolated numbers.

## 3. TRENDS

Keep trend charts for: Bookings, Calls, Calls Over 2 Minutes, Conversation Conversion, Assigned Lead Conversion, Average Call Duration, Lead Volume.

Redesign so it feels like a real analytics block, not isolated wireframe cards: reduce wasted space, improve axis/label clarity, cleaner line styling, current value prominent, compact legends/notes, consistent card sizing, no large empty chart containers.

If possible, group trends into two visual rows: Performance trends; Lead and efficiency trends.

Each trend card: metric name, current selected-period value, small chart, brief note only if needed.

Sparse-data logic stays: buckets with fewer than 3 qualifying rows show blank values — but condense the explanation to e.g. "Fewer than 3 qualifying rows: value hidden." Footnotes must not overwhelm the chart.

## 4. LEAD VOLUME AND LEAD BUDGET PACING

Keep the lead volume card; make it intentional. Show: current lead volume in selected range, lead trend, lead budget pace reference line, brief (concise) explanation of work_date logic if useful.

Preferred language: "Leads by work date"; "Budget pace shown as dashed line". Keep the dashed budget pace line.

The component must clearly answer: Are we getting enough leads? Are we above or below expected pace? How does current lead load compare to budget pacing?

## 5. BY REP TABLE

Keep By Rep but redesign substantially — help Christopher quickly see which reps drive team performance.

Current columns: Rep, Bookings, Calls > 2 Min, Conversation Conversion. Recommended columns: Rep, Bookings, Calls > 2 Min, Conversation Conversion, Assigned Lead Conversion (if available), Share of Team Bookings or Goal Pace status if helpful.

Visual priority: Rep, Bookings, Conversation Conversion. Clean compact operational table with sortable columns, cleaner row spacing, subtle row hover, better alignment, refined header styling.

Optional short status chip per rep (Top performer / Below pace / Strong conversion / Needs attention) — must be based on real metrics, not arbitrary grades. NO gamification, medals, or childish leaderboard treatments.

## 6. TEAM ATTENTION / KEY TAKEAWAYS

Compact panel: "Team Attention" / "Key Takeaways" / "Management Focus". Rule-based and summary driven — NO fake AI insights. 3–5 short management notes from real metrics, e.g.:

- Team is at 64.6% of goal with 1 working day remaining.
- Daily pace needed is 28, which is above recent daily booking average.
- Conversation conversion is healthy, but lead conversion is unavailable in this range.
- Sam Patel leads the team in bookings.
- Maya Chen trails the team on bookings despite strong meaningful conversation volume.
- Lead volume is below weekly budget pace.
- Lead volume is above pace, but bookings are not converting proportionally.

Purpose: Christopher immediately knows what to act on.

## VISUAL PRIORITY

1. Weekly goal progress
2. Total bookings
3. Daily pace needed
4. Calls over 2 minutes
5. Team conversation conversion
6. Lead volume relative to budget pace
7. Top and bottom rep performance

The Team tab should feel like the operational command center for weekly team management.

## LAYOUT

Desktop: top = header + date controls; then large team summary and goal pacing block; then trend charts grouped in a structured grid; then lead volume and lead pacing; then By Rep table; then Team Attention / Key Takeaways (or place Team Attention above the By Rep table if that scans better). Reduce vertical scrolling; the most important story primarily above the fold.

## MICROCOPY / LABEL CLEANUP

Cleaner, human, still operational labels: "Calls Over 2 Minutes" (not all caps if style supports), "Team Conversation Conversion", "Average Call Duration", "Bookings Remaining", "Daily Pace Needed". Avoid overusing tiny gray uppercase labels. Retain clarity; feel premium.

## DO NOT CHANGE THESE CORE CONCEPTS

Preserve existing meaning and logic for: total bookings, meaningful calls over 2 minutes, conversation conversion, assigned lead conversion, average call duration, weekly goal, bookings remaining, daily pace needed, lead volume by work_date, weekly lead budget pacing, by-rep rollups. Do not alter the calculation layer.

## DO NOT ADD

No AI scoring, letter grades, gamification, CRM features, messaging, training, task management, call transcripts, or overly complex chart interactions. Team-level operational visibility only.

## SUCCESS STATE

Christopher opens the Team tab and within ~10 seconds understands: how the team is performing this week, whether the team is on pace to hit 79, how many bookings remain, what pace is needed, how calls and conversions are trending, whether lead volume is healthy relative to budget pace, which reps contribute most, and what needs management attention.

Make the Team tab feel like the natural third page in the same design system as Today and Reps.
