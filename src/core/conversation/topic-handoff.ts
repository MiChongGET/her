import { createHash, randomUUID } from 'node:crypto'
import type { MemorySourceDependencies, TopicHandoffOperation, TopicHandoffPreview } from '../../shared/types'
import type { HerStore, StoredTopicHandoff } from '../storage/store'
import type { ChatService } from './chat'
import type { WorkspaceService } from './workspace'

interface TopicHandoffCandidate {
  excerpt: TopicHandoffPreview['excerpts'][number]
  sessionId: string
  entryId: string
  contentDigest: string
  dependencies: MemorySourceDependencies
  provenanceComplete: boolean
  receiverKeys: string[]
}

interface HeldPreview { preview: TopicHandoffPreview; candidates: TopicHandoffCandidate[]; receiverKey: string }

export function topicHandoffReceiver(store: HerStore, id = store.getSettings().activeProfileId): { key: string; label: string } | null {
  const service = id ? store.getService(id) : null
  if (!service) return null
  const key = createHash('sha256').update(JSON.stringify([service.id, service.protocol, service.baseUrl,
    service.authMethod, service.sealedSecrets, service.revision])).digest('hex')
  return { key, label: service.name }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A confirmed handoff is a durable local operation, independent of navigation and model execution. */
export class TopicHandoffService {
  private readonly previews = new Map<string, HeldPreview>()
  private readonly committing = new Map<string, { operationId: string; result: Promise<TopicHandoffOperation> }>()
  private readonly recovering = new Map<string, Promise<void>>()
  constructor(private readonly store: HerStore, private readonly chat: ChatService, private readonly workspace: WorkspaceService) {}

  async preview(input: { conversationId: string; messageIds: string[] }): Promise<TopicHandoffPreview> {
    const daily = this.store.ensureDailyConversation()
    if (input.conversationId !== daily.id || !Array.isArray(input.messageIds) || input.messageIds.length < 1 || input.messageIds.length > 6 ||
      new Set(input.messageIds).size !== input.messageIds.length || input.messageIds.some(id => typeof id !== 'string' || !id || id.length > 128)) throw new Error('请选择最多六条日常交流。')
    this.workspace.assertSelected(daily.id)
    const receiver = topicHandoffReceiver(this.store)
    if (!receiver) throw new Error('请先配置模型服务，再预览带入话题的背景。')
    const originals = await this.chat.readTopicHandoffCandidates(daily.id, input.messageIds)
    this.workspace.assertSelected(daily.id)
    if (topicHandoffReceiver(this.store)?.key !== receiver.key) throw new Error('模型服务已变化，请重新预览。')
    const candidates: TopicHandoffCandidate[] = originals.filter(item => item.role === 'user' || !!item.receiverKey).map(item => ({ excerpt: { messageId: item.messageId, role: item.role, text: item.text, createdAt: item.createdAt },
      sessionId: daily.piSessionId, entryId: item.entryId, contentDigest: item.contentDigest,
      dependencies: { memorySources: [], fileSources: {} }, provenanceComplete: true, receiverKeys: [item.role === 'assistant' ? item.receiverKey! : receiver.key] }))
    const length = candidates.reduce((size, item) => size + Array.from(item.excerpt.text).length, 0)
    if (length > 6000) throw new Error('所选内容超过 6000 字，请缩小范围。')
    if (!candidates.length) throw new Error('所选交流没有可安全带入的原话，请改选不含资料的日常文字。')
    const preview: TopicHandoffPreview = { id: randomUUID(), digest: digest([daily.id, receiver.key, candidates]),
      sourceConversationId: daily.id, excerpts: candidates.map(item => item.excerpt), receiverLabel: receiver.label,
      omittedCount: input.messageIds.length - candidates.length,
      crossServiceReplyCount: candidates.filter(item => item.excerpt.role === 'assistant' && item.receiverKeys[0] !== receiver.key).length }
    this.previews.set(preview.id, { preview, candidates, receiverKey: receiver.key })
    return preview
  }

  async commit(input: { operationId: string; previewId: string; digest: string }): Promise<TopicHandoffOperation> {
    const pending = this.committing.get(input.previewId)
    if (pending) {
      if (pending.operationId !== input.operationId) throw new Error('这次预览正在由另一项确认保存，请核实原操作。')
      return pending.result
    }
    const result = this.commitOne(input).finally(() => this.committing.delete(input.previewId))
    this.committing.set(input.previewId, { operationId: input.operationId, result })
    return result
  }

  private async commitOne(input: { operationId: string; previewId: string; digest: string }): Promise<TopicHandoffOperation> {
    if (![input.operationId, input.previewId, input.digest].every(value => typeof value === 'string' && !!value && value.length <= 128)) throw new Error('确认参数不正确。')
    const existing = this.store.getTopicHandoff(input.operationId)
    if (existing) {
      if (existing.previewId !== input.previewId || existing.digest !== input.digest) throw new Error('同一次确认的内容已变化。')
      if (existing.status === 'failed' && existing.errorCode === 'storage-failed') this.store.retryTopicHandoff(input.operationId)
      if (this.store.getTopicHandoff(input.operationId)?.status === 'preparing') await this.recoverOne(existing)
      return this.result(this.store.getTopicHandoff(input.operationId)!)
    }
    const held = this.previews.get(input.previewId)
    if (!held || held.preview.digest !== input.digest) throw new Error('预览已失效，请重新预览。')
    this.workspace.assertSelected(held.preview.sourceConversationId)
    if (topicHandoffReceiver(this.store)?.key !== held.receiverKey) throw new Error('接收服务已变化，请重新预览。')
    if (!await this.sourceMatches(held.candidates, held.preview.sourceConversationId)) throw new Error('来源已变化，请重新预览。')
    const persisted = this.store.getTopicHandoff(input.operationId)
    if (persisted) {
      if (persisted.previewId !== input.previewId || persisted.digest !== input.digest) throw new Error('同一次确认的内容已变化。')
      if (persisted.status === 'preparing') await this.recoverOne(persisted)
      return this.result(this.store.getTopicHandoff(input.operationId)!)
    }
    const operation: StoredTopicHandoff = { operationId: input.operationId, previewId: input.previewId, digest: input.digest,
      sourceConversationId: held.preview.sourceConversationId, sourceSessionId: held.candidates[0].sessionId, conversationId: randomUUID(), piSessionId: randomUUID(), receiverKey: held.receiverKey,
      excerpts: held.candidates.map(item => ({ messageId: item.excerpt.messageId, role: item.excerpt.role, entryId: item.entryId, text: item.excerpt.text,
        createdAt: item.excerpt.createdAt, contentDigest: item.contentDigest,
        ...(item.excerpt.role === 'assistant' ? { sourceReceiverKey: item.receiverKeys[0] } : {}) })), status: 'preparing', errorCode: null, piEntryId: null }
    this.store.insertTopicHandoff(operation)
    this.previews.delete(input.previewId)
    await this.recoverOne(operation)
    return this.result(this.store.getTopicHandoff(input.operationId)!)
  }

  async getOperation(operationId: string): Promise<TopicHandoffOperation | null> {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 128) throw new Error('操作标识不正确。')
    const value = this.store.getTopicHandoff(operationId)
    if (value?.status === 'preparing') await this.recoverOne(value)
    const current = this.store.getTopicHandoff(operationId)
    return current ? this.result(current) : null
  }

  async recover(): Promise<void> {
    for (const operation of this.store.listPreparingTopicHandoffs()) await this.recoverOne(operation)
  }

  private async sourceMatches(candidates: TopicHandoffCandidate[], conversationId: string): Promise<boolean> {
    const conversation = this.store.getConversation(conversationId)
    if (!conversation || conversation.deletedAt || candidates.some(item => !item.provenanceComplete || item.sessionId !== conversation.piSessionId ||
      item.dependencies.memorySources.length || item.dependencies.fileSources.fileIds?.length || item.dependencies.fileSources.grants?.length)) return false
    const current = await this.chat.readTopicHandoffCandidates(conversationId, candidates.map(item => item.excerpt.messageId))
    return candidates.length === current.length && candidates.every((item, index) => current[index].entryId === item.entryId &&
      current[index].contentDigest === item.contentDigest && current[index].role === item.excerpt.role &&
      (item.excerpt.role === 'user' || current[index].receiverKey === item.receiverKeys[0]))
  }

  private recoverOne(operation: StoredTopicHandoff): Promise<void> {
    const running = this.recovering.get(operation.operationId)
    if (running) return running
    const work = this.recoverStored(operation).finally(() => this.recovering.delete(operation.operationId))
    this.recovering.set(operation.operationId, work)
    return work
  }

  private async recoverStored(operation: StoredTopicHandoff): Promise<void> {
    try {
    if (topicHandoffReceiver(this.store)?.key !== operation.receiverKey) {
      this.store.finishTopicHandoff(operation.operationId, 'failed', 'receiver-changed', null)
      return
    }
    const candidates: TopicHandoffCandidate[] = operation.excerpts.map(item => ({ excerpt: { messageId: item.messageId, role: item.role ?? 'user', text: item.text, createdAt: item.createdAt },
      entryId: item.entryId, sessionId: operation.sourceSessionId, contentDigest: item.contentDigest,
      dependencies: { memorySources: [], fileSources: {} }, provenanceComplete: true, receiverKeys: [item.sourceReceiverKey ?? operation.receiverKey] }))
    if (!await this.sourceMatches(candidates, operation.sourceConversationId)) {
      this.store.finishTopicHandoff(operation.operationId, 'failed', 'source-changed', null)
      return
    }
      if (!this.store.getConversation(operation.conversationId)) this.store.createWorkConversation(operation.conversationId, operation.piSessionId, '新对话')
      const preview: TopicHandoffPreview = { id: operation.previewId, digest: operation.digest, sourceConversationId: operation.sourceConversationId,
        excerpts: candidates.map(item => item.excerpt), receiverLabel: topicHandoffReceiver(this.store)!.label, omittedCount: 0,
        crossServiceReplyCount: candidates.filter(item => item.excerpt.role === 'assistant' && item.receiverKeys[0] !== operation.receiverKey).length }
      const entryId = await this.chat.saveTopicHandoffBackground(operation.conversationId, operation.operationId, preview, operation.receiverKey)
      if (topicHandoffReceiver(this.store)?.key !== operation.receiverKey) {
        this.store.finishTopicHandoff(operation.operationId, 'failed', 'receiver-changed', null)
        return
      }
      if (!await this.sourceMatches(candidates, operation.sourceConversationId)) {
        this.store.finishTopicHandoff(operation.operationId, 'failed', 'source-changed', null)
        return
      }
      if (topicHandoffReceiver(this.store)?.key !== operation.receiverKey) {
        this.store.finishTopicHandoff(operation.operationId, 'failed', 'receiver-changed', null)
        return
      }
      this.store.finishTopicHandoff(operation.operationId, 'created', null, entryId)
    } catch {
      try { this.store.finishTopicHandoff(operation.operationId, 'failed', 'storage-failed', null) }
      catch { /* Keep the durable preparing record for a later recovery attempt. */ }
    }
  }

  private result(value: StoredTopicHandoff): TopicHandoffOperation {
    return { operationId: value.operationId, status: value.status,
      ...(value.status === 'created' ? { conversationId: value.conversationId } : {}),
      ...(value.status === 'failed' ? { errorCode: value.errorCode ?? 'storage-failed' } : {}) }
  }
}
