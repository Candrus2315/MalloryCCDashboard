# DECOMPOSITION PLAN — the largest files (PLAN ONLY — no refactoring done)

**Status: PLAN. This document audits and proposes; nothing has been moved, split, or renamed. Every extraction listed here must be its own PR behind the full gate suite (typecheck, full `bun test` 0-fail, `bun run build`), with the digit-identical presentation rule enforced (SSR text multiset diff on the same DB; COPY REPORT byte-identical).**

## 1. Why (and why not)

The seven largest files concentrate most of the product's change surface: a feature change usually touches one of them, they produce the widest review diffs, and a bad edit in `pg.ts`/`compute.ts` can corrupt numbers the owner runs the business on. Decomposition is worth doing **only where it reduces that risk** — smaller blast radius per edit, faster/parallel test attribution, and a dependency graph a human can hold in their head. Everything else is rejected as cosmetic: renaming, single-call-site helper moves, comment tidying, converting shapes, or splitting a file to hit a line count. **Cosmetic refactoring is explicitly out of scope of this plan.**

## 2. Audit — line counts + responsibilities (measured on main `8ae9af9` + this branch)

| File | Lines | Responsibility |
|---|---|---|
| `src/server/store/pg.ts` | **4,594** | `PgStore implements Store` — the production store. Contains: the 140-statement DDL array (lines 111–964), pool profiles + `SchemaAcquireTimeoutError` + `ensureSchema`/`runSchemaDdl` boot machinery, read cache, and ~162 store methods spanning every module: core identity/reporting tables, availability feed cache, call harvest, PIPs, commissions, retention ledgers/scorecards. |
| `src/server/store/types.ts` | **2,553** | The shared contract: all row interfaces (User/Contact/Opportunity/Call/Appointment/Lead/PIP/commission/retention/availability-feed rows), the `Store` interface (line 1945) both stores implement, plus shared constants/seeds (`DEFAULT_CALL_START_DATES`, `DEFAULT_COMMISSION_PROFILES`) and sync-freshness helpers (`TICK_WATCHDOG_CAP_MS`, `parseSyncStartedMs`). |
| `src/server/page-data.ts` | **2,476** | SSR payload builders for every reporting page, with clear section banners: `PageMeta`/`PageDeps` + reps/team pages (118–634), Today + Daily Report (635–975), Availability incl. range views (976–1490), Weekly report (1491–2283), Commission Center + §26 validation (2284–end). |
| `src/server/store/memory.ts` | **2,294** | `MemoryStore implements Store` — the test store. Mirrors PgStore semantics module-for-module (availability feed cache, harvest, PIPs, commissions, retention) — its size is *derived* from pg.ts's surface. |
| `src/server/metrics/compute.ts` | **2,137** | The metric core over row types: ET range filters, `summarizeCalls`/`callsByRep`, the booking-win doctrine (`isBooking`, `appointmentIsPaid`, `isBookingWin`, `bookingWinBusinessDateOf`), `bookingsFromOverThresholdCalls`, attribution split (s1 frozen + auction ruling), weekly bookings-produced, cohort machinery, rep detail/team aggregation. |
| `src/routes/settings.tsx` | **1,839** | Settings page: one `Route` + ~25 section components (weekly/monthly/rep goals, start dates, core ops, retention rules, Acuity scope, studio hours/blocks, recurring blocks, blocked times, sheet mapping, sync center, security). All sections already take `data/busy/onSave` props. |
| `src/routes/weekly.tsx` | **1,221** | Weekly page: `Route` + pure presentational components (`signedDelta`, `RhythmStrip`, `DayByRepGrid`, `RankedRepTable`) + `WeeklyPage` composing the payload. |

Test protection in place: 116 server test files + 10 component test files (suite 1,833 tests / 0 fail at time of writing).

## 3. Logical modules and dependency boundaries

The dependency direction is already clean and must be preserved by any extraction:

```
routes (UI) → page-data (payload builders) → metrics (pure computation) ← types (row contracts)
                     ↓ Store interface (the ONLY boundary to stores)
              store/ (PgStore prod · MemoryStore tests)   sync/ (writers → store)
```

Rules any decomposition must obey:

1. **`Store` (types.ts:1945) is the single store boundary.** UI and page-data never import `PgStore` or `MemoryStore` directly. Any split of types.ts must keep `Store` as one interface in one module — per-store interface variants are explicitly forbidden (two stores already prove parity across this interface; splitting it invites drift).
2. **`getWorkDate`/`getLeadCohort` (date-logic.ts) stay centralized and untouched** — the SPEC names them as THE functions.
3. **Win-basis functions stay together** (`isBooking`, `appointmentIsPaid`, `appointmentPaymentStateOf`, `isBookingWin`, `bookingWinBusinessDateOf`, `createdBusinessDateOf`): they encode the deposit/creation-week doctrine (Final Booking Logic, reschedule-lineage audit). One module, not scattered helpers.
4. **Transition pattern:** new module files hold the code; the original path keeps re-export shims (`export { x } from "./new/module"`) so no test or consumer import breaks in the same PR as the move. Shim removal is a separate, mechanical later PR.
5. **MemoryStore moves in lockstep with PgStore** — it is the parity mirror; decomposing one without the other is how the two stores drift.

## 4. Proposed module map (target shape)

- **`store/pg.ts` → `store/pg/`**: `ddl.ts` (the array — pure data), `pool.ts` (profiles, `SchemaAcquireTimeoutError`, cap constants), `boot.ts` (`ensureSchema`/`runSchemaDdl`/`raceSchemaStmt`), then per-module method groups as delegate objects: `core.ts` (users/contacts/calls/appointments/leads/goals/settings), `availability-feed.ts`, `harvest.ts`, `pips.ts`, `commission.ts`, `retention.ts`. `PgStore` becomes a thin composing facade; **the `Store` interface and all call sites unchanged**.
- **`store/types.ts` → `types/`**: `rows-core.ts`, `rows-modules.ts` (pip/commission/retention/availability-feed rows), `store-interface.ts` (Store), `sync-meta.ts` (freshness constants/helpers), `seeds.ts` (`DEFAULT_*`). Shims keep `import … from "./types"` working.
- **`page-data.ts` → `page-data/`**: `shared.ts` (PageMeta/PageDeps/loadPageMeta), `today.ts`, `reps-team.ts`, `availability.ts` (+ the already-extracted `availability-view.ts` precedent), `weekly.ts`, `commission.ts`. The section banners at 635/976/1491/2284 are the natural cut lines — they already exist.
- **`metrics/compute.ts` → `metrics/`**: `win-basis.ts` (rule 3 above), `calls.ts` (filters + summarize), `attribution.ts` (split + unattributed queue), `weekly-produced.ts`, `cohort.ts` (cohort-produced machinery — internal, per SPEC), `rep-detail.ts`. `appointmentInScope` already lives in `metrics/availability.ts` — that is the pattern to follow.
- **`routes/settings.tsx` → `components/settings/`**: one file per card (the `data/busy/onSave` prop pattern is already uniform — components are pure presentational over the payload), `settings.tsx` keeps Route + composition + save handlers.
- **`routes/weekly.tsx` → `components/weekly/`**: `RhythmStrip`, `DayByRepGrid`, `RankedRepTable` are already typed pure components — trivially extractable; `weekly.tsx` keeps Route + page state.

## 5. Lowest-risk extraction order (each step = one PR, suite green, numbers digit-identical)

| # | Extraction | Risk | Protected by |
|---|---|---|---|
| 1 | `weekly.tsx` presentational components → `components/weekly/` | lowest — pure props, no server logic, no store | full suite; SSR text multiset diff; weekly-holes + QA-phase2 suites still pass through the page unchanged |
| 2 | `settings.tsx` section components → `components/settings/` | low — uniform props, one consumer | settings-views.test.ts; the settings route renders identical payload |
| 3 | `page-data.ts` split by existing section banners → `page-data/` with re-export shim | low-medium — pure loaders over `Store`; zero logic change | report-text, daily-report-anchor, qa-phase2-views, availability(+flow/copy), weekly suites; COPY REPORT byte-identity proof |
| 4 | `types.ts` split → `types/` with re-export shim | medium — touches every import path (compile-wide but shallow) | typecheck gate (the TS2304/2551 tripwire test is exactly the guard for this class of change); full suite |
| 5 | `metrics/compute.ts` split by function family → `metrics/` | medium — pure functions but they are the number-producers | the heaviest protection in the repo: attribution, attribution-split, booking-win, booking-invariant-regression, historical-win-aggregation, weekly-bookings-produced, pace-day-cutoff, pending-payment-dismiss, reps, s1-window-interaction, s7c-created-time |
| 6 | `store/pg.ts` (LAST) — first slice `ddl.ts` (pure data, −854 lines, near-zero risk), then pool/boot, then module delegates; **memory.ts in lockstep** | highest — boot machinery, pool profiles, ensureSchema wedge-seams, 162 call sites | ingest-batch, harvest, commission-flow/-engine/-holes, retention-* batteries, read-cache, scheduler, roster, plus store-parity semantics; the reschedule-lineage + weekly-bookings-produced suites pin the production logic |

**Files that should stay together** (do NOT split further): the DDL array + `ensureSchema`/`runSchemaDdl`/`raceSchemaStmt` + `SchemaAcquireTimeoutError` (the boot contract is one story); the win-basis function family (rule 3); `Store` + the row types `Store` references (one interface module); `availability-view.ts` already sits beside its consumer and stays.

## 6. What is explicitly rejected

- Renames of modules/functions/props with a single consumer; **re-export layers with no consumer benefit**; comment/type-shape tidying; splitting a file merely to reduce its line count; any "modernization" (enum conversion, class→function rewrites) that changes code shape without changing risk.
- Any extraction of `pg.ts`/`memory.ts` **before** steps 1–5 have each landed clean: the store pair is where wedge-seams and parity live, and it should move only once the surrounding modules make its sections isolated.
- Anything that would let a Weekly/Today/CC-Report number change basis silently — the metric definitions in SPEC.md (work-date cohort vs creation-week production vs cohort-produced) are pinned by tests, and this plan must never be executed by a PR that also touches those tests.
