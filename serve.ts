// Production server for the built site. The TanStack Start build emits a portable
// fetch handler (dist/server/server.js) plus static client assets (dist/client);
// this wraps them in a Bun server — static files first, SSR for the rest.
// Run `bun run build` before starting. Restart it with `bun run publish`.
//
// LISTEN ADDRESS (portability 2026-11-05, amended same day): in MANAGED mode
// (SERVE_MANAGED=1 — an independent production host) PORT/HOST come from the
// environment through src/server/serve-config (resolveServeAddress), with
// defaults 3000 / 0.0.0.0 and named validation (ServeConfigError) so a
// misconfigured host fails loudly at boot. UNMANAGED boots — the CTO sandbox
// and local dev — IGNORE PORT/HOST entirely and always bind 3000/0.0.0.0:
// the sandbox shell profile really does carry a stray PORT (observed =80),
// and honoring it moved the site off the reverse-proxied :3000 and dark. The
// old hard-pin rationale was right; it now applies to unmanaged boots only.
//
// SECOND-INSTANCE GUARD (2026-10-09 outage hardening; CTO-sandbox process
// management): before binding, a port pre-check classifies whoever already
// listens on :3000 (src/server/boot-guard). A plain `bun run start` while a
// healthy server (or a boot still inside its grace window) owns the port now
// EXITS CLEANLY — it never opens a DB pool and never starts the sync
// scheduler, so stray restarts can no longer stack pools and saturate the
// managed Postgres connection ceiling (the Oct-8 outage chain: ~37 warm
// connections ≈ 2.5 stacked processes × max 12 → ensureSchema boots hung for
// minutes → publish.sh's old 10s health window expired → the wedged old
// runtime stayed live serving 500s). publish.sh sets SERVE_SUPERSEDE=1 so a
// DEPLOY still takes the port over from the previous build; a long-wedged
// listener (unhealthy beyond the boot-grace window) is also replaced by a
// manual restart, same as before.
//
// MANAGED MODE (SERVE_MANAGED=1; portability 2026-11-05): on an independent
// host the platform supervisor owns the process lifecycle — this process
// never probes or kills other processes. The guard pre-check and the sudo
// lsof port-eviction loop are SKIPPED entirely; the boot simply attempts
// Bun.serve and, if the port is taken, logs one line (the lockfile holder
// when readable) and exits 1 for the supervisor to resolve. Unset keeps the
// full sandbox behavior byte-identical (boot-guard planServeBoot is the
// single decision point, unit-pinned).
import handler from "./dist/server/server.js";
import { getStore } from "./src/server/store";
import {
  classifyExistingListener,
  listenerAgeSeconds,
  listenerPidsOnPort,
  managedEaddrinuseLogLine,
  planServeBoot,
  portEvictionCommand,
  probeHttp,
  readServerLockfile,
  writeServerLockfile,
} from "./src/server/boot-guard";
import { isAddressInUseError, isManagedServe, resolveServeAddress } from "./src/server/serve-config";

// Env-driven listen address with named validation (see header). On the CTO
// sandbox neither PORT nor HOST is set → exactly the historical 3000/0.0.0.0.
const { port: PORT, host: HOST } = resolveServeAddress(process.env);
const bootPlan = planServeBoot({ managed: isManagedServe(process.env) });
/**
 * Seconds a connection may go without bytes in either direction before Bun closes
 * it. Bun's default is 10, and it counts a request whose handler is still running
 * but has written nothing yet — so a server function waiting on an AI provider for
 * 12s dies mid-flight and the platform gateway hands the visitor an empty 502.
 * 255 is the maximum Bun accepts; handlers that regularly run long should still
 * write bytes early (stream) or split into start-then-poll.
 */
const IDLE_TIMEOUT = 255;
const CLIENT_DIR = `${import.meta.dir}/dist/client`;

// SECURITY (2026-10-28): this process IS the production runtime (the built
// bundle behind the platform's TLS proxy). The session cookie's Secure
// attribute is gated on this flag — vite dev (plain HTTP) never sets it, so
// localhost/dev logins keep working. Set BEFORE the server binds so no request
// can be served before the flag exists.
{
  const { markProdServeRuntime } = await import("./src/server/auth");
  markProdServeRuntime();
  // MIGRATION-ACCEPTANCE GATE (2026-10-30): THIS process is the only runtime
  // allowed to run schema migrations against the business database. The mark
  // lives on globalThis (read by src/server/store/migration-gate.ts from both
  // this module graph and the bundled store inside dist/server/server.js) and
  // is set BEFORE the port binds — same discipline as markProdServeRuntime, so
  // no request can construct a store before the mark exists. A dev boot,
  // scratch probe, test harness, or page loader holding Database_URL anywhere
  // else now fails VISIBLY (MigrationGateError) instead of silently stamping.
  const { markManagedMigrationContext } = await import("./src/server/store/migration-gate");
  markManagedMigrationContext("serve.ts (managed production runtime)");
}

// ---------------------------------------------------------------------------
// SECOND-INSTANCE GUARD — runs before anything opens a DB pool or scheduler.
// Evidence (boot-timeline probe, 2026-10-09): dist import 86ms (module scope
// touches no DB) → Bun.serve bound at +0ms; the hanging phase is ensureSchema
// (204 idempotent DDL statements — 65s measured on a HEALTHY DB, minutes when
// connections are slow), reached on the first SSR store touch. So the bind was
// never the blocked step — but every STACKED process held a warm pool while it
// hung, and the old unconditional takeover let each new `bun run start` kill
// the running server (restart storms). The guard stops both.
// ---------------------------------------------------------------------------
const LOCK_PATH = `${import.meta.dir}/.run/server.lock`;
const SUPERSEDE = process.env.SERVE_SUPERSEDE === "1";
// MANAGED MODE early-out: a managed plan skips the lsof pre-check entirely —
// no probe, no sudo, no Bun.$ — and falls straight through to the bind attempt.
const existingPids = bootPlan.runSecondInstanceGuard ? await listenerPidsOnPort(PORT) : [];
if (existingPids.length > 0) {
  const probeStatus = await probeHttp(`http://127.0.0.1:${String(PORT)}/`, 3000);
  const age = await listenerAgeSeconds(existingPids[0]);
  const verdict = classifyExistingListener({ probeStatus, listenerAgeSeconds: age, supersede: SUPERSEDE });
  if (verdict === "exit-duplicate") {
    const lock = readServerLockfile(LOCK_PATH);
    const owner = lock ? ` (lock: pid ${String(lock.pid)}, up since ${lock.started_at})` : "";
    console.log(
      `[boot-guard] a server already serves on :${String(PORT)} — pid(s) ${existingPids.map((p) => String(p)).join(",")}${owner}, ` +
        `probe GET / → ${probeStatus == null ? "no answer" : String(probeStatus)}${age == null ? "" : `, up ${String(age)}s`}. ` +
        `Exiting cleanly: no second pool, no second scheduler. ` +
        `To replace the running server deliberately, publish (SERVE_SUPERSEDE=1) or wait out the boot-grace window if it is wedged.`,
    );
    process.exit(0);
  }
  // verdict === "takeover": publish replacing the old build (SERVE_SUPERSEDE=1)
  // or a manual restart replacing a long-wedged listener — fall through to the
  // existing free-port + retry bind loop below.
}

// Free PORT regardless of which user owns the current listener. lsof runs under
// sudo so it can see (and the kill can signal) a process owned by another user;
// the loop waits for the socket to actually release before we bind. Reached
// only when the guard above classified the boot as a takeover (or the port
// was already free — where the kill loop is a no-op). MANAGED MODE: never
// constructed — the command is built ONLY on the unmanaged plan (portability:
// an independent host's supervisor owns process lifecycle, never this app).
const freePort = bootPlan.runPortEviction ? portEvictionCommand(PORT) : null;

// Take over the port, re-freeing and retrying if another publish grabbed it in the
// gap between freeing and binding (last publish wins). Bun.serve throws EADDRINUSE
// synchronously, so without this a raced publish would die while the shell already
// reported success. MANAGED MODE: no eviction, ONE bind attempt — a taken port
// is one clear log line (lockfile holder when readable) + exit 1 for the host
// supervisor; any other bind failure is rethrown for the supervisor to report.
for (let attempt = 1; ; attempt++) {
  if (freePort !== null) await Bun.$`sudo sh -c ${freePort}`.quiet().nothrow();
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      idleTimeout: IDLE_TIMEOUT,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        // HEALTH ENDPOINT (Reliability Phase 2a, owner directive 2026-10-16):
        // JSON only, no business data — app version/commit + per-provider sync
        // freshness (last success, age, ok|degraded|unknown) + overall status.
        // 200 when every tracked provider is ok, 503 when ANY is degraded
        // (stale beyond 3× its cadence) — the contract the external scheduled
        // ping (Phase 2b) polls. Fast indexed queries only; safe to expose
        // publicly (no secrets, no customer data). Unauthenticated on purpose.
        if (pathname === "/health") {
          const { buildHealthPayload, healthHttpStatus } = await import("./src/server/health");
          const payload = await buildHealthPayload();
          return new Response(JSON.stringify(payload), {
            status: healthHttpStatus(payload),
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
          });
        }
        // RAW AUDIT ENDPOINT (GET /api/audit?rep=&date=) — read-only DB rows via
        // the shared audit-api core. Same passphrase gate as every other route,
        // now via the SHARED requireGate wrapper (src/server/api-gate) — the
        // identical decision the vite dev middlewares run.
        if (pathname === "/api/audit") {
          const { requireGate } = await import("./src/server/api-gate");
          const denied = await requireGate(req);
          if (denied) return denied;
          const url = new URL(req.url);
          const { handleAuditQuery } = await import("./src/server/audit-api");
          const out = await handleAuditQuery({
            rep: url.searchParams.get("rep"),
            date: url.searchParams.get("date"),
          });
          return new Response(JSON.stringify(out.body), {
            status: out.status,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        // RETENTION DATA MATCH EXCEPTIONS API (stage 3a) — management-only
        // queue + manual-resolve actions (audited, sticky, never re-matched).
        // Same passphrase gate as every other route, via the SHARED requireGate.
        if (pathname === "/api/retention-exceptions") {
          const { requireGate } = await import("./src/server/api-gate");
          const denied = await requireGate(req);
          if (denied) return denied;
          const { getStore } = await import("./src/server/store");
          const { handleExceptionsQuery, handleExceptionAction } = await import("./src/server/retention/exceptions-api");
          const store = await getStore();
          if (req.method === "POST") {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = (await req.json()) as Record<string, unknown>;
            } catch {
              return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
            }
            const str = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string) : undefined);
            const out = await handleExceptionAction(store, {
              action: str("action") ?? "",
              id: str("id"),
              internalClientId: str("internalClientId"),
              displayName: str("displayName"),
              phone: str("phone"),
              email: str("email"),
              resolvedBy: str("resolvedBy"),
            });
            return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json; charset=utf-8" } });
          }
          const url = new URL(req.url);
          const out = await handleExceptionsQuery(store, { status: url.searchParams.get("status") });
          return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json; charset=utf-8" } });
        }
        if (pathname !== "/") {
          const file = Bun.file(CLIENT_DIR + pathname);
          if (await file.exists()) return new Response(file);
        }
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the built server entry default-exports a Bun fetch handler, and the dist import is untyped.
        return (handler as { fetch: (r: Request) => Response | Promise<Response> }).fetch(req);
      },
    });
    break;
  } catch (err) {
    if (bootPlan.managed) {
      // Supervisor owns lifecycle: a taken port is a clean named exit, never a kill.
      if (isAddressInUseError(err)) {
        console.log(managedEaddrinuseLogLine(readServerLockfile(LOCK_PATH)));
        process.exit(1);
      }
      throw err;
    }
    if (attempt >= 10) throw err;
    await Bun.sleep(200);
  }
}

console.log(`team-site serving on http://${HOST}:${String(PORT)}`);

// Lockfile: record THIS process as the port owner (observability + the
// duplicate-exit message reads it). Best-effort — never blocks serving.
await writeServerLockfile(LOCK_PATH, {
  pid: process.pid,
  port: PORT,
  started_at: new Date().toISOString(),
});

// Background HighLevel sync (owner directive): incremental tick every
// highlevel_sync_interval_seconds (settings, default 90s). Skips while another
// sync run is in progress; records failures on the connection row and retries
// next tick; recomputes attributions after each successful HighLevel sync.
import { startScheduler, bootReapStaleSyncRuns, schedulerLease } from "./src/server/sync/scheduler";
import { installShutdownSyncRunCloser } from "./src/server/sync/run-lifecycle";
import { closeAllPools } from "./src/server/store";

// RESTART GAP CLOSER (2026-11-04 incident): a serve restart used to kill the
// process mid-HighLevel-pass and leave its sync_runs row 'running' with no
// closer — the sync-in-progress guard then skipped EVERY tick until the
// independent reaper's 30-min window caught the row (three ~30-min dead zones
// today; the owner saw the stale-heartbeat banner). Two halves, both wired
// here BEFORE the scheduler starts:
//   1. SHUTDOWN — SIGTERM/SIGINT (+ beforeExit, best-effort) close the rows
//      THIS process opened as 'interrupted' (new status: distinguishable from
//      an API-failure 'error', audited in the Sync Center), then exit; the
//      whole pass is capped at 3s so a dying DB can never hang shutdown, and
//      a second signal force-exits immediately. Store resolution is lazy (at
//      signal time) so it always sees the current getStore() instance.
//   2. BOOT — force-reap any 'running' row older than the reaper's window
//      (bootReapStaleSyncRuns: the SAME criteria as the independent reaper)
//      before the first tick, so even a hard kill (SIGKILL/OOM) costs at most
//      one reaper window, never a blocked half hour of ticks. Best-effort:
//      a failure never blocks boot (the first tick reaps with the same
//      criteria anyway). The freshness watchdog's recovery path is untouched.
void bootReapStaleSyncRuns();
// PORTABILITY (2026-11-05): the closer also RELEASES THE SCHEDULER LEASE
// (scheduler-lease.ts — a standby instance picks up tick duty within one
// interval instead of waiting for our advisory-lock session to die) and
// CLOSES THE DB POOLS (a graceful restart leaves zero open connections).
// Both are resolved lazily at signal time and best-effort inside the
// existing 3s shutdown cap — never a new way to hang a dying process.
installShutdownSyncRunCloser({
  getStoreImpl: () => getStore(),
  releaseLease: async () => {
    await schedulerLease()?.release();
  },
  closeStores: () => closeAllPools(),
});

// Background Google Sheets lead sync (owner directive 2026-09-28): the
// scheduler is started with NO pre-built adapters — every consumer resolves
// its own adapter fresh from the store's CURRENT settings each tick:
//   - the sheets tick (sheets-tick.ts) builds the LIVE adapter from the
//     service-account secret + current Settings sheet config per call and
//     skips cleanly when no secret is configured (it never falls back to
//     demo rows — runSheetsSync's demo-replace guard keeps stored leads);
//   - the freshness watchdog's forced recovery calls the same tick functions
//     with no adapter keys (freshness-watchdog.ts), and the full-sync path
//     resolves from settings per run (run.ts) — so a sheet config saved in
//     Settings applies on the NEXT TICK, no restart.
// (Regression guard: a boot-frozen adapter threaded through liveAdapters made
// every google_sheets run after a mid-flight settings save skip the new sheet
// with "no sheet id configured" — sheets-fresh-config.test.ts pins the fix.)
startScheduler();
