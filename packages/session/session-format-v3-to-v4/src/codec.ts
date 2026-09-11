/** V4 framing around the released V3 event codec, adding the persisted owner. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertReleasedV4Header } from './validation.ts'

/** V4 codec preserves all released V3 event validation while carrying owner metadata. */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    const ownerUserId = ownerFromPhysicalHeader(value)
    const decoded = releasedV3SessionFormatCodec.decodeHeader(v3PhysicalHeader(value))
    return {
      ...decoded,
      version: 4,
      ...(ownerUserId === undefined ? {} : { ownerUserId }),
    }
  },
  createDecoder(value, recovery) {
    const ownerUserId = ownerFromPhysicalHeader(value)
    const decoder = releasedV3SessionFormatCodec.createDecoder(v3PhysicalHeader(value), recovery)
    return {
      ...decoder,
      header: {
        ...decoder.header,
        version: 4,
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV4Header(header)
    const { ownerUserId, ...v3 } = header
    return {
      ...releasedV3SessionFormatCodec.encodeHeader({ ...v3, version: 3 }, inheritedEventCount),
      version: 4,
      ...(ownerUserId === undefined ? {} : { ownerUserId }),
    }
  },
  encodeEvent: releasedV3SessionFormatCodec.encodeEvent,
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

function ownerFromPhysicalHeader(value: unknown): string | undefined {
  const header = snapshotSessionFormatJson(value, 'format v4 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 4) {
    throw new SessionFormatError('expected format v4 physical Session header')
  }
  const ownerUserId = header['ownerUserId']
  if (ownerUserId === undefined) return undefined
  if (typeof ownerUserId !== 'string' || ownerUserId.length === 0) {
    throw new SessionFormatError('format v4 ownerUserId must be a non-empty string')
  }
  return ownerUserId
}

function v3PhysicalHeader(value: unknown): SessionFormatHeader {
  const header = snapshotSessionFormatJson(value, 'format v4 physical header')
  if (!isSessionFormatJsonObject(header) || header['version'] !== 4) {
    throw new SessionFormatError('expected format v4 physical Session header')
  }
  const { ownerUserId: _ownerUserId, ...rest } = header
  return { ...rest, version: 3 } as SessionFormatHeader
}
