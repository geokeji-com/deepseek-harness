/** Ownerless V2 system prompts refuse ordinary migration; native V4 system rows remain durable. */

import { Context } from '@deepseek-ai/cordis'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const id = SessionId('v2-system-migration')
const config = { provider: 'mock', model: 'mock' }
let root: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-v2-system-migration-'))
})

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

async function writeV2(): Promise<string> {
  const path = generationLogPath(root, undefined, id, 2, 'none')
  await mkdir(dirname(path), { recursive: true })
  const rows = [
    { type: 'session', version: 2, id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
    {
      type: 'turn/start', seq: 0, time: 10, data: { turn: 1 },
    },
    {
      type: 'step/start', seq: 1, time: 11, data: { turn: 1, step: 1 },
    },
    {
      type: 'request/header', seq: 2, time: 12,
      data: { header: { config, system: 'historical prompt' }, reason: 'change' },
    },
    {
      type: 'turn/end', seq: 3, time: 13,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ]
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  return path
}

async function observe(path: string) {
  const identity = await stat(path, { bigint: true })
  return {
    bytes: await readFile(path),
    dev: identity.dev,
    ino: identity.ino,
    size: identity.size,
  }
}

describe('V2 system prompts through current Session and JSONL persistence', () => {
  it.each(['read', 'write'] as const)('refuses ownerless V2 migration during %s open', async (access) => {
    const sourcePath = await writeV2()
    const original = await observe(sourcePath)
    const ctx = await mount()
    const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => {
      await handle.close()
    })
    await expect(opened).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    await expect(opened).rejects.toThrow('owner-aware migration tool')
    expect(await observe(sourcePath)).toEqual(original)
    expect((await readdir(dirname(sourcePath))).filter(name => name !== 'session.lock'))
      .toEqual([basename(sourcePath)])
  })

  it('persists native V4 system appends after the protected head', async () => {
    const ctx = await mount()
    const session = Session.create(id)
    const writer = await ctx.sessionPersistence.create(session.header)
    try {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('system/message', {
        turn: 1, step: 1,
        message: freezeMessage({
          role: 'system', id: MessageId('head'),
          content: [{ type: 'text', text: 'head prompt' }],
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
        }),
      }, { surfaceOp: 'append' })
      session.append('user/message', freezeMessage({
        role: 'user', id: MessageId('question'),
        content: [{ type: 'text', text: 'question' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('system/message', {
        turn: 1, step: 1,
        message: freezeMessage({
          role: 'system', id: MessageId('context'),
          content: [{ type: 'text', text: 'tail context' }],
          source: { kind: 'plugin', plugin: 'context-plugin' },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await writer.append(session.snapshotEvents())
      await writer.flush()
    } finally {
      await writer.close()
    }

    const reopened = await mount()
    const reader = await reopened.sessionPersistence.open(id, 'read')
    try {
      expect((await reader.read()).events).toEqual(session.snapshotEvents())
      const restored = Session.fromRestore(
        id,
        session.snapshotEvents(),
        reader.header,
        reader.inheritedEventCount,
        'detached',
      )
      expect(restored.surface.nodes).toEqual([2, 3, 4])
      expect(restored.deriveMessages().map(message => message.id)).toEqual(['head', 'question', 'context'])
    } finally {
      await reader.close()
    }
  })
})
