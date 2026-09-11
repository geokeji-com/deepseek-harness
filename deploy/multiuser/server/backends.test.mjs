import assert from 'node:assert/strict'
import test from 'node:test'
import { BackendManager } from './backends.mjs'

function fixture(overrides = {}) {
  const calls = []
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
  const config = {
    publicHost: 'dsh.example.test',
    startTimeoutMs: 1000,
    idleMs: 60_000,
    users: [{ id: 'member2', port: 3091, enabled: true }],
  }
  const manager = new BackendManager(config, logger, {
    portOpen: async () => true,
    launchToken: overrides.launchToken ?? (() => 'launch-token'),
    bootstrapCookie: overrides.bootstrapCookie
      ?? (async () => 'dsh-backend-cookie=value'),
    execFile: async (file, args) => {
      calls.push({ file, args })
      return { stdout: '', stderr: '' }
    },
  })
  return { calls, manager }
}

test('adopts a running backend without restarting it when the launch token exists', async () => {
  const f = fixture()
  const state = await f.manager.ensure('member2', 'trace-test')

  assert.equal(state.cookie, 'dsh-backend-cookie=value')
  assert.deepEqual(f.calls, [])
})

test('restarts a running backend when its launch token is no longer available', async () => {
  let launchToken
  let restartCount = 0
  const f = fixture({
    launchToken: () => launchToken,
    bootstrapCookie: async () => {
      assert.equal(launchToken, 'fresh-token')
      return 'dsh-backend-cookie=fresh'
    },
  })
  f.manager.execFile = async (file, args) => {
    restartCount += 1
    assert.deepEqual(args, [
      '--user',
      'restart',
      'deepseek-harness-user@member2.service',
    ])
    launchToken = 'fresh-token'
    return { stdout: '', stderr: '' }
  }

  const state = await f.manager.ensure('member2', 'trace-test')
  assert.equal(restartCount, 1)
  assert.equal(state.cookie, 'dsh-backend-cookie=fresh')
})
