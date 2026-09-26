# Settings Page Redesign — UX/IA/Presentation Only (owner, 2026-09-26)

## HARD CONSTRAINTS
- Redesign the Settings PAGE ONLY. Do NOT change backend logic, provider integrations, secret handling, data model, calculation logic, sync logic, or business rules (presentation clarity only where stated). Preserve ALL working functionality.
- Must NOT break: weekly goal editing, lead budget editing, rep goal editing, operational defaults, Acuity inclusion settings, Google Sheets mapping, studio rules, blocked times, Sync Center, manual overrides, audit trail behavior, passphrase warning logic.
- Same design language as redesigned Today/Reps/Team/Availability: warm white/soft off-white bg, dark charcoal type, restrained accents, minimal borders, strong hierarchy, compact + dense, premium internal feel. AVOID: generic admin panel, huge empty areas, heavy form fields everywhere, repeated identical white cards, excessive all-caps, long-scroll wall, colorful status noise.

## PURPOSE
Fast access to: (1) weekly goals + lead budgets, (2) rep goals, (3) operational rules/thresholds, (4) Acuity inclusion rules, (5) Google Sheets mapping, (6) studio hours + slot rules, (7) blocked times, (8) sync health/provider status, (9) manual overrides/corrections, (10) security/passphrase state. Find and update a setting without scrolling a wall.

## HEADER
"Settings" / "Operational Settings & Admin Controls" (polished subheader, e.g. "Manage goals, rules, integrations, sync health, and manual corrections."). Compact top status strip: passphrase protection, provider connection health, last sync status, sync-in-progress.

## IA — grouped sections + sticky sub-nav (desktop anchors)
1 Security & Status · 2 Goals · 3 Operational Rules · 4 Acuity Scope & Availability Rules · 5 Google Sheets Mapping · 6 Sync Center · 7 Manual Overrides · 8 Audit Trail.
Sticky sub-nav example: Security · Goals · Rules · Acuity · Sheets · Sync · Overrides · Audit.
Default expansion: Goals, Operational Rules, Sync Center expanded; Audit Trail / Advanced Mapping / Blocked Time Exceptions collapsible.

## 1. SECURITY & STATUS
Compact: Passphrase Protection Status, HighLevel/Google Sheets/Acuity status, Last Successful Sync, Sync In Progress. Passphrase warning as polished status card/banner: not configured → "Passphrase protection is not configured. Set DASHBOARD_PASSPHRASE to require a secure gate on every page." (clear, not alarming); configured → compact positive status. Answers immediately: secure? connections healthy? syncs working?

## 2. GOALS
A. Weekly Booking Goal & Lead Budget — cleaner compact editable grid: Week | Booking Goal | Lead Budget | Actions; current week highlighted with subtle badge. Feels like "weekly planning and targets."
B. Rep Goals — compact editable list/grid directly below/beside: Rep Name | Current Goal | Team Share Reference | optional "Use Team Share" control. Keep logic "leave blank to use team share" but present polished (e.g. "Allison Wittner — [custom goal field] — Default team share: 15.8"). Rows not excessively tall.

## 3. OPERATIONAL RULES
Meaningful Call Threshold, Booking Attribution Window, Operational Time Zone — compact 2–3 col layout, feel important. Timezone note tightened: "Operational Time Zone / America/New_York / Fixed because work_date and reporting are stored in ET." Polished, not a buried technical warning.

## 4. ACUITY SCOPE & AVAILABILITY RULES (major section)
A. Calendars & Appointment Types Included — cleaner selection panel, grouped checklists, better spacing/hierarchy, Save action; refine the "empty selection = all included" message so it's noticeable.
B. Studio & Availability Rules — structured area with subsections: Slot Rules (duration, slot interval, padding), Studio Hours (clean per-day row: enabled toggle + open time + close time — readable, not cluttered inputs), Recurring Blocks (manageable repeatable schedule editor), One-off Blocks (simple exception list). No huge calendar UI.

## 5. GOOGLE SHEETS MAPPING
Family + Animalia as clean side-by-side mapping cards: sheet name, sheet ID, sheet shape, field mappings, actions. Sheet shapes as clean segmented options (One row per day + lead count / One row per lead). Compact aligned mapping selectors; reduce repeated-label clutter. Keep "Test mapping (live)" as a SECONDARY utility action. Communicate: where lead data comes from, how it's interpreted, how to validate.

## 6. SYNC CENTER (operations panel, not developer table)
A. Provider Status: Provider | Connection Status | Mode | Last Sync | Last Successful Sync | Sync Errors. Consistent status vocabulary: Connected, Disconnected, Demo, Running, Error — restrained color.
B. Recent Sync Runs: Provider | Status | Started | Finished/duration | Records upserted | Errors; collapsible older runs.

## 7. MANUAL OVERRIDES (deliberate exception management)
Subsections: Unattributed Bookings / Manual Assignments / Corrections. Unattributed table: Client | Type | Created | Suggested Rep | Assign To | Action — cleaner rows, better spacing/form alignment; surface suggested rep visually. Goal: resolve exceptions fast.

## 8. AUDIT TRAIL (bottom, compact/expandable)
What changed | Previous value | New value | Who | When. Collapsible rows or condensed table — history tool, not main event.

## VISUAL PRIORITY
1 Security/connection health · 2 weekly + rep goals · 3 operational rules · 4 Acuity scope · 5 sync health · 6 manual overrides. Sheets mapping + audit important but slightly less dominant.

## MICROCOPY
Polished labels: Weekly Booking Goal & Lead Budget · Rep Goals · Operational Rules · Acuity Reporting Scope · Studio Hours & Slot Rules · Google Sheets Mapping · Sync Center · Manual Overrides · Audit History. Shorten explanations; keep meaning.

## INTERACTION QUALITY
Clear save buttons, logical grouping, inline feedback after save, cleaner toggles/checkboxes, better input widths, consistent button hierarchy. Primary (Save) visually obvious; utility (Test Mapping) secondary; dangerous/security actions clearly differentiated.

## DO NOT CHANGE BEHAVIORS OF
Weekly goal history · rep goal inheritance from team share · meaningful call threshold · booking attribution window · operational timezone · Acuity inclusion logic · Sheets mapping behavior · sync execution/logging · manual override persistence · audit logging. Presentation + admin usability redesign, NOT a business logic rewrite.

## DO NOT ADD
Developer controls beyond current, raw secret values in UI, technical debugging clutter on main surface, AI recommendations, gamification, complex access control, modal overload.

## SUCCESS STATE
Quickly: check system/security status · update weekly goals · adjust rep goals · review/edit operational defaults · control what Acuity data counts · manage studio rules + blocked times · verify Sheets mapping · see sync health · resolve unattributed bookings · review audit history. Same product as Today/Reps/Team/Availability; large admin surface feels organized.
