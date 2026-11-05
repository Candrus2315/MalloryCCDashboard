# DEPLOY — Mallory CC Performance Dashboard on an independent host

Short, exact, operator-ready. Companion: `.env.example` (names + purposes only)
and `PORTABILITY_NOTES.md` (the compiled env inventory, Part 1 runtime core).
Everything here is test-pinned on the branch that introduced this file.

## 1. Runtime

- **Bun** — developed and tested on **Bun 1.4.4** (see `bun.lock` / `@types/bun ^1.4.4`).
  Any Bun ≥ 1.1 with the text `bun.lock` lockfile should work; pin 1.4.x to be safe.
- Node.js is NOT used at runtime (the server is `serve.ts` run by Bun; the build is Vite driven by Bun).

## 2. Build

```bash
bun install --frozen-lockfile && bun run build
```

- `bun run build` = `vite build` → outputs `dist/` (client + server bundles).
- If the build dies with `Could not resolve ./routeTree.gen`, just rerun — the plugin regenerates it.

## 3. Start (managed mode)

```bash
SERVE_MANAGED=1 PORT=3000 bun run start
```

- `bun run start` = `bun run serve.ts` — serves the BUILT `dist/` (no dev hot reload; rebuild to refresh).
- **`SERVE_MANAGED=1` disables all sandbox process takeover**: the process never probes, classifies,
  or kills other processes, and never runs sudo/lsof port eviction. It just binds and serves.
- **Port taken → one log line + exit code 1** — your supervisor owns the lifecycle (restart/stop it).
- `PORT`/`HOST` are honored **ONLY when `SERVE_MANAGED=1`**. An unmanaged boot ignores them entirely
  and always binds `3000`/`0.0.0.0` (regression-pinned: a stray `PORT=80` in an environment profile
  once moved the site off its reverse-proxied port).
- Run under your supervisor (systemd unit, container, etc.) with restart-on-failure; the app exits 0
  on SIGTERM (see §8) and non-zero on boot failure.

## 4. Health check — `/health`

- Unauthenticated, JSON only, NO business data (no counts, no names).
- **200** when every tracked provider is fresh; **503** when ANY provider is degraded (last success
  older than 3× its cadence), the database probe fails, or the check itself failed. `unknown` providers
  (never-synced, fresh install) do NOT flip the status.
- Poll cadence: **every 30 s** once healthy; during deploy/startup poll every 5 s until the first 200.
- The payload covers: app identity (`version`, `commit`, `bootedAt`, `uptimeSeconds`), `database`
  (reachable + probe latency in ms), `scheduler` (lease role `holder`/`standby`/`stopped`,
  `tickInFlight`, lease name), per-provider sync freshness (`highlevel`, `acuity`, `google_sheets`,
  `acuity_availability`, `attribution` — last success, age minutes, cadence, status), and the
  sync-heartbeat liveness field. Every query in the health path is deadline-bounded — it answers fast
  or fails honestly; post-restart a provider may briefly show `degraded` until its first pass lands.
- Machine consumers: use `status`/HTTP code. `scheduler.role` tells you which replica owns syncing.

## 5. Environment variables

Copy `.env.example` and fill in. **The complete inventory is `PORTABILITY_NOTES.md`** — the table
below mirrors it (names + purpose + default; **no values**, by design — secrets never belong in files):

| NAME | Purpose | Default |
|---|---|---|
| `PORT` | HTTP listen port — honored ONLY when `SERVE_MANAGED=1` | `3000` |
| `HOST` | HTTP listen address — honored ONLY when `SERVE_MANAGED=1` | `0.0.0.0` |
| `SERVE_MANAGED` | `=1` exactly: managed boot (no pre-check/eviction; EADDRINUSE → exit 1) | unset |
| `SERVE_SUPERSEDE` | `=1`: publish takeover (CTO publish flow — not needed on an independent host) | unset |
| `DATABASE_URL` (+ any-case variant) | Postgres connection for the business database | — (required for Postgres mode; absent → in-memory demo store) |
| `DB_CONNECT_TIMEOUT_MS` | Shared DB connect budget (ms, clamped 1–60 s) for every pool site | `10000` |
| `HEALTH_QUERY_DEADLINE_MS` | Per-await deadline for the `/health` path (ms, clamped 100–10000) | `2000` |
| `HIGHLEVEL_RUN_BUDGET_MS` | Wall-clock budget per HighLevel pass | 10 min |
| `PAGE_RENDER_TIMEOUT_MS` | SSR page-render deadline (clamped 1–60 s) | `8000` |
| `NODE_ENV` | Build/runtime mode | — |
| `DASHBOARD_PASSPHRASE` | Passphrase gate for management APIs | — (absent → gate denies; pages still render) |
| `HIGHLEVEL_API_KEY`, `HIGHLEVEL_LOCATION_ID` | HighLevel API credentials | — (absent → sync skips honestly; may also live in DB settings) |
| `ACUITY_USER_ID`, `ACUITY_API_KEY` | Acuity API credentials | — (absent → availability sync skips) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Sheets service account (the seven lead sources) | — (absent → sheets tick skips) |
| `KNOCK_API_KEY`, `KNOCK_SIGNING_KEY`, `KNOCK_WORKFLOW_KEY`, `ALERT_TO_EMAIL` | Ops-alert delivery via Knock | — (absent → log-only alerts) |
| `DB_MIGRATE_GRANT` | Explicit grantee for standalone migrations (alternative to `--grant`) | — (the script REFUSES without a grant) |
| `TEST_DATABASE_URL` | Disposable Postgres for real-DB test batteries | — (batteries skip without it) |
| `PG_REGRESSION_URL`, `POSTGRES_URL` | Disposable DB URLs for one-off scratch scripts (dev-only) | — |
| `SUPERVISOR_STATE_PATH` | CTO-sandbox supervisor-state observability read | internal path (missing → "unknown" freshness, never a crash) |
| `SERVER_LOCK_PATH` | Override the `.run/server.lock` location | `.run/server.lock` |
| `HEARTBEAT_LOG_PATH` | Sync-heartbeat log location | internal path |
| `CONTACTS_BACKFILL_MAX_PAGES`, `CONTACTS_BACKFILL_DELAY_MS` | Contacts backfill pacing | per-module caps |
| `CALL_CONTACT_MAX_MINUTES`, `CALL_CONTACT_BATCH_SIZE`, `CALL_CONTACT_FETCH_MISSING` | Call→contact heal bounds | per-module defaults |

Notes:
- Credentials resolve through the centralized secret resolver (`src/server/env.ts getSecret`,
  case-insensitive) — there are no OTHER env names for them. Sheet configuration (IDs, tabs, modes)
  and sync intervals live in the **database settings** (Settings page), not in env.
- Do not put secrets in a `.env` file loaded by the build; `VITE_*`/`import.meta.env` values bake in
  at build time. The server reads secrets at runtime via `process.env`.

## 6. Database requirements

- **PostgreSQL** with **SSL**. The app connects with `ssl: rejectUnauthorized: false` — TLS is
  negotiated, but the server's certificate is NOT verified, so self-signed provider certs work.
  Prefer a provider with a valid CA chain; the app tolerates both.
- **Connection ceiling:** keep `max_connections` comfortably above **~14 warm connections per app
  process** plus the dedicated lease connection (a running process holds: web/read pools, the
  write pool, sync-pass pools, and the one advisory-lock lease connection of max 1). For N replicas
  budget N × ~15 and headroom for migrations/admin.
- **Migrations:** boot runs a fast schema-version check — a current database runs **ZERO DDL**
  (one read round trip). To migrate explicitly:

  ```bash
  bun run db:migrate --grant "<who>"
  ```

  (refuses without an explicit grant; alternatively set `DB_MIGRATE_GRANT`).

## 7. Single worker (multiple instances are safe)

The sync scheduler is arbitrated by a **session-level Postgres advisory lock** (fixed key
`0x4D414C4C` "MALL", on a dedicated max-1 connection). Run N app instances on the same database:
**exactly one ticks the scheduler** (that replica reports `scheduler.role = "holder"` on `/health`),
the others serve HTTP and stand by (`role = "standby"`) and take over within one scheduler interval
if the holder dies. `role = "stopped"` = no scheduler loop in that process (e.g. before start).

## 8. Shutdown / crash-restart behavior

- **SIGTERM/SIGINT** (first signal): the scheduler stops, every open sync-run row the dying process
  opened is marked **`interrupted`** (audited, 3 s cap; a second signal force-exits), the advisory
  lease is released, all DB pools are closed, **exit 0**.
- **Boot** force-reaps stale `running` sync rows (per-provider reap windows: HighLevel 12 min,
  others 30 min) — a crash leaves no zombie runs.
- **Watchdog seams (all deadline-bounded):** sync passes carry wall-clock budgets; a wedged DB
  connect fails fast (10 s budget) with retry; `/health` cannot hang (2 s per-await deadline);
  SSR page renders carry an 8 s deadline. A future hang shows a fast honest error and recovers.

## 9. One-time data import (carry the existing data)

Do this **BEFORE the first boot** on the new host (the first boot otherwise seeds demo data):

1. Dump the current CTO-hosted database:
   `pg_dump --format=custom --no-owner --no-privileges "$OLD_DATABASE_URL" -f mallory.dump`
2. Restore into the new provider:
   `pg_restore --no-owner --no-privileges --dbname "$NEW_DATABASE_URL" mallory.dump`
3. Point `DATABASE_URL` at the new database and start the app (§3).
4. Verify: `curl -f http://127.0.0.1:PORT/health` → 200, `database.reachable: true`,
   providers fresh (or briefly `degraded` until the first sync pass lands — the designed freshness
   signal). The Settings page shows the connections table.

## 10. What an independent host does NOT need (CTO-sandbox specifics)

These exist only in the CTO-hosted environment and are **not required** (and not recommended) elsewhere:

- `publish.sh` / `go-live.sh` (CTO publish flow) and their `bun run publish` / `bun run go-live` scripts.
- `SERVE_SUPERSEDE` (publish takeover) — leave unset.
- The **sudo/lsof port-eviction path** — managed mode (`SERVE_MANAGED=1`) never invokes it; the
  supervisor owns process lifecycle.
- `SUPERVISOR_STATE_PATH` / `SERVER_LOCK_PATH` / `HEARTBEAT_LOG_PATH` sandbox-path overrides — the
  defaults are only meaningful inside the CTO sandbox; on an independent host the missing-file
  paths degrade observability fields to honest "unknown"/defaults, never a crash.
