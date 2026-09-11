/**
 * Agent service: live registry, factory delegation, and process-local
 * initiator scope. Concrete creation and driving belong to the loop.
 *
 * @module @deepseek-ai/dsh-agent
 */

import { Context, FiberState, getTraceable, Service, symbols } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isPromise } from 'node:util/types'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Agent } from './types.ts'
import type { AgentOptions } from './runtime-types.ts'

export * from './runtime-types.ts'
export * from './types.ts'
export type * from './projection.ts'
export * from './consumed-work.ts'
export * from './model-selection.ts'
export { agentCarrier, agentEvents, assembleContextFor, emitAgentEvent } from './dispatch.ts'
export type { AgentEventDispatch, AgentSubjectEvent } from './dispatch.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
  }
}

/**
 * Synchronous finalizer returned by unpublished Agent setup when its
 * contributions need validation at the exact publication commit point.
 */
export interface AgentSetupCommit {
  /**
   * Validate and commit the prepared setup immediately before publication.
   * @throws when publication must roll the unpublished Agent back.
   */
  commit(): void
}

/**
 * Compose an unpublished Agent scope and optionally return its publication commit.
 * @param agentCtx - unpublished Agent scope.
 * @param agent - unpublished Agent being composed.
 * @returns an optional synchronous commit invoked after setup awaits settle and immediately before publication.
 */
export type AgentSetup = (
  agentCtx: Context,
  agent: Agent,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void

/**
 * Options for programmatically creating an agent through the registry factory
 * ({@link AgentRegistry.create}). The caller supplies the single live
 * `sessionId` shared by the agent registry and session log (e.g. an
 * ACP-generated id), plus optional session metadata (the validated `cwd`, fork
 * lineage); the factory creates the session and agent under that identity.
 */
export interface CreateAgentOptions {
  /** The live agent/session identity. */
  readonly sessionId: SessionId
  /** Live parent Agent for runtime ownership; omit for a root Agent. */
  readonly parentAgent?: Agent
  /**
   * Session creation metadata: validated absolute `cwd`, `parentSession`
   * fork lineage, the `isSeeded` fork marker, the coarse `origin`
   * classification, and the `delegationDepth` recursion budget. Mirrors the
   * `cwd`/`parentSession`/`isSeeded`/`origin`/`delegationDepth` fields of
   * {@link CreateSessionOptions.meta} in dsh-session (the internal-only
   * `createdAt`, used when reconstructing a persisted session, is deliberately
   * excluded — a factory caller never sets it). This is durable session data,
   * so the session boundary validates and snapshots it before asynchronous
   * setup begins.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
    readonly ownerUserId?: string
  }
  /** Exact fork-inherited prefix length when the session metadata sets `isSeeded`. */
  readonly inheritedEventCount?: SessionLogOffset
  /**
   * Initial replay/fork history. A fork supplies a balanced completed-turn
   * prefix of the parent's log. The complete seed must be contiguous from seq
   * 0, carry only lossless-JSON data, and contain no open turn/step or dangling
   * tool call. The factory passes it to the session's durable
   * validator/snapshot boundary before publication.
   */
  readonly seed?: readonly SessionEvent[]
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal; detached before the returned handle becomes visible. */
  readonly signal?: AbortSignal
  /**
   * Creation-time composition of the agent's scoped world. The factory awaits
   * setup after minting `agentCtx` but BEFORE inserting or announcing either
   * the session or agent, so observers can never see a partially configured
   * world. Setup may return an {@link AgentSetupCommit}; the factory invokes its
   * synchronous `commit()` after every setup await settles and immediately
   * before registry publication. This lets mutable provisioning revalidate at
   * the exact publication boundary. Everything registered through `agentCtx`
   * (scoped tools, prompt sections/variables, `restrict()`, listeners, awaited
   * child plugins) exists before `session/created`, `agent/created`,
   * `agent/session-start`, and the first prompt assembly. A setup
   * throw/rejection, commit throw, or owner disposal rolls the scope back
   * without publishing either id.
   *
   * **Setup composes, it never drives**: the callback is trusted same-process
   * code and receives the full scoped context, so this is a contract rather
   * than a runtime restriction. Drive the agent only after creation resolves.
   */
  readonly setup?: AgentSetup
}

/**
 * Options for resuming an agent on a persisted session
 * ({@link AgentRegistry.resume}).
 */
export interface ResumeAgentOptions {
  /** The persisted session id to load and use as the live agent/session identity. */
  readonly resumeSessionId: SessionId
  /** Live parent Agent for runtime ownership; omit for a root Agent. */
  readonly parentAgent?: Agent
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions
  /** Optional creation-only cancellation signal for persistence load/setup; detached before return. */
  readonly signal?: AbortSignal
  /**
   * Resume-time composition of the agent's fresh scoped world. Persistence is
   * loaded first; the factory then mints `agentCtx` and awaits setup while the
   * reconstructed session and agent remain unpublished. The callback has the
   * same trusted composition-only contract and optional synchronous
   * publication commit as {@link CreateAgentOptions.setup}: all registrations
   * exist before either creation announcement, and rejection, commit failure,
   * or owner disposal rolls the transaction back without publishing either id.
   */
  readonly setup?: AgentSetup
}

/**
 * An owned agent plus its disposer, returned by {@link AgentRegistry.create} /
 * {@link AgentRegistry.resume}. The disposer is a CAPABILITY: among consumers,
 * only the holder can tear this agent down. The registered factory provider is
 * also a structural owner because the scoped agent depends on that provider's
 * service API; provider unload stops and drains every live handle it made.
 * `dispose()` stops the loop, awaits its exit, unregisters the agent, removes
 * its session from the store, and finally unwinds its scoped world.
 *
 * `ctx.agents.get(id)` still returns a bare {@link Agent} — the handle is
 * exposed only to the consumer owner that created it; the structural provider
 * reaches the same teardown internally. Config-created agents (the loop's own
 * startup) are owned by the loop fiber and never need a handle.
 */
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

/** Shared live-Agent pool exhaustion. */
export class AgentPoolCapacityError extends Error {
  /** Stable Remote error code for callers at the HTTP boundary. */
  readonly code = 'gateway/overloaded'

  /**
   * @param isChild - whether the rejected creation was an Agent child.
   * @param retryAfterMs - advisory delay before retrying.
   */
  constructor(
    readonly isChild: boolean,
    readonly retryAfterMs = 5_000,
  ) {
    super(isChild
      ? 'the shared Agent pool has no emergency child slot available'
      : 'the shared Agent pool has reached its top-level capacity')
    this.name = 'AgentPoolCapacityError'
  }
}

/** Shared turn scheduler saturation or timeout. */
export class AgentTurnOverloadedError extends Error {
  /** Stable Remote error code for callers at the HTTP boundary. */
  readonly code = 'gateway/overloaded'

  /**
   * @param reason - queue saturation or timeout category.
   * @param retryAfterMs - advisory delay before retrying.
   */
  constructor(
    readonly reason: 'queue-full' | 'timeout' | 'cancelled',
    readonly retryAfterMs = 5_000,
  ) {
    super(reason === 'queue-full'
      ? 'the shared Agent turn queue is full'
      : reason === 'timeout'
        ? 'the shared Agent turn queue wait timed out'
        : 'the shared Agent turn queue request was cancelled')
    this.name = 'AgentTurnOverloadedError'
  }
}

/**
 * The agent-creation factory the loop implementation provides to the registry
 * via {@link AgentRegistry.setFactory}. Kept on the `dsh-agent` interface so
 * consumers (e.g. the ACP bridge) program against `ctx.agents` without
 * depending on the concrete `dsh-agent-loop` package.
 */
export interface AgentFactory {
  /**
   * Create a new agent on a caller-supplied session id. Async because creation
   * awaits unpublished setup, invokes its optional synchronous commit, inserts
   * both session and agent, emits their creation notifications in order, emits
   * `agent/session-start`, and only then starts the loop. The sequence is
   * rollback-covered, but notifications delivered before a later listener
   * failure remain observable; every agent or session creation announcement
   * that began is paired by `agent/disposed` or `session/disposed` during
   * rollback. The owner disposes the resolved handle to stop/drain,
   * unregister, remove the session, and unwind the scope.
   * The registry passes a context carrying the `create()` caller's fiber and
   * scope as `ownerCtx`. The implementation attaches the unpublished
   * transaction and resulting lifecycle to that owner; it must not infer
   * ownership from the factory object's registration context.
   * @param ownerCtx - caller-bound context that owns the transaction and live handle.
   * @param options - agent/session identity, configuration, optional live parent, and setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  /**
   * Resume an agent on a persisted session. Async because it opens the
   * persisted session for write, reads and repairs the log, publishes it, and
   * awaits the optional unpublished setup transaction; must be called after
   * `ctx.sessionPersistence` exists (consumers inject `sessionPersistence`).
   * Publication follows the same setup-commit and ordered boundary as
   * {@link createAgent}.
   * @param ownerCtx - caller-bound context that owns load, setup, and the live handle.
   * @param options - persisted identity, configuration, optional live parent, and setup.
   * @returns the owned handle after setup, both announcements, and loop start complete.
   */
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}

/** Thrown when create/resume is called before an agent factory is registered. */
const NO_FACTORY_MESSAGE = 'no agent factory registered (load an agent-loop plugin)'
const NO_INITIATOR_MESSAGE = 'no initiating agent is active'
const DISPOSED_INITIATOR_MESSAGE = 'agent initiator scope is disposed'

/** All mutable lifecycle state for one exact registry entry. */
interface AgentEntry {
  readonly id: SessionId
  readonly agent: Agent
  /** Runtime creator-agent ownership; independent of durable session lineage. */
  readonly owner: Agent | undefined
  readonly carrier: Scoped<Agent>
  announced: boolean
  announcing: boolean
  detachRequested: boolean
}

/** One tracked boundary plus its inherited nesting chain. */
interface InitiatorRun {
  active: boolean
  readonly parent: InitiatorRun | undefined
}

/** Plain holder prevents Cordis from tracing the factory field before the caller context is known. */
interface FactorySlot {
  readonly target: AgentFactory
}

interface AgentPoolEntry {
  readonly agent: Agent
  readonly topLevel: boolean
  evictable: boolean
  dispose: () => Promise<void>
  lastActiveAt: number
  disposal?: Promise<void>
}

interface AgentPoolReservation {
  readonly id: SessionId
  readonly child: boolean
  consumed: boolean
}

const AGENT_POOL_LIMIT = 64
const AGENT_POOL_CHILD_RESERVE = 8
const AGENT_POOL_TOP_LEVEL_LIMIT = AGENT_POOL_LIMIT - AGENT_POOL_CHILD_RESERVE
const AGENT_POOL_IDLE_MS = 30 * 60 * 1_000
const AGENT_POOL_MAINTENANCE_MS = 60_000

/**
 * Agent service (`ctx.agents`): tracks live agents and carries the initiating
 * Agent through one process-local asynchronous driver chain. Agent *creation*
 * is provided by whichever plugin implements the {@link AgentFactory}
 * (`@deepseek-ai/dsh-agent-loop`), registered via {@link setFactory}.
 *
 * Initiator methods provide same-process causal attribution only. Ambient
 * presence is neither liveness proof nor authorization; subjects and owners
 * remain explicit, as does identity at worker, process, persistence, and wire
 * boundaries. Returned Promise boundaries drain during teardown, except a
 * nested lineage that starts an owning-fiber unload is excluded from its own drain.
 */
export class AgentRegistry extends Service {
  private store = new Map<SessionId, AgentEntry>()
  private factory: FactorySlot | undefined
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>()
  private readonly initiatorRuns = new AsyncLocalStorage<InitiatorRun>()
  private initiatorState: 'active' | 'closing' | 'disposed' = 'active'
  private activeInitiatorRuns = 0
  private initiatorDrain: PromiseWithResolvers<void> | undefined
  private initiatorDisposal: Promise<void> | undefined
  private readonly pool = new Map<SessionId, AgentPoolEntry>()
  private poolTopLevelReservations = 0
  private poolChildReservations = 0
  private readonly poolReservations = new Map<SessionId, AgentPoolReservation[]>()
  private poolTail: Promise<void> = Promise.resolve()
  private poolTimer: ReturnType<typeof setInterval> | undefined
  private poolEvictions = 0

  constructor(ctx: Context) {
    super(ctx, 'agents')
    ctx.inject(['typert'], (typeCtx) => {
      typeCtx.typert.lookups.register('agent', {
        parameter: 'agent',
        wire: 'agentId',
        hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId),
      })
      typeCtx.typert.contexts.registerHost('agent', {
        wire: 'agentId',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId)?.ctx,
      })
    })
    ctx.on('internal/status', (fiber) => {
      if (fiber.state === FiberState.UNLOADING && this.hasLifecycleAncestor(fiber)) {
        this.closeInitiators()
      }
    })
    ctx.effect(function* (this: AgentRegistry) {
      yield () => this.disposeInitiators()
      yield () => { this.closeInitiators() }
    }.bind(this), 'agents.initiatorLifecycle()')
    ctx.on('agent/status', ({ agent }) => { this.touchPooled(agent) }, { global: true })
    ctx.on('agent/assistant-stream', ({ agent }) => { this.touchPooled(agent) }, { global: true })
    ctx.on('agent/error', ({ agent }) => { this.touchPooled(agent) }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => { this.pool.delete(agent.id) }, { global: true })
    ctx.on('session/event', (session) => { this.touchPooled(session.id) }, { global: true })
    this.poolTimer = setInterval(() => { void this.maintainPool() }, AGENT_POOL_MAINTENANCE_MS)
    this.poolTimer.unref()
    ctx.effect(() => () => {
      if (this.poolTimer !== undefined) clearInterval(this.poolTimer)
      this.poolTimer = undefined
    }, 'agents.poolMaintenance()')
  }

  /**
   * Read the Agent that initiated the inherited asynchronous driver chain.
   * Use this optional form for logging, tracing, metrics, or host attribution
   * that also supports agentless calls. When a parent creates a child, setup
   * reports the causal parent while the setup callback's Agent parameter
   * identifies the child.
   * @returns the inherited Agent, or `undefined` outside an initiator boundary
   *   and inside an explicit clearing boundary.
   * @throws when this service instance has been disposed.
   */
  currentInitiator(): Agent | undefined {
    this.assertInitiatorsReadable()
    return this.initiators.getStore()
  }

  /**
   * Read the initiating Agent and fail when no initiator boundary is active.
   * Use this for private helpers contractually below a driver, or for a
   * deployment-owned outbound request whose contract forbids agentless calls.
   * Generic or direct-call paths use optional lookup or explicit request fields.
   * @returns the inherited Agent.
   * @throws when no initiator is active or this service instance has been disposed.
   */
  requireInitiator(): Agent {
    const agent = this.currentInitiator()
    if (agent === undefined) throw new Error(NO_INITIATOR_MESSAGE)
    return agent
  }

  /**
   * Run an operation with one exact Agent as its process-local initiator. The
   * exact synchronous value or Promise returned by the operation is preserved.
   * Custom drivers and test harnesses wrap their complete returned foreground
   * lifetime.
   * A queue or wire receiver may establish this boundary only after validating
   * explicit identity and resolving the exact live Agent; this method does neither.
   * Detached work remains owned by the subsystem that starts it.
   * @param agent - initiating Agent to inherit; presence is neither liveness proof nor authorization.
   * @param operation - synchronous or asynchronous operation to invoke.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withInitiator<T>(agent: Agent, operation: () => T): T {
    return this.runWithInitiator(agent, operation)
  }

  /**
   * Run an operation inside a boundary that hides any inherited initiating
   * Agent. The exact synchronous value or Promise is preserved.
   * Use this while creating lazy shared timers, queue pumps, pool maintenance,
   * watchers, or exporters so they do not inherit the first Agent that happens
   * to initialize them. It clears only initiator attribution, not explicit
   * fields, and does not own or drain detached resources.
   * @param operation - synchronous or asynchronous operation to invoke without an initiator.
   * @returns the exact value returned by `operation`.
   * @throws when the initiator scope is closing/disposed, or when `operation` throws.
   */
  withoutInitiator<T>(operation: () => T): T {
    return this.runWithInitiator(undefined, operation)
  }

  /**
   * Register the agent-creation factory (the loop calls this on construction,
   * effect-scoped). A traced Cordis service is canonicalized to its concrete
   * target; each create/resume call is then traced through that caller's
   * context so ownership follows the caller without stacking proxy layers.
   * Throws if a factory is already registered. Returns the disposer; on
   * dispose the factory slot is cleared.
   * @param factory - the loop-owned factory {@link create}/{@link resume} delegate to.
   * @returns the disposer that clears the factory slot. The exact
   *   Cordis effect disposer (single-shot): composite (generator) effects may
   *   yield it directly — exact identity nests the teardown in order.
   */
  setFactory(factory: AgentFactory): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.factory !== undefined) throw new Error('an agent factory is already registered')
      // Avoid stacking two Cordis shadow layers when a caller passes a Service
      // already read through a context. Calls are re-traced through their
      // actual owner context below.
      const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
      this.factory = { target }
      return () => { this.factory = undefined }
    }, 'agents.setFactory()')
    // The exact cordis effect disposer (the agents.register() convention): a
    // caller's composite effect can yield it for in-order teardown; the
    // loop's constructor effect returns it directly, identity-nesting the
    // registration under that effect.
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /** Return the active creation factory. */
  private requireFactory(): FactorySlot {
    if (this.factory === undefined) throw new Error(NO_FACTORY_MESSAGE)
    return this.factory
  }

  /**
   * Create and publish a new agent through the registered factory.
   * Distinct from {@link register} (which records an already-constructed
   * agent): this constructs the agent and its session. Rejects if no factory is
   * registered or creation/setup fails. The resolved {@link AgentHandle} lets
   * the owner tear down exactly this agent.
   * @param options - shared identity, optional live parent, session seed/metadata, and agent options.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    const child = options.parentAgent !== undefined
    const reservation = await this.reservePoolSlot(options.sessionId, child)
    try {
      // Re-trace a Service-backed factory through the accessing context
      // explicitly. This preserves AgentLoop's dependency origin while binding
      // its effects to ownerCtx; plain factories receive ownerCtx as an explicit
      // capability and need no Cordis tracker magic.
      const { target } = this.requireFactory()
      const receiver = getTraceable(ownerCtx, target)
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
      const handle = await Reflect.apply(target.createAgent, receiver, [ownerCtx, options])
      return this.trackPooledHandle(handle, !child)
    } finally {
      this.releasePoolReservation(reservation)
    }
  }

  /**
   * Load a persisted session and resume an agent on it through the registered
   * factory. Rejects if no factory is registered; the factory rejects if
   * session persistence is not configured or persistence/setup fails.
   * @param options - persisted identity, optional live parent, configuration, and setup.
   * @returns the handle after setup, rollback-covered publication, and loop start complete.
   */
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const ownerCtx = this.ctx
    const child = options.parentAgent !== undefined
    const reservation = await this.reservePoolSlot(options.resumeSessionId, child)
    try {
      const { target } = this.requireFactory()
      const receiver = getTraceable(ownerCtx, target)
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply intentionally supplies the caller-traced receiver
      const handle = await Reflect.apply(target.resume, receiver, [ownerCtx, options])
      return this.trackPooledHandle(handle, !child)
    } finally {
      this.releasePoolReservation(reservation)
    }
  }

  /**
   * Register a live agent. Throws if an agent with the same id is already
   * registered. Emits `agent/created` on registration and `agent/disposed`
   * when the calling fiber is disposed — both with the agent's scope carrier
   * (`scopeTarget(agent, agent)`): the subject is the agent in hand, so the
   * emits are scope-filtered regardless of which context invoked `register`
   * (calling through `agent.ctx` scopes EFFECTS; dispatch scoping always
   * requires passing the carrier). The entry is a runtime root; factory-backed
   * creation uses `options.parentAgent` for child ownership. Returns the disposer.
   * @param agent - the already-constructed agent to record in the store.
   * @returns the EXACT Cordis effect disposer (single-shot; a repeat call
   *   returns undefined without awaiting an in-flight teardown). Exact
   *   identity is load-bearing: a composite (generator) effect that owns a
   *   teardown ORDER — the agent factory's lifecycle chain — must yield THIS
   *   function so Cordis nests the unregistration at that yield position;
   *   yielding a wrapper would leave it disposing as a concurrent sibling on
   *   owner unload, unregistering the agent (and emitting `agent/disposed`)
   *   while its final turn is still draining.
   */
  register(agent: Agent): () => void {
    const dispose = this.ctx.effect(function* (this: AgentRegistry) {
      yield this.enter(agent, undefined)
      this.announce(agent)
    }.bind(this), 'agents.register()')
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Insert an already-constructed agent without announcing it. This is the
   * advanced ordered-lifecycle primitive used by the async agent factory: it
   * first completes setup while the agent is unpublished, then assigns the
   * returned detach closure into its pre-installed composite teardown before
   * calling {@link announce}. Ordinary callers use {@link register}.
   * @param agent - the prepared, unpublished agent.
   * @param owner - explicitly supplied live runtime owner, or
   *   undefined for a top-level runtime root. This is runtime ownership, not
   *   the resumed session's durable parent lineage.
   * @returns an idempotent closure that removes this exact entry and emits
   *   `agent/disposed` with listener failures contained. When called from a
   *   synchronous `agent/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   */
  enter(agent: Agent, owner: Agent | undefined, dispose?: () => Promise<void>): () => void {
    const id = agent.id
    if (id !== agent.session.id) {
      throw new Error(`agent id "${id}" does not match session id "${agent.session.id}"`)
    }
    const reserved = this.consumePoolReservation(id, owner !== undefined)
    if (!reserved && !this.admitPoolSlotSync(owner !== undefined)) {
      throw new AgentPoolCapacityError(owner !== undefined)
    }
    const carrier = scopeTarget(agent, agent)
    // This is the authoritative collision boundary. Concurrent create/resume
    // operations may both prepare, but only one exact entry can publish.
    if (this.store.has(id)) throw new Error(`agent "${id}" is already registered`)
    const entry: AgentEntry = {
      id,
      agent,
      owner,
      carrier,
      announced: false,
      announcing: false,
      detachRequested: false,
    }
    this.store.set(id, entry)
    this.pool.set(id, {
      agent,
      topLevel: owner === undefined,
      evictable: owner === undefined && dispose !== undefined,
      dispose: dispose ?? (async () => {}),
      lastActiveAt: Date.now(),
    })
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      // Every callback reached by this creation dispatch must observe the same
      // live entry, and disposal must follow creation. A listener may own
      // the advanced detach capability, so make that ordering structural:
      // visibility and the paired disposal are deferred until announce()'s
      // synchronous dispatch has unwound.
      if (entry.announcing) {
        entry.detachRequested = true
        return
      }
      this.detachEntered(entry)
    }
    return detach
  }

  /** Remove one exact entered agent and emit its paired disposal when announced. */
  private detachEntered(entry: AgentEntry): void {
    entry.detachRequested = false
    // A stale capability can never delete a later same-id lifecycle. The
    // captured entry identity is the final boundary.
    /* v8 ignore next -- enter() rejects replacement while this single-shot detach capability is live. */
    if (this.store.get(entry.id) !== entry) return
    this.store.delete(entry.id)
    this.pool.delete(entry.id)
    // An insertion rolled back before announce was never externally created,
    // so emitting disposed would invent an impossible lifecycle edge. Marking
    // happens before the created emit: if a later created listener throws,
    // earlier listeners may already have observed it and must see disposal.
    if (!entry.announced) return
    this.emitDisposed(entry)
  }

  /** Emit the paired disposal edge through the entry's stable carrier. */
  private emitDisposed(entry: AgentEntry): void {
    const args: unknown[] = [entry.carrier, 'agent/disposed', { agent: entry.agent }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`agent "${entry.id}": agent/disposed listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Announce an agent previously inserted with {@link enter}.
   * @param agent - the live inserted agent to announce.
   * @throws if `agent` is not the exact live registry entry for its id, or its
   *   creation announcement already began (including a reentrant call from a
   *   creation listener).
   */
  announce(agent: Agent): void {
    const entry = this.store.get(agent.id)
    if (entry === undefined || entry.agent !== agent) {
      throw new Error(`agent "${agent.id}" is not live in this registry`)
    }
    if (entry.announced || entry.announcing) {
      throw new Error(`agent "${entry.id}" was already announced`)
    }
    // Mark before dispatch so a listener cannot recursively create a second
    // lifecycle edge; detach still pairs a partially delivered first edge.
    entry.announcing = true
    entry.announced = true
    const args: unknown[] = [entry.carrier, 'agent/created', { agent: entry.agent }]
    try {
      for (const callback of this.ctx.events.dispatch('emit', args)) {
        // A synchronous creation failure vetoes publication and rolls back.
        // Returned-promise rejection happens after this synchronous boundary, so
        // observe and report it instead of leaking an unhandled rejection.
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`agent "${entry.id}": agent/created listener rejected: ${String(error)}`)
        })
      }
    } finally {
      entry.announcing = false
      if (entry.detachRequested) this.detachEntered(entry)
    }
  }

  /**
   * Look up a live agent.
   * @param id - the shared agent/session id to look up.
   * @returns the agent, or undefined when no live agent has that id.
   */
  get(id: SessionId): Agent | undefined {
    return this.store.get(id)?.agent
  }

  /**
   * Test whether a live agent was created through one exact parent agent's
   * scoped context. Runtime ownership is independent of durable session
   * lineage and remains unambiguous when unrelated providers reuse an id.
   * @param id - the candidate child agent's shared agent/session id.
   * @param owner - the expected runtime creator agent.
   * @returns true only while the exact child entry is live under that owner.
   */
  isOwnedBy(id: SessionId, owner: Agent): boolean {
    return this.store.get(id)?.owner === owner
  }

  /**
   * All live agents, in registration order.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  list(): Agent[] {
    return [...this.store.values()].map(entry => entry.agent)
  }

  /**
   * All live top-level agents in registration order. A top-level agent was
   * created without an owning agent context; durable session lineage does not
   * affect this runtime relation, so a resumed fork may still be a root.
   * @returns a fresh array; mutating it does not affect the registry.
   */
  roots(): Agent[] {
    return [...this.store.values()]
      .filter(entry => entry.owner === undefined)
      .map(entry => entry.agent)
  }

  /**
   * Read a point-in-time view of shared Agent residency.
   * @returns resident, running, idle, cumulative eviction, and queued counts.
   */
  poolMetrics(): {
    readonly resident: number
    readonly running: number
    readonly idle: number
    readonly evicted: number
    readonly queued: number
  } {
    const entries = [...this.pool.values()]
    const running = entries.filter(entry => entry.agent.status === 'running').length
    return {
      resident: entries.length,
      running,
      idle: entries.length - running,
      evicted: this.poolEvictions,
      queued: 0,
    }
  }

  private reservePoolSlot(id: SessionId, child: boolean): Promise<AgentPoolReservation> {
    let reservation: AgentPoolReservation | undefined
    const admitted = this.poolTail.then(async () => {
      await this.admitPoolSlot(child)
      reservation = { id, child, consumed: false }
      const entries = this.poolReservations.get(id) ?? []
      entries.push(reservation)
      this.poolReservations.set(id, entries)
    })
    this.poolTail = admitted.catch(() => {})
    return admitted.then(() => reservation as AgentPoolReservation)
  }

  private async admitPoolSlot(child: boolean): Promise<void> {
    while (true) {
      const entries = [...this.pool.values()]
      const total = entries.length + this.poolTopLevelReservations + this.poolChildReservations
      const topLevel = entries.filter(entry => entry.topLevel).length + this.poolTopLevelReservations
      const admitted = child
        ? total < AGENT_POOL_LIMIT
        : total < AGENT_POOL_LIMIT && topLevel < AGENT_POOL_TOP_LEVEL_LIMIT
      if (admitted) {
        if (child) this.poolChildReservations += 1
        else this.poolTopLevelReservations += 1
        return
      }
      if (!await this.evictOneIdleTopLevel()) throw new AgentPoolCapacityError(child)
    }
  }

  private consumePoolReservation(id: SessionId, child: boolean): boolean {
    const entries = this.poolReservations.get(id)
    const reservation = entries?.shift()
    if (entries?.length === 0) this.poolReservations.delete(id)
    if (reservation === undefined) return false
    if (reservation.child !== child) {
      this.releasePoolReservation(reservation)
      throw new Error(`agent pool reservation kind mismatch for "${id}"`)
    }
    reservation.consumed = true
    if (child) this.poolChildReservations = Math.max(0, this.poolChildReservations - 1)
    else this.poolTopLevelReservations = Math.max(0, this.poolTopLevelReservations - 1)
    return true
  }

  private releasePoolReservation(reservation: AgentPoolReservation): void {
    if (reservation.consumed) return
    reservation.consumed = true
    const entries = this.poolReservations.get(reservation.id)
    const index = entries?.indexOf(reservation) ?? -1
    if (entries !== undefined && index !== -1) entries.splice(index, 1)
    if (entries?.length === 0) this.poolReservations.delete(reservation.id)
    if (reservation.child) this.poolChildReservations = Math.max(0, this.poolChildReservations - 1)
    else this.poolTopLevelReservations = Math.max(0, this.poolTopLevelReservations - 1)
  }

  private admitPoolSlotSync(child: boolean): boolean {
    const entries = [...this.pool.values()]
    const total = entries.length + this.poolTopLevelReservations + this.poolChildReservations
    const topLevel = entries.filter(entry => entry.topLevel).length + this.poolTopLevelReservations
    return child
      ? total < AGENT_POOL_LIMIT
      : total < AGENT_POOL_LIMIT && topLevel < AGENT_POOL_TOP_LEVEL_LIMIT
  }

  private trackPooledHandle(handle: AgentHandle, topLevel: boolean): AgentHandle {
    const entry = this.pool.get(handle.agent.id) ?? {
      agent: handle.agent,
      topLevel,
      evictable: true,
      dispose: () => handle.dispose(),
      lastActiveAt: Date.now(),
    }
    entry.evictable = true
    entry.dispose = () => handle.dispose()
    this.pool.set(handle.agent.id, entry)
    this.touchPooled(handle.agent)
    return {
      agent: handle.agent,
      dispose: () => this.disposePooled(entry),
    }
  }

  private disposePooled(entry: AgentPoolEntry): Promise<void> {
    return (entry.disposal ??= (async () => {
      this.pool.delete(entry.agent.id)
      await entry.dispose()
    })())
  }

  private async evictOneIdleTopLevel(): Promise<boolean> {
    const candidate = [...this.pool.values()]
      .filter(entry => this.isEvictable(entry))
      .sort((left, right) => left.lastActiveAt - right.lastActiveAt)[0]
    if (candidate === undefined) return false
    this.poolEvictions += 1
    await this.disposePooled(candidate)
    return true
  }

  private isEvictable(entry: AgentPoolEntry): boolean {
    if (!entry.evictable || !entry.topLevel || entry.disposal !== undefined) return false
    if (entry.agent.status !== 'idle') return false
    if (entry.agent.inbox.nextTurn.length > 0 || entry.agent.inbox.nextStep.length > 0) return false
    return ![...this.store.values()].some(child => child.owner?.id === entry.agent.id)
  }

  private touchPooled(subject: Agent | SessionId): void {
    const id = typeof subject === 'string' ? subject : subject.id
    const entry = this.pool.get(id)
    if (entry === undefined) return
    entry.lastActiveAt = Date.now()
    const owner = this.store.get(id)?.owner
    if (owner !== undefined) {
      const parent = this.pool.get(owner.id)
      if (parent !== undefined) parent.lastActiveAt = entry.lastActiveAt
    }
  }

  private async maintainPool(): Promise<void> {
    const cutoff = Date.now() - AGENT_POOL_IDLE_MS
    for (const entry of [...this.pool.values()]
      .filter(item => this.isEvictable(item) && item.lastActiveAt <= cutoff)
      .sort((left, right) => left.lastActiveAt - right.lastActiveAt)) {
      try {
        await this.disposePooled(entry)
        this.poolEvictions += 1
      } catch (error: unknown) {
        this.ctx.logger.warn(`agents: idle eviction failed for "${entry.agent.id}": ${String(error)}`)
      }
    }
    this.ctx.logger.info(`agents: shared pool ${JSON.stringify(this.poolMetrics())}`)
  }

  /** Reject new initiator boundaries while inherited continuations drain. */
  private closeInitiators(): void {
    if (this.initiatorState === 'active') this.initiatorState = 'closing'
  }

  /** Wait for returned-Promise boundaries, then invalidate retained references. */
  private disposeInitiators(): Promise<void> {
    return (this.initiatorDisposal ??= (async () => {
      this.closeInitiators()
      this.releaseReentrantInitiatorRuns()
      if (this.activeInitiatorRuns !== 0) {
        this.initiatorDrain ??= Promise.withResolvers<void>()
        await this.initiatorDrain.promise
      }
      this.initiatorState = 'disposed'
      this.initiators.disable()
      this.initiatorRuns.disable()
    })())
  }

  /** Establish one tracked initiator or clearing boundary. */
  private runWithInitiator<T>(agent: Agent | undefined, operation: () => T): T {
    if (this.initiatorState !== 'active') throw new Error(DISPOSED_INITIATOR_MESSAGE)
    const run: InitiatorRun = {
      active: true,
      parent: this.initiatorRuns.getStore(),
    }
    this.activeInitiatorRuns += 1
    let result: T
    try {
      result = this.initiatorRuns.run(run, () => this.initiators.run(agent, operation))
    } catch (error: unknown) {
      this.releaseInitiatorRun(run)
      throw error
    }
    if (isPromise(result)) {
      try {
        void Promise.prototype.then.call(
          result,
          () => { this.releaseInitiatorRun(run) },
          () => { this.releaseInitiatorRun(run) },
        )
      } catch {
        // A branded Promise may expose a failing @@species. Observer setup did
        // not attach, so preserve the exact return without leaking the run.
        this.releaseInitiatorRun(run)
      }
    } else {
      this.releaseInitiatorRun(run)
    }
    return result
  }

  /** Whether one unloading fiber owns this service's lifecycle. */
  private hasLifecycleAncestor(candidate: Fiber): boolean {
    let fiber = this.ctx.fiber
    while (true) {
      if (fiber === candidate) return true
      const parent = fiber.parent.fiber
      if (parent === fiber) return false
      fiber = parent
    }
  }

  private assertInitiatorsReadable(): void {
    if (this.initiatorState === 'disposed') throw new Error(DISPOSED_INITIATOR_MESSAGE)
  }

  /** Exclude the boundary chain that initiated this teardown from its own drain. */
  private releaseReentrantInitiatorRuns(): void {
    let run = this.initiatorRuns.getStore()
    while (run !== undefined) {
      this.releaseInitiatorRun(run)
      run = run.parent
    }
  }

  private releaseInitiatorRun(run: InitiatorRun): void {
    if (!run.active) return
    run.active = false
    this.activeInitiatorRuns -= 1
    if (this.activeInitiatorRuns !== 0) return
    this.initiatorDrain?.resolve()
    this.initiatorDrain = undefined
  }
}

export default AgentRegistry
