/** Explicitly refuses implicit V3-to-V4 migration because V3 has no owner. */

import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  defineSessionFormatMigration,
  isSessionFormatJsonObject,
  sessionFormatCount,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatHeader,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header } from './validation.ts'

const OWNER_REQUIRED =
  'format v3 has no ownerUserId; run the owner-aware migration tool to publish a new format v4 generation'

/** V3 logs are never guessed into ownership during ordinary reads. */
export const sessionFormatV3ToV4 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v3-to-v4',
  fromVersion: 3,
  toVersion: 4,
  migrateHeader(_header: SessionFormatHeader): SessionFormatHeader {
    throw new SessionFormatUnsupportedMigrationError(OWNER_REQUIRED)
  },
  createStage(): SessionFormatMigrationStage {
    throw new SessionFormatUnsupportedMigrationError(OWNER_REQUIRED)
  },
  validateTargetHeader: assertReleasedV4Header,
})

/** Marker used by tests and tooling to recognize the owner-required refusal. */
export const SESSION_V4_OWNER_REQUIRED = OWNER_REQUIRED

/**
 * Build an explicitly owned V3-to-V4 migration for trusted local tooling.
 * Ordinary Session reads must continue to use {@link sessionFormatV3ToV4}.
 * @param ownerUserId - caller-supplied owner persisted on the migrated header.
 * @returns adjacent migration that preserves the complete V3 event stream.
 */
export function createSessionFormatV3ToV4Migration(ownerUserId: string): SessionFormatMigration {
  if (ownerUserId.length === 0) throw new SessionFormatError('format v4 ownerUserId must be a non-empty string')
  return defineSessionFormatMigration({
    name: '@deepseek-ai/dsh-session-format-v3-to-v4/explicit-owner',
    fromVersion: 3,
    toVersion: 4,
    migrateHeader(header) {
      if (header.version !== 3) throw new SessionFormatError('expected format v3 header')
      return { ...header, version: 4, ownerUserId }
    },
    createStage(input) {
      return new ExplicitOwnerV3ToV4Stage(input)
    },
    validateTargetHeader: assertReleasedV4Header,
  })
}

class ExplicitOwnerV3ToV4Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private sourceCut: number | undefined
  private targetCut: number | undefined
  private eventCount = 0

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    if (input.sourceHeader.version !== 3) throw new SessionFormatError('expected format v3 header')
    this.sourceCut = input.sourceHeader.isSeeded ? undefined : 0
    this.targetCut = input.sourceHeader.isSeeded ? undefined : 0
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.eventCount) throw new SessionFormatError('format v3 source events must be dense')
    if (event.type === 'session/end-seed'
      && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) {
        throw new SessionFormatError('format v3 unseeded Session contains an inherited end-seed marker')
      }
      this.sourceCut = event.seq
      this.targetCut = this.eventCount
    }
    this.eventCount += 1
    context.emitEvent(event)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(): number {
    const cut = sessionFormatCount(this.sourceCut, 'format v3 inherited end-seed marker')
    if (this.input.sourceInheritedEventCount !== undefined
      && this.input.sourceInheritedEventCount !== cut) {
      throw new SessionFormatError('format v3 inherited end-seed marker disagrees with its source cut')
    }
    return sessionFormatCount(this.targetCut, 'format v4 inherited event count')
  }
}
