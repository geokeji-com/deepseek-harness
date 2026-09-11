#!/usr/bin/env node

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/u
const WORKSPACE_UNIT = Object.freeze({ name: 'workspace', version: 2 })

/** Owner-aware Workspace directory and registry migration failure. */
export class WorkspaceMigrationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WorkspaceMigrationError'
  }
}

/**
 * Move each member workspace tree under the team root and merge its registry.
 * @param sources mappings from owner id to a per-user workspace.json path.
 * @param output shared workspace.json path.
 * @param options legacy root, team root, and test hook.
 * @returns migration summary.
 */
export async function migrateSharedWorkspaces(sources, output, options) {
  if (sources.length === 0) throw new WorkspaceMigrationError('at least one --source owner=path is required')
  const legacyRoot = resolve(requiredPath(options.legacyRoot, '--legacy-root'))
  const teamRoot = resolve(requiredPath(options.teamRoot, '--team-root'))
  const outputPath = resolve(requiredPath(output, 'shared workspace output'))
  const legacyMoves = validateLegacyMoves(options.legacyMoves ?? [])
  const owners = new Set()
  const migrations = []

  for (const source of sources) {
    if (!USER_ID.test(source.owner)) {
      throw new WorkspaceMigrationError(`invalid owner id: ${JSON.stringify(source.owner)}`)
    }
    if (owners.has(source.owner)) {
      throw new WorkspaceMigrationError(`owner appears more than once: ${source.owner}`)
    }
    owners.add(source.owner)
    const registry = validateRegistry(await readJson(source.path), source.path)
    const oldUserRoot = join(legacyRoot, source.owner)
    const newUserRoot = join(teamRoot, source.owner)
    const moves = [
      { from: oldUserRoot, to: newUserRoot },
      ...legacyMoves
        .filter(move => move.owner === source.owner)
        .map(({ from, to }) => ({ from, to })),
    ].toSorted((left, right) => left.to.split('/').length - right.to.split('/').length)
    for (const move of moves) {
      const oldExists = await pathExists(move.from)
      const newExists = await pathExists(move.to)
      if (oldExists && newExists) {
        throw new WorkspaceMigrationError(
          `both legacy and shared workspace paths exist for ${source.owner}: ${move.from}, ${move.to}`,
        )
      }
      move.oldExists = oldExists
      move.newExists = newExists
    }
    migrations.push({ owner: source.owner, registry, moves })
  }

  const target = await collectTarget(outputPath)
  for (const migration of migrations) {
    mergeRegistry(target, migration)
  }

  const moved = []
  try {
    for (const migration of migrations) {
      for (const move of migration.moves) {
        if (!move.oldExists) continue
        await mkdir(dirname(move.to), { recursive: true })
        await rename(move.from, move.to)
        moved.push({ ...move, owner: migration.owner })
        options.afterMove?.(migration.owner)
      }
    }

    await publishRegistry(outputPath, target)
  } catch (error) {
    const rollbackErrors = []
    for (const move of moved.reverse()) {
      if (await pathExists(move.to) && !await pathExists(move.from)) {
        try {
          await rename(move.to, move.from)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'workspace migration and rollback both failed')
    }
    throw error
  }

  return {
    sourceCount: sources.length,
    movedRoots: moved.length,
    workspaces: Object.keys(target.tables.workspaces).length,
    output: outputPath,
  }
}

async function collectTarget(outputPath) {
  if (!await pathExists(outputPath)) {
    return {
      unit: { ...WORKSPACE_UNIT },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
      tables: {
        workspaces: {},
      },
    }
  }
  return validateRegistry(await readJson(outputPath), outputPath, 'existing shared ')
}

function mergeRegistry(target, migration) {
  const { registry, owner } = migration
  const sourceState = registry.global
  const sourceWorkspaces = registry.tables.workspaces
  const workspaceIds = Array.isArray(sourceState?.workspaceIds)
    ? sourceState.workspaceIds
    : Object.keys(sourceWorkspaces)
  const targetPaths = new Map(
    Object.entries(target.tables.workspaces).map(([workspaceId, record]) => [record.path, workspaceId]),
  )
  const targetSessions = new Map()
  for (const [workspaceId, record] of Object.entries(target.tables.workspaces)) {
    for (const sessionId of record.sessionIds) {
      if (targetSessions.has(sessionId)) {
        throw new WorkspaceMigrationError(
          `shared workspace registry accounts session ${sessionId} more than once`,
        )
      }
      targetSessions.set(sessionId, workspaceId)
    }
  }

  for (const workspaceId of workspaceIds) {
    const record = sourceWorkspaces[workspaceId]
    if (record === undefined) {
      throw new WorkspaceMigrationError(`workspace order references missing record ${workspaceId}/${owner}`)
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new WorkspaceMigrationError(`workspace record is invalid ${workspaceId}/${owner}`)
    }
    if (typeof record.path !== 'string') {
      throw new WorkspaceMigrationError(`workspace path is invalid ${workspaceId}/${owner}`)
    }
    const path = rewriteManagedPath(record.path, migration.moves, owner)
    const existing = target.tables.workspaces[workspaceId]
    if (existing === undefined) {
      const pathOwner = targetPaths.get(path)
      if (pathOwner !== undefined && pathOwner !== workspaceId) {
        throw new WorkspaceMigrationError(
          `workspace path collision for ${path}: existing ${pathOwner}, incoming ${workspaceId}`,
        )
      }
      target.tables.workspaces[workspaceId] = {
        ...record,
        path,
        sessionIds: [...new Set(record.sessionIds)],
      }
      if (!target.global.workspaceIds.includes(workspaceId)) {
        target.global.workspaceIds.push(workspaceId)
      }
      targetPaths.set(path, workspaceId)
    } else {
      const existingIsSourcePath = migration.moves.some(move =>
        existing.path === move.from || existing.path.startsWith(`${move.from}/`))
      if (existing.path !== path && !existingIsSourcePath) {
        throw new WorkspaceMigrationError(
          `workspace id collision for ${workspaceId}: existing ${existing.path}, incoming ${path}`,
        )
      }
      targetPaths.delete(existing.path)
      const pathOwner = targetPaths.get(path)
      if (pathOwner !== undefined && pathOwner !== workspaceId) {
        throw new WorkspaceMigrationError(
          `workspace path collision for ${path}: existing ${pathOwner}, incoming ${workspaceId}`,
        )
      }
      targetPaths.set(path, workspaceId)
      existing.path = path
    }
    const sessionIds = [...new Set([
      ...target.tables.workspaces[workspaceId].sessionIds,
      ...record.sessionIds,
    ])]
    for (const sessionId of sessionIds) {
      const holder = targetSessions.get(sessionId)
      if (holder !== undefined && holder !== workspaceId) {
        throw new WorkspaceMigrationError(
          `workspace session collision for ${sessionId}: existing ${holder}, incoming ${workspaceId}`,
        )
      }
      targetSessions.set(sessionId, workspaceId)
    }
    target.tables.workspaces[workspaceId].sessionIds = sessionIds
  }
  const archived = [
    ...target.global.archivedSessionIds,
    ...Array.isArray(sourceState?.archivedSessionIds) ? sourceState.archivedSessionIds : [],
  ]
  target.global.archivedSessionIds = [...new Set(archived)]
  target.global.initialized = true
}

function validateRegistry(value, path, label = '') {
  const unit = value?.unit ?? WORKSPACE_UNIT
  if (unit === null || typeof unit !== 'object' || Array.isArray(unit)
    || unit.name !== WORKSPACE_UNIT.name || unit.version !== WORKSPACE_UNIT.version) {
    throw new WorkspaceMigrationError(`${label}workspace registry unit header is invalid: ${path}`)
  }
  const workspaces = value?.tables?.workspaces
  if (workspaces === null || typeof workspaces !== 'object' || Array.isArray(workspaces)) {
    throw new WorkspaceMigrationError(`${label}workspace registry tables.workspaces is invalid: ${path}`)
  }
  const state = value?.global ?? {
    initialized: true,
    workspaceIds: Object.keys(workspaces),
    archivedSessionIds: [],
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)
    || typeof state.initialized !== 'boolean'
    || !Array.isArray(state.workspaceIds)
    || !Array.isArray(state.archivedSessionIds ?? [])) {
    throw new WorkspaceMigrationError(`${label}workspace registry global state is invalid: ${path}`)
  }
  if (state.pendingMutation !== undefined) {
    throw new WorkspaceMigrationError(`${label}workspace registry has a pending mutation: ${path}`)
  }
  const workspaceIds = [...state.workspaceIds]
  if (new Set(workspaceIds).size !== workspaceIds.length) {
    throw new WorkspaceMigrationError(`${label}workspace registry order contains duplicates: ${path}`)
  }
  if (workspaceIds.length !== Object.keys(workspaces).length) {
    throw new WorkspaceMigrationError(`${label}workspace registry has an incomplete order: ${path}`)
  }
  const ordered = new Set()
  for (const workspaceId of workspaceIds) {
    if (!Object.hasOwn(workspaces, workspaceId)) {
      throw new WorkspaceMigrationError(
        `${label}workspace registry order references missing record ${workspaceId}: ${path}`,
      )
    }
    ordered.add(workspaceId)
  }
  const pathOwners = new Map()
  const sessionOwners = new Map()
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    if (!ordered.has(workspaceId)) {
      throw new WorkspaceMigrationError(
        `${label}workspace registry record ${workspaceId} is absent from order: ${path}`,
      )
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)
      || typeof record.path !== 'string' || !Array.isArray(record.sessionIds)
      || record.sessionIds.some(sessionId => typeof sessionId !== 'string')) {
      throw new WorkspaceMigrationError(
        `${label}workspace registry record ${workspaceId} is invalid: ${path}`,
      )
    }
    const pathOwner = pathOwners.get(record.path)
    if (pathOwner !== undefined) {
      throw new WorkspaceMigrationError(
        `${label}workspace registry path ${record.path} is claimed by ${pathOwner} and ${workspaceId}: ${path}`,
      )
    }
    pathOwners.set(record.path, workspaceId)
    for (const sessionId of record.sessionIds) {
      const sessionOwner = sessionOwners.get(sessionId)
      if (sessionOwner !== undefined) {
        throw new WorkspaceMigrationError(
          `${label}workspace registry session ${sessionId} is claimed by ${sessionOwner} and ${workspaceId}: ${path}`,
        )
      }
      sessionOwners.set(sessionId, workspaceId)
    }
  }
  return {
    unit: { ...WORKSPACE_UNIT },
    global: {
      ...state,
      initialized: true,
      workspaceIds,
      archivedSessionIds: [...new Set(state.archivedSessionIds ?? [])],
    },
    tables: {
      ...value.tables,
      workspaces: structuredClone(workspaces),
    },
  }
}

function rewriteManagedPath(path, moves, owner) {
  const absolute = resolve(path)
  for (const move of moves) {
    if (absolute === move.from || absolute.startsWith(`${move.from}/`)) {
      return `${move.to}${absolute.slice(move.from.length)}`
    }
  }
  for (const move of moves) {
    if (absolute === move.to || absolute.startsWith(`${move.to}/`)) return absolute
  }
  throw new WorkspaceMigrationError(
    `workspace path for ${owner} is outside the configured source and target roots: ${path}`,
  )
}

function validateLegacyMoves(moves) {
  if (!Array.isArray(moves)) throw new WorkspaceMigrationError('legacy moves must be an array')
  const seen = new Set()
  return moves.map((move) => {
    if (move === null || typeof move !== 'object' || Array.isArray(move)) {
      throw new WorkspaceMigrationError('legacy move must be an object')
    }
    if (!USER_ID.test(move.owner)) {
      throw new WorkspaceMigrationError(`invalid legacy move owner: ${JSON.stringify(move.owner)}`)
    }
    const from = resolve(requiredPath(move.from, 'legacy move source'))
    const to = resolve(requiredPath(move.to, 'legacy move target'))
    const key = `${move.owner}\0${from}\0${to}`
    if (seen.has(key)) throw new WorkspaceMigrationError(`duplicate legacy move: ${key}`)
    seen.add(key)
    if (from === to || to.startsWith(`${from}/`)) {
      throw new WorkspaceMigrationError(`legacy move target is inside its source: ${from} -> ${to}`)
    }
    return { owner: move.owner, from, to }
  })
}

async function publishRegistry(outputPath, value) {
  const parent = dirname(outputPath)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, `.${basename(outputPath)}-staging-`))
  const stagedFile = join(staging, basename(outputPath))
  await writeFile(stagedFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  const backup = `${outputPath}.backup-${process.pid}-${Date.now()}`
  try {
    if (await pathExists(outputPath)) {
      await rename(outputPath, backup)
      try {
        await rename(stagedFile, outputPath)
      } catch (error) {
        await rename(backup, outputPath)
        throw error
      }
      await rm(backup, { force: true })
    } else {
      await rename(stagedFile, outputPath)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new WorkspaceMigrationError(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
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

function requiredPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkspaceMigrationError(`${label} must be a non-empty path`)
  }
  return value
}

function parseArguments(argv) {
  const sources = []
  let output
  let legacyRoot
  let teamRoot
  const legacyMoves = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--source') {
      const value = argv[++index]
      const separator = value?.indexOf('=')
      if (separator === undefined || separator < 1 || separator === value.length - 1) {
        throw new WorkspaceMigrationError('--source must be owner=path')
      }
      sources.push({ owner: value.slice(0, separator), path: value.slice(separator + 1) })
    } else if (arg === '--output') {
      output = argv[++index]
    } else if (arg === '--legacy-root') {
      legacyRoot = argv[++index]
    } else if (arg === '--team-root') {
      teamRoot = argv[++index]
    } else if (arg === '--legacy-move') {
      const value = argv[++index]
      const first = value?.indexOf('=')
      const last = value?.lastIndexOf('=')
      if (first === undefined || first < 1 || last === undefined || last <= first
        || last === value.length - 1) {
        throw new WorkspaceMigrationError('--legacy-move must be owner=from=to')
      }
      legacyMoves.push({
        owner: value.slice(0, first),
        from: value.slice(first + 1, last),
        to: value.slice(last + 1),
      })
    } else {
      throw new WorkspaceMigrationError(`unknown argument: ${arg}`)
    }
  }
  return { sources, output, legacyRoot, teamRoot, legacyMoves }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const summary = await migrateSharedWorkspaces(options.sources, options.output, {
    legacyRoot: options.legacyRoot,
    teamRoot: options.teamRoot,
    legacyMoves: options.legacyMoves,
  })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh-migrate-shared-workspaces: ${message}\n`)
    process.exitCode = 1
  })
}
