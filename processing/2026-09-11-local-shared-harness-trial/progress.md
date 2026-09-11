# Progress

## 2026-09-11

- Confirmed the repository entry `/tmp/web_dsh_repo`, branch `master`, and
  current HEAD `624059a70e4fc81df41a58a78f5b49695708de51`.
- Confirmed the existing Harness PID `11411` is still running and must remain
  untouched.
- Confirmed ports `3180`, `3181`, `3182`, and `3194` are free.
- Confirmed no system Nginx is installed, so a temporary Node edge router is
  required.
- Confirmed the latest frontend build exists at `apps/web/dist/index.html`.
- Confirmed the existing web profile is approximately 539 MB and will be
  clone-copied into the isolated trial home rather than symlinked.
- Created an isolated `DSH_HOME`, cloned the profile tree, copied only
  `settings.yaml` and `.credentials.yaml`, and generated four local test
  accounts.
- Found and fixed a shared-Harness startup blocker: the web bundle's
  `connection` row read `ctx.webStartup.requestPrincipalSecret` without
  declaring `webStartup` as an injected dependency.
- Added a regression assertion over the real bundle patch file.
- Started the trial on `http://localhost:3180` with one shared Harness process.
- Verified the latest Web UI loads through the authenticated edge route.
- Verified an owner-created Session is absent from `member2`'s list and that a
  cross-owner rename returns `session/not-found`.
- Verified `/api/remote.mux` WebSocket upgrade succeeds through the edge route.
- The existing Harness on port `3080` remains untouched.
- Safari rejected the default `Secure` authentication cookie on plain
  `http://localhost`, so password verification succeeded but the follow-up
  request was anonymous.
- Added explicit `AUTH_COOKIE_SECURE` configuration with a secure production
  default and `false` for the local HTTP trial.
- Re-ran the auth/config tests (`5/5`) and verified the local login response no
  longer emits `Secure`.

## Workspace layout optimization

- Added `TEAM_WORKSPACE_PER_USER` with a secure/default-on behavior for shared
  deployments. When enabled, each authenticated principal defaults to
  `TEAM_WORKSPACE_ROOT/<userId>`.
- Added startup-time Workspace layout initialization before the proxy listens:
  the shared root is created with mode `0711`, and every enabled member folder
  is created and enforced as mode `0700`.
- Kept one shared Harness process. The path policy now separates shared Harness
  state from per-user default Workspace roots, including omitted
  `directoryPicker/list` and `session/create` requests.
- Replaced the shared deployment's loopback-triggered native OS chooser with the
  in-browser `browse` directory picker. The browser flow carries the principal
  through the proxy, so its first listing can be rewritten to the caller's
  private Workspace.
- Added `deploy/multiuser/server/shared-harness.overlay.yml` and wired it into
  both the shared systemd service and the local trial launcher.
- Added targeted tests for config validation, shared-mode per-user path
  defaults, startup directory creation, disabled members, and permission
  tightening; `15/15` pass.
- Restarted the local trial on `http://localhost:3180` with:
  - shared Harness PID `42722`
  - multiuser proxy PID `42769`
  - edge router PID `42778`
- End-to-end verification now asserts both owners' default directory plus the
  existing UI, Session isolation, cross-owner not-found, and WebSocket checks.
  It passed with:
  - owner -> `/tmp/dsh-shared-harness-local/workspace/owner`
  - member2 -> `/tmp/dsh-shared-harness-local/workspace/member2`
