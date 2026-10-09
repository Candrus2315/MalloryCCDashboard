#!/usr/bin/env bash
# Rebuild the site and (re)start the production server on port 3000.
# Build runs in the foreground so errors surface; the server is launched in a new
# session (setsid) so it keeps running after this script — and your shell — exits.
# serve.ts frees the port (across user boundaries, retrying on races) before
# binding, so this is safe to re-run no matter who started the current server.
set -euo pipefail
cd "$(dirname "$0")"

# Group-writable so any team member can publish over another member's build.
umask 002
mkdir -p .run

# The workspace starts as sources only (the coming-soon placeholder serves from
# the image's pre-built copy), so the first publish installs deps here. No-op
# once node_modules is current.
bun install
bun run build
# SERVE_SUPERSEDE=1 tells serve.ts's second-instance guard that this is a
# DEPLOY: it must take the port over from the previous build even when that
# build is perfectly healthy. A plain `bun run start` (no flag) exits cleanly
# instead of stacking a second DB pool + scheduler — the Oct-8 outage chain.
SERVE_SUPERSEDE=1 setsid nohup bun run start > .run/server.log 2>&1 < /dev/null &

# Wait for the new server to actually answer before reporting success, so a
# startup crash surfaces here instead of silently leaving the old page live.
# Health = any HTTP response that proves the SERVER is up: 2xx/3xx, or 401
# while the passphrase gate is active (a gated site answers / with 401 — the
# server is fine; the old check treated that as failure and exited 1 with
# "server isn't responding" even though everything was healthy). Connection
# refused (000) or a crashed boot keeps the loop waiting.
#
# 2026-10-09 hardening: window widened from 50×0.2s (~10s) to 120×2s (~240s).
# Measured boot timeline (probe, 2026-10-09): the HTTP bind lands in <100ms,
# but SSR cannot answer / until the first store touch runs the ensureSchema
# DDL sweep — 204 idempotent statements over the managed TLS wire, 65s measured
# on a HEALTHY DB and minutes when connections are slow (the outage condition).
# The old ~10s window expired mid-boot on every degraded-DB publish, the script
# reported "published, but the server isn't responding", and the wedged old
# runtime stayed live serving 500s. 240s covers the measured worst case while
# still surfacing a genuinely dead boot in bounded time.
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:3000 || true)
  case "$code" in
    200|201|202|204|301|302|303|307|308|401)
      echo "site published; serving on port 3000"
      exit 0
      ;;
  esac
  sleep 2
done
echo "warning: published, but the server isn't responding — check .run/server.log" >&2
exit 1
