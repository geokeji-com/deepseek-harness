import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, {
  AgentPoolCapacityError,
  type Agent,
  type AgentFactory,
  type AgentHandle,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function agent(id: string, status: Agent['status'] = 'idle'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session: Session.create(SessionId(id)),
    inbox: { nextTurn: [], nextStep: [] } as unknown as Agent['inbox'],
    status,
    ctx: new Context(),
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

interface PoolFixture {
  readonly ctx: Context
  readonly disposed: string[]
  readonly resumed: string[]
}

async function poolFixture(): Promise<PoolFixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  const disposed: string[] = []
  const resumed: string[] = []
  const makeHandle = (created: Agent, parentAgent?: Agent): AgentHandle => {
    const detach = ctx.agents.enter(created, parentAgent)
    ctx.agents.announce(created)
    return {
      agent: created,
      dispose: async () => {
        detach()
        disposed.push(String(created.id))
      },
    }
  }
  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options: CreateAgentOptions) {
      return makeHandle(agent(String(options.sessionId)), options.parentAgent)
    },
    async resume(_ownerCtx, options: ResumeAgentOptions) {
      resumed.push(String(options.resumeSessionId))
      return makeHandle(agent(String(options.resumeSessionId)), options.parentAgent)
    },
  }
  ctx.agents.setFactory(factory)
  return { ctx, disposed, resumed }
}

async function createTopLevel(fixture: PoolFixture, id: string): Promise<AgentHandle> {
  return fixture.ctx.agents.create({ sessionId: SessionId(id) })
}

describe('shared Agent pool', () => {
  it('caps resident Agents at 64 while reserving eight slots for emergency children', async () => {
    const fixture = await poolFixture()
    const topLevel: AgentHandle[] = []
    for (let index = 0; index < 56; index += 1) {
      topLevel.push(await createTopLevel(fixture, `top-${String(index)}`))
    }
    for (const handle of topLevel) {
      ;(handle.agent as { status: Agent['status'] }).status = 'running'
    }
    expect(topLevel.every(handle => handle.agent.status === 'running')).toBe(true)
    expect(fixture.ctx.agents.poolMetrics().resident).toBe(56)

    await expect(createTopLevel(fixture, 'top-overflow')).rejects.toBeInstanceOf(AgentPoolCapacityError)
    const children: AgentHandle[] = []
    for (let index = 0; index < 8; index += 1) {
      children.push(await fixture.ctx.agents.create({
        sessionId: SessionId(`child-${String(index)}`),
        parentAgent: topLevel[0]!.agent,
      }))
    }
    await expect(fixture.ctx.agents.create({
      sessionId: SessionId('child-overflow'),
      parentAgent: topLevel[0]!.agent,
    })).rejects.toBeInstanceOf(AgentPoolCapacityError)

    expect(fixture.ctx.agents.poolMetrics().resident).toBe(64)
  })

  it('evicts idle top-level Agents in LRU order after thirty minutes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const fixture = await poolFixture()
    await createTopLevel(fixture, 'oldest')
    vi.setSystemTime(1_001_000)
    await createTopLevel(fixture, 'newer')

    vi.setSystemTime(1_000_000 + 30 * 60_000 + 61_000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(fixture.disposed).toEqual(['oldest', 'newer'])
    expect(fixture.ctx.agents.poolMetrics()).toMatchObject({
      resident: 0,
      evicted: 2,
    })
  })

  it('never evicts running, queued, or child-owning top-level entries', async () => {
    const fixture = await poolFixture()
    const topLevel: AgentHandle[] = []
    for (let index = 0; index < 56; index += 1) {
      topLevel.push(await createTopLevel(fixture, `top-${String(index)}`))
    }
    const running = topLevel[0]!
    const queued = topLevel[1]!
    const parent = topLevel[2]!
    ;(running.agent as { status: Agent['status'] }).status = 'running'
    ;(queued.agent.inbox as unknown as { nextTurn: unknown[] }).nextTurn = [{ id: 'queued' }]
    await fixture.ctx.agents.create({
      sessionId: SessionId('protected-child'),
      parentAgent: parent.agent,
    })

    const replacement = await createTopLevel(fixture, 'replacement')

    expect(fixture.ctx.agents.poolMetrics().resident).toBe(57)
    expect(fixture.disposed).toHaveLength(1)
    expect(fixture.disposed[0]).not.toBe(String(running.agent.id))
    expect(fixture.disposed[0]).not.toBe(String(queued.agent.id))
    expect(fixture.disposed[0]).not.toBe(String(parent.agent.id))
    expect(replacement.agent.id).toBe(SessionId('replacement'))
  })

  it('cold-resumes a disposed handle through the shared pool', async () => {
    const fixture = await poolFixture()
    const handle = await createTopLevel(fixture, 'cold-resume')

    await handle.dispose()
    expect(fixture.ctx.agents.poolMetrics().resident).toBe(0)

    const resumed = await fixture.ctx.agents.resume({
      resumeSessionId: SessionId('cold-resume'),
    })
    expect(fixture.resumed).toEqual(['cold-resume'])
    expect(fixture.ctx.agents.poolMetrics().resident).toBe(1)
    await resumed.dispose()
  })
})
