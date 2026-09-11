# Workspace Owner Visibility Plan

## Goal

In shared-harness mode, each authenticated member must only see Workspace
records rooted under their own member directory. Foreign Workspace identifiers,
titles, paths, order entries, and follow-stream increments must never reach the
browser.

## Design

- Add a Workspace owner policy based on the configured team Workspace root and
  the authenticated principal's user id.
- Preserve local unauthenticated behavior by making every Workspace visible only
  when no principal is present.
- Fail closed when a principal is present but the owner root is not configured.
- Filter baseline rows, Session membership, archived Session ids, Live upserts,
  removals, order frames, and archive frames per follower.
- Require the caller to own a Workspace before rename, delete, reorder, or
  Session-membership mutation. Return `workspace/not-found` for foreign ids.
- Restrict rename conflict checks to Workspaces visible to the caller.
- Configure the shared Harness overlay with `DSH_WORKSPACE` as the owner root.

## Non-goals

- No Workspace schema migration.
- No change to the existing Session v4 owner model.
- No promise of kernel-level isolation inside the shared process.

## Verification

- Two-principal host tests cover baseline, mutations, name conflicts, and follow
  frames while retaining the existing Session owner tests.
- Run the package Vitest suite, host TypeScript build, lint on changed files, and
  the deployment path-policy tests.
