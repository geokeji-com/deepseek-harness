# Progress

- [x] Local commit `dcd3326a4d` identified and pushed to both remotes.
- [x] Server current branch and running units inspected.
- [x] Yishan branding presence checked at the current commit.
- [x] Fix deployment safety gaps and run tests.
- [x] Push deployment branch to server at `367d57b2b6`.
- [x] Stop writers and create checksummed backup.
- [x] Build under constrained resources.
- [x] Run the shared workspace/session migration.
- [x] Replace the shared Harness unit's pnpm wrapper with the direct Node CLI.
- [x] Prove the direct CLI opens `127.0.0.1:3094` in a memory-limited scope.
- [x] Reproduce the production readiness failure from the shared log: the v3
  migration rewrote each Session header `cwd` but retained the old
  cwd-derived project directory.
- [x] Fix the migration target to use the rewritten `cwd`, share the path
  codec across migration tools, and extend the regression test.
- [x] Run all multiuser deployment tests: 42/42 passed.
- [x] Commit and push the direct CLI launcher fix.
- [x] Commit and push the Session directory migration fix.
- [x] Install the fixed unit and start the shared Harness service.
- [x] Verify production behavior and record evidence.

## Owner isolation export hardening

- [x] Confirmed the remaining uncommitted change was the Session log export
  owner check, not unrelated user work.
- [x] Added a required-owner filter to direct exports and descendant exports;
  another owner receives the same `404` as a missing Session.
- [x] Verified locally: `route.host.spec.ts` 4/4, package host typecheck,
  targeted `oxlint`, and `git diff --check` all passed.
- [x] Committed `159335314f fix(session-log-export): enforce owner isolation`
  and pushed it to `origin/master` and `geokeji/master`.
- [x] Pushed the exact commit to the server as
  `deploy-shared-harness-v3`.
- [x] Preserved the server's pre-existing staged
  `processing/2026-09-11-shared-harness-production-deploy/progress.md`
  change while switching branches.
- [x] Attempted the full host build under a 2 GB memory cap. It stalled at
  about 1.91 GB with CPU no longer advancing, so the build scope was stopped;
  both production services remained active and no tracked build output was
  published from that attempt.
- [x] Rebuilt only the affected package under a 1 GB cap:
  package host `tsc` followed by direct `tsdown --env.DSH_BUILD_FACE host`.
  The emitted `packages/session-query/session-log-export/lib/index.js`
  contains the `ownerUserId` guard.
- [x] Restarted only `dsh-shared-harness.service`; the manager proxy was not
  restarted.
- [x] Verified server package tests 4/4 under a 900 MB cap, auth health `200`,
  proxy unauthenticated response `401`, and shared Harness unauthenticated
  response `401`.
- [x] Verified the restarted service has no errors in the journal since its
  `19:58:12 CST` start, no legacy per-user Harness units, and no extra
  build/test scopes left active.

## Deployment evidence

- Deployed commit: `159335314f5558675bd2e81f82b93db20c638869`.
- Server branch: `deploy-shared-harness-v3`.
- Shared Harness PID at verification: `8424`.
- Listener binding: `127.0.0.1:3094` only.
- Manager and auth proxy: PID `5458`, listeners `127.0.0.1:3080` and
  `127.0.0.1:3081`.
- Shared Harness memory after startup: approximately `265 MB`.
- Host memory after deployment: approximately `835 MB` used, `2.7 GiB`
  available, zero swap used.
- Rollback point: branch `deploy-shared-harness-v2` at `548c72dd0a`; its
  source, old v3 logs, and deployment backups remain available.
