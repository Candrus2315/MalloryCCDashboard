# Today-Tab Redesign — Implementation Spec

**Sources:** `/home/team/shared/design/today-redesign-brief.md` (owner, verbatim — overrides all else) · SPEC.md DESIGN section where the brief is silent · current implementation `src/routes/index.tsx`, `src/styles/app.css`, `src/server/metrics/compute.ts`, `src/server/queries.ts`.
**Hard constraint:** presentation only. Zero changes to backend logic, calculations, data fetching, metric definitions, integrations, or API wiring. Every element composes existing metric outputs only. Where the brief asks for something the data doesn't provide, it is designed gracefully for what exists and marked **NEEDS ENGINEER SUPPORT** (§7).

## 0. Existing outputs the redesign may compose from (inventory)

From `getTodayData` → `buildTodayMetrics` (all already exist; nothing added):

- `meta.mode` ("postgres"|"memory"), `meta.dbReason`, `meta.demoSeeded`
- `cohortNote` (string, e.g. "Today's cohort = leads received on Sep 24")
- `metrics.date`, `metrics.weekStart`, `metrics.leadCohortSourceDates[]`
- `metrics.bookings`: `today, yesterday, wtd, weeklyGoal, remaining, paceNeeded, goalAchievement|null`
- `metrics.callsToday`: `total, overThreshold, avgDurationSeconds|null`
- `metrics.conversionsToday`: `conversation|null, assignedLead|null`
- `metrics.leads`: `today{family,animalia,total}, weekly{family,animalia,total}, weeklyBudget, percentUsed|null, remaining, dailyNeeded`
- `metrics.openSlots`: `{ today: string[], tomorrow: string[] }` — **today + tomorrow only**
- `metrics.repRows[]`: `repId, name, totalCalls, callsOverThreshold, bookingsFromOverThreshold, totalBookings, conversationConversion|null, assignedLeadConversion|null, avgCallDurationSeconds|null, goal, actual, goalPercent|null`
- Existing pure helpers reusable presentation-side: `formatDateHuman` ("Fri, Sep 25"), `daysLeftInWeek` (Mon=7…Sun=1, incl. today), `weekStart`, and the exported constant `TREND_MIN_DENOMINATOR = 3` (metrics layer) reused as the minimum denominator for any conversion-based rule.

**Presentation-side compositions (derived ratios of existing numbers — declared here so they are not mistaken for new metrics; no new queries, no new definitions):**
- `weekElapsedFraction = (8 − daysLeftInWeek(metrics.date)) / 7` — Mon 1/7 … Sun 7/7, including today.
- `expectedToDate(rep) = rep.goal × weekElapsedFraction`.
- Team averages per column, computed from `repRows` with the **exact semantics of the existing `buildTeamAverages`**: counts = mean over all *other* reps (zeros included); rates/durations = mean over other reps that have a value; null when none. Self always excluded. Deltas reuse the existing `teamDifference` units: rates in **percentage points**, counts in **% difference**, null when either side is null (never a fake delta).

## 1. Layout map (top → bottom, desktop-first, max-w-7xl)

The page drops its current flat "bare text + `<hr>`" structure for grouped white panels on the stone-50 canvas. Vertical rhythm: sections `space-y-5` (was `space-y-8` + 4 `<hr>`s, all removed). Shell padding `py-6` (was `py-8`). Target: primary row + secondary row + attention panel above the fold at 1440×900.

1. **Header & context**
   - Line 1: `Today` (h1, text-xl font-semibold) — ` — Fri, Sep 25 — Week of Mon, Sep 21` composed from `formatDateHuman(metrics.date)` and `"Week of " + formatDateHuman(metrics.weekStart)` (already returns weekday: "Mon, Sep 21" — matches the brief's example exactly). Date pieces `text-[15px] font-medium text-stone-500`, separators stone-300.
   - Line 2 (context line, directly under header per brief): existing `data.cohortNote` string verbatim + ` (America/New_York)` — `text-xs text-stone-500`, preceded by a 4px stone-300 dot. Reuses today's exact copy (it already renders the Monday Fri+Sat+Sun multi-date case via `leadCohortSourceDates.join(", ")`). This line **moves up from the bottom of the Leads section**, where it is currently buried.
   - Line 3 (conditional): polished status banner — see §4.
2. **Primary performance KPI row (dominant)** — one full-width white card, six cells in the brief's order: **Bookings WTD · Remaining · Daily Pace Needed · Goal Achievement · Yesterday's Bookings · Bookings Today**. Grid `grid-cols-2 sm:grid-cols-3 xl:grid-cols-6`; hairline vertical dividers between cells at xl (`xl:divide-x divide-stone-100`); cell padding `px-5 py-4`. Numbers `text-5xl`. Pace state dot per §3.1. This card is the visual anchor of the page.
3. **Secondary operations row** — white card, heading `Calls & Conversions (today)` (existing string), five cells: **Total Calls · Calls Over 2 Min · Avg Call Duration · Conversation Conversion · Assigned Lead Conversion**. Numbers `text-3xl` (visibly secondary to row 2). No comparisons added — a today-vs-week or team-average-today figure does not exist in the payload and the brief forbids creating calculations (§7 notes the optional engineer path).
4. **Lead load + availability** — two-panel band, `grid lg:grid-cols-5 gap-4`: Lead Load card (`lg:col-span-3`) + Studio Availability card (`lg:col-span-2`). Details §3.3–3.4.
5. **Management Attention panel** — slim card above the rep table. Details §3.5, rules §6.
6. **Rep performance table** — heading `Rep Performance — this week` (existing) with a right-aligned honesty caption: `Team averages exclude each rep's own row · rule-based, no scores`. Redesigned table §3.6.

## 2. Type scale, spacing, palette

**Type scale** (Tailwind, all numerals `tabular-nums` — already set globally):

| Role | Token |
|---|---|
| Hero KPI number (primary row) | `text-5xl font-semibold tracking-tight text-stone-900 tabular-nums leading-none` |
| Primary KPI label | `text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500` |
| KPI subtext | `text-xs text-stone-500` |
| Secondary/lead number | `text-3xl font-semibold tracking-tight text-stone-900 tabular-nums` |
| Section heading (new `.section-heading`) | `text-[13px] font-semibold text-stone-900` — sentence case, **not** uppercase gray; optional context span `text-xs font-normal text-stone-400` |
| Table body | `text-[13px]` (existing `.data-table` base) |
| Table headers | `text-[11px] uppercase tracking-[0.08em] text-stone-400` (unchanged style) |
| Page h1 | `text-xl font-semibold tracking-tight` |
| Delta line / micro copy | `text-[11px] text-stone-400 tabular-nums` |

Note: this deliberately *reduces* the count of small gray uppercase labels (section headings become dark sentence-case) while keeping the uppercase micro-label only where it labels a number.

**Spacing scale:** page sections `space-y-5`; card padding `p-5` (dense panels — availability, attention — `p-4`); intra-card grids `gap-x-6 gap-y-5`; heading→content `mb-3`; KPI cell stack: label, `mt-2` number, `mt-1.5` subtext; table rows `py-2.5`.

**Palette (restrained; two semantic hues max beyond neutrals):**

| Token | Value | Use |
|---|---|---|
| Canvas | `stone-50` #FAFAF9 | page background (keep — warm white) |
| Surface | `white` | cards |
| Ink | `stone-900` #1C1917 | numbers, headings |
| Body / secondary | `stone-700` #44403C / `stone-500` #78716C | table body, labels |
| Muted / faint | `stone-400` #A8A29E / `stone-300` #D6D3D1 | subtext, deltas, zeros, "—" |
| Hairline | `stone-200/70` dividers, `stone-100` table row rules | minimal borders |
| Attention / at-risk / demo | `amber-700` text, `amber-50` fill, `amber-200/80` border, `amber-500` dot | banners, at-risk dots/chips, low availability |
| Positive | `emerald-700` dot/text, dots and chip dots **only** — never large fills | goal-hit, on-pace-positive |
| Selection / primary action | `stone-900` | active day card, active nav (existing) |

No gradients, no red except hard errors (existing auth error), no additional hues. The amber family does triple duty (attention/at-risk/demo) so the page never reads rainbow.

## 3. Component treatments

### 3.1 Primary KPI group (`.kpi-hero`)
Per cell: label → number → subtext, left-aligned.
- **Bookings WTD** — sub `of {weeklyGoal} goal` (existing) · pace dot (§ below).
- **Remaining** — sub `bookings left` (brief's example wording; label itself unchanged, see §4).
- **Daily Pace Needed** — sub `to hit goal` (existing) · always neutral.
- **Goal Achievement** — sub `of weekly goal` (reinforces owner-ratified denominator: WTD ÷ weekly goal) · pace dot.
- **Yesterday's Bookings** / **Bookings Today** — no subtext, neutral. (Bookings are counted by `created_at` ET; no wording added that could redefine the metric.)

**Pace state dot** (the only color on this row): one 6px dot beside the label of Bookings WTD and Goal Achievement — `bg-emerald-600` when `goalAchievement ≥ weekElapsedFraction`, `bg-amber-500` when below, with `title` "On pace for the weekly goal" / "Behind weekly pace". Numbers stay charcoal; color never shouts.

### 3.2 Secondary operations group (`.kpi-mid`)
Same stack at `text-3xl`. Keep existing sub `meaningful conversations` under Calls Over 2 Min. Avg Call Duration uses the existing `mins()` format. Null conversions render `—` in stone-300 (existing `pct()` behavior — never 0%). **No delta lines here** — no week/team comparison exists for today-only figures (documented skip per brief's "do not create new calculations").

### 3.3 Lead Load block
Heading `Leads — worked today (work-date logic)` (existing string). Five tiles, `text-3xl` numbers (**Total Leads Today** `text-4xl` as the block's anchor):
Family Leads Today · Animalia Leads Today · Total Leads Today · Weekly Leads (sub `budget {weeklyBudget}`) · % Lead Budget Used (sub `{remaining} remaining · {dailyNeeded}/day needed` — existing composition, keeps "Leads Remaining" and "Daily Leads Needed" visible as labeled sub-lines without adding tiles).
- **Budget meter (polish, optional):** 4px bar under % Lead Budget Used — track `stone-200`, fill `stone-900`, fill turns `amber-500` when `percentUsed > 1`. Pure decoration of the existing percent.
- **Over-budget dot:** `bg-amber-500` beside the label when `percentUsed > 1`; nothing otherwise.

### 3.4 Studio Availability block — day-card strip with slot reveal
Replaces the two oversized `SlotsCard`s. Heading `Studio Availability` (existing).
- **Day cards, horizontal strip:** one card per available day — **exactly two today** (Today, Tomorrow — the only days in the payload). Card: width ~112px, `rounded-lg border p-3`, day name `Today · Fri` / `Tomorrow · Sat` (`text-[11px] uppercase tracking-wide text-stone-500`; weekday via presentation-side `Intl` formatting of the ET date), open count `text-2xl font-semibold` (`5 open`; when 0 → `0 open` and the panel shows the existing copy). State: selected = `ring-1 ring-stone-900 bg-white shadow-sm`; unselected = `bg-stone-50 border-stone-200/70 hover:border-stone-300`; **low-availability emphasis** = 6px `bg-amber-500` dot + `low` microtag when open count ≤ 3 (presentational threshold, documented as a display default, configurable later — no capacity data exists to derive it from).
- **Slot reveal panel:** one shared panel beneath the strip showing the selected day's chips — existing chip style `rounded-md bg-stone-100 px-2 py-1 text-xs font-medium text-stone-600`, tighter `gap-1.5 flex-wrap`. Interaction: **click/tap selects (pinned, `aria-pressed`)**; hover previews on `lg+` only without moving the pin; default selection = Today; empty day shows existing copy `No open slots (closed or fully booked).`
- **NEEDS ENGINEER SUPPORT (explicitly called out by the task):** the brief's "Next several days" cards cannot be built — `openSlots` carries only today/tomorrow. Until extended, the strip renders exactly two cards and grows horizontally when more arrive; no placeholders, no invented numbers. See §7.1 for the exact recipe.
- **Total capacity / utilization:** not available on this payload (`computeOpenSlots` returns only open-slot labels) → omitted entirely per the brief's "if already available". Do not derive it.

### 3.5 Management Attention panel
Card titled **`Management Attention`** with caption `Rule-based from current week metrics — no scores.` Up to **5** note rows (rules §6). Row anatomy: severity dot (6px — `amber-500` at-risk, `emerald-600` positive) → one-line note `text-[13px] text-stone-700` → right-aligned rep name `text-xs font-medium text-stone-500`. Row divider `border-stone-100`; dense `p-4`. Notes are plain declarative sentences with the numbers embedded; no grades, no "AI" framing. All-clear state (zero rules fired): `No attention items — no rep is behind pace or below team conversion.` Null-safe: rules requiring a value are skipped when that value is null.

### 3.6 Rep performance table (redesigned)
Kept sortable and weekly; same `sortedRows` logic, new presentation.

**Column order — priority first:**

| # | Column (label string) | Source | Treatment |
|---|---|---|---|
| 1 | `Rep` | name | left, `font-medium text-stone-900`; **status chip inline after name** (§6.2) |
| 2 | `Total Bookings` | totalBookings | priority; `font-semibold text-stone-900`; delta sub `+14.3% vs team` (pct-diff unit) |
| 3 | `Conv. Conversion` | conversationConversion | priority; delta sub in **pts** (`+18.2 pts vs team`) |
| 4 | `Assigned Lead Conv.` | assignedLeadConversion | priority; delta sub in pts |
| 5 | `Goal %` | goalPercent | priority; 0 decimals (existing) |
| 6 | `Actual / Goal` | actual, goal | **actual-first**: `16 / 14` — actual `font-semibold text-stone-900`, goal `text-stone-400`; goal `0` renders `16 / —` |
| 7–10 | `Total Calls` · `Calls >2 Min` · `Bookings from >2 Min` · `Avg Call` | existing fields | secondary group: `text-stone-500`, values de-emphasized (zeros `text-stone-300`), hidden below `md` (`hidden md:table-cell`) |

All label strings unchanged except `Goal / Actual` → `Actual / Goal` with the two values swapped in order (§4). Delta line style: `text-[11px] text-stone-400 tabular-nums`, no color — the sign carries direction. Delta hidden (not "0.0") when rep or team value is null, or team mean is 0 for a pct-unit delta.

**Table mechanics:** `sticky` thead (`sticky top-14 bg-white/95 backdrop-blur-sm z-[1]` — sits under the existing sticky app nav, harmless on short tables); row hover `bg-stone-50` (slightly lighter than current `stone-100/50`); row dividers `border-stone-100`; sort headers become real `<button>`s inside `<th>` with `aria-sort`, active caret stone-900, idle caret stone-400; default sort stays Total Bookings desc; `Actual / Goal` sorts on `actual`. `overflow-x-auto` wrapper with `min-w-[960px]` retained.

**Chips** (compact, text + dot, never color-only): `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium` — positive `bg-emerald-50 text-emerald-700` dot `bg-emerald-600`; at-risk `bg-amber-50 text-amber-800` dot `bg-amber-500`; neutral `bg-stone-100 text-stone-600` dot `bg-stone-400`. Chip vocabulary: `Goal hit · Strong converter · Needs coaching · Below pace · On pace` (the brief's "Above team average" is intentionally dropped — the delta subs carry vs-team per column).

## 4. Label fidelity & honest warning integration

**KPI/labels that stay byte-identical:** `Bookings Today`, `Yesterday's Bookings`, `Bookings WTD`, `Remaining`, `Daily Pace Needed`, `Goal Achievement`, `Total Calls`, `Calls Over 2 Min`, `Avg Call Duration`, `Conversation Conversion`, `Assigned Lead Conversion`, `Family Leads Today`, `Animalia Leads Today`, `Total Leads Today`, `Weekly Leads`, `% Lead Budget Used`; table labels `Rep`, `Total Calls`, `Calls >2 Min`, `Bookings from >2 Min`, `Total Bookings`, `Conv. Conversion`, `Assigned Lead Conv.`, `Avg Call`, `Goal %`; headings `Calls & Conversions (today)`, `Leads — worked today (work-date logic)`, `Studio Availability`, `Rep Performance — this week`. All number formats (`pct()` digits, `mins()`) unchanged.
**The only label change:** `Goal / Actual` → `Actual / Goal`, values reordered actual-first (`16 / 14`), per the brief's explicit instruction.
**Two documented exceptions where the brief's block redesign supersedes old component titles (not metric renames):** (a) `Open Slots Today` / `Open Slots Tomorrow` card titles become day-card names `Today · Fri` / `Tomorrow · Sat` — the concepts (open slot count + specific times for today/tomorrow) remain fully displayed; (b) subtext (never the label) follows the brief's examples where given — `Remaining` sub becomes `bookings left`.

**Demo/stale warnings — polished, never lost:** one slim banner line under the header context line: `flex items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50 px-3 py-1.5 text-xs text-amber-900`, leading 6px `bg-amber-500` dot, `role="status"`, long reasons truncate with a `title` tooltip instead of stacking. Content rules: `meta.mode === "memory"` → `Demo data — in-memory store` + (dbReason ? ` · Database not connected: {dbReason}`) + ` · Values recompute live from the demo seed.`; `meta.mode === "postgres" && meta.dbReason` → `Database warning: {dbReason}`. All current honesty phrases survive in tighter form. Provider-error clauses (from the already-fetched-but-unrendered `connections` payload) are specified conditionally pending shape confirmation (§7.3). The banner coexists with everything below — no warning is designed away, and null metrics still render `—`, never 0.

## 5. Prioritized change list

**MUST-FIX**
1. **`Goal / Actual` → `Actual / Goal`, actual-first values** — the brief's explicit clarity fix; goal-first (`14 / 16`) reads backwards.
2. **Establish visual dominance for the booking-pace story** — today all six primary KPIs are equally weighted bare text; group them into the single hero card with `text-5xl` numbers and pace dots so "are we on pace?" answers in one glance (brief's 10-second goal #1).
3. **Move the lead-cohort line into the header context** — it currently sits as faint gray text at the bottom of the Leads section; the brief requires it directly under the header.
4. **Compact the availability block** — two full-sized KPI cards for a secondary fact eat the fold; replace with the day-card strip + shared slot panel.
5. **Add the management-attention layer** — chips, deltas, and the attention panel; today a manager must eyeball 10 columns × N reps to find coaching targets.

**SHOULD-FIX**
6. Low-availability emphasis (≤3 amber dot/tag) — makes "what to push" pre-attentive.
7. Sticky thead + real sort buttons with `aria-sort` — usability as rep count grows.
8. Secondary-column de-emphasis (stone-500, hidden `<md`) — density without crowding.
9. Budget utilization bar + over-budget dot in the lead block.
10. Honesty caption on the rep table ("Team averages exclude each rep's own row · rule-based, no scores").

**POLISH**
11. `focus-visible` rings on sort buttons and day cards; `role="status"` banner; `aria-pressed` day cards.
12. Zero-value de-emphasis in secondary columns; `—` in stone-300 for nulls.
13. Micro-interactions kept to `transition-colors` (no motion beyond that; respect `prefers-reduced-motion` by default).

**KEEP AS IS**
All metric labels except the one mandated change; `pct()`/`mins()` formats; default sort (Total Bookings desc); `.data-table` base size; stone palette; app shell/nav/auth gate; the loader `getTodayData()` unchanged; `cohortNote` string; `No open slots (closed or fully booked).` copy; the demo banner's informational content (restyled only); everything in `compute.ts` and `date-logic.ts`.

**Standardize sitewide later (define now, on this page first):** `.kpi-hero`/`.kpi-mid`/`.kpi-sub` classes; `.section-heading` (sentence-case) retiring `.section-title`; `.card` + `.card-dense` padding variants; `.chip` severity variants + `.delta-line`; `.status-banner`; the day-card component (reusable on the future Availability page); table header/body conventions from §3.6.

## 6. Exact rules (existing outputs only; `TEAMDENOM = 3` = existing `TREND_MIN_DENOMINATOR`)

**Shared per-rep team means** (from `repRows`, self excluded): counts (`totalCalls`, `totalBookings`) = mean over all other reps incl. zeros; rates (`conversationConversion`, `assignedLeadConversion`) = mean over other reps with a value, null if none. Deltas: rates `(rep − team) × 100` pts; bookings `((rep − team)/team) × 100` %, null when team mean is 0.

**6.1 Pace state (primary row dots):** `onPace = goalAchievement ≠ null && goalAchievement ≥ weekElapsedFraction`; dot emerald if onPace, amber if not, none if `goalAchievement` null.

**6.2 Status chip — first match wins:**
1. `Goal hit` (positive) — `goalPercent ≥ 1`
2. `Strong converter` (positive) — `conversationConversion ≠ null && teamConv ≠ null && conversationConversion ≥ teamConv && callsOverThreshold ≥ 3`
3. `Needs coaching` (at-risk) — `conversationConversion ≠ null && teamConv ≠ null && conversationConversion < teamConv && callsOverThreshold ≥ 3`
4. `Below pace` (at-risk) — `goal > 0 && actual < goal × weekElapsedFraction`
5. `On pace` (neutral) — `goal > 0` (default)
No chip when `goal === 0 && conversationConversion === null && totalCalls === 0` (a data gap is never labeled "On pace").

**6.3 Management Attention notes — per rep, first match wins; panel = up to 5 notes, at-risk first** (behind-pace by largest goal gap, then conversion deficit in pts), positives last, omitted if over cap:
1. **No activity** — `totalCalls === 0 && totalBookings === 0` → `{name} has no calls or bookings recorded this week — verify sync or lead assignment.`
2. **Goal hit** — `goalPercent ≥ 1` → `{name} hit the weekly goal — {actual} of {goal}.`
3. **Behind pace** — `goal > 0 && actual < goal × weekElapsedFraction` → `{name} is behind pace — {actual} of {goal} bookings with {daysLeft} day(s) left (expected ≈ {expected rounded 1dp} by now).`
4. **Strong volume, weak conversion** — `totalCalls ≥ teamAvgCalls && teamAvgCalls > 0 && conv < teamConv (both non-null, TEAMDENOM ≥ 3)` → `{name} has strong call volume but below-team Conversation Conversion ({rep%} vs {team%}).`
5. **Below team conversion** — `conv < teamConv (both non-null, TEAMDENOM ≥ 3)` → `{name} is below team average in Conversation Conversion ({rep%} vs {team%}).`
All-clear line only when no rule fired for any rep. Example of the brief's delta format: rep 64.0% vs team 45.8% → `64.0%` with sub `+18.2 pts vs team`.

## 7. NEEDS ENGINEER SUPPORT

1. **Availability beyond today/tomorrow (required for the brief's "next several days"):** extend `getTodayData` to loop `addDays(today, i)` for `i ∈ 0..6`, reusing **existing** store methods (`getAppointmentsOverlapping`, `getBlockedTimesBetween`) and the existing pure `computeOpenSlots` per date, exposing `openSlotsByDay: { date, label, slots[] }[]`. This is a presentation-support query extension (same primitives, more iterations) — no new logic, no metric changes. The UI in §3.4 is already designed for N horizontally scrolling cards; until it lands, the strip ships with exactly two.
2. **Optional, cleaner deltas:** expose `teamAverages` from `getTodayData` via the existing `repRangeSummaries` + `buildTeamAverages` (rows already fetched, ~10 lines). Without it, the page composes identical means from `repRows` per §0 — no engineer change required; the §3.6 caption keeps it honest either way.
3. **Confirm:** the `connections` payload shape (already returned to Today, never rendered) — if rows expose an error/status field, the §4 banner appends one clause per failing provider; unverifiable in this read-only pass.
4. **Constraint reminders:** `RepPerformanceRow` carries no per-rep `assignedLeads` — don't add payload fields for this redesign; do not "fix" nulls with 0; no comparisons in the secondary ops row (no week-average data is exposed, and the brief forbids creating the calculation).
