// @ts-nocheck - TODO 10.5: Fix store method calls after core agent integration
import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ipcMain, shell, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ConversationSummary, DesktopSettings, SaveProfileInput, SendMessageInput, TestKind, SaveMcpServiceInput, ContinueTaskInput, ConnectionTestResult, ResolveUnknownToolCallInput } from '../shared/types'
import { HerStore, type StoredConversation } from '../core/storage/store'
import { ProfileService } from '../core/storage/profiles'
import { FileAccessError, fileEntryError } from '../core/files/errors'
import { FileAccessService } from '../core/files/access'
import { ChatService, SYSTEM } from '../core/conversation/chat'
import { testConnection } from './test-connection'
import { McpConfigService } from '../core/mcp/config'
import { McpConnectionManager } from '../core/mcp/manager'
import { ToolArtifactStore } from '../core/tools/artifacts'
import { PresetDependencies } from '../core/mcp/dependencies'
import { PRESETS, PEEKABOO_ARGS, PEEKABOO_ENV } from '../core/mcp/presets'
import { externalUrl, isTrustedRenderer } from './ipc-policy'

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('对象标识不正确。')
  return value
}

function conversationSummary(conversation: StoredConversation): ConversationSummary {
  return {
    id: conversation.id, title: conversation.title, titleCustom: conversation.titleCustom,
    createdAt: conversation.createdAt.toISOString(), updatedAt: conversation.updatedAt.toISOString(), lastMessage: ''
  }
}

interface IpcDependencies {
  window: BrowserWindow
  developmentUrl?: string
  store: HerStore
  profiles: ProfileService
  chat: ChatService
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
    if (presetId === 'playwright' || presetId === 'open-websearch') {
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
  handle('her:task-get', id => deps.chat.getConversationTask(identifier(id)))
  handle('her:task-approval', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('确认参数不正确。')
    const value = input as Record<string, unknown>
    if (value.decision !== 'approve' && value.decision !== 'reject' && value.decision !== 'approve-conversation') throw new Error('确认决定不正确。')
    if (typeof value.revision !== 'string' || !value.revision || value.revision.length > 4096) throw new Error('确认版本不正确。')
    return deps.chat.decideApproval({ approvalId: identifier(value.approvalId), revision: value.revision, decision: value.decision })
  })
  handle('her:task-revoke-approval', id => deps.chat.revokeConversationApprovals(identifier(id)))
  handle('her:task-resolve-unknown', input => deps.chat.resolveUnknownToolCall(input as ResolveUnknownToolCallInput))
  handle('her:task-continue', input => deps.chat.continueTask(input as ContinueTaskInput))
  handle('her:queue-get', id => deps.chat.getQueue(identifier(id)))
  handle('her:queue-cancel', (conversationId, requestId) => deps.chat.cancelQueued(identifier(conversationId), identifier(requestId)))
  handle('her:queue-resume', id => deps.chat.resumeQueue(identifier(id)))
  const modelInput = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数不正确。')
    const value = input as Record<string, unknown>
    if (value.model !== undefined && (typeof value.model !== 'string' || !value.model || value.model.length > 2048)) throw new Error('模型标识不正确。')
    return { conversationId: identifier(value.conversationId), profileId: identifier(value.profileId), ...(value.model !== undefined ? { model: value.model as string } : {}) }
  }
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
    activeRequest: deps.chat.getActiveRequest(),
    profiles: deps.profiles.list(), conversations: deps.store.listConversations().map(conversationSummary),
    settings: deps.store.getSettings(), appVersion: deps.appVersion, dataDirectory: deps.dataDirectory
  }))
  handle('her:profile-save', input => deps.profiles.save(input as SaveProfileInput))
  handle('her:profile-delete', id => deps.profiles.delete(identifier(id)))
  handle('her:profile-select', id => deps.profiles.select(identifier(id)))
  handle('her:profile-test', (id, kind, model) => {
    if (kind !== 'chat' && kind !== 'tools' && kind !== 'vision') throw new Error('检测类型不正确。')
    if (model !== undefined && (typeof model !== 'string' || !model || model.length > 2048)) throw new Error('模型标识不正确。')
    return testConnection(deps.profiles, identifier(id), kind as TestKind, model as string | undefined)
  })
  handle('her:conversation-create', () => {
    const id = randomUUID()
    deps.store.createConversation(id, randomUUID(), '新对话')
    return conversationSummary(deps.store.getConversation(id)!)
  })
  handle('her:conversation-rename', (id, title) => {
    if (typeof title !== 'string' || title.length > 1024) throw new Error('对话标题不正确。')
    return deps.store.renameConversation(identifier(id), title)
  })
  handle('her:conversation-trash', id => deps.chat.trashConversation(identifier(id)))
  handle('her:conversation-restore', id => deps.chat.restoreConversation(identifier(id)))
  handle('her:conversation-purge', id => deps.store.purgeConversation(identifier(id)))
  handle('her:conversation-purge-batch', ids => deps.store.purgeConversations((ids as string[]).map(identifier)))
  handle('her:conversation-trash-list', () => deps.store.listTrashedConversations())
  handle('her:messages', id => {
    const conversationId = identifier(id)
    if (!deps.store.hasConversation(conversationId)) throw new Error('该对话已经不存在。')
    return deps.chat.getMessages(conversationId)
  })
  handle('her:message-send', input => deps.chat.send(input as SendMessageInput))
  handle('her:message-cancel', requestId => deps.chat.cancel(identifier(requestId)))
  handle('her:desktop-save', input => {
    if (!input || typeof input !== 'object') throw new Error('桌面设置不正确。')
    const preferences = input as { shortcut?: unknown; stopShortcut?: unknown; launchAtLogin?: unknown }
    if (typeof preferences.shortcut !== 'string' || preferences.shortcut.length > 100 ||
        typeof preferences.stopShortcut !== 'string' || preferences.stopShortcut.length > 100 ||
        typeof preferences.launchAtLogin !== 'boolean') throw new Error('快捷键或开机自启设置不正确。')
    return deps.desktopPreferences({ shortcut: preferences.shortcut, stopShortcut: preferences.stopShortcut, launchAtLogin: preferences.launchAtLogin })
  })
  handle('her:system-prompt-get', () => {
    const settings = deps.store.getSettings()
    return settings.systemPrompt ?? ''
  })
  handle('her:system-prompt-set', prompt => {
    if (typeof prompt !== 'string' || prompt.length > 16384) throw new Error('系统提示词不能超过 16384 个字符。')
    const settings = deps.store.getSettings()
    deps.store.setSettings({ ...settings, systemPrompt: prompt || undefined })
  })
  handle('her:system-prompt-default', () => SYSTEM)
  handle('her:external', url => shell.openExternal(externalUrl(url)))
}
