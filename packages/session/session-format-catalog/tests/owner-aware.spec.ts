import { describe, expect, it } from 'vitest'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import {
  createSessionFormatV3ToV4Migration,
  releasedV4SessionFormatCodec,
  SESSION_V4_OWNER_REQUIRED,
} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import {
  createOwnerAwareSessionFormatCatalog,
  sessionFormatCatalog,
} from '../src/index.ts'

function sourceHeader(isSeeded: boolean): SessionFormatHeader {
  return {
    version: 3,
    id: 'owner-aware-session',
    createdAt: 1,
    parentSession: 'parent-session',
    isSeeded,
    delegationDepth: 0,
  }
}

function event(
  type: string,
  seq: number,
  data: SessionFormatEvent['data'],
): SessionFormatEvent {
  return { type, seq, time: seq + 1, data }
}

describe('explicit-owner Session format tooling', () => {
  it('keeps ordinary reads owner-required while an explicitly owned catalog migrates in place', () => {
    const header = releasedV3SessionFormatCodec.encodeHeader(sourceHeader(true), 2)
    const rows = [
      event('feedback/record', 0, { text: 'inherited' }),
      event('session/end-seed', 1, { inherited: true }),
      event('feedback/record', 2, { text: 'local' }),
    ]

    expect(sessionFormatCatalog.readHeader(header)).toMatchObject({
      status: 'unsupported',
      reason: SESSION_V4_OWNER_REQUIRED,
    })
    expect(() => sessionFormatCatalog.createRestore(header, {
      recovery: 'strict',
      validation: 'current',
    })).toThrow(/owner-aware migration tool/u)

    const catalog = createOwnerAwareSessionFormatCatalog('member-a')
    expect(catalog.readHeader(header)).toMatchObject({
      status: 'migration-required',
      header: {
        version: 4,
        id: 'owner-aware-session',
        ownerUserId: 'member-a',
      },
    })
    const restore = catalog.createRestore(header, {
      recovery: 'strict',
      validation: 'current',
    })
    for (const row of rows) restore.decodeRow(row)

    expect(restore.finish()).toEqual({
      header: {
        ...sourceHeader(true),
        version: 4,
        ownerUserId: 'member-a',
      },
      inheritedEventCount: 1,
      events: rows,
    })
    expect(catalog.encodeCurrentHeader({
      ...sourceHeader(true),
      version: 4,
      ownerUserId: 'member-a',
    }, 1)).toEqual(releasedV4SessionFormatCodec.encodeHeader({
      ...sourceHeader(true),
      version: 4,
      ownerUserId: 'member-a',
    }, 1))
  })

  it('requires a caller-supplied non-empty owner and rejects cut disagreement', () => {
    expect(() => createSessionFormatV3ToV4Migration('')).toThrow(/non-empty string/u)
    expect(() => createOwnerAwareSessionFormatCatalog('')).toThrow(/non-empty string/u)

    const migration = createSessionFormatV3ToV4Migration('member-a')
    const header = sourceHeader(true)
    const targetHeader = migration.migrateHeader(header)
    const stage = migration.createStage({
      sourceHeader: header,
      targetHeader,
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    const emitted: SessionFormatEvent[] = []
    const context = {
      emitEvent(value: SessionFormatEvent): void {
        emitted.push(value)
      },
      emitRun(): void {},
    }
    stage.transformEvent(event('feedback/record', 0, { text: 'inherited' }), context)
    stage.transformEvent(event('session/end-seed', 1, { inherited: true }), context)

    expect(() => stage.finish(context)).toThrow(/inherited end-seed marker disagrees/u)
    expect(emitted).toEqual([
      event('feedback/record', 0, { text: 'inherited' }),
      event('session/end-seed', 1, { inherited: true }),
    ])
  })
})
