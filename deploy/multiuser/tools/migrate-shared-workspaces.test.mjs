import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  migrateSharedWorkspaces,
  WorkspaceMigrationError,
} from './migrate-shared-workspaces.mjs'

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function registry(records) {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: Object.keys(records),
      archivedSessionIds: [],
    },
    tables: { workspaces: records },
  }
}

async function writeRegistry(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

test('moves member roots and merges workspace registries deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shared-workspaces-'))
  const legacyRoot = join(root, 'legacy')
  const teamRoot = join(root, 'team')
  const ownerRegistry = join(root, 'homes/owner/storages/workspace.json')
  const memberRegistry = join(root, 'homes/member2/storages/workspace.json')
  const output = join(root, 'shared/storages/workspace.json')
  const ownerPath = join(legacyRoot, 'owner/project')
  const memberPath = join(legacyRoot, 'member2/project')

  try {
    await mkdir(ownerPath, { recursive: true })
    await mkdir(memberPath, { recursive: true })
    await writeFile(join(ownerPath, 'owner.txt'), 'owner\n')
    await writeFile(join(memberPath, 'member.txt'), 'member\n')
    await writeRegistry(ownerRegistry, {
      ...registry({
        ownerWorkspace: {
          path: ownerPath,
          title: 'owner',
          sessionIds: ['owner-session'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      global: {
        initialized: true,
        workspaceIds: ['ownerWorkspace'],
        archivedSessionIds: ['owner-archive'],
      },
    })
    await writeRegistry(memberRegistry, {
      ...registry({
        memberWorkspace: {
          path: memberPath,
          title: 'member',
          sessionIds: ['member-session'],
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      }),
      global: {
        initialized: true,
        workspaceIds: ['memberWorkspace'],
        archivedSessionIds: ['member-archive'],
      },
    })

    const summary = await migrateSharedWorkspaces([
      { owner: 'owner', path: ownerRegistry },
      { owner: 'member2', path: memberRegistry },
    ], output, { legacyRoot, teamRoot })

    assert.deepEqual(summary, {
      sourceCount: 2,
      movedRoots: 2,
      workspaces: 2,
      output,
    })
    assert.equal(await exists(ownerPath), false)
    assert.equal(await exists(memberPath), false)
    assert.equal(await exists(join(teamRoot, 'owner/project/owner.txt')), true)
    assert.equal(await exists(join(teamRoot, 'member2/project/member.txt')), true)

    const merged = JSON.parse(await readFile(output, 'utf8'))
    assert.deepEqual(merged.unit, { name: 'workspace', version: 2 })
    assert.deepEqual(merged.global.workspaceIds, ['ownerWorkspace', 'memberWorkspace'])
    assert.deepEqual(merged.global.archivedSessionIds, ['owner-archive', 'member-archive'])
    assert.equal(
      merged.tables.workspaces.ownerWorkspace.path,
      join(teamRoot, 'owner/project'),
    )
    assert.equal(
      merged.tables.workspaces.memberWorkspace.path,
      join(teamRoot, 'member2/project'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('is idempotent when the member registries and shared output already agree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shared-workspaces-idempotent-'))
  const legacyRoot = join(root, 'legacy')
  const teamRoot = join(root, 'team')
  const source = join(root, 'homes/owner/storages/workspace.json')
  const output = join(root, 'shared/storages/workspace.json')
  const oldPath = join(legacyRoot, 'owner/project')
  const newPath = join(teamRoot, 'owner/project')

  try {
    await mkdir(oldPath, { recursive: true })
    await writeRegistry(source, registry({
      ownerWorkspace: {
        path: oldPath,
        title: 'owner',
        sessionIds: ['session'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }))

    const first = await migrateSharedWorkspaces(
      [{ owner: 'owner', path: source }],
      output,
      { legacyRoot, teamRoot },
    )
    const second = await migrateSharedWorkspaces(
      [{ owner: 'owner', path: source }],
      output,
      { legacyRoot, teamRoot },
    )

    assert.equal(first.movedRoots, 1)
    assert.equal(second.movedRoots, 0)
    const merged = JSON.parse(await readFile(output, 'utf8'))
    assert.deepEqual(merged.global.workspaceIds, ['ownerWorkspace'])
    assert.deepEqual(merged.tables.workspaces.ownerWorkspace.sessionIds, ['session'])
    assert.equal(merged.tables.workspaces.ownerWorkspace.path, newPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a workspace id collision before moving member roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shared-workspaces-conflict-'))
  const legacyRoot = join(root, 'legacy')
  const teamRoot = join(root, 'team')
  const ownerRegistry = join(root, 'homes/owner/storages/workspace.json')
  const memberRegistry = join(root, 'homes/member2/storages/workspace.json')
  const output = join(root, 'shared/storages/workspace.json')
  const ownerPath = join(legacyRoot, 'owner/project')
  const memberPath = join(legacyRoot, 'member2/other')
  const record = (path, title) => ({
    path,
    title,
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  try {
    await mkdir(ownerPath, { recursive: true })
    await mkdir(memberPath, { recursive: true })
    await writeRegistry(ownerRegistry, registry({ duplicate: record(ownerPath, 'owner') }))
    await writeRegistry(memberRegistry, registry({ duplicate: record(memberPath, 'member') }))

    await assert.rejects(
      migrateSharedWorkspaces([
        { owner: 'owner', path: ownerRegistry },
        { owner: 'member2', path: memberRegistry },
      ], output, { legacyRoot, teamRoot }),
      error => error instanceof WorkspaceMigrationError
        && /workspace id collision/u.test(error.message),
    )
    assert.equal(await exists(ownerPath), true)
    assert.equal(await exists(memberPath), true)
    assert.equal(await exists(output), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rolls moved roots back when publication fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shared-workspaces-rollback-'))
  const legacyRoot = join(root, 'legacy')
  const teamRoot = join(root, 'team')
  const source = join(root, 'homes/owner/storages/workspace.json')
  const output = join(root, 'shared/storages/workspace.json')
  const oldPath = join(legacyRoot, 'owner/project')

  try {
    await mkdir(oldPath, { recursive: true })
    await writeRegistry(source, registry({
      ownerWorkspace: {
        path: oldPath,
        title: 'owner',
        sessionIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }))

    await assert.rejects(
      migrateSharedWorkspaces(
        [{ owner: 'owner', path: source }],
        output,
        {
          legacyRoot,
          teamRoot,
          afterMove: () => {
            throw new Error('injected publication failure')
          },
        },
      ),
      /injected publication failure/u,
    )
    assert.equal(await exists(oldPath), true)
    assert.equal(await exists(join(teamRoot, 'owner/project')), false)
    assert.equal(await exists(output), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
