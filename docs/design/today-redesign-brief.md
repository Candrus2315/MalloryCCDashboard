# OWNER BRIEF — TODAY TAB REDESIGN (verbatim, 2026-09-25)

Redesign ONLY the Today tab of the Mallory Portraits CC Performance Dashboard.

IMPORTANT:
Do NOT change any backend logic, calculations, integrations, database structure, data fetching, business rules, or metric definitions.
Do NOT alter the lead work date logic.
Do NOT alter GHL, Acuity, Google Sheets, or Tiger Cloud integration behavior.
Do NOT change any API wiring.
Do NOT rename core metrics unless explicitly stated below for clarity in the UI.
This is a presentation and UX redesign of the Today page only.

The current Today tab has the right information, but the UX is too flat, too spaced out, and does not guide the eye to what matters most.
It currently feels like a wireframe or admin template instead of a real internal command center.

The goal is to redesign the Today tab so Christopher can open it in the morning and within 10 seconds understand:

1. Are we on pace for the weekly booking goal
2. What happened yesterday and today
3. How calls and conversion are performing
4. How many leads the team is working today
5. Which studio dates and times need to be pushed
6. Which reps are performing well and which reps need attention

## TODAY TAB REDESIGN GOALS
The redesigned Today tab should feel like a premium internal operating dashboard.
It should feel: Clean · Modern · High signal · Operational · Manager friendly · Fast to scan · Not flashy · Not like a generic SaaS template.
Reduce empty white space. Reduce excessive use of small gray uppercase labels. Increase information density without making it crowded. Use stronger visual hierarchy so the most important metrics stand out immediately.

## DESIGN DIRECTION
Use a refined internal dashboard style.
Visual characteristics: Warm white or soft off white background · Dark charcoal typography · Restrained accent color · Very light dividers · Clean cards or grouped panels · Compact but readable tables · Strong spacing rhythm · Large KPI typography · Subtle emphasis for important or at risk data.
Avoid: Overly colorful UI · Heavy gradients · AI themed styling · Rainbow status colors · Overly rounded consumer app styling · Generic template feel.

## INFORMATION HIERARCHY
The Today tab should be reorganized into 5 clear sections in this order:
1. Header and context
2. Primary performance KPIs
3. Secondary operations row
4. Lead load and availability
5. Rep performance and management attention

## 1. HEADER AND CONTEXT
At the top show: Today · Current date · Week context.
Example: Today — Fri, Sep 25 — Week of Mon, Sep 21.
Directly under the header, include a subtle operational context line showing the lead work date logic result.
Example: "Today's lead cohort: leads received on Sep 24 (America/New_York)".
If Monday, this should reflect the Fri to Sun cohort logic.
If there are provider issues or demo mode issues, show a compact status banner, but make it more polished and less visually clunky than the current warning.

## 2. PRIMARY PERFORMANCE KPI ROW
This row should be the dominant visual section.
These KPIs should be the most visually important items on the page: Bookings WTD · Bookings Remaining · Daily Pace Needed · Goal Achievement % · Yesterday's Bookings · Bookings Today.
This row should immediately tell Christopher whether the team is on pace to hit the weekly goal.
Recommended treatment: Large number · Smaller supporting label · Very short subtext if needed.
Examples: Bookings WTD → "51 of 79 goal" · Remaining → "28 bookings left" · Daily Pace Needed → "10 to hit goal" · Goal Achievement → "64.6%".
Use subtle positive, neutral, or at risk visual indicators, but do not overdo color.
(Owner-ratified semantics: Goal Achievement = actual WTD bookings ÷ weekly booking goal — e.g. 37/79 = 46.84%.)

## 3. SECONDARY OPERATIONS ROW
Below the primary KPIs, show a second grouped section for call and conversion performance.
Include: Total Calls Today · Calls Over 2 Minutes · Average Call Duration · Conversation Conversion · Assigned Lead Conversion.
This section should be visually secondary to the booking goal section, but still clearly readable. It should feel like operational diagnostics.
If possible, include a subtle mini comparison to week average or team average where already available, but do not create new calculations if they do not already exist.

## 4. LEAD LOAD AND AVAILABILITY
This section should combine lead demand and studio availability in a way that helps Christopher direct the team.

A. Lead Load Block — show: Family Leads Today · Animalia Leads Today · Total Leads Today · Weekly Leads · % Lead Budget Used · Leads Remaining · Daily Leads Needed. This block should make it easy to understand how much work volume the team has.

B. Studio Availability Block — the current version uses two oversized white boxes for today and tomorrow. Redesign this into something more compact and more useful.
Preferred direction: Show a compact availability strip or row of day cards for at least Today · Tomorrow · Next several days if data exists.
Each day card should show: Day name · Open slot count · Optional total capacity or utilization if already available.
Example: Today "5 open" · Tomorrow "4 open" · Sun "7 open" · Mon "2 open".
When a day is selected or hovered, show the specific available time slots in a clean secondary panel or expandable area.
The available time chips can remain, but the layout should feel tighter and more intentional.
Make the low availability days stand out subtly so Christopher knows what needs to be pushed.

## 5. REP PERFORMANCE AND MANAGEMENT ATTENTION
This is one of the most important sections of the Today tab.

A. Management Attention Panel — above the rep table, add a compact panel called something like "Management Attention" / "Needs Attention Today" / "Focus Areas".
This should be rule based and presentation focused. Do NOT invent fake AI insights. Use logic based on existing metrics.
Examples of useful row level summaries:
- Rep below team average in conversation conversion
- Rep behind weekly booking pace
- Rep has strong call volume but weak booking conversion
- Rep has already hit or exceeded goal pace
This panel can surface 3 to 5 short management notes.

B. Rep Performance Table — keep the rep table, but redesign it to feel cleaner, tighter, and more useful.
Current columns: Rep · Total Calls · Calls > 2 Min · Bookings From > 2 Min · Total Bookings · Conversation Conversion · Assigned Lead Conversion · Avg Call · Goal % · Goal / Actual.
Improve this table significantly.
Prioritize these columns visually: Rep · Total Bookings · Conversation Conversion · Assigned Lead Conversion · Goal % · Actual vs Goal.
Secondary columns: Total Calls · Calls > 2 Min · Bookings From > 2 Min · Avg Call Duration.

IMPORTANT: Change the display label from "Goal / Actual" to "Actual / Goal" if the values are shown in actual first format. The current presentation is confusing.
Example: Instead of "14 / 16" under Goal / Actual, show "16 / 14" under Actual / Goal.

Enhance the table with: Sticky header if useful · Better row spacing · Cleaner alignment · Subtle row hover · Sortable columns · Better number emphasis.

For each rep row, add a compact performance indicator or short status chip, such as: Above team average · Below pace · Goal hit · Strong converter · Needs coaching.
Do not create arbitrary letter grades.

If possible, also show a subtle delta vs team average in a compact way for key columns such as Conversation Conversion · Assigned Lead Conversion · Bookings.
Example: "64.0%  +18.2 pts vs team". Make this visually lightweight.

## LAYOUT GUIDELINES
The Today page should fit far more useful information above the fold. It should not require excessive scrolling for core management insight.
Recommended layout: Header → Primary KPI row → Secondary call and conversion row → Lead and availability section → Management attention panel → Rep performance table.
Use a responsive grid but optimize primarily for desktop manager use.

## COMPONENT QUALITY
Polish each component so it feels intentionally designed.
Examples: Cards should have cleaner padding and hierarchy · Labels should be smaller and more refined · Numbers should be dominant where appropriate · Subtext should be concise · Spacing should be tighter but still breathable · Section headings should be clear and not oversized · Status and warnings should feel integrated, not bolted on.

## KEEP THESE EXISTING DATA CONCEPTS
Preserve and clearly display the following concepts exactly as they already exist:
Weekly booking goal pacing · Yesterday versus today · Calls over 2 minutes · Conversation conversion · Assigned lead conversion · Lead work date logic · Family versus Animalia lead split · Weekly lead budget usage · Open appointment slots · Rep performance ranking.
Do not alter the logic behind any of them.

## OUTPUT EXPECTATION
Redesign only the Today tab UI and UX. Keep all existing data logic intact. Make it feel like a high quality internal management command center. The result should be more compact, more polished, more actionable, and much easier to scan in the morning.
If needed, create improved component structure, grouping, and hierarchy.
Do not redesign the Reps, Team, Availability, Daily Report, or Settings pages in this step. Focus only on the Today tab.
