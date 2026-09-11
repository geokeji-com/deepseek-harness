import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INTERNAL_IDENTITY_HEADERS,
  RequestPrincipalIssuer,
  stripInternalIdentityHeaders,
} from './principal.mjs'

const SECRET = 'proxy-request-principal-secret-0123456789abcdef'

test('issues and verifies a short-lived method/path-bound principal', () => {
  const issuer = new RequestPrincipalIssuer(SECRET, 60_000)
  const token = issuer.issue('member-a', 'post', '/api/session.list?limit=10', 1_000_000)

  assert.deepEqual(issuer.verify(token, 'POST', '/api/session.list?limit=10', 1_030_000), {
    v: 1,
    sub: 'member-a',
    iat: 1_000_000,
    exp: 1_060_000,
    method: 'POST',
    path: '/api/session.list?limit=10',
  })
  assert.equal(issuer.verify(token, 'GET', '/api/session.list?limit=10', 1_030_000), undefined)
  assert.equal(issuer.verify(token, 'POST', '/api/session.list?limit=11', 1_030_000), undefined)
  assert.equal(issuer.verify(token, 'POST', '/api/session.list?limit=10', 1_060_000), undefined)
})

test('rejects malformed, forged, and wrong-key principals', () => {
  const issuer = new RequestPrincipalIssuer(SECRET)
  const token = issuer.issue('member-a', 'POST', '/api/session.list')
  const parts = token.split('.')

  assert.equal(issuer.verify(undefined, 'POST', '/api/session.list'), undefined)
  assert.equal(issuer.verify('not-a-token', 'POST', '/api/session.list'), undefined)
  assert.equal(issuer.verify(parts.slice(0, 2).join('.'), 'POST', '/api/session.list'), undefined)
  assert.equal(issuer.verify(`${parts[0]}.${parts[1]}.AAAA`, 'POST', '/api/session.list'), undefined)
  assert.equal(
    new RequestPrincipalIssuer(`${SECRET}-different`).verify(token, 'POST', '/api/session.list'),
    undefined,
  )
})

test('strips every client-controlled internal identity header', () => {
  const headers = Object.fromEntries(INTERNAL_IDENTITY_HEADERS.map(name => [name, 'forged']))
  headers['content-type'] = 'application/json'

  stripInternalIdentityHeaders(headers)

  assert.deepEqual(headers, { 'content-type': 'application/json' })
})

test('rejects weak secrets and invalid TTLs at construction', () => {
  assert.throws(() => new RequestPrincipalIssuer('short'), /at least 32 characters/u)
  for (const ttl of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new RequestPrincipalIssuer(SECRET, ttl), /positive safe integer/u)
  }
})
