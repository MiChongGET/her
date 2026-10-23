import { randomUUID } from 'node:crypto'
import type { ActionAssessment, ApprovalDecisionInput, ApprovalRequest } from '../../shared/types'
import type { ToolExecutionContext } from './types'

export class ApprovalError extends Error {}

/** actionId is main-only metadata; Pi receives only the continuation instruction in message. */
export class DeniedStepError extends ApprovalError {
  constructor(readonly actionId: string) {
    super('你已拒绝此步。继续不依赖这一步的其余获准工作；若无法继续，请说明原因并等待用户调整安排。')
    this.name = 'DeniedStepError'
  }
}

export class ToolApprovalService {
  private readonly pending = new Map<string, { request: ApprovalRequest; settle: (decision: ApprovalDecisionInput['decision']) => void }>()
  private readonly conversationGrants = new Map<string, Map<string, () => boolean>>()

  constructor(private readonly emit: (request: ApprovalRequest) => void = () => {}) {}

  async authorize(callId: string, assessment: ActionAssessment, context: ToolExecutionContext): Promise<void> {
    context.signal.throwIfAborted()
    const binding = context.approvalBinding
    if (!binding || !binding.validate()) throw new ApprovalError('动作确认已失效，请重新观察后继续。')
    const action = context.action
    const decision = action ? context.actionPolicy?.decide(action, context.intent, () => context.admitLocalCandidate?.(assessment, context) === true) ?? 'confirm' : 'confirm'
    if (decision === 'deny') throw new ApprovalError('动作授权已失效或已被拒绝。')
    if (decision === 'allow' || binding.localAdmission?.()) return
    const request: ApprovalRequest = { id: randomUUID(), runId: context.runId, callId,
      revision: binding.revision, target: action?.target ?? assessment.displayTarget ?? assessment.target,
      summary: action?.summary ?? assessment.summary, purpose: action?.purpose ?? '执行本次请求',
      preview: structuredClone(action?.preview ?? { fields: [] }), dataClasses: [...(action?.dataClasses ?? [])],
      providerName: action?.providerName, scopeSummary: action?.scopeSummary ?? '仅本次动作', actionLabel: action?.actionLabel ?? '执行一次' }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.pending.delete(request.id); context.signal.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); reject(context.signal.reason) }
      this.pending.set(request.id, { request, settle: decision => {
        if (context.signal.aborted) reject(context.signal.reason)
        else if (!binding.validate()) reject(new ApprovalError('动作确认已失效，请重新观察后继续。'))
        else if (decision === 'reject') {
          try { if (action) context.actionPolicy?.reject(action) }
          catch (error) { cleanup(); reject(error); return }
          reject(new DeniedStepError(action?.id ?? callId))
        }
        else {
          resolve()
        }
        cleanup()
      } })
      context.signal.addEventListener('abort', abort, { once: true })
      context.onApproval?.(request)
      this.emit(request)
    }).finally(() => context.onApproval?.())
    context.signal.throwIfAborted()
    if (!binding.validate()) throw new ApprovalError('动作确认已失效，请重新观察后继续。')
  }

  decide(input: ApprovalDecisionInput): void {
    if (!input || !['approve', 'reject'].includes(input.decision)) return
    const pending = this.pending.get(input.approvalId)
    if (!pending || pending.request.revision !== input.revision) return
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
