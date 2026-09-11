import { createHmac } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import {
  currentRequestPrincipal,
  RequestPrincipalService,
  UserId,
  type RequestPrincipal,
} from '../src/principal.ts'
import { HostConnectionService, nodeTrustRequest } from '../src/rpc-host.ts'

const SECRET = 'test-request-principal-secret-0123456789abcdef'

function issue(
  userId: string,
  method = 'POST',
  url = '/api/session.list',
  now = Date.now(),
  secret = SECRET,
): string {
  const payload = {
    v: 1,
    sub: userId,
    iat: now,
    exp: now + 60_000,
    method,
    path: new URL(url, 'http://localhost').pathname + new URL(url, 'http://localhost').search,
  }
  const version = 'v1'
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret)
    .update(`${version}.${encoded}`)
    .digest('base64url')
  return `${version}.${encoded}.${signature}`
}

function request(
  token?: string,
  options: {
    readonly method?: string
    readonly url?: string
    readonly remoteAddress?: string
  } = {},
): Parameters<RequestPrincipalService['resolve']>[0] {
  return {
    method: options.method ?? 'POST',
    url: options.url ?? '/api/session.list',
    headers: {
      host: '127.0.0.1:3080',
      ...token === undefined ? {} : { 'x-dsh-request-principal': token },
    },
    ...options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress },
  }
}

function principal(userId: string, now = Date.now()): RequestPrincipal {
  return {
    userId: UserId(userId),
    issuedAt: now,
    expiresAt: now + 60_000,
  }
}

describe('RequestPrincipalService', () => {
  it('adapts node request facts before principal verification', () => {
    expect(nodeTrustRequest({
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '::ffff:127.0.0.1' },
      method: 'GET',
      url: '/remote/stream?generation=1',
    })).toEqual({
      headers: { host: '127.0.0.1:3080' },
      remoteAddress: '::ffff:127.0.0.1',
      method: 'GET',
      url: '/remote/stream?generation=1',
    })
  })

  it('propagates each verified principal through HTTP RPC and exact Fetch routes', async () => {
    const ctx = new Context()
    const auth = { isAuthenticated: () => true } as unknown as BrowserAuth
    const service = new RequestPrincipalService(ctx, { secret: SECRET })
    const connection = new HostConnectionService(ctx, [], auth, service)
    const rpcUsers: string[] = []
    const fetchUsers: string[] = []
    const disposeRpc = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'session.list',
      async (_endpoint, _payload, _signal, requestPrincipal) => {
        rpcUsers.push(
          requestPrincipal?.userId ?? 'missing',
          currentRequestPrincipal(ctx)?.userId ?? 'missing',
        )
        return { ok: true, value: { userId: requestPrincipal?.userId } }
      },
    )
    const disposeFetch = connection.fetch.register({
      path: '/api/session.export',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (_request, requestPrincipal) => {
        fetchUsers.push(
          requestPrincipal?.userId ?? 'missing',
          currentRequestPrincipal(ctx)?.userId ?? 'missing',
        )
        return Response.json({ userId: requestPrincipal?.userId })
      },
    })
    const shared = connection.createSharedFetchHandler('/api')
    const rpcToken = issue('member-a', 'POST', '/api/session.list')
    const rpcResponse = await shared.fetch(new Request('http://127.0.0.1/api/session.list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-request-principal': rpcToken,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'principal-rpc',
        method: 'session.list',
        payload: {},
      }),
    }))
    expect(rpcResponse.status).toBe(200)
    const rpcBody: unknown = await rpcResponse.json()
    expect(rpcBody).toMatchObject({
      result: { ok: true, value: { userId: 'member-a' } },
    })
    expect(rpcUsers).toEqual(['member-a', 'member-a'])

    const fetchToken = issue('member-b', 'GET', '/api/session.export')
    const fetchResponse = await shared.fetch(new Request('http://127.0.0.1/api/session.export', {
      headers: { 'x-dsh-request-principal': fetchToken },
    }))
    expect(fetchResponse.status).toBe(200)
    expect(await fetchResponse.json()).toEqual({ userId: 'member-b' })
    expect(fetchUsers).toEqual(['member-b', 'member-b'])

    expect((await shared.fetch(new Request('http://127.0.0.1/api/session.export'))).status).toBe(401)
    await disposeRpc()
    await disposeFetch()
  })

  it('verifies method/path-bound principals and rejects every invalid shape', () => {
    const ctx = new Context()
    const service = new RequestPrincipalService(ctx, { secret: SECRET })
    const now = 1_000_000
    const valid = issue('member-a', 'POST', '/api/session.list?limit=10', now)

    expect(service.resolve(request(valid, {
      method: 'POST',
      url: '/api/session.list?limit=10',
    }), now)).toEqual(principal('member-a', now))
    expect(service.resolve(request(), now)).toBeUndefined()
    expect(service.resolve(request('not-a-token'), now)).toBeUndefined()
    expect(service.resolve(request(issue(
      'member-a', 'POST', '/api/session.list?limit=10', now, `${SECRET}-wrong`,
    ), {
      method: 'POST',
      url: '/api/session.list?limit=10',
    }), now)).toBeUndefined()
    expect(service.resolve(request(issue(
      'member-a', 'POST', '/api/session.list', now + 60_001,
    )), now)).toBeUndefined()
    expect(service.resolve(request(issue(
      'member-a', 'GET', '/api/session.list', now,
    )), now)).toBeUndefined()
    expect(service.resolve(request(issue(
      'member-a', 'POST', '/api/session.list?limit=1', now,
    ), {
      method: 'POST',
      url: '/api/session.list?limit=2',
    }), now)).toBeUndefined()
  })

  it('isolates overlapping principals and preserves them across async iterable pulls', async () => {
    const ctx = new Context()
    const service = new RequestPrincipalService(ctx, { secret: SECRET })
    const first = principal('member-a')
    const second = principal('member-b')
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let starts = 0

    const run = (value: RequestPrincipal): Promise<string> => service.run(value, async () => {
      starts += 1
      if (starts === 2) started.resolve(undefined)
      await release.promise
      return currentRequestPrincipal(ctx)?.userId ?? 'missing'
    })
    const both = Promise.all([run(first), run(second)])
    await started.promise
    release.resolve(undefined)
    await expect(both).resolves.toEqual(['member-a', 'member-b'])

    const seen: string[] = []
    const source = (async function* () {
      await Promise.resolve()
      yield currentRequestPrincipal(ctx)?.userId
    })()
    for await (const userId of service.bindIterable(first, source)) seen.push(userId ?? 'missing')
    expect(seen).toEqual(['member-a'])
    expect(service.current()).toBeUndefined()
  })

  it('rejects required requests outside loopback and leaves local-only mode open', () => {
    const ctx = new Context()
    const auth = { isAuthenticated: () => true } as unknown as BrowserAuth
    const connection = new HostConnectionService(
      ctx,
      [],
      auth,
      new RequestPrincipalService(ctx, { secret: SECRET }),
    )
    const valid = issue('member-a')

    expect(connection.requestRejection(request(undefined, {
      remoteAddress: '127.0.0.1',
    }))).toBe(401)
    expect(connection.requestRejection(request(valid, {
      remoteAddress: '10.0.0.8',
    }))).toBe(403)
    expect(connection.requestRejection(request(valid, {
      remoteAddress: '127.0.0.1',
    }))).toBeUndefined()

    const localCtx = new Context()
    const local = new HostConnectionService(
      localCtx,
      [],
      auth,
      new RequestPrincipalService(localCtx),
    )
    expect(local.requestRejection(request(undefined, {
      remoteAddress: '10.0.0.8',
    }))).toBeUndefined()
  })
})
