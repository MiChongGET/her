import { describe, expect, it } from 'vitest'
import { compactionBudget, estimateTextTokens, exceedsWindow, DEFAULT_CONTEXT_WINDOW } from '../src/core/agent/budget'

describe('compaction budget', () => {
  it.each([1_024, 2_048, 4_096, 8_192, 16_000, 32_000, 128_000, 1_000_000])('reserve + keepRecent leaves room in a %i window', window => {
    const budget = compactionBudget(window)
    expect(budget.reserveTokens + budget.keepRecentTokens).toBeLessThan(budget.contextWindow)
    expect(budget.contextWindow - budget.reserveTokens).toBeGreaterThan(0)
    expect(budget.maxOutputTokens).toBeLessThanOrEqual(budget.contextWindow / 2)
  })

  it('keeps Pi defaults for a large window and scales down for a small one', () => {
    expect(compactionBudget(200_000)).toMatchObject({ reserveTokens: 16_384, keepRecentTokens: 20_000 })
    const small = compactionBudget(4_096)
    expect(small.reserveTokens).toBeLessThan(16_384)
    expect(small.keepRecentTokens).toBeLessThan(20_000)
  })

  it('falls back to a default window when the model does not state one, and never goes below a floor', () => {
    expect(compactionBudget(null).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(compactionBudget(undefined).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(compactionBudget(10).contextWindow).toBe(1_024)
  })

  it('caps the requested output so a request cannot exceed what the window leaves', () => {
    expect(compactionBudget(4_096, 1_000_000).maxOutputTokens).toBeLessThanOrEqual(2_048)
    expect(compactionBudget(200_000, 4_000).maxOutputTokens).toBe(4_000)
  })

  it('counts wide characters heavier than ASCII', () => {
    expect(estimateTextTokens('a'.repeat(400))).toBeLessThan(estimateTextTokens('中'.repeat(400)))
  })

  it('flags a single message larger than the window, and accepts one that fits', () => {
    const budget = compactionBudget(4_096)
    expect(exceedsWindow('中'.repeat(5_000), budget)).toBe(true)
    expect(exceedsWindow('hello', budget)).toBe(false)
  })
})
