import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import test from 'node:test'
import { UserAuth } from './auth.mjs'

const NOW = 1_700_000_000_000

function passwordHash(password) {
  const salt = randomBytes(16)
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`
}

function createAuth(users) {
  return new UserAuth({
    cookieSecret: 'A'.repeat(43),
    cookieDays: 30,
    users,
  })
}

test('binds signed cookies to the user and client IP', () => {
  const user = {
    id: 'member2',
    enabled: true,
    passwordScrypt: passwordHash('member2-password'),
  }
  const auth = createAuth([user])
  const cookie = auth.issue(user.id, '203.0.113.10', NOW)

  assert.equal(auth.verify(cookie, '203.0.113.10', NOW + 1_000), user.id)
  assert.equal(auth.verify(cookie, '203.0.113.11', NOW + 1_000), undefined)
})

test('rejects cookies immediately after a user is disabled', () => {
  const user = {
    id: 'member2',
    enabled: true,
    passwordScrypt: passwordHash('member2-password'),
  }
  const auth = createAuth([user])
  const cookie = auth.issue(user.id, '203.0.113.10', NOW)
  user.enabled = false

  assert.equal(auth.verify(cookie, '203.0.113.10', NOW + 1_000), undefined)
  assert.equal(auth.identify('member2-password'), undefined)
  assert.throws(() => auth.issue(user.id, '203.0.113.10', NOW + 1_000))
})

test('rotating one password invalidates only that user cookie', () => {
  const member2 = {
    id: 'member2',
    enabled: true,
    passwordScrypt: passwordHash('member2-password'),
  }
  const member3 = {
    id: 'member3',
    enabled: true,
    passwordScrypt: passwordHash('member3-password'),
  }
  const auth = createAuth([member2, member3])
  const member2Cookie = auth.issue(member2.id, '203.0.113.10', NOW)
  const member3Cookie = auth.issue(member3.id, '203.0.113.10', NOW)
  member2.passwordScrypt = passwordHash('member2-new-password')

  assert.equal(auth.verify(member2Cookie, '203.0.113.10', NOW + 1_000), undefined)
  assert.equal(auth.verify(member3Cookie, '203.0.113.10', NOW + 1_000), member3.id)
})
