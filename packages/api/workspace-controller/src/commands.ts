/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import {
  currentRequestPrincipal,
  requestPrincipalOwns,
  type RequestPrincipal,
} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  realpathNormalize,
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceAccess, workspacePathVisible } from './authorization.ts'
import { workspaceView } from './feed.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspaceRenameRequest,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param ownerWorkspaceRoot - team Workspace root containing member directories.
   */
  constructor(
    private readonly ctx: Context,
    private readonly ownerWorkspaceRoot?: string,
  ) {}

  /**
   * Create or resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    const principal = currentRequestPrincipal(this.ctx)
    return this.enqueue(async () => {
      try {
        if (!workspacePathVisible(principal, this.ownerWorkspaceRoot, request.path)) {
          throw invalidWorkspacePath(request.path)
        }
        const canonical = await realpathNormalize(request.path)
        if (!workspacePathVisible(principal, this.ownerWorkspaceRoot, canonical)) {
          throw invalidWorkspacePath(request.path)
        }
        const existing = await this.ctx.workspaceRegistry.resolveByPath(canonical)
        if (existing !== undefined) {
          const access = this.access(principal)
          return {
            workspace: workspaceView(existing, sessionId => access.session(sessionId)),
            created: false,
          }
        }
        const workspace = await this.ctx.workspaceRegistry.create(canonical)
        const access = this.access(principal)
        return {
          workspace: workspaceView(workspace, sessionId => access.session(sessionId)),
          created: true,
        }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    const principal = currentRequestPrincipal(this.ctx)
    const access = this.access(principal)
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId, access)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id
          && access.workspace(candidate)
          && candidate.title === title)) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace, sessionId => access.session(sessionId)) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    const access = this.access(currentRequestPrincipal(this.ctx))
    return this.enqueue(async () => {
      this.requireWorkspace(request.workspaceId, access)
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete caller-visible Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    const access = this.access(currentRequestPrincipal(this.ctx))
    this.requireWorkspace(request.workspaceId, access)
    if (request.beforeWorkspaceId !== undefined) {
      this.requireWorkspace(request.beforeWorkspaceId, access)
    }
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        WorkspaceId(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : WorkspaceId(request.beforeWorkspaceId),
      )
      return {
        workspaceIds: workspaceIds.filter((workspaceId) => {
          const workspace = this.ctx.workspaceRegistry.get(workspaceId)
          return workspace !== undefined && access.workspace(workspace)
        }),
      }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    const principal = currentRequestPrincipal(this.ctx)
    const access = this.access(principal)
    const workspace = this.requireWorkspace(request.workspaceId, access)
    this.requireOwnedSession(request.sessionId, principal)
    if (request.beforeSessionId !== undefined) {
      this.requireOwnedSession(request.beforeSessionId, principal)
    }
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace, sessionId => access.session(sessionId)) }
  }

  /**
   * Add one known Session to the registry-global archive set.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    const principal = currentRequestPrincipal(this.ctx)
    const access = this.access(principal)
    this.requireOwnedSession(request.sessionId, principal)
    try {
      await this.ctx.workspaceRegistry.archiveSession(request.sessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceUnknownSessionError)) throw error
      throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
    }
    return {
      archivedSessionIds: this.ctx.workspaceRegistry.archivedSessionIds
        .filter(sessionId => access.session(sessionId)),
    }
  }

  private access(principal: RequestPrincipal | undefined): WorkspaceAccess {
    return new WorkspaceAccess(this.ctx, this.ownerWorkspaceRoot, principal)
  }

  private requireOwnedSession(
    sessionId: SessionId,
    principal: RequestPrincipal | undefined,
  ): void {
    const header = this.ctx.workspaceRegistry.sessionHeader(sessionId)
    if (!requestPrincipalOwns(principal, header?.ownerUserId)) {
      throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
    }
  }

  private requireWorkspace(workspaceId: WorkspaceId, access: WorkspaceAccess): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined || !access.workspace(workspace)) {
      throw workspaceNotFound(workspaceId)
    }
    return workspace
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function invalidWorkspacePath(path: string): RemoteError<'workspace/invalid-path'> {
  return new RemoteError(
    'workspace/invalid-path',
    `cannot create a Workspace at "${path}": path is outside the caller's Workspace root`,
    { path },
  )
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
