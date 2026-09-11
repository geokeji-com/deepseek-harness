#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/dsh
export PATH="/home/dsh/.tools/pnpm/node_modules/.bin:/usr/bin:/bin"

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_ROOT="$HOME/.config/deepseek-harness"
STATE_ROOT="$HOME/.local/share/deepseek-harness"
LOG_ROOT="$HOME/.local/state/deepseek-harness"
MULTI_ROOT="$CONFIG_ROOT/multiuser"
INSTANCE_ROOT="$STATE_ROOT/instances"
SHARED_ROOT="$STATE_ROOT/shared"
PATCH_ROOT="$STATE_ROOT/patches"
SKILLS_ROOT="$SHARED_ROOT/skills"
WORKSPACE_ROOT="$HOME/workspace"
PROJECT_SHARED_ROOT="$HOME/shared"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="$HOME/.local/state/deepseek-harness/deployment-backups/$STAMP"
OLD_HOME="$STATE_ROOT"

log() {
  local event="$1" status="$2" reason="$3"
  printf '{"timestamp":"%s","event":"%s","level":"%s","trace_id":"install-%s","service":"dsh-multiuser-install","env":"production","status":"%s","decision_reason":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" \
    "$([[ "$event" == *failed ]] && printf error || printf info)" \
    "$STAMP" "$status" "$reason"
}

run_install() {
  log job_started running migrate_current_state
  mkdir -p "$MULTI_ROOT" "$MULTI_ROOT/instances" "$INSTANCE_ROOT" \
    "$SHARED_ROOT" "$PATCH_ROOT" "$SKILLS_ROOT" "$WORKSPACE_ROOT" "$PROJECT_SHARED_ROOT" \
    "$LOG_ROOT/instances" "$BACKUP_ROOT"
  chmod 700 "$MULTI_ROOT" "$BACKUP_ROOT"

  mkdir -p "$BACKUP_ROOT/config" "$BACKUP_ROOT/systemd"
  cp -a "$CONFIG_ROOT/auth.env" "$BACKUP_ROOT/config/" 2>/dev/null || true
  cp -a "$CONFIG_ROOT/auth-server.mjs" "$BACKUP_ROOT/config/" 2>/dev/null || true
  cp -a "$HOME/.config/systemd/user/deepseek-harness.service" "$BACKUP_ROOT/systemd/" 2>/dev/null || true
  cp -a "$HOME/.config/systemd/user/deepseek-harness-auth.service" "$BACKUP_ROOT/systemd/" 2>/dev/null || true

  systemctl --user stop deepseek-harness.service deepseek-harness-auth.service 2>/dev/null || true

  if [[ ! -d "$INSTANCE_ROOT/owner/home" ]]; then
    mkdir -p "$INSTANCE_ROOT/owner/home"
    if [[ -d "$OLD_HOME/sessions" || -f "$OLD_HOME/settings.yaml" ]]; then
      rsync -a --exclude instances --exclude shared --exclude deployment-backups \
        "$OLD_HOME/" "$INSTANCE_ROOT/owner/home/"
    fi
  fi
  if [[ ! -d "$SHARED_ROOT/profiles" && -d "$OLD_HOME/profiles" ]]; then
    cp -a "$OLD_HOME/profiles" "$SHARED_ROOT/profiles"
  fi
  mkdir -p "$SHARED_ROOT/profiles" "$SHARED_ROOT/skills" "$SHARED_ROOT/agent-presets"
  if [[ -d "$OLD_HOME/skills" ]]; then cp -a "$OLD_HOME/skills/." "$SHARED_ROOT/skills/"; fi
  if [[ -d "$OLD_HOME/.agent-presets" ]]; then cp -a "$OLD_HOME/.agent-presets/." "$SHARED_ROOT/agent-presets/"; fi
  install -m 0644 "$SOURCE_DIR/../patches/remote-settings.patch" \
    "$PATCH_ROOT/remote-settings.patch"

  if [[ -d "$WORKSPACE_ROOT/001" && ! -e "$WORKSPACE_ROOT/owner" ]]; then
    cp -a "$WORKSPACE_ROOT/001" "$WORKSPACE_ROOT/owner"
  fi
  mkdir -p "$WORKSPACE_ROOT/owner" "$WORKSPACE_ROOT/member2" \
    "$WORKSPACE_ROOT/member3" "$WORKSPACE_ROOT/member4" "$PROJECT_SHARED_ROOT/projects"
  chmod 700 "$WORKSPACE_ROOT" "$WORKSPACE_ROOT/owner" "$WORKSPACE_ROOT/member2" \
    "$WORKSPACE_ROOT/member3" "$WORKSPACE_ROOT/member4"

  for user in owner member2 member3 member4; do
    local home="$INSTANCE_ROOT/$user/home"
    mkdir -p "$home" "$LOG_ROOT/instances/$user"
    rm -rf "$home/profiles" "$home/skills" "$home/.agent-presets"
    ln -s "$SHARED_ROOT/profiles" "$home/profiles"
    ln -s "$SHARED_ROOT/skills" "$home/skills"
    ln -s "$SHARED_ROOT/agent-presets" "$home/.agent-presets"
    ln -sfn "$PROJECT_SHARED_ROOT/projects" "$WORKSPACE_ROOT/$user/shared"
  done
  log job_succeeded success current_state_migrated
}

install_multiuser() {
  log job_started running install_multiuser
  if [[ ! -f "$CONFIG_ROOT/auth.env" ]]; then
    log job_failed failed missing_owner_auth_env
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$CONFIG_ROOT/auth.env"
  : "${AUTH_PASSWORD_SCRYPT:?missing AUTH_PASSWORD_SCRYPT}"
  : "${AUTH_COOKIE_SECRET:?missing AUTH_COOKIE_SECRET}"

  find "$SOURCE_DIR" -maxdepth 1 -type f -name '*.mjs' ! -name '*.test.mjs' \
    -exec install -m 0700 {} "$MULTI_ROOT/" \;
  cp "$SOURCE_DIR/user-admin.mjs" "$MULTI_ROOT/user-admin.mjs"
  chmod 700 "$MULTI_ROOT"/*.mjs

  local shared_env="$MULTI_ROOT/shared.env"
  local owner_credentials="$INSTANCE_ROOT/owner/home/.credentials.yaml"
  if [[ ! -f "$shared_env" ]]; then
    if [[ ! -f "$owner_credentials" ]]; then
      log job_failed failed missing_owner_credentials
      exit 1
    fi
    node "$MULTI_ROOT/extract-key.mjs" "$owner_credentials" "$shared_env"
  fi
  chmod 600 "$shared_env"

  for item in owner:3090 member2:3091 member3:3092 member4:3093; do
    local user="${item%%:*}"
    local port="${item##*:}"
    local env_file="$MULTI_ROOT/instances/$user.env"
    printf 'DSH_HOME=%s\nDSH_PORT=%s\nDSH_USER_ID=%s\nDSH_WORKSPACE=%s\n' \
      "$INSTANCE_ROOT/$user/home" "$port" "$user" "$WORKSPACE_ROOT/$user" >"$env_file"
    chmod 600 "$env_file"
  done

  INSTANCE_ROOT="$INSTANCE_ROOT" WORKSPACE_ROOT="$WORKSPACE_ROOT" \
    DSH_SHARED_ROOT="$SHARED_ROOT" SHARED_PROJECTS_ROOT="$PROJECT_SHARED_ROOT/projects" \
    SHARED_SKILLS_ROOT="$SKILLS_ROOT" SHARED_PROFILES_ROOT="$SHARED_ROOT/profiles" \
    SHARED_PRESETS_ROOT="$SHARED_ROOT/agent-presets" \
    node "$MULTI_ROOT/render-shared-agents.mjs" \
    owner member2 member3 member4 >/dev/null

  if [[ ! -f "$MULTI_ROOT/users.json" ]]; then
    USERS_FILE="$MULTI_ROOT/users.json" \
      PASSWORD_FILE="$MULTI_ROOT/new-user-passwords.txt" \
      node "$MULTI_ROOT/user-admin.mjs" init "$AUTH_PASSWORD_SCRYPT"
    chmod 600 "$MULTI_ROOT/users.json" "$MULTI_ROOT/new-user-passwords.txt"
  fi

  printf 'MANAGER_PROXY_PORT=3080\nAUTH_PORT=3081\nPUBLIC_HOST=8.130.99.203\nCOOKIE_DAYS=30\nIDLE_MINUTES=120\nSTART_TIMEOUT_SECONDS=45\nWORKSPACE_ROOT=%s\nSHARED_PROJECTS_ROOT=%s\nSHARED_SKILLS_ROOT=%s\nSHARED_PROFILES_ROOT=%s\nSHARED_PRESETS_ROOT=%s\nINSTANCE_ROOT=%s\nAUTH_COOKIE_SECRET=%s\nUSERS_FILE=%s\n' \
    "$WORKSPACE_ROOT" "$PROJECT_SHARED_ROOT/projects" "$SKILLS_ROOT" \
    "$SHARED_ROOT/profiles" "$SHARED_ROOT/agent-presets" "$INSTANCE_ROOT" \
    "$AUTH_COOKIE_SECRET" "$MULTI_ROOT/users.json" >"$MULTI_ROOT/multiuser.env"
  chmod 600 "$MULTI_ROOT/multiuser.env"

  cp "$SOURCE_DIR/dsh-multiuser.service" \
    "$HOME/.config/systemd/user/dsh-multiuser.service"
  cp "$SOURCE_DIR/deepseek-harness-user@.service" \
    "$HOME/.config/systemd/user/deepseek-harness-user@.service"
  mkdir -p "$HOME/bin"
  install -m 0755 "$SOURCE_DIR/deepseek-harness-update" \
    "$HOME/bin/deepseek-harness-update"
  install -m 0755 "$SOURCE_DIR/dsh-user-admin" \
    "$HOME/bin/dsh-user-admin"
  install -m 0755 "$SOURCE_DIR/sync-skills.mjs" \
    "$HOME/bin/dsh-skills-sync"
  install -m 0755 "$SOURCE_DIR/../tools/migrate-workspace.mjs" \
    "$HOME/bin/dsh-migrate-workspace"
  systemctl --user daemon-reload
  systemctl --user enable dsh-multiuser.service >/dev/null
  systemctl --user restart dsh-multiuser.service

  local health=""
  for _ in {1..30}; do
    health="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3081/healthz || true)"
    [[ "$health" == "200" ]] && break
    sleep 1
  done
  if [[ "$health" != "200" ]]; then
    log job_failed failed manager_healthcheck_failed
    exit 1
  fi
  systemctl --user disable deepseek-harness.service deepseek-harness-auth.service \
    >/dev/null 2>&1 || true
  log job_succeeded success multiuser_installed
}

run_install
install_multiuser
