/** Request-principal checks shared by owner-scoped Session operations. */

import type { Context } from '@deepseek-ai/cordis'
import {
  currentRequestPrincipal,
  requestPrincipalOwns,
  type RequestPrincipal,
  type UserId,
} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Read the verified principal for the current request chain.
 * @param ctx - Host context carrying the Connection request-principal service.
 * @returns the verified principal, or undefined in local-only mode.
 */
export function requestPrincipalOf(ctx: Context): RequestPrincipal | undefined {
  return currentRequestPrincipal(ctx)
}

/**
 * Return the durable owner recorded for a newly created request-scoped record.
 * @param ctx - Host context carrying the Connection request-principal service.
 * @returns the verified user id, or undefined in local-only mode.
 */
export function requestOwnerOf(ctx: Context): UserId | undefined {
  return requestPrincipalOf(ctx)?.userId
}

/**
 * Test one durable owner against a verified request principal.
 * @param principal - verified request principal, or undefined in local-only mode.
 * @param ownerUserId - durable owner recorded on the Session.
 * @returns whether the Session is visible to the caller.
 */
export function principalOwns(
  principal: RequestPrincipal | undefined,
  ownerUserId: string | undefined,
): boolean {
  return requestPrincipalOwns(principal, ownerUserId)
}

/**
 * Build the opaque failure returned for every inaccessible Session.
 * @param sessionId - requested Session identity.
 * @returns the stable not-found Remote failure.
 */
export function sessionNotFound(sessionId: SessionId): RemoteError<'session/not-found'> {
  return new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
}

/**
 * Require one verified principal to own a durable Session.
 * @param principal - verified request principal, or undefined in local-only mode.
 * @param ownerUserId - durable Session owner.
 * @param sessionId - requested Session identity.
 */
export function assertPrincipalOwns(
  principal: RequestPrincipal | undefined,
  ownerUserId: string | undefined,
  sessionId: SessionId,
): void {
  if (!principalOwns(principal, ownerUserId)) throw sessionNotFound(sessionId)
}
