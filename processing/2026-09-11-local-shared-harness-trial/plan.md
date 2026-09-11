# Local Shared Harness Trial

## Objective

Start the current shared-Harness implementation on the local Mac without
touching the existing Harness on port 3080, then expose one browser URL for a
two-account isolation experiment.

## Ports

- `3180`: browser edge router
- `3181`: authentication service
- `3182`: multiuser proxy
- `3194`: shared Harness

## Plan

- [x] Create an isolated trial home under `/tmp/dsh-shared-harness-local`.
- [x] Clone the existing web profile and copy settings/credentials only.
- [x] Generate principal, cookie, and test-user secrets.
- [x] Start and verify the shared Harness on loopback.
- [x] Start and verify the multiuser proxy.
- [x] Start the temporary HTTP/WebSocket edge router.
- [x] Verify login, latest Web UI loading, and two-account isolation.
- [x] Record URLs, credentials, PIDs, logs, and stop instructions.

## Constraints

- Leave the existing Harness PID `11411` and port `3080` untouched.
- Keep all trial state outside the repository and production state.
- Do not modify or clean the repository's uncommitted implementation changes.
