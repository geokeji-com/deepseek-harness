import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { RequestPrincipalService, toUserId, type RequestPrincipal } from '@deepseek-ai/dsh-client-connection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestRemote, installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const SECRET = 'session-owner-isolation-secret-0123456789'

function principal(userId: string): RequestPrincipal {
  return {
    userId: toUserId(userId),
    issuedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  }
}

function agent(ctx: Context, session: ReturnType<Context['sessions']['create']>): Agent {
  return {
    id: session.id,
    options: { provider: 'fixture', model: 'fixture-model' },
    session,
    inbox: createInboxStub(),
    status: 'idle',
    ctx,
    send: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(() => Promise.resolve()),
    inject: vi.fn(),
    cancel: vi.fn(),
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function harness(): Promise<{
  readonly ctx: Context
  readonly principals: RequestPrincipalService
  readonly remote: ReturnType<typeof createSessionTestRemote>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 5,
    fallbackMaxBytes: 40,
    maxTitleBytes: 40,
  })
  installSessionReadTestServices(ctx)
  ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [],
  } as never)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([]),
  }) as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
    resolveCallConfig: (config: unknown) => Promise.resolve(config),
    resolveModelInfo: () => Promise.resolve({ inputModalities: ['text', 'image'] }),
  } as never)

  ctx.agents.setFactory({
    createAgent: async (ownerCtx, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.inheritedEventCount === undefined
          ? {}
          : { inheritedEventCount: options.inheritedEventCount },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const created = agent(ownerCtx, session)
      await options.setup?.(ownerCtx, created)
      const detach = ctx.agents.enter(created, options.parentAgent)
      ctx.agents.announce(created)
      return {
        agent: created,
        dispose: async () => { detach() },
      }
    },
    resume: (_ownerCtx, _options: ResumeAgentOptions) => {
      return Promise.reject(new Error('resume is not configured for this test'))
    },
  })

  const principals = new RequestPrincipalService(ctx, { secret: SECRET })
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: '/workspace',
  })
  return { ctx, principals, remote }
}

describe('Session owner isolation', () => {
  it('stamps creates with the caller and hides another owner from every Session API', async () => {
    const { ctx, principals, remote } = await harness()
    const memberA = principal('member-a')
    const memberB = principal('member-b')
    const createdA = await principals.run(memberA, () => remote.create({
      sessionId: SessionId('owned-a'),
      cwd: '/tmp',
    }))
    const createdB = await principals.run(memberB, () => remote.create({
      sessionId: SessionId('owned-b'),
      cwd: '/tmp',
    }))
    if (!createdA.ok) throw new Error(`owner create failed: ${createdA.error.message}`)
    if (!createdB.ok) throw new Error(`foreign create failed: ${createdB.error.message}`)
    expect(ctx.sessions.get(SessionId('owned-a'))?.header.ownerUserId).toBe('member-a')
    expect(ctx.sessions.get(SessionId('owned-b'))?.header.ownerUserId).toBe('member-b')

    const sessionA = ctx.sessions.get(SessionId('owned-a'))
    const liveA = ctx.agents.get(SessionId('owned-a'))
    if (sessionA === undefined || liveA === undefined) throw new Error('owned-a did not publish')
    sessionA.append('turn/start', { turn: 1 })
    sessionA.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'owned work' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    sessionA.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const queued = createUserMessage({
      content: [{ type: 'text', text: 'queued by owner' }],
      source: { kind: 'user' },
    })
    liveA.inbox.append('next-turn', queued)

    await expect(principals.run(memberB, () => remote.rename({
      sessionId: sessionA.id,
      title: 'stolen',
    }))).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    await expect(principals.run(memberB, () => remote.selectModel({
      sessionId: sessionA.id,
      provider: 'fixture',
      model: 'fixture-model',
    }))).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    await expect(principals.run(memberB, () => remote.cancel({
      sessionId: sessionA.id,
    }))).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    await expect(principals.run(memberB, () => remote.prompt({
      sessionId: sessionA.id,
      requestId: 'foreign-prompt' as never,
      content: [{ type: 'text', text: 'stolen' }],
      mode: 'queue',
    }))).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    await expect(principals.run(memberB, () => remote.updateQueue({
      sessionId: sessionA.id,
      itemId: queued.id,
      action: { kind: 'remove' },
    }))).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    await expect(principals.run(memberB, () => remote.attachment({
      sessionId: sessionA.id,
      attachmentId: 'missing' as never,
    }))).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    await expect(principals.run(memberB, () => remote.fork({
      sessionId: sessionA.id,
    }))).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })

    await expect(principals.run(memberA, () => remote.rename({
      sessionId: sessionA.id,
      title: 'owner title',
    }))).resolves.toMatchObject({ ok: true, value: { title: 'owner title' } })
    const forked = await principals.run(memberA, () => remote.fork({
      sessionId: sessionA.id,
    }))
    expect(forked.ok).toBe(true)
    if (!forked.ok) throw new Error('owner fork failed')
    expect(ctx.sessions.get(forked.value.sessionId)?.header.ownerUserId).toBe('member-a')

    await ctx.fiber.dispose()
  })
})
