import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const LOG_ROOT = '/home/dsh/.local/state/deepseek-harness/instances'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function launchToken(userId, logRoot = LOG_ROOT) {
  return launchTokenFromPath(`${logRoot}/${userId}/web.log`)
}

function launchTokenFromPath(path) {
  if (!existsSync(path)) return undefined
  const stats = statSync(path)
  const length = Math.min(stats.size, 131072)
  if (length === 0) return undefined
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, length, stats.size - length)
  } finally {
    closeSync(fd)
  }
  const matches = [...buffer.toString('utf8').matchAll(
    /dsh web:[^\r\n]*\?token=([A-Za-z0-9_-]+)/gu,
  )]
  return matches.at(-1)?.[1]
}

function establishedPorts() {
  const ports = new Set()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows
    try {
      rows = readFileSync(file, 'utf8').trim().split('\n').slice(1)
    } catch {
      continue
    }
    for (const row of rows) {
      const fields = row.trim().split(/\s+/u)
      if (fields[3] !== '01') continue
      const port = Number.parseInt(fields[1].split(':').at(-1), 16)
      if (Number.isInteger(port)) ports.add(port)
    }
  }
  return ports
}

async function bootstrapCookie(port, publicHost, userId, logRoot = LOG_ROOT, explicitToken) {
  const token = explicitToken ?? launchToken(userId, logRoot)
  if (token === undefined) throw new Error(`launch token unavailable for ${userId}`)
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: `/?token=${encodeURIComponent(token)}`,
      headers: { host: publicHost },
    }, response => {
      response.resume()
      const setCookie = response.headers['set-cookie']?.[0]
      if (setCookie === undefined) {
        reject(new Error(`backend did not issue a browser cookie for ${userId}`))
        return
      }
      resolve(setCookie.split(';', 1)[0])
    })
    request.setTimeout(10_000, () => request.destroy(new Error('backend bootstrap timeout')))
    request.once('error', reject)
    request.end()
  })
}

export class BackendManager {
  constructor(config, logger, options = {}) {
    this.config = config
    this.logger = logger
    this.portOpen = options.portOpen ?? portOpen
    this.readLaunchToken = options.launchToken
      ?? (userId => launchToken(userId, options.logRoot))
    this.bootstrapCookie = options.bootstrapCookie
      ?? ((port, publicHost, userId) => bootstrapCookie(
        port, publicHost, userId, options.logRoot,
      ))
    this.execFile = options.execFile ?? execFileAsync
    this.states = new Map(config.users.map(user => [user.id, {
      user,
      cookie: undefined,
      lastUsed: Date.now(),
      refreshing: undefined,
      starting: undefined,
      stopping: false,
    }]))
    this.timer = setInterval(() => { void this.reapIdle() }, 60_000)
    this.timer.unref()
  }

  state(userId) {
    const state = this.states.get(userId)
    if (state === undefined) throw new Error(`unknown user: ${userId}`)
    return state
  }

  markUsed(userId) {
    this.state(userId).lastUsed = Date.now()
  }

  async ensure(userId, traceId) {
    const state = this.state(userId)
    if (!state.user.enabled) throw new Error(`user is disabled: ${userId}`)
    state.lastUsed = Date.now()
    if (await this.portOpen(state.user.port)) {
      if (state.cookie === undefined) {
        await this.refreshCookie(userId, traceId)
      }
      return state
    }
    if (state.starting === undefined) {
      state.starting = this.start(state, traceId).finally(() => {
        state.starting = undefined
      })
    }
    await state.starting
    return state
  }

  async refreshCookie(userId, traceId) {
    const state = this.state(userId)
    if (state.refreshing === undefined) {
      state.refreshing = this.refreshCookieInternal(state, traceId).finally(() => {
        state.refreshing = undefined
      })
    }
    await state.refreshing
    return state
  }

  async refreshCookieInternal(state, traceId) {
    if (this.readLaunchToken(state.user.id) !== undefined) {
      try {
        state.cookie = await this.bootstrapCookie(
          state.user.port, this.config.publicHost, state.user.id,
        )
        return
      } catch (error) {
        this.logger.warn('retry_scheduled', {
          traceId,
          job: 'backend_cookie_refresh',
          userId: state.user.id,
          error_type: error?.name ?? 'Error',
          reason: 'launch_token_bootstrap_failed',
        })
      }
    }
    await this.bootstrapService(
      state,
      traceId,
      'restart',
      'launch_token_unavailable',
      'backend_cookie_refresh',
    )
  }

  async start(state, traceId) {
    await this.bootstrapService(
      state,
      traceId,
      'start',
      'backend_missing',
      'backend_start',
    )
  }

  async bootstrapService(state, traceId, action, reason, job) {
    const unit = `deepseek-harness-user@${state.user.id}.service`
    this.logger.info('job_started', {
      traceId, job, userId: state.user.id, port: state.user.port,
      reason,
    })
    try {
      await this.execFile('/usr/bin/systemctl', ['--user', action, unit])
      state.cookie = undefined
      const startedAt = Date.now()
      state.cookie = await this.waitForBootstrap(
        state, traceId, this.config.startTimeoutMs, job,
      )
      this.logger.info('job_succeeded', {
        traceId, job, userId: state.user.id,
        duration_ms: Date.now() - startedAt,
      })
    } catch (error) {
      this.logger.error('job_failed', {
        traceId, job, userId: state.user.id,
        error_type: error?.name ?? 'Error',
        reason: `${job}_failed`,
      })
      throw error
    }
  }

  async waitForBootstrap(state, traceId, timeoutMs, job) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      if (await this.portOpen(state.user.port)
        && this.readLaunchToken(state.user.id) !== undefined) {
        try {
          return await this.bootstrapCookie(
            state.user.port, this.config.publicHost, state.user.id,
          )
        } catch (error) {
          lastError = error
        }
      }
      await sleep(500)
    }
    this.logger.warn('retry_scheduled', {
      traceId, job, userId: state.user.id,
      error_type: lastError?.name ?? 'TimeoutError',
      reason: 'backend_cookie_wait_timeout',
    })
    throw lastError ?? new Error(`backend did not become ready: ${state.user.id}`)
  }

  async stop(userId, reason, traceId) {
    const state = this.state(userId)
    if (state.stopping) return
    state.stopping = true
    try {
      await this.execFile('/usr/bin/systemctl', [
        '--user', 'stop', `deepseek-harness-user@${userId}.service`,
      ])
      state.cookie = undefined
      this.logger.info('system_stopped', {
        traceId, userId, reason, port: state.user.port,
      })
    } catch (error) {
      this.logger.error('error_occurred', {
        traceId, userId, error_type: error?.name ?? 'Error',
        reason: 'backend_stop_failed',
      })
    } finally {
      state.stopping = false
    }
  }

  async reapIdle() {
    const ports = establishedPorts()
    const now = Date.now()
    for (const state of this.states.values()) {
      if (!state.user.enabled || ports.has(state.user.port)) {
        if (ports.has(state.user.port)) state.lastUsed = now
        continue
      }
      if (now - state.lastUsed < this.config.idleMs) continue
      if (!(await this.portOpen(state.user.port))) continue
      await this.stop(state.user.id, 'idle_timeout', `idle-${state.user.id}-${now}`)
      state.lastUsed = now
    }
  }
}

/** One shared Harness process adopted by every authenticated principal. */
export class SharedBackendManager {
  constructor(config, logger, options = {}) {
    this.config = config
    this.logger = logger
    this.portOpen = options.portOpen ?? portOpen
    this.readLaunchToken = options.launchToken
      ?? (() => launchTokenFromPath(config.sharedHarness.logPath))
    this.bootstrapCookie = options.bootstrapCookie
      ?? (() => bootstrapCookieFromPath(
        config.sharedHarness.port,
        config.publicHost,
        config.sharedHarness.logPath,
      ))
    this.execFile = options.execFile ?? execFileAsync
    this.state = {
      user: { id: 'shared', port: config.sharedHarness.port, enabled: true },
      port: config.sharedHarness.port,
      cookie: undefined,
      lastUsed: Date.now(),
      refreshing: undefined,
      starting: undefined,
      stopping: false,
    }
  }

  markUsed() {
    this.state.lastUsed = Date.now()
  }

  async ensure(_userId, traceId) {
    this.markUsed()
    if (await this.portOpen(this.config.sharedHarness.port)) {
      if (this.state.cookie === undefined) await this.refreshCookie(traceId)
      return this.state
    }
    if (this.state.starting === undefined) {
      this.state.starting = this.start(traceId).finally(() => {
        this.state.starting = undefined
      })
    }
    await this.state.starting
    return this.state
  }

  async refreshCookie(traceId) {
    if (this.state.refreshing === undefined) {
      this.state.refreshing = this.refreshCookieInternal(traceId).finally(() => {
        this.state.refreshing = undefined
      })
    }
    await this.state.refreshing
    return this.state
  }

  async refreshCookieInternal(traceId) {
    if (this.readLaunchToken() !== undefined) {
      try {
        this.state.cookie = await this.bootstrapCookie()
        return
      } catch (error) {
        this.logger.warn('retry_scheduled', {
          traceId,
          job: 'shared_cookie_refresh',
          error_type: error?.name ?? 'Error',
          reason: 'launch_token_bootstrap_failed',
        })
      }
    }
    await this.bootstrapService(traceId, 'restart', 'launch_token_unavailable')
  }

  async start(traceId) {
    await this.bootstrapService(traceId, 'start', 'shared_backend_missing')
  }

  async bootstrapService(traceId, action, reason) {
    const service = this.config.sharedHarness.service
    this.logger.info('job_started', {
      traceId, job: 'shared_backend_start', service, reason,
    })
    try {
      await this.execFile('/usr/bin/systemctl', ['--user', action, service])
      this.state.cookie = undefined
      const startedAt = Date.now()
      this.state.cookie = await this.waitForBootstrap(traceId, this.config.startTimeoutMs)
      this.logger.info('job_succeeded', {
        traceId, job: 'shared_backend_start', service,
        duration_ms: Date.now() - startedAt,
      })
    } catch (error) {
      this.logger.error('job_failed', {
        traceId, job: 'shared_backend_start', service,
        error_type: error?.name ?? 'Error',
        reason: 'shared_backend_start_failed',
      })
      throw error
    }
  }

  async waitForBootstrap(traceId, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      if (await this.portOpen(this.config.sharedHarness.port)
        && this.readLaunchToken() !== undefined) {
        try {
          return await this.bootstrapCookie()
        } catch (error) {
          lastError = error
        }
      }
      await sleep(500)
    }
    this.logger.warn('retry_scheduled', {
      traceId,
      job: 'shared_backend_start',
      error_type: lastError?.name ?? 'TimeoutError',
      reason: 'shared_backend_cookie_wait_timeout',
    })
    throw lastError ?? new Error('shared Harness did not become ready')
  }

  /** Shared residency is intentional; per-user idle reaping does not stop it. */
  async reapIdle() {}

  async stop(reason, traceId) {
    await this.execFile('/usr/bin/systemctl', [
      '--user', 'stop', this.config.sharedHarness.service,
    ])
    this.state.cookie = undefined
    this.logger.info('system_stopped', {
      traceId, service: this.config.sharedHarness.service, reason,
    })
  }
}

function bootstrapCookieFromPath(port, publicHost, path) {
  const token = launchTokenFromPath(path)
  if (token === undefined) throw new Error('shared Harness launch token unavailable')
  return bootstrapCookie(port, publicHost, 'shared', undefined, token)
}
