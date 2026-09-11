/** Explicit-owner catalog for trusted local tooling that interprets historical fixtures. */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV1SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import {
  releasedV2SessionFormatCodec,
  releasedV3SessionFormatCodec,
  sessionFormatV2ToV3,
} from '@deepseek-ai/dsh-session-format-v2-to-v3'
import {
  assertReleasedV4Header,
  createSessionFormatV3ToV4Migration,
  releasedV4SessionFormatCodec,
  restoreReleasedV4Artifact,
} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { validateInstalledCurrentSessionArtifact, validateInstalledCurrentSessionHeader } from './current.ts'

/**
 * Build a current catalog whose V3 edge assigns one caller-supplied owner.
 * @param ownerUserId - explicit owner persisted on every migrated V4 header.
 * @returns catalog for trusted fixture/import tooling, never ordinary reads.
 */
export function createOwnerAwareSessionFormatCatalog(ownerUserId: string): SessionFormatCatalog {
  return createSessionFormatCatalog({
    currentVersion: 4,
    codecs: [
      releasedV0SessionFormatCodec,
      releasedV1SessionFormatCodec,
      releasedV2SessionFormatCodec,
      releasedV3SessionFormatCodec,
      releasedV4SessionFormatCodec,
    ],
    currentEncoder: releasedV4SessionFormatCodec,
    migrations: [
      sessionFormatV0ToV1,
      sessionFormatV1ToV2,
      sessionFormatV2ToV3,
      createSessionFormatV3ToV4Migration(ownerUserId),
    ],
    restoreCurrent(artifact) {
      const restored = restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
      validateInstalledCurrentSessionArtifact(restored)
      return restored
    },
    restoreTransformedCurrent(artifact) {
      return restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
    },
    restoreCurrentHeader(header) {
      assertReleasedV4Header(header)
      validateInstalledCurrentSessionHeader(header)
      return header
    },
  })
}
