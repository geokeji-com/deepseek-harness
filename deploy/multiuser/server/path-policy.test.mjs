import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPathPolicy } from './path-policy.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-path-policy-'))
  const workspaceRoot = join(root, 'workspace')
  const sharedRoot = join(root, 'shared/projects')
  const skillsRoot = join(root, 'shared/skills')
  const profilesRoot = join(root, 'shared/profiles')
  const presetsRoot = join(root, 'shared/presets')
  const instanceRoot = join(root, 'instances')
  await mkdir(join(workspaceRoot, 'member2'), { recursive: true })
  await mkdir(join(workspaceRoot, 'member3'), { recursive: true })
  await mkdir(sharedRoot, { recursive: true })
  await mkdir(join(skillsRoot, 'web-access'), { recursive: true })
  await mkdir(profilesRoot, { recursive: true })
  await mkdir(presetsRoot, { recursive: true })
  await writeFile(join(skillsRoot, 'web-access/SKILL.md'), '# Shared Skill\n')
  await writeFile(join(profilesRoot, 'cordis.yml'), 'plugins: []\n')
  await writeFile(join(presetsRoot, 'default.yaml'), 'presets: []\n')
  await mkdir(join(instanceRoot, 'member2/home/storages/session_projcache/sessions'), {
    recursive: true,
  })
  await mkdir(join(instanceRoot, 'member2/home/storages'), { recursive: true })
  await writeFile(
    join(instanceRoot, 'member2/home/storages/workspace.json'),
    JSON.stringify({
      tables: {
        workspaces: {
          own: { path: join(workspaceRoot, 'member2') },
          shared: { path: join(sharedRoot, 'common') },
          foreign: { path: join(workspaceRoot, 'member3') },
        },
      },
    }),
  )
  await writeFile(
    join(
      instanceRoot,
      'member2/home/storages/session_projcache/sessions/session-shared.json',
    ),
    JSON.stringify({
      record: { identity: { cwd: join(sharedRoot, 'common') } },
    }),
  )
  await writeFile(
    join(
      instanceRoot,
      'member2/home/storages/session_projcache/sessions/session-own.json',
    ),
    JSON.stringify({
      record: { identity: { cwd: join(workspaceRoot, 'member2') } },
    }),
  )
  return {
    root,
    workspaceRoot,
    sharedRoot,
    skillsRoot,
    profilesRoot,
    presetsRoot,
    instanceRoot,
    policy: createPathPolicy({
      workspaceRoot,
      sharedRoot,
      skillsRoot,
      profilesRoot,
      presetsRoot,
      instanceRoot,
      legacyRoots: {},
    }),
  }
}

test('allows private writes and all shared resources as read-only', async () => {
  const f = await fixture()
  try {
    const own = join(f.workspaceRoot, 'member2', 'nested')
    const shared = join(f.sharedRoot, 'common')
    assert.equal((await f.policy.authorize('member2', own)).allowed, true)
    assert.equal((await f.policy.authorize('member2', shared)).allowed, false)
    assert.equal(
      (await f.policy.authorize('member2', shared, { access: 'read' })).allowed,
      true,
    )
    for (const path of [f.skillsRoot, f.profilesRoot, f.presetsRoot]) {
      assert.equal(
        (await f.policy.authorize('member2', path, { access: 'read' })).allowed,
        true,
      )
      assert.equal((await f.policy.authorize('member2', path)).allowed, false)
    }
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('rejects home, other users, and symlink escapes', async () => {
  const f = await fixture()
  try {
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(f.workspaceRoot, 'member2', 'escape'))
    assert.equal((await f.policy.authorize('member2', f.root)).allowed, false)
    assert.equal(
      (await f.policy.authorize('member2', join(f.workspaceRoot, 'member3'))).allowed,
      false,
    )
    assert.equal(
      (await f.policy.authorize('member2', join(f.workspaceRoot, 'member2', 'escape'))).allowed,
      false,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('rewrites an omitted directory-picker path to the user root', async () => {
  const f = await fixture()
  try {
    const payload = { args: {} }
    const decision = await f.policy.inspectPayload('member2', 'directoryPicker/list', payload)
    assert.equal(decision.allowed, true)
    assert.equal(payload.args.path, join(f.workspaceRoot, 'member2'))
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('denies out-of-root workspace and file creation', async () => {
  const f = await fixture()
  try {
    const workspace = await f.policy.inspectPayload('member2', 'workspace/create', {
      args: { request: { path: f.root } },
    })
    assert.equal(workspace.allowed, false)
    assert.equal(workspace.code, 'workspace/invalid-path')

    const directory = await f.policy.inspectPayload('member2', 'directoryPicker/createDirectory', {
      args: { path: join(f.workspaceRoot, 'member2'), name: '..' },
    })
    assert.equal(directory.allowed, false)
    assert.equal(directory.code, 'directory-picker/create-failed')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('defaults new sessions into the user root', async () => {
  const f = await fixture()
  try {
    const payload = { args: { request: {} } }
    const decision = await f.policy.inspectPayload('member2', 'session/create', payload)
    assert.equal(decision.allowed, true)
    assert.equal(payload.args.request.cwd, join(f.workspaceRoot, 'member2'))
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('rejects related-file paths that escape through dot segments', async () => {
  const f = await fixture()
  try {
    const base = join(f.workspaceRoot, 'member2', 'base.md')
    const decision = await f.policy.inspectPayload('member2', 'workspaceFiles/readRelated', {
      args: { path: base, relativePath: '../../../outside.txt' },
    })
    assert.equal(decision.allowed, false)
    assert.equal(decision.code, 'workspace-file/outside-workspace')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('resolves relative file paths against the session cwd and rewrites them', async () => {
  const f = await fixture()
  try {
    const payload = {
      args: {
        workspaceFileScopeId: 'session-shared',
        path: 'notes/plan.md',
        relativePath: '../references/spec.md',
      },
    }
    const decision = await f.policy.inspectPayload(
      'member2',
      'workspaceFiles/readRelated',
      payload,
    )
    assert.equal(decision.allowed, true)
    assert.equal(payload.args.path, join(f.sharedRoot, 'common', 'notes/plan.md'))
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('uses the registered workspace path for new sessions and rejects foreign ones', async () => {
  const f = await fixture()
  try {
    const own = {
      args: { request: { workspaceId: 'own' } },
    }
    assert.equal(
      (await f.policy.inspectPayload('member2', 'session/create', own)).allowed,
      true,
    )
    assert.equal(own.args.request.cwd, undefined)

    const foreign = {
      args: { request: { workspaceId: 'foreign' } },
    }
    assert.equal(
      (await f.policy.inspectPayload('member2', 'session/create', foreign)).allowed,
      false,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('rewrites a relative workspace create and open path to an allowed absolute path', async () => {
  const f = await fixture()
  try {
    const create = {
      args: { request: { path: 'project-a' } },
    }
    assert.equal(
      (await f.policy.inspectPayload('member2', 'workspace/create', create)).allowed,
      true,
    )
    assert.equal(create.args.request.path, join(f.workspaceRoot, 'member2', 'project-a'))

    const open = {
      args: {
        agentId: 'session-own',
        request: { path: 'README.md' },
      },
    }
    assert.equal(
      (await f.policy.inspectPayload('member2', 'session/openWorkspacePath', open)).allowed,
      true,
    )
    assert.equal(open.args.request.path, join(f.workspaceRoot, 'member2', 'README.md'))

    const sharedOpen = {
      args: {
        agentId: 'session-shared',
        request: { path: 'README.md' },
      },
    }
    assert.equal(
      (await f.policy.inspectPayload(
        'member2',
        'session/openWorkspacePath',
        sharedOpen,
      )).allowed,
      false,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('allows members to read shared skills but denies all write paths', async () => {
  const f = await fixture()
  try {
    const skillFile = join(f.skillsRoot, 'web-access/SKILL.md')
    const read = {
      args: { path: skillFile },
    }
    assert.equal(
      (await f.policy.inspectPayload('member2', 'workspaceFiles/read', read)).allowed,
      true,
    )

    const list = {
      args: { path: f.skillsRoot },
    }
    assert.equal(
      (await f.policy.inspectPayload('member2', 'directoryPicker/list', list)).allowed,
      true,
    )

    const createDirectory = {
      args: { path: f.skillsRoot, name: 'copy' },
    }
    assert.equal(
      (await f.policy.inspectPayload(
        'member2',
        'directoryPicker/createDirectory',
        createDirectory,
      )).allowed,
      false,
    )

    const createWorkspace = {
      args: { request: { path: join(f.skillsRoot, 'copy') } },
    }
    assert.equal(
      (await f.policy.inspectPayload('member2', 'workspace/create', createWorkspace)).allowed,
      false,
    )

    const editSkill = {
      args: { request: { path: skillFile } },
    }
    assert.equal(
      (await f.policy.inspectPayload(
        'member2',
        'session/openWorkspacePath',
        editSkill,
      )).allowed,
      false,
    )
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
