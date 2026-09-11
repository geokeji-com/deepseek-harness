#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_ROOT/config/server.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  printf 'missing config: %s\n' "$CONFIG_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${SERVER_HOST:?SERVER_HOST is required}"
: "${SERVER_USER:?SERVER_USER is required}"
: "${SSH_KEY:?SSH_KEY is required}"
: "${REMOTE_REPO:?REMOTE_REPO is required}"
: "${REMOTE_MIRROR_ROOT:?REMOTE_MIRROR_ROOT is required}"
: "${REMOTE_WORKSPACE_ROOT:?REMOTE_WORKSPACE_ROOT is required}"
: "${REMOTE_SHARED_ROOT:?REMOTE_SHARED_ROOT is required}"

SSH_KEY="${SSH_KEY/#\~/$HOME}"
SSH_OPTS=(
  -i "$SSH_KEY"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$HOME/.ssh/known_hosts"
  -o ConnectTimeout=10
)
SSH_TARGET="$SERVER_USER@$SERVER_HOST"

remote() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"
}

require_user() {
  local user="${1:-}"
  if [[ "$user" == "shared" || "$user" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
    return 0
  fi
  printf 'user must be a valid member id or shared\n' >&2
  exit 2
}

require_instance_user() {
  local user="${1:-}"
  if [[ "$user" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
    return 0
  fi
  printf 'logs requires a valid member id\n' >&2
  exit 2
}

workspace_local_path() {
  if [[ "$1" == "shared" ]]; then
    printf '%s/workspace/shared\n' "$PROJECT_ROOT"
  else
    printf '%s/workspace/%s\n' "$PROJECT_ROOT" "$1"
  fi
}

workspace_remote_path() {
  if [[ "$1" == "shared" ]]; then
    printf '%s/projects\n' "$REMOTE_SHARED_ROOT"
  else
    printf '%s/%s\n' "$REMOTE_WORKSPACE_ROOT" "$1"
  fi
}

log_trace() {
  local event="$1" level="$2" trace_id="$3" status="$4" reason="$5"
  printf '{"timestamp":"%s","event":"%s","level":"%s","trace_id":"%s","service":"dsh-web-local","env":"macos","status":"%s","decision_reason":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" "$level" "$trace_id" "$status" "$reason"
}
