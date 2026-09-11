/** Ownerless V0/V1 generations are refused before any migration publication. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generationLogPath, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'

const id = SessionId('multi-edge-seeded')
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

function message(text: string) {
  return {
    id: text,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

function event(type: string, seq: number, data: object) {
  return { type, seq, time: 100 + seq, data }
}

async function seed(version: 0 | 1, compression: JsonlCompression) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-multi-edge-publication-'))
  roots.push(root)
  const path = generationLogPath(root, undefined, id, version, compression)
  await mkdir(dirname(path), { recursive: true })
  const header = { type: 'session', version, id, createdAt: 1, delegationDepth: 0 }
  const rows = [
    event('turn/start', 0, { turn: 1 }),
    event('step/start', 1, { turn: 1, step: 1 }),
    { ...event('user/message', 2, message('question')), surfaceOp: 'append' },
    event('step/end', 3, { turn: 1, step: 1 }),
    event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const headerLine = JSON.stringify(header) + '\n'
  const body = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  const bytes = compression === 'none' ? Buffer.from(headerLine + body) : Buffer.concat([
    await compressZstdFrame(headerLine),
    await compressZstdFrame(body),
  ])
  await writeFile(path, bytes)
  return { root, path, bytes }
}

async function mount(root: string, compression: JsonlCompression) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return ctx
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

describe.each([0, 1] as const)('V%s multi-edge durable publication', (version) => {
  it.each(['none', 'zstd'] as const)('refuses ownerless read and write without publishing (%s)', async (compression) => {
    const { root, path, bytes } = await seed(version, compression)
    const original = await observe(path)
    const ctx = await mount(root, compression)

    for (const access of ['read', 'write'] as const) {
      const opened = ctx.sessionPersistence.open(id, access).then(async (handle) => {
        await handle.close()
      })
      await expect(opened).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
      await expect(opened).rejects.toThrow('owner-aware migration tool')
      await ctx.sessionPersistence.flush()
      expect(await observe(path)).toEqual(original)
      expect(await readFile(path)).toEqual(bytes)
      expect((await readdir(dirname(path))).filter(name => name !== 'session.lock'))
        .toEqual([basename(path)])
    }
  })
})
