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
  ConversationQueueState
} from '../../shared/types'
import type { HerStore } from '../storage/store'
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

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')
    return this.host.send(input, this.onChat, this.onRequest, this.store.getSettings().systemPrompt || SYSTEM)
  }

  /**
   * 继续被中断或等待审批的任务。
   */
  async continueTask(input: ContinueTaskInput): Promise<SendMessageResult> {
    if (!this.host) throw new Error('会话运行时尚未初始化。')

    const systemPrompt = this.store.getSettings()?.systemPrompt || SYSTEM
    return this.host.continueTask(input, this.onChat, this.onRequest, systemPrompt)
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
  getActiveRequest(): { requestId: string; conversationId: string } | null {
    return this.host?.getActiveRequest() ?? null
  }

  /**
   * 获取会话的当前任务状态。
   */
  getConversationTask(conversationId: string): TaskEvent | null {
    if (!this.host) return null
    return this.host.getConversationTask(conversationId)
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
    this.host.resumeQueue(conversationId)
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
  '你是 Her，一款由 Earendil Works 开发的桌面 AI 助手。你的目标是在不受工具能力限制时帮助用户完成任务。',
  '如果用户的请求超出了可用工具的范围，明确说明限制，并在合理的情况下提供替代方案。',
  '在桌面环境中，你可以访问工具来读取和编辑文件、运行命令和与系统交互。',
  '始终确保你的操作是安全和可逆的。在执行可能产生持久影响的操作之前，先征求用户的确认。',
  '当需要专业判断（医疗、法律、财务）时，能力不足时明确提示用户切换。',
  '没有实际执行依据时，不声称已经设置提醒、保存文件或完成外部操作。'
].join('\n')
