import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { RequestPrincipalService, toUserId, type RequestPrincipal } from '@deepseek-ai/dsh-client-connection'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionQueryEngine, {
  type SessionSearchHit,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { describe, expect, it, vi } from 'vitest'
import {
  createSessionTestRemote,
  installSessionReadTestServices,
  testSessionPersistence,
} from './test-remote.ts'

const MEMBERS = 50
const CHILDREN = 8
const SECRET = 'multiuser-load-isolation-secret-0123456789'
const RSS_LIMIT = 3.5 * 1024 * 1024 * 1024
const COLD_RESUME_P95_LIMIT_MS = 3_000

const sid = (value: string): SessionId => value as SessionId
const userId = (index: number): string => `member-${String(index).padStart(2, '0')}`
const parentSessionId = (index: number): SessionId => sid(`load-parent-${String(index)}`)
const childSessionId = (index: number): SessionId => sid(`load-child-${String(index)}`)

function principal(index: number): RequestPrincipal {
  return {
    userId: toUserId(userId(index)),
    issuedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  }
}

class LoadSearchQuery extends SessionQueryEngine {
  override searchSessions(
    request: SessionSearchRequest,
  ): ReturnType<SessionQueryEngine['searchSessions']> {
    const items: SessionSearchHit[] = this.ctx.sessions.list()
      .filter(session => request.query.includes(session.header.ownerUserId ?? ''))
      .map((session, index) => ({
        header: session.header,
        live: true,
        persisted: false,
        bestMatch: {
          sessionId: session.id,
          seq: SessionSeq(0),
          type: 'user/message',
          time: 1_000 + index,
          surface: 'current',
          snippet: `load match ${session.header.ownerUserId ?? 'missing'}`,
        },
      }))
    return Promise.resolve({ items })
  }

  override searchEvents(): ReturnType<SessionQueryEngine['searchEvents']> {
    return Promise.reject(new Error('event search is not configured in the load fixture'))
  }
}

function agent(ctx: Context, session: ReturnType<Context['sessions']['create']>): Agent {
  const nextTurn: UserMessage[] = []
  const nextStep: UserMessage[] = []
  const target = (value: 'next-turn' | 'next-step'): UserMessage[] =>
    value === 'next-turn' ? nextTurn : nextStep
  const inbox: Agent['inbox'] = {
    get nextTurn() { return nextTurn },
    get nextStep() { return nextStep },
    clear() {
      nextStep.length = 0
      nextTurn.length = 0
    },
    append(value, message) { target(value).push(message) },
    prepend(value, message) { target(value).unshift(message) },
    replace(messageId, newMessage) {
      for (const list of [nextStep, nextTurn]) {
        const index = list.findIndex(message => message.id === messageId)
        if (index === -1) continue
        list[index] = newMessage
        return true
      }
      return false
    },
    remove(messageId) {
      for (const list of [nextStep, nextTurn]) {
        const index = list.findIndex(message => message.id === messageId)
        if (index === -1) continue
        list.splice(index, 1)
        return true
      }
      return false
    },
    splice(value, start, deleteCount, inserted) {
      return target(value).splice(start, deleteCount, ...inserted)
    },
  }
  return {
    id: session.id,
    options: { provider: 'fixture', model: 'fixture-model' },
    session,
    inbox,
    status: 'idle',
    ctx,
    send: vi.fn(),
    followup: (message) => { target('next-turn').push(message) },
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
  readonly pids: Set<number>
}> {
  const ctx = new Context()
  const pids = new Set<number>()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 5,
    fallbackMaxBytes: 40,
    maxTitleBytes: 40,
  })
  new LoadSearchQuery(ctx)
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

  const publish = (created: Agent, parentAgent?: Agent): AgentHandle => {
    pids.add(process.pid)
    const detach = ctx.agents.enter(created, parentAgent)
    ctx.agents.announce(created)
    return {
      agent: created,
      dispose: async () => { detach() },
    }
  }

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
      return publish(created, options.parentAgent)
    },
    resume: async (ownerCtx, options: ResumeAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.get(options.resumeSessionId)
      if (session === undefined) throw new Error(`missing Session ${options.resumeSessionId}`)
      return publish(agent(ownerCtx, session))
    },
  })

  const principals = new RequestPrincipalService(ctx, { secret: SECRET })
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: '/workspace',
  })
  return { ctx, principals, remote, pids }
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

describe('shared Harness multi-user load', () => {
  it('serves 50 isolated users through list, search, prompt, follow, subagents, and cold resume', async () => {
    const { ctx, principals, remote, pids } = await harness()
    const members = Array.from({ length: MEMBERS }, (_, index) => principal(index))
    const rssBefore = process.memoryUsage().rss

    const parents = await Promise.all(Array.from({ length: MEMBERS }, (_, index) => ctx.agents.create({
      sessionId: parentSessionId(index),
      meta: {
        cwd: '/workspace',
        ownerUserId: userId(index),
      },
    })))
    for (const [index, handle] of parents.entries()) {
      handle.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `load request ${String(index)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }

    const children: AgentHandle[] = []
    for (let index = 0; index < CHILDREN; index += 1) {
      children.push(await ctx.agents.create({
        sessionId: childSessionId(index),
        parentAgent: parents[index]!.agent,
        meta: {
          cwd: '/workspace',
          ownerUserId: userId(index),
        },
      }))
    }
    expect(ctx.agents.poolMetrics().resident).toBe(MEMBERS + CHILDREN)
    expect(ctx.agents.poolMetrics().resident).toBeLessThanOrEqual(64)

    const listResults = await Promise.all(
      members.map(member => principals.run(member, () => remote.list({}))),
    )
    for (const [index, result] of listResults.entries()) {
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.message)
      const visible = new Set(result.value.items.map(item => item.sessionId))
      expect(visible).toContain(parentSessionId(index))
      if (index < CHILDREN) expect(visible).toContain(childSessionId(index))
      else expect(visible.size).toBe(1)
    }

    const searchResults = await Promise.all(members.map(member => principals.run(
      member,
      () => remote.search(
        { query: `load match ${String(member.userId)}` },
        new AbortController().signal,
      ),
    )))
    for (const [index, result] of searchResults.entries()) {
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.message)
      expect(result.value.items.map(item => item.sessionId)).toContain(parentSessionId(index))
      expect(result.value.items).toHaveLength(index < CHILDREN ? 2 : 1)
      expect(result.value.items.every(item => item.snippet.includes(userId(index)))).toBe(true)
    }

    const promptResults = await Promise.all(members.map((member, index) => principals.run(
      member,
      () => remote.prompt({
        sessionId: parentSessionId(index),
        requestId: `load-prompt-${String(index)}` as never,
        content: [{ type: 'text', text: `prompt ${String(index)}` }],
        mode: 'queue',
      }),
    )))
    expect(promptResults.every(result => result.ok)).toBe(true)

    for (let index = 0; index < MEMBERS; index += 1) {
      const item = ctx.agents.get(parentSessionId(index))?.inbox.nextTurn.at(-1)
      if (item === undefined) throw new Error(`prompt ${String(index)} did not queue`)
      await expect(principals.run(
        members[(index + 1) % MEMBERS]!,
        () => remote.updateQueue({
          sessionId: parentSessionId(index),
          itemId: item.id,
          action: { kind: 'remove' },
        }),
      )).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })
      const removed = await principals.run(members[index]!, () => remote.updateQueue({
        sessionId: parentSessionId(index),
        itemId: item.id,
        action: { kind: 'remove' },
      }))
      if (!removed.ok) throw new Error(removed.error.message)
      expect(removed.ok).toBe(true)
    }

    for (let index = 0; index < 5; index += 1) {
      const address = { kind: 'session' as const, sessionId: parentSessionId(index) }
      const abort = new AbortController()
      const follow = principals.bindIterable(
        members[index]!,
        remote.follow({ address }, abort.signal),
      )[Symbol.asyncIterator]()
      const opening = await follow.next()
      expect(opening).toMatchObject({
        done: false,
        value: { type: 'snapshot' },
      })
      if (opening.done) throw new Error('owner follow ended before its snapshot')
      const cursor = 'cursor' in opening.value ? opening.value.cursor : undefined
      if (typeof cursor !== 'number') throw new Error('owner follow omitted its cursor')
      await follow.return(undefined)
      abort.abort()

      await expect(principals.run(members[index]!, () => remote.page({
        address,
        throughSeq: cursor,
      }))).resolves.toMatchObject({ ok: true })

      const foreignAddress = { kind: 'session' as const, sessionId: parentSessionId(index) }
      await expect(principals.run(members[(index + 1) % MEMBERS]!, () => remote.page({
        address: foreignAddress,
        throughSeq: cursor,
      }))).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })

      const foreignFollow = principals.bindIterable(
        members[(index + 1) % MEMBERS]!,
        remote.follow({ address: foreignAddress }, new AbortController().signal),
      )[Symbol.asyncIterator]()
      await expect(foreignFollow.next()).rejects.toMatchObject({ code: 'session/not-found' })

      await expect(principals.run(
        members[(index + 1) % MEMBERS]!,
        () => remote.prompt({
          sessionId: parentSessionId(index),
          requestId: `foreign-load-prompt-${String(index)}` as never,
          content: [{ type: 'text', text: 'foreign prompt' }],
          mode: 'queue',
        }),
      )).resolves.toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    }

    const rssAfterLoad = process.memoryUsage().rss
    expect(rssAfterLoad).toBeLessThan(RSS_LIMIT)

    for (const child of children) await child.dispose()
    for (const parent of parents) await parent.dispose()
    expect(ctx.agents.poolMetrics()).toMatchObject({ resident: 0, running: 0 })
    const rssAfterEviction = process.memoryUsage().rss
    expect(rssAfterEviction).toBeLessThan(RSS_LIMIT)

    const resumeLatencies: number[] = []
    const resumed = await Promise.all(members.map(async (_, index) => {
      const started = performance.now()
      const handle = await ctx.agents.resume({ resumeSessionId: parentSessionId(index) })
      resumeLatencies.push(performance.now() - started)
      return handle
    }))
    expect(p95(resumeLatencies)).toBeLessThan(COLD_RESUME_P95_LIMIT_MS)
    expect(ctx.agents.poolMetrics().resident).toBe(MEMBERS)
    for (const handle of resumed) {
      expect(handle.agent.session.header.ownerUserId).toBe(userId(resumed.indexOf(handle)))
      await handle.dispose()
    }

    expect(ctx.agents.poolMetrics()).toMatchObject({ resident: 0, running: 0 })
    expect(pids).toEqual(new Set([process.pid]))
    const rssAfterCycles = process.memoryUsage().rss
    expect(rssAfterCycles).toBeLessThan(RSS_LIMIT)
    expect(rssAfterCycles).toBeLessThan(rssBefore + 1024 * 1024 * 1024)
    await ctx.fiber.dispose()
  }, 30_000)
})
