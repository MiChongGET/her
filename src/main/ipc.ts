import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ipcMain, shell, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { Appearance, DesktopSettings, FileReference, SaveProfileInput, SendMessageInput, TestKind, SaveMcpServiceInput, ContinueTaskInput, ConnectionTestResult, ResolveUnknownToolCallInput, WorkspaceSelection } from '../shared/types'
import { HerStore } from '../core/storage/store'
import { ProfileService } from '../core/storage/profiles'
import { FileAccessError, fileEntryError } from '../core/files/errors'
import { FileAccessService } from '../core/files/access'
import { WorkspaceService } from '../core/conversation/workspace'
import { TopicHandoffService } from '../core/conversation/topic-handoff'
import { ChatService, SYSTEM } from '../core/conversation/chat'
import { testConnection } from './test-connection'
import { McpConfigService } from '../core/mcp/config'
import { McpConnectionManager } from '../core/mcp/manager'
import { ToolArtifactStore } from '../core/tools/artifacts'
import { PresetDependencies } from '../core/mcp/dependencies'
import { PRESETS, PEEKABOO_ARGS, PEEKABOO_ENV } from '../core/mcp/presets'
import { externalUrl, isTrustedRenderer } from './ipc-policy'
import { BUILTIN_SKILLS } from '../core/skills/builtin'

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('对象标识不正确。')
  return value
}

interface IpcDependencies {
  window: BrowserWindow
  developmentUrl?: string
  store: HerStore
  profiles: ProfileService
  chat: ChatService
  workspace: WorkspaceService
  topicHandoffs: TopicHandoffService
  configs: McpConfigService
  manager: McpConnectionManager
  dependencies: PresetDependencies
  artifacts: ToolArtifactStore
  files: FileAccessService
  lifetime: AbortSignal
  pending: Set<Promise<unknown>>
  appVersion: string
  dataDirectory: string
  desktopPreferences: (input: { shortcut: string; stopShortcut: string; launchAtLogin: boolean }) => DesktopSettings
  setAppearance: (appearance: Appearance) => DesktopSettings
  onPendingActionsChanged?: () => void
  onSkillDisabled?: (id: string) => void
}

export function registerIpc(deps: IpcDependencies): void {
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== deps.window.webContents ||
          !isTrustedRenderer(event.senderFrame?.url ?? '', deps.developmentUrl,
            event.senderFrame === deps.window.webContents.mainFrame)) {
        throw new Error('此窗口无权调用 Her。')
      }
      deps.lifetime.throwIfAborted()
      const result = action(...args)
      if (result instanceof Promise) {
        deps.pending.add(result)
        void result.finally(() => deps.pending.delete(result)).catch(() => {})
      }
      return result
    })
  }
  const fileContext = (conversationId: string) => ({ conversationId, runId: 'file-ui', callId: 'file-ui', signal: deps.lifetime })
  const sourceInput = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['conversationId', 'fileId'].includes(key))) throw new Error('文件引用不正确。')
    const value = input as Record<string, unknown>
    return { context: fileContext(identifier(value.conversationId)), id: identifier(value.fileId) }
  }
  handle('her:files-persistent', () => deps.files.listPersistentGrants())
  handle('her:files-drop', async (id, paths) => {
    const conversationId = identifier(id)
    try {
      const grants = await deps.files.grant(paths as string[], { conversationId, kind: 'file', scope: 'conversation' })
      const context = fileContext(conversationId)
      const files = []
      for (const grant of grants) files.push(await deps.files.reference(grant.id, '', context))
      deps.files.validateSources({ fileIds: files.map(file => file.id) }, context)
      return files
    } catch (error) { deps.lifetime.throwIfAborted(); throw fileEntryError(error) }
  })
  handle('her:files-preview', async input => {
    const { context, id } = sourceInput(input)
    try {
      const { reference } = await deps.files.resolve(id, context)
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(reference.mimeType) || reference.size > 10 * 1024 * 1024) throw new FileAccessError('仅支持预览 10 MiB 以内的图片。')
      const bytes = await deps.files.readBytes(id, context)
      deps.files.validateSources({ fileIds: [id] }, context)
      return { mimeType: reference.mimeType, dataUrl: `data:${reference.mimeType};base64,${Buffer.from(bytes).toString('base64')}` }
    } catch (error) { deps.lifetime.throwIfAborted(); throw fileEntryError(error) }
  })
  handle('her:files-open', async input => {
    const { context, id } = sourceInput(input)
    try {
      const { path } = await deps.files.resolve(id, context)
      deps.files.validateSources({ fileIds: [id] }, context)
      if (['.txt', '.md', '.log', '.json', '.csv', '.pdf', '.docx', '.pptx', '.xlsx', '.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(path).toLowerCase())) {
        const error = await shell.openPath(path)
        deps.lifetime.throwIfAborted()
        if (error) throw new FileAccessError('无法打开原文件，请检查默认应用。')
      } else shell.showItemInFolder(path)
    } catch (error) { deps.lifetime.throwIfAborted(); throw fileEntryError(error) }
  })
  handle('her:files-list', id => deps.files.listGrants(identifier(id)))
  handle('her:files-validate-draft', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('草稿资料参数不正确。')
    const value = input as Record<string, unknown>
    if (Object.keys(value).some(key => !['conversationId', 'fileIds'].includes(key)) || !Array.isArray(value.fileIds) || value.fileIds.length > 100) throw new Error('草稿资料参数不正确。')
    const conversationId = identifier(value.conversationId)
    deps.workspace.assertSelected(conversationId)
    const valid: FileReference[] = [], invalidIds: string[] = []
    for (const rawId of value.fileIds) {
      const id = identifier(rawId)
      try {
        deps.files.validateSources({ fileIds: [id] }, fileContext(conversationId))
        const reference = deps.store.getFileReference(id)
        if (reference) valid.push(reference.reference)
        else invalidIds.push(id)
      } catch { invalidIds.push(id) }
    }
    return { valid, invalidIds }
  })
  handle('her:files-revoke', id => deps.files.revoke(identifier(id)))
  handle('her:files-select', async input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('文件选择参数不正确。')
    const value = input as Record<string, unknown>
    if (Object.keys(value).some(key => !['conversationId', 'kind', 'scope'].includes(key)) ||
        !['file', 'directory'].includes(String(value.kind)) || !['conversation', 'persistent'].includes(String(value.scope)) ||
        (value.kind === 'file' && value.scope !== 'conversation')) throw new Error('文件选择参数不正确。')
    const conversationId = identifier(value.conversationId)
    if (!deps.store.hasConversation(conversationId)) throw new Error('该对话已经不存在。')
    const kind = value.kind as 'file' | 'directory'
    const scope = value.scope as 'conversation' | 'persistent'
    try {
      const selection = await dialog.showOpenDialog(deps.window, { properties: kind === 'file' ? ['openFile', 'multiSelections'] : ['openDirectory'] })
      deps.lifetime.throwIfAborted()
      if (!deps.store.hasConversation(conversationId)) throw new FileAccessError('该对话已经不存在。')
      if (selection.canceled || !selection.filePaths.length) return { grants: [], files: [] }
      const grants = await deps.files.grant(selection.filePaths, { scope, kind, ...(scope === 'conversation' ? { conversationId } : {}) })
      const context = { conversationId, runId: 'selection', callId: 'selection', signal: deps.lifetime }
      const files = []
      for (const grant of grants) if (grant.kind === 'file') files.push(await deps.files.reference(grant.id, '', context))
      deps.files.validateSources({ fileIds: files.map(file => file.id), grants: grants.map(grant => ({ id: grant.id, revision: grant.revision })) }, context)
      return { grants, files }
    } catch (error) {
      deps.lifetime.throwIfAborted()
      throw fileEntryError(error)
    }
  })
  handle('her:mcp-presets', () => PRESETS)
  handle('her:mcp-dependencies', async (preset, id) => {
    const presetId = identifier(preset)
    const serviceId = id === '' ? '' : identifier(id)
    const before = serviceId ? deps.configs.list().find(item => item.id === serviceId) : undefined
    if (serviceId && (!before || before.presetId !== presetId)) throw new Error('预设配置不匹配。')
    const checks = await deps.dependencies.checkPresetDependencies(presetId, serviceId)
    deps.lifetime.throwIfAborted()
    if (serviceId && deps.configs.list().find(item => item.id === serviceId)?.revision !== before?.revision) throw new Error('检查期间配置已变化，请重试。')
    return checks
  })
  handle('her:mcp-create-preset', async preset => {
    const presetId = identifier(preset)
    if (presetId === 'markitdown') {
      const input = await deps.dependencies.markitdownPreset()
      deps.lifetime.throwIfAborted()
      return deps.configs.save(input)
    }
    if (presetId === 'open-websearch') {
      const input = await deps.dependencies.webPreset(presetId)
      deps.lifetime.throwIfAborted()
      return deps.configs.save(input)
    }
    if (presetId !== 'peekaboo') throw new Error('此预设当前仅提供依赖诊断。')
    const checks = await deps.dependencies.checkPresetDependencies('peekaboo', '')
    deps.lifetime.throwIfAborted()
    const native = checks.find(check => check.component === 'Peekaboo')
    if (native?.status !== 'ready' || !native.resolvedPath) throw new Error(native?.message ?? '请先安装已验证的原生依赖。')
    return deps.configs.save({ name: 'Mac 操作 · Peekaboo', presetId: 'peekaboo', enabled: checks.every(check => check.status === 'ready'), transport: 'stdio', command: native.resolvedPath, args: PEEKABOO_ARGS, secretValues: PEEKABOO_ENV })
  })
  handle('her:mcp-list' , () => deps.configs.list())
  handle('her:mcp-environment', (id, revision) => deps.configs.getEnvironment(identifier(id), revision as number))
  handle('her:mcp-save', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MCP 配置不正确。')
    const value = input as SaveMcpServiceInput
    if (value.id !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision! < 1)) throw new Error('MCP 配置版本不正确。')
    return deps.configs.save(value)
  })
  handle('her:mcp-delete', id => deps.configs.remove(identifier(id)))
  handle('her:mcp-enable', (id, enabled, revision) => {
    const service = deps.configs.list().find(item => item.id === identifier(id))
    if (!service || typeof enabled !== 'boolean' || !Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error('MCP 配置不正确。')
    return deps.configs.save({ ...service, enabled, expectedRevision: revision as number })
  })
  handle('her:mcp-status', id => deps.manager.getStatus(identifier(id)))
  handle('her:mcp-tools', id => deps.manager.listTools(identifier(id)))
  handle('her:mcp-test', async id => {
    const serviceId = identifier(id)
    const service = deps.configs.list().find(item => item.id === serviceId)
    if (!service) throw new Error('MCP 服务不存在。')
    let result: ConnectionTestResult
    try {
      const tools = await deps.manager.listTools(serviceId)
      result = { status: 'passed', message: `连接成功，发现 ${tools.length} 个工具。`, checkedAt: new Date().toISOString() }
    } catch {
      deps.lifetime.throwIfAborted()
      result = { status: 'failed', message: deps.manager.getStatus(serviceId).message ?? '连接未完成，请检查配置与启用状态。', checkedAt: new Date().toISOString() }
    }
    deps.lifetime.throwIfAborted()
    if (!deps.configs.recordTest(serviceId, service.revision, result)) throw new Error('测试期间配置已变化，请重新测试。')
    return result
  })
  const revisionNumber = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('卡片版本不正确。')
    return value
  }
  const cardInput = (input: unknown, keys: string[]) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new Error('卡片参数不正确。')
    return input as Record<string, unknown>
  }
  const selectedWork = (id: unknown) => {
    const owner = identifier(id)
    deps.workspace.assertSelected(owner)
    if (deps.store.getTopicInfo(owner)?.kind !== 'work') throw new Error('请先进入原工作话题。')
    return owner
  }
  const currentDelegation = (id: unknown, revision: unknown) => {
    const value = deps.store.getDelegation(identifier(id))
    if (!value) throw new Error('委托不可用。')
    selectedWork(value.conversationId)
    if (value.revision !== revisionNumber(revision) || !['active', 'paused'].includes(value.status)) throw new Error('委托版本已变化。')
    return value
  }
  const changed = (action: () => unknown) => {
    const result = action()
    deps.onPendingActionsChanged?.()
    if (result instanceof Promise) return result.then(() => { deps.onPendingActionsChanged?.() })
  }
  handle('her:delegation-details', id => deps.chat.getDelegationDetails(selectedWork(id)))
  for (const action of ['pause', 'cancel', 'resume'] as const) handle(`her:delegation-${action}`, (id, revision, expectedControls) => {
    const value = currentDelegation(id, revision)
    if (action === 'pause' && value.status !== 'active') throw new Error('委托已暂缓。')
    const controls: { id: string; revision: number }[] = []
    if (expectedControls !== undefined) {
      if (action !== 'resume' || !Array.isArray(expectedControls)) throw new Error('暂停控制版本不正确。')
      for (const item of expectedControls) {
        const expected = cardInput(item, ['id', 'revision'])
        controls.push({ id: identifier(expected.id), revision: revisionNumber(expected.revision) })
      }
    }
    return changed(() => action === 'pause' ? deps.chat.pauseDelegation(value.id, value.revision)
      : action === 'cancel' ? deps.chat.cancelDelegation(value.id, value.revision)
      : deps.chat.resumeDelegation(value.id, value.revision, () => { selectedWork(value.conversationId) }, controls))
  })
  for (const action of ['approve', 'reject'] as const) handle(`her:delegation-scope-${action}`, (id, revision) => {
    const value = deps.store.getDelegationControl(identifier(id))
    if (!value) throw new Error('范围卡不可用。')
    selectedWork(value.conversationId)
    if (value.revision !== revisionNumber(revision) || value.status !== 'waiting') throw new Error('范围卡已变化。')
    return changed(() => action === 'approve' ? deps.chat.approveDelegationScope(value.id, value.revision) : deps.chat.rejectDelegationScope(value.id, value.revision))
  })
  const currentControl = (input: unknown, extras: string[] = []) => {
    const value = cardInput(input, ['conversationId', 'controlId', 'revision', ...extras])
    const owner = selectedWork(value.conversationId)
    const control = deps.store.listPriorityControls().find(control => control.id === identifier(value.controlId))
    if (!control || control.revision !== revisionNumber(value.revision)) throw new Error('控制卡已变化。')
    const candidates = control.candidates.filter(candidate => (control.heldDelegationIds.includes(candidate.delegationId) || control.heldIntentIds.some(id => deps.store.getIntentControl(id)?.delegationId === candidate.delegationId)) && deps.store.getDelegation(candidate.delegationId)?.conversationId === owner)
    const hasOwnedInputs = control.heldIntentIds.some(id => deps.store.getOrdinaryWorkInputOwner(id) === owner)
    if (!candidates.length && !hasOwnedInputs) throw new Error('此控制不属于原话题。')
    return { value, owner, control, candidates, hasOwnedInputs }
  }
  handle('her:delegation-control-resolve', input => {
    const { value, owner, control, candidates, hasOwnedInputs } = currentControl(input, ['kind', 'delegationIds', 'candidateRevisions', 'releaseOwnedInputs'])
    if (value.releaseOwnedInputs !== undefined && (value.kind !== 'ordinary' || value.releaseOwnedInputs !== true)) throw new Error('控制参数不正确。')
    if (!['pause', 'cancel', 'revise', 'ordinary'].includes(String(value.kind)) || !Array.isArray(value.delegationIds) ||
      value.delegationIds.length > candidates.length || new Set(value.delegationIds).size !== value.delegationIds.length) throw new Error('控制选择不正确。')
    const ids = value.delegationIds.map(id => {
      const candidate = candidates.find(candidate => candidate.delegationId === identifier(id))
      if (!candidate) throw new Error('请选择当前话题的候选。')
      currentDelegation(candidate.delegationId, candidate.revision)
      return candidate.delegationId
    })
    if (value.kind === 'ordinary') {
      if (hasOwnedInputs && value.releaseOwnedInputs !== true) throw new Error('请明确核对此话题尚受控制的普通输入。')
      if (!Array.isArray(value.candidateRevisions) || value.candidateRevisions.length !== candidates.length) throw new Error('请重新核对当前候选版本。')
      const seen = new Set<string>()
      for (const item of value.candidateRevisions) {
        const expected = cardInput(item, ['delegationId', 'currentRevision']), id = identifier(expected.delegationId)
        if (seen.has(id) || !candidates.some(candidate => candidate.delegationId === id) || deps.store.getDelegation(id)?.revision !== revisionNumber(expected.currentRevision)) throw new Error('候选版本已变化。')
        seen.add(id)
      }
    } else if (value.candidateRevisions !== undefined) throw new Error('控制参数不正确。')
    // Scope edits are derived only from the persisted bounded control, never renderer proof.
    const scope = value.kind === 'revise' && ids.length === 1 && control.budget !== undefined
      ? { ...deps.store.getDelegation(ids[0])!.scope, constraints: { ...deps.store.getDelegation(ids[0])!.scope.constraints, budget: control.budget } } : undefined
    const previous = control.ownerResolutions?.[owner]
    if (previous && !(value.kind === 'ordinary' && (previous === 'pause' || hasOwnedInputs))) throw new Error('此话题的控制已处理。')
    return changed(() => deps.chat.resolveControlForOwner(control.id, owner, { kind: value.kind as 'pause' | 'cancel' | 'revise' | 'ordinary', delegationIds: ids, ...(scope ? { scope } : {}), ...(value.releaseOwnedInputs ? { releaseOwnedInputs: true } : {}) }))
  })
  handle('her:delegation-denial-prepare', input => {
    const { value, owner, control, candidates } = currentControl(input, ['delegationId', 'scopeRevision', 'denialId'])
    const delegation = currentDelegation(value.delegationId, value.scopeRevision)
    if (delegation.conversationId !== owner || !candidates.some(candidate => candidate.delegationId === delegation.id && candidate.revision === delegation.revision)) throw new Error('请选择原话题的当前步骤。')
    return changed(() => { deps.chat.prepareDenialRevision(control.id, owner, delegation.id, delegation.revision, identifier(value.denialId)) })
  })
  handle('her:delegation-denial-confirm', input => {
    const { owner, control, candidates } = currentControl(input)
    const selection = control.selection
    if (!selection || !candidates.some(candidate => candidate.delegationId === selection.delegationId && candidate.revision === selection.scopeRevision)) throw new Error('拒绝步骤卡已变化。')
    const delegation = currentDelegation(selection.delegationId, selection.scopeRevision)
    if (delegation.conversationId !== owner || control.ownerResolutions?.[owner]) throw new Error('拒绝步骤卡已变化。')
    return changed(() => deps.chat.confirmDenialRevision(control.id, owner, control.revision))
  })
  handle('her:task-get', id => { const conversationId = identifier(id); deps.workspace.assertSelected(conversationId); return deps.chat.getConversationTask(conversationId) })
  handle('her:task-approval', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('确认参数不正确。')
    const value = input as Record<string, unknown>
    if (value.decision !== 'approve' && value.decision !== 'reject') throw new Error('确认决定不正确。')
    if (typeof value.revision !== 'string' || !value.revision || value.revision.length > 4096) throw new Error('确认版本不正确。')
    if (Object.keys(value).some(key => !['approvalId', 'revision', 'decision'].includes(key))) throw new Error('确认参数不正确。')
    const approvalId = identifier(value.approvalId)
    const task = deps.store.listConversations().map(conversation => deps.chat.getConversationTask(conversation.id))
      .find(task => task?.approval?.id === approvalId && task.approval.revision === value.revision)
    if (!task) throw new Error('动作确认已失效。')
    deps.workspace.assertSelected(task.conversationId)
    return changed(() => deps.chat.decideApproval({ approvalId, revision: value.revision as string, decision: value.decision as 'approve' | 'reject' }))
  })
  handle('her:task-revoke-approval', id => deps.chat.revokeConversationApprovals(identifier(id)))
  handle('her:task-resolve-unknown', input => deps.chat.resolveUnknownToolCall(input as ResolveUnknownToolCallInput))
  handle('her:task-continue', input => {
    const value = cardInput(input, ['runId', 'requestId', 'profileId', 'model'])
    const task = deps.store.getTask(identifier(value.runId))
    if (!task) throw new Error('原任务不可用。')
    deps.workspace.assertSelected(task.conversationId)
    if (deps.store.getDelegationForRun(task.id)) throw new Error('请使用原话题卡片明确继续委托。')
    return deps.chat.continueTask(input as ContinueTaskInput, () => deps.workspace.assertSelected(task.conversationId))
  })
  handle('her:queue-get', id => deps.chat.getQueue(identifier(id)))
  handle('her:queue-cancel', (conversationId, requestId) => deps.chat.cancelQueued(identifier(conversationId), identifier(requestId)))
  handle('her:queue-resume', id => deps.chat.resumeQueue(identifier(id)))
  const modelInput = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数不正确。')
    const value = input as Record<string, unknown>
    if (value.model !== undefined && (typeof value.model !== 'string' || !value.model || value.model.length > 2048)) throw new Error('模型标识不正确。')
    return { conversationId: identifier(value.conversationId), profileId: identifier(value.profileId), ...(value.model !== undefined ? { model: value.model as string } : {}) }
  }
  handle('her:context-usage', input => deps.chat.getConversationContext(modelInput(input)))
  handle('her:compact', input => deps.chat.compact(modelInput(input)))
  handle('her:compact-stop', id => deps.chat.stopCompaction(identifier(id)))
  handle('her:model-switch', input => deps.chat.switchModel(modelInput(input)))
  handle('her:artifact-preview', async (id, conversationId) => {
    const artifactId = identifier(id)
    const owner = identifier(conversationId)
    const bytes = await deps.artifacts.read(artifactId, { runId: 'preview', callId: 'preview', conversationId: owner, signal: deps.lifetime })
    deps.lifetime.throwIfAborted()
    const reference = deps.store.getArtifact(artifactId)!
    return { mimeType: reference.mimeType, dataUrl: `data:${reference.mimeType};base64,${Buffer.from(bytes).toString('base64')}` }
  })
  handle('her:bootstrap', () => ({
    profiles: deps.profiles.list(), dailyConversationId: deps.store.ensureDailyConversation().id,
    settings: deps.store.getSettings(), appVersion: deps.appVersion, dataDirectory: deps.dataDirectory
  }))
  handle('her:profile-catalog', () => deps.profiles.listCatalog())
  handle('her:profile-save', input => deps.profiles.save(input as SaveProfileInput))
  handle('her:profile-delete', id => deps.profiles.delete(identifier(id)))
  handle('her:profile-select', id => deps.profiles.select(identifier(id)))
  handle('her:profile-test', (id, kind, model) => {
    if (kind !== 'chat' && kind !== 'tools' && kind !== 'vision') throw new Error('检测类型不正确。')
    if (model !== undefined && (typeof model !== 'string' || !model || model.length > 2048)) throw new Error('模型标识不正确。')
    return testConnection(deps.profiles, identifier(id), kind as TestKind, model as string | undefined)
  })
  handle('her:workspace-select', input => deps.workspace.select(input as WorkspaceSelection))
  handle('her:topic-handoff-preview', input => deps.topicHandoffs.preview(input as { conversationId: string; messageIds: string[] }))
  handle('her:topic-handoff-commit', input => deps.topicHandoffs.commit(input as { operationId: string; previewId: string; digest: string }))
  handle('her:topic-handoff-status', id => deps.topicHandoffs.getOperation(identifier(id)))
  handle('her:workspace-list', () => deps.workspace.listWorkItems())
  handle('her:workspace-pending-open', () => deps.workspace.getPendingActionOpen())
  handle('her:workspace-pending-ack', input => deps.workspace.ackPendingActionOpen(input as { id: string; version: number }))
  handle('her:workspace-pending', () => deps.workspace.getPendingActions())
  handle('her:workspace-resolve-pending', input => deps.workspace.resolvePendingAction(input as { id: string; version: number }))
  handle('her:conversation-create', () => {
    const id = randomUUID()
    deps.store.createWorkConversation(id, randomUUID(), '新对话')
    return deps.workspace.select({ section: 'work', conversationId: id })
  })
  handle('her:conversation-rename', (id, title) => {
    if (typeof title !== 'string' || title.length > 1024) throw new Error('对话标题不正确。')
    return deps.store.renameConversation(identifier(id), title)
  })
  handle('her:conversation-trash', async id => {
    await deps.chat.trashConversation(identifier(id))
    // Host stop events precede the store deletion; publish the final visible set.
    deps.onPendingActionsChanged?.()
  })
  handle('her:conversation-restore', id => {
    const restored = deps.chat.restoreConversation(identifier(id))
    deps.onPendingActionsChanged?.()
    return restored
  })
  handle('her:conversation-purge', id => deps.chat.purgeConversations([identifier(id)]))
  handle('her:conversation-purge-batch', ids => { if (!Array.isArray(ids) || ids.length > 10000) throw new Error('对话列表不正确。'); return deps.chat.purgeConversations(ids.map(identifier)) })
  handle('her:conversation-trash-list', () => deps.store.listTrashedConversations())
  handle('her:messages', async id => {
    const conversationId = identifier(id)
    deps.workspace.assertSelected(conversationId)
    const messages = await deps.chat.getMessages(conversationId)
    deps.workspace.assertSelected(conversationId)
    return messages
  })
  handle('her:message-send', async input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('消息参数不正确。')
    const value = input as SendMessageInput
    deps.workspace.assertSelected(identifier(value.conversationId))
    const result = await deps.chat.send(value)
    if (result.controlId) deps.onPendingActionsChanged?.()
    return result
  })
  handle('her:message-cancel', requestId => deps.chat.cancel(identifier(requestId)))
  handle('her:desktop-save', input => {
    if (!input || typeof input !== 'object') throw new Error('桌面设置不正确。')
    const preferences = input as { shortcut?: unknown; stopShortcut?: unknown; launchAtLogin?: unknown }
    if (typeof preferences.shortcut !== 'string' || preferences.shortcut.length > 100 ||
        typeof preferences.stopShortcut !== 'string' || preferences.stopShortcut.length > 100 ||
        typeof preferences.launchAtLogin !== 'boolean') throw new Error('快捷键或开机自启设置不正确。')
    return deps.desktopPreferences({ shortcut: preferences.shortcut, stopShortcut: preferences.stopShortcut, launchAtLogin: preferences.launchAtLogin })
  })
  handle('her:appearance-set', appearance => {
    if (appearance !== 'light' && appearance !== 'dark' && appearance !== 'system') throw new Error('外观设置不正确。')
    try { return deps.setAppearance(appearance) }
    catch { throw new Error('外观设置未能保存，请重试。') }
  })
  handle('her:system-prompt-get', () => {
    const settings = deps.store.getSettings()
    return settings.systemPrompt ?? ''
  })
  const listSkills = () => {
    const disabled = deps.store.getSettings().disabledSkillIds ?? []
    return BUILTIN_SKILLS.map(skill => ({ ...skill, enabled: !disabled.includes(skill.id) }))
  }
  handle('her:skills-list', listSkills)
  handle('her:skills-enable', (id, enabled) => {
    if (typeof id !== 'string' || !BUILTIN_SKILLS.some(skill => skill.id === id) || typeof enabled !== 'boolean') throw new Error('技能或启用状态不正确。')
    try {
      const settings = deps.store.getSettings()
      const disabled = new Set(settings.disabledSkillIds ?? [])
      if (enabled) disabled.delete(id); else disabled.add(id)
      deps.store.setSettings({ ...settings, disabledSkillIds: [...disabled] })
      if (!enabled) deps.onSkillDisabled?.(id)
      return listSkills()
    } catch { throw new Error('技能设置未能保存，请重试。') }
  })
  handle('her:system-prompt-set', prompt => {
    if (typeof prompt !== 'string' || prompt.length > 16384) throw new Error('系统提示词不能超过 16384 个字符。')
    const settings = deps.store.getSettings()
    deps.store.setSettings({ ...settings, systemPrompt: prompt || undefined })
  })
  handle('her:system-prompt-default', () => SYSTEM)
  handle('her:external', url => shell.openExternal(externalUrl(url)))
}
