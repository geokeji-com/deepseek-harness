#!/usr/bin/env node

import {
  constants,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib'
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const STATE_ROOT = process.env.DSH_STATE_ROOT
  ?? '/home/dsh/.local/share/deepseek-harness'
const BACKUP_ROOT = process.env.DSH_BACKUP_ROOT
  ?? '/home/dsh/.local/state/deepseek-harness/workspace-migrations'
const ZSTD_MAGIC = 0xFD2FB528

function usage(message) {
  if (message !== undefined) process.stderr.write(`${message}\n`)
  process.stderr.write(
    'usage: migrate-workspace.mjs --user <id> --old <absolute-path> --new <absolute-path>\n',
  )
  process.exit(2)
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (value === undefined || !key?.startsWith('--')) usage('invalid arguments')
    values[key.slice(2)] = value
  }
  if (values.user === undefined || values.old === undefined || values.new === undefined) {
    usage('missing required arguments')
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(values.user)) usage('invalid user id')
  if (!values.old.startsWith('/') || !values.new.startsWith('/')) {
    usage('workspace paths must be absolute')
  }
  return {
    user: values.user,
    oldPath: resolve(values.old),
    newPath: resolve(values.new),
  }
}

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
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
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
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
  const slug = readable.replace(/^-+/u, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

function scanFirstFrame(buffer) {
  if (buffer.length < 5 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) {
    throw new Error('session log does not start with a Zstandard frame')
  }
  let offset = 4
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  if ((descriptor & 0x18) !== 0) throw new Error('reserved Zstandard frame-header bit')
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
    if (buffer.length - offset < 3) throw new Error('truncated Zstandard block header')
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 0x03) throw new Error('reserved Zstandard block type')
    offset += blockType === 0x01 ? 1 : blockSize
    if (offset > buffer.length) throw new Error('truncated Zstandard block payload')
    if (lastBlock) break
  }
  if (checksum) offset += 4
  if (offset > buffer.length) throw new Error('truncated Zstandard checksum')
  return offset
}

function parseHeader(frame, expectedSessionId) {
  const decoded = zstdDecompressSync(frame).toString('utf8')
  const lines = decoded.split('\n')
  if (lines.length !== 2 || lines[1] !== '') {
    throw new Error('first Zstandard frame is not exactly one JSONL header line')
  }
  const header = JSON.parse(lines[0])
  if (header?.type !== 'session' || header?.id !== expectedSessionId) {
    throw new Error(`session header identity mismatch for ${expectedSessionId}`)
  }
  return { header, newline: decoded.endsWith('\n') }
}

function compressHeader(header) {
  return zstdCompressSync(`${JSON.stringify(header)}\n`, {
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

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.migration-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  const handle = await open(temporary, 'r')
  await handle.sync()
  await handle.close()
  await rename(temporary, path)
}

async function writeBufferAtomic(path, value) {
  const temporary = `${path}.migration-${process.pid}`
  await writeFile(temporary, value, { mode: 0o600 })
  const handle = await open(temporary, 'r')
  await handle.sync()
  await handle.close()
  await rename(temporary, path)
}

async function findSessionDirectory(sessionsRoot, sessionId) {
  const encoded = encodeSegment(sessionId)
  const matches = []
  for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(sessionsRoot, entry.name, encoded)
    if (await exists(candidate)) matches.push(candidate)
  }
  if (matches.length !== 1) {
    throw new Error(`expected one stored directory for ${sessionId}, found ${matches.length}`)
  }
  return matches[0]
}

async function findSessionLog(sessionDirectory) {
  const matches = (await readdir(sessionDirectory))
    .filter(name => /^session\.v\d+\.jsonl\.zstd$/u.test(name))
  if (matches.length !== 1) {
    throw new Error(`expected one compressed session log in ${sessionDirectory}, found ${matches.length}`)
  }
  return join(sessionDirectory, matches[0])
}

function assertServiceStopped(user) {
  if (process.env.DSH_SKIP_SERVICE_CHECK === '1') return
  const service = `deepseek-harness-user@${user}.service`
  const result = spawnSync('systemctl', ['--user', 'is-active', service], {
    encoding: 'utf8',
  })
  if (result.stdout.trim() === 'active') {
    throw new Error(`${service} is active; stop it before migration`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  assertServiceStopped(options.user)

  const home = join(STATE_ROOT, 'instances', options.user, 'home')
  const sessionsRoot = join(home, 'sessions')
  const workspaceRegistryPath = join(home, 'storages/workspace.json')
  const cacheRoot = join(home, 'storages/session_projcache/sessions')
  const registry = await readJson(workspaceRegistryPath)
  const workspaces = Object.entries(registry?.tables?.workspaces ?? {})
    .filter(([, workspace]) => workspace.path === options.oldPath || workspace.path === options.newPath)
  if (workspaces.length !== 1) {
    throw new Error(`expected one workspace matching old or new path, found ${workspaces.length}`)
  }
  const [workspaceId, workspace] = workspaces[0]
  const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []

  const oldDirectoryExists = await exists(options.oldPath)
  const newDirectoryExists = await exists(options.newPath)
  if (oldDirectoryExists && newDirectoryExists) {
    throw new Error('both old and new workspace directories exist')
  }
  if (!oldDirectoryExists && !newDirectoryExists) {
    throw new Error('neither old nor new workspace directory exists')
  }

  const sessions = []
  for (const sessionId of sessionIds) {
    const currentDirectory = await findSessionDirectory(sessionsRoot, sessionId)
    const logPath = await findSessionLog(currentDirectory)
    const bytes = await readFile(logPath)
    const firstFrameEnd = scanFirstFrame(bytes)
    const { header } = parseHeader(bytes.subarray(0, firstFrameEnd), sessionId)
    if (header.cwd !== options.oldPath && header.cwd !== options.newPath) {
      throw new Error(`session ${sessionId} has unexpected cwd ${JSON.stringify(header.cwd)}`)
    }
    const targetDirectory = join(
      sessionsRoot,
      projectKey(options.newPath),
      encodeSegment(sessionId),
    )
    if (targetDirectory !== currentDirectory && await exists(targetDirectory)) {
      throw new Error(`target session directory already exists: ${targetDirectory}`)
    }
    sessions.push({
      sessionId,
      currentDirectory,
      targetDirectory,
      logPath,
      bytes,
      firstFrameEnd,
      header,
    })
  }

  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  const backup = join(BACKUP_ROOT, `${options.user}-${stamp}`)
  await mkdir(backup, { recursive: true, mode: 0o700 })
  await cp(workspaceRegistryPath, join(backup, 'workspace.json'))
  if (oldDirectoryExists) {
    await cp(options.oldPath, join(backup, 'workspace'), { recursive: true, preserveTimestamps: true })
  } else {
    await cp(options.newPath, join(backup, 'workspace'), { recursive: true, preserveTimestamps: true })
  }
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]
    await cp(session.currentDirectory, join(backup, `session-${index}`), {
      recursive: true,
      preserveTimestamps: true,
    })
    try {
      await cp(
        join(cacheRoot, `${session.sessionId}.json`),
        join(backup, `cache-${index}.json`),
        { preserveTimestamps: true },
      )
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const movedSessions = []
  let movedWorkspace = false
  try {
    if (oldDirectoryExists) {
      await mkdir(dirname(options.newPath), { recursive: true })
      await rename(options.oldPath, options.newPath)
      movedWorkspace = true
    }

    for (const session of sessions) {
      if (session.header.cwd !== options.newPath) {
        session.header.cwd = options.newPath
        const replacement = Buffer.concat([
          compressHeader(session.header),
          session.bytes.subarray(session.firstFrameEnd),
        ])
        await writeBufferAtomic(session.logPath, replacement)
      }
      if (session.currentDirectory !== session.targetDirectory) {
        await mkdir(dirname(session.targetDirectory), { recursive: true })
        await rename(session.currentDirectory, session.targetDirectory)
        movedSessions.push(session)
      }
      const cachePath = join(cacheRoot, `${session.sessionId}.json`)
      if (await exists(cachePath)) {
        const cache = await readJson(cachePath)
        if (cache?.record?.identity !== undefined) {
          cache.record.identity.cwd = options.newPath
          await writeJsonAtomic(cachePath, cache)
        }
      }
    }

    workspace.path = options.newPath
    await writeJsonAtomic(workspaceRegistryPath, registry)
  } catch (error) {
    for (const session of movedSessions.reverse()) {
      if (await exists(session.targetDirectory) && !await exists(session.currentDirectory)) {
        await mkdir(dirname(session.currentDirectory), { recursive: true })
        await rename(session.targetDirectory, session.currentDirectory)
      }
    }
    if (movedWorkspace && await exists(options.newPath) && !await exists(options.oldPath)) {
      await rename(options.newPath, options.oldPath)
    }
    throw new Error(
      `migration failed and rollback was attempted; backup retained at ${backup}: ${error.message}`,
      { cause: error },
    )
  }

  process.stdout.write(`${JSON.stringify({
    user: options.user,
    workspaceId,
    oldPath: options.oldPath,
    newPath: options.newPath,
    sessionCount: sessions.length,
    backup,
  })}\n`)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exit(1)
})
