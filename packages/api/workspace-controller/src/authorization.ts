/** Owner-scoped visibility for the global Workspace registry. */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  requestPrincipalOwns,
  type RequestPrincipal,
} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

/**
 * Return whether one Workspace path belongs to the principal's member root.
 * Local mode (no principal) keeps the full registry visible. Shared mode fails
 * closed when the owner root is absent or the user id is not one path segment.
 * @param principal - verified request identity, or undefined in local mode.
 * @param ownerWorkspaceRoot - team Workspace root containing member directories.
 * @param workspacePath - canonical or prospective Workspace path.
 * @returns whether the principal may see the Workspace.
 */
export function workspacePathVisible(
  principal: RequestPrincipal | undefined,
  ownerWorkspaceRoot: string | undefined,
  workspacePath: string,
): boolean {
  if (principal === undefined) return true
  if (ownerWorkspaceRoot === undefined || ownerWorkspaceRoot.trim() === '') return false
  const userId = String(principal.userId)
  if (userId === '' || userId === '.' || userId === '..' || /[/\\]/u.test(userId)) return false
  return isWithin(resolve(ownerWorkspaceRoot, userId), resolve(workspacePath))
}

/** Per-request Workspace and Session visibility snapshot. */
export class WorkspaceAccess {
  /**
   * @param ctx - Host context carrying the Workspace registry.
   * @param ownerWorkspaceRoot - configured team Workspace root.
   * @param principal - verified request identity, or undefined in local mode.
   */
  constructor(
    private readonly ctx: Context,
    private readonly ownerWorkspaceRoot: string | undefined,
    private readonly principal: RequestPrincipal | undefined,
  ) {}

  /**
   * Test one Workspace record against the caller's member root.
   * @param workspace - authoritative Workspace record.
   * @returns whether the Workspace is visible.
   */
  workspace(workspace: Pick<Workspace, 'path'>): boolean {
    return workspacePathVisible(this.principal, this.ownerWorkspaceRoot, workspace.path)
  }

  /**
   * Test one Session against its durable owner.
   * @param sessionId - Session identity to test.
   * @returns whether the Session is visible.
   */
  session(sessionId: string): boolean {
    return requestPrincipalOwns(
      this.principal,
      this.ctx.workspaceRegistry.sessionHeader(sessionId as SessionId)?.ownerUserId,
    )
  }
}

function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const path = relative(root, candidate)
  return path !== ''
    && path !== '..'
    && !path.startsWith(`..${sep}`)
    && !isAbsolute(path)
}
