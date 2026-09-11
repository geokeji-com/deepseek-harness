import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from './config.mjs'

const ENV_KEYS = [
  'USERS_FILE',
  'COOKIE_DAYS',
  'IDLE_MINUTES',
  'START_TIMEOUT_SECONDS',
]

test('rejects non-numeric lifecycle durations instead of propagating NaN', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-config-'))
  const previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]))
  const usersFile = join(root, 'users.json')
  try {
    await writeFile(usersFile, JSON.stringify({
      users: [{
        id: 'owner',
        port: 3090,
        enabled: true,
        passwordScrypt: `${'a'.repeat(32)}:${'b'.repeat(64)}`,
      }],
    }))
    process.env.USERS_FILE = usersFile
    process.env.COOKIE_DAYS = '30'
    process.env.IDLE_MINUTES = '120'
    process.env.START_TIMEOUT_SECONDS = '45'
    const config = loadConfig()
    assert.equal(config.idleMs, 7_200_000)
    assert.equal(config.startTimeoutMs, 45_000)

    process.env.IDLE_MINUTES = 'not-a-number'
    assert.throws(() => loadConfig(), /IDLE_MINUTES must be a positive integer/u)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
