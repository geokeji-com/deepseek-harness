#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_INSTANCE_ROOT = '/home/dsh/.local/share/deepseek-harness/instances'
const DEFAULT_WORKSPACE_ROOT = '/home/dsh/workspace'
const DEFAULT_SHARED_ROOT = '/home/dsh/.local/share/deepseek-harness/shared'
const DEFAULT_SHARED_PROJECTS_ROOT = '/home/dsh/shared/projects'
const DEFAULT_USERS = ['owner', 'member2', 'member3', 'member4']
const USER_ID = /^[a-z][a-z0-9-]{0,31}$/u

export function renderSharedAgentsContent(options = {}) {
  const sharedRoot = resolve(options.sharedRoot ?? DEFAULT_SHARED_ROOT)
  const skillsRoot = resolve(options.skillsRoot ?? resolve(sharedRoot, 'skills'))
  const profilesRoot = resolve(options.profilesRoot ?? resolve(sharedRoot, 'profiles'))
  const presetsRoot = resolve(options.presetsRoot ?? resolve(sharedRoot, 'agent-presets'))
  const sharedProjectsRoot = resolve(
    options.sharedProjectsRoot ?? DEFAULT_SHARED_PROJECTS_ROOT,
  )
  return `# Global Shared Agent Policy

This is the single global instruction file shared by every Harness member. The
same file is symlinked into each member's DSH home and private workspace.

## Member identity and writable root

- Read the current member ID from the \`DSH_USER_ID\` environment variable.
- The only persistent writable root for agent-issued filesystem operations is
  the directory in \`DSH_WORKSPACE\`.
- The expected private root is \`/home/dsh/workspace/$DSH_USER_ID\`.
- If \`DSH_USER_ID\` or \`DSH_WORKSPACE\` is missing, empty, or inconsistent with
  that expected path, stop and refuse filesystem writes.
- Never write outside \`DSH_WORKSPACE\`, including every path listed below.

## Shared read-only resources

These paths are shared by all members and may be read or executed when needed:

- Shared state root: \`${sharedRoot}\`
- Skills: \`${skillsRoot}\`
- Profiles and plugins: \`${profilesRoot}\`
- Agent presets: \`${presetsRoot}\`
- Shared projects: \`${sharedProjectsRoot}\`

Administrators update shared resources through deployment scripts outside
member sessions. A member session must treat every shared path as read-only.

## Mandatory filesystem rules

1. Treat \`DSH_WORKSPACE\` as the default working directory and the only location
   for persistent reads, writes, edits, deletes, moves, renames, permission
   changes, generated files, and temporary files.
2. Before an operation, resolve the path canonically and verify that it remains
   inside \`DSH_WORKSPACE\`. Reject the whole operation when it does not.
3. Persistent writes into the shared state root, shared projects, another
   member's workspace, \`/home/dsh\`, the Harness source tree, settings,
   sessions, credentials, service files, databases, or logs are forbidden.
4. Never bypass this policy with \`..\`, absolute paths, symlinks, shell globs,
   command substitution, environment-variable tricks, mount points, or commands
   such as \`find /\`, \`rg /\`, \`rsync\`, or \`scp\`.
5. Read-only shared resources may be opened or executed, but never modified,
   deleted, renamed, chmodded, packaged, patched, updated in place, or used as
   a destination for generated output.
6. Keep temporary files under \`DSH_WORKSPACE\`. If the operating system requires
   another temporary directory, use a uniquely named ephemeral path, store no
   persistent data there, and clean it up before finishing.
7. Do not run package managers, build tools, tests, or scripts with options that
   modify global system state, home-directory dotfiles, shared resources, or
   another member's files.
8. If the user asks to modify a shared resource or another member's files,
   explain that the path is outside the current member's writable root and
   refuse the write.
9. If the allowed destination is ambiguous, stop and ask before acting.

## Reporting

When refusing a filesystem operation, state the requested path, the current
\`DSH_WORKSPACE\`, and the fact that it was blocked by the global shared policy.
`
}

async function replaceWithSymlink(linkPath, targetPath) {
  try {
    if ((await lstat(linkPath)).isDirectory()) {
      throw new Error(`refusing to replace directory with AGENTS.md symlink: ${linkPath}`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const temporary = `${linkPath}.tmp-${process.pid}-${randomUUID()}`
  await symlink(targetPath, temporary)
  try {
    await rename(temporary, linkPath)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export async function renderSharedAgents(options = {}) {
  const instanceRoot = resolve(options.instanceRoot ?? DEFAULT_INSTANCE_ROOT)
  const workspaceRoot = resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT)
  const sharedRoot = resolve(options.sharedRoot ?? DEFAULT_SHARED_ROOT)
  const target = resolve(sharedRoot, 'AGENTS.md')
  const users = [...new Set(options.users ?? DEFAULT_USERS)]
  for (const userId of users) {
    if (!USER_ID.test(userId)) throw new Error(`invalid user id: ${userId}`)
  }

  const content = renderSharedAgentsContent({
    sharedRoot,
    skillsRoot: options.skillsRoot,
    profilesRoot: options.profilesRoot,
    presetsRoot: options.presetsRoot,
    sharedProjectsRoot: options.sharedProjectsRoot,
  })
  await mkdir(sharedRoot, { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${process.pid}`
  await writeFile(temporary, content, { mode: 0o444 })
  const handle = await open(temporary, 'r')
  await handle.sync()
  await handle.close()
  await rename(temporary, target)

  const links = []
  for (const userId of users) {
    const home = resolve(instanceRoot, userId, 'home')
    const workspace = resolve(workspaceRoot, userId)
    for (const link of [resolve(home, 'AGENTS.md'), resolve(workspace, 'AGENTS.md')]) {
      await mkdir(dirname(link), { recursive: true, mode: 0o700 })
      await replaceWithSymlink(link, target)
      links.push(link)
    }
  }
  return { target, links, bytes: Buffer.byteLength(content) }
}

async function main() {
  const users = process.argv.slice(2)
  const result = await renderSharedAgents({
    users: users.length === 0 ? DEFAULT_USERS : users,
    instanceRoot: process.env.INSTANCE_ROOT,
    workspaceRoot: process.env.WORKSPACE_ROOT,
    sharedRoot: process.env.DSH_SHARED_ROOT,
    skillsRoot: process.env.SHARED_SKILLS_ROOT,
    profilesRoot: process.env.SHARED_PROFILES_ROOT,
    presetsRoot: process.env.SHARED_PRESETS_ROOT,
    sharedProjectsRoot: process.env.SHARED_PROJECTS_ROOT,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exit(1)
  })
}
