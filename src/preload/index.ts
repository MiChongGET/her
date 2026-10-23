import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { HerApi, WorkspaceChatEvent, WorkspaceRequestEvent, WorkspaceTaskEvent, PendingActionNotice } from '../shared/types'

function applyEffectiveAppearance(value: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return
  const apply = () => document.documentElement.setAttribute('data-appearance', value)
  if (document.documentElement) apply()
  else document.addEventListener('DOMContentLoaded', apply, { once: true })
}

applyEffectiveAppearance(process.argv.includes('--her-effective-appearance=dark') ? 'dark' : 'light')
ipcRenderer.on('her:appearance-effective', (_event, value: unknown) => {
  if (value === 'dark' || value === 'light') applyEffectiveAppearance(value)
})

// 开发模式下启用 IPC 调试日志
const isDev = process.env.NODE_ENV === 'development' || process.env.ELECTRON_RENDERER_URL

const createIpcProxy = <T extends (...args: any[]) => any>(channel: string, fn: T): T => {
  return ((...args: any[]) => {
    const started = performance.now()
    if (isDev) console.log('[IPC]', { channel, phase: 'start' })
    const result = fn(...args)
    if (result instanceof Promise) {
      return result.then(
        value => {
          if (isDev) console.log('[IPC]', { channel, elapsedMs: Math.round(performance.now() - started), outcome: 'success' })
          return value
        },
        error => {
          if (isDev) console.error('[IPC]', { channel, elapsedMs: Math.round(performance.now() - started), outcome: 'failure', code: 'IPC_FAILED' })
          throw error
        }
      )
    }
    return result
  }) as T
}

const api: HerApi = {
  getDelegationDetails: createIpcProxy('her:delegation-details', (conversationId) => ipcRenderer.invoke('her:delegation-details', conversationId)),
  previewTopicHandoff: createIpcProxy('her:topic-handoff-preview', input => ipcRenderer.invoke('her:topic-handoff-preview', input)),
  commitTopicHandoff: createIpcProxy('her:topic-handoff-commit', input => ipcRenderer.invoke('her:topic-handoff-commit', input)),
  getTopicHandoffOperation: createIpcProxy('her:topic-handoff-status', id => ipcRenderer.invoke('her:topic-handoff-status', id)),
  pauseDelegation: createIpcProxy('her:delegation-pause', (id, revision) => ipcRenderer.invoke('her:delegation-pause', id, revision)),
  cancelDelegation: createIpcProxy('her:delegation-cancel', (id, revision) => ipcRenderer.invoke('her:delegation-cancel', id, revision)),
  resumeDelegation: createIpcProxy('her:delegation-resume', (id, revision, controls) => ipcRenderer.invoke('her:delegation-resume', id, revision, controls)),
  approveDelegationScope: createIpcProxy('her:delegation-scope-approve', (id, revision) => ipcRenderer.invoke('her:delegation-scope-approve', id, revision)),
  rejectDelegationScope: createIpcProxy('her:delegation-scope-reject', (id, revision) => ipcRenderer.invoke('her:delegation-scope-reject', id, revision)),
  resolveDelegationControl: createIpcProxy('her:delegation-control-resolve', (input) => ipcRenderer.invoke('her:delegation-control-resolve', input)),
  prepareDelegationDenial: createIpcProxy('her:delegation-denial-prepare', (input) => ipcRenderer.invoke('her:delegation-denial-prepare', input)),
  confirmDelegationDenial: createIpcProxy('her:delegation-denial-confirm', (input) => ipcRenderer.invoke('her:delegation-denial-confirm', input)),

  addDroppedFiles: createIpcProxy('her:files-drop', async (conversationId, files) => {
    if (!Array.isArray(files) || !files.length || files.length > 100) throw new Error('请拖入磁盘上的文件。')
    const paths = files.map(file => {
      const path = webUtils.getPathForFile(file)
      if (!path) throw new Error('请拖入磁盘上的文件；文件夹请使用授权目录入口。')
      return path
    })
    return ipcRenderer.invoke('her:files-drop', conversationId, paths)
  }),
  listPersistentFileGrants: createIpcProxy('her:files-persistent', () => ipcRenderer.invoke('her:files-persistent')),
  openFileSource: createIpcProxy('her:files-open', input => ipcRenderer.invoke('her:files-open', input)),
  getFilePreview: createIpcProxy('her:files-preview', input => ipcRenderer.invoke('her:files-preview', input)),

  selectFiles: createIpcProxy('her:files-select', input => ipcRenderer.invoke('her:files-select', input)),
  validateDraftFiles: createIpcProxy('her:files-validate-draft', input => ipcRenderer.invoke('her:files-validate-draft', input)),
  listFileGrants: createIpcProxy('her:files-list', id => ipcRenderer.invoke('her:files-list', id)),
  revokeFileGrant: createIpcProxy('her:files-revoke', id => ipcRenderer.invoke('her:files-revoke', id)),
  listMcpPresets: createIpcProxy('her:mcp-presets', () => ipcRenderer.invoke('her:mcp-presets')),
  checkPresetDependencies: createIpcProxy('her:mcp-dependencies', (presetId, serviceId) => ipcRenderer.invoke('her:mcp-dependencies', presetId, serviceId)),
  createMcpPreset: createIpcProxy('her:mcp-create-preset', presetId => ipcRenderer.invoke('her:mcp-create-preset', presetId)),
  listMcpServices: createIpcProxy('her:mcp-list', () => ipcRenderer.invoke('her:mcp-list')),
  getMcpEnvironment: createIpcProxy('her:mcp-environment', (id, revision) => ipcRenderer.invoke('her:mcp-environment', id, revision)),
  saveMcpService: createIpcProxy('her:mcp-save', input => ipcRenderer.invoke('her:mcp-save', input)),
  deleteMcpService: createIpcProxy('her:mcp-delete', id => ipcRenderer.invoke('her:mcp-delete', id)),
  testMcpService: createIpcProxy('her:mcp-test', id => ipcRenderer.invoke('her:mcp-test', id)),
  setMcpServiceEnabled: createIpcProxy('her:mcp-enable', (id, enabled, revision) => ipcRenderer.invoke('her:mcp-enable', id, enabled, revision)),
  listMcpTools: createIpcProxy('her:mcp-tools', id => ipcRenderer.invoke('her:mcp-tools', id)),
  getMcpStatus: createIpcProxy('her:mcp-status', id => ipcRenderer.invoke('her:mcp-status', id)),
  getConversationTask: createIpcProxy('her:task-get', id => ipcRenderer.invoke('her:task-get', id)),
  decideToolApproval: createIpcProxy('her:task-approval', input => ipcRenderer.invoke('her:task-approval', input)),
  revokeConversationApprovals: createIpcProxy('her:task-revoke-approval', id => ipcRenderer.invoke('her:task-revoke-approval', id)),
  resolveUnknownToolCall: createIpcProxy('her:task-resolve-unknown', input => ipcRenderer.invoke('her:task-resolve-unknown', input)),
  continueTask: createIpcProxy('her:task-continue', input => ipcRenderer.invoke('her:task-continue', input)),
  getConversationContext: createIpcProxy('her:context-usage', input => ipcRenderer.invoke('her:context-usage', input)),
  getQueue: createIpcProxy('her:queue-get', id => ipcRenderer.invoke('her:queue-get', id)),
  cancelQueuedMessage: createIpcProxy('her:queue-cancel', (conversationId, requestId) => ipcRenderer.invoke('her:queue-cancel', conversationId, requestId)),
  resumeQueue: createIpcProxy('her:queue-resume', id => ipcRenderer.invoke('her:queue-resume', id)),
  compactConversation: createIpcProxy('her:compact', input => ipcRenderer.invoke('her:compact', input)),
  stopCompaction: createIpcProxy('her:compact-stop', id => ipcRenderer.invoke('her:compact-stop', id)),
  switchModel: createIpcProxy('her:model-switch', input => ipcRenderer.invoke('her:model-switch', input)),
  getArtifactPreview: createIpcProxy('her:artifact-preview', (id, conversationId) => ipcRenderer.invoke('her:artifact-preview', id, conversationId)),
  selectWorkspace: createIpcProxy('her:workspace-select', input => ipcRenderer.invoke('her:workspace-select', input)),
  listWorkItems: createIpcProxy('her:workspace-list', () => ipcRenderer.invoke('her:workspace-list')),
  getPendingActions: createIpcProxy('her:workspace-pending', () => ipcRenderer.invoke('her:workspace-pending')),
  resolvePendingAction: createIpcProxy('her:workspace-resolve-pending', input => ipcRenderer.invoke('her:workspace-resolve-pending', input)),
  onWorkspaceRequestEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceRequestEvent) => callback(payload)
    ipcRenderer.on('her:workspace-request-event', listener)
    return () => { ipcRenderer.removeListener('her:workspace-request-event', listener) }
  },
  onWorkspaceTaskEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceTaskEvent) => callback(payload)
    ipcRenderer.on('her:workspace-task-event', listener)
    return () => { ipcRenderer.removeListener('her:workspace-task-event', listener) }
  },
  getPendingActionOpen: createIpcProxy('her:workspace-pending-open', () => ipcRenderer.invoke('her:workspace-pending-open')),
  ackPendingActionOpen: createIpcProxy('her:workspace-pending-ack', input => ipcRenderer.invoke('her:workspace-pending-ack', input)),
  onPendingActionOpen: callback => {
    const listener = () => callback()
    ipcRenderer.on('her:workspace-pending-open-event', listener)
    return () => { ipcRenderer.removeListener('her:workspace-pending-open-event', listener) }
  },
  onPendingActions: callback => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PendingActionNotice[]) => callback(payload)
    ipcRenderer.on('her:workspace-pending-event', listener)
    return () => { ipcRenderer.removeListener('her:workspace-pending-event', listener) }
  },
  getBootstrap: createIpcProxy('her:bootstrap', () => ipcRenderer.invoke('her:bootstrap')),
  listModelCatalog: createIpcProxy('her:profile-catalog', () => ipcRenderer.invoke('her:profile-catalog')),
  saveProfile: createIpcProxy('her:profile-save', input => ipcRenderer.invoke('her:profile-save', input)),
  deleteProfile: createIpcProxy('her:profile-delete', id => ipcRenderer.invoke('her:profile-delete', id)),
  selectProfile: createIpcProxy('her:profile-select', id => ipcRenderer.invoke('her:profile-select', id)),
  testProfile: createIpcProxy('her:profile-test', (id, kind, model) => ipcRenderer.invoke('her:profile-test', id, kind, model)),
  createConversation: createIpcProxy('her:conversation-create', () => ipcRenderer.invoke('her:conversation-create')),
  renameConversation: createIpcProxy('her:conversation-rename', (id, title) => ipcRenderer.invoke('her:conversation-rename', id, title)),
  trashConversation: createIpcProxy('her:conversation-trash', id => ipcRenderer.invoke('her:conversation-trash', id)),
  restoreConversation: createIpcProxy('her:conversation-restore', id => ipcRenderer.invoke('her:conversation-restore', id)),
  purgeConversation: createIpcProxy('her:conversation-purge', id => ipcRenderer.invoke('her:conversation-purge', id)),
  purgeConversations: createIpcProxy('her:conversation-purge-batch', ids => ipcRenderer.invoke('her:conversation-purge-batch', ids)),
  listTrashedConversations: createIpcProxy('her:conversation-trash-list', () => ipcRenderer.invoke('her:conversation-trash-list')),
  getMessages: createIpcProxy('her:messages', id => ipcRenderer.invoke('her:messages', id)),
  sendMessage: createIpcProxy('her:message-send', input => ipcRenderer.invoke('her:message-send', input)),
  cancelMessage: createIpcProxy('her:message-cancel', requestId => ipcRenderer.invoke('her:message-cancel', requestId)),
  setDesktopPreferences: createIpcProxy('her:desktop-save', input => ipcRenderer.invoke('her:desktop-save', input)),
  setAppearance: createIpcProxy('her:appearance-set', appearance => ipcRenderer.invoke('her:appearance-set', appearance)),
  getSystemPrompt: createIpcProxy('her:system-prompt-get', () => ipcRenderer.invoke('her:system-prompt-get')),
  listSkills: createIpcProxy('her:skills-list', () => ipcRenderer.invoke('her:skills-list')),
  setSkillEnabled: createIpcProxy('her:skills-enable', (id, enabled) => ipcRenderer.invoke('her:skills-enable', id, enabled)),
  setSystemPrompt: createIpcProxy('her:system-prompt-set', prompt => ipcRenderer.invoke('her:system-prompt-set', prompt)),
  getDefaultSystemPrompt: createIpcProxy('her:system-prompt-default', () => ipcRenderer.invoke('her:system-prompt-default')),
  onWorkspaceChatEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceChatEvent) => {
      if (isDev) console.log('[IPC] ← her:workspace-chat-event')
      callback(payload)
    }
    ipcRenderer.on('her:workspace-chat-event', listener)
    return () => { ipcRenderer.removeListener('her:workspace-chat-event', listener) }
  },
  openExternal: createIpcProxy('her:external', url => ipcRenderer.invoke('her:external', url))
}

contextBridge.exposeInMainWorld('her', api)
