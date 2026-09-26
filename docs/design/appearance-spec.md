# Appearance Setting + Dark Theme (owner, 2026-09-26)

## SCOPE
Presentation + client-side preference persistence ONLY. No backend logic, provider integrations, metrics, or sync changes. Cross-cutting: applies to ALL pages — Today, Reps, Team, Availability, Daily Report, Settings — plus tables, charts, forms, modals, status banners, tooltips, navigation.

## SETTING
Three options: System (default) | Light | Dark. Control lives in Settings under a section called "Appearance". Example UI:
Appearance — [ System ] [ Light ] [ Dark ] — "System / Uses your device appearance automatically."

## SYSTEM MODE
Mirror OS/browser color scheme via prefers-color-scheme. When System is active and the user's device switches light↔dark, the dashboard updates automatically (live matchMedia listener).

## LIGHT MODE
The existing warm white / soft off-white visual system (unchanged).

## DARK MODE — true theme, NOT color inversion
- Deep charcoal / near-black backgrounds (avoid pure black everywhere)
- Slightly lighter elevated surfaces (cards, panels)
- Warm white primary text; muted gray secondary text
- Restrained accent colors; subtle borders
- Readable charts; accessible contrast throughout
- AVOID: pure black everywhere, harsh white text, bright neon, heavy glow, generic developer-dashboard styling
- Feel: premium, calm, consistent with the light-mode design language

## BEHAVIOR
- Persist the user's manual choice (client-side, e.g. localStorage; applied before first paint to avoid flash).
- System: keep following the OS theme automatically.
- Light or Dark: manual choice overrides OS until the user changes it.

## IMPLEMENTATION NOTES (for builder)
- Tailwind `darkMode: 'class'` strategy + dark: variants; toggle class on <html>.
- Preference hook/store: 'system' | 'light' | 'dark', default 'system'; resolve system → media query; listen for changes while in system mode.
- Audit EVERY existing page/component for hardcoded light-only colors; convert to theme-aware tokens. Coverage checklist: page shells, KPI cards, tables (headers/rows/hover), forms/inputs, buttons (primary/secondary/danger), status banners (demo/stale/sync), badges, tooltips, modals, nav tabs, progress bars/charts.
- No logic files touched (metrics/compute, sync/*, store write paths).

## ACCEPTANCE
1. Default is System and follows OS theme live. 2. Manual Dark persists across reloads and overrides OS. 3. Manual Light persists likewise. 4. No flash of wrong theme on load. 5. All six pages + nav + banners + tables + forms readable in dark; no pure-black/harsh-white/neon. 6. All existing tests still pass; no behavior change outside presentation.
