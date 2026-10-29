# The Mallory CC Performance Dashboard site

This is the team's web app: a [TanStack Start](https://tanstack.com/start)
application (React + Vite + Tailwind), served on **port 3000**. It is a real,
full-stack internal dashboard for the Mallory Portraits Client Concierge team —
one trustworthy place that syncs GoHighLevel, Acuity Scheduling, and Google
Sheets into a Postgres database and reports CC performance, lead volume, goals,
bookings, and studio availability. The product spec lives in `docs/SPEC.md`;
the delivery workflow lives in `docs/WORKFLOW.md`.

(HISTORICAL: this file previously described the repo as a "coming soon"
placeholder starter. That framing is obsolete — the placeholder was replaced by
the dashboard build in the first weeks of the project.)

## Layout

```
src/
  routes/            # one file per page; the router is generated automatically
    __root.tsx       # the HTML shell: <head>, fonts, global layout
    index.tsx        # the Today landing page ("/")
    weekly.tsx       # Weekly leadership report (Gross/Cancellations/Net + leads)
    reps.tsx, team.tsx, availability.tsx, daily-report.tsx
    performance*.tsx # PIP management module (drafts/new/templates/print/history)
    retention*.tsx   # Retention module
    settings.tsx     # goals, budgets, integrations, studio rules, sync center
    audit.tsx, status.tsx  # booking reconciliation views; /status health view
  server/            # server-only logic (never imported client-side)
    store/           # the Store interface + MemoryStore (tests) + PgStore (prod)
    metrics/         # metric computation (compute.ts), availability engine
    sync/            # provider sync jobs: HighLevel, Acuity, Sheets, scheduler
    page-data.ts     # SSR page payload builders (one source of truth per KPI)
  components/        # shared UI components (+ __tests__)
  styles/app.css     # Tailwind entrypoint + base styles
vite.config.ts       # serves on 0.0.0.0:3000
serve.ts             # production entry (Bun, idleTimeout 255s)
```

Add a page by creating a new file under `src/routes/` — e.g. `about.tsx` becomes
`/about`. Files are routes; the router is generated automatically.

## Serving and shipping

How this site is served and how changes go live **depends on the team's setup**:
your system prompt's **Website** section is the authority — follow it, not this
file. The `package.json` scripts (`publish`, `go-live`) exist for setups whose
Website section tells you to run them; don't run them otherwise. Server logs live
in `.run/`.

## Gates (every change)

- `bun run typecheck` — typecheck gate (runs `src/server/__tests__/typecheck.test.ts`).
- `bun test` / `bun run test:all` — the full suite; it must pass with 0 failures.
- `bun run build` — production build must exit 0. **Never restore an old `dist`
  after building** (stale dist = old formatting with fresh data).

## Secrets

Read the owner's secrets from `process.env` in server-only code. Never put them in a
`.env` file: `.env` files are not published, so a value that only lives there is
missing on the live site.

## Database

The production store is Postgres (`src/server/store/pg.ts`, PgStore); tests run
against `src/server/store/memory.ts` (MemoryStore), both implementing the same
`Store` interface in `src/server/store/types.ts`. `DATABASE_URL` is provided by
the environment and reaches the published site automatically.

Query Postgres from server-only code with the store/`postgres.js` helpers — never
from the client:

```tsx
import { createServerFn } from "@tanstack/react-start";
import { sql } from "~/db";

const getPosts = createServerFn().handler(async () => {
  const rows = await sql()`select id, title, created_at from posts`;
  // Coerce non-primitive columns before returning — timestamps come back as JS
  // Dates, which React will not render:
  return rows.map((r) => ({ ...r, created_at: String(r.created_at) }));
});
```

## Server behavior gotchas

- **Slow handlers** — `serve.ts` sets Bun's `idleTimeout` to 255s; keep that line.
  With Bun's default (10s) a handler that waits on a provider API is cut at ~12s
  and the visitor sees an empty 502. Use `createServerFn({ method: "POST" })` for
  work that costs money, so the gateway never re-sends it, and prefer streaming or
  a start-then-poll pair for anything that regularly runs past ~20s.
- **Sync jobs** never run provider calls on page load — pages read from the store;
  the scheduler and SYNC NOW refresh the store. Stale provider data is shown as a
  warning, never rendered as current.
- **Data honesty** — a metric that cannot be computed renders an honest "—", never
  a fabricated number (SPEC: never invent data).
