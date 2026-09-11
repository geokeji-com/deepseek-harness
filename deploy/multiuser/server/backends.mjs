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

function launchToken(userId) {
  const path = `${LOG_ROOT}/${userId}/web.log`
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

async function bootstrapCookie(port, publicHost, userId) {
  const token = launchToken(userId)
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
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.states = new Map(config.users.map(user => [user.id, {
      user,
      cookie: undefined,
      lastUsed: Date.now(),
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
    if (await portOpen(state.user.port)) {
      if (state.cookie === undefined) {
        state.cookie = await this.waitForBootstrap(
          state, traceId, 15_000, 'backend_cookie_refresh',
        )
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

  async refreshCookie(userId) {
    const state = this.state(userId)
    state.cookie = await bootstrapCookie(
      state.user.port, this.config.publicHost, state.user.id,
    )
    return state
  }

  async start(state, traceId) {
    const unit = `deepseek-harness-user@${state.user.id}.service`
    this.logger.info('job_started', {
      traceId, job: 'backend_start', userId: state.user.id, port: state.user.port,
      reason: 'backend_missing',
    })
    try {
      await execFileAsync('/usr/bin/systemctl', ['--user', 'start', unit])
      const startedAt = Date.now()
      state.cookie = await this.waitForBootstrap(
        state, traceId, this.config.startTimeoutMs, 'backend_start',
      )
      this.logger.info('job_succeeded', {
        traceId, job: 'backend_start', userId: state.user.id,
        duration_ms: Date.now() - startedAt,
      })
    } catch (error) {
      this.logger.error('job_failed', {
        traceId, job: 'backend_start', userId: state.user.id,
        error_type: error?.name ?? 'Error',
        reason: 'backend_start_failed',
      })
      throw error
    }
  }

  async waitForBootstrap(state, traceId, timeoutMs, job) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      if (await portOpen(state.user.port) && launchToken(state.user.id) !== undefined) {
        try {
          return await bootstrapCookie(
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
      await execFileAsync('/usr/bin/systemctl', [
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
      if (!(await portOpen(state.user.port))) continue
      await this.stop(state.user.id, 'idle_timeout', `idle-${state.user.id}-${now}`)
      state.lastUsed = now
    }
  }
}
