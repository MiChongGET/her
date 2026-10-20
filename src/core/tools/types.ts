import type { ActionAssessment, ApprovalRequest, ToolResult } from '../../shared/types'
import type { ResourceQueue } from './resources'
import type { ActionLedger } from './ledger'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolExecutionContext {
  runId: string
  conversationId: string
  callId: string
  signal: AbortSignal
  modelSupportsVision?: boolean
  // Main-process policy hooks. Never exposed to the renderer or model.
  approvalBinding?: { revision: string; validate: () => boolean; allowAllOperations?: boolean; conversationScope?: { id: string; validate: () => boolean } }
  authorize?: (assessment: ActionAssessment, context: ToolExecutionContext) => Promise<void>
  onObserved?: (target: string) => void
  onNoEffect?: () => void
  onAttempt?: () => void
  onDispatch?: (assessment: ActionAssessment, phase?: 'preflight' | 'action') => void
  onPreflightComplete?: () => void
  markDispatched?: (phase: 'preflight' | 'action') => void
  completePreflight?: () => void
  onApproval?: (request?: ApprovalRequest) => void
  observationValidated?: boolean
  validateRuntime?: () => boolean
  resources?: ResourceQueue
  ledger?: ActionLedger
}

export interface ToolExecutor {
  (args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>
}

export interface ToolRegistrationOptions {
  allowAllOperations?: boolean
  conversationApprovalScope?: string
  deferDispatch?: boolean
  revision?: string
  isAvailable?: () => boolean
  assess?: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ActionAssessment>
  validateObservation?: (assessment: ActionAssessment, context: ToolExecutionContext) => boolean
  timeoutMs?: 60000 | 120000
  /** Resource keys this call needs exclusively (`desktop`, `write:<target>`, `mcp:<service>`). */
  resources?: (args: Record<string, unknown>, assessment: ActionAssessment) => string[]
}

export interface ToolRegistry {
  getDefinitions(): ToolDefinition[]
  snapshot(): ToolRegistry
  getRevisions(): Record<string, string>
  execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>
}
