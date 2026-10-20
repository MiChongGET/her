/** Pi's defaults; fine for large windows, but larger than a small window can hold. */
const DEFAULT_RESERVE = 16_384
const DEFAULT_KEEP_RECENT = 20_000
export const DEFAULT_CONTEXT_WINDOW = 32_000
export const MIN_CONTEXT_WINDOW = 1_024

export interface CompactionBudget {
  contextWindow: number
  /** Room kept free for the next reply and the summary request. */
  reserveTokens: number
  /** Recent history kept verbatim after compaction. */
  keepRecentTokens: number
  /** Output cap so one request can never ask for more than the window leaves. */
  maxOutputTokens: number
}

/**
 * Reserve and keepRecent never exceed a share of the window, so reserve + keepRecent + summary always
 * fits and a small-window model can still send. Large windows keep Pi's defaults.
 */
export function compactionBudget(contextWindow: number | null | undefined, requestedOutput?: number): CompactionBudget {
  const window = Math.max(MIN_CONTEXT_WINDOW, Math.floor(contextWindow ?? DEFAULT_CONTEXT_WINDOW))
  const reserveTokens = Math.min(DEFAULT_RESERVE, Math.floor(window * 0.25))
  const keepRecentTokens = Math.min(DEFAULT_KEEP_RECENT, Math.floor(window * 0.3))
  const maxOutputTokens = Math.max(256, Math.min(requestedOutput ?? reserveTokens, reserveTokens, Math.floor(window / 2)))
  return { contextWindow: window, reserveTokens, keepRecentTokens, maxOutputTokens }
}

/** Rough size of text for a pre-flight check; real usage replaces it once the provider reports it. */
export function estimateTextTokens(text: string): number {
  let tokens = 0
  for (const character of text) tokens += character.charCodeAt(0) > 0x2e80 ? 1 : 0.25
  return Math.ceil(tokens)
}

/** A single message that cannot fit even in an empty context; compacting cannot help it. */
export function exceedsWindow(text: string, budget: CompactionBudget): boolean {
  return estimateTextTokens(text) > budget.contextWindow - budget.reserveTokens
}
