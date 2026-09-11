/** Trusted user identity propagated by the deployment's authenticated proxy. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionTrustRequest, RequestPrincipal, UserId } from './rpc.ts'

export type { RequestPrincipal } from './rpc.ts'

/**
 * Brand one validated proxy user id.
 * @param id - non-empty user identity.
 * @returns branded user identity.
 */
export function UserId(id: string): UserId {
  if (id.length === 0) throw new TypeError('UserId must be non-empty')
  return brandString<UserId>(id)
}

/**
 * Read the verified principal from the current async request context.
 * @param ctx - context carrying the optional request-principal service.
 * @returns verified identity, or undefined for legacy local-only deployments.
 */
export function currentRequestPrincipal(ctx: Context): RequestPrincipal | undefined {
  const service = ctx.get('requestPrincipal')
  if (service === undefined) return undefined
  return service.required ? service.require() : service.current()
}

/**
 * Test whether a principal may access one owner-scoped record.
 * @param principal - verified request identity, or undefined in local-only mode.
 * @param ownerUserId - durable owner stored on the record.
 * @returns whether the record is visible to the caller.
 */
export function requestPrincipalOwns(
  principal: RequestPrincipal | undefined,
  ownerUserId: string | undefined,
): boolean {
  if (principal === undefined) return true
  return ownerUserId !== undefined && ownerUserId === principal.userId
}

/** Connection configuration for the proxy-signed request principal. */
export interface RequestPrincipalConfig {
  /** Shared HMAC key. Empty disables the principal requirement for local-only use. */
  readonly secret?: string
  /** Maximum accepted token age. Default: 60000 milliseconds. */
  readonly maxAgeMs?: number
}

interface PrincipalPayload {
  readonly v: 1
  readonly sub: string
  readonly iat: number
  readonly exp: number
  readonly method?: string
  readonly path?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Request-scoped identity propagated after the trusted transport boundary. */
    requestPrincipal: RequestPrincipalService
  }
}

const HEADER = 'x-dsh-request-principal'
const MAX_FUTURE_SKEW_MS = 5_000

/** Verify signed proxies and expose the verified principal to one async request chain. */
export class RequestPrincipalService extends Service {
  private readonly secret: Buffer | undefined
  private readonly maxAgeMs: number
  private readonly storage = new AsyncLocalStorage<RequestPrincipal>()

  /**
   * @param ctx - owning Connection context.
   * @param config - signing secret and freshness policy.
   */
  constructor(ctx: Context, config: RequestPrincipalConfig = {}) {
    super(ctx, 'requestPrincipal')
    const secret = config.secret ?? ''
    if (secret.length > 0 && secret.length < 32) {
      throw new Error('request principal secret must contain at least 32 characters')
    }
    const maxAgeMs = config.maxAgeMs ?? 60_000
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
      throw new Error('request principal maxAgeMs must be a positive safe integer')
    }
    this.secret = secret.length === 0 ? undefined : Buffer.from(secret, 'utf8')
    this.maxAgeMs = maxAgeMs
  }

  /** Whether this deployment rejects requests without a valid principal. */
  get required(): boolean {
    return this.secret !== undefined
  }

  /** Return the current verified principal, if this async chain has one. */
  current(): RequestPrincipal | undefined {
    return this.storage.getStore()
  }

  /** Require one principal inside a protected downstream operation. */
  require(): RequestPrincipal {
    const principal = this.current()
    if (principal === undefined) throw new Error('request principal is unavailable')
    return principal
  }

  /**
   * Run one callback in the verified principal's async context.
   * @param principal - verified request identity.
   * @param callback - synchronous or promise-returning operation.
   * @returns the callback result.
   */
  run<T>(principal: RequestPrincipal, callback: () => T): T {
    return this.storage.run(principal, callback)
  }

  /**
   * Bind one async iterable to a principal across every iterator call.
   * @param principal - verified request identity.
   * @param source - downstream Remote stream.
   * @returns a generator that installs the same async context for every pull.
   */
  async *bindIterable<T>(
    principal: RequestPrincipal,
    source: AsyncIterable<T>,
  ): AsyncGenerator<T> {
    const iterator = source[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await this.run(principal, () => iterator.next())
        if (next.done === true) return
        yield next.value
      }
    } finally {
      if (iterator.return !== undefined) {
        await this.run(principal, () => iterator.return?.())
      }
    }
  }

  /**
   * Verify one request header when configured.
   * @param request - HTTP request headers and optional peer address.
   * @param now - validation instant for deterministic tests.
   * @returns verified principal, or undefined when absent or invalid.
   */
  resolve(request: ConnectionTrustRequest, now = Date.now()): RequestPrincipal | undefined {
    const token = header(request.headers, HEADER)
    if (token === undefined || this.secret === undefined) return undefined
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') return undefined
    const [version, encoded, signature] = parts
    const expected = createHmac('sha256', this.secret)
      .update(`${version}.${encoded}`)
      .digest()
    let received: Buffer
    try {
      received = Buffer.from(signature as string, 'base64url')
    } catch {
      return undefined
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(encoded as string, 'base64url').toString('utf8'))
    } catch {
      return undefined
    }
    const payload = principalPayload(value)
    if (payload === undefined
      || payload.exp <= payload.iat || payload.exp <= now
      || payload.iat > now + MAX_FUTURE_SKEW_MS
      || now - payload.iat > this.maxAgeMs) {
      return undefined
    }
    if (payload.method !== undefined && payload.method !== request.method) return undefined
    if (payload.path !== undefined && payload.path !== requestPath(request.url)) return undefined
    return {
      userId: UserId(payload.sub),
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    }
  }
}

function requestPath(url: string | undefined): string | undefined {
  if (url === undefined || url.length === 0) return undefined
  try {
    const parsed = new URL(url, 'http://localhost')
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return undefined
  }
}

function principalPayload(value: unknown): PrincipalPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const payload = value as Record<string, unknown>
  if (payload.v !== 1
    || typeof payload.sub !== 'string' || payload.sub.length === 0
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || (payload.method !== undefined && typeof payload.method !== 'string')
    || (payload.path !== undefined && typeof payload.path !== 'string')) {
    return undefined
  }
  return {
    v: 1,
    sub: payload.sub,
    iat: payload.iat as number,
    exp: payload.exp as number,
    ...(payload.method === undefined ? {} : { method: payload.method }),
    ...(payload.path === undefined ? {} : { path: payload.path }),
  }
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const record: Readonly<Record<string, string | readonly string[] | undefined>> = headers
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (key.toLowerCase() !== name) continue
    if (typeof value === 'string') return value
    if (value !== undefined) {
      const first = value[0]
      if (typeof first === 'string') return first
    }
  }
  return undefined
}
