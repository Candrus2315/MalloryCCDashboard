// Production server for the built site. The TanStack Start build emits a portable
// fetch handler (dist/server/server.js) plus static client assets (dist/client);
// this wraps them in a Bun server on port 3000 — static files first, SSR for the
// rest. Run `bun run build` before starting. Restart it with `bun run publish`.
//
// SECOND-INSTANCE GUARD (2026-10-09 outage hardening): before binding, a port
// pre-check classifies whoever already listens on :3000 (src/server/boot-guard).
// A plain `bun run start` while a healthy server (or a boot still inside its
// grace window) owns the port now EXITS CLEANLY — it never opens a DB pool and
// never starts the sync scheduler, so stray restarts can no longer stack pools
// and saturate the managed Postgres connection ceiling (the Oct-8 outage chain:
// ~37 warm connections ≈ 2.5 stacked processes × max 12 → ensureSchema boots
// hung for minutes → publish.sh's old 10s health window expired → the wedged
// old runtime stayed live serving 500s). publish.sh sets SERVE_SUPERSEDE=1 so
// a DEPLOY still takes the port over from the previous build; a long-wedged
// listener (unhealthy beyond the boot-grace window) is also replaced by a
// manual restart, same as before.
import handler from "./dist/server/server.js";
import {
  classifyExistingListener,
  listenerAgeSeconds,
  listenerPidsOnPort,
  probeHttp,
  readServerLockfile,
  writeServerLockfile,
} from "./src/server/boot-guard";

// Pinned, NOT read from the environment. The published preview URL
// (<label>.<PUBLIC_SITE_DOMAIN>) is reverse-proxied to 0.0.0.0:3000 inside the
// sandbox, so the default site MUST bind there. Bun auto-loads .env files, so
// honouring process.env.PORT/HOST would let a stray env var or a .env in the site
// dir silently move the site off :3000 (or onto loopback) and break the public URL.
const PORT = 3000;
const HOST = "0.0.0.0";
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
const existingPids = await listenerPidsOnPort(PORT);
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
// was already free — where the kill loop is a no-op).
const freePort =
  `for _ in $(seq 1 25); do ` +
  `pids=$(lsof -t -iTCP:${String(PORT)} -sTCP:LISTEN 2>/dev/null || true); ` +
  `if [ -z "$pids" ]; then exit 0; fi; ` +
  `kill $pids 2>/dev/null || true; sleep 0.2; ` +
  `done`;

// Take over the port, re-freeing and retrying if another publish grabbed it in the
// gap between freeing and binding (last publish wins). Bun.serve throws EADDRINUSE
// synchronously, so without this a raced publish would die while the shell already
// reported success.
for (let attempt = 1; ; attempt++) {
  await Bun.$`sudo sh -c ${freePort}`.quiet().nothrow();
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      idleTimeout: IDLE_TIMEOUT,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        // RAW AUDIT ENDPOINT (GET /api/audit?rep=&date=) — read-only DB rows via
        // the shared audit-api core. Same passphrase gate as every other route
        // (resolveGate), so enabling DASHBOARD_PASSPHRASE later protects it too.
        if (pathname === "/api/audit") {
          const { resolveGate } = await import("./src/server/auth");
          const gate = await resolveGate(req);
          if (gate.kind !== "allow") return gate.response;
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
import { startScheduler } from "./src/server/sync/scheduler";

// Background Google Sheets lead sync (owner directive 2026-09-28): build the
// LIVE sheets adapter the way production does — GOOGLE_SERVICE_ACCOUNT_JSON
// from env + the Settings sheet config — and thread it into the scheduler's
// tick. When the store/secret isn't ready at boot we pass nothing: the tick
// resolves the adapter itself from env each round and skips cleanly when no
// secret is configured (it never falls back to demo rows — runSheetsSync's
// demo-replace guard keeps stored leads). Sheet-config changes picked up on
// the next restart; SYNC NOW always reads current settings.
import { getStore } from "./src/server/store";
import { createSheetsAdapter } from "./src/server/sync/sheets-live";
const liveSheets = await (async () => {
  try {
    const store = await getStore();
    return createSheetsAdapter((await store.getSettings()).sheets);
  } catch {
    return null; // store not ready at boot — the tick self-resolves per round
  }
})();
startScheduler(liveSheets ? { liveAdapters: { sheets: liveSheets } } : undefined);
