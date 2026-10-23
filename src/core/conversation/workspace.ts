import { createHash, randomUUID } from 'node:crypto'
import type {
  ChatEvent, PendingActionNotice, RequestEvent, TaskEvent, WorkspaceChatEvent,
  WorkspaceListItem, WorkspaceRequestEvent, WorkspaceSelection, WorkspaceSnapshot, WorkspaceTaskEvent
} from '../../shared/types'
import type { HerStore, StoredConversation } from '../storage/store'
import type { ChatService } from './chat'

interface PendingEntry {
  conversationId: string
  fingerprint: string
  deliveryFingerprint: string
  notice: PendingActionNotice
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('对象标识不正确。')
  return value
}

function objectInput(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new Error('工作区参数不正确。')
  return input as Record<string, unknown>
}

function summary(conversation: StoredConversation) {
  return { id: conversation.id, title: conversation.title, titleCustom: conversation.titleCustom,
    createdAt: conversation.createdAt.toISOString(), updatedAt: conversation.updatedAt.toISOString(), lastMessage: '' }
}

/** Renderer detail authority belongs to one current selection, never to a pending notice. */
export class WorkspaceService {
  private selection: WorkspaceSelection | null = null
  private version = 0
  private readyVersion: number | null = null
  private pendingOpen: PendingActionNotice | null = null
  private pending = new Map<string, PendingEntry>()

  constructor(private readonly store: HerStore, private readonly chat: ChatService) {}

  async select(input: WorkspaceSelection): Promise<WorkspaceSnapshot> {
    const value = objectInput(input, ['section', 'conversationId'])
    if (value.section !== 'daily' && value.section !== 'work' && value.section !== 'memory') throw new Error('工作区不正确。')
    const requestedId = value.conversationId === undefined ? undefined : identifier(value.conversationId)
    if (value.section === 'memory' && requestedId !== undefined) throw new Error('记忆说明页没有对话。')
    let conversationId = requestedId
    if (value.section === 'daily') {
      conversationId = this.store.ensureDailyConversation().id
      if (requestedId !== undefined && requestedId !== conversationId) throw new Error('话题不属于此工作区。')
    } else if (conversationId !== undefined && value.section === 'work' && this.store.getTopicInfo(conversationId)?.kind !== 'work') {
      throw new Error('话题不属于此工作区。')
    }
    const conversation = conversationId === undefined ? null : this.store.getConversation(conversationId)
    if (conversationId !== undefined && (!conversation || conversation.deletedAt)) throw new Error('话题不可用。')
    if (conversationId !== undefined && this.store.getTopicHandoffForConversation(conversationId)?.status !== undefined && this.store.getTopicHandoffForConversation(conversationId)?.status !== 'created') throw new Error('话题仍在保存中。')
    const selection: WorkspaceSelection = { section: value.section, ...(conversationId === undefined ? {} : { conversationId }) }
    this.selection = selection
    const version = ++this.version
    this.readyVersion = null
    const workItems = selection.section === 'work' ? this.listWorkItems() : []
    let messages: WorkspaceSnapshot['messages'] = []
    if (conversationId !== undefined) {
      try { messages = await this.chat.getMessages(conversationId) }
      catch (error) { if (this.version !== version) throw new Error('界面已切换。'); throw error }
      if (this.version !== version) throw new Error('界面已切换。')
      if (this.selection?.conversationId !== conversationId || !this.store.hasConversation(conversationId)) throw new Error('请先进入原话题。')
    }
    if (this.version !== version) throw new Error('界面已切换。')
    this.readyVersion = version
    const task = conversationId === undefined ? null : this.chat.getConversationTask(conversationId)
    const activeRequest = conversationId === undefined ? null : this.chat.getActiveRequest(conversationId)
    return { selection: { ...selection }, version, activeRequest: activeRequest?.conversationId === conversationId ? activeRequest : null, conversation: conversation ? summary(conversation) : null,
      topic: conversationId === undefined ? null : this.store.getTopicInfo(conversationId),
      messages: messages.filter(message => message.conversationId === conversationId),
      task: task && this.ownsTask(task, conversationId!) ? task : null, workItems }
  }

  listWorkItems(): WorkspaceListItem[] {
    if (this.selection?.section !== 'work') throw new Error('请先进入工作区。')
    return this.store.listConversations()
      .filter(item => this.store.getTopicInfo(item.id)?.kind === 'work' && (!this.store.getTopicHandoffForConversation(item.id) || this.store.getTopicHandoffForConversation(item.id)?.status === 'created'))
      .map(item => ({ conversation: summary(item), topic: this.store.getTopicInfo(item.id) }))
  }

  assertSelected(conversationId: string): void {
    identifier(conversationId)
    if (!this.isSelected(conversationId)) throw new Error('请先进入原话题。')
  }

  getPendingActions(): PendingActionNotice[] {
    const current = new Map<string, PendingEntry>()
    for (const conversation of this.store.listConversations()) {
      const task = this.chat.getConversationTask(conversation.id)
      if (!task || !this.ownsTask(task, conversation.id)) continue
      const delegation = this.store.getDelegationForRun(task.run.id)
      if (delegation && ['completed', 'cancelled'].includes(delegation.status) && !task.unknownCalls?.length) continue
      const status: PendingActionNotice['status'] | null = task.unknownCalls?.length ? 'unknown'
        : task.run.status === 'waiting_approval' ? 'waiting_approval'
        : ['paused', 'stopped', 'failed', 'interrupted'].includes(task.run.status) ? 'paused' : null
      if (!status) continue
      // Deliberately exclude seq, elapsed time, titles and all business text.
      const fingerprint = JSON.stringify([conversation.id, task.run.id, task.requestId, task.generation,
        task.run.status, status, task.approval ? [task.approval.id, task.approval.runId, task.approval.callId, task.approval.revision] : null,
        task.unknownCalls?.map(call => [call.runId, call.callId, call.revision]).sort() ?? []])
      const previous = this.pending.get(task.run.id)
      const notice = previous?.fingerprint === fingerprint ? previous.notice
        : { id: previous?.notice.id ?? randomUUID(), status, version: (previous?.notice.version ?? 0) + 1 }
      const deliveryFingerprint = createHash('sha256').update(JSON.stringify([conversation.id, task.run.id, status,
        task.approval ? [task.approval.id, task.approval.callId, task.approval.revision] : null,
        task.unknownCalls?.map(call => [call.runId, call.callId, call.revision]).sort() ?? []])).digest('hex')
      current.set(task.run.id, { conversationId: conversation.id, fingerprint, deliveryFingerprint, notice })
    }
    for (const proposal of this.chat.getPendingDelegationActions()) {
      const key = proposal.id, fingerprint = JSON.stringify([proposal.id, proposal.conversationId, proposal.revision])
      const previous = this.pending.get(key)
      const notice: PendingActionNotice = previous?.fingerprint === fingerprint ? previous.notice
        : { id: previous?.notice.id ?? randomUUID(), status: proposal.status, version: (previous?.notice.version ?? 0) + 1 }
      current.set(key, { conversationId: proposal.conversationId, fingerprint,
        deliveryFingerprint: createHash('sha256').update(fingerprint).digest('hex'), notice })
    }
    this.pending = current
    return [...current.values()].map(entry => ({ ...entry.notice }))
  }

  async resolvePendingAction(input: { id: string; version: number }): Promise<{ conversationId: string } | null> {
    const value = objectInput(input, ['id', 'version']), id = identifier(value.id)
    if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version <= 0) throw new Error('待处理版本不正确。')
    this.getPendingActions()
    const entry = [...this.pending.values()].find(item => item.notice.id === id && item.notice.version === value.version)
    return entry ? { conversationId: entry.conversationId } : null
  }

  /** Main-process only; never exposed by the renderer notice contract. */
  notificationFingerprint(notice: PendingActionNotice): string | null {
    const entry = [...this.pending.values()].find(item => item.notice.id === notice.id && item.notice.version === notice.version)
    return entry?.deliveryFingerprint ?? null
  }

  notificationRunFingerprint(notice: PendingActionNotice): string | null {
    const entry = [...this.pending.entries()].find(([, item]) => item.notice.id === notice.id && item.notice.version === notice.version)
    return entry ? createHash('sha256').update(JSON.stringify(['notification-run', entry[0]])).digest('hex') : null
  }

  queuePendingActionOpen(notice: PendingActionNotice): void { this.pendingOpen = { ...notice } }

  async getPendingActionOpen(): Promise<PendingActionNotice | null> {
    const notice = this.pendingOpen
    if (!notice) return null
    if (await this.resolvePendingAction({ id: notice.id, version: notice.version })) return { ...notice }
    if (this.pendingOpen === notice) this.pendingOpen = null
    return null
  }

  ackPendingActionOpen(input: { id: string; version: number }): void {
    const value = objectInput(input, ['id', 'version'])
    const id = identifier(value.id)
    if (!Number.isSafeInteger(value.version) || (value.version as number) <= 0) throw new Error('待处理版本不正确。')
    if (this.pendingOpen?.id === id && this.pendingOpen.version === value.version) this.pendingOpen = null
  }

  routeChat(event: ChatEvent): WorkspaceChatEvent | null {
    return this.isSelected(event.conversationId) && event.message.conversationId === event.conversationId &&
      (!event.task || this.ownsTask(event.task, event.conversationId)) ? { selectionVersion: this.version, event } : null
  }

  routeRequest(event: RequestEvent): WorkspaceRequestEvent | null {
    return this.isSelected(event.conversationId) ? { selectionVersion: this.version, event } : null
  }

  routeTask(event: TaskEvent): WorkspaceTaskEvent | null {
    return this.isSelected(event.conversationId) && this.ownsTask(event, event.conversationId) ? { selectionVersion: this.version, event } : null
  }

  private isSelected(conversationId: string): boolean {
    return this.readyVersion === this.version && this.selection?.conversationId === conversationId && this.store.hasConversation(conversationId)
  }

  private ownsTask(task: TaskEvent, conversationId: string): boolean {
    return task.conversationId === conversationId && task.run.conversationId === conversationId
  }
}
