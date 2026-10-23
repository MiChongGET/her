import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { FileSources } from '../../shared/types'

export const SOURCE_PLACEHOLDER = '（资料授权或版本已失效，相关内容不再发送；请重新选择资料。）'

/** `file:<id>` or `grant:<id>@<revision>`: the host-issued handles a piece of context depends on. */
export type SourceKey = string
export const fileKey = (id: string): SourceKey => `file:${id}`
export const grantKey = (id: string, revision: number): SourceKey => `grant:${id}@${revision}`
export const handoffKey = (operationId: string): SourceKey => `handoff:${operationId}`

export function sourceKeys(sources: FileSources | undefined): SourceKey[] {
  return [...(sources?.fileIds ?? []).map(fileKey), ...(sources?.grants ?? []).map(grant => grantKey(grant.id, grant.revision))]
}

export function toFileSources(keys: Iterable<SourceKey>): FileSources {
  const fileIds: string[] = [], grants: { id: string; revision: number }[] = []
  for (const key of keys) {
    if (key.startsWith('file:')) fileIds.push(key.slice(5))
    else if (key.startsWith('grant:')) { const [id, revision] = key.slice(6).split('@'); grants.push({ id, revision: Number(revision) }) }
  }
  return { ...(fileIds.length ? { fileIds } : {}), ...(grants.length ? { grants } : {}) }
}

/** Custom entries the host writes into the Pi session: which sources a run, or one tool result, depends on. */
export const RUN_SOURCES = 'her.run'
export const TOOL_SOURCES = 'her.sources'

interface Message { role?: string; timestamp?: number; toolCallId?: string; content?: unknown; summary?: string }
type AnyMessage = Message & Record<string, unknown>

/** Stable identity of a message in the model context, matching it back to its session entry. */
function messageKey(message: AnyMessage): string {
  return `${message.role}:${message.timestamp}:${message.role === 'toolResult' ? message.toolCallId : ''}`
}

export interface SourceIndex {
  /** The sources each message was derived from, including everything the model had already seen. */
  derived: Map<string, Set<SourceKey>>
  /** The sources a user typed or attached themselves; later context never taints a user's own message. */
  own: Map<string, Set<SourceKey>>
  /** Sources behind the whole branch. */
  all: Set<SourceKey>
}

/**
 * Walks the active branch in order. Each assistant message, tool result and summary depends on its own sources plus
 * everything that came before it in the context: a model that read a file may have carried it into any later reply.
 */
export function indexBranch(branch: SessionEntry[]): SourceIndex {
  const derived = new Map<string, Set<SourceKey>>(), own = new Map<string, Set<SourceKey>>()
  const seen = new Set<SourceKey>(), toolSources = new Map<string, Set<SourceKey>>()
  let runSources = new Set<SourceKey>()
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === RUN_SOURCES) {
      runSources = new Set(sourceKeys((entry.data as { fileSources?: FileSources } | undefined)?.fileSources))
    } else if (entry.type === 'custom' && entry.customType === TOOL_SOURCES) {
      const data = entry.data as { toolCallId?: string; fileSources?: FileSources } | undefined
      if (data?.toolCallId) toolSources.set(data.toolCallId, new Set(sourceKeys(data.fileSources)))
    } else if (entry.type === 'custom_message' && entry.customType === 'her.topic-handoff') {
      const operationId = (entry.details as { operationId?: string } | undefined)?.operationId
      if (operationId) {
        const key = `custom:${new Date(entry.timestamp).getTime()}:`
        const source = handoffKey(operationId)
        seen.add(source)
        own.set(key, new Set([source]))
        derived.set(key, new Set(seen))
      }
    } else if (entry.type === 'message') {
      const message = entry.message as AnyMessage
      const key = messageKey(message)
      let mine = new Set<SourceKey>()
      if (message.role === 'user') { mine = runSources; runSources = new Set() }
      else if (message.role === 'toolResult') mine = toolSources.get(message.toolCallId as string) ?? new Set()
      for (const source of mine) seen.add(source)
      own.set(key, new Set(mine))
      derived.set(key, message.role === 'user' ? new Set(mine) : new Set(seen))
    } else if (entry.type === 'compaction') {
      const key = `compactionSummary:${new Date(entry.timestamp).getTime()}:`
      own.set(key, new Set())
      derived.set(key, new Set(seen))
    }
  }
  return { derived, own, all: seen }
}

export type Validity = (keys: SourceKey[]) => boolean

function placeholderFor(message: AnyMessage): AnyMessage {
  const text = [{ type: 'text', text: SOURCE_PLACEHOLDER }]
  if (message.role === 'toolResult') return { ...message, content: text, isError: true, details: undefined }
  if (message.role === 'assistant') {
    // Tool calls stay (their results still need a partner) but their arguments no longer carry the material.
    const calls = (message.content as { type: string }[]).filter(part => part.type === 'toolCall').map(part => ({ ...part, arguments: {} }))
    return { ...message, content: [...text, ...calls] }
  }
  if (message.role === 'compactionSummary') return { ...message, summary: SOURCE_PLACEHOLDER }
  if (message.role === 'user') return { ...message, content: text }
  return { ...message, content: text }
}

/**
 * Replaces every message that depends on an invalid source with a placeholder. A message that cannot be matched to
 * the session record is judged by everything the branch has seen, so nothing unaccounted for slips through.
 */
export function filterMessages<T>(messages: T[], index: SourceIndex, valid: Validity): { messages: T[]; used: Set<SourceKey>; dropped: number } {
  const used = new Set<SourceKey>(), checked = new Map<string, boolean>()
  const ok = (keys: Set<SourceKey>) => {
    const id = [...keys].sort().join('|')
    let result = checked.get(id)
    if (result === undefined) { result = keys.size === 0 || valid([...keys]); checked.set(id, result) }
    return result
  }
  let dropped = 0
  const output = messages.map(item => {
    const message = item as unknown as AnyMessage
    const key = message.role === 'compactionSummary' ? `compactionSummary:${message.timestamp}:` : messageKey(message)
    const keys = message.role === 'user'
      ? index.own.get(key) ?? new Set<SourceKey>()
      : index.derived.get(key) ?? (index.own.has(key) ? new Set<SourceKey>() : index.all)
    if (ok(keys)) { for (const source of keys) used.add(source); return item }
    dropped++
    return placeholderFor(message) as unknown as T
  })
  return { messages: output, used, dropped }
}

/** The sources behind a set of messages, e.g. what a summary request is about to be built from. */
export function sourcesOf(messages: unknown[], index: SourceIndex): Set<SourceKey> {
  const keys = new Set<SourceKey>()
  for (const item of messages) {
    const message = item as AnyMessage
    const key = message.role === 'compactionSummary' ? `compactionSummary:${message.timestamp}:` : messageKey(message)
    for (const source of message.role === 'user' ? index.own.get(key) ?? [] : index.derived.get(key) ?? index.all) keys.add(source)
  }
  return keys
}
