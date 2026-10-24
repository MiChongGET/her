import { randomUUID } from 'node:crypto'
import { isWeatherAction } from '../weather/tools'
import { messageActionFacts, messageActionCurrent, type MessageTarget } from '../tools/message-actions'
import { DeniedStepError } from '../tools/approval'
import type { HttpComparison } from './http-comparison'
import type { TopicInfo } from '../../shared/types'
import type { HerStore } from '../storage/store'
import type { ActionDescriptor, Delegation, DelegationControl, DelegationProducers, DelegationProposal, DelegationProgressEvidence, DelegationScope, UserIntent } from './types'

interface Dependencies extends DelegationProducers {
  onReady?: (control: DelegationControl) => void
}

function scopeComplete(scope: DelegationScope): boolean {
  return !!scope.purpose.trim() && !!scope.completion.trim() && scope.objects.length > 0 && scope.allowedCapabilities.length > 0 &&
    [...scope.objects, ...scope.allowedCapabilities, ...scope.origins].every(value => typeof value === 'string' && !!value.trim())
}

/** Host authority and lifecycle only. Per-action policy belongs to the common tool gate. */
export class DelegationService {
  constructor(private readonly store: HerStore, private readonly producers: Dependencies = {}, private readonly httpComparison?: HttpComparison) {}

  /** Description authority comes from the registry's compiled adapter, never from model fields. */
  decide(action: ActionDescriptor, intent?: UserIntent, localCandidate?: () => boolean): 'allow' | 'confirm' | 'deny' {
    try {
      this.assertCurrent(action, localCandidate)
      if (intent) this.trusted(intent)
    } catch { return 'deny' }
    if (isWeatherAction(action)) return 'allow'
    const message = messageActionFacts(action)
    if (intent && message && this.authorizeExactMessage(intent, message.target, message.text, action)) return 'allow'
    if (!action.delegationId || action.opaque) return 'confirm'
    const value = this.get(action.delegationId)
    if (action.confirmation === 'always' || !['read', 'interact'].includes(action.effect)) return 'confirm'
    if (!value.scope.objects.includes(action.targetId) || !value.scope.allowedCapabilities.includes(action.capability)) return 'confirm'
    if (value.scope.origins.length && (!action.origin || !value.scope.origins.includes(action.origin))) return 'confirm'
    if (Object.entries(value.scope.constraints).some(([key, expected]) => action.constraints?.[key] !== expected)) return 'confirm'
    return 'allow'
  }

  /** Boolean decisions never consume an instruction. Only a compiled, current ordinary-message proof qualifies. */
  authorizeExactMessage(intent: UserIntent, target: MessageTarget, finalText: string, action: ActionDescriptor): boolean {
    try {
      this.assertCurrent(action)
      const stored = this.trusted(intent), proof = messageActionFacts(action)
      if (!proof || !messageActionCurrent(action) || !action.delegationId || action.intentId !== stored.id || stored.kind === 'control' ||
        this.store.hasConsumedExactMessage(stored.id) || action.opaque || action.effect !== 'send' || action.businessEffect !== 'message.send' ||
        action.capability !== 'message.send' || JSON.stringify(proof.target) !== JSON.stringify(target) || proof.text !== finalText || !finalText ||
        stored.text !== `在${proof.channelName}里给${target.displayName}发：${finalText}`) return false
      const delegation = this.get(action.delegationId)
      return this.store.getTopicInfo(delegation.conversationId)?.kind === 'work' && action.conversationId === delegation.conversationId &&
        this.store.getIntentControl(stored.id)?.delegationId === delegation.id && delegation.scope.objects.includes(action.targetId) &&
        delegation.scope.allowedCapabilities.includes(action.capability) &&
        (!delegation.scope.origins.length || (!!action.origin && delegation.scope.origins.includes(action.origin))) &&
        Object.entries(delegation.scope.constraints).every(([key, value]) => action.constraints?.[key] === value)
    } catch { return false }
  }

  /** Called synchronously at the registry's final dispatch boundary, never from a decision or model tool. */
  consumeExactMessage(intentId: string, action: ActionDescriptor, call: { runId: string; callId: string; toolName: string; args: Record<string, unknown> }): void {
    const intent = this.store.getUserIntent(intentId), proof = messageActionFacts(action)
    if (!intent || !proof || !this.authorizeExactMessage(intent, proof.target, proof.text, action) ||
      call.args.recipientName !== proof.target.displayName || call.args.text !== proof.text || Object.keys(call.args).some(key => !['recipientName', 'text'].includes(key))) throw new Error('原样消息批准已失效或已经使用。')
    this.store.consumeExactMessage(intentId, action, call)
  }

  private matchesControl(action: ActionDescriptor, delegationIds: string[], intentIds: string[] = []): boolean {
    return (!!action.intentId && intentIds.includes(action.intentId)) || delegationIds.some(id => id === action.delegationId ||
      (!action.delegationId && !action.intentId && !!action.conversationId && this.store.getDelegation(id)?.conversationId === action.conversationId))
  }

  assertCurrent(action: ActionDescriptor, localCandidate?: () => boolean): void {
    for (const control of this.store.listPriorityControls()) {
      const held = [...control.heldDelegationIds, ...(control.selectedDelegationIds ?? []).filter(id => {
        const current = this.store.getDelegation(id)
        return control.status === 'resolved' && !!current && (current.status !== 'active' || current.resumeRequired)
      })]
      if (localCandidate?.() === true || !this.matchesControl(action, held, control.heldIntentIds) || control.status === 'ordinary') continue
      const uncertain = action.opaque || action.effect === 'unknown'
      const target = !control.targetIds || control.targetIds.includes(action.targetId)
      if (uncertain || (target && (control.effect === 'all' || action.effect !== 'read' ||
        (control.effect === 'budget' && action.constraints?.budget !== undefined)))) throw new Error('用户已暂停相关后续动作，等待确认；已发生的动作不会撤回。')
    }
    if (!action.delegationId) return
    const value = this.assertRunnable(action.delegationId)
    if (value.revision !== action.scopeRevision) throw new Error('委托版本已变化。')
    if (this.isDenied(action)) throw new DeniedStepError(action.id)
  }

  /** Old approvals stay invalid even after a mistaken hold is clarified and lifted. Reads remain independent. */
  controlVersion(action: ActionDescriptor): string {
    return JSON.stringify(this.store.listPriorityControls().filter(control => control.history !== 'ordinary' &&
      this.matchesControl(action, control.candidates.map(value => value.delegationId), control.candidateIntentIds) &&
      (!control.targetIds || control.targetIds.includes(action.targetId) || action.opaque) &&
      (action.opaque || action.effect !== 'read' || control.effect === 'all' || (control.effect === 'budget' && action.constraints?.budget !== undefined)))
      .map(control => [control.id, control.revision]))
  }

  observeAction(action: ActionDescriptor): void { this.store.saveDelegationActionFact(action) }

  isDenied(action: ActionDescriptor): boolean {
    if (!action.delegationId) return false
    const refusals = this.store.listDelegationDenials(action.delegationId).filter(value => !value.withdrawal)
    if (!refusals.length) return false
    // An opaque replacement cannot establish that it avoids a refused business step.
    if (action.opaque || action.effect === 'unknown' || !action.targetId) return true
    // Existing compiled public reads need no mutation business vocabulary.
    if (action.effect !== 'read' && !action.businessEffect?.trim()) return true
    return refusals.some(value => {
      // Old/opaque refusals have no reliable business identity; only a proven public read is independent.
      if (!value.businessEffect || value.effect === 'unknown') return action.effect !== 'read' || value.targetId === action.targetId
      // Data categories are recorded, but changing/omitting them cannot erase this refused effect on this object.
      return value.targetId === action.targetId && value.businessEffect === action.businessEffect
    })
  }

  reject(action: ActionDescriptor): void {
    this.assertCurrent(action)
    if (action.delegationId) this.store.saveDelegationDenial({ id: randomUUID(), delegationId: action.delegationId, scopeRevision: action.scopeRevision,
      targetId: action.targetId, businessEffect: action.businessEffect, effect: action.effect, dataClasses: [...new Set(action.dataClasses)].sort(),
      actionId: action.id, adapterId: action.adapterId, adapterRevision: action.adapterRevision, capability: action.capability, payloadHash: action.payloadHash })
  }

  /** Main-only: the producer must verify an explicit user revision, never merely a control classification. */
  reviseDeniedStep(id: string, revision: number, denialId: string, intentId: string, evidenceSpans: [number, number][]): Delegation {
    const current = this.current(id, revision), intent = this.store.getUserIntent(intentId)
    const denial = this.store.listDelegationDenials(id).find(value => value.id === denialId && !value.withdrawal)
    const origin = this.store.listDelegationControls().find(value => value.delegationId === id)
    const originalIntent = origin && this.store.getUserIntent(origin.intentId)
    if (!denial || !intent || intent.kind !== 'control' || (intent.conversationId !== current.conversationId && intent.conversationId !== originalIntent?.conversationId) ||
      !evidenceSpans.length || evidenceSpans.some(([start, end]) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > intent.text.length)) throw new Error('缺少明确修订这一步的用户依据。')
    this.trusted(intent)
    const proof = this.producers.validateDenialRevision?.(structuredClone(current), structuredClone(denial), structuredClone(intent), structuredClone(evidenceSpans))
    if (!proof || proof.decision !== 'withdraw-denial' || proof.delegationId !== id || proof.scopeRevision !== revision || proof.denialId !== denial.id ||
      proof.targetId !== denial.targetId || proof.businessEffect !== denial.businessEffect || proof.effect !== denial.effect ||
      JSON.stringify(proof.dataClasses) !== JSON.stringify(denial.dataClasses ?? []) || proof.intentId !== intent.id || proof.messageId !== intent.messageId ||
      JSON.stringify(proof.evidenceSpans) !== JSON.stringify(evidenceSpans)) throw new Error('尚无可信的明确修订依据。')
    const value = { ...current, revision: revision + 1, resumeRequired: true }
    this.store.reviseDelegationDenial(value, revision, denial, proof)
    return value
  }

  getProgressEvidence(conversationId: string): DelegationProgressEvidence[] {
    if (!this.store.hasConversation(conversationId) || this.store.getTopicInfo(conversationId)?.kind !== 'work') return []
    const observedAt = new Date().toISOString()
    return this.store.listDelegations().filter(value => value.conversationId === conversationId).map(value => {
      const control = this.store.listDelegationControls().find(control => control.delegationId === value.id)
      const intent = control && this.store.getUserIntent(control.intentId)
      const unknown = this.store.listDelegationUnknownEvidence(value.id)
      const terminal = value.status === 'completed' || value.status === 'cancelled'
      const task = this.store.getLatestDelegationTask(value.id)
      const confirmation = this.store.listPriorityControls().some(pending => ['classifying', 'waiting'].includes(pending.status) &&
        !pending.ownerResolutions?.[conversationId] &&
        (pending.heldDelegationIds.includes(value.id) || (!!intent && pending.heldIntentIds.includes(intent.id))))
      const pendingReason = unknown.length ? 'unknown' : !terminal && (task?.status === 'waiting_approval' || confirmation) ? 'approval'
        : !terminal && this.producers.revalidate?.(structuredClone(value)) !== true ? 'capability' : null
      return { delegationId: value.id, conversationId, revision: value.revision, status: value.status, pendingReason,
        completedActionCount: this.httpComparison?.getVerifiedReadCount(value) ?? 0, observedAt,
        evidenceRefs: [...(intent ? [{ kind: 'user-request' as const, id: intent.id }] : []), ...unknown.map(id => ({ kind: 'ledger' as const, id }))] }
    })
  }

  get(id: string): Delegation {
    const value = this.store.getDelegation(id)
    if (!value) throw new Error('找不到委托。')
    return value
  }

  private current(id: string, revision: number): Delegation {
    const value = this.get(id)
    if (value.revision !== revision) throw new Error('委托版本已变化。')
    if (value.status === 'cancelled' || value.status === 'completed') throw new Error('委托已经结束。')
    if (!this.store.hasConversation(value.conversationId)) throw new Error('话题不可用。')
    return value
  }

  private trusted(intent: UserIntent): UserIntent {
    const stored = this.store.getUserIntent(intent.id)
    if (!stored || stored.source !== 'user' || stored.messageId !== intent.messageId || stored.conversationId !== intent.conversationId || stored.text !== intent.text) throw new Error('用户依据无效。')
    if (!this.store.hasConversation(stored.conversationId)) throw new Error('用户依据已失效。')
    return stored
  }

  /** Public to host code; possession of a model-shaped intent is never itself a grant. */
  create(topic: TopicInfo, intent: UserIntent, scope: DelegationScope): Delegation {
    const stored = this.trusted(intent), control = this.store.getIntentControl(stored.id)
    if (topic.kind !== 'work' || this.store.getTopicInfo(topic.conversationId)?.kind !== 'work' || !control ||
      control.status !== 'approved' || !control.delegationId || control.conversationId !== topic.conversationId ||
      JSON.stringify(control.proposal.scope) !== JSON.stringify(scope)) throw new Error('委托范围尚未确认。')
    return this.get(control.delegationId)
  }

  pause(id: string, revision: number): Delegation {
    const value = { ...this.current(id, revision), status: 'paused' as const, revision: revision + 1 }
    this.store.updateDelegation(value, revision)
    return value
  }

  cancel(id: string, revision: number): Delegation {
    const value = { ...this.current(id, revision), status: 'cancelled' as const, resumeRequired: false, revision: revision + 1 }
    this.store.updateDelegation(value, revision)
    return value
  }

  /** Explicit host/user revision, never called by the model tool. */
  revise(id: string, revision: number, scope: DelegationScope): Delegation {
    if (!scopeComplete(scope)) throw new Error('请补全目的、对象和结束条件。')
    const value = { ...this.current(id, revision), scope: structuredClone(scope), revision: revision + 1, resumeRequired: true }
    this.store.updateDelegation(value, revision)
    return value
  }

  resume(id: string, revision: number, controls: { id: string; revision: number }[] = []): Delegation {
    const current = this.current(id, revision)
    if (this.producers.revalidate?.(structuredClone(current)) !== true) throw new Error('需要重新核对委托对象、范围和可用能力。')
    const value = { ...current, status: 'active' as const, resumeRequired: false, revision: revision + 1 }
    this.store.resumeDelegation(value, revision, controls)
    return value
  }

  assertRunnable(id: string): Delegation {
    const value = this.get(id)
    this.current(id, value.revision)
    if (value.status !== 'active' || value.resumeRequired) throw new Error('委托需要用户继续或重新确认。')
    return value
  }

  complete(id: string, revision: number): Delegation {
    const current = this.current(id, revision)
    const proof = this.producers.validateCompletion?.(structuredClone(current))
    if (!proof || proof.delegationId !== id || proof.scopeRevision !== revision || proof.condition !== current.scope.completion || !proof.evidenceId.trim()) throw new Error('尚无可核验的完成依据。')
    const value = { ...current, status: 'completed' as const, resumeRequired: false, revision: revision + 1 }
    this.store.updateDelegation(value, revision, proof)
    return value
  }

  attachRun(id: string, runId: string): void {
    const value = this.assertRunnable(id), task = this.store.getTask(runId)
    if (!task || task.conversationId !== value.conversationId) throw new Error('运行不属于此委托。')
    const existing = this.store.getDelegationForRun(runId)
    if (existing?.id === id) return
    this.store.attachDelegationRun(id, runId, value.revision)
  }

  admitIntent(intent: UserIntent, proposal: DelegationProposal): { conversationId: string; status: 'ready' | 'needs-confirmation'; delegationId?: string } {
    const stored = this.trusted(intent)
    let control = this.store.getIntentControl(stored.id)
    if (control?.status === 'rejected') throw new Error('此范围候选已拒绝。')
    if (!control) {
      if (!proposal.id || proposal.id.length > 128 || proposal.revision !== 1 || !proposal.evidenceSpans.length ||
        proposal.evidenceSpans.some(([start, end]) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > stored.text.length)) throw new Error('候选原文依据不正确。')
      const resolved = this.producers.resolveScope?.(structuredClone(stored), structuredClone(proposal))
      const selected = resolved?.topicId
      if (selected && (!this.store.hasConversation(selected) || this.store.getTopicInfo(selected)?.kind !== 'work')) throw new Error('工作话题不可用。')
      control = { id: proposal.id, intentId: stored.id, conversationId: selected ?? randomUUID(),
        proposal: structuredClone({ ...proposal, ...(resolved ? { scope: resolved.scope } : {}) }), revision: 1,
        status: 'waiting', requestId: randomUUID(), dispatch: 'pending' }
      this.store.insertDelegationControl(control)
      // The persisted target identity makes a retry after a crash reuse this same work topic.
      this.ensureTopic(control)
      if (resolved && scopeComplete(resolved.scope)) this.approveScope(control.id, 1)
    }
    this.ensureTopic(control)
    control = this.store.getDelegationControl(control.id)!
    if (control.status === 'approved') {
      const delegation = this.get(control.delegationId!)
      if (delegation.status === 'active' && !delegation.resumeRequired) this.producers.onReady?.(control)
      return { conversationId: control.conversationId, status: 'ready', delegationId: delegation.id }
    }
    return { conversationId: control.conversationId, status: 'needs-confirmation' }
  }

  private ensureTopic(control: DelegationControl): void {
    if (!this.store.getConversation(control.conversationId)) this.store.createWorkConversation(control.conversationId, randomUUID(), '新委托')
    if (!this.store.hasConversation(control.conversationId) || this.store.getTopicInfo(control.conversationId)?.kind !== 'work') throw new Error('工作话题不可用。')
  }

  approveScope(proposalId: string, revision: number): Delegation {
    const control = this.store.getDelegationControl(proposalId)
    if (!control || control.revision !== revision || control.status === 'rejected') throw new Error('范围候选已变化。')
    this.trusted(this.store.getUserIntent(control.intentId)!)
    this.ensureTopic(control)
    if (control.status === 'approved') return this.get(control.delegationId!)
    if (!scopeComplete(control.proposal.scope)) throw new Error('请补全目的、对象和结束条件。')
    const value: Delegation = { id: randomUUID(), conversationId: control.conversationId, scope: structuredClone(control.proposal.scope), revision: 1, status: 'active', resumeRequired: false }
    this.store.approveDelegationControl(control, value)
    this.producers.onReady?.(this.store.getDelegationControl(proposalId)!)
    return value
  }

  rejectScope(proposalId: string, revision: number): void {
    const control = this.store.getDelegationControl(proposalId)
    if (!control || control.revision !== revision || control.status !== 'waiting') throw new Error('范围候选已变化。')
    this.store.updateDelegationControl({ ...control, status: 'rejected', revision: revision + 1 }, revision)
  }
}
