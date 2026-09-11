import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { RequestPrincipalIssuer } from './principal.mjs'
import { createProxyHandler, forwardedHeaders } from './proxy.mjs'

const SECRET = 'proxy-integration-secret-0123456789abcdef'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => { resolve() })
  })
}

function fixtureAuth(userId = 'member-a') {
  return {
    parseCookie: value => value,
    verify: value => value === `auth=${userId}` ? userId : undefined,
  }
}

function fixtureBackends(port) {
  const calls = []
  return {
    calls,
    async ensure(userId, traceId) {
      calls.push({ userId, traceId })
      return {
        user: { id: userId },
        port,
        cookie: 'backend-session=trusted',
      }
    },
    async refreshCookie() {},
    markUsed() {},
  }
}

test('HTTP proxy strips forged identity headers and injects one signed principal', async () => {
  const issuer = new RequestPrincipalIssuer(SECRET)
  let received
  const backend = http.createServer((request, response) => {
    received = request.headers
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      cookie: request.headers.cookie,
      principal: request.headers['x-dsh-request-principal'],
      forged: request.headers['x-dsh-user-id'],
    }))
  })
  const backendPort = await listen(backend)
  const backends = fixtureBackends(backendPort)
  const proxy = http.createServer(createProxyHandler({
    auth: fixtureAuth(),
    backends,
    logger: { info() {}, warn() {}, error() {} },
    pathPolicy: undefined,
    principal: issuer,
    publicHost: 'dsh.example.test',
  }))
  const proxyPort = await listen(proxy)

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/session.list?limit=10`, {
      headers: {
        cookie: 'auth=member-a',
        'x-dsh-user-id': 'member-b',
        'x-dsh-principal': 'forged',
      },
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.cookie, 'backend-session=trusted')
    assert.equal(body.forged, undefined)
    assert.equal(received.cookie, 'backend-session=trusted')
    assert.equal(received['x-dsh-user-id'], undefined)
    assert.equal(received['x-dsh-principal'], undefined)
    assert.equal(issuer.verify(body.principal, 'GET', '/api/session.list?limit=10')?.sub, 'member-a')
  } finally {
    await close(proxy)
    await close(backend)
  }
})

test('WebSocket proxy strips forged identity headers and binds the upgrade principal', () => {
  const issuer = new RequestPrincipalIssuer(SECRET)
  const principal = issuer.issue('member-a', 'GET', '/api/remote.mux')
  const headers = forwardedHeaders({
    headers: {
      host: 'public.example.test',
      cookie: 'client-cookie=untrusted',
      'x-dsh-request-principal': 'forged',
      'x-dsh-user-id': 'member-b',
      'x-dsh-authenticated-user': 'forged',
      'x-dsh-principal': 'forged',
    },
  }, 'backend-session=trusted', 'dsh.example.test', principal, true)

  assert.equal(headers.cookie, 'backend-session=trusted')
  assert.equal(headers.host, 'dsh.example.test')
  assert.equal(headers.connection, 'Upgrade')
  assert.equal(headers['x-dsh-user-id'], undefined)
  assert.equal(headers['x-dsh-authenticated-user'], undefined)
  assert.equal(headers['x-dsh-principal'], undefined)
  assert.equal(issuer.verify(
    headers['x-dsh-request-principal'],
    'GET',
    '/api/remote.mux',
  )?.sub, 'member-a')
})
