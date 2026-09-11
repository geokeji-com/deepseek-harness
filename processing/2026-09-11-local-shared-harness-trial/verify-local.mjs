import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TRIAL = process.env.DSH_TRIAL_ROOT ?? '/tmp/dsh-shared-harness-local'
const ORIGIN = process.env.DSH_TRIAL_ORIGIN ?? 'http://localhost:3180'
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(join(REPO_ROOT, 'package.json'))
const WebSocket = require(join(
  REPO_ROOT,
  'node_modules/.pnpm/ws@8.21.0/node_modules/ws',
))

function credentials() {
  const values = new Map()
  for (const line of readFileSync(join(TRIAL, 'trial-credentials.txt'), 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1))
  }
  return values
}

async function login(password) {
  const response = await fetch(`${ORIGIN}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
  })
  if (response.status !== 303) throw new Error(`login failed with HTTP ${String(response.status)}`)
  const cookie = response.headers.getSetCookie()
    .map(value => value.split(';', 1)[0])
    .find(value => value.startsWith('dsh-user='))
  if (cookie === undefined) throw new Error('login response did not set dsh-user')
  return cookie
}

async function rpc(cookie, method, args) {
  const response = await fetch(`${ORIGIN}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `trial-${method}-${Date.now()}`,
      method,
      payload: { args },
    }),
  })
  const body = await response.json()
  return { status: response.status, result: body.result }
}

function ids(result) {
  return new Set((result.value?.items ?? []).map(item => item.sessionId))
}

async function verifyWebSocket(cookie) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:3180/api/remote.mux', {
      headers: { cookie },
    })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('WebSocket upgrade timed out'))
    }, 10_000)
    socket.once('open', () => {
      clearTimeout(timer)
      socket.close()
      resolve()
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

const users = credentials()
const anonymousRoot = await fetch(`${ORIGIN}/`, { redirect: 'manual' })
if (anonymousRoot.status !== 303 || anonymousRoot.headers.get('location') !== '/login') {
  throw new Error(`anonymous root did not redirect to /login: HTTP ${String(anonymousRoot.status)}`)
}

const ownerCookie = await login(users.get('owner'))
const memberCookie = await login(users.get('member2'))

const ownerDirectory = await rpc(ownerCookie, 'directoryPicker/list', {})
const memberDirectory = await rpc(memberCookie, 'directoryPicker/list', {})
if (ownerDirectory.result?.ok !== true
  || ownerDirectory.result.value?.path !== join(TRIAL, 'workspace/owner')) {
  throw new Error(`owner default directory is wrong: ${JSON.stringify(ownerDirectory.result)}`)
}
if (memberDirectory.result?.ok !== true
  || memberDirectory.result.value?.path !== join(TRIAL, 'workspace/member2')) {
  throw new Error(`member2 default directory is wrong: ${JSON.stringify(memberDirectory.result)}`)
}

const page = await fetch(`${ORIGIN}/`, { headers: { cookie: ownerCookie } })
const html = await page.text()
if (page.status !== 200 || !html.includes('<script')) {
  throw new Error(`Web UI did not load: HTTP ${String(page.status)}`)
}

const created = await rpc(ownerCookie, 'session/create', { request: {} })
if (created.status !== 200 || created.result?.ok !== true) {
  throw new Error(`owner session/create failed: ${JSON.stringify(created.result)}`)
}
const sessionId = created.result.value.sessionId

const ownerList = await rpc(ownerCookie, 'session/list', { _request: {} })
const memberList = await rpc(memberCookie, 'session/list', { _request: {} })
if (!ids(ownerList.result).has(sessionId)) throw new Error('owner cannot see own Session')
if (ids(memberList.result).has(sessionId)) throw new Error('member2 can see owner Session')

const foreignRename = await rpc(memberCookie, 'session/rename', {
  request: { sessionId, title: 'forbidden' },
})
if (foreignRename.result?.ok !== false
  || foreignRename.result.error?.code !== 'session/not-found') {
  throw new Error(`cross-owner rename was not hidden: ${JSON.stringify(foreignRename.result)}`)
}

await verifyWebSocket(ownerCookie)

console.log(JSON.stringify({
  origin: ORIGIN,
  ui: 'ok',
  owner_default_directory: ownerDirectory.result.value.path,
  member2_default_directory: memberDirectory.result.value.path,
  owner_session: sessionId,
  owner_session_count: ids(ownerList.result).size,
  member_session_count: ids(memberList.result).size,
  cross_owner: foreignRename.result.error.code,
  websocket: 'ok',
}, null, 2))
