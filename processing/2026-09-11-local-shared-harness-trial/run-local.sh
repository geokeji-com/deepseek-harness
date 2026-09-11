#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TRIAL="${DSH_TRIAL_ROOT:-/tmp/dsh-shared-harness-local}"
NODE_BIN="${DSH_NODE_BIN:-/Users/nixy/.nvm/versions/node/v22.22.0/bin}"
EDGE_SCRIPT="$SCRIPT_DIR/edge-router.mjs"
SHARED_HARNESS_OVERLAY="$REPO_ROOT/deploy/multiuser/server/shared-harness.overlay.yml"

HARNESS_PID=""
PROXY_PID=""
EDGE_PID=""

cleanup() {
  trap - EXIT INT TERM
  for pid in "$EDGE_PID" "$PROXY_PID" "$HARNESS_PID"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  while read -r job; do
    kill "$job" 2>/dev/null || true
  done < <(jobs -p)
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for port in 3180 3181 3182 3194; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'port %s is already in use\n' "$port" >&2
    exit 1
  fi
done

LIVE_ENV=(
  PATH="$NODE_BIN:$PATH"
  DSH_HOME="$TRIAL/home"
  DSH_WORKSPACE="$TRIAL/workspace"
  DSH_PORT=3194
  NODE_OPTIONS=--max-old-space-size=4096
)

env "${LIVE_ENV[@]}" \
  DSH_REQUEST_PRINCIPAL_SECRET="$(cat "$TRIAL/principal.secret")" \
  "$NODE_BIN/node" --import tsx/esm apps/cli/src/bin.ts \
    --patch "$SHARED_HARNESS_OVERLAY" \
    --profile trial --no-open --host 127.0.0.1 --port 3194 \
  >"$TRIAL/logs/harness.log" 2>&1 &
HARNESS_PID=$!
printf '%s\n' "$HARNESS_PID" >"$TRIAL/run/harness.pid"

for _ in $(seq 1 200); do
  if ! kill -0 "$HARNESS_PID" 2>/dev/null; then
    printf 'shared Harness exited during startup\n' >&2
    exit 1
  fi
  if lsof -nP -iTCP:3194 -sTCP:LISTEN >/dev/null 2>&1 \
    && rg -q 'dsh web:[^\r\n]*\?token=' "$TRIAL/logs/harness.log"; then
    break
  fi
  sleep 0.5
done

env \
  PATH="$NODE_BIN:$PATH" \
  BACKEND_MODE=shared \
  MANAGER_PROXY_PORT=3182 \
  AUTH_PORT=3181 \
  PUBLIC_HOST=localhost:3180 \
  REQUEST_PRINCIPAL_SECRET="$(cat "$TRIAL/principal.secret")" \
  SHARED_DSH_HOME="$TRIAL/home" \
  SHARED_HARNESS_PORT=3194 \
  SHARED_HARNESS_SERVICE=dsh-shared-harness.service \
  SHARED_HARNESS_LOG="$TRIAL/logs/harness.log" \
  TEAM_WORKSPACE_ROOT="$TRIAL/workspace" \
  TEAM_WORKSPACE_PER_USER=true \
  WORKSPACE_ROOT="$TRIAL/workspace" \
  SHARED_PROJECTS_ROOT="$TRIAL/shared" \
  SHARED_SKILLS_ROOT="$TRIAL/skills" \
  SHARED_PROFILES_ROOT="$TRIAL/home/profiles" \
  SHARED_PRESETS_ROOT="$TRIAL/presets" \
  INSTANCE_ROOT="$TRIAL/instances" \
  AUTH_COOKIE_SECRET="$(cat "$TRIAL/cookie.secret")" \
  AUTH_COOKIE_SECURE=false \
  USERS_FILE="$TRIAL/users.json" \
  "$NODE_BIN/node" deploy/multiuser/server/main.mjs \
  >"$TRIAL/logs/proxy.log" 2>&1 &
PROXY_PID=$!
printf '%s\n' "$PROXY_PID" >"$TRIAL/run/proxy.pid"

for _ in $(seq 1 80); do
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    printf 'multiuser proxy exited during startup\n' >&2
    exit 1
  fi
  if curl -fsS --max-time 1 http://127.0.0.1:3181/healthz >/dev/null 2>&1 \
    && lsof -nP -iTCP:3182 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

env \
  PATH="$NODE_BIN:$PATH" \
  EDGE_HOST=127.0.0.1 \
  EDGE_PORT=3180 \
  AUTH_PORT=3181 \
  MANAGER_PROXY_PORT=3182 \
  "$NODE_BIN/node" "$EDGE_SCRIPT" \
  >"$TRIAL/logs/edge.log" 2>&1 &
EDGE_PID=$!
printf '%s\n' "$EDGE_PID" >"$TRIAL/run/edge.pid"

for _ in $(seq 1 40); do
  if ! kill -0 "$EDGE_PID" 2>/dev/null; then
    printf 'edge router exited during startup\n' >&2
    exit 1
  fi
  if curl -fsS --max-time 1 http://localhost:3180/healthz >/dev/null 2>&1; then
    printf 'ready: http://localhost:3180\n'
    printf 'harness_pid=%s proxy_pid=%s edge_pid=%s\n' \
      "$HARNESS_PID" "$PROXY_PID" "$EDGE_PID"
    while kill -0 "$HARNESS_PID" 2>/dev/null \
      && kill -0 "$PROXY_PID" 2>/dev/null \
      && kill -0 "$EDGE_PID" 2>/dev/null; do
      sleep 60
    done
    exit 1
  fi
  sleep 0.25
done

printf 'edge router did not become ready\n' >&2
exit 1
