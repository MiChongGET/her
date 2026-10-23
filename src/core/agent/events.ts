import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { TaskEvent, TaskRun } from '../../shared/types'

export interface HerAgentEvent extends TaskEvent {}

/** Pi turn/message completion is not task completion: tools, retries or compaction may still follow. */
export function piTaskStatus(event: AgentSessionEvent): TaskRun['status'] | undefined {
  switch (event.type) {
    case 'compaction_start': return 'compacting'
    case 'compaction_end': return event.willRetry ? 'retrying' : 'running'
    case 'auto_retry_start': return 'retrying'
    case 'auto_retry_end': return event.success ? 'running' : undefined
    case 'tool_execution_start':
    case 'tool_execution_end':
    case 'message_start': return 'running'
    default: return undefined
  }
}
