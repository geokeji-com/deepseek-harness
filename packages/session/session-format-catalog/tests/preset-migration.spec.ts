/** Every historical entry generation migrates all preset selections before projection or fork. */

import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '../src/index.ts'
import { releasedV0SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV1SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import {
  assertReleasedV3Header,
  releasedV2SessionFormatCodec,
  releasedV3SessionFormatCodec,
  restoreReleasedV3Artifact,
  sessionFormatV2ToV3,
} from '@deepseek-ai/dsh-session-format-v2-to-v3'

const currentV3Catalog = createSessionFormatCatalog({
  currentVersion: 3,
  codecs: [
    releasedV0SessionFormatCodec,
    releasedV1SessionFormatCodec,
    releasedV2SessionFormatCodec,
    releasedV3SessionFormatCodec,
  ],
  currentEncoder: releasedV3SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
  restoreCurrent: artifact => restoreReleasedV3Artifact(artifact, new Set()),
  restoreTransformedCurrent: artifact => restoreReleasedV3Artifact(artifact, new Set()),
  restoreCurrentHeader(header) {
    assertReleasedV3Header(header)
    return header
  },
})

describe('catalog preset migration', () => {
  it.each([0, 1, 2])('migrates a seeded v%i header and every inherited/local selection', (version) => {
    const header = {
      type: 'session', version, id: 'code', createdAt: 1, parentSession: 'parent', delegationDepth: 0,
      agentPreset: 'code', ...(version === 2 ? { isSeeded: true } : { seedLength: 2 }),
    }
    const selections = ['code', 'standard', 'code', 'minimal', 'code']
    const rows = selections.map((agentPreset, index) => ({
      type: 'agent-preset/selected', seq: index + (version === 2 && index >= 2 ? 1 : 0),
      time: index + 1, data: { agentPreset },
    }))
    const source = version === 2
      ? [...rows.slice(0, 2), { type: 'session/end-seed', seq: 2, time: 2, data: { inherited: true } }, ...rows.slice(2)]
      : rows
    const before = JSON.stringify({ header, source })
    const restore = currentV3Catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of source) restore.decodeRow(row)
    const artifact = restore.finish()
    expect(artifact.header).toMatchObject({ version: 3, id: 'code', agentPreset: 'ptc', isSeeded: true })
    expect(artifact.inheritedEventCount).toBe(2)
    expect(artifact.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(artifact.events.filter(event => event.type === 'agent-preset/selected').map(event => event.data))
      .toEqual(['ptc', 'standard', 'ptc', 'minimal', 'ptc'].map(agentPreset => ({ agentPreset })))
    expect(artifact.events[2]).toMatchObject({ type: 'session/end-seed', data: { inherited: true } })
    expect(JSON.stringify({ header, source })).toBe(before)
  })

  it('does not reinterpret a native v3 custom preset named code', () => {
    const header = {
      type: 'session', version: 4, id: 'native', ownerUserId: 'principal-a', createdAt: 1, isSeeded: false,
      delegationDepth: 0, agentPreset: 'code',
    }
    const row = { type: 'agent-preset/selected', seq: 0, time: 1, data: { agentPreset: 'code' } }
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    restore.decodeRow(row)
    expect(restore.finish()).toMatchObject({ header: { agentPreset: 'code' }, events: [row] })
  })
})
