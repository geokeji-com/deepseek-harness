# Shared Harness Isolation Implementation

## Objective

Replace the per-user Harness process model with one shared Harness while
preserving per-session ownership isolation for authenticated users.

## Acceptance

- A signed request principal is the only trusted user identity after the proxy.
- Every Session API and Session event is scoped to the persisted owner.
- Workspace projections expose only the caller's sessions.
- Session format v4 persists `ownerUserId`; migration never rewrites v3 logs.
- Agent residency, turn concurrency, FIFO admission, and idle eviction are
  centrally enforced.
- Deployment supports shared and legacy backend modes with a rollback path.
- Focused tests cover cross-owner denial, migration, lifecycle, and overload.

## Workstreams

- [x] Persist implementation checklist and progress evidence.
- [x] Add request-principal parsing, signing, propagation, and tests.
- [x] Add Session v4 owner metadata and v3-to-v4 migration support.
- [x] Enforce owner checks across Session and Workspace APIs/events.
- [x] Add shared Agent pool and turn admission controls.
- [x] Add shared deployment mode, path policy, and migration tooling.
- [x] Run focused tests, typecheck, and production-representative validation.
- [x] Audit, archive process evidence, and report residual risk.

## Completion Evidence

- Signed principals are method/path-bound, proxy headers are stripped, and the
  shared Harness service explicitly binds `127.0.0.1`.
- Session v4 persists `ownerUserId`; trusted migration tooling assigns owners
  explicitly and never rewrites v3 generations.
- Session, Workspace, Gateway, Remote Event, stream mux, and control streams
  enforce owner visibility; cross-owner Session access returns
  `session/not-found`.
- The shared pool caps total residency at 64, reserves eight child slots,
  evicts idle top-level Agents after 30 minutes, and cold-resumes disposed
  handles.
- Turn admission caps concurrent work at 32 with a 64-entry FIFO queue and a
  120-second timeout.
- Deployment defaults to `BACKEND_MODE=shared`, retains `legacy`, and provides
  session and Workspace migration tools with rollback-safe publication.

## Residual Risk

- This workspace validates the implementation and fixtures, not the target
  host migration itself. Production backup, dry run, cutover, and rollback
  remain operator actions.
- The 50-user load test enforces the 3.5 GB process RSS ceiling and a cold
  resume p95 below three seconds in the test process; target-host monitoring is
  still required after deployment.

## Constraints

- Do not modify `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR` or
  `CODEX_SANDBOX_ENV_VAR`.
- Preserve all committed Session generations.
- Do not delete or rewrite the existing untracked `archived/` directory.
- Treat the target deployment as a semi-trusted team, not a hostile tenant
  boundary.
