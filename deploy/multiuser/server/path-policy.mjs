import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, posix, resolve } from 'node:path'

const DEFAULT_WORKSPACE_ROOT = '/home/dsh/workspace'
const DEFAULT_SHARED_ROOT = '/home/dsh/shared/projects'
const DEFAULT_INSTANCE_ROOT = '/home/dsh/.local/share/deepseek-harness/instances'
const DEFAULT_SKILLS_ROOT = '/home/dsh/.local/share/deepseek-harness/shared/skills'
const DEFAULT_PROFILES_ROOT = '/home/dsh/.local/share/deepseek-harness/shared/profiles'
const DEFAULT_PRESETS_ROOT = '/home/dsh/.local/share/deepseek-harness/shared/agent-presets'
const MAX_JSON_BODY_BYTES = 1024 * 1024
const SESSION_CACHE_DIR = 'home/storages/session_projcache/sessions'

const FILE_ENDPOINTS = new Set([
  'workspaceFiles/read',
  'workspaceFiles/readBytes',
  'workspaceFiles/readAll',
  'workspaceFiles/readRelated',
  'workspaceFiles/stat',
  'workspaceFiles/list',
])
const POLICY_ENDPOINTS = new Set([
  ...FILE_ENDPOINTS,
  'directoryPicker/list',
  'directoryPicker/createDirectory',
  'workspace/create',
  'session/create',
  'session/openWorkspacePath',
])

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}/`)
}

function absolutePath(candidate) {
  return posix.normalize(candidate.startsWith('/') ? candidate : posix.resolve('/', candidate))
}

async function canonicalProbe(candidate) {
  let current = resolve(candidate)
  const missing = []
  for (;;) {
    try {
      const canonical = await realpath(current)
      return missing.length === 0 ? canonical : resolve(canonical, ...missing)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return resolve(candidate)
      missing.unshift(basename(current))
      current = parent
    }
  }
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let bytes = 0
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_JSON_BODY_BYTES) {
        rejectBody(new Error('JSON request body exceeds policy limit'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => resolveBody(Buffer.concat(chunks)))
    request.once('error', rejectBody)
  })
}

function rpcFailure(rpcId, code, message, details) {
  return Buffer.from(JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details } },
  }))
}

export function createPathPolicy(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT)
  const sharedRoot = resolve(options.sharedRoot ?? DEFAULT_SHARED_ROOT)
  const instanceRoot = resolve(options.instanceRoot ?? DEFAULT_INSTANCE_ROOT)
  const skillsRoot = resolve(options.skillsRoot ?? DEFAULT_SKILLS_ROOT)
  const profilesRoot = resolve(options.profilesRoot ?? DEFAULT_PROFILES_ROOT)
  const presetsRoot = resolve(options.presetsRoot ?? DEFAULT_PRESETS_ROOT)
  const legacyRoots = options.legacyRoots ?? {}
  const rootsCache = new Map()
  const readableRootsCache = new Map()

  const primaryRoot = userId => resolve(workspaceRoot, userId)

  async function rootsFor(userId) {
    const cached = rootsCache.get(userId)
    if (cached !== undefined) return cached
    const candidates = [
      primaryRoot(userId),
      ...(legacyRoots[userId] ?? []),
    ]
    const roots = [...new Set(await Promise.all(candidates.map(canonicalProbe)))]
    rootsCache.set(userId, roots)
    return roots
  }

  async function readableRootsFor(userId) {
    const cached = readableRootsCache.get(userId)
    if (cached !== undefined) return cached
    const roots = [...new Set([
      ...(await rootsFor(userId)),
      await canonicalProbe(sharedRoot),
      await canonicalProbe(skillsRoot),
      await canonicalProbe(profilesRoot),
      await canonicalProbe(presetsRoot),
    ])]
    readableRootsCache.set(userId, roots)
    return roots
  }

  async function authorize(userId, candidate, { relativeTo, access = 'write' } = {}) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return { allowed: false, reason: 'path_missing' }
    }
    const absolute = candidate.startsWith('/')
      ? absolutePath(candidate)
      : posix.resolve(relativeTo ?? primaryRoot(userId), candidate)
    const canonical = await canonicalProbe(absolute)
    const roots = access === 'read'
      ? await readableRootsFor(userId)
      : await rootsFor(userId)
    return roots.some(root => isWithin(root, canonical))
      ? { allowed: true, path: absolute, canonicalPath: canonical }
      : { allowed: false, reason: 'path_outside_allowed_roots' }
  }

  async function workspacePath(userId, workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return undefined
    try {
      const file = resolve(instanceRoot, userId, 'home/storages/workspace.json')
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      return parsed?.tables?.workspaces?.[workspaceId]?.path
    } catch {
      return undefined
    }
  }

  async function sessionCwd(userId, sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0
      || sessionId === '.' || sessionId === '..'
      || sessionId.includes('/') || sessionId.includes('\\')) {
      return undefined
    }
    try {
      const file = resolve(instanceRoot, userId, SESSION_CACHE_DIR, `${sessionId}.json`)
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      const cwd = parsed?.record?.identity?.cwd
      return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined
    } catch {
      return undefined
    }
  }

  async function relativeBase(userId, args) {
    const sessionId = args?.workspaceFileScopeId ?? args?.agentId
    if (typeof sessionId !== 'string') return primaryRoot(userId)
    const cwd = await sessionCwd(userId, sessionId)
    if (cwd === undefined) return primaryRoot(userId)
    const result = await authorize(userId, cwd, { access: 'read' })
    return result.allowed ? result.path : primaryRoot(userId)
  }

  async function inspectPayload(userId, endpoint, payload) {
    const args = payload?.args
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return { allowed: true }
    }

    if (endpoint === 'directoryPicker/list') {
      if (args.path === undefined) args.path = primaryRoot(userId)
      const result = await authorize(userId, args.path, { access: 'read' })
      if (result.allowed) {
        args.path = result.path
        return { allowed: true }
      }
      return {
        allowed: false,
        code: 'directory-picker/unreadable',
        details: { path: args.path },
      }
    }

    if (endpoint === 'directoryPicker/createDirectory') {
      const result = await authorize(userId, args.path)
      const invalidName = typeof args.name !== 'string' || args.name.trim() === ''
        || args.name === '.' || args.name === '..' || /[/\\]/u.test(args.name)
      if (!result.allowed || invalidName) {
        return {
          allowed: false,
          code: 'directory-picker/create-failed',
          details: { path: result.allowed ? posix.join(result.path, String(args.name)) : args.path },
        }
      }
      const child = await authorize(userId, posix.join(result.path, args.name))
      if (!child.allowed) {
        return {
          allowed: false,
          code: 'directory-picker/create-failed',
          details: { path: posix.join(result.path, args.name) },
        }
      }
      args.path = result.path
      return { allowed: true }
    }

    if (endpoint === 'workspace/create') {
      const path = args.request?.path
      const result = await authorize(userId, path)
      if (!result.allowed) {
        return { allowed: false, code: 'workspace/invalid-path', details: { path } }
      }
      args.request.path = result.path
      return { allowed: true }
    }

    if (endpoint === 'session/create') {
      const request = args.request ?? (args.request = {})
      if (typeof request.cwd === 'string' && request.cwd.length > 0) {
        const result = await authorize(userId, request.cwd)
        if (!result.allowed) {
          return { allowed: false, code: 'gateway/bad-request', details: { path: request.cwd } }
        }
        request.cwd = result.path
        return { allowed: true }
      }
      if (typeof request.workspaceId === 'string' && request.workspaceId.length > 0) {
        const registered = await workspacePath(userId, request.workspaceId)
        if (registered !== undefined) {
          const result = await authorize(userId, registered)
          if (!result.allowed) {
            return { allowed: false, code: 'gateway/bad-request', details: { path: registered } }
          }
          return { allowed: true }
        }
        return { allowed: true }
      }
      request.cwd = primaryRoot(userId)
      return { allowed: true }
    }

    if (FILE_ENDPOINTS.has(endpoint)) {
      const result = await authorize(userId, args.path, {
        relativeTo: await relativeBase(userId, args),
        access: 'read',
      })
      if (!result.allowed) {
        return {
          allowed: false,
          code: 'workspace-file/outside-workspace',
          details: { path: args.path ?? '' },
        }
      }
      args.path = result.path
      if (endpoint === 'workspaceFiles/readRelated') {
        if (typeof args.relativePath !== 'string' || args.relativePath.startsWith('/')) {
          return {
            allowed: false,
            code: 'gateway/bad-request',
            details: {},
          }
        }
        const related = posix.resolve(dirname(result.path), args.relativePath)
        const relatedResult = await authorize(userId, related, { access: 'read' })
        if (!relatedResult.allowed) {
          return {
            allowed: false,
            code: 'workspace-file/outside-workspace',
            details: { path: related },
          }
        }
      }
      return { allowed: true }
    }

    if (endpoint === 'session/openWorkspacePath') {
      const result = await authorize(userId, args.request?.path, {
        relativeTo: await relativeBase(userId, args),
      })
      if (!result.allowed) {
        return {
          allowed: false,
          code: 'gateway/bad-request',
          details: { path: args.request?.path ?? '' },
        }
      }
      args.request.path = result.path
      return { allowed: true }
    }
    return { allowed: true }
  }

  async function inspectRequest(request, userId) {
    if (request.method !== 'POST') return { body: true }
    let endpoint
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname
      endpoint = pathname.startsWith('/api/') ? pathname.slice('/api/'.length) : undefined
    } catch {
      return { body: true }
    }
    if (endpoint === undefined || !POLICY_ENDPOINTS.has(endpoint)) return { body: true }
    const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') return { body: true }

    const original = await readBody(request)
    let envelope
    try {
      envelope = JSON.parse(original.toString('utf8'))
    } catch {
      return { body: original }
    }
    if (envelope?.type !== 'client-request' || envelope.method !== endpoint
      || typeof envelope.rpcId !== 'string') {
      return { body: original }
    }

    const decision = await inspectPayload(userId, endpoint, envelope.payload)
    if (decision.allowed) {
      return { body: Buffer.from(JSON.stringify(envelope)) }
    }
    const message = decision.code === 'gateway/bad-request'
      ? 'path is outside the allowed workspace roots'
      : decision.code === 'workspace/invalid-path'
        ? 'workspace path is outside the allowed roots'
        : decision.code === 'workspace-file/outside-workspace'
          ? 'file path is outside the allowed workspace roots'
          : decision.code === 'directory-picker/create-failed'
            ? 'directory creation is outside the allowed workspace roots'
            : 'path is outside the allowed workspace roots'
    return {
      response: rpcFailure(
        envelope.rpcId,
        decision.code,
        message,
        decision.details ?? {},
      ),
      reason: decision.reason ?? 'path_policy_denied',
    }
  }

  return {
    authorize,
    inspectPayload,
    inspectRequest,
    primaryRoot,
    rootsFor,
    sessionCwd,
    workspacePath,
  }
}
