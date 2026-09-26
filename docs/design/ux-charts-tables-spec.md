# UX SPEC — Charts, Tables & Data Interaction (owner brief, 2026-09-26, verbatim)

> AUTHORITATIVE OWNER DIRECTIVE. Presentation/interaction/usability only.
> HARD EXCLUSIONS — do NOT change: integrations; centralized metrics engine; week/date logic;
> metric definitions; reconciled call data; attribution logic.
> Companion specs: design/data-terminology.md (Non Roster/Unattributed labels, call_start_date
> "Not Yet Active"), design/week-cadence-lockin.md (historical week selector, context preservation),
> design/appearance-spec.md (dark theme — build charts/tables dark-aware).

## 1. MAKE ALL TREND CHARTS INTERACTIVE
Hover/scrub on all applicable charts: highlight nearest data point, active dot/marker, subtle
vertical guide line through selected date, floating tooltip with exact date + exact value.
Snap horizontally to nearest day's data — no pixel-perfect aiming. Clean compact tooltips, e.g.:
"Sep 24 / 402 calls" or "Sep 24 / 402 calls / +8.4% vs previous day". No information overload.

## 2. CLICK TO DRILL DOWN
Where supporting raw data exists, clicking a chart point opens inspection of what created the
number. Consistent pattern: right-side detail drawer (or similarly lightweight panel) — never
navigate away. Examples:
- CALLS: click Sep 24 → call detail for Sep 24: Rep, Time, Contact (if available), Direction,
  Duration, Status, HighLevel call/message identifier where appropriate.
- CALLS OVER 2 MIN: click Sep 24 → only qualifying calls (duration >120s).
- BOOKINGS: click Sep 24 → bookings attributed to that date: Rep, Appointment/client where
  appropriate, Appointment type, Appointment date/time, Attribution status.
- CONVERSATION CONVERSION: show components behind the rate ("14 bookings from qualifying calls /
  38 calls >2 min / 36.8%"). Never a bare percentage without numerator+denominator.
- ASSIGNED LEAD CONVERSION: total bookings, assigned leads, resulting conversion. If denominator
  unavailable/unverified, continue displaying "unavailable" — never invent a rate.
- AVG CALL DURATION: average duration + number of calls included.
- LEAD VOLUME: hover = Date, Family leads, Animalia leads, Total leads, Budget pace; click =
  inspect that day's lead cohort when underlying lead rows are available.

## 3. PRESERVE PAGE CONTEXT DURING DRILL DOWN
Drill-down must preserve current dashboard context: historical week (e.g. Historical · Week of
Sep 21 → clicking Sep 24 stays in that historical week, never silently returns to Current Week),
selected rep, selected date range, selected filters, operational/historical state. Closing the
drawer returns exactly where the user was.

## 4. CHART VISUAL REDESIGN
Clean minimal direction kept; charts more polished and useful. Current charts have too much empty
card space — improve: chart height, plot utilization, axis readability, spacing, tooltip design,
active point treatment, hover states, labels. Chart occupies more of its card. NOT flashy: no 3D,
no heavy gradients, no excessive grid lines, no neon, no animations that slow analysis, no large
legends, no clutter. Restrained animation for hover only.

## 5. PARTIAL / INCOMPLETE DAY TREATMENT
Partial current day ≠ completed historical day. If Today is in progress, mark its datapoint
partial ("Today · In Progress" or subtle open marker) so a chart dropping toward zero from
partial elapsing isn't misread. Closed/non-working days distinguishable from true zero-performance
working days where appropriate.

## 6. TEAM BY REP TABLE REDESIGN
Modern management performance table, not a spreadsheet. Preserve metrics; improve hierarchy.
Rep column visually dominant; consistent numeric alignment; intentional spacing/row height;
subtle row hover; sticky header on scroll; rep name stays visible on horizontal scroll; sortable
columns visibly sortable without arrows filling every header.

## 7. REDUCE TABLE DENSITY
Primary metrics in the main table: Rep, Bookings, Goal Progress, Calls, Calls >2 Min,
Conversation Conversion, Average Call Duration. Secondary info via expanded row / view details /
tooltip / drill-down drawer. Scan the team in seconds.

## 8. GOAL PROGRESS SHOULD BE VISUAL
Compact visual progress treatment: "Bookings 8 / 15.8" + [progress bar] + "50.6%". Exact numbers
stay visible; visualization supplements, never replaces.

## 9. PERFORMANCE STATUS CHIPS (INCLUDES BUG/LOGIC AUDIT)
Reduce chip noise — badges communicate meaningful states only (Strong Conversion, Needs
Attention, No Activity, Not Yet Active, Goal Met). No positive badge unless the metric qualifies.
AUDIT THIS BUG: reps currently show "Strong converter" while displaying 0.0% Conversation
Conversion and 0.0 pts vs team — semantically wrong. A rep must NOT get "Strong converter" merely
because all reps are at zero or the team comparison has no meaningful sample. Only show Strong
Converter when: valid conversion denominator AND minimum qualifying sample threshold satisfied
AND rep actually exceeds the defined comparison threshold. Otherwise show NO positive chip (do
not auto-substitute a negative chip).

## 10. NEW REP STATUS
Respect call_start_date / activation logic (see design/data-terminology.md): before start date =
"Not Yet Active" — never "No Activity", "Needs Attention", or "Underperforming". Applies to Dan
before his Monday call start; normal logic begins at call_start_date.

## 11. REP DETAIL COMPARISON TABLE
"Performance Compared With Team Average" redesign: each row makes Metric / Selected Rep / Team
Average / Difference immediately obvious. Restrained indicators where useful. Don't overuse
green/red; don't exaggerate positive styling for large percentages from tiny denominators
(e.g. Rep 4 vs team avg 0.5 = +700% is valid math but misleading signal — keep exact math,
restrain the visual treatment when sample is very small).

## 12. ROW CLICK / REP DRILL DOWN
Rep rows feel interactive: subtle hover affordance; clicking opens the rep's detailed performance
context. From Team: click Allison Wittner → Reps page → Allison auto-selected → selected
week/date range preserved. Never make Christopher reselect rep and period manually.

## 13. COMMON DETAIL DRAWER
One reusable drawer pattern for: call records, qualifying calls, bookings, lead records, metric
explanations, audit detail. Includes: clear title, current date/date range, current rep when
applicable, record count, filters when useful, close button, scrollable body. Admin/audit views
may show source identifiers; NEVER expose secrets or API credentials.

## 14. TOOLTIP AND CURSOR BEHAVIOR
Interactivity must be visually communicated: pointer cursor where clickable, subtle row hover,
highlighted chart point, crosshair/guide line, tooltip, selected state. Users never guess what
is interactive. Keyboard focus and touch/tap where practical.

## 15. RESPONSIVE TABLE BEHAVIOR
Don't shrink columns until unreadable. On narrow screens: prioritize primary metrics, horizontal
scroll when genuinely needed, rep identity anchored, lower-priority info into expanded details.
Don't destroy desktop usability to fit mobile.

## 16. DATA TRUST MUST REMAIN VISIBLE (HARD RULE)
Every drill-down resolves to the SAME normalized records used by the metric. If Team says
"106 Calls >2 Min", the qualifying-call records behind the drill-down must reconcile to 106 for
the exact same selected range. NO separate drill-down query with different filtering logic.
SOURCE RECORDS = NORMALIZED DB RECORDS = DISPLAYED METRIC = DRILL-DOWN RECORDS.

## 17. DESIGN INTENT
Executive management dashboard: fast to scan, interactive, calm, premium, data-dense without
feeling crowded, operational not decorative. NOT: spreadsheet-in-a-website, static PDF, generic
analytics template, developer admin panel, disconnected cards. Build on the existing Today-page
visual language; substantially improve interaction and information hierarchy of charts/tables.

## 18. DO NOT HOLD UP THE EXISTING BUILD
UX work continues alongside reconciliation/week-cadence work. Do not undo the verified data
architecture. Presentation sits on top of the existing trusted metrics engine.
