import { randomUUID } from 'node:crypto'
import type { ActionAssessment, ApprovalDecisionInput, ApprovalRequest } from '../../shared/types'
import type { ToolExecutionContext } from './types'

export class ApprovalError extends Error {}

export class ToolApprovalService {
  private readonly pending = new Map<string, { request: ApprovalRequest; settle: (decision: ApprovalDecisionInput['decision']) => void }>()
  private readonly conversationGrants = new Map<string, Map<string, () => boolean>>()

  constructor(private readonly emit: (request: ApprovalRequest) => void = () => {}) {}

  async authorize(callId: string, assessment: ActionAssessment, context: ToolExecutionContext): Promise<void> {
    context.signal.throwIfAborted()
    if (assessment.effect === 'read') return
    const binding = context.approvalBinding
    if (!binding || !binding.validate()) throw new ApprovalError('动作确认已失效，请重新观察后继续。')
    if (binding.allowAllOperations) return
    const scope = binding.conversationScope
    if (scope && this.hasConversationApproval(context.conversationId) && this.conversationGrants.get(context.conversationId)?.has(scope.id)) return
    const request: ApprovalRequest = { id: randomUUID(), runId: context.runId, callId,
      revision: binding.revision, target: assessment.displayTarget ?? assessment.target, summary: assessment.summary,
      ...(scope ? { allowConversation: true } : {}) }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.pending.delete(request.id); context.signal.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); reject(context.signal.reason) }
      this.pending.set(request.id, { request, settle: decision => {
        cleanup()
        if (context.signal.aborted) reject(context.signal.reason)
        else if (!binding.validate()) reject(new ApprovalError('动作确认已失效，请重新观察后继续。'))
        else if (decision === 'reject') reject(new ApprovalError('你已拒绝这个动作。'))
        else {
          if (decision === 'approve-conversation' && scope && scope.validate()) {
            const grants = this.conversationGrants.get(context.conversationId) ?? new Map<string, () => boolean>()
            grants.set(scope.id, scope.validate)
            this.conversationGrants.set(context.conversationId, grants)
          }
          resolve()
        }
      } })
      context.signal.addEventListener('abort', abort, { once: true })
      context.onApproval?.(request)
      this.emit(request)
    }).finally(() => context.onApproval?.())
    context.signal.throwIfAborted()
    if (!binding.validate()) throw new ApprovalError('动作确认已失效，请重新观察后继续。')
  }

  decide(input: ApprovalDecisionInput): void {
    if (!input || !['approve', 'reject', 'approve-conversation'].includes(input.decision)) return
    const pending = this.pending.get(input.approvalId)
    if (!pending || pending.request.revision !== input.revision) return
    if (input.decision === 'approve-conversation' && !pending.request.allowConversation) return
    pending.settle(input.decision)
  }

  hasConversationApproval(conversationId: string): boolean {
    const grants = this.conversationGrants.get(conversationId)
    if (!grants) return false
    for (const [id, validate] of grants) if (!validate()) grants.delete(id)
    if (!grants.size) this.conversationGrants.delete(conversationId)
    return grants.size > 0
  }

  revokeConversation(conversationId: string): void { this.conversationGrants.delete(conversationId) }
}
