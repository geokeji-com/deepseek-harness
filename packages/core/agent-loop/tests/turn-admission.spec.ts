import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentTurnOverloadedError } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TurnAdmissionController } from '../src/turn-admission.ts'

afterEach(() => {
  vi.useRealTimers()
})

async function occupy(controller: TurnAdmissionController, count = 32): Promise<Array<() => void>> {
  return Promise.all(
    Array.from(
      { length: count },
      (_, index) => controller.acquire(SessionId(`running-${String(index)}`)),
    ),
  )
}

describe('shared turn admission', () => {
  it('runs at most 32 turns and admits the next waiter when one releases', async () => {
    const controller = new TurnAdmissionController()
    const releases = await occupy(controller)
    const waiting = controller.acquire(SessionId('waiting'))
    let admitted = false
    void waiting.then(() => { admitted = true })

    await Promise.resolve()
    expect(admitted).toBe(false)
    expect(controller.metrics()).toMatchObject({ running: 32, queued: 1 })

    releases[0]!()
    const releaseWaiting = await waiting
    expect(admitted).toBe(true)
    expect(controller.metrics()).toMatchObject({ running: 32, queued: 0 })

    releaseWaiting()
    releaseWaiting()
    expect(controller.metrics().running).toBe(31)
    for (const release of releases.slice(1)) release()
  })

  it('keeps FIFO order and removes a cancelled waiter without blocking later work', async () => {
    const controller = new TurnAdmissionController()
    const releases = await occupy(controller)
    const order: string[] = []
    const first = controller.acquire(SessionId('first')).then((release) => {
      order.push('first')
      return release
    })
    const cancelled = new AbortController()
    const second = controller.acquire(SessionId('second'), cancelled.signal).then((release) => {
      order.push('second')
      return release
    })
    const third = controller.acquire(SessionId('third')).then((release) => {
      order.push('third')
      return release
    })

    await Promise.resolve()
    expect(controller.metrics().queued).toBe(3)
    cancelled.abort()
    await expect(second).rejects.toMatchObject({ reason: 'cancelled' })
    expect(controller.metrics().queued).toBe(2)

    releases[0]!()
    const releaseFirst = await first
    expect(order).toEqual(['first'])
    releaseFirst()
    const releaseThird = await third
    expect(order).toEqual(['first', 'third'])

    releaseThird()
    for (const release of releases.slice(1)) release()
  })

  it('rejects the sixty-fifth queued turn with a retryable overload error', async () => {
    const controller = new TurnAdmissionController()
    const releases = await occupy(controller)
    const queued = Array.from(
      { length: 64 },
      (_, index) => controller.acquire(SessionId(`queued-${String(index)}`)),
    )
    await Promise.resolve()

    await expect(controller.acquire(SessionId('overflow'))).rejects.toMatchObject({
      code: 'gateway/overloaded',
      reason: 'queue-full',
      retryAfterMs: 5_000,
    } satisfies Partial<AgentTurnOverloadedError>)
    expect(controller.metrics()).toMatchObject({ running: 32, queued: 64 })

    releases[0]!()
    const releaseQueued = await queued[0]!
    releaseQueued()
    for (const release of releases.slice(1)) release()
    for (const pending of queued.slice(1)) {
      const release = await pending
      release()
    }
  })

  it('times out after 120 seconds and releases the queue slot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const controller = new TurnAdmissionController()
    const releases = await occupy(controller)
    const waiting = controller.acquire(SessionId('timeout'))
    const rejection = waiting.catch((error: unknown) => error as AgentTurnOverloadedError)

    await vi.advanceTimersByTimeAsync(119_999)
    expect(controller.metrics()).toMatchObject({ running: 32, queued: 1, waitingMs: 119_999 })

    await vi.advanceTimersByTimeAsync(1)
    await expect(rejection).resolves.toMatchObject({
      code: 'gateway/overloaded',
      reason: 'timeout',
      retryAfterMs: 5_000,
    })
    expect(controller.metrics()).toMatchObject({ running: 32, queued: 0 })

    for (const release of releases) release()
  })
})
