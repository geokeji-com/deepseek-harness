#!/usr/bin/env node
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { sessionDirectory } from './session-paths.mjs'

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/u
const GENERATION = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/u
const ZSTD_MAGIC = 0xFD2FB528
const ZSTD_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Report one owner-aware migration refusal without publishing any target file. */
export class SessionMigrationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SessionMigrationError'
  }
}

const repoRoot = resolve(
  process.env.DSH_REPO_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)),
)
const { releasedV3SessionFormatCodec } = await loadBuiltPackage('session-format-v2-to-v3')
const { releasedV4SessionFormatCodec } = await loadBuiltPackage('session-format-v3-to-v4')

async function loadBuiltPackage(name) {
  const directory = join(repoRoot, 'packages/session', name)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  } catch (error) {
    throw new SessionMigrationError(
      `cannot load built Session codec ${name} from ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const exported = manifest.exports?.['.']
  const entry = typeof exported === 'string'
    ? exported
    : exported?.default ?? exported?.import ?? manifest.main
  if (typeof entry !== 'string') {
    throw new SessionMigrationError(`Session codec ${name} has no built entry point`)
  }
  let lastError
  for (const candidate of [entry, 'lib/types/index.js']) {
    try {
      return await import(pathToFileURL(resolve(directory, candidate)).href)
    } catch (error) {
      lastError = error
    }
  }
  throw new SessionMigrationError(
    `cannot import built Session codec ${name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/**
 * Atomically migrate one or more V3 Session roots into a shared V4 store.
 *
 * @param sources mappings from owner id to a read-only V3 Session root.
 * @param output shared V4 Session root.
 * @param options optional parent policy and test timing hook.
 * @returns migration summary.
 */
export async function migrateSessionsV4(sources, output, options = {}) {
  if (sources.length === 0) throw new SessionMigrationError('at least one --source owner=path is required')
  if (typeof output !== 'string' || output.length === 0) {
    throw new SessionMigrationError('--output must be a non-empty path')
  }
  const outputRoot = resolve(output)
  const cwdPrefixes = options.cwdPrefixes ?? []
  const owners = new Set()
  const entries = []
  const ids = new Map()

  for (const source of sources) {
    if (!USER_ID.test(source.owner)) {
      throw new SessionMigrationError(`invalid owner id: ${JSON.stringify(source.owner)}`)
    }
    if (owners.has(source.owner)) {
      throw new SessionMigrationError(`owner appears more than once: ${source.owner}`)
    }
    owners.add(source.owner)
    const sourceRoot = resolve(source.path)
    for (const file of await collectGenerationFiles(sourceRoot)) {
      const parsed = await inspectSource(file, sourceRoot, source.owner)
      if (parsed === undefined) continue
      const previous = ids.get(parsed.id)
      if (previous !== undefined) {
        throw new SessionMigrationError(
          `Session id collision for "${parsed.id}" between ${previous.file} and ${file}`,
        )
      }
      ids.set(parsed.id, { owner: source.owner, file })
      entries.push({ ...parsed, sourceRoot, sourceFile: file })
    }
  }

  const existing = await collectExistingTargets(outputRoot)
  for (const entry of entries) {
    const target = existing.get(entry.id)
    if (target !== undefined && target.owner !== entry.owner) {
      throw new SessionMigrationError(
        `owner conflict for Session "${entry.id}": existing ${target.owner}, requested ${entry.owner}`,
      )
    }
  }
  if (options.validateParents !== false) {
    const known = new Set([...existing.keys(), ...ids.keys()])
    for (const entry of entries) {
      if (entry.parentSession !== undefined && !known.has(entry.parentSession)) {
        throw new SessionMigrationError(
          `Session "${entry.id}" references missing parent "${entry.parentSession}"`,
        )
      }
    }
  }

  const outputParent = dirname(outputRoot)
  await mkdir(outputParent, { recursive: true })
  const staging = await mkdtemp(join(outputParent, `.${basename(outputRoot)}-staging-`))
  const backup = `${outputRoot}.backup-${process.pid}-${Date.now()}`
  let published = 0
  let skipped = 0
  try {
    if (await pathExists(outputRoot)) {
      for (const entry of await readdir(outputRoot)) {
        await cp(join(outputRoot, entry), join(staging, entry), { recursive: true, force: false })
      }
    }
    for (const entry of entries) {
      if (existing.has(entry.id)) {
        skipped += 1
        continue
      }
      const targetCwd = entry.cwd === undefined
        ? undefined
        : rewriteCwd(entry.cwd, cwdPrefixes)
      const target = join(
        sessionDirectory(staging, targetCwd, entry.id),
        'session.v4.jsonl',
      )
      await mkdir(dirname(target), { recursive: true })
      await writeV4Generation(entry.sourceFile, `${target}.zstd`, entry.owner, targetCwd)
      options.afterPrepare?.(entry)
      published += 1
    }

    if (await pathExists(outputRoot)) {
      await rename(outputRoot, backup)
      try {
        await rename(staging, outputRoot)
      } catch (error) {
        await rename(backup, outputRoot)
        throw error
      }
      await rm(backup, { recursive: true, force: true })
    } else {
      await rename(staging, outputRoot)
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (await pathExists(backup) && !await pathExists(outputRoot)) {
      await rename(backup, outputRoot)
    }
    throw error
  }

  return {
    sourceCount: sources.length,
    discovered: entries.length,
    published,
    skipped,
    output: outputRoot,
  }
}

async function collectGenerationFiles(root) {
  const files = []
  async function visit(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && GENERATION.test(entry.name)) files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

async function inspectSource(file, sourceRoot, owner) {
  const lines = (await readGenerationText(file)).split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new SessionMigrationError(`empty Session log: ${file}`)
  let headerValue
  try {
    headerValue = JSON.parse(lines[0])
  } catch {
    throw new SessionMigrationError(`invalid Session header JSON: ${file}`)
  }
  const version = headerValue?.version
  if (version === 4) return undefined
  if (version !== 3) {
    throw new SessionMigrationError(
      `only format v3 logs can be migrated to v4: ${file} stores v${String(version)}`,
    )
  }
  const header = releasedV3SessionFormatCodec.decodeHeader(headerValue)
  if (header.id.length === 0) throw new SessionMigrationError(`empty Session id: ${file}`)
  return {
    id: header.id,
    owner,
    cwd: header.cwd,
    parentSession: header.parentSession,
    relative: relative(sourceRoot, file),
  }
}

async function collectExistingTargets(outputRoot) {
  const targets = new Map()
  for (const file of await collectGenerationFiles(outputRoot)) {
    const match = GENERATION.exec(basename(file))
    if (match?.[1] !== '4') continue
    const lines = (await readGenerationText(file)).split('\n', 1)
    let value
    try {
      value = JSON.parse(lines[0])
    } catch {
      throw new SessionMigrationError(`invalid existing V4 header: ${file}`)
    }
    const header = releasedV4SessionFormatCodec.decodeHeader(value)
    if (header.ownerUserId === undefined) {
      throw new SessionMigrationError(`existing V4 Session has no owner: ${file}`)
    }
    const previous = targets.get(header.id)
    if (previous !== undefined) {
      throw new SessionMigrationError(`duplicate existing V4 Session id: ${header.id}`)
    }
    targets.set(header.id, { owner: header.ownerUserId, file })
  }
  return targets
}

async function writeV4Generation(source, target, owner, targetCwd) {
  const sourceText = await readGenerationText(source)
  const sourceLines = sourceText.split('\n')
  if (sourceLines.at(-1) === '') sourceLines.pop()
  if (sourceLines.length === 0) throw new SessionMigrationError(`empty Session log: ${source}`)
  const sourceHeaderValue = JSON.parse(sourceLines[0])
  const sourceHeader = releasedV3SessionFormatCodec.decodeHeader(sourceHeaderValue)
  const decoder = releasedV3SessionFormatCodec.createDecoder(sourceHeaderValue, 'strict')
  const events = []
  for (const line of sourceLines.slice(1)) {
    if (line.length === 0) continue
    decoder.decodeRow(JSON.parse(line), {
      emitEvent: event => {
        events.push(releasedV4SessionFormatCodec.encodeEvent(event))
      },
      emitRun: run => {
        for (const event of run.expand()) {
          events.push(releasedV4SessionFormatCodec.encodeEvent(event))
        }
      },
    })
  }
  const inheritedEventCount = decoder.finish({
    emitEvent: event => {
      events.push(releasedV4SessionFormatCodec.encodeEvent(event))
    },
    emitRun: run => {
      for (const event of run.expand()) {
        events.push(releasedV4SessionFormatCodec.encodeEvent(event))
      }
    },
  })
  const targetHeader = {
    ...sourceHeader,
    version: 4,
    ownerUserId: owner,
    ...(targetCwd === undefined
      ? {}
      : { cwd: targetCwd }),
  }
  const rows = [
    releasedV4SessionFormatCodec.encodeHeader(targetHeader, inheritedEventCount),
    ...events,
  ]
  const temporary = `${target}.tmp-${process.pid}`
  const encodedRows = rows.map(row => `${JSON.stringify(row)}\n`)
  const frames = [zstdCompressSync(encodedRows[0], ZSTD_OPTIONS)]
  if (encodedRows.length > 1) {
    frames.push(zstdCompressSync(encodedRows.slice(1).join(''), ZSTD_OPTIONS))
  }
  await writeFile(temporary, Buffer.concat(frames), {
    mode: 0o600,
    flag: 'wx',
  })
  await rename(temporary, target)
}

async function readGenerationText(file) {
  const bytes = await readFile(file)
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== ZSTD_MAGIC) {
    return bytes.toString('utf8')
  }
  const chunks = []
  let offset = 0
  while (offset < bytes.length) {
    const end = scanZstdFrame(bytes, offset)
    chunks.push(zstdDecompressSync(bytes.subarray(offset, end)))
    offset = end
  }
  return Buffer.concat(chunks).toString('utf8')
}

function scanZstdFrame(buffer, from) {
  let offset = from
  if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
    throw new SessionMigrationError('Session log does not contain a complete Zstandard frame')
  }
  offset += 4
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  if ((descriptor & 0x18) !== 0) throw new SessionMigrationError('invalid Zstandard frame descriptor')
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
    if (buffer.length - offset < 3) throw new SessionMigrationError('truncated Zstandard block header')
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 0x03) throw new SessionMigrationError('invalid Zstandard block type')
    offset += blockType === 0x01 ? 1 : blockSize
    if (offset > buffer.length) throw new SessionMigrationError('truncated Zstandard block payload')
    if (lastBlock) break
  }
  if (checksum) offset += 4
  if (offset > buffer.length) throw new SessionMigrationError('truncated Zstandard checksum')
  return offset
}

function rewriteCwd(cwd, prefixes) {
  let best
  for (const prefix of prefixes) {
    if (cwd !== prefix.from && !cwd.startsWith(`${prefix.from}/`)) continue
    if (best === undefined || prefix.from.length > best.from.length) best = prefix
  }
  if (best === undefined) return cwd
  return `${best.to}${cwd.slice(best.from.length)}`
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function parseArguments(argv) {
  const sources = []
  const cwdPrefixes = []
  let output
  let owner
  let validateParents = true
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--source') {
      const value = argv[++index]
      const separator = value?.indexOf('=')
      if (separator === undefined || separator < 1 || separator === value.length - 1) {
        throw new SessionMigrationError('--source must be owner=path')
      }
      sources.push({ owner: value.slice(0, separator), path: value.slice(separator + 1) })
    } else if (arg === '--owner') {
      owner = argv[++index]
    } else if (arg === '--output') {
      output = argv[++index]
    } else if (arg === '--cwd-prefix') {
      const value = argv[++index]
      const separator = value?.indexOf('=')
      if (separator === undefined || separator < 1 || separator === value.length - 1) {
        throw new SessionMigrationError('--cwd-prefix must be from=to')
      }
      cwdPrefixes.push({
        from: resolve(value.slice(0, separator)),
        to: resolve(value.slice(separator + 1)),
      })
    } else if (arg === '--allow-missing-parent') {
      validateParents = false
    } else {
      throw new SessionMigrationError(`unknown argument: ${arg}`)
    }
  }
  if (owner !== undefined) {
    if (sources.length !== 1) {
      throw new SessionMigrationError('--owner is accepted only with one --source')
    }
    sources[0].owner = owner
  }
  if (output === undefined) throw new SessionMigrationError('--output is required')
  return { sources, output, validateParents, cwdPrefixes }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const summary = await migrateSessionsV4(options.sources, options.output, {
    validateParents: options.validateParents,
    cwdPrefixes: options.cwdPrefixes,
  })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh-migrate-sessions-v4: ${message}\n`)
    process.exitCode = 1
  })
}
