/** Process-wide FIFO admission for concurrently running Agent turns. */

import { AgentTurnOverloadedError } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

const MAX_CONCURRENT_TURNS = 32
const MAX_QUEUED_TURNS = 64
const QUEUE_WAIT_MS = 120_000

/** One turn waiting for a global execution slot. */
interface QueuedTurn {
  readonly sessionId: SessionId
  readonly signal: AbortSignal | undefined
  readonly enqueuedAt: number
  readonly resolve: (release: () => void) => void
  readonly reject: (reason: unknown) => void
  timer?: ReturnType<typeof setTimeout>
  abort?: () => void
  settled: boolean
}

/** Point-in-time turn scheduler occupancy. */
export interface TurnAdmissionMetrics {
  readonly running: number
  readonly queued: number
  readonly waitingMs: number
}

/** Central turn concurrency and FIFO wait policy. */
export class TurnAdmissionController {
  private readonly queue: QueuedTurn[] = []
  private running = 0

  /**
   * Acquire one turn slot after all earlier requests ahead in the FIFO queue.
   * @param sessionId - Agent identity requesting execution.
   * @param signal - optional caller cancellation while waiting.
   * @returns an idempotent release function.
   */
  acquire(sessionId: SessionId, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      return Promise.reject(new AgentTurnOverloadedError('cancelled'))
    }
    const immediate = this.tryAcquire()
    if (immediate !== undefined) return Promise.resolve(immediate)
    if (this.queue.length >= MAX_QUEUED_TURNS) {
      return Promise.reject(new AgentTurnOverloadedError('queue-full'))
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry: QueuedTurn = {
        sessionId,
        signal,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        settled: false,
      }
      const settle = (action: () => void): void => {
        if (entry.settled) return
        entry.settled = true
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        if (entry.abort !== undefined) entry.signal?.removeEventListener('abort', entry.abort)
        action()
      }
      entry.abort = () => {
        const index = this.queue.indexOf(entry)
        if (index !== -1) this.queue.splice(index, 1)
        settle(() => { reject(new AgentTurnOverloadedError('cancelled')) })
        this.pump()
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      entry.timer = setTimeout(() => {
        const index = this.queue.indexOf(entry)
        if (index !== -1) this.queue.splice(index, 1)
        settle(() => { reject(new AgentTurnOverloadedError('timeout')) })
        this.pump()
      }, QUEUE_WAIT_MS)
      entry.timer.unref()
      this.queue.push(entry)
      this.pump()
    })
  }

  /**
   * Acquire a slot without yielding when capacity is immediately available.
   * @returns an idempotent release function, or undefined when this turn must
   *   preserve FIFO ordering behind running or queued work.
   */
  tryAcquire(): (() => void) | undefined {
    if (this.running >= MAX_CONCURRENT_TURNS || this.queue.length > 0) return undefined
    this.running += 1
    return this.releaseOnce()
  }

  /** @returns current running, queued, and oldest-wait duration. */
  metrics(): TurnAdmissionMetrics {
    const first = this.queue[0]
    return {
      running: this.running,
      queued: this.queue.length,
      waitingMs: first === undefined ? 0 : Math.max(0, Date.now() - first.enqueuedAt),
    }
  }

  private pump(): void {
    while (this.running < MAX_CONCURRENT_TURNS && this.queue.length > 0) {
      const entry = this.queue.shift() as QueuedTurn
      if (entry.settled) continue
      entry.settled = true
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      if (entry.abort !== undefined) entry.signal?.removeEventListener('abort', entry.abort)
      this.running += 1
      entry.resolve(this.releaseOnce())
    }
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.running -= 1
      this.pump()
    }
  }
}
