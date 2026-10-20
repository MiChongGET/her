// Task 2.3: Event adapter — subscribe to Pi events, transform to Her's types, and
// update projection from Pi entries. Subscribes to turn_end and agent_settled, pulls
// entries via SessionManager.getEntries() for reconciliation (entry_appended does not
// fire for ordinary messages).
// Task 3.4: Sanitize error messages to remove synthetic_secret_marker.

import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { HerStore } from '../storage/store'

/**
 * Task 3.4: Sanitize error messages by removing synthetic secret markers.
 * Pi may include `synthetic_secret_marker` in error messages when credentials are involved.
 */
function sanitizeError(message: string): string {
  return message.replace(/synthetic_secret_marker/gi, '[已隐藏]')
}

export type HerAgentEventType =
  | 'turn_start'
  | 'turn_end'
  | 'agent_settled'
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_result'
  | 'error'
  | 'abort'

export interface HerAgentEvent {
  type: HerAgentEventType
  conversationId: string
  taskId: string
  generation: number
  timestamp: Date
  payload: unknown
}

/**
 * Adapter wrapping Pi's AgentSession event subscription. Transforms Pi events into Her's
 * event types, publishes them to Her's channels, and reconciles projection state from Pi
 * entries at turn boundaries.
 */
export class AgentEventAdapter {
  private unsubscribe?: () => void

  constructor(
    private readonly session: AgentSession,
    private readonly conversationId: string,
    private readonly taskId: string,
    private readonly generation: number,
    private readonly store: HerStore,
    private readonly onEvent: (event: HerAgentEvent) => void
  ) {}

  /**
   * Subscribe to Pi events and start transforming them. Returns an unsubscribe function.
   */
  subscribe(): () => void {
    this.unsubscribe = this.session.subscribe((piEvent: AgentSessionEvent) => {
      this.handlePiEvent(piEvent)
    })
    return this.unsubscribe
  }

  private handlePiEvent(piEvent: AgentSessionEvent): void {
    const timestamp = new Date()

    switch (piEvent.type) {
      case 'turn_start': {
        this.emit('turn_start', { timestamp })
        break
      }

      case 'turn_end': {
        // Pull latest entries and reconcile projection
        this.reconcileProjection()
        this.emit('turn_end', { timestamp })
        break
      }

      case 'agent_settled': {
        // Final reconciliation after all messages and tool calls complete
        this.reconcileProjection()
        this.emit('agent_settled', { timestamp })
        break
      }

      case 'message_update': {
        // Streaming text delta from assistant
        // assistantMessageEvent contains the delta content
        if (piEvent.assistantMessageEvent?.type === 'text_delta') {
          this.emit('text_delta', {
            text: piEvent.assistantMessageEvent.delta,
            timestamp
          })
        }
        break
      }

      case 'tool_execution_start': {
        this.emit('tool_call_start', {
          callId: piEvent.toolCallId,
          toolName: piEvent.toolName,
          arguments: piEvent.args,
          timestamp
        })
        break
      }

      case 'tool_execution_end': {
        this.emit('tool_call_result', {
          callId: piEvent.toolCallId,
          result: piEvent.result,
          isError: piEvent.isError,
          timestamp
        })
        break
      }

      // agent_end is the terminal event (from AgentSessionEvent)
      case 'agent_end': {
        // Check if this was an error or aborted
        // Pi's agent_end doesn't have outcome/error fields directly
        // We need to check messages to detect errors
        // For now, just emit agent_settled
        this.reconcileProjection()
        this.emit('agent_settled', { timestamp })
        break
      }
    }
  }

  private emit(type: HerAgentEventType, payload: unknown): void {
    this.onEvent({
      type,
      conversationId: this.conversationId,
      taskId: this.taskId,
      generation: this.generation,
      timestamp: new Date(),
      payload
    })
  }

  /**
   * Reconcile projection: pull all entries from Pi SessionManager, compare with last known
   * entry ID, and update projection for new entries. This is called at turn_end and
   * agent_settled, not on every entry_appended (which does not fire for ordinary messages).
   */
  private reconcileProjection(): void {
    // Task 4.x will implement the full projection reconciliation logic. For now, this is a stub.
    // Steps:
    // 1. Get last known entry ID from conversation row
    // 2. Call session.getEntries() to pull all Pi entries
    // 3. Find entries after last known ID
    // 4. Build ProjectedSessionEntry for each new entry
    // 5. Write to projection_entries table
    // 6. Update conversation.last_entry_id
  }

  dispose(): void {
    this.unsubscribe?.()
  }
}
