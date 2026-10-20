import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { ChatMessage } from '../../shared/types'

export interface RunRecord {
  requestId: string
  userMessageId: string
  assistantMessageId: string
  profileId: string
  model: string
}

export interface RunOutcome {
  /** The user's message was written to the Pi session, so the model may have seen it. */
  reached: boolean
  run?: RunRecord
  /** What the model had already said before the crash. */
  assistantText: string
  /** The run had already recorded its own final result before the crash. */
  result?: ChatMessage
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(part => (part as { type?: string }).type === 'text').map(part => (part as { text: string }).text).join('') : ''

/**
 * Looks at the part of the session belonging to one request: from its last `her.run` marker to the next marker.
 * A marker with no user message after it was written just before the crash and the model never saw the input.
 * Using the last marker matters: a request put back in the queue gets a second marker when it runs again.
 */
export function classifyRun(entries: SessionEntry[], requestId: string): RunOutcome {
  let start = -1
  entries.forEach((entry, index) => {
    if (entry.type === 'custom' && entry.customType === 'her.run' && (entry.data as RunRecord | undefined)?.requestId === requestId) start = index
  })
  if (start < 0) return { reached: false, assistantText: '' }
  const outcome: RunOutcome = { reached: false, run: entries[start].type === 'custom' ? (entries[start] as { data: RunRecord }).data : undefined, assistantText: '' }
  for (const entry of entries.slice(start + 1)) {
    if (entry.type === 'custom' && entry.customType === 'her.run') break
    if (entry.type === 'custom' && entry.customType === 'her.result') outcome.result = entry.data as ChatMessage
    if (entry.type === 'message' && entry.message.role === 'user') outcome.reached = true
    if (entry.type === 'message' && entry.message.role === 'assistant') outcome.assistantText += textOf(entry.message.content)
  }
  return outcome
}
