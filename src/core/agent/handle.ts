// Task 4.2: Per-conversation handle with generation, runId, and event sequencing.
// Old generation events are discarded. Each handle wraps one AgentSessionHandle and
// tracks the current run state.

import type { AgentSessionHandle, AgentConfig } from './types'
import type { HerAgentEvent } from './events'

export type ConversationRunStatus =
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'waiting_resource'
  | 'compacting'
  | 'stopping'

export interface ConversationHandle {
  conversationId: string
  generation: number
  runId: string | null
  status: ConversationRunStatus
  sequenceNumber: number
  session: AgentSessionHandle

  /** Start a new run with a new runId */
  startRun(runId: string): void

  /** Handle an event from the session. Discard if generation or runId mismatch. */
  handleEvent(event: HerAgentEvent): void

  /** Abort the current run */
  abort(): void

  /** Increment generation (invalidates current runId and all in-flight events) */
  incrementGeneration(): void

  /** Task 7.1: Switch to a new model. Disposes the old session and replaces it. */
  replaceSession(newSession: AgentSessionHandle): void

  /** Dispose the session and mark inactive */
  dispose(): void
}

/**
 * Create a conversation handle wrapping an agent session. The handle tracks the
 * current generation and runId, and discards events from old runs.
 */
export function createConversationHandle(
  conversationId: string,
  session: AgentSessionHandle,
  onEvent: (event: HerAgentEvent) => void
): ConversationHandle {
  let generation = 0
  let runId: string | null = null
  let status: ConversationRunStatus = 'idle'
  let sequenceNumber = 0

  const handle: ConversationHandle = {
    conversationId,
    get generation() { return generation },
    get runId() { return runId },
    get status() { return status },
    get sequenceNumber() { return sequenceNumber },
    session,

    startRun(newRunId: string) {
      runId = newRunId
      status = 'running'
      sequenceNumber = 0
    },

    handleEvent(event: HerAgentEvent) {
      // Discard events from old generations
      if (event.generation !== generation) {
        console.log(`Discarding event from old generation ${event.generation} (current: ${generation})`)
        return
      }

      // Discard events from different tasks (runId mismatch)
      if (event.taskId !== runId) {
        console.log(`Discarding event from different task ${event.taskId} (current: ${runId})`)
        return
      }

      // Increment sequence number and forward to host
      sequenceNumber++
      onEvent(event)

      // Update status based on event type
      if (event.type === 'agent_settled' || event.type === 'error' || event.type === 'abort') {
        status = 'idle'
        runId = null
      }
    },

    abort() {
      if (status === 'running') {
        session.abort()
        status = 'stopping'
      }
    },

    incrementGeneration() {
      generation++
      runId = null
      status = 'idle'
      sequenceNumber = 0
    },

    replaceSession(newSession: AgentSessionHandle) {
      // Dispose old session
      session.dispose()
      // Replace with new session
      session = newSession
      // Increment generation to invalidate old events
      generation++
      runId = null
      status = 'idle'
      sequenceNumber = 0
    },

    dispose() {
      session.dispose()
      status = 'idle'
      runId = null
    }
  }

  return handle
}
