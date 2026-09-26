# GLOBAL LAYOUT SYSTEM REVISION (owner brief, 2026-09-26, verbatim)

> QUEUE POSITION: LAST — owner directive: "the last thing we do after all backlog is finished."
> All other backlog items (accuracy, terminology, UX charts/tables interaction, week cadence,
> availability, attribution, settings redesign, dark theme) complete BEFORE this pass begins.
> HARD EXCLUSIONS — do NOT change: backend architecture; integrations; metric definitions;
> reconciliation logic; date/week logic. This is a global layout + information-design pass only.
> Companion specs: design/ux-charts-tables-spec.md, design/appearance-spec.md,
> design/settings-redesign-spec.md, design/availability-spec.md, design/data-terminology.md.

## CORE PRINCIPLE
Do NOT design by asking "What can fit beside this?" Design by asking "What information belongs
together, how important is it, and how much space does it actually need?" Layout is CONTENT
DRIVEN, never SPACE FILLING. Never stretch a component because unused horizontal space exists;
never squeeze a component because another sits in the same row.

## DESKTOP MANAGEMENT EXPERIENCE
Primary experience: full-size desktop (~1280 / 1440 / 1600px+). Responsive afterward.
Consistent centered application content area with intentional max width (no infinite stretch on
large monitors). Sensible page gutters + section spacing. Composed, not stretched.

## GLOBAL LAYOUT GRID (reusable)
- FULL WIDTH: important operational components benefiting from horizontal visibility (studio
  availability, large trend visualizations, rep performance, daily report output, major tables).
- TWO-THIRDS / ONE-THIRD: only when one component is clearly primary, the other genuinely secondary.
- HALF / HALF: only when both components have comparable density and importance.
- COMPACT STRIP: small KPI groups.
- STACKED: when components do not meaningfully belong side by side.
- Never auto-pair components just because there are two of them.

## STOP FORCING EQUAL CARD HEIGHTS
Cards use the height their content requires; no growing vertically to align bottom edges
(a 5-metric lead summary may need 180px; a complex availability visualization 300px — do not
stretch the former to 300px). Alignment must not create wasted space.

## REDUCE THE NUMBER OF BOXES
Hierarchy via spacing, typography, dividers, background shifts, section headers, alignment —
not continuous card-in-card nesting. Strong card containers only for genuinely distinct modules.
Instead of Large card → smaller card → metric box + pill, prefer Section → metric row → subtle
divider → interactive detail. Lighter, more intentional.

## WIDTH BY INFORMATION DENSITY
- A single KPI does not need 25% of the screen.
- A seven-day availability outlook DOES need substantial horizontal space.
- A detailed performance table should usually be full width.
- A small warning panel does not automatically need full width unless content is substantial.
- A chart needs enough width for its trend to be readable.
Components are not interchangeable grid blocks.

## KPIs COMPACT
KPI sections = compact horizontal strips (Bookings WTD, Remaining, Pace Needed, Goal Achievement,
Yesterday, Today) — one cohesive KPI system via typography + spacing, not six unrelated giant
cards. Avoid unnecessary outer-card height.

## CHART LAYOUT
Charts sized to what is analyzed. Small related trends: deliberate 2- or 3-column analytical grid
depending on width and complexity — never four tiny charts just to fit a row; if a chart is too
narrow to interpret comfortably, move it to the next row. Important charts (Lead Volume, Booking
Trend, Team Performance) span wider areas. Readability over symmetric placement.

## TABLE LAYOUT
Tables generally need horizontal room — never performance tables inside narrow side columns.
Primary management tables usually span available content width. Reduce columns before reducing
readability; secondary data in expanded rows / detail drawers rather than 10+ squeezed columns.

## EMPTY SPACE
Empty space is allowed — unused screen area is not a design failure. Intentional breathing room
beats adding width/height/cards to fill the canvas. Distinguish intentional whitespace (between
sections) from wasted space (giant blanks inside components from unnecessary fixed heights).

## SECTION RHYTHM
Every page follows a vertical information hierarchy: page context/filters → primary KPIs →
primary operational information → secondary analysis → management actions/attention → detailed
records. The page answers in order: Where are we? Are we on target? What's happening? What needs
attention? Where can I investigate further? Modules are never arranged primarily by which
rectangles fit beside each other.

## PAGE EXAMPLES (informational hierarchy, not rigid same-dimension requirements)
- TODAY: header/live state → weekly performance KPIs → Calls & Conversions Today → Studio
  Availability (full width) → Leads Worked Today (compact strip) → Management Attention →
  Rep Performance (full width).
- TEAM: week context → team KPIs → goal & pacing → performance trends → lead volume → rep
  comparison table → management attention/insights. Charts get room to be useful; no numerous
  equal-size cards for symmetry.
- REPS: rep + range selector → weekly goal progress → current-period activity → conversion/
  efficiency metrics → Coaching Focus → Comparison With Team → trend history → raw/drill-down
  detail on request. One coherent rep performance story.
- AVAILABILITY: structured around "Where does the team need bookings?" — upcoming days, capacity,
  open slots, utilization, Dates to Push. No grid of equally sized cards when days/info need
  different emphasis.
- SETTINGS: structured by category, clear sections, collapsible groups — not every setting its
  own card.

## RESPONSIVE RULE
Desktop composition first. At narrower widths reflow intentionally (two-column → stacked;
seven-day strip → horizontal scroll; wide table → key columns + detail) — never shrink
everything proportionally.

## GLOBAL DESIGN REVIEW CHECKLIST (apply to every current page)
Unnecessary fixed heights; unnecessary equal-height cards; arbitrary two-column layouts; large
internal blank areas; cramped important components; nested card clutter; overly wide small
components; tables squeezed into insufficient width; charts made too narrow to read. Correct
these patterns with the new layout system. Do not rebuild working functionality — layout
composition and information hierarchy only.

## DESIGN TARGET
A deliberately composed management operating system. NOT a collection of cards arranged by an
auto-grid; NOT a website trying to fill every pixel; NOT a spreadsheet with rounded corners.
Every component looks exactly where it belongs, at the size it needs to be.
