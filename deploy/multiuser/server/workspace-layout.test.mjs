import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeWorkspaceLayout } from './workspace-layout.mjs'

async function mode(path) {
  return (await stat(path)).mode & 0o777
}

test('creates one private workspace root for each enabled member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-layout-'))
  const workspaceRoot = join(root, 'workspace')
  try {
    const result = await initializeWorkspaceLayout({
      users: [
        { id: 'owner', enabled: true },
        { id: 'member2', enabled: true },
        { id: 'disabled', enabled: false },
      ],
      pathPolicy: {
        workspaceRoot,
        perUserWorkspace: true,
      },
    })

    assert.deepEqual(result, {
      workspaceRoot,
      memberCount: 2,
      perUserWorkspace: true,
    })
    assert.equal(await mode(workspaceRoot), 0o711)
    assert.equal(await mode(join(workspaceRoot, 'owner')), 0o700)
    assert.equal(await mode(join(workspaceRoot, 'member2')), 0o700)
    await assert.rejects(stat(join(workspaceRoot, 'disabled')), /ENOENT/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tightens permissions on an existing member workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-layout-'))
  const workspaceRoot = join(root, 'workspace')
  try {
    await initializeWorkspaceLayout({
      users: [{ id: 'owner', enabled: true }],
      pathPolicy: {
        workspaceRoot,
        perUserWorkspace: true,
      },
    })
    const memberRoot = join(workspaceRoot, 'owner')
    await chmod(memberRoot, 0o755)

    await initializeWorkspaceLayout({
      users: [{ id: 'owner', enabled: true }],
      pathPolicy: {
        workspaceRoot,
        perUserWorkspace: true,
      },
    })

    assert.equal(await mode(memberRoot), 0o700)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('only initializes the root when per-user workspaces are disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-layout-'))
  const workspaceRoot = join(root, 'workspace')
  try {
    const result = await initializeWorkspaceLayout({
      users: [{ id: 'owner', enabled: true }],
      pathPolicy: {
        workspaceRoot,
        perUserWorkspace: false,
      },
    })

    assert.equal(result.memberCount, 0)
    assert.equal(result.perUserWorkspace, false)
    await assert.rejects(stat(join(workspaceRoot, 'owner')), /ENOENT/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
