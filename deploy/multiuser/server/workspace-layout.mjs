import { chmod, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT_MODE = 0o711
const MEMBER_MODE = 0o700

export async function initializeWorkspaceLayout(config) {
  const workspaceRoot = resolve(config.pathPolicy.workspaceRoot)
  await mkdir(workspaceRoot, { recursive: true, mode: ROOT_MODE })
  await chmod(workspaceRoot, ROOT_MODE)

  const members = config.pathPolicy.perUserWorkspace
    ? config.users.filter(user => user.enabled !== false)
    : []

  for (const member of members) {
    const memberRoot = join(workspaceRoot, member.id)
    await mkdir(memberRoot, { recursive: true, mode: MEMBER_MODE })
    await chmod(memberRoot, MEMBER_MODE)
  }

  return {
    workspaceRoot,
    memberCount: members.length,
    perUserWorkspace: config.pathPolicy.perUserWorkspace,
  }
}
