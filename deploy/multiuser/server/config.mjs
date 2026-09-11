import { readFileSync } from 'node:fs'

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/u
const SCRYPT = /^[a-f0-9]{32}:[a-f0-9]{64}$/u

function positiveInt(value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a valid TCP port`)
  }
  return parsed
}

export function loadConfig() {
  const usersPath = process.env.USERS_FILE
    ?? '/home/dsh/.config/deepseek-harness/multiuser/users.json'
  const users = JSON.parse(readFileSync(usersPath, 'utf8')).users
  if (!Array.isArray(users) || users.length === 0) throw new Error('users.json has no users')

  const ids = new Set()
  const ports = new Set()
  for (const user of users) {
    if (!USER_ID.test(user.id)) throw new Error('invalid user id')
    if (ids.has(user.id)) throw new Error(`duplicate user id: ${user.id}`)
    if (typeof user.passwordScrypt !== 'string' || !SCRYPT.test(user.passwordScrypt)) {
      throw new Error(`invalid password hash for ${user.id}`)
    }
    ids.add(user.id)
    user.port = positiveInt(user.port, `port for ${user.id}`)
    if (ports.has(user.port)) throw new Error(`duplicate port: ${user.port}`)
    ports.add(user.port)
    user.enabled = user.enabled !== false
  }

  return {
    users,
    usersPath,
    proxyPort: positiveInt(process.env.MANAGER_PROXY_PORT ?? '3080', 'MANAGER_PROXY_PORT'),
    authPort: positiveInt(process.env.AUTH_PORT ?? '3081', 'AUTH_PORT'),
    publicHost: process.env.PUBLIC_HOST ?? '8.130.99.203',
    cookieDays: Number(process.env.COOKIE_DAYS ?? '30'),
    cookieSecret: process.env.AUTH_COOKIE_SECRET ?? '',
    idleMs: Number(process.env.IDLE_MINUTES ?? '120') * 60 * 1000,
    startTimeoutMs: Number(process.env.START_TIMEOUT_SECONDS ?? '45') * 1000,
    pathPolicy: {
      workspaceRoot: process.env.WORKSPACE_ROOT
        ?? '/home/dsh/workspace',
      sharedRoot: process.env.SHARED_PROJECTS_ROOT
        ?? '/home/dsh/shared/projects',
      skillsRoot: process.env.SHARED_SKILLS_ROOT
        ?? '/home/dsh/.local/share/deepseek-harness/shared/skills',
      profilesRoot: process.env.SHARED_PROFILES_ROOT
        ?? '/home/dsh/.local/share/deepseek-harness/shared/profiles',
      presetsRoot: process.env.SHARED_PRESETS_ROOT
        ?? '/home/dsh/.local/share/deepseek-harness/shared/agent-presets',
      instanceRoot: process.env.INSTANCE_ROOT
        ?? '/home/dsh/.local/share/deepseek-harness/instances',
      legacyRoots: {},
    },
  }
}
