import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'dsh-user'
const MAX_FAILURES = 5
const LOCK_MS = 5 * 60 * 1000

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function verifyHash(password, encoded) {
  const [saltHex, expectedHex] = encoded.split(':')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 32)
  return safeEqual(actual, Buffer.from(expectedHex, 'hex'))
}

function cookieSignature(secret, user, expiresText, ip) {
  return createHmac('sha256', secret)
    .update(`${user.id}|${user.passwordScrypt}|${expiresText}|${ip}`)
    .digest('base64url')
}

export class UserAuth {
  constructor(config) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(config.cookieSecret)) {
      throw new Error('AUTH_COOKIE_SECRET must be a 32-byte base64url value')
    }
    if (!Number.isInteger(config.cookieDays) || config.cookieDays < 1) {
      throw new Error('COOKIE_DAYS must be a positive integer')
    }
    this.config = config
    this.secret = Buffer.from(config.cookieSecret, 'base64url')
    this.cookieSecure = config.cookieSecure !== false
    this.failures = new Map()
  }

  identify(password) {
    let selected
    for (const user of this.config.users) {
      if (!user.enabled) continue
      const matched = verifyHash(password, user.passwordScrypt)
      if (matched && selected === undefined) selected = user.id
    }
    return selected
  }

  issue(userId, ip, now = Date.now()) {
    const user = this.config.users.find(candidate => candidate.id === userId && candidate.enabled)
    if (user === undefined) throw new Error(`cannot issue a cookie for an unavailable user: ${userId}`)
    const expiresAt = now + this.config.cookieDays * 24 * 60 * 60 * 1000
    const expiresText = String(expiresAt)
    return `${expiresAt}.${cookieSignature(this.secret, user, expiresText, ip)}`
  }

  verify(cookie, ip, now = Date.now()) {
    if (typeof cookie !== 'string') return undefined
    const at = cookie.indexOf('.')
    if (at < 1) return undefined
    const expiresText = cookie.slice(0, at)
    const signature = cookie.slice(at + 1)
    if (!/^\d{13}$/u.test(expiresText) || !/^[A-Za-z0-9_-]{43}$/u.test(signature)) {
      return undefined
    }
    const expiresAt = Number(expiresText)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return undefined
    for (const user of this.config.users) {
      if (!user.enabled) continue
      const expected = cookieSignature(this.secret, user, expiresText, ip)
      if (safeEqual(signature, expected)) return user.id
    }
    return undefined
  }

  cookieHeader(userId, ip, now = Date.now()) {
    const maxAge = this.config.cookieDays * 24 * 60 * 60
    const secure = this.cookieSecure ? '; Secure' : ''
    return `${COOKIE_NAME}=${this.issue(userId, ip, now)}; Max-Age=${maxAge}; Path=/; HttpOnly${secure}; SameSite=Lax`
  }

  clearCookieHeader() {
    const secure = this.cookieSecure ? '; Secure' : ''
    return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly${secure}; SameSite=Lax`
  }

  parseCookie(header) {
    for (const segment of String(header ?? '').split(';')) {
      const at = segment.indexOf('=')
      if (at < 1) continue
      if (segment.slice(0, at).trim() === COOKIE_NAME) {
        return segment.slice(at + 1).trim()
      }
    }
    return undefined
  }

  lockSeconds(ip, now = Date.now()) {
    const state = this.failures.get(ip)
    if (state === undefined) return 0
    if (state.lockedUntil > now) return Math.ceil((state.lockedUntil - now) / 1000)
    if (state.lockedUntil !== 0) this.failures.delete(ip)
    return 0
  }

  recordFailure(ip, now = Date.now()) {
    const state = this.failures.get(ip) ?? { count: 0, lockedUntil: 0 }
    state.count += 1
    if (state.count >= MAX_FAILURES) {
      state.count = 0
      state.lockedUntil = now + LOCK_MS
    }
    this.failures.set(ip, state)
  }

  clearFailures(ip) {
    this.failures.delete(ip)
  }
}
