# Progress

## 2026-09-11

- Restored the `/tmp/web_dsh_repo` ASCII entry and recorded the repository path.
- Read repository, package, and skill instructions.
- Confirmed branch `master`, HEAD `624059a70e`, and only the pre-existing
  untracked `archived/` directory.
- Found an existing local Web process on port 3081 and a remote build process;
  both remain untouched.
- Started implementation from the identity, persistence, and authorization
  layers before deployment changes.
- Added signed request principals, Connection propagation, Session format v4
  owner metadata, and the owner-aware v3-to-v4 migration boundary.
- Fixed the Gateway WebSocket regression by declaring `requestPrincipal` as an
  injection dependency. The full Gateway stream host suite now passes (22/22).

## Final Verification

- Re-ran owner-aware catalog tests: `2/2` passed.
- Re-ran deployment principal/proxy tests: `6/6` passed.
- Re-ran Session and Workspace migration tool tests: `10/10` passed.
- Re-ran the migration refusal suites after tightening their assertions:
  `86/86` passed across three files.
- Ran the final focused isolation, load, pool, admission, Gateway, Remote,
  Workspace, and control suites: `122/122` passed across 11 files.
- `pnpm typecheck` passed, including host library builds, tsdown, and client
  contracts.
- `git diff --check`, all changed-file oxlint checks, and Shell syntax checks
  passed.
- Added explicit `--host 127.0.0.1` to the shared Harness service so its
  loopback-only boundary is configuration-visible.

## Remaining Operator Work

- Back up production homes, credentials, settings, and Workspace registries.
- Run owner/member pilot migrations and validate Session totals, owners,
  lineages, Workspace membership, search, and login before full cutover.
- Keep the legacy per-user services disabled during observation and retain the
  documented rollback path until the shared deployment is accepted.
