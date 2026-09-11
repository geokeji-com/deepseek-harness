# Workspace Owner Visibility Checklist

- [x] Foreign Workspace id never appears in a baseline.
- [x] Foreign Workspace title and path never appear in a baseline.
- [x] Foreign Workspace order ids never appear in follow frames.
- [x] Foreign upserts are suppressed or projected as removal only when needed.
- [x] Foreign rename/delete/reorder returns `workspace/not-found`.
- [x] Foreign title conflicts do not block an owned rename.
- [x] Owned empty Workspaces remain visible.
- [x] Owned Session membership remains filtered by Session owner.
- [x] Shared overlay passes `DSH_WORKSPACE` into `workspace-controller`.
- [x] Focused host tests, host build, lint, and path-policy tests pass.
