import { createHmac } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  HostConnectionService,
  RequestPrincipalService,
} from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  Config,
  SESSION_LOG_FILENAME,
  SESSION_LOG_EXPORT_PATH,
  apply,
  inject,
} from '../src/index.ts'

const sid = (value: string): SessionId => value as SessionId
const SECRET = 'session-export-principal-secret-0123456789abcdef'

function principalToken(userId: string, url: string): string {
  const now = Date.now()
  const encoded = Buffer.from(JSON.stringify({
    v: 1,
    sub: userId,
    iat: now,
    exp: now + 60_000,
    method: 'GET',
    path: new URL(url, 'http://localhost').pathname + new URL(url, 'http://localhost').search,
  }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', SECRET)
    .update(`v1.${encoded}`)
    .digest('base64url')
  return `v1.${encoded}.${signature}`
}

function readHandle(id: string, ownerUserId?: string): SessionHandle {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt: 1,
    isSeeded: false,
    cwd: '/workspace',
    delegationDepth: 0,
    ...(ownerUserId === undefined ? {} : { ownerUserId }),
  }
  return {
    id: header.id,
    header,
    access: 'read',
    read: async () => ({ eventState: 'detached', events: [] }),
    close: async () => {},
  } as unknown as SessionHandle
}

async function mounted(
  withServices: boolean,
  options: { readonly ownerUserId?: string } = {},
): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  if (withServices) {
    ctx.provide('sessionQuery', {
      traceSession: async () => ({ descendants: [] }),
    } as never)
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => ({
        header: readHandle(String(id), options.ownerUserId).header,
      }),
      open: async (id: SessionId) => readHandle(String(id), options.ownerUserId),
    } as never)
    ctx.provide('attachments', {
      readImage: async () => { throw new Error('fixture has no images') },
    } as never)
  }
  const principal = options.ownerUserId === undefined
    ? undefined
    : new RequestPrincipalService(ctx, { secret: SECRET })
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth, principal)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return { connection, dispose: () => fiber.dispose() }
}

describe('Session log export Fetch route', () => {
  it('registers one GET/HEAD route and removes it with the plugin fiber', async () => {
    const { connection, dispose } = await mounted(true)
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(strFromU8(files[SESSION_LOG_FILENAME] as Uint8Array)).toContain('"id":"session-1"')

    const head = await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`, { method: 'HEAD' },
    ))
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()

    await dispose()
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))).status).toBe(404)
  })

  it('validates the query before reporting missing export services', async () => {
    const { connection, dispose } = await mounted(false)
    const shared = connection.createSharedFetchHandler('/api')
    expect((await shared.fetch(new Request(`http://host${SESSION_LOG_EXPORT_PATH}`))).status).toBe(400)
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1&includeDescendants=1`,
    ))).status).toBe(400)
    expect((await shared.fetch(new Request(
      `http://host${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`,
    ))).status).toBe(500)
    await dispose()
  })

  it('hides a stored Session from a different required principal', async () => {
    const { connection, dispose } = await mounted(true, { ownerUserId: 'member-a' })
    const shared = connection.createSharedFetchHandler('/api')
    const url = `${SESSION_LOG_EXPORT_PATH}?sessionId=session-1`
    const owned = principalToken('member-a', url)
    const foreign = principalToken('member-b', url)

    const allowed = await shared.fetch(new Request(`http://host${url}`, {
      headers: { 'x-dsh-request-principal': owned },
    }))
    expect(allowed.status).toBe(200)

    const hidden = await shared.fetch(new Request(`http://host${url}`, {
      headers: { 'x-dsh-request-principal': foreign },
    }))
    expect(hidden.status).toBe(404)

    await dispose()
  })

  it('validates the compression level', () => {
    expect(Config({})).toEqual({ compressionLevel: 6 })
    expect(Config({ compressionLevel: 0 })).toEqual({ compressionLevel: 0 })
    expect(Config({ compressionLevel: 9 })).toEqual({ compressionLevel: 9 })
    for (const compressionLevel of [-1, 10, 1.5]) {
      expect(() => Config({ compressionLevel } as never)).toThrow()
    }
  })
})
