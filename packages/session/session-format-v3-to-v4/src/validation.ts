/** Native V4 owner validation layered over the released V3 artifact checks. */

import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV3Header, restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3'

/**
 * Validate current V4 identity without requiring an owner for local-only use.
 * @param header - decoded V4 Session header.
 */
export function assertReleasedV4Header(header: SessionFormatHeader): void {
  if (header.version !== 4) throw new SessionFormatError('expected format v4 header')
  if (header.ownerUserId !== undefined
    && (typeof header.ownerUserId !== 'string' || header.ownerUserId.length === 0)) {
    throw new SessionFormatError('format v4 ownerUserId must be a non-empty string')
  }
  const { ownerUserId: _ownerUserId, ...v3 } = header
  assertReleasedV3Header({ ...v3, version: 3 })
}

/**
 * Validate a V4 artifact with the frozen V3 event semantics.
 * @param artifact - detached V4 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the same validated artifact.
 */
export function restoreReleasedV4Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV4Header(artifact.header)
  const { ownerUserId: _ownerUserId, ...v3 } = artifact.header
  restoreReleasedV3Artifact(
    { ...artifact, header: { ...v3, version: 3 } },
    knownEventTypes,
  )
  return artifact
}
