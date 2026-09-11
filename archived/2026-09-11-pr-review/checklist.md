# PR review and follow-up fixes

## Scope

- Review `nixyme/deepseek-harness` PR #1 on branch
  `feat/multiuser-web-deployment`.
- Fix confirmed correctness and operational issues on the same branch.
- Keep changes scoped to `deploy/multiuser`.
- Push the result to the existing PR, then leave a GitHub review comment.

## Confirmed findings

- [x] Disabled users can still authenticate with an existing signed cookie.
- [x] A running backend whose launch token has fallen outside the log tail
  cannot be adopted after the manager restarts.
- [x] Rotating one user's password rotates the global cookie secret and logs
  every user out.
- [x] A failed update resets tracked source but does not rebuild the previous
  revision, leaving generated dependencies/artifacts on the new revision.
- [x] Local manager status, logs, and Skill restart loops are hard-coded to the
  initial four users.
- [x] Migration rollback moves directories back but does not restore rewritten
  session headers and projection-cache identities.

## Verification

- [x] Run deployment unit tests: 22/22 passed.
- [x] Run shell syntax checks. ShellCheck was not installed.
- [x] Apply the remote-settings patch check.
- [x] Run `git diff --check`.
- [x] Push commit `6a5e73bca5` to the existing PR branch.
- [x] Submit the review comment and verify it is attached to PR #1.

## Result

- Pull request: https://github.com/nixyme/deepseek-harness/pull/1
- Review state: `COMMENTED`
- Pull request state: `OPEN`
- No GitHub Actions checks are configured for the branch.
