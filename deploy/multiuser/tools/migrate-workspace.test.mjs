import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./migrate-workspace.mjs', import.meta.url))

function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char !== '~' && /^[A-Za-z0-9._-]$/u.test(char)) out += char
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/u.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}

function frame(value) {
  return zstdCompressSync(value, {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

test('migrates a registered workspace, session header, and projection cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-migration-'))
  const stateRoot = join(root, 'state')
  const backupRoot = join(root, 'backups')
  const oldPath = join(root, 'legacy-workspace')
  const newPath = join(root, 'private/workspace/member2/legacy-workspace')
  const userId = 'member2'
  const sessionId = 'session-migration-test'
  const home = join(stateRoot, 'instances', userId, 'home')
  const sessionDirectory = join(home, 'sessions', projectKey(oldPath), encodeSegment(sessionId))
  const cacheDirectory = join(home, 'storages/session_projcache/sessions')
  const registryPath = join(home, 'storages/workspace.json')
  const cachePath = join(cacheDirectory, `${sessionId}.json`)

  try {
    await mkdir(oldPath, { recursive: true })
    await writeFile(join(oldPath, 'answer.txt'), 'preserved\n')
    await mkdir(dirname(registryPath), { recursive: true })
    await mkdir(sessionDirectory, { recursive: true })
    await mkdir(cacheDirectory, { recursive: true })
    const header = {
      type: 'session',
      version: 3,
      id: sessionId,
      createdAt: 1,
      cwd: oldPath,
      isSeeded: false,
      delegationDepth: 0,
    }
    const body = JSON.stringify({ type: 'user/message', payload: 'unchanged' })
    await writeFile(
      join(sessionDirectory, 'session.v3.jsonl.zstd'),
      Buffer.concat([frame(`${JSON.stringify(header)}\n`), frame(`${body}\n`)]),
    )
    await writeFile(registryPath, JSON.stringify({
      tables: {
        workspaces: {
          workspaceId: {
            path: oldPath,
            title: 'legacy',
            sessionIds: [sessionId],
          },
        },
      },
    }))
    await writeFile(cachePath, JSON.stringify({
      version: 7,
      record: { identity: { cwd: oldPath } },
    }))

    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--user', userId,
      '--old', oldPath,
      '--new', newPath,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_STATE_ROOT: stateRoot,
        DSH_BACKUP_ROOT: backupRoot,
        DSH_SKIP_SERVICE_CHECK: '1',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await exists(oldPath), false)
    assert.equal(await exists(join(newPath, 'answer.txt')), true)

    const newSessionDirectory = join(
      home,
      'sessions',
      projectKey(newPath),
      encodeSegment(sessionId),
    )
    assert.equal(await exists(sessionDirectory), false)
    assert.equal(await exists(newSessionDirectory), true)

    const log = await readFile(join(newSessionDirectory, 'session.v3.jsonl.zstd'))
    const firstFrameEnd = log.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4)
    assert.ok(firstFrameEnd > 0)
    const rewritten = JSON.parse(
      zstdDecompressSync(log.subarray(0, firstFrameEnd)).toString('utf8').trim(),
    )
    assert.equal(rewritten.cwd, newPath)

    const registry = JSON.parse(await readFile(registryPath, 'utf8'))
    assert.equal(registry.tables.workspaces.workspaceId.path, newPath)
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.equal(cache.record.identity.cwd, newPath)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.backup.startsWith(backupRoot), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restores session metadata when migration fails before registry commit', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-rollback-'))
  const stateRoot = join(root, 'state')
  const backupRoot = join(root, 'backups')
  const oldPath = join(root, 'legacy-workspace')
  const newPath = join(root, 'private/workspace/member2/legacy-workspace')
  const userId = 'member2'
  const sessionId = 'session-rollback-test'
  const home = join(stateRoot, 'instances', userId, 'home')
  const sessionDirectory = join(home, 'sessions', projectKey(oldPath), encodeSegment(sessionId))
  const cacheDirectory = join(home, 'storages/session_projcache/sessions')
  const registryPath = join(home, 'storages/workspace.json')
  const registryDirectory = dirname(registryPath)
  const cachePath = join(cacheDirectory, `${sessionId}.json`)

  try {
    await mkdir(oldPath, { recursive: true })
    await writeFile(join(oldPath, 'answer.txt'), 'preserved\n')
    await mkdir(registryDirectory, { recursive: true })
    await mkdir(sessionDirectory, { recursive: true })
    await mkdir(cacheDirectory, { recursive: true })
    const header = {
      type: 'session',
      version: 3,
      id: sessionId,
      createdAt: 1,
      cwd: oldPath,
      isSeeded: false,
      delegationDepth: 0,
    }
    await writeFile(
      join(sessionDirectory, 'session.v3.jsonl.zstd'),
      Buffer.concat([frame(`${JSON.stringify(header)}\n`), frame('{}\n')]),
    )
    await writeFile(registryPath, JSON.stringify({
      tables: {
        workspaces: {
          workspaceId: {
            path: oldPath,
            title: 'legacy',
            sessionIds: [sessionId],
          },
        },
      },
    }))
    await writeFile(cachePath, JSON.stringify({
      version: 7,
      record: { identity: { cwd: oldPath } },
    }))

    // Force the final atomic registry write to fail after logs and caches changed.
    await chmod(registryDirectory, 0o555)
    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--user', userId,
      '--old', oldPath,
      '--new', newPath,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_STATE_ROOT: stateRoot,
        DSH_BACKUP_ROOT: backupRoot,
        DSH_SKIP_SERVICE_CHECK: '1',
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /rollback completed/u)

    assert.equal(await exists(oldPath), true)
    assert.equal(await exists(newPath), false)
    assert.equal(await exists(sessionDirectory), true)
    assert.equal(
      await exists(join(home, 'sessions', projectKey(newPath), encodeSegment(sessionId))),
      false,
    )

    const log = await readFile(join(sessionDirectory, 'session.v3.jsonl.zstd'))
    const firstFrameEnd = log.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4)
    const restored = JSON.parse(
      zstdDecompressSync(log.subarray(0, firstFrameEnd)).toString('utf8').trim(),
    )
    assert.equal(restored.cwd, oldPath)
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    assert.equal(cache.record.identity.cwd, oldPath)
    const registry = JSON.parse(await readFile(registryPath, 'utf8'))
    assert.equal(registry.tables.workspaces.workspaceId.path, oldPath)
  } finally {
    await chmod(registryDirectory, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
