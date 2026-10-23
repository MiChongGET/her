// Task 10.3: ChatService 重写为 AgentHost 的轻量包装层。
// 保持 IPC 接口不变，内部委托给 AgentHost 处理并行会话。

import { randomUUID } from 'node:crypto'
import type {
  SendMessageInput,
  SendMessageResult,
  ContinueTaskInput,
  ApprovalDecisionInput,
  ResolveUnknownToolCallInput,
  TaskEvent,
  RequestEvent,
  ChatEvent,
  ChatMessage,
  ConversationQueueState,
  DelegationDetails
} from '../../shared/types'
import type { HerStore } from '../storage/store'
import type { ControlChoice } from '../delegations/types'
import type { AgentHost } from '../agent/host'

/**
 * ChatService: IPC 入口层，桥接前端请求到 AgentHost。
 *
 * 职责：
 * - 接收 IPC 请求（send, continueTask, cancel, approve）
 * - 委托给 AgentHost 处理
 * - 返回结果给前端
 * - 维护当前活动请求的映射（用于 cancelActive, getActiveRequest）
 */
export class ChatService {
  constructor(
    private readonly store: HerStore,
    private readonly host?: AgentHost,
    private readonly onChat: (event: ChatEvent) => void = () => {},
    private readonly onRequest: (event: RequestEvent) => void = () => {}
  ) {}

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.getMessages(conversationId)
  }

  async readTopicHandoffCandidates(conversationId: string, messageIds: string[]) {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.readTopicHandoffCandidates(conversationId, messageIds)
  }

  async saveTopicHandoffBackground(conversationId: string, operationId: string, preview: import('../../shared/types').TopicHandoffPreview, receiverKey: string): Promise<string> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.saveTopicHandoffBackground(conversationId, operationId, preview, receiverKey)
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.send(input, this.onChat, this.onRequest, this.store.getSettings().systemPrompt || SYSTEM)
  }

  /** Private main-process source; WorkspaceService only exposes opaque notices. */
  getPendingDelegationActions() {
    const scopes = this.store.listDelegationControls().filter(control => control.status === 'waiting' && this.store.hasConversation(control.conversationId))
      .map(control => ({ id: `scope:${control.id}`, conversationId: control.conversationId, revision: control.revision, status: 'waiting_approval' as const }))
    const paused = this.store.listDelegations().filter(value => {
      if (!this.store.hasConversation(value.conversationId) || this.store.getTopicInfo(value.conversationId)?.kind !== 'work' || !['active', 'paused'].includes(value.status)) return false
      if (this.store.listUnresolvedToolCalls(value.conversationId).length || value.scope.objects.some(target => this.store.isTargetQuarantined(target))) return false
      const task = this.store.getLatestTask(value.conversationId)
      const delegated = this.store.getLatestDelegationTask(value.id)
      const active = this.getActiveRequest(value.conversationId)
      // A durable no-task admission failure publishes before Host removes its admission marker.
      const failedAdmission = active && !delegated && this.store.getInput(active.requestId)?.status === 'cancelled' &&
        this.store.listDelegationControls().some(control => control.delegationId === value.id && control.requestId === active.requestId && control.dispatch === 'failed')
      if (active && !failedAdmission) return false
      const unfinished = delegated?.conversationId === value.conversationId && ['stopped', 'failed', 'interrupted', 'completed'].includes(delegated.status) &&
        (task?.id === delegated.id || (task?.status === 'completed' && !this.store.getDelegationForRun(task.id)))
      if (delegated && !unfinished) return false
      if (!value.resumeRequired && value.status !== 'paused' && !unfinished) return false
      return !task || !['waiting_approval', 'stopped', 'failed', 'interrupted'].includes(task.status)
    }).map(value => ({ id: `delegation:${value.id}`, conversationId: value.conversationId, revision: value.revision, status: 'paused' as const }))
    const controls = this.store.listPriorityControls().flatMap(control => {
      if (!['waiting', 'classifying'].includes(control.status) && !control.heldDelegationIds.length && !control.heldIntentIds.length) return []
      const entries = control.candidates.filter(candidate => control.heldDelegationIds.includes(candidate.delegationId)).flatMap(candidate => {
        const delegation = this.store.getDelegation(candidate.delegationId)
        return delegation && this.store.hasConversation(delegation.conversationId) ? [{ id: `control:${control.id}:${delegation.id}`, conversationId: delegation.conversationId, revision: control.revision, status: 'paused' as const }] : []
      })
      for (const owner of new Set(control.heldIntentIds.map(id => this.store.getOrdinaryWorkInputOwner(id)).filter((id): id is string => !!id))) {
        if (this.store.hasConversation(owner)) entries.push({ id: `control:${control.id}:input:${owner}`, conversationId: owner, revision: control.revision, status: 'paused' })
      }
      if (control.heldIntentIds.some(id => {
        if (this.store.getOrdinaryWorkInputOwner(id)) return false
        const binding = this.store.getIntentControl(id)
        const delegation = binding?.delegationId && this.store.getDelegation(binding.delegationId)
        return !delegation || !this.store.hasConversation(delegation.conversationId)
      }) && this.store.hasConversation(control.conversationId)) entries.push({ id: `control:${control.id}:pending`, conversationId: control.conversationId, revision: control.revision, status: 'paused' })
      return entries
    })
    return [...scopes, ...paused, ...controls]
  }

  getDelegationDetails(conversationId: string): DelegationDetails {
    const delegations = this.store.listDelegations().filter(value => value.conversationId === conversationId)
    const task = this.store.getLatestTask(conversationId)
    return {
      conversationId,
      delegations: delegations.map(value => {
        const delegated = this.store.getLatestDelegationTask(value.id)
        return { ...value, resumeControls: this.store.getDelegationResumeControls(value.id), canResume: ['active', 'paused'].includes(value.status) &&
          !this.getActiveRequest(conversationId) && !this.store.listUnresolvedToolCalls(conversationId).length && !value.scope.objects.some(target => this.store.isTargetQuarantined(target)) &&
          (!delegated || (['stopped', 'failed', 'interrupted', 'completed'].includes(delegated.status) &&
            (task?.id === delegated.id || (task?.status === 'completed' && !this.store.getDelegationForRun(task.id))))) }
      }),
      scopes: this.store.listDelegationControls().filter(value => value.conversationId === conversationId && value.status === 'waiting')
        .map(value => ({ id: value.id, revision: value.revision, scope: value.proposal.scope })),
      controls: this.store.listPriorityControls().flatMap(control => {
        const resolution = control.ownerResolutions?.[conversationId]
        const hasOwnedInputs = control.heldIntentIds.some(id => this.store.getOrdinaryWorkInputOwner(id) === conversationId)
        if (resolution && resolution !== 'pause' && !hasOwnedInputs) return []
        if (!['waiting', 'classifying'].includes(control.status) && !control.heldDelegationIds.length && !control.heldIntentIds.length) return []
        const candidates = control.candidates.flatMap(candidate => {
          const value = this.store.getDelegation(candidate.delegationId)
          if ((!control.heldDelegationIds.includes(candidate.delegationId) && !control.heldIntentIds.some(id => this.store.getIntentControl(id)?.delegationId === candidate.delegationId)) || !value || value.conversationId !== conversationId) return []
          return [{ delegationId: value.id, scopeRevision: candidate.revision, currentRevision: value.revision, purpose: value.scope.purpose,
            denials: this.store.listDelegationDenials(value.id).filter(denial => !denial.withdrawal).map(denial => ({
              id: denial.id, target: this.store.listDelegationActionFacts().find(fact => fact.delegationId === value.id && fact.targetId === denial.targetId)?.target ?? denial.targetId,
              capability: denial.capability, businessEffect: denial.businessEffect, dataClasses: denial.dataClasses ?? [] })) }]
        })
        if (!candidates.length && !hasOwnedInputs) return []
        const selection = control.selection && !control.selection.confirmed && candidates.some(candidate => candidate.delegationId === control.selection!.delegationId)
          ? { delegationId: control.selection.delegationId, scopeRevision: control.selection.scopeRevision, denialId: control.selection.denialId } : undefined
        return [{ id: control.id, revision: control.revision, kind: control.kind, effect: control.effect, budget: control.budget, resolution, hasOwnedInputs, candidates, selection }]
      })
    }
  }

  pauseDelegation(id: string, revision: number): void {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    const delegation = this.host.delegations.pause(id, revision)
    const active = this.host.getActiveRequest(delegation.conversationId)
    if (active && (this.store.getDelegationInput(active.requestId)?.delegationId === id || this.store.listDelegationControls().some(control => control.delegationId === id && control.requestId === active.requestId))) this.host.stopRequest(active.requestId)
  }

  cancelDelegation(id: string, revision: number): void {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    const delegation = this.host.delegations.cancel(id, revision)
    const active = this.host.getActiveRequest(delegation.conversationId)
    if (active && (this.store.getDelegationInput(active.requestId)?.delegationId === id || this.store.listDelegationControls().some(control => control.delegationId === id && control.requestId === active.requestId))) this.host.stopRequest(active.requestId)
  }

  rejectDelegationScope(id: string, revision: number): void {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    this.host.delegations.rejectScope(id, revision)
  }

  resolveControlForOwner(controlId: string, owner: string, choice: ControlChoice): Promise<void> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.resolveControlForOwner(controlId, owner, choice)
  }

  resolveControl(controlId: string, choice: ControlChoice): Promise<void> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.resolveControl(controlId, choice)
  }

  prepareDenialRevision(controlId: string, conversationId: string, delegationId: string, revision: number, denialId: string) {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.prepareDenialRevision(controlId, conversationId, delegationId, revision, denialId)
  }

  confirmDenialRevision(controlId: string, conversationId: string, revision: number): Promise<void> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.confirmDenialRevision(controlId, conversationId, revision)
  }

  approveDelegationScope(proposalId: string, revision: number) {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.approveDelegationScope(proposalId, revision, { onChat: this.onChat, onRequest: this.onRequest, systemPrompt: this.store.getSettings().systemPrompt || SYSTEM })
  }

  async resumeDelegation(id: string, revision: number, assertSelected: () => void = () => {}, controls: { id: string; revision: number }[] = []) {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.resumeDelegation(id, revision, { onChat: this.onChat, onRequest: this.onRequest, systemPrompt: this.store.getSettings().systemPrompt || SYSTEM }, assertSelected, controls)
  }

  /**
   * 继续被中断或等待审批的任务。
   */
  async continueTask(input: ContinueTaskInput, assertSelected?: () => void): Promise<SendMessageResult> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')

    const systemPrompt = this.store.getSettings()?.systemPrompt || SYSTEM
    return this.host.continueTask(input, this.onChat, this.onRequest, systemPrompt, assertSelected ? { beforeResume: assertSelected, beforeAdmission: assertSelected } : undefined)
  }

  /**
   * 取消当前活动请求。
   */
  cancelActive(): void {
    const request = this.host?.getActiveRequest()
    if (request) this.host!.stopRequest(request.requestId)
  }

  cancel(requestId: string): void { this.host?.stopRequest(requestId) }

  /**
   * 审批决策（批准或拒绝工具调用）。
   */
  async decideApproval(input: ApprovalDecisionInput): Promise<void> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.decideApproval(input)
  }

  /**
   * 解决未知工具调用（用户提供结果）。
   */
  resolveUnknownToolCall(input: ResolveUnknownToolCallInput): TaskEvent | null {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.resolveUnknownToolCall(input)
  }

  /**
   * 撤销会话的所有审批。
   */
  revokeConversationApprovals(conversationId: string): void {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    this.host.revokeConversationApprovals(conversationId)
  }

  /**
   * 获取当前活动请求。
   */
  getActiveRequest(conversationId?: string): { requestId: string; conversationId: string } | null {
    return this.host?.getActiveRequest(conversationId) ?? null
  }

  /**
   * 获取会话的当前任务状态。
   */
  getConversationTask(conversationId: string): TaskEvent | null {
    if (!this.host) return null
    return this.host.getConversationTask(conversationId)
  }

  getConversationContext(input: { conversationId: string; profileId: string; model?: string }) {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.getConversationContext(input)
  }

  /** 会话的排队消息、是否暂停及原因。 */
  getQueue(conversationId: string): ConversationQueueState {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.getQueue(conversationId)
  }

  cancelQueued(conversationId: string, requestId: string): void {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    this.host.cancelQueued(conversationId, requestId)
  }

  resumeQueue(conversationId: string): void {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    this.host.resumeQueue(conversationId, { onChat: this.onChat, onRequest: this.onRequest, systemPrompt: this.store.getSettings().systemPrompt || SYSTEM })
  }

  async compact(input: { conversationId: string; profileId: string; model?: string }): Promise<void> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.compactConversation(input, this.onChat, this.onRequest, this.store.getSettings().systemPrompt || SYSTEM)
  }

  stopCompaction(conversationId: string): void { this.host?.stopCompaction(conversationId) }

  async switchModel(input: { conversationId: string; profileId: string; model?: string }): Promise<void> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.switchModel(input)
  }

  /** 移入回收站：先关闭派发资格，再停止该会话任务和队列，释放句柄与专属连接；其他会话不受影响。 */
  async trashConversation(conversationId: string): Promise<void> {
    await this.host?.trash(conversationId)
    this.store.trashConversation(conversationId)
  }

  async purgeConversations(ids: string[]): Promise<void> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    await this.host.purgeConversations(ids)
  }

  /** 从回收站恢复：只允许查看，不自动续跑或恢复旧审批。 */
  restoreConversation(conversationId: string) {
    const summary = this.store.restoreConversation(conversationId)
    this.host?.restoreForViewing(conversationId)
    return summary
  }

  /**
   * 优雅关闭（停止所有任务）。
   */
  async shutdown(): Promise<void> {
    await this.host?.stopAll()
  }
}

// System prompt (moved from old ChatService)
export const SYSTEM = [
  '你是 Samantha，Her 内置的私人 AI 助手。你的名字来自电影《Her》中的 AI 助手。你的目标是在不受工具能力限制时帮助用户完成任务。',
  '如果用户的请求超出了可用工具的范围，明确说明限制，并在合理的情况下提供替代方案。',
  '在桌面环境中，你可以访问工具来读取和编辑文件、运行命令和与系统交互。',
  '始终确保你的操作是安全和可逆的。在执行可能产生持久影响的操作之前，先征求用户的确认。',
  '当需要专业判断（医疗、法律、财务）时，能力不足时明确提示用户切换。',
  '没有实际执行依据时，不声称已经设置提醒、保存文件或完成外部操作。'
].join('\n')
