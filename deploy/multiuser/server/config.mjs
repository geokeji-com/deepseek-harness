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

function positiveInteger(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function booleanValue(value, name, fallback) {
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} must be "true" or "false"`)
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

  const backendMode = process.env.BACKEND_MODE ?? 'legacy'
  if (backendMode !== 'shared' && backendMode !== 'legacy') {
    throw new Error('BACKEND_MODE must be "shared" or "legacy"')
  }
  const requestPrincipalSecret = process.env.REQUEST_PRINCIPAL_SECRET ?? ''
  if (backendMode === 'shared' && requestPrincipalSecret.length < 32) {
    throw new Error('REQUEST_PRINCIPAL_SECRET must contain at least 32 characters in shared mode')
  }
  const sharedHarness = {
    home: process.env.SHARED_DSH_HOME
      ?? '/home/dsh/.local/share/deepseek-harness/shared/home',
    port: positiveInt(process.env.SHARED_HARNESS_PORT ?? '3090', 'SHARED_HARNESS_PORT'),
    service: process.env.SHARED_HARNESS_SERVICE ?? 'dsh-shared-harness.service',
    logPath: process.env.SHARED_HARNESS_LOG
      ?? '/home/dsh/.local/state/deepseek-harness/shared/web.log',
    workspaceRoot: process.env.TEAM_WORKSPACE_ROOT
      ?? '/home/dsh/shared/workspace',
  }
  const perUserWorkspace = booleanValue(
    process.env.TEAM_WORKSPACE_PER_USER,
    'TEAM_WORKSPACE_PER_USER',
    true,
  )

  return {
    users,
    usersPath,
    backendMode,
    requestPrincipalSecret,
    sharedHarness,
    proxyPort: positiveInt(process.env.MANAGER_PROXY_PORT ?? '3080', 'MANAGER_PROXY_PORT'),
    authPort: positiveInt(process.env.AUTH_PORT ?? '3081', 'AUTH_PORT'),
    publicHost: process.env.PUBLIC_HOST ?? '8.130.99.203',
    cookieDays: positiveInteger(process.env.COOKIE_DAYS ?? '30', 'COOKIE_DAYS'),
    cookieSecret: process.env.AUTH_COOKIE_SECRET ?? '',
    cookieSecure: booleanValue(
      process.env.AUTH_COOKIE_SECURE,
      'AUTH_COOKIE_SECURE',
      true,
    ),
    idleMs: positiveInteger(process.env.IDLE_MINUTES ?? '120', 'IDLE_MINUTES') * 60 * 1000,
    startTimeoutMs: positiveInteger(
      process.env.START_TIMEOUT_SECONDS ?? '45',
      'START_TIMEOUT_SECONDS',
    ) * 1000,
    pathPolicy: {
      shared: backendMode === 'shared',
      sharedHome: sharedHarness.home,
      workspaceRoot: backendMode === 'shared'
        ? sharedHarness.workspaceRoot
        : process.env.WORKSPACE_ROOT ?? '/home/dsh/workspace',
      perUserWorkspace,
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
