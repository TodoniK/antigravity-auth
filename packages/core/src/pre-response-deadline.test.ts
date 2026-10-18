import { describe, expect, it, spyOn } from 'bun:test'
import { getEventListeners } from 'node:events'
import {
  PRE_RESPONSE_DEADLINE_MS,
  PreResponseDeadline,
  PreResponseTimeoutError,
} from './pre-response-deadline.ts'

function fixture() {
  let now = 0
  const timers = new Map<() => void, number>()
  const caller = new AbortController()
  const deadline = new PreResponseDeadline(caller.signal, {
    now: () => now,
    schedule(callback, delay) {
      timers.set(callback, now + delay)
      return () => {
        timers.delete(callback)
      }
    },
  })
  return {
    caller,
    deadline,
    timers,
    advance(ms: number, fire = true) {
      now += ms
      if (fire)
        for (const [callback, at] of [...timers]) {
          if (at <= now && timers.delete(callback)) callback()
        }
    },
  }
}

describe('PreResponseDeadline', () => {
  it('monotonic deadline survives wall clock jumps and boundary races', () => {
    const wall = spyOn(Date, 'now')
    try {
      const before = fixture()
      wall.mockReturnValue(Number.MAX_SAFE_INTEGER)
      before.advance(PRE_RESPONSE_DEADLINE_MS - 1, false)
      before.deadline.acceptHeaders()
      before.advance(PRE_RESPONSE_DEADLINE_MS)
      expect(before.deadline.signal.aborted).toBe(false)
      before.deadline.dispose()
      expect(before.timers.size).toBe(0)
      expect(getEventListeners(before.caller.signal, 'abort')).toHaveLength(0)

      const boundary = fixture()
      wall.mockReturnValue(0)
      boundary.advance(PRE_RESPONSE_DEADLINE_MS, false)
      expect(() => boundary.deadline.acceptHeaders()).toThrow(
        PreResponseTimeoutError,
      )
      expect(boundary.deadline.signal.aborted).toBe(true)
      boundary.deadline.dispose()
      expect(boundary.timers.size).toBe(0)
      expect(getEventListeners(boundary.caller.signal, 'abort')).toHaveLength(0)
    } finally {
      wall.mockRestore()
    }
  })

  it('successful headers disarm only the pre-response timer', async () => {
    const f = fixture()
    f.deadline.acceptHeaders()
    f.advance(PRE_RESPONSE_DEADLINE_MS * 2)
    expect(await f.deadline.wait(() => 'late body')).toBe('late body')
    const reason = new Error('caller cancellation after headers')
    f.caller.abort(reason)
    expect(f.deadline.signal.reason).toBe(reason)
    f.deadline.dispose()
    expect(f.timers.size).toBe(0)
  })

  it('cancel pre-response work without retry or timeout conversion', async () => {
    const f = fixture()
    const reason = new Error('caller cancellation')
    const pending = f.deadline.wait(() => new Promise<void>(() => {}))
    f.caller.abort(reason)
    f.advance(PRE_RESPONSE_DEADLINE_MS)
    await expect(pending).rejects.toBe(reason)
    f.deadline.dispose()
    expect(getEventListeners(f.deadline.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(f.caller.signal, 'abort')).toHaveLength(0)
    expect(f.timers.size).toBe(0)
  })

  it('an empty-response resend re-arms the original absolute deadline', () => {
    const f = fixture()
    f.advance(PRE_RESPONSE_DEADLINE_MS / 2)
    f.deadline.acceptHeaders()
    f.advance(PRE_RESPONSE_DEADLINE_MS / 2)
    expect(() => f.deadline.resume()).toThrow(PreResponseTimeoutError)
    f.deadline.dispose()
  })
})
