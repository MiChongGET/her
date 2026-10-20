import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunLimits, RunLimitError } from '../src/core/agent/limits'

afterEach(() => { vi.useRealTimers() })

describe('run limits', () => {
  it('refuses the 41st tool call before it can be dispatched', () => {
    const limits = new RunLimits(() => {})
    for (let i = 0; i < 40; i++) limits.attempt()
    expect(limits.toolCalls).toBe(40)
    expect(() => limits.attempt()).toThrow(RunLimitError)
    expect(limits.toolCalls).toBe(40)
  })

  it('reports the active-time limit after ten minutes of work', () => {
    vi.useFakeTimers()
    const reached = vi.fn(), limits = new RunLimits(reached)
    limits.start()
    vi.advanceTimersByTime(599_000)
    expect(reached).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(reached).toHaveBeenCalledTimes(1)
    expect(reached.mock.calls[0][0]).toBeInstanceOf(RunLimitError)
  })

  it('does not count time spent waiting for approval, and the invocation clock restarts afterwards', () => {
    vi.useFakeTimers()
    const reached = vi.fn(), limits = new RunLimits(reached)
    limits.start()
    vi.advanceTimersByTime(300_000)
    limits.pause()
    vi.advanceTimersByTime(3_600_000)
    expect(reached).not.toHaveBeenCalled()
    limits.resume()
    vi.advanceTimersByTime(299_000)
    expect(reached).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(reached).toHaveBeenCalledTimes(1)
  })

  it('stops counting and never fires once finished', () => {
    vi.useFakeTimers()
    const reached = vi.fn(), limits = new RunLimits(reached)
    limits.start(); vi.advanceTimersByTime(1_000); limits.stop()
    vi.advanceTimersByTime(3_600_000)
    expect(reached).not.toHaveBeenCalled()
    expect(limits.elapsedMs).toBe(1_000)
  })
})
