import assert from 'node:assert/strict'
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  renderSharedAgents,
  renderSharedAgentsContent,
} from './render-shared-agents.mjs'

test('renders one shared policy with dynamic member identity', () => {
  const content = renderSharedAgentsContent({
    sharedRoot: '/srv/shared',
    teamWorkspaceRoot: '/srv/team',
    skillsRoot: '/srv/shared/skills',
    profilesRoot: '/srv/shared/profiles',
    presetsRoot: '/srv/shared/presets',
    sharedProjectsRoot: '/srv/projects',
  })
  assert.match(content, /`DSH_USER_ID`/u)
  assert.match(content, /`DSH_WORKSPACE`/u)
  assert.match(content, /`\/srv\/team\/\$DSH_USER_ID`/u)
  assert.match(content, /Skills: `\/srv\/shared\/skills`/u)
  assert.match(content, /Profiles and plugins: `\/srv\/shared\/profiles`/u)
  assert.match(content, /Agent presets: `\/srv\/shared\/presets`/u)
  assert.match(content, /Shared projects: `\/srv\/projects`/u)
  assert.match(content, /Never write outside `\/srv\/team\/\$DSH_USER_ID`/u)
  assert.doesNotMatch(content, /\/srv\/team\/member2/u)
})

test('writes one canonical file and links every home and workspace to it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shared-agents-'))
  try {
    const instanceRoot = join(root, 'instances')
    const workspaceRoot = join(root, 'workspace')
    const sharedRoot = join(root, 'shared')
    const sharedHome = join(sharedRoot, 'home')
    const teamWorkspaceRoot = join(root, 'team-workspace')
    await mkdir(join(instanceRoot, 'member2/home'), { recursive: true })
    await mkdir(join(workspaceRoot, 'member2'), { recursive: true })
    await mkdir(join(instanceRoot, 'member3/home'), { recursive: true })
    await mkdir(join(workspaceRoot, 'member3'), { recursive: true })
    const homeLink = join(instanceRoot, 'member2/home/AGENTS.md')
    await writeFile(homeLink, 'old content\n')

    const result = await renderSharedAgents({
      instanceRoot,
      workspaceRoot,
      sharedRoot,
      sharedHome,
      teamWorkspaceRoot,
      users: ['member2', 'member3'],
      sharedProjectsRoot: join(root, 'projects'),
    })
    assert.equal((await stat(result.target)).mode & 0o777, 0o444)
    for (const link of result.links) {
      assert.equal((await lstat(link)).isSymbolicLink(), true)
      assert.equal(await readFile(link, 'utf8'), await readFile(result.target, 'utf8'))
    }
    assert.equal(result.links.length, 5)
    assert.match(await readFile(homeLink, 'utf8'), /Global Shared Agent Policy/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
