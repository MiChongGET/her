import type { Extension, SessionEntry } from '@earendil-works/pi-coding-agent'
import { filterMessages, indexBranch, sourcesOf, SOURCE_PLACEHOLDER, toFileSources, type SourceKey, type Validity } from './sources'

export interface SourceGuardOptions {
  /** The session's active branch, read on every request so it is always current. */
  branch: () => SessionEntry[]
  /** True when none of these sources has been revoked, replaced or removed. */
  valid: Validity
  /** Called with what a request is about to rely on, so a later revoke can stop exactly the requests that used it. */
  onUse?: (keys: Set<SourceKey>) => void
}

const failClosed = <T,>(messages: T[]): T[] => messages.map(() => ({
  role: 'user', content: [{ type: 'text', text: SOURCE_PLACEHOLDER }], timestamp: Date.now()
}) as unknown as T)

/**
 * An inline Pi extension that stands between the stored history and every model request. Pi swallows a handler's
 * exception and sends the original messages, so each handler contains its own failures and drops the material instead.
 */
export function createSourceGuard(options: SourceGuardOptions): Extension {
  const handlers = new Map<string, ((...args: unknown[]) => Promise<unknown>)[]>()
  // Normal requests, tool-result follow-ups, retries and continuations after a restart all pass through here.
  handlers.set('context', [async (event: unknown) => {
    const messages = Array.isArray((event as { messages?: unknown[] } | null)?.messages) ? (event as { messages: unknown[] }).messages : []
    try {
      const result = filterMessages(messages, indexBranch(options.branch()), options.valid)
      options.onUse?.(result.used)
      return { messages: result.messages }
    } catch { return { messages: failClosed(messages) } }
  }])
  // The summary request is built from these messages, so revoked material must not reach it either.
  handlers.set('session_before_compact', [async (event: unknown) => {
    const { preparation, signal } = event as { preparation: { messagesToSummarize: unknown[]; turnPrefixMessages: unknown[]; previousSummary?: string }; signal: AbortSignal }
    try {
      const index = indexBranch(options.branch())
      const bad = [...sourcesOf([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages], index)]
      if (bad.length && !options.valid(bad)) {
        const filtered = filterMessages(preparation.messagesToSummarize, index, options.valid)
        preparation.messagesToSummarize.splice(0, preparation.messagesToSummarize.length, ...filtered.messages)
        const prefix = filterMessages(preparation.turnPrefixMessages, index, options.valid)
        preparation.turnPrefixMessages.splice(0, preparation.turnPrefixMessages.length, ...prefix.messages)
      }
      // An earlier summary may itself rest on a revoked source; start again rather than carry it forward.
      if (preparation.previousSummary !== undefined && !options.valid([...index.all])) preparation.previousSummary = undefined
      signal.throwIfAborted()
      return undefined
    } catch (error) {
      if (signal.aborted) throw error
      // Better no compaction than a summary of material we could not vet.
      return { cancel: true }
    }
  }])
  return {
    path: 'her:source-guard', resolvedPath: 'her:source-guard', hidden: true,
    sourceInfo: { path: 'her:source-guard', source: 'her', scope: 'temporary', origin: 'top-level' } as Extension['sourceInfo'],
    handlers, tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map()
  }
}

export { toFileSources }
