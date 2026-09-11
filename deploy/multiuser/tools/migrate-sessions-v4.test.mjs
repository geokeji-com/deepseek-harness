import assert from 'node:assert/strict'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { releasedV3SessionFormatCodec } from '../../../packages/session/session-format-v2-to-v3/lib/index.js'
import {
  migrateSessionsV4,
  SessionMigrationError,
} from './migrate-sessions-v4.mjs'
import { encodeSegment, projectKey } from './session-paths.mjs'

const ZSTD_MAGIC = 0xFD2FB528
const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function header(id, cwd, extra = {}) {
  return releasedV3SessionFormatCodec.encodeHeader({
    version: 3,
    id,
    createdAt: 1,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    ...extra,
  }, 0)
}

async function writePlainSession(root, relative, value) {
  const path = join(root, relative, 'session.v3.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`)
  return path
}

async function writeZstdSession(root, relative, value) {
  const path = join(root, relative, 'session.v3.jsonl.zstd')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, zstdCompressSync(`${JSON.stringify(value)}\n`, ZSTD_OPTIONS))
  return path
}

function firstZstdFrameEnd(buffer) {
  let offset = 4
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0
    ? (singleSegment ? 1 : 0)
    : 1 << contentSizeFlag
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  for (;;) {
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    offset += blockType === 0x01 ? 1 : blockHeader >>> 3
    if (lastBlock) break
  }
  if (checksum) offset += 4
  return offset
}

async function readV4Header(path) {
  const bytes = await readFile(path)
  assert.equal(bytes.readUInt32LE(0), ZSTD_MAGIC)
  const end = firstZstdFrameEnd(bytes)
  return JSON.parse(zstdDecompressSync(bytes.subarray(0, end)).toString('utf8').trim())
}

test('migrates a plain V3 generation to zstd V4 and rewrites cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sessions-v4-plain-'))
  const source = join(root, 'owner/sessions')
  const output = join(root, 'shared/sessions')
  const oldCwd = join(root, 'legacy/member2/project')
  const newCwd = join(root, 'team/member2/project')
  const relative = '--legacy-member2-project--/session-plain'
  const sourceFile = await writePlainSession(source, relative, header('session-plain', oldCwd))

  try {
    const summary = await migrateSessionsV4(
      [{ owner: 'member2', path: source }],
      output,
      { cwdPrefixes: [{ from: oldCwd, to: newCwd }] },
    )

    assert.deepEqual(summary, {
      sourceCount: 1,
      discovered: 1,
      published: 1,
      skipped: 0,
      output,
    })
    const target = join(
      output,
      projectKey(newCwd),
      encodeSegment('session-plain'),
      'session.v4.jsonl.zstd',
    )
    assert.equal(await exists(target), true)
    assert.equal(await exists(join(output, relative, 'session.v4.jsonl')), false)
    assert.deepEqual(await readV4Header(target), {
      ...header('session-plain', newCwd),
      version: 4,
      ownerUserId: 'member2',
    })
    assert.equal(await exists(sourceFile), true)
    assert.equal(JSON.parse((await readFile(sourceFile, 'utf8')).trim()).version, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reads zstd V3, inherits parents, skips existing V4, and preserves old generations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sessions-v4-zstd-'))
  const source = join(root, 'owner/sessions')
  const output = join(root, 'shared/sessions')
  const cwd = join(root, 'legacy/owner/project')
  const sourceParentRelative = '--legacy-owner-project--/parent'
  const sourceChildRelative = '--legacy-owner-project--/child'
  const targetParentRelative = join(projectKey(cwd), encodeSegment('parent'))
  const targetChildRelative = join(projectKey(cwd), encodeSegment('child'))
  await writeZstdSession(source, sourceParentRelative, header('parent', cwd))
  await writeZstdSession(source, sourceChildRelative, header('child', cwd, {
    parentSession: 'parent',
  }))

  try {
    const first = await migrateSessionsV4([{ owner: 'owner', path: source }], output)
    assert.equal(first.published, 2)
    assert.equal(first.skipped, 0)

    const oldGeneration = join(output, targetParentRelative, 'session.v2.jsonl')
    await writeFile(oldGeneration, 'preserved\n')
    const second = await migrateSessionsV4([{ owner: 'owner', path: source }], output)

    assert.equal(second.published, 0)
    assert.equal(second.skipped, 2)
    assert.equal(await exists(oldGeneration), true)
    assert.equal(await exists(join(output, `${targetParentRelative}.backup`)), false)
    const childHeader = await readV4Header(join(
      output,
      targetChildRelative,
      'session.v4.jsonl.zstd',
    ))
    assert.equal(childHeader.ownerUserId, 'owner')
    assert.equal(childHeader.parentSession, 'parent')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects duplicate ids and missing parents before publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sessions-v4-refusal-'))
  const sourceA = join(root, 'owner/sessions')
  const sourceB = join(root, 'member2/sessions')
  const output = join(root, 'shared/sessions')

  try {
    await writePlainSession(sourceA, 'projectA/session', header('duplicate', '/a'))
    await writePlainSession(sourceB, 'projectB/session', header('duplicate', '/b'))
    await assert.rejects(
      migrateSessionsV4([
        { owner: 'owner', path: sourceA },
        { owner: 'member2', path: sourceB },
      ], output),
      error => error instanceof SessionMigrationError
        && /Session id collision/u.test(error.message),
    )
    assert.equal(await exists(output), false)

    await rm(sourceB, { recursive: true, force: true })
    await writePlainSession(sourceB, 'projectB/child', header('child', '/b', {
      parentSession: 'missing',
    }))
    await assert.rejects(
      migrateSessionsV4([{ owner: 'member2', path: sourceB }], output),
      error => error instanceof SessionMigrationError
        && /references missing parent/u.test(error.message),
    )
    assert.equal(await exists(output), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removes staging and leaves the published generation unchanged after a failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sessions-v4-rollback-'))
  const source = join(root, 'owner/sessions')
  const output = join(root, 'shared/sessions')
  await writePlainSession(source, 'project/session', header('session', '/project'))
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'sentinel'), 'unchanged\n')

  try {
    await assert.rejects(
      migrateSessionsV4(
        [{ owner: 'owner', path: source }],
        output,
        {
          afterPrepare: () => {
            throw new Error('injected prepare failure')
          },
        },
      ),
      /injected prepare failure/u,
    )
    assert.equal(await readFile(join(output, 'sentinel'), 'utf8'), 'unchanged\n')
    assert.equal(await exists(join(output, 'project')), false)
    const names = await import('node:fs/promises').then(({ readdir }) => readdir(output))
    assert.deepEqual(names, ['sentinel'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
