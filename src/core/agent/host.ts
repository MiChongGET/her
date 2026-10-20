import { randomUUID } from 'node:crypto'
import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
import type { ToolExecutionContext, ToolRegistry } from '../tools/types'
import { combineRegistries } from '../tools/combine'
import type { ApprovalRequest, FileReference, FileSources, ConversationQueueState, QueuePauseReason, ChatEvent, ChatMessage, RequestEvent, SendMessageInput, SendMessageResult, TaskEvent, ApprovalDecisionInput, ResolveUnknownToolCallInput, ContinueTaskInput } from '../../shared/types'
import type { HerStore, StoredConversation } from '../storage/store'
import type { ProfileService } from '../storage/profiles'
import { createHerAgentSession, openConversationHistory, SessionDamagedError, SessionUnreadableError } from './factory'
import { createGatedTools } from '../tools/gate'
import { createDefaultRegistry } from '../tools/registry'
import { ToolApprovalService } from '../tools/approval'
import { ResourceQueue } from '../tools/resources'
import { ActionLedger } from '../tools/ledger'
import { RunLimits, RunLimitError } from './limits'
import { classifyRun } from './recover'
import { buildSystemPrompt } from './system-prompt'
import { compactionBudget, exceedsWindow } from './budget'
import type { FileAccessService } from '../files/access'
import type { McpConnectionManager } from '../mcp/manager'
import { FileAccessError } from '../files/errors'
import { fileKey, sourceKeys, toFileSources, RUN_SOURCES, TOOL_SOURCES, type SourceKey } from './sources'

interface ActiveRun {
  requestId: string
  conversationId: string
  taskId: string
  controller: AbortController
  result: SendMessageResult
  session?: AgentSession
  pending?: Promise<void>
  approval?: ApprovalRequest
  limits: RunLimits
  /** Set when the user asked to stop, or a limit stopped the run. */
  stopReason?: QueuePauseReason
  limitError?: RunLimitError
  /** Why the run was stopped, when the reason is not the user's own stop. */
  stopMessage?: string
  /** The sources the latest request relied on, so a revoke can stop exactly the runs that used them. */
  sources: Set<SourceKey>
  files: FileReference[]
}

/** Where the events of a conversation's runs go; refreshed by every call that comes with callbacks. */
interface Sink {
  onChat: (event: ChatEvent) => void
  onRequest: (event: RequestEvent) => void
  systemPrompt: string
}

/** Pi owns history and model execution; Her owns admission, display and cancellation. */
export class AgentHost {
  private readonly active = new Map<string, ActiveRun>()
  private readonly admitting = new Map<string, { requestId: string; controller: AbortController }>()
  private readonly approvals = new ToolApprovalService()
  private readonly resources = new ResourceQueue()
  private readonly ledger: ActionLedger
  private readonly sinks = new Map<string, Sink>()
  /** Conversations whose queue waits for the user, and why. */
  private readonly paused = new Map<string, QueuePauseReason>()
  /** Compactions and model switches in progress; they own the conversation like a run does. */
  private readonly compacting = new Map<string, { controller: AbortController; session?: AgentSession }>()
  private closing = false
  private readonly unsubscribeRevoke?: () => void
  private readonly unsubscribeProfiles?: () => void
  private readonly recovery: Promise<void>
  private recovered = false
  /** Bumped by trash/purge; a run started before the bump loses dispatch authority immediately. */
  private readonly generation = new Map<string, number>()
  private readonly mcp?: McpConnectionManager

  /** Tools available to one conversation's run; the default is the built-in registry only. */
  constructor(private readonly store: HerStore, private readonly profiles: ProfileService, private readonly dataDirectory: string,
    private readonly toolsFor: (conversationId: string, signal: AbortSignal) => Promise<ToolRegistry> = async () => createDefaultRegistry().snapshot(),
    private readonly readImage?: (artifactId: string, context: ToolExecutionContext) => Promise<Uint8Array>,
    private readonly files?: FileAccessService, mcp?: McpConnectionManager) {
    this.mcp = mcp
    this.ledger = new ActionLedger(store)
    this.ledger.recover()
    // After a restart nothing resumes by itself: interrupted work is only recorded, and waiting messages wait for the user.
    this.store.markInterruptedTasks()
    const running = this.store.listRunningInputs()
    for (const conversationId of new Set([...this.store.listConversationsWithPendingInput(), ...running.map(input => input.conversationId)])) this.paused.set(conversationId, 'restart')
    this.recovery = this.recoverInputs(running).catch(() => { /* the store may already be closed */ }).finally(() => { this.recovered = true })
    this.unsubscribeRevoke = this.files?.onRevoked(() => this.recheckSources())
    this.unsubscribeProfiles = profiles.onChanged((profileId, reason) => this.stopForService(profileId, reason))
  }

  /** Resolves once start-up recovery has settled every input a crash left claimed. */
  ready(): Promise<void> { return this.recovery }

  /**
   * An input a crash left 'running' goes one of two ways. If the user's message never reached the Pi session the
   * model never saw it, so it returns to the queue (still paused: nothing runs by itself). If it did reach Pi it may
   * have had effects, so it is closed as interrupted and never resent; the reply is recorded as unfinished.
   */
  private async recoverInputs(running: ReturnType<HerStore['listRunningInputs']>): Promise<void> {
    for (const input of running) {
      try {
        const conversation = this.store.getConversation(input.conversationId)
        if (!conversation || conversation.deletedAt) { this.store.updateInputStatus(input.id, 'cancelled'); continue }
        const { manager } = await openConversationHistory(this.dataDirectory, conversation)
        const outcome = classifyRun(manager.getEntries(), input.id)
        if (!outcome.reached) { this.store.requeueInput(input.id); continue }
        this.store.updateInputStatus(input.id, 'cancelled')
        if (!outcome.result && outcome.run) {
          manager.appendCustomEntry('her.result', { id: outcome.run.assistantMessageId, conversationId: input.conversationId, role: 'assistant',
            content: outcome.assistantText, status: 'failed', error: '应用中断，回复未完成。', createdAt: new Date().toISOString(),
            profileId: outcome.run.profileId, model: outcome.run.model })
        }
        this.reconcile(input.conversationId, manager)
      } catch {
        // The session could not be read, so whether the model saw the message is unknown. Never resend it.
        try { this.store.updateInputStatus(input.id, 'cancelled') } catch { /* closed */ }
      }
    }
  }

  private conversation(id: string): StoredConversation {
    const conversation = this.store.getConversation(id)
    if (!conversation || conversation.deletedAt) throw new Error('该对话已经不存在。')
    return conversation
  }

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    const conversation = this.conversation(conversationId)
    const active = this.active.get(conversationId)
    if (active) return [...this.store.getMessages(conversationId).filter(message =>
      message.id !== active.result.userMessage.id && message.id !== active.result.assistantMessage.id),
    active.result.userMessage, active.result.assistantMessage]
    const { manager } = await openConversationHistory(this.dataDirectory, conversation)
    this.conversation(conversationId)
    this.reconcile(conversationId, manager)
    return this.store.getMessages(conversationId)
  }

  private reconcile(conversationId: string, manager: SessionManager): void {
    const entries: { entryId: string; message: ChatMessage }[] = []
    let run: { userMessageId: string; assistantMessageId: string; profileId: string; model: string; files?: FileReference[] } | undefined
    const history = manager.getEntries()
    // A run with tool calls writes several assistant messages; they are one reply, shown as one message.
    let reply: number | undefined
    for (const entry of history) {
      if (entry.type === 'custom' && entry.customType === 'her.run') { run = entry.data as typeof run; reply = undefined }
      if (entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant')) {
        const message = entry.message
        let content = typeof message.content === 'string' ? message.content
          : message.content.filter(part => part.type === 'text').map(part => part.text).join('')
        // The reference block is sent to the model only; the chat shows what the user typed, plus the files as chips.
        const marker = '\n已授权资料引用：'
        if (run?.files?.length && message.role === 'user' && content.includes(marker)) content = content.slice(0, content.indexOf(marker))
        const status = message.role === 'user' || message.stopReason === 'stop' ? 'complete' : message.stopReason === 'aborted' ? 'cancelled' : 'failed'
        if (run && message.role === 'assistant' && reply !== undefined) {
          entries[reply].message = { ...entries[reply].message, content: entries[reply].message.content + content, status }
          continue
        }
        if (run && message.role === 'assistant') reply = entries.length
        entries.push({ entryId: entry.id, message: {
          id: run ? message.role === 'user' ? run.userMessageId : run.assistantMessageId : entry.id,
          conversationId, role: message.role, content, status,
          createdAt: entry.timestamp, ...(run ? { profileId: run.profileId, model: run.model } : {}),
          ...(run?.files?.length && message.role === 'user' ? { files: run.files } : {})
        } })
      }
      if (entry.type === 'custom' && entry.customType === 'her.result') {
        const message = entry.data as ChatMessage
        const previous = entries.findIndex(value => value.message.id === message.id)
        if (previous < 0) entries.push({ entryId: entry.id, message: { ...message, createdAt: entry.timestamp } })
        else entries[previous].message = { ...message, createdAt: entries[previous].message.createdAt }
      }
    }
    this.store.replaceMessageProjection(conversationId, entries, history.at(-1)?.id ?? null)
  }


  /** True while a run, an admission or a compaction owns the conversation. */
  private busy(conversationId: string): boolean {
    return this.active.has(conversationId) || this.admitting.has(conversationId) || this.compacting.has(conversationId)
  }

  private sinkFor(conversationId: string, sink?: Sink): Sink {
    if (sink) this.sinks.set(conversationId, sink)
    const current = this.sinks.get(conversationId)
    if (!current) throw new Error('会话运行时尚未初始化。')
    return current
  }

  private validate(input: SendMessageInput): void {
    for (const value of [input?.requestId, input?.conversationId, input?.profileId]) {
      if (typeof value !== 'string' || !value || value.length > 128) throw new Error('消息标识不正确。')
    }
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 100_000) throw new Error('请输入不超过 100000 字符的消息。')
    if (input.attachments?.length) throw new Error('粘贴或拖入的附件尚未接入，请先从文件选择器选择资料，或只发送文字。')
    if (input.fileIds !== undefined && (!Array.isArray(input.fileIds) || input.fileIds.length > 100 || !input.fileIds.every(id => typeof id === 'string' && id && id.length <= 128))) throw new Error('文件引用不正确。')
    if (input.fileIds?.length && !this.files) throw new Error('资料发送尚未启用。')
    if (input.retryMessageId !== undefined) {
      // A retry is a new message with the same text. It is only offered for the very last reply, and only if that reply did not finish.
      const last = this.store.getMessages(input.conversationId).at(-1)
      if (typeof input.retryMessageId !== 'string' || !last || last.id !== input.retryMessageId || last.role !== 'assistant' || !['failed', 'cancelled'].includes(last.status)) {
        throw new Error('只能重试当前对话最后一个未完成的回答。')
      }
      if (input.fileIds?.length) throw new Error('重试不能附带新的资料。')
    }
  }

  private placeholder(conversationId: string, userMessageId: string, content: string, profileId: string, model: string | undefined): SendMessageResult {
    const now = new Date().toISOString()
    return {
      userMessage: { id: userMessageId, conversationId, role: 'user', content, status: 'complete', createdAt: now },
      assistantMessage: { id: randomUUID(), conversationId, role: 'assistant', content: '', status: 'streaming', createdAt: now, profileId, ...(model ? { model } : {}) }
    }
  }

  async send(input: SendMessageInput, onChat: (event: ChatEvent) => void, onRequest: (event: RequestEvent) => void, systemPrompt: string): Promise<SendMessageResult> {
    if (this.closing) throw new Error('应用正在退出。')
    this.validate(input)
    this.conversation(input.conversationId)
    this.sinkFor(input.conversationId, { onChat, onRequest, systemPrompt })
    // Only waits while start-up recovery is still running; afterwards the conversation is claimed before any await.
    if (!this.recovered) await this.recovery
    const { conversationId } = input
    // Idle means nothing runs, nothing waits and nothing is paused with a queue. Claim the conversation before
    // any await so stop can reach this send while credentials are read, and a second send is queued behind it.
    // A failed compaction holds even an empty queue: the history is too large, so running on would only fail again.
    const idle = !this.busy(conversationId) && this.store.listPendingInputs(conversationId).length === 0 && this.paused.get(conversationId) !== 'compaction-failed'
    if (idle) this.paused.delete(conversationId)
    const controller = new AbortController()
    if (idle) this.admitting.set(conversationId, { requestId: input.requestId, controller })
    try {
      const provider = await this.profiles.resolve(input.profileId, input.model)
      controller.signal.throwIfAborted()
      if (this.closing) throw new Error('应用正在退出。')
      this.conversation(conversationId)
      // A message that cannot fit an empty context is refused now; compacting cannot make room for it.
      if (exceedsWindow(input.content, compactionBudget(provider.contextWindow, provider.maxOutputTokens))) {
        throw new Error('这条消息超过当前模型的上下文容量，请缩小内容，或换用上下文更大的模型。')
      }
      const userMessageId = randomUUID()
      // Fail now, with a clear reason, rather than after the message has waited in the queue.
      if (input.fileIds?.length) await this.checkFiles(conversationId, input.fileIds, provider, controller.signal)
      this.store.enqueueInput(conversationId, input.content, input.fileIds?.length ? input.fileIds : null, input.requestId, { profileId: input.profileId, model: provider.model, userMessageId })
      if (!idle) {
        // Something may have finished while credentials were read; if so, the queue can go on right now.
        this.startNext(conversationId)
        return { ...structuredClone(this.placeholder(conversationId, userMessageId, input.content, provider.id, provider.model)), queued: true }
      }
      return await this.admit(input.requestId, false, undefined, controller)
    } catch (error) {
      if (idle) this.admitting.delete(conversationId)
      throw error
    }
  }

  /** Runs one stored request. A direct send reports a failure to its caller; a queued one pauses the queue. */
  private async admit(requestId: string, fromQueue: boolean, continuationOf?: string, claimed?: AbortController): Promise<SendMessageResult> {
    if (!this.recovered) await this.recovery
    const row = this.store.getInput(requestId)
    if (!row || row.status !== 'pending') throw new Error('该消息已经不在队列中。')
    const controller = claimed ?? new AbortController()
    this.admitting.set(row.conversationId, { requestId, controller })
    let started = false
    try {
      // Needed to report the run; checked first so a missing sink cannot fail after the request was claimed.
      const sink = this.sinkFor(row.conversationId)
      const profileId = row.profileId
      if (!profileId) throw new Error('消息缺少模型设置，请重新发送。')
      const revision = this.profiles.revision(profileId)
      const provider = await this.profiles.resolve(profileId, row.model ?? undefined)
      controller.signal.throwIfAborted()
      if (this.closing) throw new Error('应用正在退出。')
      const conversation = this.conversation(row.conversationId)
      if (this.profiles.revision(profileId) !== revision) throw new Error('模型配置已变化，请重新发送。')
      await this.prepareModel(conversation, provider, controller.signal)
      controller.signal.throwIfAborted()
      // A queued message may have waited a while: the files must still be there, unchanged and authorised.
      const fileIds: string[] = row.attachments ? JSON.parse(row.attachments) : []
      const files = fileIds.length ? await this.checkFiles(row.conversationId, fileIds, provider, controller.signal) : []
      if (!this.store.claimInput(requestId)) throw new Error('该消息已经被取消。')
      started = true
      const result = this.placeholder(row.conversationId, row.userMessageId ?? randomUUID(), row.content, provider.id, provider.model)
      const run: ActiveRun = { requestId, conversationId: row.conversationId, taskId: randomUUID(), controller, result, sources: new Set(), files,
        limits: new RunLimits(error => { run.limitError = error; run.stopReason = 'limit'; this.abortRun(run) }) }
      this.store.createTask({ id: run.taskId, conversationId: row.conversationId, requestId, generation: 0, status: 'running',
        serviceId: provider.id, modelId: provider.model, configRevision: revision, error: null, continuationOf: continuationOf ?? null,
        assistantMessageId: result.assistantMessage.id })
      this.active.set(row.conversationId, run)
      run.limits.start()
      sink.onRequest({ requestId, conversationId: row.conversationId, state: 'started' })
      run.pending = this.generate(run, conversation, provider, sink)
      return structuredClone(result)
    } catch (error) {
      // Not started: withdraw the request so it cannot be picked up again. Once claimed it is 'running',
      // which cancelPendingInput leaves alone, so close it explicitly or it would stay running forever.
      if (!this.store.cancelPendingInput(requestId) && started) this.store.updateInputStatus(requestId, 'cancelled')
      if (fromQueue) {
        this.paused.set(row.conversationId, 'failed')
        this.sinks.get(row.conversationId)?.onRequest({ requestId, conversationId: row.conversationId, state: 'failed',
          error: error instanceof Error ? error.message : '消息无法开始。' })
      }
      throw error
    } finally { this.admitting.delete(row.conversationId) }
  }

  /** Starts the oldest waiting request of a conversation, unless something else owns it or it is paused. */
  private startNext(conversationId: string): void {
    if (this.closing || this.busy(conversationId) || this.paused.has(conversationId)) return
    const next = this.store.listPendingInputs(conversationId)[0]
    if (!next) return
    void this.admit(next.id, true).catch(() => { /* already recorded: input cancelled, queue paused */ })
  }

  /** Called when a run is over. Only a clean completion lets the queue go on by itself. */
  private afterRun(run: ActiveRun, status: 'complete' | 'cancelled' | 'failed'): void {
    const { conversationId } = run
    try {
      const open = this.store.listOpenToolCalls(run.taskId)
      if (run.stopReason) this.paused.set(conversationId, run.stopReason)
      else if (status !== 'complete') this.paused.set(conversationId, 'failed')
      else if (open.length > 0) this.paused.set(conversationId, 'unknown-action')
      this.startNext(conversationId)
    } catch {
      // The store may already be closed during shutdown; nothing should run on from here.
      this.paused.set(conversationId, run.stopReason ?? 'failed')
    }
  }

  getQueue(conversationId: string): ConversationQueueState {
    this.conversation(conversationId)
    return {
      conversationId,
      items: this.store.listPendingInputs(conversationId).map(item => ({
        requestId: item.id, userMessageId: item.userMessageId ?? item.id, preview: item.content.slice(0, 120),
        profileId: item.profileId, model: item.model, createdAt: item.createdAt.toISOString()
      })),
      paused: this.paused.get(conversationId) ?? null,
      running: this.active.has(conversationId) || this.admitting.has(conversationId),
      compacting: this.compacting.has(conversationId)
    }
  }

  /** Withdraws a waiting message. Once it has started it can only be stopped, not withdrawn. */
  cancelQueued(conversationId: string, requestId: string): void {
    this.conversation(conversationId)
    const row = this.store.getInput(requestId)
    if (!row || row.conversationId !== conversationId) throw new Error('这条排队消息已经不存在。')
    if (!this.store.cancelPendingInput(requestId)) throw new Error('这条消息已经开始处理，无法撤销，可以停止当前回复。')
    if (this.store.listPendingInputs(conversationId).length === 0 && this.paused.get(conversationId) === 'restart') this.paused.delete(conversationId)
  }

  /** The user's explicit go-ahead after a stop, failure, restart or compaction problem. */
  resumeQueue(conversationId: string, sink?: Sink): void {
    this.conversation(conversationId)
    // After a restart no send has registered where events go, so the caller supplies it.
    if (sink) this.sinks.set(conversationId, sink)
    this.paused.delete(conversationId)
    this.startNext(conversationId)
  }

  /**
   * Trash: close dispatch authority (generation+1) before anything else, then stop this conversation's
   * work, pause its queue, and release its handle and scoped MCP connections. Nothing else is touched.
   */
  async trash(conversationId: string): Promise<void> {
    this.generation.set(conversationId, (this.generation.get(conversationId) ?? 0) + 1)
    this.stopCompaction(conversationId)
    await this.stop(conversationId)
    this.paused.set(conversationId, 'stopped')
    this.approvals.revokeConversation(conversationId)
    this.sinks.delete(conversationId)
    await this.mcp?.disconnectConversation(conversationId)
  }

  /** View-only: a restored conversation never resumes its queue or old approvals by itself. */
  restoreForViewing(conversationId: string): void {
    this.paused.set(conversationId, 'stopped')
  }

  /** Resolves and re-checks the chosen files (existence, grant, version) and the model's ability to take them. */
  private async checkFiles(conversationId: string, fileIds: string[], provider: Awaited<ReturnType<ProfileService['resolve']>>, signal: AbortSignal): Promise<FileReference[]> {
    if (!this.files) throw new Error('资料发送尚未启用。')
    const context = { conversationId, runId: 'attach', callId: 'attach', signal }
    const references: FileReference[] = []
    for (const id of fileIds) references.push((await this.files.resolve(id, context)).reference)
    this.files.validateSources({ fileIds }, context)
    const images = references.filter(file => file.mimeType.startsWith('image/'))
    if (images.length) {
      if (!provider.multimodal) throw new Error('当前模型不支持视觉，请切换到支持视觉的模型后发送图片。')
      if (images.length > 10) throw new Error('最多发送 10 张图片。')
      if (images.some(file => file.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimeType))) {
        throw new Error('图片仅支持 PNG、JPEG、GIF、WebP，每张最多 10 MiB。')
      }
    }
    return references
  }

  /** The text and images for the model. Files are only re-read here, at the moment of sending. */
  private async promptFor(run: ActiveRun, provider: Awaited<ReturnType<ProfileService['resolve']>>): Promise<{ text: string; images: { type: 'image'; data: string; mimeType: string }[] }> {
    const content = run.result.userMessage.content
    if (!run.files.length || !this.files) return { text: content, images: [] }
    const context = { conversationId: run.conversationId, runId: run.taskId, callId: 'attach', signal: run.controller.signal }
    this.files.validateSources({ fileIds: run.files.map(file => file.id) }, context)
    const images: { type: 'image'; data: string; mimeType: string }[] = []
    if (provider.multimodal) for (const file of run.files.filter(item => item.mimeType.startsWith('image/'))) {
      images.push({ type: 'image', data: Buffer.from(await this.files.readBytes(file.id, context)).toString('base64'), mimeType: file.mimeType })
    }
    return { text: `${content}\n已授权资料引用：${JSON.stringify(run.files)}`, images }
  }

  /** The guard that keeps revoked or replaced material out of requests and summaries of one conversation. */
  private guardFor(conversationId: string, onUse: (keys: Set<SourceKey>) => void) {
    return {
      valid: (keys: SourceKey[]) => {
        if (!this.files) return true
        try { this.files.validateSources(toFileSources(keys), { conversationId, runId: 'guard', callId: 'guard', signal: new AbortController().signal }); return true }
        catch { return false }
      },
      onUse
    }
  }

  /**
   * A deleted service, or one whose address, protocol or credentials changed, can no longer be trusted by the runs that
   * started with it: stop exactly those, pause their queues, and say why. A rename or model-list edit never gets here.
   */
  private stopForService(profileId: string, reason: 'deleted' | 'connection-changed'): void {
    for (const run of this.active.values()) {
      if (run.result.assistantMessage.profileId !== profileId) continue
      run.stopReason = 'service-changed'
      run.stopMessage = reason === 'deleted' ? '模型服务已被删除，已停止。' : '模型服务的地址或凭据已变化，已停止。'
      this.paused.set(run.conversationId, 'service-changed')
      this.abortRun(run)
    }
  }

  /** After a revoke: stop every run whose latest request relied on something that is no longer valid. */
  private recheckSources(): void {
    if (!this.files) return
    for (const run of this.active.values()) {
      const stale = this.guardFor(run.conversationId, () => {}).valid([...run.sources]) === false
      if (!stale) continue
      run.stopReason = 'source-revoked'
      run.stopMessage = '回复引用的资料已被撤销或已变化，已停止。'
      this.paused.set(run.conversationId, 'source-revoked')
      this.abortRun(run)
    }
  }

  private abortRun(run: ActiveRun): void {
    run.controller.abort()
    void run.session?.abort()
  }

  private async generate(run: ActiveRun, conversation: StoredConversation, provider: Awaited<ReturnType<ProfileService['resolve']>>, sink: Sink): Promise<void> {
    const { onChat, onRequest, systemPrompt } = sink
    let connection: Awaited<ReturnType<typeof createHerAgentSession>> | undefined
    let history: Awaited<ReturnType<typeof openConversationHistory>> | undefined
    let marker: string | undefined
    let unsubscribe: (() => void) | undefined
    let error: string | undefined
    const assistant = run.result.assistantMessage
    try {
      history = await openConversationHistory(this.dataDirectory, conversation)
      const runSources = toFileSources(run.files.map(file => fileKey(file.id)))
      // Ids, versions and names only: no file content and no path ever goes into the session record.
      marker = history.manager.appendCustomEntry('her.run', { requestId: run.requestId, userMessageId: run.result.userMessage.id,
        assistantMessageId: assistant.id, profileId: provider.id, model: provider.model,
        ...(run.files.length ? { files: run.files, fileSources: runSources } : {}) })
      for (const key of sourceKeys(runSources)) run.sources.add(key)
      const hist = history
      const registry = await this.toolsFor(run.conversationId, run.controller.signal)
      run.controller.signal.throwIfAborted()
      const revision = this.profiles.revision(provider.id)
      const generation = this.generation.get(run.conversationId) ?? 0
      const tools = createGatedTools(registry, {
        runId: run.taskId, conversationId: run.conversationId, signal: run.controller.signal, resources: this.resources, ledger: this.ledger,
        validateRuntime: () => !this.closing && this.profiles.revision(provider.id) === revision && (this.generation.get(run.conversationId) ?? 0) === generation,
        modelSupportsVision: provider.multimodal === true, readImage: this.readImage,
        authorize: (assessment, context) => this.approvals.authorize(context.callId, assessment, context),
        onSources: (callId, sources) => {
          for (const key of sourceKeys(sources)) run.sources.add(key)
          hist.manager.appendCustomEntry(TOOL_SOURCES, { toolCallId: callId, fileSources: sources })
        },
        // The call over the limit is refused before it runs, and the whole run stops so the model cannot keep trying.
        onAttempt: () => {
          try { run.limits.attempt() }
          catch (limit) { if (limit instanceof RunLimitError) { run.limitError = limit; run.stopReason = 'limit'; this.abortRun(run) } throw limit }
        },
        onApproval: approval => {
          run.approval = approval
          if (approval) run.limits.pause(); else run.limits.resume()
          onChat({ requestId: run.requestId, conversationId: run.conversationId, message: { ...assistant }, done: false, task: this.taskEvent(run) })
        }
      })
      connection = await createHerAgentSession(provider, conversation, this.dataDirectory, buildSystemPrompt(systemPrompt, tools.map(tool => tool.name), { contextWindow: compactionBudget(provider.contextWindow, provider.maxOutputTokens).contextWindow }), run.controller.signal, history, tools, undefined,
        this.guardFor(run.conversationId, keys => { run.sources = keys }))
      run.controller.signal.throwIfAborted()
      run.session = connection.session
      unsubscribe = connection.session.subscribe(event => {
        // The failed attempt is dropped from the model's view when Pi retries, so what it had streamed must not stay on screen
        // or the retried reply would be appended to it.
        if (event.type === 'auto_retry_start' && !run.controller.signal.aborted) {
          assistant.content = ''
          onChat({ requestId: run.requestId, conversationId: run.conversationId, message: { ...assistant }, done: false })
        }
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && !run.controller.signal.aborted) {
          assistant.content += event.assistantMessageEvent.delta
          onChat({ requestId: run.requestId, conversationId: run.conversationId, message: { ...assistant }, done: false })
        }
      })
      const { text, images } = await this.promptFor(run, provider)
      await connection.session.prompt(text, images.length ? { images } : undefined)
      // The run is over only when the prompt has returned AND the session has settled (no retry, compaction or queued
      // continuation); an in-flight dispatch left behind shows up as an open call and pauses the queue.
      await Promise.race([connection.session.waitForIdle(), new Promise<void>(resolve => run.controller.signal.addEventListener('abort', () => resolve(), { once: true }))])
      run.controller.signal.throwIfAborted()
      const last = connection.session.messages.at(-1)
      if (!last || last.role !== 'assistant' || last.stopReason !== 'stop' || !connection.transport.normalEnd || !assistant.content.trim()) {
        throw new Error('incomplete')
      }
      assistant.status = 'complete'
    } catch (caught) {
      const aborted = run.controller.signal.aborted
      assistant.status = aborted ? 'cancelled' : 'failed'
      // A damaged or unreadable session has its own message; anything else from the SDK may name local paths or secrets.
      const sessionProblem = caught instanceof SessionDamagedError || caught instanceof SessionUnreadableError ? caught.message : undefined
      error = run.limitError?.message ?? run.stopMessage ?? sessionProblem ?? (aborted ? '回复已停止。' : connection?.transport.failure ?? '模型请求失败，请检查模型设置后重试。')
      assistant.error = error
      // Text produced before the stop is kept as an interrupted fragment, never as a finished answer.
      if (aborted && assistant.content.trim()) {
        try { this.store.saveDraftFragment(run.taskId, 'interrupted-text', assistant.content) } catch { /* the message itself still shows it */ }
      }
    } finally {
      run.limits.stop()
      unsubscribe?.()
      try {
        if (history) {
          const entries = history.manager.getEntries()
          const current = entries.slice(entries.findIndex(entry => entry.id === marker) + 1)
          if (!current.some(entry => entry.type === 'message' && entry.message.role === 'user')) {
            history.manager.appendMessage({ role: 'user', content: [{ type: 'text', text: run.result.userMessage.content }], timestamp: Date.now() })
          }
          history.manager.appendCustomEntry('her.result', { ...assistant })
          this.reconcile(run.conversationId, history.manager)
        }
        this.store.updateInputStatus(run.requestId, assistant.status === 'complete' ? 'completed' : 'cancelled')
        this.store.updateTaskStatus(run.taskId, assistant.status === 'complete' ? 'completed' : assistant.status === 'cancelled' ? 'stopped' : 'failed', error ?? null)
      } catch {
        assistant.status = 'failed'
        assistant.error = error = '对话记录保存失败，请检查本地资料目录后重试。'
      } finally {
        connection?.session.dispose()
        this.active.delete(run.conversationId)
        onChat({ requestId: run.requestId, conversationId: run.conversationId, message: { ...assistant }, done: true })
        onRequest({ requestId: run.requestId, conversationId: run.conversationId,
          state: assistant.status === 'complete' ? 'completed' : assistant.status === 'cancelled' ? 'cancelled' : 'failed', ...(error ? { error } : {}) })
        this.afterRun(run, assistant.status === 'streaming' ? 'failed' : assistant.status)
      }
    }
  }

  getActiveRequest(): { requestId: string; conversationId: string } | null {
    const run = this.active.values().next().value as ActiveRun | undefined
    if (run) return { requestId: run.requestId, conversationId: run.conversationId }
    const admission = this.admitting.entries().next().value
    return admission ? { requestId: admission[1].requestId, conversationId: admission[0] } : null
  }

  /**
   * Stop order: close the queue's dispatch first, then cancel approval and resource waits (they share the
   * run's signal), then abort the session and let the run settle. Dispatched actions end as unknown in the ledger.
   */
  stopRequest(requestId: string): void {
    for (const [conversationId, admission] of this.admitting) if (admission.requestId === requestId) {
      this.paused.set(conversationId, 'stopped')
      admission.controller.abort(new Error('回复已停止。'))
    }
    for (const run of this.active.values()) if (run.requestId === requestId) {
      run.stopReason ??= 'stopped'
      this.paused.set(run.conversationId, run.stopReason)
      this.abortRun(run)
    }
  }

  async stop(conversationId: string): Promise<void> {
    this.stopCompaction(conversationId)
    const run = this.active.get(conversationId)
    if (run) { this.stopRequest(run.requestId); await run.pending }
  }

  async stopAll(): Promise<void> {
    this.closing = true
    this.unsubscribeRevoke?.()
    this.unsubscribeProfiles?.()
    for (const admission of this.admitting.values()) admission.controller.abort(new Error('应用正在退出。'))
    for (const compaction of this.compacting.values()) { compaction.controller.abort(new Error('应用正在退出。')); compaction.session?.abortCompaction() }
    const runs = [...this.active.values()]
    for (const run of runs) this.stopRequest(run.requestId)
    await Promise.all(runs.map(run => run.pending))
  }

  private taskEvent(run: ActiveRun): TaskEvent {
    const { assistantMessage } = run.result
    return { requestId: run.requestId, conversationId: run.conversationId, ...(run.approval ? { approval: run.approval } : {}),
      run: { id: run.taskId, requestId: run.requestId, conversationId: run.conversationId, assistantMessageId: assistantMessage.id,
        status: run.approval ? 'awaiting_confirmation' : 'running', providerId: assistantMessage.profileId ?? '', model: assistantMessage.model ?? '',
        toolCallsCount: run.limits.toolCalls, activeMs: run.limits.elapsedMs } }
  }

  /** The running task, or else the newest one if it ended without finishing or left an unknown outcome nobody has decided on. */
  getConversationTask(conversationId: string): TaskEvent | null {
    const run = this.active.get(conversationId)
    if (run) return this.withUnknowns(this.taskEvent(run))
    const task = this.store.getLatestTask(conversationId)
    if (!task) return null
    const unknownCalls = this.store.listUnresolvedToolCalls(conversationId)
    if (task.status === 'completed' && !unknownCalls.length) return null
    const status = task.status === 'failed' ? 'failed' : task.status === 'completed' ? 'completed' : 'stopped'
    return { requestId: task.requestId, conversationId, ...(unknownCalls.length ? { unknownCalls } : {}),
      run: { id: task.id, requestId: task.requestId, conversationId, assistantMessageId: task.assistantMessageId ?? '', status,
        providerId: task.serviceId, model: task.modelId, toolCallsCount: this.store.countToolCalls(task.id),
        activeMs: Math.max(0, (task.endedAt ?? task.createdAt).getTime() - (task.startedAt ?? task.createdAt).getTime()),
        ...(task.continuationOf ? { continuationOf: task.continuationOf } : {}) } }
  }

  private withUnknowns(event: TaskEvent): TaskEvent {
    const unknownCalls = this.store.listUnresolvedToolCalls(event.conversationId)
    return unknownCalls.length ? { ...event, unknownCalls } : event
  }

  /** A decision only releases the pending call whose revision (run, call, tool version, args, target) it names. */
  async decideApproval(input: ApprovalDecisionInput): Promise<void> {
    this.approvals.decide(input)
  }

  revokeConversationApprovals(conversationId: string): void {
    this.approvals.revokeConversation(conversationId)
  }

  /**
   * Resolve an unknown tool call result.
   * TODO: Implement unknown tool call tracking and resolution
   */
  resolveUnknownToolCall(input: ResolveUnknownToolCallInput): TaskEvent | null {
    if (!input || typeof input !== 'object' || !['handled', 'abandoned'].includes(input.decision)) throw new Error('处理决定不正确。')
    this.conversation(input.conversationId)
    // Only while nothing is running: a person must not clear a block under a task that is still acting.
    if (this.busy(input.conversationId)) throw new Error('该对话仍在运行，请先停止任务，再处理未知动作。')
    const target = this.store.resolveToolCall(input)
    // The call stays 'unknown' in the ledger; only the target's block is lifted, and only once no other unresolved
    // unknown outcome still points at it. A later interaction on it still needs fresh approval.
    if (this.store.countUnresolvedUnknownOnTarget(target) === 0) this.ledger.resolve(target, input.decision)
    return this.getConversationTask(input.conversationId)
  }

  /**
   * Starts a new attempt for a stopped, interrupted or failed task. Quarantined targets and the approval
   * rules stay in force, and the model is told which earlier actions have an unknown outcome so it does not repeat them.
   */
  async continueTask(input: ContinueTaskInput, onChat: (event: ChatEvent) => void, onRequest: (event: RequestEvent) => void, systemPrompt: string): Promise<SendMessageResult> {
    if (this.closing) throw new Error('应用正在退出。')
    for (const value of [input?.runId, input?.requestId, input?.profileId]) {
      if (typeof value !== 'string' || !value || value.length > 128) throw new Error('任务标识不正确。')
    }
    const task = this.store.getTask(input.runId)
    if (!task) throw new Error('找不到要继续的任务。')
    this.conversation(task.conversationId)
    if (!['interrupted', 'stopped', 'failed'].includes(task.status)) throw new Error('只有被中断、停止或失败的任务可以继续。')
    if (this.store.getContinuation(task.id)) throw new Error('这个任务已经继续过了。')
    if (this.busy(task.conversationId)) throw new Error('该对话正在处理其他任务，请等待完成或停止。')
    this.sinkFor(task.conversationId, { onChat, onRequest, systemPrompt })
    const provider = await this.profiles.resolve(input.profileId, input.model)
    if (this.busy(task.conversationId)) throw new Error('该对话正在处理其他任务，请等待完成或停止。')
    const open = this.store.listOpenToolCalls(task.id)
    const note = (resolution: 'handled' | 'abandoned' | null) => resolution === 'handled' ? '；用户已处理，但历史结果仍未知，不得重放，后续操作需要新观察和新确认'
      : resolution === 'abandoned' ? '；用户已放弃此动作，历史结果仍未知，不得重放' : ''
    const prompt = open.length
      ? `继续完成上一次未完成的任务。\n以下动作的结果未知，不要重复执行；请先重新观察对应目标，确认状态后再决定：\n${open.map(call => `- ${call.toolName}（目标 ${call.target}）${note(call.resolution)}`).join('\n')}`
      : '继续完成上一次未完成的任务。'
    this.store.enqueueInput(task.conversationId, prompt, null, input.requestId, { profileId: input.profileId, model: provider.model, userMessageId: randomUUID() })
    // The user's explicit go-ahead; the new attempt runs ahead of anything still waiting.
    this.paused.delete(task.conversationId)
    return this.admit(input.requestId, false, task.id)
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Compaction and model switching
  // ──────────────────────────────────────────────────────────────────────────────

  /** Compacts through a throw-away session on the same Pi history; success appends a checkpoint, failure appends nothing. */
  private async runCompaction(conversation: StoredConversation, provider: Awaited<ReturnType<ProfileService['resolve']>>, signal: AbortSignal,
    track?: { session?: AgentSession }, forWindow?: number): Promise<void> {
    const connection = await createHerAgentSession(provider, conversation, this.dataDirectory, this.sinks.get(conversation.id)?.systemPrompt ?? '', signal, undefined, [], forWindow,
      this.guardFor(conversation.id, () => {}))
    if (track) track.session = connection.session
    try { await connection.session.compact() }
    finally { connection.session.dispose() }
  }

  async compactConversation(input: { conversationId: string; profileId: string; model?: string },
    onChat: (event: ChatEvent) => void, onRequest: (event: RequestEvent) => void, systemPrompt: string): Promise<void> {
    if (this.closing) throw new Error('应用正在退出。')
    const { conversationId } = input
    const conversation = this.conversation(conversationId)
    this.sinkFor(conversationId, { onChat, onRequest, systemPrompt })
    if (this.busy(conversationId)) throw new Error('该对话正在处理中，请等待完成或停止后再压缩。')
    const controller = new AbortController(), track: { controller: AbortController; session?: AgentSession } = { controller }
    // Claim before any await: messages sent from now on are queued behind the compaction.
    this.compacting.set(conversationId, track)
    let ok = false
    try {
      const provider = await this.profiles.resolve(input.profileId, input.model)
      controller.signal.throwIfAborted()
      const { manager } = await openConversationHistory(this.dataDirectory, conversation)
      if (manager.buildSessionContext().messages.length < 2) throw new CompactionNotNeeded()
      await this.runCompaction(conversation, provider, controller.signal, track)
      ok = true
    } catch (error) {
      // Pi declines when nothing lies beyond the part it keeps verbatim; retrying cannot help, so the queue is not paused.
      if (error instanceof CompactionNotNeeded || (error instanceof Error && /Nothing to compact/i.test(error.message))) throw new Error('这个对话还没有足够的内容可以压缩。')
      const stopped = controller.signal.aborted
      // Nothing half-finished is used: no checkpoint was written, and the queue waits for the user.
      this.paused.set(conversationId, stopped ? 'compaction-stopped' : 'compaction-failed')
      throw new Error(stopped ? '压缩已停止，没有使用任何半份摘要，原有对话保持不变。' : '压缩失败，原有对话没有改动，可以重试。')
    } finally {
      this.compacting.delete(conversationId)
    }
    if (ok) {
      const reason = this.paused.get(conversationId)
      if (reason === 'compaction-stopped' || reason === 'compaction-failed') this.paused.delete(conversationId)
      this.startNext(conversationId)
    }
  }

  stopCompaction(conversationId: string): void {
    const compaction = this.compacting.get(conversationId)
    if (!compaction) return
    compaction.controller.abort(new Error('压缩已停止。'))
    compaction.session?.abortCompaction()
  }

  private lastModel(manager: SessionManager): { profileId: string; model: string } | undefined {
    const entries = manager.getEntries()
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.type === 'custom' && (entry.customType === 'her.run' || entry.customType === 'her.model')) {
        const data = entry.data as { profileId?: string; model?: string } | undefined
        if (data?.profileId && data.model) return { profileId: data.profileId, model: data.model }
      }
    }
    return undefined
  }

  /**
   * Runs before a different model takes over a conversation: refuses a model that cannot see images already in
   * the history, and compacts with the previous model first when the new window is too small for the history.
   */
  private async prepareModel(conversation: StoredConversation, provider: Awaited<ReturnType<ProfileService['resolve']>>, signal: AbortSignal): Promise<void> {
    const { manager } = await openConversationHistory(this.dataDirectory, conversation)
    const last = this.lastModel(manager)
    if (!last || (last.profileId === provider.id && last.model === provider.model)) return
    const { estimateTokens } = await import('@earendil-works/pi-coding-agent')
    const messages = () => openConversationHistory(this.dataDirectory, conversation).then(history => history.manager.buildSessionContext().messages)
    const before = await messages()
    const hasImage = before.some(message => {
      const content = (message as { content?: unknown }).content
      return Array.isArray(content) && content.some(part => (part as { type?: string }).type === 'image')
    })
    if (hasImage && provider.multimodal !== true) throw new Error('这个对话里已有图片，目标模型不支持图片，请选择支持图片的模型。')
    const budget = compactionBudget(provider.contextWindow, provider.maxOutputTokens)
    // The system prompt stored in the session was built for the previous model; every run rebuilds it for the one in use, so it is not history to fit.
    const fits = (list: typeof before) => list.filter(message => (message as { role?: string }).role !== 'system')
      .reduce((sum, message) => sum + estimateTokens(message), 0) <= budget.contextWindow - budget.reserveTokens
    if (fits(before)) return
    const previous = await this.profiles.resolve(last.profileId, last.model).catch(() => undefined)
    if (!previous) throw new Error('目标模型的上下文更小，需要先压缩，但原来的模型服务已不可用。请恢复原服务或换用上下文更大的模型。')
    signal.throwIfAborted()
    try { await this.runCompaction(conversation, previous, signal, undefined, budget.contextWindow) }
    catch (error) {
      if (error instanceof Error && /Nothing to compact/i.test(error.message)) throw new Error('目标模型的上下文太小，现有对话无法再压缩到它能容纳的大小，请换用上下文更大的模型。')
      throw error
    }
    signal.throwIfAborted()
    if (!fits(await messages())) throw new Error('压缩后仍超过目标模型的上下文容量，请换用上下文更大的模型。')
  }

  /** Switches an idle conversation to another model. A running or compacting conversation is refused. */
  async switchModel(input: { conversationId: string; profileId: string; model?: string }): Promise<void> {
    if (this.closing) throw new Error('应用正在退出。')
    const conversation = this.conversation(input.conversationId)
    if (this.busy(input.conversationId)) throw new Error('该对话正在处理中，请等待完成或停止后再切换模型。')
    const controller = new AbortController()
    this.compacting.set(input.conversationId, { controller })
    try {
      const provider = await this.profiles.resolve(input.profileId, input.model)
      await this.prepareModel(conversation, provider, controller.signal)
      const { manager } = await openConversationHistory(this.dataDirectory, conversation)
      manager.appendCustomEntry('her.model', { profileId: provider.id, model: provider.model })
    } finally { this.compacting.delete(input.conversationId) }
  }
}

class CompactionNotNeeded extends Error {}
