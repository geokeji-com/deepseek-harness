# Shared Harness Production Deployment

## Objective

Deploy commit `dcd3326a4d` to the DeepSeek ECS host while protecting the
existing owner/member data and keeping peak memory below the host limit.

## Safety Constraints

- Do not use the legacy `deepseek-harness-update` path for this deployment.
- Stop every writing Harness and proxy unit before taking the data snapshot.
- Build inside a constrained systemd scope with explicit memory, swap, task,
  and CPU limits.
- Keep the old branch, old services, and v3 session files recoverable.
- Do not declare success until the shared process, owner isolation, workspace
  layout, login path, and resource limits have been verified.

## Steps

1. Fix deployment safety gaps and run focused multiuser tests.
2. Commit and push the deployment fixes.
3. Push the exact commit to the server as `deploy-shared-harness`.
4. Stop the proxy and per-user Harness units, then snapshot config, state, and
   workspaces with checksums.
5. Install dependencies and build serially inside a memory-constrained scope.
6. Run the shared-mode installer and start the shared Harness.
7. Verify resource limits, a single backend process, workspace permissions,
   v4 session owners, cross-owner rejection, login, and HTTP/WebSocket health.
8. Record evidence and retain the rollback point.
