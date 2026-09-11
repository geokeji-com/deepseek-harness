import { createHmac, timingSafeEqual } from 'node:crypto'

export const REQUEST_PRINCIPAL_HEADER = 'x-dsh-request-principal'
export const INTERNAL_IDENTITY_HEADERS = Object.freeze([
  REQUEST_PRINCIPAL_HEADER,
  'x-dsh-external-user',
  'x-dsh-user-id',
  'x-dsh-authenticated-user',
  'x-dsh-principal',
])

function requestPath(url) {
  const parsed = new URL(url, 'http://localhost')
  return `${parsed.pathname}${parsed.search}`
}

function safeEqual(left, right) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** Issue and verify the short-lived principal consumed by one shared Harness. */
export class RequestPrincipalIssuer {
  /**
   * @param secret minimum 32-character HMAC secret shared only by proxy and Harness.
   * @param ttlMs accepted token lifetime.
   */
  constructor(secret, ttlMs = 60_000) {
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new Error('request principal secret must contain at least 32 characters')
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('request principal ttl must be a positive safe integer')
    }
    this.secret = Buffer.from(secret, 'utf8')
    this.ttlMs = ttlMs
  }

  /**
   * Mint one method/path-bound proxy principal.
   * @param userId authenticated external user.
   * @param method HTTP method.
   * @param url request target, including any query string.
   * @param now issuance instant.
   * @returns compact signed principal token.
   */
  issue(userId, method, url, now = Date.now()) {
    const payload = {
      v: 1,
      sub: userId,
      iat: now,
      exp: now + this.ttlMs,
      method: String(method).toUpperCase(),
      path: requestPath(url),
    }
    const version = 'v1'
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signature = createHmac('sha256', this.secret)
      .update(`${version}.${encoded}`)
      .digest('base64url')
    return `${version}.${encoded}.${signature}`
  }

  /**
   * Verify one token for tests and diagnostics. The Harness owns production verification.
   * @param token compact principal token.
   * @param method expected method.
   * @param url expected request target.
   * @param now validation instant.
   * @returns decoded payload, or undefined when invalid.
   */
  verify(token, method, url, now = Date.now()) {
    if (typeof token !== 'string') return undefined
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') return undefined
    const [version, encoded, signature] = parts
    const expected = createHmac('sha256', this.secret)
      .update(`${version}.${encoded}`)
      .digest()
    let received
    try {
      received = Buffer.from(signature, 'base64url')
    } catch {
      return undefined
    }
    if (!safeEqual(received, expected)) return undefined
    let payload
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      return undefined
    }
    if (payload?.v !== 1 || typeof payload.sub !== 'string' || payload.sub.length === 0
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.exp <= now || payload.iat > now || payload.exp <= payload.iat) {
      return undefined
    }
    if (payload.method !== String(method).toUpperCase() || payload.path !== requestPath(url)) {
      return undefined
    }
    return payload
  }
}

/**
 * Remove every client-controlled identity header before applying the trusted one.
 * @param headers mutable outgoing header map.
 */
export function stripInternalIdentityHeaders(headers) {
  for (const name of INTERNAL_IDENTITY_HEADERS) delete headers[name]
}
