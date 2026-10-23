// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App'
import type { BootstrapState, ChatEvent, ChatMessage, ConnectionTestResult, DesktopSettings, HerApi, ProviderProfile, SaveProfileInput, SendMessageInput, SendMessageResult, TestKind, TrashedConversation, WorkspaceSnapshot, WorkspaceSelection, WorkspaceChatEvent, PendingActionNotice, WorkspaceTaskEvent, WorkspaceListItem } from '../src/shared/types'

const profile: ProviderProfile = {
  id: 'provider-1', name: '我的模型', protocol: 'openai', contextWindow: 128000, authMethod: 'api-key', baseUrl: 'https://example.com/proxy/v1', model: 'chat-model',
  hasApiKey: true, hasCustomHeaders: true,
  models: [{ id: 'chat-model', longOutput: false, multimodal: false, tests: { chat: { status: 'untested', message: '尚未测试' }, tools: { status: 'untested', message: '尚未测试' }, vision: { status: 'untested', message: '尚未测试' } } }]
}
const conversation = { id: 'conversation-1', title: '今天的事', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', lastMessage: '' }
const userMessage: ChatMessage = { id: 'user-1', conversationId: conversation.id, role: 'user', content: '陪我想想', status: 'complete', createdAt: '2026-10-13T00:00:01Z' }
const assistantMessage: ChatMessage = { id: 'assistant-1', conversationId: conversation.id, role: 'assistant', content: '', status: 'streaming', createdAt: '2026-10-13T00:00:02Z', profileId: profile.id, model: profile.model }

let bridge: HerApi
let backendState: BootstrapState & { conversations: typeof conversation[] }
let backendActiveRequest: { requestId: string; conversationId: string } | null
let selectionVersion: number
let selectedWorkspace: WorkspaceSelection
let emitWorkspace: (event: WorkspaceChatEvent) => void
let emitWorkspaceTask: (event: WorkspaceTaskEvent) => void
let emitPendingOpen: () => void
let emitPending: (notices: PendingActionNotice[]) => void
const dailyConversation = { ...conversation, id: 'daily', title: '日常' }
async function snapshot(selection: WorkspaceSelection): Promise<WorkspaceSnapshot> {
  selectedWorkspace = selection
  const version = ++selectionVersion
  const current = selection.section === 'daily' ? dailyConversation : backendState.conversations.find(item => item.id === selection.conversationId) ?? null
  return { activeRequest: current?.id === backendActiveRequest?.conversationId ? backendActiveRequest : null, selection: { ...selection, ...(current ? { conversationId: current.id } : {}) }, version, conversation: current, topic: current ? { conversationId: current.id, kind: current.id === 'daily' ? 'daily' : 'work', shareProgress: false, shareRevision: 1 } : null, messages: current && current.id !== 'daily' ? await bridge.getMessages(current.id) : [], task: current && current.id !== 'daily' ? await bridge.getConversationTask(current.id) : null, workItems: selection.section === 'work' ? backendState.conversations.map(conversation => ({ conversation, topic: { conversationId: conversation.id, kind: 'work', shareProgress: false, shareRevision: 1 } })) : [] }
}
let trashedState: TrashedConversation[]
let emit: (event: ChatEvent) => void
let emitRequest: (event: import('../src/shared/types').RequestEvent) => void = () => {}
let unsubscribe: ReturnType<typeof vi.fn>

function createdSnapshot(id: string, title = conversation.title): WorkspaceSnapshot {
  return { version: selectionVersion + 1, selection: { section: 'work', conversationId: id }, conversation: { ...conversation, id, title }, topic: { conversationId: id, kind: 'work', shareProgress: false, shareRevision: 1 }, messages: [], task: null, workItems: [] }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function commitProfile(input: SaveProfileInput) {
  const previous = backendState.profiles.find((item) => item.id === input.id)
  const saved: ProviderProfile = {
    ...profile, id: input.id ?? 'provider-new', name: input.name, protocol: input.protocol, baseUrl: input.baseUrl, model: input.model, authMethod: input.authMethod, contextWindow: input.contextWindow, catalogProvider: input.catalogProvider,
    models: (input.models ?? [{ id: input.model }]).map((entry) => ({ id: entry.id, longOutput: entry.longOutput === true, multimodal: entry.multimodal === true, tests: previous?.models.find((old) => old.id === entry.id)?.tests ?? structuredClone(profile.models[0].tests) })),
    hasApiKey: input.apiKey === undefined ? previous?.hasApiKey ?? false : input.apiKey !== '',
    hasCustomHeaders: input.customHeaders === undefined ? previous?.hasCustomHeaders ?? false : Object.keys(input.customHeaders).length > 0
  }
  const maxOutputTokens = input.maxOutputTokens === undefined ? previous?.maxOutputTokens : input.maxOutputTokens ?? undefined
  if (maxOutputTokens !== undefined) saved.maxOutputTokens = maxOutputTokens
  backendState.profiles = previous ? backendState.profiles.map((item) => item.id === saved.id ? saved : item) : [...backendState.profiles, saved]
  return structuredClone(saved)
}

function commitTest(id: string, kind: TestKind, result: ConnectionTestResult, model?: string) {
  backendState.profiles = backendState.profiles.map((item) => item.id === id ? { ...item, models: item.models.map((entry) => entry.id === (model ?? item.model) ? { ...entry, tests: { ...entry.tests, [kind]: result } } : entry) } : item)
  return result
}

beforeEach(() => {
  backendActiveRequest = null
  selectionVersion = 0
  selectedWorkspace = { section: 'daily' }
  unsubscribe = vi.fn()
  trashedState = []
  backendState = {
    dailyConversationId: 'daily', profiles: [structuredClone(profile)], conversations: [conversation],
    settings: { activeProfileId: profile.id, shortcut: 'CommandOrControl+Shift+H', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: false, appearance: 'light' },
    appVersion: '0.1.0', dataDirectory: '/local/her'
  }
  emitRequest = () => {}
  bridge = {
    previewTopicHandoff: vi.fn(), commitTopicHandoff: vi.fn(), getTopicHandoffOperation: vi.fn(),
    getDelegationDetails: vi.fn().mockImplementation(async conversationId => ({ conversationId, delegations: [], scopes: [], controls: [] })),
    pauseDelegation: vi.fn(), cancelDelegation: vi.fn(), resumeDelegation: vi.fn(), approveDelegationScope: vi.fn(), rejectDelegationScope: vi.fn(),
    resolveDelegationControl: vi.fn(), prepareDelegationDenial: vi.fn(), confirmDelegationDenial: vi.fn(),
    addDroppedFiles: vi.fn().mockResolvedValue([]), listPersistentFileGrants: vi.fn().mockResolvedValue([]),
    getFilePreview: vi.fn().mockResolvedValue({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aQ==' }), openFileSource: vi.fn().mockResolvedValue(undefined),
    selectFiles: vi.fn().mockResolvedValue({ grants: [], files: [] }),
    validateDraftFiles: vi.fn().mockResolvedValue({ valid: [], invalidIds: [] }),
    listFileGrants: vi.fn().mockResolvedValue([]),
    revokeFileGrant: vi.fn().mockResolvedValue(undefined),
    listMcpPresets: vi.fn().mockResolvedValue([]), checkPresetDependencies: vi.fn().mockResolvedValue([]), createMcpPreset: vi.fn(),
    onWorkspaceRequestEvent: vi.fn().mockImplementation(callback => { emitRequest = event => callback({ selectionVersion, event }); return () => {} }),
    listMcpServices: vi.fn().mockResolvedValue([]), getMcpEnvironment: vi.fn().mockResolvedValue({}), saveMcpService: vi.fn(), deleteMcpService: vi.fn(), testMcpService: vi.fn(),
    setMcpServiceEnabled: vi.fn(), listMcpTools: vi.fn().mockResolvedValue([]), getMcpStatus: vi.fn(),
    getConversationContext: vi.fn().mockResolvedValue({ tokens: null, contextWindow: 128000 }),
    getQueue: vi.fn().mockImplementation(async (conversationId: string) => ({ conversationId, items: [], paused: null, running: false, compacting: false })),
    cancelQueuedMessage: vi.fn().mockResolvedValue(undefined), resumeQueue: vi.fn().mockResolvedValue(undefined), compactConversation: vi.fn().mockResolvedValue(undefined),
    stopCompaction: vi.fn().mockResolvedValue(undefined), switchModel: vi.fn().mockResolvedValue(undefined),
    getConversationTask: vi.fn().mockResolvedValue(null), decideToolApproval: vi.fn().mockResolvedValue(undefined), revokeConversationApprovals: vi.fn().mockResolvedValue(undefined),
    resolveUnknownToolCall: vi.fn(),
    continueTask: vi.fn(), onWorkspaceTaskEvent: vi.fn().mockImplementation(callback => { emitWorkspaceTask = callback; return () => {} }), getArtifactPreview: vi.fn(),
    getBootstrap: vi.fn().mockImplementation(async () => { const { conversations: _, ...state } = backendState; return structuredClone(state) }),
    selectWorkspace: vi.fn().mockImplementation(snapshot),
    listWorkItems: vi.fn().mockImplementation(async () => backendState.conversations.map(conversation => ({ conversation, topic: { conversationId: conversation.id, kind: 'work', shareProgress: false, shareRevision: 1 } }))),
    getPendingActions: vi.fn().mockResolvedValue([]), resolvePendingAction: vi.fn().mockResolvedValue(null),
    getPendingActionOpen: vi.fn().mockResolvedValue(null), ackPendingActionOpen: vi.fn().mockResolvedValue(undefined),
    onPendingActionOpen: vi.fn().mockImplementation(callback => { emitPendingOpen = callback; return () => {} }),
    onPendingActions: vi.fn().mockImplementation(callback => { emitPending = callback; return () => {} }),
    listModelCatalog: vi.fn().mockResolvedValue([]),
    saveProfile: vi.fn().mockImplementation(async (input) => commitProfile(input)),
    deleteProfile: vi.fn().mockImplementation(async (id) => { backendState.profiles = backendState.profiles.filter((item) => item.id !== id); if (backendState.settings.activeProfileId === id) backendState.settings.activeProfileId = null }),
    selectProfile: vi.fn().mockImplementation(async (id) => { backendState.settings.activeProfileId = id }),
    testProfile: vi.fn().mockImplementation(async (id, kind, model) => commitTest(id, kind, { status: 'passed', message: '连接成功' }, model)),
    createConversation: vi.fn().mockImplementation(async () => { const created = { ...conversation, id: 'conversation-2', title: '新的对话' }; backendState.conversations.unshift(created); return snapshot({ section: 'work', conversationId: created.id }) }),
    renameConversation: vi.fn().mockImplementation(async (id: string, title: string) => {
      const clean = title.trim()
      if (!clean) throw new Error('请输入对话标题。')
      if (!backendState.conversations.some((item) => item.id === id)) throw new Error('该对话已经不存在。')
      backendState.conversations = backendState.conversations.map((item) => item.id === id ? { ...item, title: clean, titleCustom: true } : item)
      return structuredClone(backendState.conversations.find((item) => item.id === id))
    }),
    trashConversation: vi.fn().mockImplementation(async (id: string) => {
      const target = backendState.conversations.find((item) => item.id === id)
      if (!target) throw new Error('该对话已经不存在。')
      backendState.conversations = backendState.conversations.filter((item) => item.id !== id)
      trashedState = [{ ...target, deletedAt: '2026-10-14T00:00:00Z' }, ...trashedState]
    }),
    restoreConversation: vi.fn().mockImplementation(async (id: string) => {
      const target = trashedState.find((item) => item.id === id)
      if (!target) throw new Error('该对话不在回收站中。')
      const { deletedAt: _deletedAt, ...summary } = target
      trashedState = trashedState.filter((item) => item.id !== id)
      backendState.conversations = [...backendState.conversations, summary].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return structuredClone(summary)
    }),
    purgeConversation: vi.fn().mockImplementation(async (id: string) => {
      if (!trashedState.some((item) => item.id === id)) throw new Error('只能永久删除回收站中的对话。')
      trashedState = trashedState.filter((item) => item.id !== id)
    }),
    purgeConversations: vi.fn().mockImplementation(async (ids: string[]) => {
      const invalidIds = ids.filter((id) => !trashedState.some((item) => item.id === id))
      if (invalidIds.length > 0) throw new Error('只能永久删除回收站中的对话。')
      trashedState = trashedState.filter((item) => !ids.includes(item.id))
    }),
    listTrashedConversations: vi.fn().mockImplementation(async () => structuredClone(trashedState)),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ userMessage, assistantMessage }), cancelMessage: vi.fn().mockResolvedValue(undefined),
    setDesktopPreferences: vi.fn().mockImplementation(async (input) => { backendState.settings = { ...backendState.settings, ...input }; return structuredClone(backendState.settings) }),
    setAppearance: vi.fn().mockImplementation(async appearance => { backendState.settings = { ...backendState.settings, appearance }; return structuredClone(backendState.settings) }),
    getSystemPrompt: vi.fn().mockResolvedValue(''),
    listSkills: vi.fn().mockResolvedValue([]),
    setSkillEnabled: vi.fn().mockResolvedValue([]),
    setSystemPrompt: vi.fn().mockResolvedValue(undefined),
    getDefaultSystemPrompt: vi.fn().mockResolvedValue('你是 Samantha，Her 内置的私人 AI 助手。'),
    onWorkspaceChatEvent: vi.fn().mockImplementation((callback) => { emitWorkspace = callback; emit = event => { if (event.task) emitWorkspaceTask({ selectionVersion, event: event.task }); const { task: _, ...chat } = event; callback({ selectionVersion, event: chat }) }; return unsubscribe }),
    openExternal: vi.fn().mockResolvedValue(undefined)
  }
  window.her = bridge
})

afterEach(() => cleanup())

async function openApp() {
  render(<App />)
  await screen.findByRole('textbox', { name: '消息' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '一起在做的事' })))
  const first = backendState.conversations[0]
  if (first) await act(async () => fireEvent.click(screen.getByRole('button', { name: first.title })))
  else await act(async () => fireEvent.click(screen.getAllByRole('button', { name: '另开一个话题' })[0]))
  const modelDetails = screen.queryByText('模型与能力')?.closest('details')
  if (modelDetails) modelDetails.open = true
  return { unmount: cleanup }
}

async function openTopic(title: string) {
  await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
  await userEvent.click(await screen.findByRole('button', { name: title }))
}

async function trashTopic(title: string) {
  if (screen.queryByRole('button', { name: '返回话题' })) await userEvent.click(screen.getByRole('button', { name: '返回话题' }))
  const menu = screen.getByLabelText(`${title}的更多操作`).closest('details')!
  await userEvent.click(screen.getByLabelText(`${title}的更多操作`))
  await userEvent.click(within(menu).getByRole('button', { name: '移到回收站' }))
}

describe('conversation navigation and failure recovery', () => {
  it('groups conversations by local update day and puts the latest conversation first', async () => {
    const today = new Date(); today.setHours(12, 0, 0, 0)
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
    const earlier = new Date(today); earlier.setDate(today.getDate() - 5)
    backendState.conversations = [
      { ...conversation, id: 'old', title: '以前的对话', updatedAt: earlier.toISOString() },
      { ...conversation, id: 'morning', title: '上午的对话', updatedAt: new Date(today.getTime() - 3600000).toISOString() },
      { ...conversation, id: 'yesterday', title: '昨天的对话', updatedAt: yesterday.toISOString() },
      { ...conversation, id: 'latest', title: '最近的对话', updatedAt: today.toISOString() }
    ]
    await openApp()
    await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
    const list = within(screen.getByRole('region', { name: '一起在做的事' }))
    for (const title of ['最近的对话', '上午的对话', '昨天的对话', '以前的对话']) expect(list.getByRole('button', { name: title })).toBeTruthy()
  })

  it('collapses date groups independently without changing the current conversation or draft', async () => {
    const user = userEvent.setup()
    const today = new Date()
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
    backendState.conversations = [
      { ...conversation, title: '当前对话', updatedAt: today.toISOString() },
      { ...conversation, id: 'yesterday', title: '昨日记录', updatedAt: yesterday.toISOString() }
    ]
    await openApp()
    await user.type(screen.getByRole('textbox', { name: '消息' }), '保留这段草稿')
    await user.click(screen.getByRole('button', { name: '返回话题' }))
    await user.click(screen.getByRole('button', { name: '昨日记录' }))
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('')
    await user.click(screen.getByRole('button', { name: '返回话题' }))
    await user.click(screen.getByRole('button', { name: '当前对话' }))
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('保留这段草稿')
  })

  it('restores sidebar width and collapsed groups after hiding without clearing the draft', async () => {
    const user = userEvent.setup()
    backendState.conversations = [{ ...conversation, updatedAt: new Date().toISOString() }]
    await openApp()
    const separator = screen.getByRole('separator', { name: '调整侧栏宽度' })
    separator.focus()
    await user.keyboard('{ArrowRight}')
    const width = separator.getAttribute('aria-valuenow')
    await user.type(screen.getByRole('textbox', { name: '消息' }), '侧栏收起后继续写')
    await user.click(screen.getByRole('button', { name: '隐藏侧栏' }))
    expect(screen.queryByRole('complementary', { name: '会话侧栏' })).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('侧栏收起后继续写')
    await user.click(screen.getByRole('button', { name: '显示侧栏' }))
    expect(screen.getByRole('complementary', { name: '会话侧栏' })).toBeTruthy()
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe(width)
    expect(screen.getByRole('button', { name: '一起在做的事' })).toBeTruthy()
  })

  it('bounds sidebar keyboard resizing and clamps the width when the window gets narrower', async () => {
    const user = userEvent.setup()
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 850 })
    try {
      await openApp()
      const separator = screen.getByRole('separator', { name: '调整侧栏宽度' })
      expect(separator.getAttribute('aria-valuenow')).toBe('200')
      separator.focus()
      await user.keyboard('{ArrowRight}')
      expect(separator.getAttribute('aria-valuenow')).toBe('216')
      await user.keyboard('{Home}{ArrowLeft}')
      expect(separator.getAttribute('aria-valuenow')).toBe('200')
      await user.keyboard('{End}{ArrowRight}')
      expect(separator.getAttribute('aria-valuenow')).toBe('330')
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 760 })
      fireEvent(window, new Event('resize'))
      expect(separator.getAttribute('aria-valuenow')).toBe('240')
      expect(separator.getAttribute('aria-valuemax')).toBe('240')
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })

  it('keeps tool logs out of conversation previews while retaining the readable reply', async () => {
    backendState.conversations = [
      { ...conversation, id: 'reply', title: '带工具的回复', lastMessage: '🔧 调用工具 get_current_time({}) → 2026/10/15 20:00:00\n现在晚上八点了。' },
      { ...conversation, id: 'tool-only', title: '工具记录', lastMessage: '🔧 调用工具 get_current_time({}) → 2026/10/15 20:00:00' },
      { ...conversation, id: 'plain', title: '普通摘要', lastMessage: '调用工具 get_current_time() 可以查看时间。' }
    ]
    await openApp()
    await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
    const list = within(screen.getByRole('region', { name: '一起在做的事' }))
    expect(within(list.getByRole('button', { name: '带工具的回复' })).getByText('现在晚上八点了。')).toBeTruthy()
    expect(within(list.getByRole('button', { name: '工具记录' })).getByText('工具调用记录')).toBeTruthy()
    expect(within(list.getByRole('button', { name: '普通摘要' })).getByText('调用工具 get_current_time() 可以查看时间。')).toBeTruthy()
    expect(list.queryByText(/🔧|→/)).toBeNull()
  })

  it('moves today conversations into yesterday when the local calendar day changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 15, 23, 59, 59))
    backendState.conversations = [{ ...conversation, updatedAt: new Date().toISOString() }]
    try {
      render(<App />)
      await act(async () => {})
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '一起在做的事' })))
      expect(screen.getByRole('button', { name: conversation.title })).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(screen.getByRole('button', { name: conversation.title })).toBeTruthy()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it.each([true, false])('opens the failed provider settings without changing the active service (provider exists: %s)', async (providerExists) => {
    const user = userEvent.setup()
    const active = { ...profile, id: 'provider-active', name: '当前服务' }
    backendState.profiles = providerExists ? [profile, active] : [active]
    backendState.settings.activeProfileId = active.id
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, { ...assistantMessage, status: 'failed', error: 'HTTP 401：请检查密钥。' }])
    await openApp()
    const failed = (await screen.findByText('HTTP 401：请检查密钥。')).closest('article')!
    await user.click(within(failed).getByRole('button', { name: '检查模型设置' }))
    const dialog = within(screen.getByRole('dialog', { name: '设置' }))
    expect((dialog.getByLabelText('服务名称') as HTMLInputElement).value).toBe(providerExists ? profile.name : active.name)
    expect((screen.getByLabelText('当前模型服务') as HTMLSelectElement).value).toBe(active.id)
    await user.click(dialog.getByRole('button', { name: '关闭设置' }))
    expect(within(failed).getByText('HTTP 401：请检查密钥。')).toBeTruthy()
    expect(within(failed).getByRole('button', { name: '重试' })).toBeTruthy()
  })
})

describe('renderer bridge behavior', () => {
  it('reaches the API key immediately after the connection address with the keyboard', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByLabelText('Base URL'))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByLabelText('API Key'))
  })

  it('saves advanced connection fields after editing and collapsing them', async () => {
    const user = userEvent.setup()
    backendState.profiles = [{ ...profile, protocol: 'anthropic' }]
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    const advanced = screen.getByText('高级选项').closest('details')!
    expect(advanced.open).toBe(false)
    await user.click(screen.getByText('高级选项'))
    await user.type(screen.getByLabelText('最大输出 token 数'), '8192')
    fireEvent.change(screen.getByLabelText('额外请求头'), { target: { value: '{"X-Project":"her"}' } })
    await user.click(screen.getByText('高级选项'))
    expect(advanced.open).toBe(false)
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await screen.findByText('服务已保存')
    expect(bridge.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 8192, customHeaders: { 'X-Project': 'her' } }))
    expect((screen.getByLabelText('额外请求头') as HTMLTextAreaElement).value).toBe('')
  })

  it('reveals an invalid collapsed advanced field so it can be corrected before saving', async () => {
    const user = userEvent.setup()
    backendState.profiles = [{ ...profile, protocol: 'anthropic' }]
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    const advanced = screen.getByText('高级选项').closest('details')!
    await user.click(screen.getByText('高级选项'))
    await user.type(screen.getByLabelText('最大输出 token 数'), '0')
    await user.click(screen.getByText('高级选项'))
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    expect(bridge.saveProfile).not.toHaveBeenCalled()
    expect(advanced.open).toBe(true)
    await user.clear(screen.getByLabelText('最大输出 token 数'))
    await user.type(screen.getByLabelText('最大输出 token 数'), '8192')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await screen.findByText('服务已保存')
    expect(bridge.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 8192 }))
  })

  it('focuses the delete confirmation so the fixed action can be confirmed with the keyboard', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '删除服务' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '确认删除服务' }))
    await user.keyboard('{Enter}')
    await screen.findByText('服务已删除，聊天记录已保留')
    expect(screen.queryByRole('button', { name: `编辑 ${profile.name}` })).toBeNull()
  })

  it('keeps saved credentials out of the form and preserves them when saving blank fields', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    const key = screen.getByLabelText('API Key') as HTMLInputElement
    const headers = screen.getByLabelText('额外请求头') as HTMLTextAreaElement
    expect(key.value).toBe('')
    expect(headers.value).toBe('')
    await user.clear(screen.getByLabelText('服务名称'))
    await user.type(screen.getByLabelText('服务名称'), '新名称')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: profile.id, name: '新名称', protocol: 'openai', baseUrl: profile.baseUrl, model: profile.model,
      models: expect.arrayContaining([expect.objectContaining({ id: profile.model, longOutput: false })])
    })))
    expect(screen.getByText('服务已保存')).toBeTruthy()
    expect(localStorage.length).toBe(0)
  })

  it('requires explicit clearing and rejects headers that are not a string-valued object', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByText('高级选项'))
    fireEvent.change(screen.getByLabelText('额外请求头'), { target: { value: '{"X-Token":7}' } })
    await user.click(screen.getByText('高级选项'))
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('JSON 对象'))
    expect(screen.getByText('高级选项').closest('details')!.open).toBe(true)
    expect(bridge.saveProfile).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText('额外请求头'))
    await user.click(screen.getByLabelText('清除已保存的密钥'))
    await user.click(screen.getByLabelText('清除已保存的请求头'))
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', customHeaders: {} })))
  })

  it('preserves a stream event arriving before the send acknowledgement', async () => {
    const user = userEvent.setup()
    const response = deferred<SendMessageResult>()
    let input!: SendMessageInput
    vi.mocked(bridge.sendMessage).mockImplementation((value) => { input = value; return response.promise })
    await openApp()
    await user.type(screen.getByRole('textbox', { name: '消息' }), userMessage.content)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(1))
    act(() => emit({ requestId: input.requestId, conversationId: conversation.id, message: { ...assistantMessage, content: '已经到达的文字' }, done: false }))
    expect(within(screen.getByLabelText('聊天消息')).getByText('已经到达的文字')).toBeTruthy()
    await act(async () => response.resolve({ userMessage, assistantMessage }))
    expect(within(screen.getByLabelText('聊天消息')).getByText('已经到达的文字')).toBeTruthy()
    expect(within(screen.getByLabelText('聊天消息')).getAllByText(userMessage.content)).toHaveLength(1)
    act(() => emit({ requestId: input.requestId, conversationId: conversation.id, message: { ...assistantMessage, content: '已经到达的文字', status: 'complete' }, done: true }))
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  })

  it.each([
    { kind: 'legacy string', result: '2026/10/14 23:03:27' },
    { kind: 'structured result', result: { content: [{ type: 'text' as const, text: '2026/10/14 23:03:27' }] } }
  ])('shows $kind tool calls in their own collapsed block apart from the answer text', async ({ result }) => {
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, {
      ...assistantMessage, content: '快十一点啦', status: 'complete',
      toolCalls: [{ id: 'c1', name: 'get_current_time', arguments: {}, result }]
    }])
    await openApp()
    const messages = within(await screen.findByLabelText('聊天消息'))
    const block = (await messages.findByText('工具记录：1 个步骤')).closest('details')!
    expect(block.open).toBe(false)
    expect(block.textContent).toContain('get_current_time')
    expect(block.textContent).toContain('2026/10/14 23:03:27')
    const answer = messages.getByText('快十一点啦')
    expect(block.contains(answer)).toBe(false)
  })

  it('stops a stream and retries its original user message without adding a duplicate', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.type(screen.getByRole('textbox', { name: '消息' }), userMessage.content)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(within(screen.getByLabelText('聊天消息')).getByText(userMessage.content)).toBeTruthy())
    const firstInput = vi.mocked(bridge.sendMessage).mock.calls[0][0]
    act(() => emit({ requestId: firstInput.requestId, conversationId: conversation.id, message: { ...assistantMessage, content: '想了一半' }, done: false }))
    await user.click(screen.getByRole('button', { name: '停止生成' }))
    expect(bridge.cancelMessage).toHaveBeenCalledWith(firstInput.requestId)
    act(() => emit({ requestId: firstInput.requestId, conversationId: conversation.id, message: { ...assistantMessage, content: '想了一半', status: 'cancelled' }, done: true }))
    await user.click(screen.getByRole('button', { name: '重新生成' }))
    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(2))
    expect(vi.mocked(bridge.sendMessage).mock.calls[1][0]).toMatchObject({ content: userMessage.content, retryMessageId: assistantMessage.id })
    expect(within(screen.getByLabelText('聊天消息')).getAllByText(userMessage.content)).toHaveLength(1)
  })

  it('shows provider failures and permits retrying the failed assistant message', async () => {
    const user = userEvent.setup()
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, { ...assistantMessage, content: '部分回答', status: 'failed', error: '连接中断，请检查服务地址后重试' }])
    await openApp()
    expect(await screen.findByText('连接中断，请检查服务地址后重试')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: userMessage.content, retryMessageId: assistantMessage.id })))
  })

  it('prevents repeated submissions while pending and does not submit during IME composition', async () => {
    const response = deferred<SendMessageResult>()
    vi.mocked(bridge.sendMessage).mockReturnValue(response.promise)
    await openApp()
    const composer = screen.getByRole('textbox', { name: '消息' })
    fireEvent.change(composer, { target: { value: '中文输入' } })
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    expect(bridge.sendMessage).not.toHaveBeenCalled()
    fireEvent.keyDown(composer, { key: 'Enter' })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(1))
    await act(async () => response.resolve({ userMessage, assistantMessage }))
  })

  it('persists a user-selected provider and desktop preferences through the bridge', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...backendState, ...state, profiles: [profile, { ...profile, id: 'provider-2', name: 'Claude 服务', protocol: 'anthropic' }] }
    await openApp()
    await user.selectOptions(screen.getByLabelText('当前模型服务'), 'provider-2')
    await waitFor(() => expect(bridge.selectProfile).toHaveBeenCalledWith('provider-2'))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: '桌面偏好' }))
    await user.clear(screen.getByLabelText('唤出快捷键'))
    await user.type(screen.getByLabelText('唤出快捷键'), 'CommandOrControl+Alt+H')
    await user.click(screen.getByLabelText('登录时启动 Her'))
    await user.click(screen.getByRole('button', { name: '保存偏好' }))
    await waitFor(() => expect(bridge.setDesktopPreferences).toHaveBeenCalledWith({ shortcut: 'CommandOrControl+Alt+H', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: true }))
    expect(screen.getByText('桌面偏好已保存')).toBeTruthy()
  })

  it('saves appearance immediately without submitting other desktop preferences', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: '桌面偏好' }))
    await user.click(screen.getByRole('radio', { name: '深色' }))
    await screen.findByText('外观已保存')
    expect(bridge.setAppearance).toHaveBeenCalledWith('dark')
    expect(bridge.setDesktopPreferences).not.toHaveBeenCalled()
    expect((screen.getByRole('radio', { name: '深色' }) as HTMLInputElement).checked).toBe(true)
  })

  it('keeps the saved appearance when changing appearance fails', async () => {
    const user = userEvent.setup()
    vi.mocked(bridge.setAppearance).mockRejectedValueOnce(new Error('磁盘只读'))
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: '桌面偏好' }))
    await user.click(screen.getByRole('radio', { name: '深色' }))
    expect(await screen.findByText(/外观保存失败：磁盘只读/)).toBeTruthy()
    expect((screen.getByRole('radio', { name: '浅色' }) as HTMLInputElement).checked).toBe(true)
  })

  it('uses the safe external-link bridge and disposes the stream listener', async () => {
    const user = userEvent.setup()
    vi.mocked(bridge.getMessages).mockResolvedValue([{ ...assistantMessage, content: '[资料](https://example.com/docs)\n\n![远程图片说明](https://example.com/image.png)\n\n<script>unsafe()</script>', status: 'complete' }])
    await openApp()
    await user.click(await screen.findByRole('link', { name: '资料' }))
    expect(bridge.openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('.markdown img')).toBeNull()
    expect(screen.getByText('远程图片说明')).toBeTruthy()
    cleanup()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('guides the first connection and clears transient credentials after saving the selected service', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...backendState, ...state, profiles: [], conversations: [], settings: { ...state.settings, activeProfileId: null } }
    render(<App />)
    await screen.findByRole('textbox', { name: '消息' })
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: '配置模型服务' }))
    await user.type(screen.getByLabelText('服务名称'), 'Claude')
    await user.selectOptions(screen.getByLabelText('协议'), 'anthropic')
    await user.type(screen.getByLabelText('Base URL'), 'https://example.com/proxy/v1')
    await user.type(screen.getByLabelText('Model ID'), 'claude-model')
    fireEvent.change(screen.getByLabelText('上下文容量'), { target: { value: '200000' } })
    await user.type(screen.getByLabelText('API Key'), 'entered-test-key')
    await user.click(screen.getByText('高级选项'))
    fireEvent.change(screen.getByLabelText('额外请求头'), { target: { value: '{"X-Project":"her"}' } })
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Claude', protocol: 'anthropic', baseUrl: 'https://example.com/proxy/v1', model: 'claude-model',
      models: expect.arrayContaining([expect.objectContaining({ id: 'claude-model', longOutput: false })]),
      apiKey: 'entered-test-key', customHeaders: { 'X-Project': 'her' }, maxOutputTokens: null
    })))
    await waitFor(() => expect(bridge.selectProfile).toHaveBeenCalledWith('provider-new'))
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('额外请求头') as HTMLTextAreaElement).value).toBe('')
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('shows the saved output limit across supported protocols', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...backendState, ...state, profiles: [{ ...profile, protocol: 'anthropic', maxOutputTokens: 8192 }] }
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect((screen.getByLabelText('最大输出 token 数') as HTMLInputElement).value).toBe('8192')
    await user.selectOptions(screen.getByLabelText('协议'), 'openai')
    expect(screen.getByLabelText('最大输出 token 数')).toBeTruthy()
  })

  it('saves openai-responses protocol with an optional output limit and shows R monogram', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '添加服务' }))
    await user.type(screen.getByLabelText('服务名称'), '星火')
    await user.selectOptions(screen.getByLabelText('协议'), 'openai-responses')
    expect(screen.getByLabelText('最大输出 token 数')).toBeTruthy()
    await user.type(screen.getByLabelText('Base URL'), 'https://example.com/v1')
    await user.type(screen.getByLabelText('Model ID'), 'spark-model')
    fireEvent.change(screen.getByLabelText('上下文容量'), { target: { value: '128000' } })
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      name: '星火', protocol: 'openai-responses', baseUrl: 'https://example.com/v1', model: 'spark-model',
      models: expect.arrayContaining([expect.objectContaining({ id: 'spark-model', longOutput: false })])
    })))
    expect(bridge.saveProfile).toHaveBeenCalledWith(expect.not.objectContaining({ maxOutputTokens: expect.anything() }))
    const item = screen.getByRole('button', { name: '编辑 星火' })
    expect(within(item).getByText('R')).toBeTruthy()
  })


  it('saves an empty maximum output tokens as null and a typed value as a number', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...backendState, ...state, profiles: [{ ...profile, protocol: 'anthropic' }] }
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect((screen.getByLabelText('最大输出 token 数') as HTMLInputElement).value).toBe('')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: 'anthropic', maxOutputTokens: null })))
    await user.click(screen.getByText('高级选项'))
    await user.type(screen.getByLabelText('最大输出 token 数'), '8192')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ maxOutputTokens: 8192 })))
  })

  it('adds, removes and re-defaults models and saves them with the default model id', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect((screen.getByRole('button', { name: '删除模型 1' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: '添加模型' }))
    await user.type(screen.getByLabelText('Model ID 2'), 'second-model')
    await user.click(screen.getByLabelText('设为默认模型 2'))
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({
      model: 'second-model', models: expect.arrayContaining([
        expect.objectContaining({ id: 'chat-model', longOutput: false }),
        expect.objectContaining({ id: 'second-model', longOutput: false })
      ])
    })))
    await user.click(screen.getByRole('button', { name: '删除模型 2' }))
    expect((screen.getByLabelText('设为默认模型 1') as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({
      model: 'chat-model', models: expect.arrayContaining([expect.objectContaining({ id: 'chat-model', longOutput: false })])
    })))
  })

  it('offers the 1M switch for every protocol, keeps it across protocol changes and saves it', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    for (const protocol of ['openai', 'anthropic', 'openai-responses']) {
      await user.selectOptions(screen.getByLabelText('协议'), protocol)
      expect(screen.getByLabelText('1M 1')).toBeTruthy()
      expect(screen.getByLabelText('最大输出 token 数')).toBeTruthy()
    }
    await user.click(screen.getByLabelText('1M 1'))
    await user.selectOptions(screen.getByLabelText('协议'), 'openai')
    expect((screen.getByLabelText('1M 1') as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({
      protocol: 'openai', models: expect.arrayContaining([expect.objectContaining({ id: 'chat-model', longOutput: true })])
    })))
  })

  it('explains the 262144 default in the maximum output tokens field', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...backendState, ...state, profiles: [{ ...profile, protocol: 'anthropic' }] }
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect((screen.getByLabelText('最大输出 token 数') as HTMLInputElement).placeholder).toBe('留空使用默认 262144')
    expect((screen.getByLabelText('最大输出 token 数') as HTMLInputElement).max).toBe('1000000')
  })

  it('tests the chosen model and shows that model\'s result', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    const second = { id: 'second-model', longOutput: false, multimodal: false, tests: structuredClone(profile.models[0].tests) }
    backendState = { ...backendState, ...state, profiles: [{ ...profile, models: [...profile.models, second] }] }
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.selectOptions(screen.getByLabelText('测试模型'), 'second-model')
    await user.click(screen.getByRole('button', { name: '测试文字' }))
    await screen.findByText('文字测试：连接成功')
    expect(bridge.testProfile).toHaveBeenCalledWith(profile.id, 'chat', 'second-model')
    expect(screen.getByText('已验证')).toBeTruthy()
    await user.selectOptions(screen.getByLabelText('测试模型'), 'chat-model')
    expect(screen.queryByText('已验证')).toBeNull()
  })

  describe('switching models in the chat window', () => {
    const entry = (id: string) => ({ id, longOutput: false, multimodal: false, tests: structuredClone(profile.models[0].tests) })
    const multi: ProviderProfile = { ...profile, model: 'chat-model', models: [entry('chat-model'), entry('other-model')] }
    const second: ProviderProfile = { ...profile, id: 'provider-2', name: '第二个服务', model: 'b-default', models: [entry('b-one'), entry('b-default')] }

    async function openWith(profiles: ProviderProfile[]) {
      const state = await bridge.getBootstrap()
      backendState = { ...backendState, ...state, profiles: structuredClone(profiles) }
      await openApp()
    }
    const modelPicker = () => screen.getByLabelText('当前模型') as HTMLSelectElement
    const options = () => [...modelPicker().options].map((option) => option.value)

    async function sendHello(user: ReturnType<typeof userEvent.setup>) {
      await user.type(screen.getByRole('textbox', { name: '消息' }), '你好')
      await user.click(screen.getByRole('button', { name: '发送' }))
      await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalled())
    }

    it('lists the active service models with the default selected', async () => {
      await openWith([multi])
      expect(options()).toEqual(['chat-model', 'other-model'])
      expect(modelPicker().value).toBe('chat-model')
    })

    it('keeps the conversation visible when the native model picker moves focus to the window', async () => {
      await openWith([multi])
      const blur = new FocusEvent('focusout', { bubbles: true })
      Object.defineProperty(blur, 'relatedTarget', { value: window })
      modelPicker().dispatchEvent(blur)
      expect(screen.getByRole('heading', { name: '今天的事' })).toBeTruthy()
      expect(modelPicker().closest('details')?.open).toBe(true)
    })

    it('sends the chosen model, and the default when nothing was chosen', async () => {
      const user = userEvent.setup()
      await openWith([multi])
      await sendHello(user)
      expect(vi.mocked(bridge.sendMessage).mock.calls[0][0]).toMatchObject({ model: 'chat-model' })
      await act(async () => emit({ requestId: vi.mocked(bridge.sendMessage).mock.calls[0][0].requestId, conversationId: conversation.id, message: { ...assistantMessage, status: 'complete' }, done: true }))
      await user.selectOptions(modelPicker(), 'other-model')
      expect(modelPicker().value).toBe('other-model')
      expect(modelPicker().closest('details')?.className).toBe('model-details')
      await sendHello(user)
      await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(2))
      expect(vi.mocked(bridge.sendMessage).mock.calls[1][0]).toMatchObject({ model: 'other-model' })
    })

    it('returns to the default model for a new conversation', async () => {
      const user = userEvent.setup()
      await openWith([multi])
      await user.selectOptions(modelPicker(), 'other-model')
      await user.click(screen.getByRole('button', { name: '返回话题' }))
      await user.click(screen.getByRole('button', { name: '另开一个话题' }))
      await waitFor(() => expect(modelPicker().value).toBe('chat-model'))
    })

    it('lists the new service models and selects its default after switching services', async () => {
      const user = userEvent.setup()
      await openWith([multi, second])
      await user.selectOptions(modelPicker(), 'other-model')
      await user.selectOptions(screen.getByLabelText('当前模型服务'), 'provider-2')
      await waitFor(() => expect(options()).toEqual(['b-one', 'b-default']))
      expect(modelPicker().value).toBe('b-default')
    })

    it('falls back to the default model when the chosen one is removed', async () => {
      const user = userEvent.setup()
      await openWith([multi])
      await user.selectOptions(modelPicker(), 'other-model')
      await user.click(screen.getByRole('button', { name: '设置' }))
      await user.click(screen.getByRole('button', { name: '删除模型 2' }))
      await user.click(screen.getByRole('button', { name: '保存服务' }))
      await screen.findByText('服务已保存')
      await user.click(screen.getByRole('button', { name: '关闭设置' }))
      expect(options()).toEqual(['chat-model'])
      expect(modelPicker().value).toBe('chat-model')
      await sendHello(user)
      expect(vi.mocked(bridge.sendMessage).mock.calls[0][0]).toMatchObject({ model: 'chat-model' })
    })
  })

  it('records chat and tool test results independently', async () => {
    const user = userEvent.setup()
    vi.mocked(bridge.testProfile).mockImplementation(async (id, kind) => commitTest(id, kind, kind === 'chat' ? { status: 'passed', message: '文字连通' } : { status: 'failed', message: '该服务不支持工具' }))
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '测试文字' }))
    await screen.findByText('文字测试：文字连通')
    await user.click(screen.getByRole('button', { name: '测试工具' }))
    await screen.findByText('工具测试：该服务不支持工具')
    expect(bridge.testProfile).toHaveBeenNthCalledWith(1, profile.id, 'chat')
    expect(bridge.testProfile).toHaveBeenNthCalledWith(2, profile.id, 'tools')
    expect(screen.getByText('文字连通')).toBeTruthy()
    expect(screen.getByText('该服务不支持工具')).toBeTruthy()
    expect(screen.getByText('已验证')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
  })

  it('removes a selected service only after explicit confirmation while keeping conversations', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '删除服务' }))
    expect(bridge.deleteProfile).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '确认删除服务' }))
    await screen.findByText('服务已删除，聊天记录已保留')
    expect(bridge.deleteProfile).toHaveBeenCalledWith(profile.id)
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    expect((screen.getByLabelText('当前模型服务') as HTMLSelectElement).value).toBe('')
    await user.click(screen.getByRole('button', { name: '返回话题' }))
    expect(screen.getByRole('button', { name: conversation.title })).toBeTruthy()
  })

  it('keeps a terminal response when acknowledgement and an outdated stream event arrive later', async () => {
    const user = userEvent.setup()
    const response = deferred<SendMessageResult>()
    let input!: SendMessageInput
    vi.mocked(bridge.sendMessage).mockImplementation((value) => { input = value; return response.promise })
    await openApp()
    await user.type(screen.getByRole('textbox', { name: '消息' }), userMessage.content)
    await user.click(screen.getByRole('button', { name: '发送' }))
    act(() => emit({ requestId: input.requestId, conversationId: conversation.id, message: { ...assistantMessage, content: '完整回答', status: 'complete' }, done: true }))
    await act(async () => response.resolve({ userMessage, assistantMessage }))
    act(() => emit({ requestId: input.requestId, conversationId: conversation.id, message: { ...assistantMessage, content: '过时的半段' }, done: false }))
    expect(within(screen.getByLabelText('聊天消息')).getByText('完整回答')).toBeTruthy()
    expect(screen.queryByText('过时的半段')).toBeNull()
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  })

  it('allows retrying a failed history load without requiring another conversation', async () => {
    const user = userEvent.setup()
    vi.mocked(bridge.getMessages).mockRejectedValueOnce(new Error('本地读取失败')).mockResolvedValueOnce([userMessage])
    await openApp()
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: '重试加载' }))
    await waitFor(() => expect(within(screen.getByLabelText('聊天消息')).getByText(userMessage.content)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('replaces a new conversation placeholder with the first user message title', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...backendState, ...state, conversations: [] }
    vi.mocked(bridge.sendMessage).mockResolvedValue({ userMessage: { ...userMessage, conversationId: 'conversation-2' }, assistantMessage: { ...assistantMessage, conversationId: 'conversation-2' } })
    await openApp()
    await user.type(screen.getByRole('textbox', { name: '消息' }), userMessage.content)
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(screen.getByRole('heading', { name: userMessage.content })).toBeTruthy()
  })

  it('renames the current conversation from the header and updates the sidebar', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '重命名对话' }))
    const input = screen.getByLabelText('对话标题')
    await user.clear(input)
    await user.type(input, '  周报草稿{Enter}')
    await waitFor(() => expect(bridge.renameConversation).toHaveBeenCalledWith(conversation.id, '  周报草稿'))
    expect(await screen.findByRole('heading', { name: '周报草稿' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '返回话题' }))
    expect(screen.getByRole('button', { name: '周报草稿' })).toBeTruthy()
    expect(screen.queryByLabelText('对话标题')).toBeNull()
  })

  it('cancels renaming with Escape without calling the bridge', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '重命名对话' }))
    await user.type(screen.getByLabelText('对话标题'), '不会保存{Escape}')
    expect(screen.queryByLabelText('对话标题')).toBeNull()
    expect(bridge.renameConversation).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: conversation.title })).toBeTruthy()
  })

  it('shows an error for a blank title and keeps the old one', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '重命名对话' }))
    const input = screen.getByLabelText('对话标题')
    await user.clear(input)
    await user.type(input, '   {Enter}')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('无法重命名'))
    expect(screen.getByRole('heading', { name: conversation.title })).toBeTruthy()
  })

  it('returns to daily after deleting the current work conversation', async () => {
    const user = userEvent.setup()
    const other = { ...conversation, id: 'conversation-other', title: '另一段对话' }
    const state = await bridge.getBootstrap()
    backendState = { ...backendState, ...state, conversations: [conversation, other] }
    await openApp()
    await trashTopic(conversation.title)
    await waitFor(() => expect(bridge.trashConversation).toHaveBeenCalledWith(conversation.id))
    expect(await screen.findByRole('heading', { name: '一起在做的事' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '另一段对话' })).toBeNull()
    expect(screen.queryByRole('button', { name: conversation.title })).toBeNull()
  })

  it('shows the welcome screen after deleting the only conversation', async () => {
    const user = userEvent.setup()
    await openApp()
    await trashTopic(conversation.title)
    expect(await screen.findByRole('heading', { name: '还没有一起在做的事' })).toBeTruthy()
  })

  it('keeps a generating conversation and shows why deleting it was refused', async () => {
    const user = userEvent.setup()
    vi.mocked(bridge.trashConversation).mockRejectedValueOnce(new Error('这段对话正在生成回答，请先停止。'))
    await openApp()
    await trashTopic(conversation.title)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('请先停止'))
    expect(screen.getByRole('button', { name: conversation.title })).toBeTruthy()
  })

  it('does not overwrite a custom title that equals the placeholder when the first message is sent', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...backendState, ...state, conversations: [{ ...conversation, title: '新的对话' }] }
    await openApp()
    await user.click(screen.getByRole('button', { name: '重命名对话' }))
    await user.type(screen.getByLabelText('对话标题'), '{Enter}')
    await waitFor(() => expect(bridge.renameConversation).toHaveBeenCalledWith(conversation.id, '新的对话'))
    await user.type(screen.getByRole('textbox', { name: '消息' }), userMessage.content)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalled())
    expect(screen.getByRole('heading', { name: '新的对话' })).toBeTruthy()
  })

  describe('trash panel', () => {
    const trashed: TrashedConversation = { ...conversation, id: 'trashed-1', title: '旧对话', updatedAt: '2026-10-14T00:00:00Z', lastMessage: '以前聊的', deletedAt: '2026-10-14T08:30:00Z' }

    async function openTrash(user: ReturnType<typeof userEvent.setup>) {
      trashedState = [structuredClone(trashed)]
      await openApp()
      await user.click(screen.getByRole('button', { name: '回收站' }))
      return screen.findByRole('dialog', { name: '回收站' })
    }

    it('lists deleted conversations when opened', async () => {
      const dialog = await openTrash(userEvent.setup())
      expect(await within(dialog).findByText('旧对话')).toBeTruthy()
      expect(bridge.listTrashedConversations).toHaveBeenCalledTimes(1)
    })

    it('restores a conversation to the sidebar in last-activity order', async () => {
      const user = userEvent.setup()
      const dialog = await openTrash(user)
      await user.click(await within(dialog).findByRole('button', { name: '恢复 旧对话' }))
      await waitFor(() => expect(bridge.restoreConversation).toHaveBeenCalledWith('trashed-1'))
      await waitFor(() => expect(within(dialog).queryByText('旧对话')).toBeNull())
      await user.click(within(dialog).getByRole('button', { name: '关闭回收站' }))
      await user.click(screen.getByRole('button', { name: '返回话题' }))
      expect(screen.getByRole('button', { name: '旧对话' })).toBeTruthy()
      expect(screen.getByRole('button', { name: conversation.title })).toBeTruthy()
    })

    it('asks for confirmation before permanently deleting and honours cancel', async () => {
      const user = userEvent.setup()
      const dialog = await openTrash(user)
      await user.click(await within(dialog).findByRole('button', { name: '永久删除 旧对话' }))
      expect(bridge.purgeConversation).not.toHaveBeenCalled()
      await user.click(within(dialog).getByRole('button', { name: '取消' }))
      expect(within(dialog).getByText('旧对话')).toBeTruthy()
      await user.click(within(dialog).getByRole('button', { name: '永久删除 旧对话' }))
      await user.click(within(dialog).getByRole('button', { name: '确认永久删除' }))
      await waitFor(() => expect(bridge.purgeConversation).toHaveBeenCalledWith('trashed-1'))
      await waitFor(() => expect(within(dialog).queryByText('旧对话')).toBeNull())
      expect(within(dialog).getByText('回收站是空的')).toBeTruthy()
    })

    it('shows an error when the trash cannot be read', async () => {
      const user = userEvent.setup()
      await openApp()
      vi.mocked(bridge.listTrashedConversations).mockRejectedValueOnce(new Error('磁盘不可读'))
      await user.click(screen.getByRole('button', { name: '回收站' }))
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('无法读取回收站'))
    })

    it('allows batch selecting conversations with checkboxes', async () => {
      const trashed2: TrashedConversation = { ...conversation, id: 'trashed-2', title: '另一个对话', deletedAt: '2026-10-14T09:00:00Z' }
      trashedState = [structuredClone(trashed), structuredClone(trashed2)]
      const user = userEvent.setup()
      await openApp()
      await user.click(screen.getByRole('button', { name: '回收站' }))
      const dialog = await screen.findByRole('dialog', { name: '回收站' })

      const checkbox1 = within(dialog).getByLabelText('选择 旧对话') as HTMLInputElement
      const checkbox2 = within(dialog).getByLabelText('选择 另一个对话') as HTMLInputElement

      await user.click(checkbox1)
      expect(checkbox1.checked).toBe(true)
      await user.click(checkbox2)
      expect(checkbox2.checked).toBe(true)
    })

    it('shows the selected count and clears the selection with cancel', async () => {
      const trashed2: TrashedConversation = { ...conversation, id: 'trashed-2', title: '另一个对话', deletedAt: '2026-10-14T09:00:00Z' }
      trashedState = [structuredClone(trashed), structuredClone(trashed2)]
      const user = userEvent.setup()
      await openApp()
      await user.click(screen.getByRole('button', { name: '回收站' }))
      const dialog = await screen.findByRole('dialog', { name: '回收站' })

      const checkbox1 = await within(dialog).findByLabelText('选择 旧对话') as HTMLInputElement
      const checkbox2 = within(dialog).getByLabelText('选择 另一个对话') as HTMLInputElement
      await user.click(checkbox1)
      await user.click(checkbox2)
      expect(within(dialog).getByText('2 项已选')).toBeTruthy()

      await user.click(within(dialog).getByRole('button', { name: '取消选择' }))
      expect(checkbox1.checked).toBe(false)
      expect(checkbox2.checked).toBe(false)
      expect(within(dialog).queryByText(/项已选/)).toBeNull()
    })

    it('batch deletes selected conversations with confirmation', async () => {
      const trashed2: TrashedConversation = { ...conversation, id: 'trashed-2', title: '另一个对话', deletedAt: '2026-10-14T09:00:00Z' }
      trashedState = [structuredClone(trashed), structuredClone(trashed2)]
      const user = userEvent.setup()
      await openApp()
      await user.click(screen.getByRole('button', { name: '回收站' }))
      const dialog = await screen.findByRole('dialog', { name: '回收站' })

      await user.click(within(dialog).getByLabelText('选择 旧对话'))
      await user.click(within(dialog).getByLabelText('选择 另一个对话'))
      await user.click(within(dialog).getByRole('button', { name: '删除选中项' }))

      expect(bridge.purgeConversations).not.toHaveBeenCalled()
      await user.click(within(dialog).getByRole('button', { name: '确认删除' }))
      await waitFor(() => expect(bridge.purgeConversations).toHaveBeenCalledWith(['trashed-1', 'trashed-2']))
      await waitFor(() => expect(within(dialog).queryByText('旧对话')).toBeNull())
      await waitFor(() => expect(within(dialog).queryByText('另一个对话')).toBeNull())
    })

    it('clears all conversations with confirmation', async () => {
      const trashed2: TrashedConversation = { ...conversation, id: 'trashed-2', title: '另一个对话', deletedAt: '2026-10-14T09:00:00Z' }
      trashedState = [structuredClone(trashed), structuredClone(trashed2)]
      const user = userEvent.setup()
      await openApp()
      await user.click(screen.getByRole('button', { name: '回收站' }))
      const dialog = await screen.findByRole('dialog', { name: '回收站' })

      await user.click(within(dialog).getByRole('button', { name: '清空回收站' }))
      expect(bridge.purgeConversations).not.toHaveBeenCalled()
      await user.click(within(dialog).getByRole('button', { name: '确认清空' }))
      await waitFor(() => expect(bridge.purgeConversations).toHaveBeenCalledWith(['trashed-1', 'trashed-2']))
      await waitFor(() => expect(within(dialog).getByText('回收站是空的')).toBeTruthy())
    })

    it('offers clear-all until a conversation is selected, then delete-selected', async () => {
      const user = userEvent.setup()
      const dialog = await openTrash(user)
      await within(dialog).findByText('旧对话')
      expect(within(dialog).getByRole('button', { name: '清空回收站' })).toBeTruthy()
      expect(within(dialog).queryByRole('button', { name: '删除选中项' })).toBeNull()

      await user.click(within(dialog).getByLabelText('选择 旧对话'))
      expect(within(dialog).getByRole('button', { name: '删除选中项' })).toBeTruthy()
      expect(within(dialog).queryByRole('button', { name: '清空回收站' })).toBeNull()
    })

    it('shows an error when batch delete fails', async () => {
      const trashed2: TrashedConversation = { ...conversation, id: 'trashed-2', title: '另一个对话', deletedAt: '2026-10-14T09:00:00Z' }
      trashedState = [structuredClone(trashed), structuredClone(trashed2)]
      const user = userEvent.setup()
      await openApp()
      await user.click(screen.getByRole('button', { name: '回收站' }))
      const dialog = await screen.findByRole('dialog', { name: '回收站' })

      await user.click(within(dialog).getByLabelText('选择 旧对话'))
      vi.mocked(bridge.purgeConversations).mockRejectedValueOnce(new Error('数据库错误'))
      await user.click(within(dialog).getByRole('button', { name: '删除选中项' }))
      await user.click(within(dialog).getByRole('button', { name: '确认删除' }))

      expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('无法批量删除'))
    })
  })

  it('allows stopping a new turn after cancellation rejected the previous send acknowledgement', async () => {
    const user = userEvent.setup()
    const response = deferred<SendMessageResult>()
    vi.mocked(bridge.sendMessage).mockReturnValueOnce(response.promise)
    await openApp()
    await user.type(screen.getByRole('textbox', { name: '消息' }), userMessage.content)
    await user.click(screen.getByRole('button', { name: '发送' }))
    await user.click(screen.getByRole('button', { name: '停止生成' }))
    await act(async () => response.reject(new Error('请求已取消。')))
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect((await screen.findByRole('button', { name: '停止生成' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not let a dismissed connection test revert a newer saved model', async () => {
    const user = userEvent.setup()
    const response = deferred<ConnectionTestResult>()
    vi.mocked(bridge.testProfile).mockReturnValueOnce(response.promise)
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '测试文字' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.clear(screen.getByLabelText('Model ID'))
    await user.type(screen.getByLabelText('Model ID'), 'new-model')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await screen.findByText('服务已保存')
    await act(async () => response.resolve({ status: 'untested', message: '配置已变化，请重新测试' }))
    expect((screen.getByLabelText('Model ID') as HTMLInputElement).value).toBe('new-model')
    expect(screen.queryByText('配置已变化，请重新测试')).toBeNull()
  })

  it('does not let a dismissed connection test resurrect a deleted service', async () => {
    const user = userEvent.setup()
    const response = deferred<ConnectionTestResult>()
    vi.mocked(bridge.testProfile).mockReturnValueOnce(response.promise)
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '测试文字' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '删除服务' }))
    await user.click(screen.getByRole('button', { name: '确认删除服务' }))
    await screen.findByText('服务已删除，聊天记录已保留')
    await act(async () => response.resolve({ status: 'untested', message: '配置已变化，请重新测试' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(screen.queryByRole('option', { name: profile.name })).toBeNull()
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not let a dismissed save acknowledgement replace a newer model', async () => {
    const user = userEvent.setup()
    const response = deferred<ProviderProfile>()
    vi.mocked(bridge.saveProfile).mockImplementationOnce((input) => { commitProfile(input); return response.promise })
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.clear(screen.getByLabelText('Model ID'))
    await user.type(screen.getByLabelText('Model ID'), 'first-model')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.clear(screen.getByLabelText('Model ID'))
    await user.type(screen.getByLabelText('Model ID'), 'new-model')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await screen.findByText('服务已保存')
    await act(async () => response.resolve({ ...profile, model: 'first-model' }))
    expect((screen.getByLabelText('Model ID') as HTMLInputElement).value).toBe('new-model')
  })

  it('does not let dismissed desktop preferences overwrite newer preferences', async () => {
    const user = userEvent.setup()
    const response = deferred<DesktopSettings>()
    vi.mocked(bridge.setDesktopPreferences).mockImplementationOnce((input) => { backendState.settings = { ...backendState.settings, ...input }; return response.promise })
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: '桌面偏好' }))
    await user.clear(screen.getByLabelText('唤出快捷键'))
    await user.type(screen.getByLabelText('唤出快捷键'), 'CommandOrControl+Alt+A')
    await user.click(screen.getByRole('button', { name: '保存偏好' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: '桌面偏好' }))
    await user.clear(screen.getByLabelText('唤出快捷键'))
    await user.type(screen.getByLabelText('唤出快捷键'), 'CommandOrControl+Alt+B')
    await user.click(screen.getByRole('button', { name: '保存偏好' }))
    await screen.findByText('桌面偏好已保存')
    await act(async () => response.resolve({ activeProfileId: profile.id, shortcut: 'CommandOrControl+Alt+A', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: false, appearance: 'light' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: '桌面偏好' }))
    expect((screen.getByLabelText('唤出快捷键') as HTMLInputElement).value).toBe('CommandOrControl+Alt+B')
  })

  it('does not let a dismissed first-save selection replace a newer selected service', async () => {
    const user = userEvent.setup()
    const response = deferred<void>()
    const state = await bridge.getBootstrap()
    backendState = { ...backendState, ...state, profiles: [profile, { ...profile, id: 'provider-2', name: '另一个服务' }], settings: { ...state.settings, activeProfileId: null } }
    vi.mocked(bridge.selectProfile).mockImplementationOnce((id) => { backendState.settings.activeProfileId = id; return response.promise })
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.selectProfile).toHaveBeenCalledWith(profile.id))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await user.selectOptions(screen.getByLabelText('当前模型服务'), 'provider-2')
    await waitFor(() => expect((screen.getByLabelText('当前模型服务') as HTMLSelectElement).value).toBe('provider-2'))
    await act(async () => response.resolve(undefined))
    expect((screen.getByLabelText('当前模型服务') as HTMLSelectElement).value).toBe('provider-2')
  })

  it('shows a save committed after dismissing settings when settings is reopened', async () => {
    const user = userEvent.setup()
    const commit = deferred<void>()
    vi.mocked(bridge.saveProfile).mockImplementationOnce(async (input) => { await commit.promise; return commitProfile(input) })
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.clear(screen.getByLabelText('Model ID'))
    await user.type(screen.getByLabelText('Model ID'), 'saved-while-closed')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await act(async () => commit.resolve(undefined))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await waitFor(() => expect((screen.getByLabelText('Model ID') as HTMLInputElement).value).toBe('saved-while-closed'))
  })

  it('shows a deletion committed after dismissing settings without restoring the service', async () => {
    const user = userEvent.setup()
    const commit = deferred<void>()
    vi.mocked(bridge.deleteProfile).mockImplementationOnce(async (id) => { await commit.promise; backendState.profiles = backendState.profiles.filter((item) => item.id !== id); backendState.settings.activeProfileId = null })
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '删除服务' }))
    await user.click(screen.getByRole('button', { name: '确认删除服务' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await act(async () => commit.resolve(undefined))
    expect(screen.queryByRole('option', { name: profile.name })).toBeNull()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: `编辑 ${profile.name}` })).toBeNull())
    expect(screen.queryByRole('option', { name: profile.name })).toBeNull()
  })

  it('shows desktop preferences committed after dismissing settings', async () => {
    const user = userEvent.setup()
    const commit = deferred<void>()
    vi.mocked(bridge.setDesktopPreferences).mockImplementationOnce(async (input) => { await commit.promise; backendState.settings = { ...backendState.settings, ...input }; return structuredClone(backendState.settings) })
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: '桌面偏好' }))
    await user.clear(screen.getByLabelText('唤出快捷键'))
    await user.type(screen.getByLabelText('唤出快捷键'), 'CommandOrControl+Alt+C')
    await user.click(screen.getByRole('button', { name: '保存偏好' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await act(async () => commit.resolve(undefined))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: '桌面偏好' }))
    expect((screen.getByLabelText('唤出快捷键') as HTMLInputElement).value).toBe('CommandOrControl+Alt+C')
  })

  it('preserves current form edits when a dismissed test refreshes identical configuration fields', async () => {
    const user = userEvent.setup()
    const response = deferred<ConnectionTestResult>()
    vi.mocked(bridge.testProfile).mockImplementationOnce(async (id, kind) => commitTest(id, kind, await response.promise))
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '测试文字' }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.clear(screen.getByLabelText('服务名称'))
    await user.type(screen.getByLabelText('服务名称'), '当前草稿')
    await user.type(screen.getByLabelText('API Key'), 'draft-test-key')
    await act(async () => response.resolve({ status: 'passed', message: '连接成功' }))
    expect((screen.getByLabelText('服务名称') as HTMLInputElement).value).toBe('当前草稿')
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('draft-test-key')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: '当前草稿', apiKey: 'draft-test-key' })))
  })

  it('loads the default system prompt as editable text', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: /系统提示词/ }))
    const textarea = screen.getByLabelText('系统提示词') as HTMLTextAreaElement
    expect(textarea.value).toBe('你是 Samantha，Her 内置的私人 AI 助手。')
    await user.type(textarea, '请简洁回答。')
    expect(textarea.value).toBe('你是 Samantha，Her 内置的私人 AI 助手。请简洁回答。')
    expect(screen.getByRole('button', { name: '保存提示词' })).toBeDefined()
    expect(screen.getByRole('button', { name: '恢复默认' })).toBeDefined()
  })

  it('saves system prompt and calls IPC', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: /系统提示词/ }))
    const textarea = screen.getByLabelText('系统提示词') as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, '你是一个友善的助手')
    await user.click(screen.getByRole('button', { name: '保存提示词' }))
    await waitFor(() => expect(bridge.setSystemPrompt).toHaveBeenCalledWith('你是一个友善的助手'))
  })

  it('restores default system prompt', async () => {
    vi.mocked(bridge.getSystemPrompt).mockResolvedValue('自定义提示词')
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: /系统提示词/ }))
    const textarea = screen.getByLabelText('系统提示词') as HTMLTextAreaElement
    expect(textarea.value).toBe('自定义提示词')
    await user.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(textarea.value).toBe('你是 Samantha，Her 内置的私人 AI 助手。')
    await user.click(screen.getByRole('button', { name: '保存提示词' }))
    await waitFor(() => expect(bridge.setSystemPrompt).toHaveBeenCalledWith(''))
  })

  it('waits for both prompts before allowing edits and shows a load failure', async () => {
    const response = deferred<string>()
    vi.mocked(bridge.getDefaultSystemPrompt).mockReturnValue(response.promise)
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: /系统提示词/ }))
    expect((screen.getByLabelText('系统提示词') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '保存提示词' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => response.reject(new Error('offline')))
    expect(screen.getByText('系统提示词加载失败，请关闭设置后重试。')).toBeDefined()
    expect((screen.getByRole('button', { name: '保存提示词' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows character count when typing system prompt', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: /系统提示词/ }))
    const textarea = screen.getByLabelText('系统提示词') as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, '测试文本')
    expect(screen.getByText(/已输入 4 \/ 16384 字符/)).toBeDefined()
  })
})

import type { McpServiceConfig, TaskEvent } from '../src/shared/types'
import { ArtifactPreview } from '../src/renderer/src/TaskStatus'
import TaskStatus from '../src/renderer/src/TaskStatus'

function taskEvent(status: TaskEvent['run']['status'] = 'awaiting_confirmation'): TaskEvent {
  return { requestId: 'task-request', conversationId: conversation.id,
    run: { id: 'run-1', requestId: 'task-request', conversationId: conversation.id, assistantMessageId: assistantMessage.id, status, providerId: profile.id, model: 'old-model', toolCallsCount: 1, activeMs: 1 },
    ...(status === 'awaiting_confirmation' ? { approval: { purpose: '执行请求', preview: { fields: [] }, dataClasses: [], scopeSummary: '本次', actionLabel: '确认', id: 'approval-1', runId: 'run-1', callId: 'call-1', revision: 'rev-1', target: '目标窗口', summary: '发送这条消息' } } : {}) }
}
const toolMessage: ChatMessage = { ...assistantMessage, content: '部分结果', toolCalls: [{ id: 'call-1', name: 'send', arguments: {}, status: 'awaiting_confirmation' }] }

it('collapses task execution records by default and retains the summary and user expansion during updates', async () => {
  const user = userEvent.setup()
  const task = taskEvent('completed')
  task.run.toolCallsCount = 7
  const message: ChatMessage = { ...toolMessage, toolCalls: [{ ...toolMessage.toolCalls![0], status: 'succeeded' }] }
  const view = render(<TaskStatus task={task} message={message} canContinue={false} onContinue={() => {}} onStop={() => {}} />)
  const panel = screen.getByRole('region', { name: '任务状态' })
  const summary = within(panel).getByText('已完成', { exact: true }).closest('summary')!
  expect(summary).not.toBeNull()
  const records = summary.parentElement as HTMLDetailsElement
  expect(records.open).toBe(false)
  expect(summary.textContent).toContain('已调用 7 个工具 · old-model')
  expect(within(records).getByText('工具步骤 · 已完成')).toBeTruthy()
  await user.click(summary)
  expect(records.open).toBe(true)
  view.rerender(<TaskStatus task={{ ...task, run: { ...task.run, toolCallsCount: 8 } }} message={message} canContinue={false} onContinue={() => {}} onStop={() => {}} />)
  expect(records.open).toBe(true)
  expect(summary.textContent).toContain('已调用 8 个工具')
  await user.click(summary)
  expect(records.open).toBe(false)
})

it('keeps task approval, stop and continuation controls outside collapsed execution records', async () => {
  const stop = vi.fn(), resume = vi.fn()
  const view = render(<TaskStatus task={taskEvent()} message={toolMessage} canContinue={false} onContinue={resume} onStop={stop} />)
  const panel = screen.getByRole('region', { name: '任务状态' })
  expect(panel.querySelector('details')?.open).toBe(false)
  const approve = screen.getByRole('button', { name: '确认' })
  expect(approve.closest('details')).toBeNull()
  fireEvent.click(approve)
  await waitFor(() => expect(bridge.decideToolApproval).toHaveBeenCalledWith({ approvalId: 'approval-1', revision: 'rev-1', decision: 'approve' }))
  fireEvent.click(screen.getByRole('button', { name: '停止任务' }))
  expect(stop).toHaveBeenCalledOnce()
  view.rerender(<TaskStatus task={taskEvent('stopped')} message={toolMessage} canContinue onContinue={resume} onStop={stop} />)
  const continuation = screen.getByRole('button', { name: '继续任务' })
  expect(continuation.closest('details')).toBeNull()
  fireEvent.click(continuation)
  expect(resume).toHaveBeenCalledOnce()
})

it('obsolete conversation browser flags cannot offer a blanket permission', () => {
  const task = taskEvent()
  task.approval!.allowConversation = true
  render(<TaskStatus task={{ ...task, browserAutoApproved: true }} canContinue={false} onContinue={() => {}} onStop={() => {}} />)
  expect(screen.queryByRole('button', { name: /自动允许浏览器|关闭浏览器自动/ })).toBeNull()
})

it('reload hydrates live approval and stop identity; continuation retains trace and uses the currently selected model', async () => {
  const task = taskEvent()
  backendState.profiles[0].models.push({ ...structuredClone(profile.models[0]), id: 'selected-model' })
  vi.mocked(bridge.getConversationTask).mockResolvedValue(task)
  vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, toolMessage])
  await openApp()
  await screen.findByText('目标窗口', { exact: false })
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
  await waitFor(() => expect(bridge.decideToolApproval).toHaveBeenCalledWith({ approvalId: 'approval-1', revision: 'rev-1', decision: 'approve' }))
  fireEvent.click(screen.getByRole('button', { name: '停止任务' }))
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith('task-request'))
  const stopped = { ...toolMessage, status: 'cancelled' as const, toolCalls: [{ ...toolMessage.toolCalls![0], status: 'cancelled' as const }] }
  act(() => emit({ requestId: task.requestId, conversationId: conversation.id, message: stopped, done: true, task: taskEvent('stopped') }))
  expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull()
  fireEvent.change(screen.getByLabelText('当前模型', { exact: true }), { target: { value: 'selected-model' } })
  vi.mocked(bridge.continueTask).mockResolvedValue({ userMessage, assistantMessage: { ...assistantMessage, id: 'continued' } })
  fireEvent.click(await screen.findByRole('button', { name: '继续任务' }))
  await waitFor(() => expect(bridge.continueTask).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', profileId: profile.id, model: 'selected-model' })))
  expect(screen.getAllByText(userMessage.content)).toHaveLength(1)
  expect(screen.getAllByText('部分结果').length).toBeGreaterThan(0)
})

it('a late snapshot cannot replace a newer terminal task or move an approval into another conversation', async () => {
  backendState.conversations.push({ ...conversation, id: 'conversation-2', title: '第二段' })
  await openApp()
  const late = deferred<WorkspaceSnapshot>()
  const oldVersion = selectionVersion + 1
  vi.mocked(bridge.selectWorkspace).mockReturnValueOnce(late.promise)
  fireEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
  await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
  await userEvent.click(screen.getByRole('button', { name: '第二段' }))
  await act(async () => late.resolve({ ...createdSnapshot(conversation.id), version: oldVersion, task: taskEvent() }))
  expect(screen.getByRole('heading', { name: '第二段' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '确认' })).toBeNull()
  expect(screen.queryByLabelText('任务状态')).toBeNull()
})

const mcpA: McpServiceConfig = { id: 'mcp-a', name: 'A 服务', enabled: true, transport: 'streamable-http', url: 'http://localhost:1111/mcp', revision: 1, secretKeys: ['authorization'], hasSecrets: true }
async function openMcp() {
  vi.mocked(bridge.listMcpServices).mockResolvedValue([mcpA, { ...mcpA, id: 'mcp-b', name: 'B 服务' }])
  vi.mocked(bridge.getMcpStatus).mockImplementation(async id => ({ serviceId: id, revision: 1, state: 'ready', toolCount: 1 }))
  await openApp()
  fireEvent.click(await screen.findByRole('button', { name: '设置' }))
  fireEvent.click(await screen.findByRole('tab', { name: 'MCP 工具' }))
  await screen.findByDisplayValue('A 服务')
}

it('removes the all-conversation permission and saves ordinary MCP edits without the retired field', async () => {
  vi.mocked(bridge.saveMcpService).mockResolvedValue({ ...mcpA, revision: 2 })
  await openMcp()
  expect(screen.queryByRole('checkbox', { name: '所有对话允许此工具的所有操作' })).toBeNull()
  expect(screen.queryByText(/所有对话中自动执行|不再逐次确认|关闭此开关恢复确认/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '保存 MCP 服务' }))
  await waitFor(() => expect(bridge.saveMcpService).toHaveBeenCalledWith(expect.objectContaining({ id: 'mcp-a', expectedRevision: 1 })))
  expect(vi.mocked(bridge.saveMcpService).mock.calls[0][0]).not.toHaveProperty('allowAllOperations')
})

it('keeps saved MCP configuration in focus while preset setup opens without clearing the draft', async () => {
  const user = userEvent.setup()
  vi.mocked(bridge.listMcpPresets).mockResolvedValue([{ id: 'peekaboo', name: 'Mac 操作 · Peekaboo', executable: true, defaultEnabled: true, guidance: '原生安装指引' }])
  await openMcp()
  expect(await screen.findByText('已连接')).toBeTruthy()
  const presetToggle = screen.getByText('从预设添加').closest('summary')!
  expect((presetToggle.parentElement as HTMLDetailsElement).open).toBe(false)
  await user.clear(screen.getByLabelText('MCP 名称'))
  await user.type(screen.getByLabelText('MCP 名称'), '保留我的配置草稿')
  await user.click(presetToggle)
  expect((presetToggle.parentElement as HTMLDetailsElement).open).toBe(true)
  expect(screen.getByRole('button', { name: '检查预设依赖' })).toBeTruthy()
  expect((screen.getByLabelText('MCP 名称') as HTMLInputElement).value).toBe('保留我的配置草稿')
})

it('MCP test/status refresh preserves typed drafts and secrets, then saves with CAS and explicit clear', async () => {
  const late = deferred<ConnectionTestResult>()
  vi.mocked(bridge.testMcpService).mockReturnValue(late.promise)
  vi.mocked(bridge.saveMcpService).mockResolvedValue({ ...mcpA, name: '草稿名称', revision: 2, secretKeys: [], hasSecrets: false })
  await openMcp()
  expect((screen.getByLabelText('authorization', { exact: true }) as HTMLInputElement).type).toBe('password')
  expect(bridge.getMcpEnvironment).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '测试 MCP 连接' }))
  fireEvent.change(screen.getByLabelText('MCP 名称'), { target: { value: '草稿名称' } })
  fireEvent.change(screen.getByLabelText('authorization', { exact: true }), { target: { value: 'draft-secret' } })
  await act(async () => late.resolve({ status: 'passed', message: '测试完成' }))
  expect((screen.getByLabelText('MCP 名称') as HTMLInputElement).value).toBe('草稿名称')
  expect((screen.getByLabelText('authorization', { exact: true }) as HTMLInputElement).value).toBe('draft-secret')
  fireEvent.click(screen.getByLabelText('清除 authorization'))
  fireEvent.click(screen.getByRole('button', { name: '保存 MCP 服务' }))
  await waitFor(() => expect(bridge.saveMcpService).toHaveBeenCalledWith(expect.objectContaining({ id: mcpA.id, expectedRevision: 1, name: '草稿名称', clearSecretKeys: ['authorization'] })))
})

it('a late MCP test for A cannot change B editor or its connection status', async () => {
  const late = deferred<ConnectionTestResult>()
  vi.mocked(bridge.testMcpService).mockReturnValue(late.promise)
  await openMcp()
  fireEvent.click(screen.getByRole('button', { name: '测试 MCP 连接' }))
  fireEvent.click(screen.getByRole('button', { name: /B 服务/ }))
  fireEvent.change(screen.getByLabelText('MCP 名称'), { target: { value: 'B 草稿' } })
  await act(async () => late.resolve({ status: 'passed', message: 'A 的旧测试' }))
  expect((screen.getByLabelText('MCP 名称') as HTMLInputElement).value).toBe('B 草稿')
  expect(screen.queryByText('A 的旧测试')).toBeNull()
})

it('preview ignores a late artifact from the previous conversation', async () => {
  const late = deferred<{ mimeType: string; dataUrl: string }>()
  vi.mocked(bridge.getArtifactPreview).mockReturnValue(late.promise)
  const view = render(<ArtifactPreview id="image-a" conversationId="a" />)
  fireEvent.click(screen.getByRole('button', { name: '查看工具图片' }))
  view.rerender(<ArtifactPreview id="image-b" conversationId="b" />)
  await act(async () => late.resolve({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,SECRET' }))
  expect(screen.queryByAltText('工具图片')).toBeNull()
})

it('a snapshot started before a new send cannot replace the newly admitted stop identity', async () => {
  await openApp()
  const stale = deferred<WorkspaceSnapshot>()
  const oldVersion = selectionVersion
  const sending = deferred<SendMessageResult>()
  vi.mocked(bridge.selectWorkspace).mockReturnValueOnce(stale.promise)
  vi.mocked(bridge.sendMessage).mockReturnValue(sending.promise)
  fireEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'new request' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledOnce())
  const input = vi.mocked(bridge.sendMessage).mock.calls[0][0]
  await act(async () => stale.resolve({ ...createdSnapshot(conversation.id), version: oldVersion, task: taskEvent() }))
  expect(screen.queryByRole('button', { name: '确认' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith(input.requestId))
})

it('offers the saved model vision probe and reports failed capabilities without changing the selected model', async () => {
  backendState.profiles[0].models[0].tests.vision = { status: 'failed', message: '无法识别' }
  await openApp()
  await screen.findByText(/视觉未通过/)
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  fireEvent.click(await screen.findByRole('button', { name: '测试视觉' }))
  await waitFor(() => expect(bridge.testProfile).toHaveBeenCalledWith(profile.id, 'vision'))
  expect(bridge.selectProfile).not.toHaveBeenCalled()
})

it('reload during connection preparation restores busy and stop even before a durable task exists', async () => {
  backendActiveRequest = { requestId: 'preparing', conversationId: conversation.id }
  vi.mocked(bridge.getConversationTask).mockResolvedValue(null)
  vi.mocked(bridge.sendMessage).mockResolvedValue({ userMessage, assistantMessage, queued: true })
  vi.mocked(bridge.cancelMessage).mockImplementation(async () => { backendActiveRequest = null; emitRequest({ requestId: 'preparing', conversationId: conversation.id, state: 'cancelled' }) })
  await openApp()
  const stop = await screen.findByRole('button', { name: '停止生成' })
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'second request' } })
  fireEvent.keyDown(screen.getByLabelText('消息'), { key: 'Enter', code: 'Enter' })
  await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'second request' })))
  fireEvent.click(stop)
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith('preparing'))
  await screen.findByRole('button', { name: '发送' })
})

it('late bootstrap cannot expose the active identity or approval from an unselected work topic', async () => {
  const boot = deferred<BootstrapState>()
  backendActiveRequest = { requestId: 'task-request', conversationId: conversation.id }
  vi.mocked(bridge.getBootstrap).mockReturnValueOnce(boot.promise)
  render(<App />)
  act(() => emit({ requestId: 'task-request', conversationId: conversation.id, message: { ...toolMessage, status: 'cancelled' }, done: true, task: taskEvent('stopped') }))
  const { conversations: _, ...state } = backendState
  await act(async () => boot.resolve(structuredClone(state)))
  await screen.findByLabelText('消息')
  expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  expect(screen.queryByRole('button', { name: '确认' })).toBeNull()
  expect(bridge.getConversationTask).not.toHaveBeenCalled()
})


it.each(['cancelled', 'failed'] as const)('a reloaded pre-run request clears busy on its %s lifecycle event without a stop click or refresh', async state => {
  backendActiveRequest = { requestId: 'preparing', conversationId: conversation.id }
  await openApp()
  await screen.findByRole('button', { name: '停止生成' })
  const reads = vi.mocked(bridge.getBootstrap).mock.calls.length
  act(() => emitRequest({ requestId: 'preparing', conversationId: conversation.id, state }))
  await screen.findByRole('button', { name: '发送' })
  expect(bridge.cancelMessage).not.toHaveBeenCalled()
  expect(bridge.getBootstrap).toHaveBeenCalledTimes(reads)
})

it('late lifecycle events from the old request cannot stop or replace a newer admitted request', async () => {
  backendActiveRequest = { requestId: 'old', conversationId: conversation.id }
  await openApp()
  await screen.findByRole('button', { name: '停止生成' })
  act(() => emitRequest({ requestId: 'old', conversationId: conversation.id, state: 'cancelled' }))
  await screen.findByRole('button', { name: '发送' })
  act(() => emitRequest({ requestId: 'new', conversationId: conversation.id, state: 'started' }))
  act(() => {
    emitRequest({ requestId: 'old', conversationId: conversation.id, state: 'failed', error: 'old failure' })
    emitRequest({ requestId: 'old', conversationId: conversation.id, state: 'started' })
  })
  expect(screen.queryByText('old failure')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith('new'))
})


it('a detached original send rejection cannot clear the next request after a terminal lifecycle event', async () => {
  const old = deferred<SendMessageResult>()
  const next = deferred<SendMessageResult>()
  vi.mocked(bridge.sendMessage).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  await openApp()
  await screen.findByLabelText('消息')
  await waitFor(() => expect(bridge.getMessages).toHaveBeenCalled())
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'first' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(1))
  const firstId = vi.mocked(bridge.sendMessage).mock.calls[0][0].requestId
  act(() => emitRequest({ requestId: firstId, conversationId: conversation.id, state: 'cancelled' }))
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'second' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(2))
  const nextId = vi.mocked(bridge.sendMessage).mock.calls[1][0].requestId
  await act(async () => old.reject(new Error('old rejection')))
  expect(screen.queryByText(/old rejection/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith(nextId))
})

it('grant_is_not_os_permission: missing system permission stays unready and preserves MCP draft', async () => {
  vi.mocked(bridge.listMcpPresets).mockResolvedValue([{ id: 'peekaboo', name: 'Mac 操作 · Peekaboo', defaultEnabled: true, executable: true, guidance: '原生 4.9.3 安装指引' }])
  vi.mocked(bridge.checkPresetDependencies).mockResolvedValue([{ component: 'Accessibility', status: 'permission_required', message: '请授予实际 Her 辅助功能权限' }])
  await openApp()
  await screen.findByRole('heading', { name: '今天的事' })
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  fireEvent.click(await screen.findByRole('tab', { name: 'MCP 工具' }))
  fireEvent.change(await screen.findByLabelText('MCP 名称'), { target: { value: '未保存草稿' } })
  fireEvent.click(await screen.findByRole('button', { name: '检查预设依赖' }))
  const checks = within(await screen.findByRole('list', { name: '预设依赖检查' }))
  expect(checks.getByText('Accessibility')).toBeTruthy()
  expect(checks.getByText('需授权')).toBeTruthy()
  expect(screen.getByText(/能力待就绪/)).toBeTruthy()
  expect(screen.getByText(/打开系统设置不代表已授权或委托已完成/)).toBeTruthy()
  expect((screen.getByLabelText('MCP 名称') as HTMLInputElement).value).toBe('未保存草稿')
  expect(bridge.createMcpPreset).not.toHaveBeenCalled()
})


const documentFile = { id: 'file-1', grantId: 'grant-1', name: 'notes.pdf', mimeType: 'application/pdf', size: 100, version: 'v1' }
const documentGrant = { id: 'grant-1', kind: 'file' as const, scope: 'conversation' as const, conversationId: conversation.id, displayName: 'notes.pdf', revision: 1 }

async function chooseFiles() {
  await userEvent.click(await screen.findByText('文字与附件'))
  await userEvent.click(screen.getByRole('button', { name: '添加资料' }))
}

async function openCurrentGrants() {
  await userEvent.click(await screen.findByText('文字与附件'))
  await userEvent.click(screen.getByRole('button', { name: '查看当前资料授权' }))
}

it('opens the composer file menu with real selection, directory and grant actions', async () => {
  await openApp()
  const trigger = await screen.findByText('文字与附件')
  await userEvent.click(trigger)
  expect(screen.getByRole('button', { name: '添加资料' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '授权当前话题目录' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '授权长期目录' })).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: '授权当前话题目录' }))
  expect(bridge.selectFiles).toHaveBeenCalledWith({ conversationId: conversation.id, kind: 'directory', scope: 'conversation' })
  await userEvent.click(trigger)
  await userEvent.click(screen.getByRole('button', { name: '查看当前资料授权' }))
  expect(screen.getByRole('dialog', { name: '当前资料授权' })).toBeTruthy()
  expect(screen.getByText('资料授权').closest('details')?.open).toBe(true)
})

it('attaches documents with text models and sends only IDs, preserving cancellation and retry draft', async () => {
  await openApp()
  await chooseFiles()
  expect(screen.queryByText('notes.pdf')).toBeNull()
  vi.mocked(bridge.selectFiles).mockResolvedValueOnce({ grants: [documentGrant], files: [documentFile] })
  await chooseFiles()
  expect(await screen.findByRole('button', { name: '移除 notes.pdf' })).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalled())
  expect(vi.mocked(bridge.sendMessage).mock.calls[0][0]).toMatchObject({ fileIds: ['file-1'], content: '请查看附件' })
  expect(vi.mocked(bridge.sendMessage).mock.calls[0][0].attachments).toBeUndefined()
})

it('discards native selection after A to B to A and after revoke', async () => {
  backendState.conversations.push({ ...conversation, id: 'b', title: '另一段' })
  const selecting = deferred<{ grants: typeof documentGrant[]; files: typeof documentFile[] }>()
  vi.mocked(bridge.selectFiles).mockReturnValueOnce(selecting.promise)
  await openApp()
  await chooseFiles()
  await openTopic('另一段')
  await openTopic('今天的事')
  await act(async () => selecting.resolve({ grants: [documentGrant], files: [documentFile] }))
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
})

it('settings lists persistent grants without a conversation and late diagnostics preserve model draft', async () => {
  backendState.conversations = []
  vi.mocked(bridge.listPersistentFileGrants).mockResolvedValue([{ ...documentGrant, kind: 'directory', scope: 'persistent', conversationId: undefined, displayName: '长期资料' }])
  const checks = deferred<import('../src/shared/types').DependencyCheck[]>()
  vi.mocked(bridge.checkPresetDependencies).mockReturnValue(checks.promise)
  render(<App />)
  await screen.findByRole('textbox', { name: '消息' })
  await userEvent.click(await screen.findByRole('button', { name: '设置' }))
  const name = screen.getByLabelText('服务名称'); await userEvent.clear(name); await userEvent.type(name, '未保存草稿')
  await userEvent.click(screen.getByRole('tab', { name: '资料授权' }))
  expect(await screen.findByText('长期资料')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: '检查解析器依赖' }))
  await userEvent.click(screen.getByRole('tab', { name: '模型服务' }))
  await act(async () => checks.resolve([]))
  expect((screen.getByLabelText('服务名称') as HTMLInputElement).value).toBe('未保存草稿')
  expect(bridge.createConversation).not.toHaveBeenCalled()
})

it('projects document states and real physical pages without granting arbitrary MCP sources', async () => {
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...assistantMessage, status: 'complete', toolCalls: [
    { id: 'read', name: 'read_document', arguments: { fileId: 'file-1' }, status: 'succeeded', result: { content: [], fileSources: { fileIds: ['file-1'] }, structuredContent: { documentId: 'doc', text: '真实片段', status: 'partial', source: { fileId: 'file-1', name: 'notes.pdf', section: '引言' }, range: { offset: 0, length: 4 }, truncated: false } } },
    { id: 'pdf', name: 'read_pdf_pages', arguments: { fileId: 'file-1' }, status: 'succeeded', result: { content: [], fileSources: { fileIds: ['file-1'] }, structuredContent: { renderedPages: [3], failedPages: [{ pageNumber: 2, error: 'render failure' }], pages: [{ pageNumber: 3, width: 100, height: 100 }] } } },
    { id: 'external', name: 'mcp_fake', arguments: {}, result: { content: [], structuredContent: { source: { fileId: 'bad', name: 'fake-source' } } } }
  ] }])
  await openApp()
  expect(await screen.findByText('部分提取')).toBeTruthy()
  expect(screen.getByText('真实片段')).toBeTruthy()
  expect(screen.getByText(/物理第 3 页/)).toBeTruthy()
  expect(screen.getByText(/物理第 2 页.*失败/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /fake-source/ })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '打开来源 notes.pdf' }))
  expect(bridge.openFileSource).toHaveBeenCalledWith({ conversationId: conversation.id, fileId: 'file-1' })
})

it('creates an owned conversation for attachment selection without erasing typed text', async () => {
  backendState.conversations = []
  vi.mocked(bridge.selectFiles).mockResolvedValue({ grants: [documentGrant], files: [documentFile] })
  await openApp()
  await userEvent.type(await screen.findByRole('textbox', { name: '消息' }), '保留这段草稿')
  await chooseFiles()
  expect(await screen.findByRole('button', { name: '移除 notes.pdf' })).toBeTruthy()
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('保留这段草稿')
  expect(bridge.selectFiles).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation-2' }))
})

it('drop and grant-list completions cannot cross A to B to A', async () => {
  backendState.conversations.push({ ...conversation, id: 'b', title: '另一段' })
  const dropped = deferred<typeof documentFile[]>()
  const listing = deferred<typeof documentGrant[]>()
  vi.mocked(bridge.addDroppedFiles).mockReturnValue(dropped.promise)
  vi.mocked(bridge.listFileGrants).mockReturnValueOnce(listing.promise)
  await openApp()
  await screen.findByText('文字与附件')
  fireEvent.drop(document.querySelector('.composer-area')!, { dataTransfer: { files: [new File(['hello'], 'notes.pdf')], types: ['Files'] } })
  await openTopic('另一段')
  await openTopic('今天的事')
  await act(async () => { dropped.resolve([documentFile]); listing.resolve([documentGrant]) })
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
  expect(screen.queryByRole('button', { name: '撤销 notes.pdf' })).toBeNull()
})

it('revocation discards late selection and image previews while retaining visible history', async () => {
  const image = { ...documentFile, name: 'picture.png', mimeType: 'image/png' }
  const preview = deferred<{ mimeType: string; dataUrl: string }>()
  vi.mocked(bridge.getFilePreview).mockReturnValue(preview.promise)
  vi.mocked(bridge.listFileGrants).mockResolvedValue([documentGrant])
  vi.mocked(bridge.selectFiles).mockResolvedValueOnce({ grants: [documentGrant], files: [image] })
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...userMessage, files: [image] }])
  await openApp()
  await chooseFiles()
  await screen.findByRole('button', { name: '移除 picture.png' })
  const selection = deferred<{ grants: typeof documentGrant[]; files: typeof documentFile[] }>()
  vi.mocked(bridge.selectFiles).mockReturnValueOnce(selection.promise)
  await chooseFiles()
  await openCurrentGrants()
  vi.mocked(bridge.listFileGrants).mockResolvedValue([])
  await userEvent.click(screen.getByRole('button', { name: '撤销 notes.pdf' }))
  await act(async () => { preview.resolve({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,late' }); selection.resolve({ grants: [documentGrant], files: [image] }) })
  expect(screen.queryByRole('button', { name: '移除 picture.png' })).toBeNull()
  expect(screen.queryByAltText('picture.png')).toBeNull()
  expect(screen.getByRole('button', { name: '打开来源 picture.png' })).toBeTruthy()
  expect(screen.getByText(/授权已撤销，历史保留/)).toBeTruthy()
})

it('selected image preview survives sending as a reference without inline persisted bytes', async () => {
  const image = { ...documentFile, name: 'picture.png', mimeType: 'image/png' }
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...userMessage, files: [image] }])
  await openApp()
  expect(await screen.findByAltText('picture.png')).toBeTruthy()
})

it('projects pending, failed and empty document results without inventing pages', async () => {
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...assistantMessage, status: 'complete', toolCalls: [
    { id: 'pending', name: 'read_document', arguments: { fileId: 'p' }, status: 'running' },
    { id: 'failed', name: 'read_document', arguments: { fileId: 'f' }, status: 'failed', result: { isError: true, content: [{ type: 'text', text: '提取失败' }] } },
    { id: 'empty', name: 'read_document', arguments: { fileId: 'e' }, status: 'succeeded', result: { content: [], fileSources: { fileIds: ['e'] }, structuredContent: { documentId: 'e', status: 'empty', text: '', source: { fileId: 'e', name: 'empty.pdf' }, range: { offset: 0, length: 0 }, truncated: false } } }
  ] }])
  await openApp()
  expect(await screen.findByText('正在读取…')).toBeTruthy()
  expect(screen.getByText('读取失败')).toBeTruthy()
  expect(screen.getByText('未提取到文字')).toBeTruthy()
  expect(screen.queryByText(/物理第/)).toBeNull()
})

it('late parser results in another conversation never appear in the current conversation', async () => {
  backendState.conversations.push({ ...conversation, id: 'b', title: '另一段' })
  await openApp()
  await screen.findByText('文字与附件')
  await openTopic('另一段')
  await act(async () => emit({ requestId: 'old-parse', conversationId: conversation.id, done: true, message: { ...assistantMessage, content: '', status: 'complete', toolCalls: [{ id: 'r', name: 'read_document', arguments: { fileId: 'f' }, status: 'succeeded', result: { content: [], fileSources: { fileIds: ['f'] }, structuredContent: { text: '迟到的资料片段', status: 'ready', source: { fileId: 'f', name: 'old.pdf' } } } }] } }))
  expect(screen.queryByText('迟到的资料片段')).toBeNull()
})

it('unmount drops pending file preview and picker results', async () => {
  const selection = deferred<{ grants: typeof documentGrant[]; files: typeof documentFile[] }>()
  vi.mocked(bridge.selectFiles).mockReturnValueOnce(selection.promise)
  const view = await openApp()
  await chooseFiles()
  view.unmount()
  await act(async () => selection.resolve({ grants: [documentGrant], files: [documentFile] }))
  await openApp()
  await screen.findByText('文字与附件')
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
})

it('revocation immediately invalidates pending PDF artifact previews before the revoke reply', async () => {
  vi.mocked(bridge.listFileGrants).mockResolvedValue([documentGrant])
  const preview = deferred<{ mimeType: string; dataUrl: string }>()
  const revoking = deferred<void>()
  vi.mocked(bridge.getArtifactPreview).mockReturnValueOnce(preview.promise)
  vi.mocked(bridge.revokeFileGrant).mockReturnValueOnce(revoking.promise)
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...assistantMessage, status: 'complete', toolCalls: [{ id: 'pdf', name: 'read_pdf_pages', arguments: { fileId: 'file-1' }, status: 'succeeded', result: { content: [{ type: 'image', artifactId: 'page', mimeType: 'image/png' }], fileSources: { fileIds: ['file-1'] } } }] }])
  await openApp()
  await userEvent.click(await screen.findByText('工具记录：1 个步骤'))
  await userEvent.click(screen.getByRole('button', { name: '查看工具图片' }))
  await openCurrentGrants()
  await userEvent.click(screen.getByRole('button', { name: '撤销 notes.pdf' }))
  await act(async () => preview.resolve({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,old' }))
  expect(screen.queryByAltText('工具图片')).toBeNull()
  vi.mocked(bridge.listFileGrants).mockResolvedValue([])
  await act(async () => revoking.resolve())
})

it('a failed revoke does not claim that historical source authorization was revoked', async () => {
  vi.mocked(bridge.listFileGrants).mockResolvedValue([documentGrant])
  vi.mocked(bridge.revokeFileGrant).mockRejectedValueOnce(new Error('撤销未完成，请重试'))
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...userMessage, files: [documentFile] }])
  await openApp()
  await screen.findByRole('button', { name: '打开来源 notes.pdf' })
  await openCurrentGrants()
  await userEvent.click(screen.getByRole('button', { name: '撤销 notes.pdf' }))
  expect(await screen.findByText('撤销未完成，请重试')).toBeTruthy()
  expect(screen.queryByText(/授权已撤销，历史保留/)).toBeNull()
  expect((screen.getByRole('button', { name: '打开来源 notes.pdf' }) as HTMLButtonElement).disabled).toBe(false)
})

it('a late historical parse result after revoke is labelled unavailable instead of ready for reading', async () => {
  vi.mocked(bridge.listFileGrants).mockResolvedValue([documentGrant])
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...userMessage, files: [documentFile] }])
  await openApp()
  await screen.findByRole('button', { name: '打开来源 notes.pdf' })
  await openCurrentGrants()
  vi.mocked(bridge.listFileGrants).mockResolvedValue([])
  await userEvent.click(screen.getByRole('button', { name: '撤销 notes.pdf' }))
  await act(async () => emit({ requestId: 'late-read', conversationId: conversation.id, done: true, message: { ...assistantMessage, status: 'complete', toolCalls: [{ id: 'doc', name: 'read_document', arguments: { fileId: 'file-1' }, status: 'succeeded', result: { content: [], fileSources: { fileIds: ['file-1'] }, structuredContent: { status: 'ready', text: '历史片段', source: { fileId: 'file-1', name: 'notes.pdf' }, range: { offset: 0, length: 4 } } } }] } }))
  expect(screen.queryByText('已提取文字')).toBeNull()
  expect(screen.getByText('历史结果 · 当前不可继续读取')).toBeTruthy()
})

it('first send rejection restores the original text in its newly owned conversation', async () => {
  backendState.conversations = []
  vi.mocked(bridge.sendMessage).mockRejectedValueOnce(new Error('模型不可用'))
  await openApp()
  const input = await screen.findByRole('textbox', { name: '消息' })
  await userEvent.type(input, '首次发送的原文')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByText(/发送失败：模型不可用/)
  expect((input as HTMLTextAreaElement).value).toBe('首次发送的原文')
  expect(bridge.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conversation-2' }))
})

it.each(['pending', 'completed'])('send rejection restores text during a new %s file selection without resurrecting old files', async phase => {
  const response = deferred<SendMessageResult>()
  const selection = deferred<{ grants: typeof documentGrant[]; files: typeof documentFile[] }>()
  vi.mocked(bridge.sendMessage).mockReturnValueOnce(response.promise)
  vi.mocked(bridge.selectFiles).mockResolvedValueOnce({ grants: [documentGrant], files: [documentFile] }).mockReturnValueOnce(selection.promise)
  await openApp()
  await chooseFiles()
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '待恢复原文')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await chooseFiles()
  if (phase === 'completed') await act(async () => selection.resolve({ grants: [], files: [{ ...documentFile, id: 'new-file', name: 'new.pdf' }] }))
  await act(async () => response.reject(new Error('未提交')))
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('待恢复原文')
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
  await act(async () => selection.resolve({ grants: [], files: [{ ...documentFile, id: 'new-file', name: 'new.pdf' }] }))
  expect(screen.getByRole('button', { name: '移除 new.pdf' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
})

it('send rejection restores its own text and files after A to B to A', async () => {
  backendState.conversations.push({ ...conversation, id: 'b', title: '另一段' })
  const response = deferred<SendMessageResult>()
  vi.mocked(bridge.sendMessage).mockReturnValueOnce(response.promise)
  vi.mocked(bridge.selectFiles).mockResolvedValueOnce({ grants: [documentGrant], files: [documentFile] })
  await openApp()
  await chooseFiles()
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '旧草稿')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await openTopic('另一段')
  await openTopic('今天的事')
  await act(async () => response.reject(new Error('未提交')))
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('旧草稿')
  expect(screen.getByRole('button', { name: '移除 notes.pdf' })).toBeTruthy()
})

it.each(['新的草稿', ''])('send rejection preserves newer user text edits including intentional empty text: %s', async newer => {
  const response = deferred<SendMessageResult>()
  vi.mocked(bridge.sendMessage).mockReturnValueOnce(response.promise)
  await openApp()
  const input = await screen.findByRole('textbox', { name: '消息' })
  await userEvent.type(input, '旧草稿')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await userEvent.type(input, '新的草稿')
  if (!newer) await userEvent.clear(input)
  await act(async () => response.reject(new Error('未提交')))
  expect((input as HTMLTextAreaElement).value).toBe(newer)
})

it('a delayed topic creation preserves the daily draft', async () => {
  backendState.conversations = []
  const creation = deferred<WorkspaceSnapshot>()
  vi.mocked(bridge.createConversation).mockReturnValueOnce(creation.promise)
  render(<App />)
  const input = await screen.findByRole('textbox', { name: '消息' })
  await userEvent.type(input, '日常里的草稿')
  await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
  await userEvent.click(screen.getAllByRole('button', { name: '另开一个话题' })[0])
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await act(async () => creation.resolve(createdSnapshot('created')))
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('日常里的草稿')
  expect(bridge.sendMessage).not.toHaveBeenCalled()
})


it('delayed topic creation cannot reclaim a newer topic view', async () => {
  const creation = deferred<WorkspaceSnapshot>()
  vi.mocked(bridge.createConversation).mockReturnValueOnce(creation.promise)
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '一起在做的事' }))
  await userEvent.click(screen.getByRole('button', { name: '另开一个话题' }))
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await openTopic(conversation.title)
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '新视图草稿')
  await act(async () => creation.resolve(createdSnapshot('late-created')))
  expect(bridge.sendMessage).not.toHaveBeenCalled()
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('新视图草稿')
  expect(screen.getByRole('heading', { name: conversation.title })).toBeTruthy()
})

describe('queue and task indicators', () => {
  const queueState = (patch: Partial<import('../src/shared/types').ConversationQueueState>) => ({
    conversationId: conversation.id, items: [], paused: null, running: false, compacting: false, ...patch })

  it('lists messages waiting behind the running reply, oldest first, with their preview', async () => {
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, assistantMessage])
    vi.mocked(bridge.getQueue).mockResolvedValue(queueState({ running: true, items: [
      { requestId: 'q1', userMessageId: 'u1', preview: '第一条排队的话', profileId: null, model: null, createdAt: '2026-10-20T08:00:00.000Z' },
      { requestId: 'q2', userMessageId: 'u2', preview: '第二条排队的话', profileId: null, model: null, createdAt: '2026-10-20T08:01:00.000Z' }] }))
    await openApp()
    const region = await screen.findByRole('status', { name: '排队中的消息' })
    const previews = [...region.querySelectorAll('.queued-preview')].map(node => node.textContent)
    expect(previews).toEqual(['第一条排队的话', '第二条排队的话'])
  })

  it('says why the queue is waiting for the user instead of running on', async () => {
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, assistantMessage])
    vi.mocked(bridge.getQueue).mockResolvedValue(queueState({ paused: 'compaction-failed', items: [
      { requestId: 'q1', userMessageId: 'u1', preview: '等着', profileId: null, model: null, createdAt: '2026-10-20T08:00:00.000Z' }] }))
    await openApp()
    expect(await screen.findByText('压缩失败')).toBeTruthy()
  })

  it('shows that a compaction is in progress', async () => {
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, assistantMessage])
    vi.mocked(bridge.getQueue).mockResolvedValue(queueState({ compacting: true, items: [
      { requestId: 'q1', userMessageId: 'u1', preview: '等着', profileId: null, model: null, createdAt: '2026-10-20T08:00:00.000Z' }] }))
    await openApp()
    await userEvent.click(await screen.findByLabelText('查看 token 用量与上下文'))
    expect(await screen.findByText('正在压缩上下文…')).toBeTruthy()
  })

  it('shows nothing extra when nothing is queued', async () => {
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, assistantMessage])
    await openApp()
    await waitFor(() => expect(bridge.getQueue).toHaveBeenCalledWith(conversation.id))
    await screen.findByLabelText('聊天消息')
    expect(screen.queryByRole('status', { name: '排队中的消息' })).toBeNull()
  })

  it('shows a waiting approval in its conversation', async () => {
    vi.mocked(bridge.getConversationTask).mockResolvedValue(taskEvent())
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, toolMessage])
    await openApp()
    expect(await screen.findByRole('button', { name: '确认' })).toBeTruthy()
  })

  it('does not mark a finished task in the sidebar', async () => {
    vi.mocked(bridge.getConversationTask).mockResolvedValue(taskEvent('stopped'))
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, toolMessage])
    await openApp()
    await screen.findByText('已停止', { exact: false })
    expect(document.querySelector('.task-indicator')).toBeNull()
  })
})

describe('token usage display', () => {
  it.each([null, 11])('keeps token counts out of the answer bubble', async input => {
    bridge.getMessages = vi.fn().mockResolvedValue([userMessage, { ...assistantMessage, content: 'done', status: 'complete', usage: { input, output: input === null ? null : 5 } }])
    await openApp()
    await screen.findByText('done')
    expect(document.querySelector('.message-usage')).toBeNull()
    expect(screen.queryByText(input === null ? '用量未知' : '输入 11 / 输出 5 token')).toBeNull()
  })
})

describe('explicit model source and authentication', () => {
  it('keeps authentication mode when renaming a saved service', async () => {
    const user = userEvent.setup(); await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect((screen.getByLabelText('认证方式') as HTMLSelectElement).value).toBe('api-key')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ authMethod: 'api-key' })))
  })

  it('shows catalog capacity and image capability and saves the selected catalog provider', async () => {
    const user = userEvent.setup()
    bridge.listModelCatalog = vi.fn().mockResolvedValue([{ provider: 'anthropic', id: 'catalog-model', name: '目录模型', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', contextWindow: 200000, maxOutputTokens: 64000, multimodal: true }])
    await openApp(); await user.click(screen.getByRole('button', { name: '设置' }))
    await user.selectOptions(screen.getByLabelText('模型来源'), 'catalog')
    await user.selectOptions(await screen.findByLabelText('Pi 目录模型'), 'anthropic/catalog-model')
    expect((screen.getByLabelText('上下文容量') as HTMLInputElement).value).toBe('200000')
    expect(screen.getByText(/支持图片.*工具能力/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(bridge.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ catalogProvider: 'anthropic', model: 'catalog-model', maxOutputTokens: 64000 })))
  })
})

describe('ordered runtime events', () => {
  it('discards an older sequence without overwriting a newer answer', async () => {
    await openApp()
    await act(async () => emit({ conversationId: conversation.id, requestId: 'ordered', runId: 'run-ordered', generation: 0, seq: 10, message: { ...assistantMessage, content: 'newest' }, done: false }))
    await within(screen.getByLabelText('聊天消息')).findByText('newest')
    await act(async () => emit({ conversationId: conversation.id, requestId: 'ordered', runId: 'run-ordered', generation: 0, seq: 9, message: { ...assistantMessage, content: 'stale' }, done: false }))
    expect(screen.queryByText('stale')).toBeNull()
    expect(within(screen.getByLabelText('聊天消息')).getByText('newest')).toBeTruthy()
  })
})

describe('conversation runtime controls', () => {
  it('lets a second conversation send while the first is running', async () => {
    backendState.conversations.push({ ...conversation, id: 'second', title: '另一段' })
    backendActiveRequest = { conversationId: conversation.id, requestId: 'background' }
    const user = userEvent.setup(); await openApp()
    await openTopic('另一段')
    await user.type(screen.getByRole('textbox', { name: '消息' }), 'parallel{Enter}')
    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'second', content: 'parallel' })))
  })

  it('offers withdrawal and explicit resume for paused queued messages', async () => {
    vi.mocked(bridge.getQueue).mockResolvedValue({ conversationId: conversation.id, items: [{ requestId: 'queued', userMessageId: 'queued-user', preview: 'waiting', profileId: profile.id, model: profile.model, createdAt: conversation.createdAt }], paused: 'stopped', running: false, compacting: false })
    const user = userEvent.setup(); await openApp()
    await user.click(await screen.findByRole('button', { name: '撤销排队消息 waiting' }))
    expect(bridge.cancelQueuedMessage).toHaveBeenCalledWith(conversation.id, 'queued')
    await user.click(screen.getByRole('button', { name: '继续队列' }))
    expect(bridge.resumeQueue).toHaveBeenCalledWith(conversation.id)
  })

  it('offers manual compaction and a stop entry even with no queued messages', async () => {
    const user = userEvent.setup(); await openApp()
    await user.click(await screen.findByLabelText('查看 token 用量与上下文'))
    await user.click(await screen.findByRole('button', { name: '压缩上下文' }))
    expect(bridge.compactConversation).toHaveBeenCalledWith(expect.objectContaining({ conversationId: conversation.id, profileId: profile.id }))
    vi.mocked(bridge.getQueue).mockResolvedValue({ conversationId: conversation.id, items: [], paused: null, running: false, compacting: true })
    await act(async () => emitRequest({ requestId: 'tick', conversationId: conversation.id, state: 'started' }))
    await user.click(await screen.findByRole('button', { name: '停止压缩' }))
    expect(bridge.stopCompaction).toHaveBeenCalledWith(conversation.id)
  })
})

describe('durable cleanup retry', () => {
  it('shows failed cleanup after reopening the trash and retries without offering restore', async () => {
    trashedState = [{ ...conversation, deletedAt: conversation.updatedAt, cleanupPending: true, cleanupError: '清理未完成，请重试。' }]
    const user = userEvent.setup(); await openApp()
    await user.click(screen.getByRole('button', { name: '回收站' }))
    await screen.findByText('清理未完成，请重试。')
    expect(screen.queryByRole('button', { name: `恢复 ${conversation.title}` })).toBeNull()
    await user.click(screen.getByRole('button', { name: `重试清理 ${conversation.title}` }))
    await waitFor(() => expect(bridge.purgeConversation).toHaveBeenCalledWith(conversation.id))
    await screen.findByText('回收站是空的')
  })
})

describe('composer token and context controls', () => {
  it('shows only the context ring until opened, with all usage and compaction inside the panel', async () => {
    bridge.getConversationContext = vi.fn().mockResolvedValue({ tokens: 225000, contextWindow: 475000 })
    vi.mocked(bridge.getMessages).mockResolvedValue([
      { ...assistantMessage, status: 'complete', id: 'first-usage', usage: { input: 3406, output: 137 } },
      { ...assistantMessage, status: 'complete', id: 'last-usage', usage: { input: 7165, output: 101 } }
    ])
    const user = userEvent.setup(); await openApp()
    const controls = await screen.findByRole('group', { name: 'Token 用量与上下文' })
    const summary = within(controls).getByLabelText('查看 token 用量与上下文')
    await within(summary).findByText('47%')
    expect(summary.textContent).toBe('47%')
    expect((summary.closest('details') as HTMLDetailsElement).open).toBe(false)
    expect(within(controls).getByRole('button', { name: '压缩上下文' }).closest('details')).toBe(summary.closest('details'))
    await user.click(summary)
    expect(within(controls).getByRole('button', { name: '压缩上下文' })).toBeTruthy()
    expect(within(controls).getByText('7,165')).toBeTruthy()
    expect(within(controls).getByText('10,809')).toBeTruthy()
    expect(within(controls).getByText('225,000 / 475,000')).toBeTruthy()
  })
})

it('marks a partial conversation total honestly and does not substitute zero for unknown context', async () => {
  vi.mocked(bridge.getMessages).mockResolvedValue([
    { ...assistantMessage, id: 'known', status: 'complete', usage: { input: 1000, output: 200 } },
    { ...assistantMessage, id: 'unknown', status: 'complete', usage: { input: null, output: null } }
  ])
  const user = userEvent.setup(); await openApp()
  const controls = await screen.findByRole('group', { name: 'Token 用量与上下文' })
  expect(within(controls).getByLabelText('查看 token 用量与上下文').textContent).toBe('—')
  expect(within(controls).queryByText('0%')).toBeNull()
  const summary = within(controls).getByLabelText('查看 token 用量与上下文')
  await user.click(summary)
  expect((summary.closest('details') as HTMLDetailsElement).open).toBe(true)
  expect(within(controls).getByText('至少 1,200')).toBeTruthy()
  expect(within(controls).getAllByText('未知').length).toBeGreaterThan(0)
  await user.keyboard('{Escape}')
  expect((summary.closest('details') as HTMLDetailsElement).open).toBe(false)
  expect(document.activeElement).toBe(summary)
})

it('keeps successful compaction feedback visible after refreshing the context estimate', async () => {
  vi.mocked(bridge.getConversationContext).mockResolvedValue({ tokens: 8000, contextWindow: 16000 })
  vi.mocked(bridge.compactConversation).mockImplementation(async () => {
    vi.mocked(bridge.getConversationContext).mockResolvedValue({ tokens: null, contextWindow: 16000 })
  })
  const user = userEvent.setup(); await openApp()
  const summary = await screen.findByLabelText('查看 token 用量与上下文')
  await within(summary).findByText('50%')
  await user.click(summary)
  await user.click(screen.getByRole('button', { name: '压缩上下文' }))
  await within(summary).findByText('—')
  expect(await screen.findByText('上下文已压缩，历史消息仍可查看')).toBeTruthy()
})

describe('companion workspace', () => {
  it('shows the memory entry as an unavailable page with no conversation actions', async () => {
    render(<App />)
    await screen.findByRole('textbox', { name: '消息' })
    await userEvent.click(screen.getByRole('button', { name: '她记得的事' }))
    expect(await screen.findByText('记忆功能尚未开放')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '消息' })).toBeNull()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(screen.queryByRole('button', { name: '新对话' })).toBeNull()
    expect(bridge.selectWorkspace).toHaveBeenLastCalledWith({ section: 'memory' })
  })

  it('failed_detail_read_is_not_empty_and_cannot_send', async () => {
    vi.mocked(bridge.selectWorkspace).mockImplementation(async selection => {
      if (selection.section === 'work' && selection.conversationId) throw new Error('读取失败哨兵')
      return snapshot(selection)
    })
    render(<App />)
    await screen.findByRole('textbox', { name: '消息' })
    await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
    await userEvent.click(await screen.findByRole('button', { name: conversation.title }))
    expect((await screen.findByRole('alert')).textContent).toContain('读取失败哨兵')
    expect(screen.queryByRole('heading', { name: '我在，慢慢说。' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '消息' })).toBeNull()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(bridge.sendMessage).not.toHaveBeenCalled()
  })

  it('same_page_refresh_retains_readable_content_but_blocks_actions_until_reloaded', async () => {
    const nextRead = deferred<WorkspaceSnapshot>()
    let reads = 0
    const dailyMessage: ChatMessage = { ...userMessage, id: 'daily-user', conversationId: 'daily', content: '今天想去散步' }
    vi.mocked(bridge.selectWorkspace).mockImplementation(async selection => {
      if (selection.section === 'daily' && ++reads === 2) return nextRead.promise
      const result = await snapshot(selection)
      return selection.section === 'daily' ? { ...result, messages: [dailyMessage] } : result
    })
    render(<App />)
    expect(await screen.findByText('今天想去散步')).toBeTruthy()
    await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '回来再聊')
    await userEvent.click(screen.getByRole('button', { name: '日常' }))
    expect(screen.getByText('今天想去散步')).toBeTruthy()
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => nextRead.reject(new Error('刷新失败哨兵')))
    expect(screen.getByText('今天想去散步')).toBeTruthy()
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true)
    expect((await screen.findByRole('alert')).textContent).toContain('刷新失败哨兵')
    expect(bridge.sendMessage).not.toHaveBeenCalled()
  })

  it('draft_returns_to_its_owner_without_leaking_into_daily', async () => {
    render(<App />)
    await screen.findByRole('textbox', { name: '消息' })
    await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '日常草稿')
    await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
    await userEvent.click(await screen.findByRole('button', { name: conversation.title }))
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('')
    await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '话题草稿')
    await userEvent.click(screen.getByRole('button', { name: '日常' }))
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('日常草稿')
    await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
    await userEvent.click(await screen.findByRole('button', { name: conversation.title }))
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('话题草稿')
  })

  it('failed_send_after_switch_restores_only_the_origin_draft', async () => {
    const sending = deferred<SendMessageResult>()
    vi.mocked(bridge.sendMessage).mockReturnValue(sending.promise)
    render(<App />)
    await screen.findByRole('textbox', { name: '消息' })
    await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '还没发出的日常话')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledOnce())
    await openTopic(conversation.title)
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('')
    await act(async () => sending.reject(new Error('发送失败哨兵')))
    await userEvent.click(screen.getByRole('button', { name: '日常' }))
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('还没发出的日常话')
  })

  it('pending_read_failure_is_explicit_and_can_be_retried', async () => {
    vi.mocked(bridge.getPendingActions).mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce([])
    render(<App />)
    expect(await screen.findByText('待处理信息暂时无法读取。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await waitFor(() => expect(bridge.getPendingActions).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('待处理信息暂时无法读取。')).toBeNull())
  })

  it('queue_read_failure_is_explicit_and_can_be_retried', async () => {
    vi.mocked(bridge.getQueue).mockRejectedValue(new Error('read failed'))
    await openApp()
    expect(await screen.findByText('待发消息暂时无法读取。')).toBeTruthy()
    const readsBeforeRetry = vi.mocked(bridge.getQueue).mock.calls.length
    vi.mocked(bridge.getQueue).mockImplementation(async conversationId => ({ conversationId, items: [], paused: null, running: false, compacting: false }))
    await userEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await waitFor(() => expect(bridge.getQueue).toHaveBeenCalledTimes(readsBeforeRetry + 1))
    await waitFor(() => expect(screen.queryByText('待发消息暂时无法读取。')).toBeNull())
  })

  it('cancel_before_submit_keeps_original_context', async () => {
    const message: ChatMessage = { ...userMessage, id: 'daily-source', conversationId: 'daily', content: '周末想去河边走走' }
    vi.mocked(bridge.selectWorkspace).mockImplementation(async selection => selection.section === 'daily' ? { ...await snapshot(selection), messages: [message] } : snapshot(selection))
    render(<App />)
    await screen.findByText('周末想去河边走走')
    await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '原来的草稿')
    await userEvent.click(screen.getByRole('button', { name: '单独聊这件事' }))
    await userEvent.click(screen.getByRole('button', { name: '留在日常' }))
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('原来的草稿')
    expect(bridge.commitTopicHandoff).not.toHaveBeenCalled()
  })

  it('lost_commit_reply_queries_same_operation', async () => {
    const message: ChatMessage = { ...userMessage, id: 'daily-source', conversationId: 'daily', content: '周末想去河边走走' }
    vi.mocked(bridge.selectWorkspace).mockImplementation(async selection => selection.section === 'daily' ? { ...await snapshot(selection), messages: [message] } : snapshot(selection))
    vi.mocked(bridge.previewTopicHandoff).mockResolvedValue({ id: 'preview-1', digest: 'digest-1', sourceConversationId: 'daily',
      excerpts: [{ messageId: 'daily-source', role: 'user', text: message.content, createdAt: message.createdAt }], receiverLabel: '本地服务', omittedCount: 0 })
    vi.mocked(bridge.commitTopicHandoff).mockRejectedValue(new Error('reply lost'))
    vi.mocked(bridge.getTopicHandoffOperation).mockImplementation(async id => ({ operationId: id, status: 'preparing' }))
    render(<App />)
    await screen.findByText('周末想去河边走走')
    await userEvent.click(screen.getByRole('button', { name: '单独聊这件事' }))
    await screen.findByText('你 · 来自日常 · 本次选定内容')
    await userEvent.click(screen.getByRole('button', { name: '确认并另开话题' }))
    expect(await screen.findByText(/仍在核实这次保存/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '留在日常' }))
    await userEvent.click(screen.getByRole('button', { name: '单独聊这件事' }))
    await userEvent.click(screen.getByRole('button', { name: '核实这次保存' }))
    expect(bridge.commitTopicHandoff).toHaveBeenCalledTimes(1)
    expect(bridge.getTopicHandoffOperation).toHaveBeenCalledTimes(2)
    expect(vi.mocked(bridge.getTopicHandoffOperation).mock.calls[0][0]).toBe(vi.mocked(bridge.getTopicHandoffOperation).mock.calls[1][0])
  })

  it('two_confirmation_clicks_in_one_render_use_one_operation', async () => {
    const message: ChatMessage = { ...userMessage, id: 'daily-source', conversationId: 'daily', content: '周末去河边' }
    const commit = deferred<import('../src/shared/types').TopicHandoffOperation>()
    vi.mocked(bridge.selectWorkspace).mockImplementation(async selection => selection.section === 'daily' ? { ...await snapshot(selection), messages: [message] } : snapshot(selection))
    vi.mocked(bridge.previewTopicHandoff).mockResolvedValue({ id: 'preview-1', digest: 'digest-1', sourceConversationId: 'daily',
      excerpts: [{ messageId: 'daily-source', role: 'user', text: message.content, createdAt: message.createdAt }], receiverLabel: '本地服务', omittedCount: 0 })
    vi.mocked(bridge.commitTopicHandoff).mockReturnValue(commit.promise)
    render(<App />)
    await screen.findByText('周末去河边')
    await userEvent.click(screen.getByRole('button', { name: '单独聊这件事' }))
    const confirm = await screen.findByRole('button', { name: '确认并另开话题' })
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm) })
    expect(bridge.commitTopicHandoff).toHaveBeenCalledTimes(1)
    await act(async () => commit.resolve({ operationId: vi.mocked(bridge.commitTopicHandoff).mock.calls[0][0].operationId, status: 'preparing' }))
  })


  it('daily_is_default_and_work_history_is_reachable', async () => {
    render(<App />)
    expect((await screen.findByRole('button', { name: '日常' })).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: conversation.title })).toBeNull()
    expect(screen.getByRole('button', { name: '她记得的事' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
    expect((await screen.findAllByRole('heading', { name: '一起在做的事' })).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: '另开一个话题' }))
    expect(await screen.findByRole('heading', { name: '这件事，我们从哪里开始？' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '日常' }))
    expect(screen.queryByRole('heading', { name: '这件事，我们从哪里开始？' })).toBeNull()
  })
})


it('private_pending_requires_opening_original_topic', async () => {
  const notice: PendingActionNotice = { id: 'opaque-notice', version: 1, status: 'waiting_approval' }
  backendState.conversations.push({ ...conversation, id: 'private', title: '工作秘密哨兵' })
  const approval = taskEvent()
  approval.run.status = 'waiting_approval'
  approval.conversationId = 'private'; approval.run.conversationId = 'private'; approval.approval!.target = '工作秘密哨兵'
  vi.mocked(bridge.getConversationTask).mockImplementation(async id => id === 'private' ? approval : null)
  vi.mocked(bridge.getPendingActions).mockResolvedValue([notice])
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: 'private' })
  render(<App />)
  expect(await screen.findByText('有一件事需要你确认')).toBeTruthy()
  expect(screen.queryByText('工作秘密哨兵')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '查看' }))
  expect(bridge.resolvePendingAction).toHaveBeenCalledWith({ id: notice.id, version: notice.version })
  expect(await screen.findByRole('heading', { name: '工作秘密哨兵' })).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: '确认' }))
  expect(bridge.decideToolApproval).toHaveBeenCalledWith({ approvalId: 'approval-1', revision: 'rev-1', decision: 'approve' })
})

it('late_workspace_event_does_not_replace_selection', async () => {
  await openApp()
  const version = selectionVersion
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await act(async () => emitWorkspace({ selectionVersion: version, event: { requestId: 'late', conversationId: conversation.id, message: { ...assistantMessage, content: '工作秘密哨兵' }, done: false } }))
  expect(screen.queryByText('工作秘密哨兵')).toBeNull()
  expect(screen.getByRole('heading', { name: '日常' })).toBeTruthy()
})

it('trashing_a_topic_from_the_list_keeps_other_topics_available', async () => {
  backendState.conversations.push({ ...conversation, id: 'private', title: '工作秘密哨兵' })
  await openApp()
  await trashTopic(conversation.title)
  expect(await screen.findByRole('heading', { name: '一起在做的事' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: conversation.title })).toBeNull()
  expect(screen.getByRole('button', { name: '工作秘密哨兵' })).toBeTruthy()
})


it('returning to daily restores its scroll position without loading background tasks', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: '日常' })
  const area = document.querySelector<HTMLDivElement>('.chat-scroll')!
  Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 2400 })
  Object.defineProperty(area, 'clientHeight', { configurable: true, value: 400 })
  area.scrollTop = 275
  fireEvent.scroll(area)
  await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
  area.scrollTop = 0
  await userEvent.click(screen.getByRole('button', { name: conversation.title }))
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  expect(area.scrollTop).toBe(275)
  expect(bridge.getConversationTask).toHaveBeenCalledTimes(1)
  expect(bridge.getConversationTask).toHaveBeenCalledWith(conversation.id)
})

it('a same-sequence task envelope cannot suppress its message envelope', async () => {
  await openApp()
  const event = { ...taskEvent('running'), seq: 55, runId: 'same-run' }
  act(() => emitWorkspaceTask({ selectionVersion, event }))
  act(() => emitWorkspace({ selectionVersion, event: { conversationId: conversation.id, requestId: event.requestId, runId: 'same-run', seq: 55, message: { ...assistantMessage, content: '仍然显示的文字' }, done: false } }))
  expect(await within(screen.getByLabelText('聊天消息')).findByText('仍然显示的文字')).toBeTruthy()
  expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy()
})

it('a stale pending notice does not select a work topic or disclose details', async () => {
  const notice: PendingActionNotice = { id: 'expired', version: 1, status: 'waiting_approval' }
  vi.mocked(bridge.getPendingActions).mockResolvedValue([notice])
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '查看' }))
  expect(screen.getByRole('heading', { name: '日常' })).toBeTruthy()
  expect(bridge.selectWorkspace).toHaveBeenCalledTimes(1)
  expect(screen.queryByText('有一件事需要你确认')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('这件事的状态已更新')
})

it('a rejected send from the previous work topic cannot expose its error in daily', async () => {
  const sending = deferred<SendMessageResult>()
  vi.mocked(bridge.sendMessage).mockReturnValue(sending.promise)
  await openApp()
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '私密工作')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await act(async () => sending.reject(new Error('工作秘密哨兵')))
  expect(screen.queryByText(/工作秘密哨兵/)).toBeNull()
})

it.each(['renameConversation', 'trashConversation', 'resumeQueue', 'cancelMessage', 'createConversation', 'switchModel'] as const)('a late %s error cannot leak into daily or clear its draft', async method => {
  const pending = deferred<never>()
  vi.mocked(bridge[method]).mockReturnValueOnce(pending.promise)
  backendActiveRequest = method === 'cancelMessage' ? { conversationId: conversation.id, requestId: 'old-work' } : null
  backendState.profiles[0].models.push({ ...structuredClone(profile.models[0]), id: 'other-model' })
  vi.mocked(bridge.getQueue).mockImplementation(async conversationId => ({ conversationId, items: [{ requestId: 'queued', userMessageId: 'queued-user', preview: '待处理', profileId: profile.id, model: profile.model, createdAt: conversation.createdAt }], paused: 'stopped', running: false, compacting: false }))
  await openApp()
  if (method === 'renameConversation') {
    fireEvent.click(screen.getByRole('button', { name: '重命名对话' }))
    fireEvent.change(screen.getByLabelText('对话标题'), { target: { value: '旧标题' } })
    fireEvent.keyDown(screen.getByLabelText('对话标题'), { key: 'Enter' })
  } else if (method === 'switchModel') {
    fireEvent.change(screen.getByLabelText('当前模型', { exact: true }), { target: { value: 'other-model' } })
  } else if (method === 'trashConversation') {
    await trashTopic(conversation.title)
  } else if (method === 'createConversation') {
    await userEvent.click(screen.getByRole('button', { name: '返回话题' }))
    await userEvent.click(screen.getByRole('button', { name: '另开一个话题' }))
  } else {
    const name = method === 'resumeQueue' ? '继续队列' : '停止生成'
    fireEvent.click(screen.getByRole('button', { name }))
  }
  await waitFor(() => expect(bridge[method]).toHaveBeenCalled())
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '日常的新草稿')
  await act(async () => pending.reject(new Error('工作秘密哨兵')))
  expect(screen.queryByText(/工作秘密哨兵/)).toBeNull()
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('日常的新草稿')
})

it('a late successful trash cannot navigate away from the newly selected work or clear its draft', async () => {
  const pending = deferred<void>()
  vi.mocked(bridge.trashConversation).mockReturnValueOnce(pending.promise)
  backendState.conversations.push({ ...conversation, id: 'other', title: '新的工作' })
  await openApp()
  await trashTopic(conversation.title)
  await userEvent.click(screen.getByRole('button', { name: '新的工作' }))
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '新工作草稿')
  await act(async () => pending.resolve())
  expect(screen.getByRole('heading', { name: '新的工作' })).toBeTruthy()
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('新工作草稿')
})

it.each(['daily', 'work'] as const)('opens a daily-origin pending approval from %s in the daily section', async section => {
  const notice: PendingActionNotice = { id: 'daily-approval', version: 1, status: 'waiting_approval' }
  const dailyTask = taskEvent()
  dailyTask.conversationId = 'daily'; dailyTask.run.conversationId = 'daily'
  vi.mocked(bridge.getPendingActions).mockResolvedValue([notice])
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: 'daily' })
  vi.mocked(bridge.selectWorkspace).mockImplementation(async selection => {
    if (selection.section === 'work' && selection.conversationId === 'daily') throw new Error('话题不属于此工作区。')
    const result = await snapshot(selection)
    return selection.section === 'daily' ? { ...result, task: dailyTask } : result
  })
  render(<App />)
  await screen.findByRole('heading', { name: '日常' })
  if (section === 'work') {
    await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
    expect(screen.queryByRole('button', { name: '查看' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '日常' }))
  }
  await userEvent.click(screen.getByRole('button', { name: '查看' }))
  expect(await screen.findByRole('button', { name: '确认' })).toBeTruthy()
  expect(screen.queryByText(/话题不属于此工作区/)).toBeNull()
  expect(bridge.selectWorkspace).toHaveBeenLastCalledWith({ section: 'daily', conversationId: 'daily' })
  await userEvent.click(screen.getByRole('button', { name: '确认' }))
  expect(bridge.decideToolApproval).toHaveBeenCalledWith({ approvalId: 'approval-1', revision: 'rev-1', decision: 'approve' })
})

it.each(['resolve', 'reject'] as const)('late daily selection %s preserves a newer topic draft', async outcome => {
  backendState.conversations.push({ ...conversation, id: 'new-work', title: '新的工作' })
  await openApp()
  const daily = deferred<WorkspaceSnapshot>()
  const oldDaily = { ...createdSnapshot('daily', '日常'), selection: { section: 'daily' as const, conversationId: 'daily' } }
  vi.mocked(bridge.selectWorkspace).mockReturnValueOnce(daily.promise)
  fireEvent.click(screen.getByRole('button', { name: '日常' }))
  await waitFor(() => expect(bridge.selectWorkspace).toHaveBeenLastCalledWith({ section: 'daily' }))
  await openTopic('新的工作')
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '新工作草稿')
  await act(async () => { if (outcome === 'resolve') daily.resolve(oldDaily); else daily.reject(new Error('旧日常读取失败')) })
  expect(screen.getByRole('heading', { name: '新的工作' })).toBeTruthy()
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('新工作草稿')
  expect(screen.queryByText(/旧日常读取失败/)).toBeNull()
})

it('restoring unrelated trash preserves the current composer and scroll without changing the selected event version', async () => {
  trashedState = [{ ...conversation, id: 'restored', title: '恢复的工作', deletedAt: '2026-10-22T00:00:00Z' }]
  vi.mocked(bridge.selectFiles).mockResolvedValue({ grants: [documentGrant], files: [documentFile] })
  await openApp()
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '保留草稿和附件')
  await chooseFiles()
  expect(await screen.findByRole('button', { name: '移除 notes.pdf' })).toBeTruthy()
  const area = document.querySelector<HTMLDivElement>('.chat-scroll')!
  Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 2400 })
  Object.defineProperty(area, 'clientHeight', { configurable: true, value: 400 })
  area.scrollTop = 145; fireEvent.scroll(area)
  const oldVersion = selectionVersion
  await userEvent.click(screen.getByRole('button', { name: '回收站' }))
  await userEvent.click(await screen.findByRole('button', { name: '恢复 恢复的工作' }))
  await waitFor(() => expect(backendState.conversations.some(item => item.title === '恢复的工作')).toBe(true))
  expect(screen.getByRole('heading', { name: conversation.title })).toBeTruthy()
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('保留草稿和附件')
  expect(screen.getByRole('button', { name: '移除 notes.pdf' })).toBeTruthy()
  expect(area.scrollTop).toBe(145)
  expect(selectionVersion).toBe(oldVersion)
  act(() => emitWorkspace({ selectionVersion: oldVersion - 1, event: { conversationId: conversation.id, requestId: 'obsolete', message: { ...assistantMessage, content: '旧版本内容' }, done: false } }))
  act(() => emitWorkspace({ selectionVersion, event: { conversationId: conversation.id, requestId: 'current', message: { ...assistantMessage, content: '刷新后的内容' }, done: false } }))
  expect(await within(screen.getByLabelText('聊天消息')).findByText('刷新后的内容')).toBeTruthy()
  expect(screen.queryByText('旧版本内容')).toBeNull()
})

it('a restored-list refresh accepts current-topic events in flight without rolling back their final state', async () => {
  trashedState = [{ ...conversation, id: 'restored', title: '恢复的工作', deletedAt: '2026-10-22T00:00:00Z' }]
  vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, { ...assistantMessage, content: '刷新前的片段' }])
  vi.mocked(bridge.getConversationTask).mockResolvedValue(taskEvent('running'))
  await openApp()
  const refreshing = deferred<WorkspaceListItem[]>()
  let listed: WorkspaceListItem[] | undefined
  vi.mocked(bridge.listWorkItems).mockImplementationOnce(async () => { listed = backendState.conversations.map(conversation => ({ conversation, topic: null })); return refreshing.promise })
  await userEvent.click(screen.getByRole('button', { name: '回收站' }))
  await userEvent.click(await screen.findByRole('button', { name: '恢复 恢复的工作' }))
  await waitFor(() => expect(listed).toBeDefined())
  act(() => emitWorkspaceTask({ selectionVersion, event: { ...taskEvent('completed'), runId: 'run-1', seq: 10 } }))
  act(() => emitWorkspace({ selectionVersion, event: { conversationId: conversation.id, requestId: 'task-request', runId: 'run-1', seq: 10, message: { ...assistantMessage, content: '刷新期间完成的回复', status: 'complete' }, done: true } }))
  expect(await within(screen.getByLabelText('聊天消息')).findByText('刷新期间完成的回复')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  await act(async () => refreshing.resolve(listed!))
  expect(within(screen.getByLabelText('聊天消息')).getByText('刷新期间完成的回复')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
})

it('a newer daily navigation wins over an in-flight restored-list refresh and its events', async () => {
  trashedState = [{ ...conversation, id: 'restored', title: '恢复的工作', deletedAt: '2026-10-22T00:00:00Z' }]
  await openApp()
  const refreshing = deferred<WorkspaceListItem[]>()
  const eventVersion = selectionVersion
  let listed: WorkspaceListItem[] | undefined
  vi.mocked(bridge.listWorkItems).mockImplementationOnce(async () => { listed = backendState.conversations.map(conversation => ({ conversation, topic: null })); return refreshing.promise })
  await userEvent.click(screen.getByRole('button', { name: '回收站' }))
  await userEvent.click(await screen.findByRole('button', { name: '恢复 恢复的工作' }))
  await waitFor(() => expect(listed).toBeDefined())
  await userEvent.click(screen.getByRole('button', { name: '关闭回收站' }))
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '日常的新草稿')
  act(() => emitWorkspace({ selectionVersion: eventVersion, event: { conversationId: conversation.id, requestId: 'private', message: { ...assistantMessage, content: '工作秘密哨兵' }, done: false } }))
  await act(async () => refreshing.resolve(listed!))
  expect(screen.getByRole('heading', { name: '日常' })).toBeTruthy()
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('日常的新草稿')
  expect(screen.queryByText('工作秘密哨兵')).toBeNull()
  expect(screen.queryByRole('button', { name: '恢复的工作' })).toBeNull()
})

it('a failed optional work-list refresh keeps current chat, task and request events usable', async () => {
  trashedState = [{ ...conversation, id: 'restored', title: '恢复的工作', deletedAt: '2026-10-22T00:00:00Z' }]
  await openApp()
  const selectedVersion = selectionVersion
  const selections = vi.mocked(bridge.selectWorkspace).mock.calls.length
  // Reproduce the retired select-as-refresh failure ordering: version changes before a failed detail read.
  vi.mocked(bridge.selectWorkspace).mockImplementationOnce(async selection => { await snapshot(selection); throw new Error('列表读取失败') })
  vi.mocked(bridge.listWorkItems).mockRejectedValueOnce(new Error('列表读取失败'))
  await userEvent.click(screen.getByRole('button', { name: '回收站' }))
  await userEvent.click(await screen.findByRole('button', { name: '恢复 恢复的工作' }))
  await screen.findByText(/无法刷新工作列表/)
  act(() => emitRequest({ conversationId: conversation.id, requestId: 'after-list', state: 'started' }))
  expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy()
  const approval = taskEvent()
  approval.requestId = 'after-list'; approval.run.requestId = 'after-list'
  act(() => emitWorkspaceTask({ selectionVersion, event: approval }))
  expect(screen.getByRole('button', { name: '确认' })).toBeTruthy()
  act(() => emitWorkspace({ selectionVersion, event: { conversationId: conversation.id, requestId: 'after-list', message: { ...assistantMessage, content: '失败刷新后的有效回复' }, done: false } }))
  expect(within(screen.getByLabelText('聊天消息')).getByText('失败刷新后的有效回复')).toBeTruthy()
  act(() => emitRequest({ conversationId: conversation.id, requestId: 'after-list', state: 'completed' }))
  expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  expect(selectionVersion).toBe(selectedVersion)
  expect(bridge.selectWorkspace).toHaveBeenCalledTimes(selections)
})

it('native notice queued before bootstrap resolves opens daily with current selection version', async () => {
  const notice: PendingActionNotice = { id: 'native-daily', status: 'waiting_approval', version: 1 }
  const boot = deferred<BootstrapState>()
  vi.mocked(bridge.getBootstrap).mockReturnValueOnce(boot.promise)
  vi.mocked(bridge.getPendingActionOpen).mockResolvedValue(notice)
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: 'daily' })
  render(<App />)
  await act(async () => { boot.resolve(backendState) })
  await waitFor(() => expect(bridge.ackPendingActionOpen).toHaveBeenCalledWith({ id: notice.id, version: 1 }))
  expect(bridge.selectWorkspace).toHaveBeenLastCalledWith({ section: 'daily', conversationId: 'daily' })
  const incoming = { ...assistantMessage, conversationId: 'daily', content: 'native selection event accepted' }
  await act(async () => emitWorkspace({ selectionVersion, event: { conversationId: 'daily', requestId: 'native-request', done: false, message: incoming } }))
  expect(screen.getByText(incoming.content)).toBeTruthy()
})
it('stale native notice only acknowledges without opening a workspace', async () => {
  render(<App />); await screen.findByRole('heading', { name: '日常' })
  const calls = vi.mocked(bridge.selectWorkspace).mock.calls.length
  const notice: PendingActionNotice = { id: 'stale-native', status: 'paused', version: 3 }
  vi.mocked(bridge.getPendingActionOpen).mockResolvedValue(notice)
  await act(async () => emitPendingOpen())
  await waitFor(() => expect(bridge.ackPendingActionOpen).toHaveBeenCalledWith({ id: notice.id, version: 3 }))
  expect(bridge.selectWorkspace).toHaveBeenCalledTimes(calls)
})

it.each(['resolve', 'snapshot'] as const)('failed native notice %s remains queued and opens after renderer reload', async phase => {
  let queued: PendingActionNotice | null = null
  const notice: PendingActionNotice = { id: 'retained-native', status: 'waiting_approval', version: 7 }
  vi.mocked(bridge.getPendingActionOpen).mockImplementation(async () => queued)
  vi.mocked(bridge.ackPendingActionOpen).mockImplementation(async input => {
    if (queued?.id === input.id && queued.version === input.version) queued = null
  })
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: conversation.id })
  const first = render(<App />)
  await screen.findByRole('heading', { name: '日常' })
  queued = notice
  if (phase === 'resolve') vi.mocked(bridge.resolvePendingAction).mockRejectedValueOnce(new Error('通知定位暂时失败'))
  else vi.mocked(bridge.selectWorkspace).mockRejectedValueOnce(new Error('通知快照暂时失败'))
  await act(async () => emitPendingOpen())
  expect(await screen.findByText(phase === 'resolve' ? '通知定位暂时失败' : /通知快照暂时失败/)).toBeTruthy()
  expect(bridge.ackPendingActionOpen).not.toHaveBeenCalled()
  expect(queued).toEqual(notice)
  first.unmount()
  render(<App />)
  expect(await screen.findByRole('heading', { name: conversation.title })).toBeTruthy()
  await waitFor(() => expect(bridge.ackPendingActionOpen).toHaveBeenCalledWith({ id: notice.id, version: notice.version }))
  expect(queued).toBeNull()
})

it.each(['resolve', 'snapshot'] as const)('new user selection consumes superseded native %s without later redirect', async phase => {
  const notice: PendingActionNotice = { id: 'superseded-native', status: 'waiting_approval', version: 2 }
  render(<App />)
  await screen.findByRole('heading', { name: '日常' })
  const resolving = deferred<{ conversationId: string } | null>()
  const selecting = deferred<WorkspaceSnapshot>()
  vi.mocked(bridge.getPendingActionOpen).mockResolvedValue(notice)
  vi.mocked(bridge.resolvePendingAction).mockImplementationOnce(() => phase === 'resolve' ? resolving.promise : Promise.resolve({ conversationId: conversation.id }))
  let delayedSnapshot: WorkspaceSnapshot | undefined
  if (phase === 'snapshot') vi.mocked(bridge.selectWorkspace).mockImplementationOnce(async selection => { delayedSnapshot = await snapshot(selection); return selecting.promise })
  await act(async () => emitPendingOpen())
  await waitFor(() => expect(bridge.resolvePendingAction).toHaveBeenCalledWith({ id: notice.id, version: notice.version }))
  if (phase === 'snapshot') await waitFor(() => expect(delayedSnapshot).toBeDefined())
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await act(async () => {
    if (phase === 'resolve') resolving.resolve({ conversationId: conversation.id })
    else selecting.resolve(delayedSnapshot!)
  })
  await waitFor(() => expect(bridge.ackPendingActionOpen).toHaveBeenCalledWith({ id: notice.id, version: notice.version }))
  expect(bridge.selectWorkspace).toHaveBeenLastCalledWith({ section: 'daily' })
  expect(screen.getByRole('heading', { name: '日常' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: conversation.title })).toBeNull()
})

it('late native inbox consumes only the superseded notice and preserves newer daily draft and attachments', async () => {
  await openApp()
  const inbox = deferred<PendingActionNotice | null>()
  const notice: PendingActionNotice = { id: 'late-inbox', status: 'waiting_approval', version: 4 }
  vi.mocked(bridge.getPendingActionOpen).mockReturnValueOnce(inbox.promise)
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: conversation.id })
  await act(async () => emitPendingOpen())
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '新日常草稿不能丢失')
  vi.mocked(bridge.selectFiles).mockResolvedValueOnce({ grants: [{ ...documentGrant, conversationId: 'daily' }], files: [documentFile] })
  await chooseFiles()
  expect(await screen.findByRole('button', { name: '移除 notes.pdf' })).toBeTruthy()
  const calls = vi.mocked(bridge.selectWorkspace).mock.calls.length
  await act(async () => inbox.resolve(notice))
  expect(screen.getByRole('heading', { name: '日常' })).toBeTruthy()
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('新日常草稿不能丢失')
  expect(screen.getByRole('button', { name: '移除 notes.pdf' })).toBeTruthy()
  expect(bridge.selectWorkspace).toHaveBeenCalledTimes(calls)
  expect(bridge.resolvePendingAction).not.toHaveBeenCalled()
  expect(bridge.ackPendingActionOpen).toHaveBeenCalledExactlyOnceWith({ id: notice.id, version: notice.version })
})

it.each(['before', 'after'] as const)('queued native wakeup %s newer navigation keeps its own navigation ownership', async arrival => {
  await openApp()
  const inbox = deferred<PendingActionNotice | null>()
  const oldNotice: PendingActionNotice = { id: 'same-notice-id', status: 'paused', version: 1 }
  const newNotice = { ...oldNotice, version: 2 }
  let queued: PendingActionNotice | null = newNotice
  vi.mocked(bridge.getPendingActionOpen).mockReturnValueOnce(inbox.promise).mockImplementation(async () => queued)
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: conversation.id })
  vi.mocked(bridge.ackPendingActionOpen).mockImplementation(async input => {
    if (input.id === queued?.id && input.version === queued.version) queued = null
  })
  await act(async () => emitPendingOpen())
  if (arrival === 'before') await act(async () => emitPendingOpen())
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '用户最新草稿')
  if (arrival === 'after') await act(async () => emitPendingOpen())
  await act(async () => inbox.resolve(oldNotice))
  await waitFor(() => expect(bridge.ackPendingActionOpen).toHaveBeenCalledExactlyOnceWith({ id: newNotice.id, version: 2 }))
  expect(bridge.ackPendingActionOpen).not.toHaveBeenCalledWith({ id: oldNotice.id, version: 1 })
  expect(queued).toBeNull()
  if (arrival === 'before') {
    expect(bridge.resolvePendingAction).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: '日常' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('用户最新草稿')
  } else {
    expect(bridge.resolvePendingAction).toHaveBeenCalledExactlyOnceWith({ id: newNotice.id, version: 2 })
    expect(screen.getByRole('heading', { name: conversation.title })).toBeTruthy()
  }
})

it('failed native inbox is not consumed and can open after renderer reload', async () => {
  let queued: PendingActionNotice | null = null
  const notice: PendingActionNotice = { id: 'unread-inbox', status: 'paused', version: 5 }
  vi.mocked(bridge.getPendingActionOpen).mockImplementation(async () => queued)
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: conversation.id })
  vi.mocked(bridge.ackPendingActionOpen).mockImplementation(async () => { queued = null })
  const first = render(<App />)
  await screen.findByRole('heading', { name: '日常' })
  queued = notice
  vi.mocked(bridge.getPendingActionOpen).mockRejectedValueOnce(new Error('inbox temporarily unavailable'))
  await act(async () => emitPendingOpen())
  expect(bridge.ackPendingActionOpen).not.toHaveBeenCalled()
  expect(queued).toEqual(notice)
  first.unmount(); render(<App />)
  expect(await screen.findByRole('heading', { name: conversation.title })).toBeTruthy()
  await waitFor(() => expect(bridge.ackPendingActionOpen).toHaveBeenCalledExactlyOnceWith({ id: notice.id, version: 5 }))
})

it.each(['inbox', 'resolve'] as const)('failed native %s does not block a newer queued native click', async phase => {
  render(<App />); await screen.findByRole('heading', { name: '日常' })
  const inbox = deferred<PendingActionNotice | null>()
  const resolving = deferred<{ conversationId: string } | null>()
  const oldNotice: PendingActionNotice = { id: 'old-failed', status: 'paused', version: 1 }
  const newNotice: PendingActionNotice = { id: 'new-valid', status: 'paused', version: 3 }
  vi.mocked(bridge.getPendingActionOpen).mockReturnValueOnce(phase === 'inbox' ? inbox.promise : Promise.resolve(oldNotice)).mockResolvedValue(newNotice)
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: conversation.id })
  if (phase === 'resolve') vi.mocked(bridge.resolvePendingAction).mockReturnValueOnce(resolving.promise)
  await act(async () => emitPendingOpen())
  await act(async () => emitPendingOpen())
  await act(async () => {
    if (phase === 'inbox') inbox.reject(new Error('old inbox failed'))
    else resolving.reject(new Error('old resolution failed'))
  })
  expect(await screen.findByRole('heading', { name: conversation.title })).toBeTruthy()
  await waitFor(() => expect(bridge.ackPendingActionOpen).toHaveBeenCalledExactlyOnceWith({ id: newNotice.id, version: 3 }))
})

it.each(['opened', 'failed'] as const)('queued native wakeup survives the first native click own %s selection', async outcome => {
  render(<App />); await screen.findByRole('heading', { name: '日常' })
  const oldNotice: PendingActionNotice = { id: 'native-first', status: 'paused', version: 1 }
  const newNotice: PendingActionNotice = { id: 'native-second', status: 'paused', version: 2 }
  const resolving = deferred<{ conversationId: string } | null>()
  vi.mocked(bridge.getPendingActionOpen).mockResolvedValueOnce(oldNotice).mockResolvedValue(newNotice)
  vi.mocked(bridge.resolvePendingAction).mockReturnValueOnce(resolving.promise).mockResolvedValue({ conversationId: 'daily' })
  if (outcome === 'failed') vi.mocked(bridge.selectWorkspace).mockRejectedValueOnce(new Error('first native snapshot failed'))
  await act(async () => emitPendingOpen())
  await act(async () => emitPendingOpen())
  await act(async () => resolving.resolve({ conversationId: conversation.id }))
  await waitFor(() => expect(bridge.resolvePendingAction).toHaveBeenCalledWith({ id: newNotice.id, version: newNotice.version }))
  expect(bridge.selectWorkspace).toHaveBeenLastCalledWith({ section: 'daily', conversationId: 'daily' })
  expect(screen.getByRole('heading', { name: '日常' })).toBeTruthy()
  expect(bridge.ackPendingActionOpen).toHaveBeenCalledWith({ id: newNotice.id, version: newNotice.version })
  if (outcome === 'failed') expect(bridge.ackPendingActionOpen).not.toHaveBeenCalledWith({ id: oldNotice.id, version: oldNotice.version })
})

it('superseded native inbox may already contain the newer click and must not consume it early', async () => {
  await openApp()
  const inbox = deferred<PendingActionNotice | null>()
  const notice: PendingActionNotice = { id: 'latest-inbox-identity', status: 'paused', version: 9 }
  let queued: PendingActionNotice | null = notice
  vi.mocked(bridge.getPendingActionOpen).mockReturnValueOnce(inbox.promise).mockImplementation(async () => queued)
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: conversation.id })
  vi.mocked(bridge.ackPendingActionOpen).mockImplementation(async input => {
    if (queued?.id === input.id && queued.version === input.version) queued = null
  })
  await act(async () => emitPendingOpen())
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await act(async () => emitPendingOpen())
  await act(async () => inbox.resolve(notice))
  expect(await screen.findByRole('heading', { name: conversation.title })).toBeTruthy()
  expect(bridge.resolvePendingAction).toHaveBeenCalledExactlyOnceWith({ id: notice.id, version: 9 })
  expect(bridge.ackPendingActionOpen).toHaveBeenCalledExactlyOnceWith({ id: notice.id, version: 9 })
  expect(queued).toBeNull()
})

it('daily pending routes to original work before fetching scope cards and Her control state is not Samantha', async () => {
  const notice: PendingActionNotice = { id: 'scope-notice', version: 3, status: 'waiting_approval' }
  vi.mocked(bridge.getPendingActions).mockResolvedValue([notice])
  vi.mocked(bridge.resolvePendingAction).mockResolvedValue({ conversationId: conversation.id })
  vi.mocked(bridge.selectWorkspace).mockImplementation(async selection => {
    const value = await snapshot(selection)
    if (selection.section === 'work' && value.conversation) value.topic = { conversationId: value.conversation.id, kind: 'work', shareProgress: false, shareRevision: 1 }
    return value
  })
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...assistantMessage, status: 'complete', content: 'Her 状态：等待确认控制', hostStatus: true }])
  vi.mocked(bridge.getDelegationDetails).mockResolvedValue({ conversationId: conversation.id, delegations: [], controls: [], scopes: [{ id: 'scope', revision: 4, scope: { purpose: '私密范围哨兵', objects: ['私密对象'], completion: '交付', allowedCapabilities: ['read'], origins: [], constraints: {} } }] })
  render(<App />)
  await screen.findByText('有一件事需要你确认')
  expect(bridge.getDelegationDetails).not.toHaveBeenCalled()
  expect(screen.queryByText(/私密范围哨兵/)).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '查看' }))
  await screen.findByText(/私密范围哨兵/)
  expect(bridge.getDelegationDetails).toHaveBeenCalledWith(conversation.id)
  expect(screen.getByRole('img', { name: 'Her 状态' })).toBeTruthy()
  expect(screen.queryByRole('img', { name: 'Samantha' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '拒绝此范围' }))
  expect(bridge.rejectDelegationScope).toHaveBeenCalledWith('scope', 4)
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  await screen.findByRole('heading', { name: '日常' })
  expect(screen.queryAllByText(/私密范围哨兵|私密对象/)).toEqual([])
})


function terminalControlResult(conversationId: string): SendMessageResult {
  return { controlId: 'terminal-control', userMessage: { ...userMessage, conversationId, content: '先别发' },
    assistantMessage: { ...assistantMessage, conversationId, id: 'terminal-control', content: 'Her 状态：相关后续动作已暂缓。', status: 'complete', hostStatus: true } }
}

it.each(['daily', 'work'] as const)('terminal control in idle %s clears connecting and lets the next send own its stop identity', async section => {
  vi.mocked(bridge.sendMessage).mockImplementationOnce(async input => terminalControlResult(input.conversationId))
  if (section === 'work') await openApp()
  else { render(<App />); await screen.findByRole('heading', { name: '日常' }) }
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '先别发' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByText('Her 状态：相关后续动作已暂缓。')).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Her 状态' })).toBeTruthy()
  expect(screen.queryByText('正在连接模型…')).toBeNull()
  expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  expect((screen.getByLabelText('当前模型', { exact: true }) as HTMLSelectElement).disabled).toBe(false)
  const next = deferred<SendMessageResult>()
  vi.mocked(bridge.sendMessage).mockReturnValueOnce(next.promise)
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '继续聊聊' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(2))
  const [control, normal] = vi.mocked(bridge.sendMessage).mock.calls.map(call => call[0])
  expect(normal.requestId).not.toBe(control.requestId)
  fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith(normal.requestId))
})

it('terminal control preserves an already running source request until its genuine completion', async () => {
  backendActiveRequest = { requestId: 'real-running', conversationId: conversation.id }
  vi.mocked(bridge.sendMessage).mockResolvedValueOnce(terminalControlResult(conversation.id))
  await openApp()
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '先别发' } })
  fireEvent.keyDown(screen.getByLabelText('消息'), { key: 'Enter', code: 'Enter' })
  await screen.findByText('Her 状态：相关后续动作已暂缓。')
  fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith('real-running'))
  expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy()
  act(() => emitRequest({ ...backendActiveRequest!, state: 'cancelled' }))
  expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
})

it('terminal control resolves after navigation without changing daily or resurrecting a hidden request', async () => {
  const control = deferred<SendMessageResult>()
  vi.mocked(bridge.sendMessage).mockReturnValueOnce(control.promise)
  await openApp()
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '先别发' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledOnce())
  await userEvent.click(screen.getByRole('button', { name: '日常' }))
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '日常新草稿' } })
  await act(async () => control.resolve(terminalControlResult(conversation.id)))
  expect(screen.queryByText('Her 状态：相关后续动作已暂缓。')).toBeNull()
  expect((screen.getByLabelText('消息') as HTMLTextAreaElement).value).toBe('日常新草稿')
  await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
  await userEvent.click(screen.getByRole('button', { name: conversation.title }))
  expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  expect(screen.queryByText('正在连接模型…')).toBeNull()
})

it.each([false, true])('terminal control cannot finish a newer request when the original view is stale: %s', async navigate => {
  const control = deferred<SendMessageResult>()
  vi.mocked(bridge.sendMessage).mockReturnValueOnce(control.promise)
  await openApp()
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '先别发' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledOnce())
  if (navigate) {
    await userEvent.click(screen.getByRole('button', { name: '日常' }))
    await userEvent.click(screen.getByRole('button', { name: '一起在做的事' }))
    await userEvent.click(screen.getByRole('button', { name: conversation.title }))
  }
  act(() => emitRequest({ conversationId: conversation.id, requestId: 'new-real-request', state: 'started' }))
  await act(async () => control.resolve(terminalControlResult(conversation.id)))
  expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith('new-real-request'))
})

it('pending publication refreshes selected owner controls without a task event', async () => {
  vi.mocked(bridge.selectWorkspace).mockImplementation(async selection => {
    const value = await snapshot(selection)
    if (selection.section === 'work' && value.conversation) value.topic = { conversationId: value.conversation.id, kind: 'work', shareProgress: false, shareRevision: 1 }
    return value
  })
  await openApp()
  await screen.findByRole('region', { name: '原话题委托卡' })
  expect(screen.queryByLabelText('原话题控制确认')).toBeNull()
  vi.mocked(bridge.getDelegationDetails).mockResolvedValue({ conversationId: conversation.id, delegations: [], scopes: [], controls: [{
    id: 'terminal-control', revision: 2, kind: 'pause', effect: 'mutation', candidates: []
  }] })
  act(() => emitPending([{ id: 'opaque-control-notice', status: 'paused', version: 2 }]))
  expect(await screen.findByLabelText('原话题控制确认')).toBeTruthy()
})
