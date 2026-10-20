// Task 9.1: IPC channel definitions for Her-Pi runtime. All events carry
// conversationId and generation for proper routing and stale event filtering.

import type { HerAgentEvent } from '../core/agent/events'
import type { StoredConversation, StoredTask, InputQueueStatus } from '../core/storage/store'
import type { AgentConfig } from '../core/agent/types'

// ──────────────────────────────────────────────────────────────────────────────
// Renderer → Main requests
// ──────────────────────────────────────────────────────────────────────────────

export interface EnqueueInputRequest {
  conversationId: string
  content: string
  attachments?: unknown[]
}

export interface StopTaskRequest {
  conversationId: string
}

export interface CompactRequest {
  conversationId: string
}

export interface SwitchModelRequest {
  conversationId: string
  newServiceId: string
  newModelId: string
}

export interface ApproveToolRequest {
  conversationId: string
  toolCallId: string
  approved: boolean
}

// ──────────────────────────────────────────────────────────────────────────────
// Main → Renderer events
// ──────────────────────────────────────────────────────────────────────────────

export interface AgentEventNotification {
  event: HerAgentEvent
}

export interface TaskStatusUpdate {
  conversationId: string
  taskId: string
  status: string
  error?: string
}

export interface InputQueueUpdate {
  conversationId: string
  requestId: string
  status: InputQueueStatus
}

// ──────────────────────────────────────────────────────────────────────────────
// IPC channel names
// ──────────────────────────────────────────────────────────────────────────────

export const IPC_CHANNELS = {
  // Renderer → Main
  ENQUEUE_INPUT: 'agent:enqueue-input',
  STOP_TASK: 'agent:stop-task',
  COMPACT: 'agent:compact',
  SWITCH_MODEL: 'agent:switch-model',
  APPROVE_TOOL: 'agent:approve-tool',

  // Main → Renderer
  AGENT_EVENT: 'agent:event',
  TASK_STATUS: 'agent:task-status',
  INPUT_QUEUE: 'agent:input-queue',
} as const

/**
 * Task 9.1: IPC handler stubs. Actual implementation will wire these to AgentHost.
 * Each handler validates the request, calls the appropriate AgentHost method, and
 * returns a result or throws an error.
 */
export function registerAgentIpcHandlers(): void {
  // TODO: Wire to electron ipcMain.handle()
  console.log('[IPC] Agent IPC handlers registered (stub)')
}
