#!/usr/bin/env bash
set -euo pipefail

TRIAL="${DSH_TRIAL_ROOT:-/tmp/dsh-shared-harness-local}"

for name in edge proxy harness; do
  file="$TRIAL/run/$name.pid"
  if [[ ! -f "$file" ]]; then
    continue
  fi
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    printf 'stopped %s pid=%s\n' "$name" "$pid"
  fi
done
