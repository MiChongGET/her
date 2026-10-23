import type { ActionDescription, ActionDescriptor, UserIntent } from '../delegations/types'
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
  delegationId?: string
  intent?: UserIntent
  describeAction?: (assessment: ActionAssessment, args: Record<string, unknown>) => Promise<ActionDescriptor>
  action?: ActionDescriptor
  actionPolicy?: {
    decide(action: ActionDescriptor, intent?: UserIntent, localCandidate?: () => boolean): 'allow' | 'confirm' | 'deny'
    assertCurrent(action: ActionDescriptor, localCandidate?: () => boolean): void
    observeAction?(action: ActionDescriptor): void
    controlVersion?(action: ActionDescriptor): string
    reject(action: ActionDescriptor): void
    consumeExactMessage?(intentId: string, action: ActionDescriptor, call: { runId: string; callId: string; toolName: string; args: Record<string, unknown> }): void
  }
  /** Exact current-run candidate identity checker supplied by Host, never from tool arguments. */
  admitLocalCandidate?: (assessment: ActionAssessment, context: ToolExecutionContext) => boolean
  // Main-process policy hooks. Never exposed to the renderer or model.
  approvalBinding?: { revision: string; validate: () => boolean; localAdmission?: () => boolean; allowAllOperations?: boolean; conversationScope?: { id: string; validate: () => boolean } }
  authorize?: (assessment: ActionAssessment, context: ToolExecutionContext) => Promise<void>
  onObserved?: (target: string) => void
  onNoEffect?: () => void
  onAttempt?: () => void
  onDispatch?: (assessment: ActionAssessment, phase?: 'preflight' | 'action') => void
  onPreflightComplete?: () => void
  markDispatched?: (phase: 'preflight' | 'action') => void
  completePreflight?: () => void
  onWaitingResources?: (waiting: boolean) => void
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
  describeAction?: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<ActionDescription>
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
