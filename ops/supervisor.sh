#!/usr/bin/env bash
# ============================================================================
# SUPERVISOR (Reliability 2b/3 — owner directive, highest-value first)
#
# One plain-bash loop, ~60s interval, no cron/systemd/no new dependencies.
# Field evidence it exists for:
#   - 2026-10-22 23:55: the sync heartbeat died SILENTLY with its parent
#     terminal session (nothing above nohup) — found ~40 min later by hand.
#   - publish swaps dist files but never restarts the long-running serve, so
#     every deploy needed a hand restart (3+ occurrences, one 4-hour
#     stale-code window during the fairyland incident).
#
# Checks each cycle (decision rules live in src/server/supervisor-decisions.ts
# — test-covered by bun tests; this script only collects FACTS and EXECUTES):
#   1. SERVE ALIVE + CURRENT — the pid in .run/server.lock must answer /health
#      AND its boot-cached commit must match `git rev-parse --short HEAD`.
#      Dead OR stale-commit → the documented runbook: kill the lock pid (only
#      ever that pid), nohup bun run start, wait for /health, re-check.
#   2. HEARTBEAT ALIVE — pgrep sync-heartbeat.sh; none → the exact brief
#      command: nohup bash ~/heartbeat/sync-heartbeat.sh >> ~/heartbeat/heartbeat.log
#   3. Quiet-healthy: the log records ACTIONS and state CHANGES only, so the
#      log stays readable (a healthy cycle writes nothing).
#
# Guards:
#   - own lockfile .run/supervisor.lock (stale lock auto-clears by pid
#     liveness) — two supervisors can never stack;
#   - a serve seen bad must be seen bad on TWO consecutive cycles before a
#     restart (one /health blip never restarts a healthy serve);
#   - a SECOND restart request within 5 min starts a 10-min backoff (the
#     "≥2 restarts/5 min → back off, do not loop-crash" rule);
#   - scope: only the lock pid is ever killed; if the port is held by a
#     foreign pid the supervisor stands down and logs.
#
# Usage:
#   ops/supervisor.sh            # daemon loop (start under setsid+nohup)
#   ops/supervisor.sh --once     # DRY RUN: one check cycle, prints facts +
#                                # verdict + the actions it WOULD take;
#                                # executes and persists nothing
#   SUPERVISOR_DRY_RUN=1 ops/supervisor.sh   # loop that never mutates (rehearsal)
#
# Environment knobs (all optional): SUPERVISOR_INTERVAL (60),
# SUPERVISOR_SITE_DIR, SUPERVISOR_HEALTH_URL, SUPERVISOR_PORT (3000),
# SUPERVISOR_BOOT_WAIT (180s — ensureSchema takes ~65s on a healthy DB),
# SUPERVISOR_HB_SCRIPT, SUPERVISOR_HB_LOG, SUPERVISOR_LOG.
# ============================================================================
set -u
. /etc/profile >/dev/null 2>&1
export HOME="${SUPERVISOR_HOME:-/home/agent-lead}"

SITE_DIR="${SUPERVISOR_SITE_DIR:-/home/team/shared/site}"
RUN_DIR="$SITE_DIR/.run"
SERVER_LOCK="$RUN_DIR/server.lock"
STATE_FILE="$RUN_DIR/supervisor-state.json"
LOCK_FILE="$RUN_DIR/supervisor.lock"
LOG_FILE="${SUPERVISOR_LOG:-$RUN_DIR/supervisor.log}"
FACTS_FILE="$RUN_DIR/supervisor-facts.tmp"
NEXT_STATE_FILE="$RUN_DIR/supervisor-state.next.tmp"
DECIDE="$SITE_DIR/ops/supervisor-decide.ts"
HEALTH_URL="${SUPERVISOR_HEALTH_URL:-http://127.0.0.1:3000/health}"
PORT="${SUPERVISOR_PORT:-3000}"
HB_SCRIPT="${SUPERVISOR_HB_SCRIPT:-$HOME/heartbeat/sync-heartbeat.sh}"
HB_LOG="${SUPERVISOR_HB_LOG:-$HOME/heartbeat/heartbeat.log}"
INTERVAL="${SUPERVISOR_INTERVAL:-60}"
BOOT_WAIT="${SUPERVISOR_BOOT_WAIT:-180}"
DRY_RUN="${SUPERVISOR_DRY_RUN:-0}"
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

log() {
  local line
  line="$(date -u +%FT%TZ) | $*"
  echo "$line" >> "$LOG_FILE" 2>/dev/null
  [ "$ONCE" = "1" ] && echo "LOG | $line"
  return 0
}

# ---------------------------------------------------------------------------
# One decision cycle: collect facts → decide (TS helper) → execute → persist.
# Never fatal: any failure inside is logged and the loop continues.
# ---------------------------------------------------------------------------
cycle() {
  # ---- facts: serve -------------------------------------------------------
  local lock_pid="" lock_alive=0 port_pid="" health_body="" health_ok=0 health_commit=""
  if [ -r "$SERVER_LOCK" ]; then
    lock_pid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$SERVER_LOCK" | head -1)"
  fi
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    lock_alive=1
  fi
  port_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  health_body="$(curl -sS -m 10 -H 'accept: application/json' "$HEALTH_URL" 2>/dev/null || true)"
  case "$health_body" in
    *'"status"'*)
      health_ok=1
      health_commit="$(printf '%s' "$health_body" | sed -n 's/.*"commit":"\([0-9a-fA-F][0-9a-fA-F]*\)".*/\1/p' | head -1)"
      ;;
  esac
  local head_commit
  head_commit="$(git -C "$SITE_DIR" rev-parse --short HEAD 2>/dev/null || true)"

  # ---- facts: heartbeat ---------------------------------------------------
  local hb_procs
  hb_procs="$(pgrep -fc "sync-heartbeat.sh" 2>/dev/null || true)"
  case "$hb_procs" in ''|*[!0-9]*) hb_procs=0 ;; esac

  # ---- decide (pure rules live in the TS helper, bun-test covered) --------
  mkdir -p "$RUN_DIR" 2>/dev/null
  printf '{"lockPid":%s,"lockPidAlive":%s,"healthReachable":%s,"healthCommit":%s,"headCommit":%s,"portPid":%s,"procs":%s}' \
    "${lock_pid:-null}" \
    "$([ "$lock_alive" = "1" ] && echo true || echo false)" \
    "$([ "$health_ok" = "1" ] && echo true || echo false)" \
    "$([ -n "$health_commit" ] && printf '"%s"' "$health_commit" || echo null)" \
    "$([ -n "$head_commit" ] && printf '"%s"' "$head_commit" || echo null)" \
    "$([ -n "$port_pid" ] && printf '"%s"' "$port_pid" || echo null)" \
    "$hb_procs" > "$FACTS_FILE" 2>/dev/null || { log "cycle aborted: cannot write facts file"; return 1; }

  local state_arg="" next_arg="" out verdict
  [ "$ONCE" = "0" ] && state_arg="$STATE_FILE" && next_arg="$NEXT_STATE_FILE"
  out="$(bun "$DECIDE" "$FACTS_FILE" "$state_arg" "$next_arg" 2>>"$LOG_FILE" || true)"
  verdict="$(printf '%s\n' "$out" | head -n 1)"
  case "$verdict" in
    '{'*) : ;;
    *)  log "decide failed (no verdict) — no action this cycle"; return 1 ;;
  esac

  # ---- quiet-healthy logging: state lines and reasons only on change ------
  local reasons state_changed state_line
  reasons="$(printf '%s\n' "$out" | sed -n 's/^LOG | //p' | grep -v '^WARNING' || true)"
  state_changed="$(printf '%s' "$verdict" | sed -n 's/.*"stateChanged":\([a-z]*\).*/\1/p')"
  state_line="$(printf '%s' "$verdict" | sed -n 's/.*"stateLine":"\([^"]*\)".*/\1/p')"
  if [ "$state_changed" = "true" ] || [ "$reasons" != "${last_reasons:-}" ]; then
    printf '%s\n' "$reasons" | while IFS= read -r l; do [ -n "$l" ] && log "$l"; done
  fi
  last_reasons="$reasons"

  # ---- execute actions ----------------------------------------------------
  local serve_action hb_action
  serve_action="$(printf '%s' "$verdict" | sed -n 's/.*"serve":{"action":"\([a-z-]*\)".*/\1/p')"
  hb_action="$(printf '%s' "$verdict" | sed -n 's/.*"hb":{"action":"\([a-z-]*\)".*/\1/p')"

  if [ "$serve_action" = "restart" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      log "DRY RUN: would restart serve (kill lock pid ${lock_pid:-none}, then nohup bun run start)"
    else
      restart_serve "$lock_pid" "$port_pid"
    fi
  fi
  if [ "$hb_action" = "restart" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      log "DRY RUN: would start heartbeat (nohup bash $HB_SCRIPT >> $HB_LOG)"
    else
      log "action: starting heartbeat (nohup bash $HB_SCRIPT >> $HB_LOG)"
      nohup bash "$HB_SCRIPT" >> "$HB_LOG" 2>&1 &
      disown 2>/dev/null || true
    fi
  fi

  # ---- persist state (never in --once: dry diagnostics spend no budget) ---
  if [ "$ONCE" = "0" ] && [ -s "$NEXT_STATE_FILE" ]; then
    mv "$NEXT_STATE_FILE" "$STATE_FILE" 2>/dev/null || true
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Runbook restart: kill the lock pid (ONLY that pid), free the port, plain
# `nohup bun run start`, wait for /health, re-check the commit honestly.
# ---------------------------------------------------------------------------
restart_serve() {
  local lock_pid="$1" port_pid="$2"
  if [ -n "$port_pid" ] && { [ -z "$lock_pid" ] || [ "$port_pid" != "$lock_pid" ]; }; then
    log "restart aborted: port $PORT held by pid $port_pid, not the lock pid ${lock_pid:-none} — outside supervisor scope"
    return 1
  fi
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    log "restart: killing serve pid $lock_pid (from .run/server.lock)"
    kill "$lock_pid" 2>/dev/null || true
    local i=0
    while kill -0 "$lock_pid" 2>/dev/null && [ "$i" -lt 10 ]; do sleep 0.5; i=$((i + 1)); done
    if kill -0 "$lock_pid" 2>/dev/null; then
      log "restart: pid $lock_pid survived TERM — sending KILL"
      kill -9 "$lock_pid" 2>/dev/null || true
      sleep 1
    fi
  else
    log "restart: no live lock pid to kill (lock: ${lock_pid:-none})"
  fi
  local p="" i=0
  while [ "$i" -lt 10 ]; do
    p="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    [ -z "$p" ] && break
    sleep 0.5
    i=$((i + 1))
  done
  if [ -n "$p" ]; then
    log "restart aborted: port $PORT still held by pid $p after the kill — not touching outside scope"
    return 1
  fi
  log "restart: starting serve (nohup bun run start — the documented runbook)"
  ( cd "$SITE_DIR" && nohup bun run start >> /tmp/serve.log 2>&1 & ) 2>/dev/null
  local waited=0 body="" commit=""
  while [ "$waited" -lt "$BOOT_WAIT" ]; do
    sleep 3
    waited=$((waited + 3))
    body="$(curl -sS -m 5 -H 'accept: application/json' "$HEALTH_URL" 2>/dev/null || true)"
    case "$body" in
      *'"status"'*)
        commit="$(printf '%s' "$body" | sed -n 's/.*"commit":"\([0-9a-fA-F][0-9a-fA-F]*\)".*/\1/p' | head -1)"
        break
        ;;
    esac
  done
  if [ -z "$commit" ]; then
    log "restart incomplete: /health not answering after ${BOOT_WAIT}s — the next cycle re-checks"
    return 1
  fi
  local head_now
  head_now="$(git -C "$SITE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if [ "$commit" = "$head_now" ]; then
    log "restart complete: /health answering, commit $commit matches HEAD"
  else
    log "restart complete BUT commit mismatch: serving $commit vs HEAD $head_now — the next cycle re-checks"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------
if [ "$ONCE" = "1" ]; then
  log "dry run (--once): one check cycle, no actions executed, nothing persisted"
  cycle
  log "dry run complete"
  exit 0
fi

mkdir -p "$RUN_DIR" 2>/dev/null
if [ -f "$LOCK_FILE" ]; then
  old_pid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$LOCK_FILE" | head -1)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    echo "supervisor already running (pid $old_pid, lock $LOCK_FILE) — exiting"
    exit 0
  fi
  log "stale supervisor lock (pid ${old_pid:-unreadable} gone) — taking over"
fi
printf '{"pid":%s,"started_at":"%s"}\n' "$$" "$(date -u +%FT%TZ)" > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE" "$FACTS_FILE" "$NEXT_STATE_FILE" 2>/dev/null; exit 0' INT TERM

log "supervisor started (pid $$, interval ${INTERVAL}s, site $SITE_DIR, port $PORT)"
while :; do
  cycle || log "cycle error (non-fatal, continuing): $?"
  sleep "$INTERVAL"
done
