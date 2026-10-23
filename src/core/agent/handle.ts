import type { TaskRun } from '../../shared/types'

/** Identity and event ordering for one attempt; the host owns its session and lifetime. */
export class ConversationHandle {
  seq = 0
  status: TaskRun['status'] = 'running'
  constructor(readonly conversationId: string, readonly runId: string, readonly generation: number,
    private readonly current: () => boolean) {}

  event<T extends object>(event: T, hostTerminal = false) {
    if (!this.current() && !hostTerminal) return undefined
    return { ...event, conversationId: this.conversationId, runId: this.runId, generation: this.generation, seq: ++this.seq }
  }
}
