// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App'
import type { BootstrapState, ChatEvent, ChatMessage, ConnectionTestResult, DesktopSettings, HerApi, ProviderProfile, SaveProfileInput, SendMessageInput, SendMessageResult, TestKind, TrashedConversation } from '../src/shared/types'

const profile: ProviderProfile = {
  id: 'provider-1', name: '我的模型', protocol: 'openai', baseUrl: 'https://example.com/proxy/v1', model: 'chat-model',
  hasApiKey: true, hasCustomHeaders: true,
  models: [{ id: 'chat-model', longOutput: false, multimodal: false, tests: { chat: { status: 'untested', message: '尚未测试' }, tools: { status: 'untested', message: '尚未测试' }, vision: { status: 'untested', message: '尚未测试' } } }]
}
const conversation = { id: 'conversation-1', title: '今天的事', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', lastMessage: '' }
const userMessage: ChatMessage = { id: 'user-1', conversationId: conversation.id, role: 'user', content: '陪我想想', status: 'complete', createdAt: '2026-10-13T00:00:01Z' }
const assistantMessage: ChatMessage = { id: 'assistant-1', conversationId: conversation.id, role: 'assistant', content: '', status: 'streaming', createdAt: '2026-10-13T00:00:02Z', profileId: profile.id, model: profile.model }

let bridge: HerApi
let backendState: BootstrapState
let trashedState: TrashedConversation[]
let emit: (event: ChatEvent) => void
let emitRequest: (event: import('../src/shared/types').RequestEvent) => void = () => {}
let unsubscribe: ReturnType<typeof vi.fn>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function commitProfile(input: SaveProfileInput) {
  const previous = backendState.profiles.find((item) => item.id === input.id)
  const saved: ProviderProfile = {
    ...profile, id: input.id ?? 'provider-new', name: input.name, protocol: input.protocol, baseUrl: input.baseUrl, model: input.model,
    models: (input.models ?? [{ id: input.model }]).map((entry) => ({ id: entry.id, longOutput: entry.longOutput === true, multimodal: entry.multimodal === true, tests: previous?.models.find((old) => old.id === entry.id)?.tests ?? structuredClone(profile.models[0].tests) })),
    hasApiKey: input.apiKey === undefined ? previous?.hasApiKey ?? false : input.apiKey !== '',
    hasCustomHeaders: input.customHeaders === undefined ? previous?.hasCustomHeaders ?? false : Object.keys(input.customHeaders).length > 0
  }
  const maxOutputTokens = input.protocol !== 'anthropic' ? undefined : input.maxOutputTokens === undefined ? previous?.maxOutputTokens : input.maxOutputTokens ?? undefined
  if (maxOutputTokens !== undefined) saved.maxOutputTokens = maxOutputTokens
  backendState.profiles = previous ? backendState.profiles.map((item) => item.id === saved.id ? saved : item) : [...backendState.profiles, saved]
  return structuredClone(saved)
}

function commitTest(id: string, kind: TestKind, result: ConnectionTestResult, model?: string) {
  backendState.profiles = backendState.profiles.map((item) => item.id === id ? { ...item, models: item.models.map((entry) => entry.id === (model ?? item.model) ? { ...entry, tests: { ...entry.tests, [kind]: result } } : entry) } : item)
  return result
}

beforeEach(() => {
  unsubscribe = vi.fn()
  trashedState = []
  backendState = {
    profiles: [structuredClone(profile)], conversations: [conversation],
    settings: { activeProfileId: profile.id, shortcut: 'CommandOrControl+Shift+H', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: false },
    appVersion: '0.1.0', dataDirectory: '/local/her'
  }
  emitRequest = () => {}
  bridge = {
    addDroppedFiles: vi.fn().mockResolvedValue([]), listPersistentFileGrants: vi.fn().mockResolvedValue([]),
    getFilePreview: vi.fn().mockResolvedValue({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aQ==' }), openFileSource: vi.fn().mockResolvedValue(undefined),
    selectFiles: vi.fn().mockResolvedValue({ grants: [], files: [] }),
    listFileGrants: vi.fn().mockResolvedValue([]),
    revokeFileGrant: vi.fn().mockResolvedValue(undefined),
    listMcpPresets: vi.fn().mockResolvedValue([]), checkPresetDependencies: vi.fn().mockResolvedValue([]), createMcpPreset: vi.fn(),
    onRequestEvent: vi.fn().mockImplementation(callback => { emitRequest = callback; return () => {} }),
    listMcpServices: vi.fn().mockResolvedValue([]), getMcpEnvironment: vi.fn().mockResolvedValue({}), saveMcpService: vi.fn(), deleteMcpService: vi.fn(), testMcpService: vi.fn(),
    setMcpServiceEnabled: vi.fn(), listMcpTools: vi.fn().mockResolvedValue([]), getMcpStatus: vi.fn(),
    getQueue: vi.fn().mockImplementation(async (conversationId: string) => ({ conversationId, items: [], paused: null, running: false, compacting: false })),
    cancelQueuedMessage: vi.fn().mockResolvedValue(undefined), resumeQueue: vi.fn().mockResolvedValue(undefined), compactConversation: vi.fn().mockResolvedValue(undefined),
    stopCompaction: vi.fn().mockResolvedValue(undefined), switchModel: vi.fn().mockResolvedValue(undefined),
    getConversationTask: vi.fn().mockResolvedValue(null), decideToolApproval: vi.fn().mockResolvedValue(undefined), revokeConversationApprovals: vi.fn().mockResolvedValue(undefined),
    resolveUnknownToolCall: vi.fn(),
    continueTask: vi.fn(), onTaskEvent: vi.fn().mockReturnValue(() => {}), getArtifactPreview: vi.fn(),
    getBootstrap: vi.fn().mockImplementation(async () => structuredClone(backendState)),
    saveProfile: vi.fn().mockImplementation(async (input) => commitProfile(input)),
    deleteProfile: vi.fn().mockImplementation(async (id) => { backendState.profiles = backendState.profiles.filter((item) => item.id !== id); if (backendState.settings.activeProfileId === id) backendState.settings.activeProfileId = null }),
    selectProfile: vi.fn().mockImplementation(async (id) => { backendState.settings.activeProfileId = id }),
    testProfile: vi.fn().mockImplementation(async (id, kind, model) => commitTest(id, kind, { status: 'passed', message: '连接成功' }, model)),
    createConversation: vi.fn().mockResolvedValue({ ...conversation, id: 'conversation-2', title: '新的对话' }),
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
    getSystemPrompt: vi.fn().mockResolvedValue(''),
    setSystemPrompt: vi.fn().mockResolvedValue(undefined),
    getDefaultSystemPrompt: vi.fn().mockResolvedValue('你是 Her，一个私人 AI 助手。'),
    onChatEvent: vi.fn().mockImplementation((callback) => { emit = callback; return unsubscribe }),
    openExternal: vi.fn().mockResolvedValue(undefined)
  }
  window.her = bridge
})

afterEach(() => cleanup())

async function openApp() {
  render(<App />)
  await screen.findByRole('textbox', { name: '消息' })
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
    const recent = within(screen.getByRole('region', { name: '今天的对话' }))
    expect(recent.getAllByRole('button').map(button => button.getAttribute('aria-label')).filter(name => name && !name.startsWith('删除对话'))).toEqual(['最近的对话', '上午的对话'])
    expect(within(screen.getByRole('region', { name: '昨天的对话' })).getByRole('button', { name: '昨天的对话' })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '更早的对话' })).getByRole('button', { name: '以前的对话' })).toBeTruthy()
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
    const todayToggle = screen.getByRole('button', { name: '今天' })
    await user.click(todayToggle)
    expect(todayToggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: '当前对话' })).toBeNull()
    expect(screen.getByRole('button', { name: '昨日记录' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '当前对话' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('保留这段草稿')
    await user.click(screen.getByRole('button', { name: '昨天' }))
    expect(screen.queryByRole('button', { name: '昨日记录' })).toBeNull()
    todayToggle.focus()
    await user.keyboard('{Enter}')
    expect(todayToggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: '当前对话' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: '昨日记录' })).toBeNull()
  })

  it('restores sidebar width and collapsed groups after hiding without clearing the draft', async () => {
    const user = userEvent.setup()
    backendState.conversations = [{ ...conversation, updatedAt: new Date().toISOString() }]
    await openApp()
    const separator = screen.getByRole('separator', { name: '调整侧栏宽度' })
    separator.focus()
    await user.keyboard('{ArrowRight}')
    const width = separator.getAttribute('aria-valuenow')
    await user.click(screen.getByRole('button', { name: '今天' }))
    await user.type(screen.getByRole('textbox', { name: '消息' }), '侧栏收起后继续写')
    await user.click(screen.getByRole('button', { name: '隐藏侧栏' }))
    expect(screen.queryByRole('complementary', { name: '会话侧栏' })).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('侧栏收起后继续写')
    await user.click(screen.getByRole('button', { name: '显示侧栏' }))
    expect(screen.getByRole('complementary', { name: '会话侧栏' })).toBeTruthy()
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe(width)
    expect(screen.getByRole('button', { name: '今天' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('bounds sidebar keyboard resizing and clamps the width when the window gets narrower', async () => {
    const user = userEvent.setup()
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 850 })
    try {
      await openApp()
      const separator = screen.getByRole('separator', { name: '调整侧栏宽度' })
      expect(separator.getAttribute('aria-valuenow')).toBe('210')
      separator.focus()
      await user.keyboard('{ArrowRight}')
      expect(separator.getAttribute('aria-valuenow')).toBe('226')
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
    const list = within(screen.getByRole('navigation', { name: '对话列表' }))
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
      expect(screen.getByRole('region', { name: '今天的对话' })).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(screen.queryByRole('region', { name: '今天的对话' })).toBeNull()
      expect(within(screen.getByRole('region', { name: '昨天的对话' })).getByRole('button', { name: conversation.title })).toBeTruthy()
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
    backendState = { ...state, profiles: [profile, { ...profile, id: 'provider-2', name: 'Claude 服务', protocol: 'anthropic' }] }
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

  it('uses the safe external-link bridge and disposes the stream listener', async () => {
    const user = userEvent.setup()
    vi.mocked(bridge.getMessages).mockResolvedValue([{ ...assistantMessage, content: '[资料](https://example.com/docs)\n\n![远程图片说明](https://example.com/image.png)\n\n<script>unsafe()</script>', status: 'complete' }])
    await openApp()
    await user.click(await screen.findByRole('link', { name: '资料' }))
    expect(bridge.openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('远程图片说明')).toBeTruthy()
    cleanup()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('guides the first connection and clears transient credentials after saving the selected service', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...state, profiles: [], conversations: [], settings: { ...state.settings, activeProfileId: null } }
    await openApp()
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: '配置模型服务' }))
    await user.type(screen.getByLabelText('服务名称'), 'Claude')
    await user.selectOptions(screen.getByLabelText('协议'), 'anthropic')
    await user.type(screen.getByLabelText('Base URL'), 'https://example.com/proxy/v1')
    await user.type(screen.getByLabelText('Model ID'), 'claude-model')
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

  it('shows the saved maximum output tokens only for Anthropic services', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...state, profiles: [{ ...profile, protocol: 'anthropic', maxOutputTokens: 8192 }] }
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect((screen.getByLabelText('最大输出 token 数') as HTMLInputElement).value).toBe('8192')
    await user.selectOptions(screen.getByLabelText('协议'), 'openai')
    expect(screen.queryByLabelText('最大输出 token 数')).toBeNull()
  })

  it('saves openai-responses protocol without maxOutputTokens and shows R monogram', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('button', { name: '添加服务' }))
    await user.type(screen.getByLabelText('服务名称'), '星火')
    await user.selectOptions(screen.getByLabelText('协议'), 'openai-responses')
    expect(screen.queryByLabelText('最大输出 token 数')).toBeNull()
    await user.type(screen.getByLabelText('Base URL'), 'https://example.com/v1')
    await user.type(screen.getByLabelText('Model ID'), 'spark-model')
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
    backendState = { ...state, profiles: [{ ...profile, protocol: 'anthropic' }] }
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
      expect(!!screen.queryByLabelText('最大输出 token 数')).toBe(protocol === 'anthropic')
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
    backendState = { ...state, profiles: [{ ...profile, protocol: 'anthropic' }] }
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    expect((screen.getByLabelText('最大输出 token 数') as HTMLInputElement).placeholder).toBe('留空使用默认 262144')
    expect((screen.getByLabelText('最大输出 token 数') as HTMLInputElement).max).toBe('1000000')
  })

  it('tests the chosen model and shows that model\'s result', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    const second = { id: 'second-model', longOutput: false, multimodal: false, tests: structuredClone(profile.models[0].tests) }
    backendState = { ...state, profiles: [{ ...profile, models: [...profile.models, second] }] }
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
      backendState = { ...state, profiles: structuredClone(profiles) }
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

    it('sends the chosen model, and the default when nothing was chosen', async () => {
      const user = userEvent.setup()
      await openWith([multi])
      await sendHello(user)
      expect(vi.mocked(bridge.sendMessage).mock.calls[0][0]).toMatchObject({ model: 'chat-model' })
      emit({ requestId: vi.mocked(bridge.sendMessage).mock.calls[0][0].requestId, conversationId: conversation.id, message: { ...assistantMessage, status: 'complete' }, done: true })
      await user.selectOptions(modelPicker(), 'other-model')
      expect(screen.getByText(/other-model/, { selector: '.composer-hint' })).toBeTruthy()
      await sendHello(user)
      await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledTimes(2))
      expect(vi.mocked(bridge.sendMessage).mock.calls[1][0]).toMatchObject({ model: 'other-model' })
    })

    it('returns to the default model for a new conversation', async () => {
      const user = userEvent.setup()
      await openWith([multi])
      await user.selectOptions(modelPicker(), 'other-model')
      await user.click(screen.getByRole('button', { name: '新对话' }))
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
    expect(within(screen.getByRole('button', { name: conversation.title })).getByText('完整回答')).toBeTruthy()
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
    backendState = { ...state, conversations: [] }
    vi.mocked(bridge.sendMessage).mockResolvedValue({ userMessage: { ...userMessage, conversationId: 'conversation-2' }, assistantMessage: { ...assistantMessage, conversationId: 'conversation-2' } })
    await openApp()
    await user.type(screen.getByRole('textbox', { name: '消息' }), userMessage.content)
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByRole('button', { name: userMessage.content })).toBeTruthy()
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

  it('switches to the next conversation after deleting the current one', async () => {
    const user = userEvent.setup()
    const other = { ...conversation, id: 'conversation-other', title: '另一段对话' }
    const state = await bridge.getBootstrap()
    backendState = { ...state, conversations: [conversation, other] }
    await openApp()
    await user.click(screen.getByRole('button', { name: `删除对话 ${conversation.title}` }))
    await waitFor(() => expect(bridge.trashConversation).toHaveBeenCalledWith(conversation.id))
    expect(await screen.findByRole('heading', { name: '另一段对话' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: conversation.title })).toBeNull()
  })

  it('shows the welcome screen after deleting the only conversation', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: `删除对话 ${conversation.title}` }))
    expect(await screen.findByRole('heading', { name: '我在，慢慢说。' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '新的开始' })).toBeTruthy()
  })

  it('keeps a generating conversation and shows why deleting it was refused', async () => {
    const user = userEvent.setup()
    vi.mocked(bridge.trashConversation).mockRejectedValueOnce(new Error('这段对话正在生成回答，请先停止。'))
    await openApp()
    await user.click(screen.getByRole('button', { name: `删除对话 ${conversation.title}` }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('请先停止'))
    expect(screen.getByRole('button', { name: conversation.title })).toBeTruthy()
  })

  it('does not overwrite a custom title that equals the placeholder when the first message is sent', async () => {
    const user = userEvent.setup()
    const state = await bridge.getBootstrap()
    backendState = { ...state, conversations: [{ ...conversation, title: '新的对话' }] }
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
      const names = within(screen.getByRole('navigation', { name: '对话列表' })).getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')).filter((name) => name && !name.startsWith('删除对话'))
      expect(names).toEqual(['旧对话', conversation.title])
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
      expect(within(dialog).getByText('回收站是空的。')).toBeTruthy()
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
      await waitFor(() => expect(within(dialog).getByText('回收站是空的。')).toBeTruthy())
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
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).disabled).toBe(true)
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
    await act(async () => response.resolve({ activeProfileId: profile.id, shortcut: 'CommandOrControl+Alt+A', stopShortcut: 'CommandOrControl+Shift+Escape', launchAtLogin: false }))
    await user.click(screen.getByRole('button', { name: '关闭设置' }))
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: '桌面偏好' }))
    expect((screen.getByLabelText('唤出快捷键') as HTMLInputElement).value).toBe('CommandOrControl+Alt+B')
  })

  it('does not let a dismissed first-save selection replace a newer selected service', async () => {
    const user = userEvent.setup()
    const response = deferred<void>()
    const state = await bridge.getBootstrap()
    backendState = { ...state, profiles: [profile, { ...profile, id: 'provider-2', name: '另一个服务' }], settings: { ...state.settings, activeProfileId: null } }
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

  it('renders system prompt tab and allows editing', async () => {
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: /系统提示词/ }))
    expect(screen.getByLabelText('系统提示词')).toBeDefined()
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
    const user = userEvent.setup()
    await openApp()
    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.click(screen.getByRole('tab', { name: /系统提示词/ }))
    await user.click(screen.getByRole('button', { name: '恢复默认' }))
    const textarea = screen.getByLabelText('系统提示词') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
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
    ...(status === 'awaiting_confirmation' ? { approval: { id: 'approval-1', runId: 'run-1', callId: 'call-1', revision: 'rev-1', target: '目标窗口', summary: '发送这条消息' } } : {}) }
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
  const approve = screen.getByRole('button', { name: '允许这次操作' })
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

it('offers conversation browser permission only when the Host allows it and supports revocation', async () => {
  const task = taskEvent()
  task.approval!.allowConversation = true
  const view = render(<TaskStatus task={task} canContinue={false} onContinue={() => {}} onStop={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '本轮对话自动允许浏览器操作' }))
  await waitFor(() => expect(bridge.decideToolApproval).toHaveBeenCalledWith({ approvalId: 'approval-1', revision: 'rev-1', decision: 'approve-conversation' }))
  view.rerender(<TaskStatus task={{ ...taskEvent('completed'), browserAutoApproved: true }} canContinue={false} onContinue={() => {}} onStop={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '关闭浏览器自动操作' }))
  await waitFor(() => expect(bridge.revokeConversationApprovals).toHaveBeenCalledWith(conversation.id))
  await waitFor(() => expect(screen.queryByRole('button', { name: '关闭浏览器自动操作' })).toBeNull())
})

it('reload hydrates live approval and stop identity; continuation retains trace and uses the currently selected model', async () => {
  const task = taskEvent()
  backendState.profiles[0].models.push({ ...structuredClone(profile.models[0]), id: 'selected-model' })
  vi.mocked(bridge.getConversationTask).mockResolvedValue(task)
  vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, toolMessage])
  render(<App />)
  await screen.findByText('目标窗口', { exact: false })
  fireEvent.click(screen.getByRole('button', { name: '允许这次操作' }))
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

it('a late query cannot replace a newer terminal task or move an approval into another conversation', async () => {
  const late = deferred<TaskEvent | null>()
  backendState.conversations.push({ ...conversation, id: 'conversation-2', title: '第二段' })
  vi.mocked(bridge.getConversationTask).mockImplementation(id => id === conversation.id ? late.promise : Promise.resolve(null))
  vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, toolMessage])
  render(<App />)
  await screen.findByLabelText('消息')
  act(() => emit({ requestId: 'task-request', conversationId: conversation.id, message: { ...toolMessage, status: 'cancelled' }, done: true, task: taskEvent('stopped') }))
  await act(async () => late.resolve(taskEvent()))
  expect(screen.queryByRole('button', { name: '允许这次操作' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '第二段' }))
  await waitFor(() => expect(bridge.getConversationTask).toHaveBeenCalledWith('conversation-2'))
  expect(screen.queryByLabelText('任务状态')).toBeNull()
})

const mcpA: McpServiceConfig = { id: 'mcp-a', name: 'A 服务', enabled: true, transport: 'streamable-http', url: 'http://localhost:1111/mcp', revision: 1, secretKeys: ['authorization'], hasSecrets: true }
async function openMcp() {
  vi.mocked(bridge.listMcpServices).mockResolvedValue([mcpA, { ...mcpA, id: 'mcp-b', name: 'B 服务' }])
  vi.mocked(bridge.getMcpStatus).mockImplementation(async id => ({ serviceId: id, revision: 1, state: 'ready', toolCount: 1 }))
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: '设置' }))
  fireEvent.click(await screen.findByRole('tab', { name: 'MCP 工具' }))
  await screen.findByDisplayValue('A 服务')
}

it('saves the all-conversation MCP permission and restores its checked state when reopening the service', async () => {
  vi.mocked(bridge.saveMcpService).mockResolvedValue({ ...mcpA, revision: 2, allowAllOperations: true })
  await openMcp()
  const toggle = screen.getByRole('checkbox', { name: '所有对话允许此工具的所有操作' })
  expect((toggle as HTMLInputElement).checked).toBe(false)
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: '保存 MCP 服务' }))
  await waitFor(() => expect(bridge.saveMcpService).toHaveBeenCalledWith(expect.objectContaining({ id: 'mcp-a', expectedRevision: 1, allowAllOperations: true })))
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '所有对话允许此工具的所有操作' }) as HTMLInputElement).checked).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: /B 服务/ }))
  expect((screen.getByRole('checkbox', { name: '所有对话允许此工具的所有操作' }) as HTMLInputElement).checked).toBe(false)
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

it('a task query started before a new send cannot replace the newly admitted stop identity', async () => {
  const stale = deferred<TaskEvent | null>()
  const sending = deferred<SendMessageResult>()
  vi.mocked(bridge.getConversationTask).mockReturnValue(stale.promise)
  vi.mocked(bridge.sendMessage).mockReturnValue(sending.promise)
  render(<App />)
  await screen.findByLabelText('消息')
  await waitFor(() => expect(bridge.getMessages).toHaveBeenCalled())
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'new request' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalledOnce())
  const input = vi.mocked(bridge.sendMessage).mock.calls[0][0]
  await act(async () => stale.resolve(taskEvent()))
  expect(screen.queryByRole('button', { name: '允许这次操作' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith(input.requestId))
})

it('offers the saved model vision probe and reports failed capabilities without changing the selected model', async () => {
  backendState.profiles[0].models[0].tests.vision = { status: 'failed', message: '无法识别' }
  render(<App />)
  await screen.findByText(/视觉未通过/)
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  fireEvent.click(await screen.findByRole('button', { name: '测试视觉' }))
  await waitFor(() => expect(bridge.testProfile).toHaveBeenCalledWith(profile.id, 'vision'))
  expect(bridge.selectProfile).not.toHaveBeenCalled()
})

it('reload during connection preparation restores busy and stop even before a durable task exists', async () => {
  backendState.activeRequest = { requestId: 'preparing', conversationId: conversation.id }
  vi.mocked(bridge.getConversationTask).mockResolvedValue(null)
  vi.mocked(bridge.cancelMessage).mockImplementation(async () => { backendState.activeRequest = null; emitRequest({ requestId: 'preparing', conversationId: conversation.id, state: 'cancelled' }) })
  render(<App />)
  const stop = await screen.findByRole('button', { name: '停止生成' })
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: 'second request' } })
  fireEvent.keyDown(screen.getByLabelText('消息'), { key: 'Enter', code: 'Enter' })
  expect(bridge.sendMessage).not.toHaveBeenCalled()
  fireEvent.click(stop)
  await waitFor(() => expect(bridge.cancelMessage).toHaveBeenCalledWith('preparing'))
  await screen.findByRole('button', { name: '发送' })
})

it('late bootstrap active identity cannot resurrect a task already stopped by a live event', async () => {
  const boot = deferred<BootstrapState>()
  backendState.activeRequest = { requestId: 'task-request', conversationId: conversation.id }
  vi.mocked(bridge.getBootstrap).mockReturnValueOnce(boot.promise)
  render(<App />)
  act(() => emit({ requestId: 'task-request', conversationId: conversation.id, message: { ...toolMessage, status: 'cancelled' }, done: true, task: taskEvent('stopped') }))
  await act(async () => boot.resolve(structuredClone(backendState)))
  await screen.findByLabelText('消息')
  expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  expect(screen.queryByRole('button', { name: '允许这次操作' })).toBeNull()
})


it.each(['cancelled', 'failed'] as const)('a reloaded pre-run request clears busy on its %s lifecycle event without a stop click or refresh', async state => {
  backendState.activeRequest = { requestId: 'preparing', conversationId: conversation.id }
  render(<App />)
  await screen.findByRole('button', { name: '停止生成' })
  const reads = vi.mocked(bridge.getBootstrap).mock.calls.length
  act(() => emitRequest({ requestId: 'preparing', conversationId: conversation.id, state }))
  await screen.findByRole('button', { name: '发送' })
  expect(bridge.cancelMessage).not.toHaveBeenCalled()
  expect(bridge.getBootstrap).toHaveBeenCalledTimes(reads)
})

it('late lifecycle events from the old request cannot stop or replace a newer admitted request', async () => {
  backendState.activeRequest = { requestId: 'old', conversationId: conversation.id }
  render(<App />)
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
  render(<App />)
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

it('shows per-component preset diagnostics without discarding custom MCP drafts', async () => {
  vi.mocked(bridge.listMcpPresets).mockResolvedValue([{ id: 'peekaboo', name: 'Mac 操作 · Peekaboo', defaultEnabled: true, executable: true, guidance: '原生 4.9.3 安装指引' }])
  vi.mocked(bridge.checkPresetDependencies).mockResolvedValue([{ component: 'Accessibility', status: 'permission_required', message: '请授予实际 Her 辅助功能权限' }])
  render(<App />)
  await screen.findByRole('heading', { name: '今天的事' })
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  fireEvent.click(await screen.findByRole('tab', { name: 'MCP 工具' }))
  fireEvent.change(await screen.findByLabelText('MCP 名称'), { target: { value: '未保存草稿' } })
  fireEvent.click(await screen.findByRole('button', { name: '检查预设依赖' }))
  const checks = within(await screen.findByRole('list', { name: '预设依赖检查' }))
  expect(checks.getByText('Accessibility')).toBeTruthy()
  expect(checks.getByText('需授权')).toBeTruthy()
  expect((screen.getByLabelText('MCP 名称') as HTMLInputElement).value).toBe('未保存草稿')
  expect(bridge.createMcpPreset).not.toHaveBeenCalled()
})


const documentFile = { id: 'file-1', grantId: 'grant-1', name: 'notes.pdf', mimeType: 'application/pdf', size: 100, version: 'v1' }
const documentGrant = { id: 'grant-1', kind: 'file' as const, scope: 'conversation' as const, conversationId: conversation.id, displayName: 'notes.pdf', revision: 1 }

it('attaches documents with text models and sends only IDs, preserving cancellation and retry draft', async () => {
  render(<App />)
  const add = await screen.findByRole('button', { name: '添加资料' })
  await userEvent.click(add)
  expect(screen.queryByText('notes.pdf')).toBeNull()
  vi.mocked(bridge.selectFiles).mockResolvedValueOnce({ grants: [documentGrant], files: [documentFile] })
  await userEvent.click(add)
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
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '添加资料' }))
  await userEvent.click(screen.getByRole('button', { name: '另一段' }))
  await userEvent.click(screen.getByRole('button', { name: '今天的事' }))
  await act(async () => selecting.resolve({ grants: [documentGrant], files: [documentFile] }))
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
})

it('settings lists persistent grants without a conversation and late diagnostics preserve model draft', async () => {
  backendState.conversations = []
  vi.mocked(bridge.listPersistentFileGrants).mockResolvedValue([{ ...documentGrant, kind: 'directory', scope: 'persistent', conversationId: undefined, displayName: '长期资料' }])
  const checks = deferred<import('../src/shared/types').DependencyCheck[]>()
  vi.mocked(bridge.checkPresetDependencies).mockReturnValue(checks.promise)
  render(<App />)
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
  render(<App />)
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
  render(<App />)
  await userEvent.type(await screen.findByRole('textbox', { name: '消息' }), '保留这段草稿')
  await userEvent.click(screen.getByRole('button', { name: '添加资料' }))
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
  render(<App />)
  await screen.findByRole('button', { name: '添加资料' })
  fireEvent.drop(document.querySelector('.composer-area')!, { dataTransfer: { files: [new File(['hello'], 'notes.pdf')], types: ['Files'] } })
  await userEvent.click(screen.getByRole('button', { name: '另一段' }))
  await userEvent.click(screen.getByRole('button', { name: '今天的事' }))
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
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '添加资料' }))
  await screen.findByRole('button', { name: '移除 picture.png' })
  const selection = deferred<{ grants: typeof documentGrant[]; files: typeof documentFile[] }>()
  vi.mocked(bridge.selectFiles).mockReturnValueOnce(selection.promise)
  await userEvent.click(screen.getByRole('button', { name: '添加资料' }))
  await userEvent.click(screen.getByText('资料授权 · 1'))
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
  render(<App />)
  expect(await screen.findByAltText('picture.png')).toBeTruthy()
})

it('projects pending, failed and empty document results without inventing pages', async () => {
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...assistantMessage, status: 'complete', toolCalls: [
    { id: 'pending', name: 'read_document', arguments: { fileId: 'p' }, status: 'running' },
    { id: 'failed', name: 'read_document', arguments: { fileId: 'f' }, status: 'failed', result: { isError: true, content: [{ type: 'text', text: '提取失败' }] } },
    { id: 'empty', name: 'read_document', arguments: { fileId: 'e' }, status: 'succeeded', result: { content: [], fileSources: { fileIds: ['e'] }, structuredContent: { documentId: 'e', status: 'empty', text: '', source: { fileId: 'e', name: 'empty.pdf' }, range: { offset: 0, length: 0 }, truncated: false } } }
  ] }])
  render(<App />)
  expect(await screen.findByText('正在读取…')).toBeTruthy()
  expect(screen.getByText('读取失败')).toBeTruthy()
  expect(screen.getByText('未提取到文字')).toBeTruthy()
  expect(screen.queryByText(/物理第/)).toBeNull()
})

it('late parser results in another conversation never appear in the current conversation', async () => {
  backendState.conversations.push({ ...conversation, id: 'b', title: '另一段' })
  render(<App />)
  await screen.findByRole('button', { name: '添加资料' })
  await userEvent.click(screen.getByRole('button', { name: '另一段' }))
  await act(async () => emit({ requestId: 'old-parse', conversationId: conversation.id, done: true, message: { ...assistantMessage, content: '', status: 'complete', toolCalls: [{ id: 'r', name: 'read_document', arguments: { fileId: 'f' }, status: 'succeeded', result: { content: [], fileSources: { fileIds: ['f'] }, structuredContent: { text: '迟到的资料片段', status: 'ready', source: { fileId: 'f', name: 'old.pdf' } } } }] } }))
  expect(screen.queryByText('迟到的资料片段')).toBeNull()
})

it('unmount drops pending file preview and picker results', async () => {
  const selection = deferred<{ grants: typeof documentGrant[]; files: typeof documentFile[] }>()
  vi.mocked(bridge.selectFiles).mockReturnValueOnce(selection.promise)
  const view = render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '添加资料' }))
  view.unmount()
  await act(async () => selection.resolve({ grants: [documentGrant], files: [documentFile] }))
  render(<App />)
  await screen.findByRole('button', { name: '添加资料' })
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
})

it('revocation immediately invalidates pending PDF artifact previews before the revoke reply', async () => {
  vi.mocked(bridge.listFileGrants).mockResolvedValue([documentGrant])
  const preview = deferred<{ mimeType: string; dataUrl: string }>()
  const revoking = deferred<void>()
  vi.mocked(bridge.getArtifactPreview).mockReturnValueOnce(preview.promise)
  vi.mocked(bridge.revokeFileGrant).mockReturnValueOnce(revoking.promise)
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...assistantMessage, status: 'complete', toolCalls: [{ id: 'pdf', name: 'read_pdf_pages', arguments: { fileId: 'file-1' }, status: 'succeeded', result: { content: [{ type: 'image', artifactId: 'page', mimeType: 'image/png' }], fileSources: { fileIds: ['file-1'] } } }] }])
  render(<App />)
  await userEvent.click(await screen.findByText('工具记录：1 个步骤'))
  await userEvent.click(screen.getByRole('button', { name: '查看工具图片' }))
  await userEvent.click(screen.getByText('资料授权 · 1'))
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
  render(<App />)
  await screen.findByRole('button', { name: '打开来源 notes.pdf' })
  await userEvent.click(screen.getByText('资料授权 · 1'))
  await userEvent.click(screen.getByRole('button', { name: '撤销 notes.pdf' }))
  expect(await screen.findByText('撤销未完成，请重试')).toBeTruthy()
  expect(screen.queryByText(/授权已撤销，历史保留/)).toBeNull()
  expect((screen.getByRole('button', { name: '打开来源 notes.pdf' }) as HTMLButtonElement).disabled).toBe(false)
})

it('a late historical parse result after revoke is labelled unavailable instead of ready for reading', async () => {
  vi.mocked(bridge.listFileGrants).mockResolvedValue([documentGrant])
  vi.mocked(bridge.getMessages).mockResolvedValue([{ ...userMessage, files: [documentFile] }])
  render(<App />)
  await screen.findByRole('button', { name: '打开来源 notes.pdf' })
  await userEvent.click(screen.getByText('资料授权 · 1'))
  vi.mocked(bridge.listFileGrants).mockResolvedValue([])
  await userEvent.click(screen.getByRole('button', { name: '撤销 notes.pdf' }))
  await act(async () => emit({ requestId: 'late-read', conversationId: conversation.id, done: true, message: { ...assistantMessage, status: 'complete', toolCalls: [{ id: 'doc', name: 'read_document', arguments: { fileId: 'file-1' }, status: 'succeeded', result: { content: [], fileSources: { fileIds: ['file-1'] }, structuredContent: { status: 'ready', text: '历史片段', source: { fileId: 'file-1', name: 'notes.pdf' }, range: { offset: 0, length: 4 } } } }] } }))
  expect(screen.queryByText('已提取文字')).toBeNull()
  expect(screen.getByText('历史结果 · 当前不可继续读取')).toBeTruthy()
})

it('first send rejection restores the original text in its newly owned conversation', async () => {
  backendState.conversations = []
  vi.mocked(bridge.sendMessage).mockRejectedValueOnce(new Error('模型不可用'))
  render(<App />)
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
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '添加资料' }))
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '待恢复原文')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await userEvent.click(screen.getByRole('button', { name: '添加资料' }))
  if (phase === 'completed') await act(async () => selection.resolve({ grants: [], files: [{ ...documentFile, id: 'new-file', name: 'new.pdf' }] }))
  await act(async () => response.reject(new Error('未提交')))
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('待恢复原文')
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
  await act(async () => selection.resolve({ grants: [], files: [{ ...documentFile, id: 'new-file', name: 'new.pdf' }] }))
  expect(screen.getByRole('button', { name: '移除 new.pdf' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
})

it('send rejection never restores old text or files after A to B to A', async () => {
  backendState.conversations.push({ ...conversation, id: 'b', title: '另一段' })
  const response = deferred<SendMessageResult>()
  vi.mocked(bridge.sendMessage).mockReturnValueOnce(response.promise)
  vi.mocked(bridge.selectFiles).mockResolvedValueOnce({ grants: [documentGrant], files: [documentFile] })
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '添加资料' }))
  await userEvent.type(screen.getByRole('textbox', { name: '消息' }), '旧草稿')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await userEvent.click(screen.getByRole('button', { name: '另一段' }))
  await userEvent.click(screen.getByRole('button', { name: '今天的事' }))
  await act(async () => response.reject(new Error('未提交')))
  expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('')
  expect(screen.queryByRole('button', { name: '移除 notes.pdf' })).toBeNull()
})

it.each(['新的草稿', ''])('send rejection preserves newer user text edits including intentional empty text: %s', async newer => {
  const response = deferred<SendMessageResult>()
  vi.mocked(bridge.sendMessage).mockReturnValueOnce(response.promise)
  render(<App />)
  const input = await screen.findByRole('textbox', { name: '消息' })
  await userEvent.type(input, '旧草稿')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await userEvent.type(input, '新的草稿')
  if (!newer) await userEvent.clear(input)
  await act(async () => response.reject(new Error('未提交')))
  expect((input as HTMLTextAreaElement).value).toBe(newer)
})

it('send-owned delayed creation preserves text edited while the conversation is being created', async () => {
  backendState.conversations = []
  const creation = deferred<typeof conversation>()
  vi.mocked(bridge.createConversation).mockReturnValueOnce(creation.promise)
  vi.mocked(bridge.sendMessage).mockRejectedValueOnce(new Error('未提交'))
  render(<App />)
  const input = await screen.findByRole('textbox', { name: '消息' })
  await userEvent.type(input, '原文')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await userEvent.clear(input); await userEvent.type(input, '创建期间的新草稿')
  await act(async () => creation.resolve({ ...conversation, id: 'created' }))
  await screen.findByText(/发送失败：未提交/)
  expect((input as HTMLTextAreaElement).value).toBe('创建期间的新草稿')
})


it('send-owned creation cannot reclaim the view after the user opens another conversation', async () => {
  backendState.conversations = []
  const creation = deferred<typeof conversation>()
  vi.mocked(bridge.createConversation).mockReturnValueOnce(creation.promise).mockResolvedValueOnce({ ...conversation, id: 'user-new', title: '用户新对话' })
  render(<App />)
  const input = await screen.findByRole('textbox', { name: '消息' })
  await userEvent.type(input, '旧请求')
  await userEvent.click(screen.getByRole('button', { name: '发送' }))
  await userEvent.click(screen.getByRole('button', { name: '新对话' }))
  await screen.findByRole('heading', { name: '用户新对话' })
  await userEvent.type(input, '新视图草稿')
  await act(async () => creation.resolve({ ...conversation, id: 'late-created' }))
  expect(bridge.sendMessage).not.toHaveBeenCalled()
  expect((input as HTMLTextAreaElement).value).toBe('新视图草稿')
  expect(screen.getByRole('heading', { name: '用户新对话' })).toBeTruthy()
})

describe('queue and task indicators', () => {
  const queueState = (patch: Partial<import('../src/shared/types').ConversationQueueState>) => ({
    conversationId: conversation.id, items: [], paused: null, running: false, compacting: false, ...patch })

  it('lists messages waiting behind the running reply, oldest first, with their preview', async () => {
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, assistantMessage])
    vi.mocked(bridge.getQueue).mockResolvedValue(queueState({ running: true, items: [
      { requestId: 'q1', userMessageId: 'u1', preview: '第一条排队的话', profileId: null, model: null, createdAt: '2026-10-20T08:00:00.000Z' },
      { requestId: 'q2', userMessageId: 'u2', preview: '第二条排队的话', profileId: null, model: null, createdAt: '2026-10-20T08:01:00.000Z' }] }))
    render(<App />)
    const region = await screen.findByRole('status', { name: '排队中的消息' })
    const previews = [...region.querySelectorAll('.queued-preview')].map(node => node.textContent)
    expect(previews).toEqual(['第一条排队的话', '第二条排队的话'])
  })

  it('says why the queue is waiting for the user instead of running on', async () => {
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, assistantMessage])
    vi.mocked(bridge.getQueue).mockResolvedValue(queueState({ paused: 'compaction-failed', items: [
      { requestId: 'q1', userMessageId: 'u1', preview: '等着', profileId: null, model: null, createdAt: '2026-10-20T08:00:00.000Z' }] }))
    render(<App />)
    expect(await screen.findByText('压缩失败')).toBeTruthy()
  })

  it('shows that a compaction is in progress', async () => {
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, assistantMessage])
    vi.mocked(bridge.getQueue).mockResolvedValue(queueState({ compacting: true, items: [
      { requestId: 'q1', userMessageId: 'u1', preview: '等着', profileId: null, model: null, createdAt: '2026-10-20T08:00:00.000Z' }] }))
    render(<App />)
    expect(await screen.findByText('正在压缩上下文…')).toBeTruthy()
  })

  it('shows nothing extra when nothing is queued', async () => {
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, assistantMessage])
    render(<App />)
    await waitFor(() => expect(bridge.getQueue).toHaveBeenCalledWith(conversation.id))
    await screen.findByLabelText('聊天消息')
    expect(screen.queryByRole('status', { name: '排队中的消息' })).toBeNull()
  })

  it('marks a conversation whose task is waiting for approval in the sidebar', async () => {
    vi.mocked(bridge.getConversationTask).mockResolvedValue(taskEvent())
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, toolMessage])
    render(<App />)
    const indicator = await screen.findByLabelText('等待确认')
    expect(indicator.className).toContain('awaiting_confirmation')
  })

  it('does not mark a finished task in the sidebar', async () => {
    vi.mocked(bridge.getConversationTask).mockResolvedValue(taskEvent('stopped'))
    vi.mocked(bridge.getMessages).mockResolvedValue([userMessage, toolMessage])
    render(<App />)
    await screen.findByText('已停止', { exact: false })
    expect(document.querySelector('.task-indicator')).toBeNull()
  })
})
