import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHost } from '../src/core/agent/host'
import type { Delegation, DelegationScope } from '../src/core/delegations/types'
import { describe, expect, it } from 'vitest'
import { isTrustedRenderer, externalUrl } from '../src/main/ipc-policy'

describe('desktop trust boundary', () => {
  it('allows only the application main frame or the exact development origin', () => {
    expect(isTrustedRenderer('her://app/index.html', undefined, true)).toBe(true)
    expect(isTrustedRenderer('her://app/index.html', undefined, false)).toBe(false)
    expect(isTrustedRenderer('her://evil/index.html', undefined, true)).toBe(false)
    expect(isTrustedRenderer('file:///etc/passwd', undefined, true)).toBe(false)
    expect(isTrustedRenderer('http://localhost:5173/', 'http://localhost:5173/', true)).toBe(true)
    expect(isTrustedRenderer('http://localhost:5174/', 'http://localhost:5173/', true)).toBe(false)
    expect(isTrustedRenderer('https://example.com/', 'http://localhost:5173/', true)).toBe(false)
  })

  it('opens only explicit HTTP links without embedded credentials', () => {
    expect(externalUrl('https://example.com/docs')).toBe('https://example.com/docs')
    expect(() => externalUrl('file:///etc/passwd')).toThrow()
    expect(() => externalUrl('javascript:alert(1)')).toThrow()
    expect(() => externalUrl('https://user:secret@example.com/')).toThrow()
  })
})

// Exercise the actual registration wrapper, not just its URL predicate.
const electronMock = vi.hoisted(() => ({ pathForFile: vi.fn(), openPath: vi.fn(async () => ''), reveal: vi.fn(), select: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })), handlers: new Map<string, (...args: any[]) => any>(), exposed: undefined as unknown, invoke: vi.fn(), listeners: new Map<string, (...args: any[]) => void>() }))
vi.mock('electron', () => ({
  webUtils: { getPathForFile: electronMock.pathForFile },
  dialog: { showOpenDialog: electronMock.select },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => electronMock.handlers.set(channel, handler) },
  shell: { openExternal: vi.fn(), openPath: electronMock.openPath, showItemInFolder: electronMock.reveal },
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { electronMock.exposed = api } },
  ipcRenderer: { invoke: electronMock.invoke, on: (channel: string, listener: (...args: any[]) => void) => electronMock.listeners.set(channel, listener), removeListener: vi.fn() }
}))
import { vi } from 'vitest'
import { createShutdown } from '../src/main/shutdown'
import { registerIpc } from '../src/main/ipc'
import { FileAccessService } from '../src/core/files/access'
import { HerStore } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'
import { PresetDependencies } from '../src/core/mcp/dependencies'
import { McpConfigService } from '../src/core/mcp/config'
import { McpConnectionManager } from '../src/core/mcp/manager'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { WorkspaceService } from '../src/core/conversation/workspace'
import { TopicHandoffService } from '../src/core/conversation/topic-handoff'
import { ChatService } from '../src/core/conversation/chat'
import type { HerApi } from '../src/shared/types'

function ipcFixture(realHost = false, revalidate = false) {
  const store = new HerStore(':memory:')
  const lifetime = new AbortController()
  const codec = { encrypt: async (text: string) => Buffer.from(text), decrypt: async (bytes: Buffer) => bytes.toString() }
  const profiles = new ProfileService(store, codec, lifetime.signal)
  const configs = new McpConfigService(store, codec, lifetime.signal)
  const registry = new SimpleToolRegistry()
  const artifacts = new ToolArtifactStore(store, lifetime.signal)
  const manager = new McpConnectionManager(configs, registry, artifacts)
  const directory = realHost ? mkdtempSync(join(tmpdir(), 'her-card-')) : ''
  const host = realHost ? new AgentHost(store, profiles, directory, undefined, undefined, undefined, undefined, { revalidate: () => revalidate }) : undefined
  const onChat = vi.fn(), onRequest = vi.fn()
  const chat = new ChatService(store, host, onChat, onRequest)
  vi.spyOn(chat, 'getMessages').mockResolvedValue([])
  const workspace = new WorkspaceService(store, chat)
  const topicHandoffs = new TopicHandoffService(store, chat, workspace)
  const mainFrame = { url: 'her://app/index.html' }
  const publish = vi.fn()
  const window = { webContents: { mainFrame, send: publish } }
  registerIpc({ window: window as never, store, profiles, configs, manager, dependencies: new PresetDependencies(), artifacts, files: new FileAccessService(store, lifetime.signal), chat, workspace, topicHandoffs, lifetime: lifetime.signal, pending: new Set(), appVersion: 'test', dataDirectory: 'test', desktopPreferences: input => ({ activeProfileId: null, appearance: 'light', ...input }), setAppearance: appearance => ({ ...store.getSettings(), appearance }), onPendingActionsChanged: () => window.webContents.send('her:workspace-pending-event', workspace.getPendingActions()) })
  const event = { sender: window.webContents, senderFrame: mainFrame }
  return { publish, onChat, onRequest, host, directory, store, workspace, chat, profiles, configs, manager, lifetime, event, call: (channel: string, ...args: unknown[]) => electronMock.handlers.get(channel)!(event, ...args) }
}

it('accepts only the three appearance preferences through IPC', () => {
  const fixture = ipcFixture()
  try {
    expect(fixture.call('her:appearance-set', 'dark')).toMatchObject({ appearance: 'dark' })
    expect(() => fixture.call('her:appearance-set', 'sepia')).toThrow('外观设置不正确')
  } finally { fixture.store.close() }
})

it('creates persisted conversations through IPC and returns renderer summaries', async () => {
  const fixture = ipcFixture()
  try {
    const firstSnapshot = await fixture.call('her:conversation-create')
    const first = firstSnapshot.conversation
    const secondSnapshot = await fixture.call('her:conversation-create')
    const second = secondSnapshot.conversation
    expect(first).toMatchObject({
      id: expect.any(String), title: '新对话', titleCustom: false,
      createdAt: expect.any(String), updatedAt: expect.any(String), lastMessage: ''
    })
    expect(Number.isFinite(Date.parse(first.createdAt))).toBe(true)
    expect(second.id).not.toBe(first.id)
    const storedFirst = fixture.store.getConversation(first.id)!
    const storedSecond = fixture.store.getConversation(second.id)!
    expect(storedFirst.piSessionId).toEqual(expect.any(String))
    expect(storedFirst.piSessionId.length).toBeGreaterThan(0)
    expect(storedSecond.piSessionId).not.toBe(storedFirst.piSessionId)
    expect(fixture.call('her:bootstrap')).not.toHaveProperty('conversations')
    expect((await fixture.call('her:workspace-select', { section: 'work' })).workItems.map((item: any) => item.conversation)).toEqual(expect.arrayContaining([first, second]))
  } finally {
    await fixture.manager.shutdown()
    fixture.store.close()
  }
})

it('rejects message-send for a conversation that was not read into the current workspace', async () => {
  const fixture = ipcFixture()
  try {
    await fixture.call('her:conversation-create')
    const privateTopic = randomUUID()
    fixture.store.createWorkConversation(privateTopic, randomUUID(), '另一话题')
    const send = vi.spyOn(fixture.chat, 'send')
    await expect(fixture.call('her:message-send', { requestId: randomUUID(), conversationId: privateTopic, profileId: 'missing', content: '不要发错地方' })).rejects.toThrow('请先进入原话题')
    expect(send).not.toHaveBeenCalled()
  } finally {
    await fixture.manager.shutdown()
    fixture.store.close()
  }
})

it('rejects every new MCP/task/artifact method from subframes or another sender and closes admission synchronously', async () => {
  const fixture = ipcFixture()
  const channels = [...electronMock.handlers.keys()].filter(channel => /her:(mcp|task|artifact)-/.test(channel))
  expect(channels).toHaveLength(17)
  expect(channels).toContain('her:mcp-environment')
  for (const channel of channels) {
    const handler = electronMock.handlers.get(channel)!
    expect(() => handler({ ...fixture.event, senderFrame: { url: 'her://app/index.html' } })).toThrow('无权')
    expect(() => handler({ ...fixture.event, sender: {} })).toThrow('无权')
  }
  fixture.lifetime.abort(new Error('closing'))
  expect(() => fixture.call('her:mcp-list')).toThrow('closing')
  await fixture.manager.shutdown(); fixture.store.close()
})

it('requires CAS and validates approval/enabling envelopes while preserving blank credentials', async () => {
  const fixture = ipcFixture()
  const saved = await fixture.call('her:mcp-save', { name: 'private', enabled: false, transport: 'stdio', command: 'node', args: [], secretValues: { TOKEN: 'hidden' } })
  expect(saved).not.toHaveProperty('secretValues')
  await expect(fixture.call('her:mcp-environment', saved.id, saved.revision)).resolves.toEqual({ TOKEN: 'hidden' })
  expect(() => fixture.call('her:mcp-save', { ...saved, name: 'stale' })).toThrow('版本')
  expect(() => fixture.call('her:mcp-enable', saved.id, 'yes', saved.revision)).toThrow()
  expect(() => fixture.call('her:task-approval', { approvalId: 'a', revision: 'r', decision: 'yes' })).toThrow()
  const changed = await fixture.call('her:mcp-save', { ...saved, expectedRevision: saved.revision, secretValues: { TOKEN: '' } })
  expect(changed.hasSecrets).toBe(true)
  const enabled = await fixture.call('her:mcp-enable', saved.id, true, changed.revision)
  expect(enabled.hasSecrets).toBe(true)
  const cleared = await fixture.call('her:mcp-save', { ...enabled, expectedRevision: enabled.revision, clearSecretKeys: ['TOKEN'] })
  expect(cleared.hasSecrets).toBe(false)
  await fixture.manager.shutdown(); fixture.store.close()
})

it('preload logs only fixed metadata on success and failure, including artifact and profile payloads', async () => {
  vi.stubEnv('NODE_ENV', 'development')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await import('../src/preload/index')
  const api = electronMock.exposed as HerApi
  const sensitive = 'SECRET-user-document-image-base64'
  electronMock.invoke.mockResolvedValue({ dataUrl: sensitive })
  await api.getArtifactPreview(sensitive, sensitive)
  electronMock.invoke.mockResolvedValue({ TOKEN: sensitive })
  await api.getMcpEnvironment('service', 1)
  expect(electronMock.invoke).toHaveBeenCalledWith('her:mcp-environment', 'service', 1)
  electronMock.invoke.mockRejectedValue(new Error(sensitive))
  await expect(api.saveProfile({ name: sensitive, protocol: 'openai', baseUrl: sensitive, model: sensitive, contextWindow: 128000, authMethod: 'api-key', apiKey: sensitive })).rejects.toThrow(sensitive)
  const logs = JSON.stringify([...log.mock.calls, ...error.mock.calls])
  expect(logs).not.toContain(sensitive)
  expect(logs).toContain('her:artifact-preview'); expect(logs).toContain('elapsedMs'); expect(logs).toContain('IPC_FAILED')
  log.mockRestore(); error.mockRestore(); vi.unstubAllEnvs()
})

it('late MCP test completion after shutdown never persists or reads closed DB', async () => {
  const fixture = ipcFixture()
  const config = await fixture.configs.save({ name: 'test', enabled: true, transport: 'stdio', command: 'node', args: [] })
  let resolve!: (value: []) => void
  vi.spyOn(fixture.manager, 'listTools').mockImplementation(() => new Promise(done => { resolve = done }))
  const testing = fixture.call('her:mcp-test', config.id) as Promise<unknown>
  const settled = Promise.allSettled([testing])
  vi.useFakeTimers()
  const shutdown = createShutdown({ lifetime: fixture.lifetime, stop: () => {}, drain: () => Promise.all([fixture.manager.shutdown(), settled]), forceClose: () => fixture.manager.forceCloseOwnedProcesses(), close: () => fixture.store.close() })
  const quitting = shutdown()
  await vi.advanceTimersByTimeAsync(5000); await quitting
  const record = vi.spyOn(fixture.store, 'recordMcpTest'); const get = vi.spyOn(fixture.store, 'getMcpService')
  resolve([])
  expect((await settled)[0].status).toBe('rejected')
  expect(record).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled()
  vi.useRealTimers()
})

it('only the main-owned picker can create grants and late selection is discarded on shutdown', async () => {
  const fixture = ipcFixture()
  const conversation = (() => { const id = randomUUID(); fixture.store.createConversation(id, randomUUID(), 't'); return { id } })()
  const input = { conversationId: conversation.id, kind: 'file', scope: 'conversation' }
  await expect(Promise.resolve().then(() => fixture.call('her:files-select', { ...input, paths: ['/etc/passwd'] }))).rejects.toThrow()
  expect(await fixture.call('her:files-select', input)).toEqual({ grants: [], files: [] })
  let resolve!: (value: { canceled: boolean; filePaths: string[] }) => void
  const promise = new Promise<{ canceled: boolean; filePaths: string[] }>(done => { resolve = done })
  electronMock.select.mockReturnValueOnce(promise)
  const pending = fixture.call('her:files-select', input)
  fixture.lifetime.abort(new Error('closing'))
  resolve({ canceled: false, filePaths: ['/etc/passwd'] })
  await expect(pending).rejects.toThrow('closing')
  expect(fixture.store.listFileGrants()).toEqual([])
  await fixture.manager.shutdown(); fixture.store.close()
})

it('returns only conversation-owned references for native selected files, with no renderer path grant method', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'her-selection-')); const path = join(directory, 'note.txt')
  await writeFile(path, 'selected')
  const fixture = ipcFixture(); const conversationId = (() => { const id = randomUUID(); fixture.store.createConversation(id, randomUUID(), 't'); return id })()
  try {
    electronMock.select.mockResolvedValueOnce({ canceled: false, filePaths: [path] })
    const selection = await fixture.call('her:files-select', { conversationId, kind: 'file', scope: 'conversation' })
    expect(selection.grants[0]).toMatchObject({ scope: 'conversation', conversationId, kind: 'file', displayName: 'note.txt' })
    expect(selection.files[0]).toMatchObject({ grantId: selection.grants[0].id, name: 'note.txt', size: 8 })
    expect(JSON.stringify(selection)).not.toContain(directory)
    expect(electronMock.handlers.has('her:files-grant')).toBe(false)
    await fixture.call('her:files-revoke', selection.grants[0].id)
    expect(await fixture.call('her:files-list', conversationId)).toEqual([])
  } finally { await fixture.manager.shutdown(); fixture.store.close(); await rm(directory, { recursive: true, force: true }) }
})

it('sanitizes missing selected-file and injected native-dialog errno paths before IPC rejection', async () => {
  const fixture = ipcFixture(); const conversationId = (() => { const id = randomUUID(); fixture.store.createConversation(id, randomUUID(), 't'); return id })()
  const input = { conversationId, kind: 'file', scope: 'conversation' }
  const privatePath = '/private/var/her-selection-secret-does-not-exist/secret.txt'
  try {
    electronMock.select.mockResolvedValueOnce({ canceled: false, filePaths: [privatePath] })
    const missing = await fixture.call('her:files-select', input).catch((error: Error) => error)
    expect(missing).toBeInstanceOf(Error)
    expect(missing.message).toMatch(/不存在|缺失/)
    expect(missing.message).not.toContain(privatePath)
    expect(missing.message).not.toContain('her-selection-secret')
    electronMock.select.mockRejectedValueOnce(Object.assign(new Error(`EACCES: open '${privatePath}'`), { code: 'EACCES', path: privatePath }))
    const denied = await fixture.call('her:files-select', input).catch((error: Error) => error)
    expect(denied).toBeInstanceOf(Error)
    expect(denied.message).toMatch(/权限/)
    expect(denied.message).not.toContain(privatePath)
    expect(denied).not.toHaveProperty('path')
    expect(fixture.store.listFileGrants()).toEqual([])
  } finally { await fixture.manager.shutdown(); fixture.store.close() }
})


it('drop preload accepts only native File provenance and main rejects directories and stale sources', async () => {
  await import('../src/preload/index')
  const api = electronMock.exposed as HerApi
  const fixture = ipcFixture(); const conversationId = (() => { const id = randomUUID(); fixture.store.createConversation(id, randomUUID(), 't'); return id })()
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const directory = await mkdtemp('/tmp/her-drop-'); const path = directory + '/note.txt'
  await writeFile(path, 'hello')
  electronMock.invoke.mockImplementation(async (channel, ...args) => fixture.call(channel, ...args))
  electronMock.pathForFile.mockReturnValue('')
  try {
    await expect(api.addDroppedFiles(conversationId, [{ path } as unknown as File])).rejects.toThrow()
    expect(fixture.store.listFileGrants()).toEqual([])
    electronMock.pathForFile.mockReturnValue(path)
    const files = await api.addDroppedFiles(conversationId, [{} as File])
    expect(files[0]).toMatchObject({ name: 'note.txt', size: 5 })
    expect(JSON.stringify(files)).not.toContain(directory)
    await api.openFileSource({ conversationId, fileId: files[0].id })
    expect(electronMock.openPath).toHaveBeenCalledWith(await (await import('node:fs/promises')).realpath(path))
    await api.revokeFileGrant(files[0].grantId)
    await expect(api.openFileSource({ conversationId, fileId: files[0].id })).rejects.toThrow()
    electronMock.pathForFile.mockReturnValue(directory)
    await expect(api.addDroppedFiles(conversationId, [{} as File])).rejects.toThrow()
    await expect(api.openFileSource({ conversationId, fileId: files[0].id, path } as never)).rejects.toThrow()
  } finally { await fixture.manager.shutdown(); fixture.store.close(); await rm(directory, { recursive: true, force: true }) }
})

it('source opening reveals launchers and persistent listing works after every conversation is purged', async () => {
  const fixture = ipcFixture(); const conversationId = (() => { const id = randomUUID(); fixture.store.createConversation(id, randomUUID(), 't'); return id })()
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const directory = await mkdtemp('/tmp/her-open-'); const path = directory + '/launch.command'
  await writeFile(path, 'echo dangerous')
  try {
    const files = await fixture.call('her:files-drop', conversationId, [path])
    electronMock.openPath.mockClear(); electronMock.reveal.mockClear()
    await fixture.call('her:files-open', { conversationId, fileId: files[0].id })
    expect(electronMock.openPath).not.toHaveBeenCalled()
    expect(electronMock.reveal).toHaveBeenCalledWith(await (await import('node:fs/promises')).realpath(path))
    electronMock.select.mockResolvedValueOnce({ canceled: false, filePaths: [directory] })
    const selection = await fixture.call('her:files-select', { conversationId, kind: 'directory', scope: 'persistent' })
    fixture.store.trashConversation(conversationId); fixture.store.purgeConversation(conversationId)
    expect(await fixture.call('her:files-persistent')).toEqual(selection.grants)
  } finally { await fixture.manager.shutdown(); fixture.store.close(); await rm(directory, { recursive: true, force: true }) }
})

it('new file actions reject untrusted frames and native directory cancellation grants nothing', async () => {
  const fixture = ipcFixture(); const conversationId = (() => { const id = randomUUID(); fixture.store.createConversation(id, randomUUID(), 't'); return id })()
  try {
    for (const channel of ['her:files-drop', 'her:files-open', 'her:files-preview', 'her:files-persistent']) {
      expect(() => electronMock.handlers.get(channel)!({ ...fixture.event, senderFrame: { url: 'her://app/index.html' } })).toThrow('无权')
    }
    electronMock.select.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await fixture.call('her:files-select', { conversationId, scope: 'persistent', kind: 'directory' })).toEqual({ files: [], grants: [] })
    expect(fixture.store.listFileGrants()).toEqual([])
  } finally { await fixture.manager.shutdown(); fixture.store.close() }
})

it.each(['revoke', 'purge', 'version', 'shutdown'] as const)('checked image preview never publishes bytes after late %s', async mode => {
  const fixture = ipcFixture(); const conversationId = (() => { const id = randomUUID(); fixture.store.createConversation(id, randomUUID(), 't'); return id })()
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const directory = await mkdtemp('/tmp/her-preview-'); const path = directory + '/image.png'
  await writeFile(path, 'image')
  let resume!: () => void; const gate = new Promise<void>(done => { resume = done })
  let reading!: () => void; const entered = new Promise<void>(done => { reading = done })
  const original = FileAccessService.prototype.readBytes
  const read = vi.spyOn(FileAccessService.prototype, 'readBytes').mockImplementation(async function(this: FileAccessService, ...args) {
    const bytes = await original.apply(this, args); reading(); await gate; return bytes
  })
  try {
    const [file] = await fixture.call('her:files-drop', conversationId, [path])
    const preview = fixture.call('her:files-preview', { conversationId, fileId: file.id })
    await entered
    if (mode === 'revoke') await fixture.call('her:files-revoke', file.grantId)
    if (mode === 'purge') { fixture.store.trashConversation(conversationId); fixture.store.purgeConversation(conversationId) }
    if (mode === 'version') await writeFile(path, 'changed-image')
    if (mode === 'shutdown') fixture.lifetime.abort(new Error('closing'))
    resume()
    await expect(preview).rejects.toThrow()
  } finally { read.mockRestore(); await fixture.manager.shutdown(); fixture.store.close(); await rm(directory, { recursive: true, force: true }) }
})

it('queue, compaction and model-switch channels reject other senders and subframes, and validate their input', async () => {
  const fixture = ipcFixture()
  const channels = ['her:queue-get', 'her:queue-cancel', 'her:queue-resume', 'her:compact', 'her:compact-stop', 'her:model-switch', 'her:context-usage']
  for (const channel of channels) {
    expect(electronMock.handlers.has(channel)).toBe(true)
    const handler = electronMock.handlers.get(channel)!
    expect(() => handler({ ...fixture.event, senderFrame: { url: 'her://app/index.html' } })).toThrow('无权')
    expect(() => handler({ ...fixture.event, sender: {} })).toThrow('无权')
  }
  expect(() => fixture.call('her:queue-get', '')).toThrow('对象标识')
  expect(() => fixture.call('her:queue-cancel', 'c', 42)).toThrow('对象标识')
  expect(() => fixture.call('her:compact', 'not an object')).toThrow('参数不正确')
  expect(() => fixture.call('her:compact', { conversationId: 'c', profileId: 'p', model: 7 })).toThrow('模型标识')
  expect(() => fixture.call('her:model-switch', { conversationId: 'c' })).toThrow('对象标识')
  expect(() => fixture.call('her:context-usage', null)).toThrow('参数不正确')
  expect(() => fixture.call('her:context-usage', { conversationId: 'c', profileId: 'p', model: 3 })).toThrow('模型标识')
  await fixture.manager.shutdown(); fixture.store.close()
})

it('workspace bootstrap excludes private titles and detail reads require explicit selection', async () => {
  const fixture = ipcFixture()
  try {
    const secretId = randomUUID()
    fixture.store.createWorkConversation(secretId, randomUUID(), '工作秘密哨兵')
    const boot = fixture.call('her:bootstrap')
    expect(boot).toHaveProperty('dailyConversationId')
    expect(boot).not.toHaveProperty('conversations')
    expect(JSON.stringify(boot)).not.toContain('工作秘密哨兵')
    await fixture.call('her:workspace-select', { section: 'daily' })
    await expect(fixture.call('her:messages', secretId)).rejects.toThrow('原话题')
    expect(() => fixture.call('her:task-get', secretId)).toThrow('原话题')
    const work = await fixture.call('her:workspace-select', { section: 'work', conversationId: secretId })
    expect(work.conversation.title).toBe('工作秘密哨兵')
  } finally { await fixture.manager.shutdown(); fixture.store.close() }
})


it('a pending detail read rejects after the workspace selection changes', async () => {
  const fixture = ipcFixture()
  try {
    const id = randomUUID()
    fixture.store.createWorkConversation(id, randomUUID(), 'private')
    await fixture.workspace.select({ section: 'work', conversationId: id })
    let finish!: (messages: []) => void
    vi.mocked(fixture.chat.getMessages).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const reading = fixture.call('her:messages', id)
    await fixture.workspace.select({ section: 'daily' })
    finish([])
    await expect(reading).rejects.toThrow('原话题')
  } finally { await fixture.manager.shutdown(); fixture.store.close() }
})

it('workspace IPC rejects untrusted senders and malformed selections or notice versions', async () => {
  const fixture = ipcFixture()
  try {
    for (const channel of ['her:workspace-select', 'her:workspace-pending', 'her:workspace-resolve-pending']) {
      const handler = electronMock.handlers.get(channel)!
      expect(() => handler({ ...fixture.event, senderFrame: { url: 'her://app/index.html' } })).toThrow('无权')
      expect(() => handler({ ...fixture.event, sender: {} })).toThrow('无权')
    }
    await expect(fixture.call('her:workspace-select', { section: 'anything' })).rejects.toThrow()
    await expect(fixture.call('her:workspace-select', { section: 'daily', secret: true })).rejects.toThrow()
    await expect(fixture.call('her:workspace-resolve-pending', { id: 'notice', version: 0 })).rejects.toThrow()
  } finally { await fixture.manager.shutdown(); fixture.store.close() }
})

it('preload keeps scoped task and chat subscriptions independent and has no raw task extraction', async () => {
  await import('../src/preload/index')
  const api = electronMock.exposed as HerApi
  const chat = vi.fn(), task = vi.fn(), request = vi.fn(), pending = vi.fn()
  api.onWorkspaceChatEvent(chat); api.onWorkspaceTaskEvent(task); api.onWorkspaceRequestEvent(request); api.onPendingActions(pending)
  const envelope = { selectionVersion: 7, event: { task: { secret: 'private' } } }
  electronMock.listeners.get('her:workspace-chat-event')!({}, envelope)
  expect(chat).toHaveBeenCalledWith(envelope)
  expect(task).not.toHaveBeenCalled()
  electronMock.listeners.get('her:workspace-task-event')!({}, envelope)
  expect(task).toHaveBeenCalledWith(envelope)
  expect(api).not.toHaveProperty('onTaskEvent')
  expect(api).not.toHaveProperty('onChatEvent')
  expect(electronMock.listeners.has('her:chat-event')).toBe(false)
})

it('workspace-list is a trusted work-only metadata bridge that preserves the selected event version', async () => {
  const fixture = ipcFixture()
  try {
    expect(electronMock.handlers.has('her:workspace-list')).toBe(true)
    const id = randomUUID()
    fixture.store.createWorkConversation(id, randomUUID(), 'private work')
    await fixture.call('her:workspace-select', { section: 'daily' })
    expect(() => fixture.call('her:workspace-list')).toThrow()
    const selected = await fixture.call('her:workspace-select', { section: 'work', conversationId: id })
    vi.mocked(fixture.chat.getMessages).mockClear()
    const tasks = vi.spyOn(fixture.chat, 'getConversationTask')
    const listed = fixture.call('her:workspace-list')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ conversation: { id }, topic: { kind: 'work' } })
    expect(fixture.chat.getMessages).not.toHaveBeenCalled(); expect(tasks).not.toHaveBeenCalled()
    expect(fixture.workspace.routeRequest({ conversationId: id, requestId: 'r', state: 'started' })?.selectionVersion).toBe(selected.version)
    const handler = electronMock.handlers.get('her:workspace-list')!
    expect(() => handler({ ...fixture.event, sender: {} })).toThrow('无权')
    expect(() => handler({ ...fixture.event, senderFrame: { url: 'her://app/index.html' } })).toThrow('无权')
    await import('../src/preload/index')
    const api = electronMock.exposed as HerApi
    electronMock.invoke.mockResolvedValue(listed)
    await expect(api.listWorkItems()).resolves.toEqual(listed)
    expect(electronMock.invoke).toHaveBeenCalledWith('her:workspace-list')
  } finally { await fixture.manager.shutdown(); fixture.store.close() }
})

it('delegation card channels require trusted main frame and reject obsolete approval payload', async () => {
  const f = ipcFixture()
  try {
    for (const channel of ['her:delegation-details', 'her:delegation-pause', 'her:delegation-cancel', 'her:delegation-resume', 'her:delegation-scope-approve', 'her:delegation-scope-reject', 'her:delegation-control-resolve', 'her:delegation-denial-prepare', 'her:delegation-denial-confirm']) {
      expect(electronMock.handlers.has(channel)).toBe(true)
      expect(() => electronMock.handlers.get(channel)!({ ...f.event, senderFrame: { url: 'her://app/index.html' } })).toThrow('无权')
    }
    expect(() => f.call('her:task-approval', { approvalId: 'old', revision: 'old', decision: 'approve-conversation' })).toThrow('决定')
  } finally { await f.manager.shutdown(); f.store.close() }
})

const cardScope: DelegationScope = { purpose: '私密卡片目的', objects: ['contact:private'], completion: '交付结果', allowedCapabilities: ['message.send'], origins: [], constraints: {} }
async function cardFixture(revalidate = false) {
  const f = ipcFixture(true, revalidate)
  const daily = f.store.ensureDailyConversation()
  await f.host!.getMessages(daily.id)
  const add = (purpose: string) => {
    const conversationId = randomUUID(); f.store.createWorkConversation(conversationId, randomUUID(), purpose)
    const d: Delegation = { id: randomUUID(), conversationId, scope: { ...cardScope, purpose }, revision: 1, status: 'active', resumeRequired: false }
    f.store.insertDelegation(d)
    const intentId = randomUUID(); f.store.saveUserIntent({ id: intentId, messageId: randomUUID(), conversationId: daily.id, text: '请安排私密工作', source: 'user', kind: 'unclassified', spans: [] })
    f.store.classifyUserIntent(intentId, 'delegate')
    f.store.insertDelegationControl({ id: randomUUID(), intentId, conversationId, proposal: { id: randomUUID(), revision: 1, scope: d.scope, evidenceSpans: [[0, 8]] }, revision: 1, status: 'approved', delegationId: d.id, requestId: randomUUID(), dispatch: 'attached' })
    return d
  }
  const a = add('私密卡片目的'), b = add('其他话题秘密')
  const select = (owner = a.conversationId) => f.call('her:workspace-select', { section: 'work', conversationId: owner })
  const control = async (text: string) => {
    const result = await f.host!.send({ requestId: randomUUID(), conversationId: daily.id, profileId: 'missing', content: text }, () => {}, () => {}, 'test')
    return f.store.listPriorityControls().find(control => control.id === result.controlId!)!
  }
  const close = async () => { await f.host!.stopAll(); await f.manager.shutdown(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }) }
  return { ...f, a, b, daily, select, control, close }
}
it('private_pending_contains_only_opaque_id_status_version and original selected owner gates details and lifecycle', async () => {
  const f = await cardFixture()
  try {
    f.host!.delegations.pause(f.a.id, 1)
    await f.call('her:workspace-select', { section: 'daily' })
    const [notice] = f.call('her:workspace-pending')
    expect(Object.keys(notice).sort()).toEqual(['id', 'status', 'version'])
    expect(JSON.stringify(notice)).not.toMatch(/私密|contact|目的/)
    expect(() => f.call('her:delegation-details', f.a.conversationId)).toThrow('原话题')
    await f.select()
    const details = f.call('her:delegation-details', f.a.conversationId)
    expect(details.delegations[0]).toMatchObject({ id: f.a.id, revision: 2 })
    expect(JSON.stringify(details)).not.toContain('其他话题秘密')
    expect(() => f.call('her:delegation-cancel', f.b.id, 1)).toThrow('原话题')
    expect(() => f.call('her:delegation-cancel', f.a.id, 1)).toThrow()
    await f.call('her:delegation-cancel', f.a.id, 2)
    expect(f.store.getDelegation(f.a.id)?.status).toBe('cancelled')
    expect(() => f.call('her:delegation-cancel', f.a.id, 2)).toThrow()
    expect(await f.call('her:workspace-resolve-pending', { id: notice.id, version: notice.version })).toBeNull()
  } finally { await f.close() }
})
it('selected owner control resolution is versioned and cannot release other owner holds', async () => {
  const f = await cardFixture()
  try {
    const c = await f.control('先别发')
    await f.select()
    const input = { conversationId: f.a.conversationId, controlId: c.id, revision: c.revision, kind: 'pause', delegationIds: [f.a.id] }
    expect(() => f.call('her:delegation-control-resolve', { ...input, delegationIds: [f.b.id] })).toThrow()
    expect(() => f.call('her:delegation-control-resolve', { ...input, revision: 0 })).toThrow()
    await f.call('her:delegation-control-resolve', input)
    const after = f.store.listPriorityControls().find(control => control.id === c.id)!
    expect(after.revision).toBeGreaterThan(c.revision)
    expect(after.heldDelegationIds).toContain(f.b.id)
    expect(() => f.call('her:delegation-control-resolve', input)).toThrow()
    await f.call('her:delegation-control-resolve', { ...input, revision: after.revision, kind: 'ordinary', delegationIds: [], candidateRevisions: [{ delegationId: f.a.id, currentRevision: 1 }] })
    expect(f.store.listPriorityControls().find(control => control.id === c.id)!.heldDelegationIds).toEqual([f.b.id])
    await f.call('her:workspace-select', { section: 'daily' })
    expect(() => f.call('her:delegation-control-resolve', { ...input, revision: f.store.listPriorityControls().find(control => control.id === c.id)!.revision })).toThrow('原话题')
  } finally { await f.close() }
})
it('another owner ordinary release cannot turn a retained mutation pause into a global ordinary bypass', async () => {
  const f = await cardFixture()
  try {
    const control = await f.control('先别发')
    await f.select()
    await f.call('her:delegation-control-resolve', { conversationId: f.a.conversationId, controlId: control.id, revision: control.revision, kind: 'pause', delegationIds: [f.a.id] })
    await f.select(f.b.conversationId)
    const current = f.store.listPriorityControls().find(value => value.id === control.id)!
    await f.call('her:delegation-control-resolve', { conversationId: f.b.conversationId, controlId: control.id, revision: current.revision,
      kind: 'ordinary', delegationIds: [], candidateRevisions: [{ delegationId: f.b.id, currentRevision: 1 }] })
    const after = f.store.listPriorityControls().find(value => value.id === control.id)!
    expect(after.heldDelegationIds).toEqual([f.a.id])
    expect(() => f.host!.delegations.assertCurrent({ id: 'call', delegationId: f.a.id, scopeRevision: 1, adapterId: 'opaque', adapterRevision: '1', payloadHash: 'hash', effect: 'unknown', targetId: 'target', capability: 'opaque', confirmation: 'always', opaque: true, dataClasses: [] })).toThrow('暂停')
    expect(after.status).toBe('resolved')
  } finally { await f.close() }
})
it('pausing a delegation does not stop another request in the same work topic', async () => {
  const f = await cardFixture()
  try {
    const requestId = randomUUID()
    vi.spyOn(f.host!, 'getActiveRequest').mockReturnValue({ requestId, conversationId: f.a.conversationId })
    const stop = vi.spyOn(f.host!, 'stopRequest')
    await f.select()
    await f.call('her:delegation-pause', f.a.id, 1)
    expect(f.store.getDelegation(f.a.id)?.status).toBe('paused')
    expect(stop).not.toHaveBeenCalled()
  } finally { await f.close() }
})
it('owner release retains unmaterialized input even when its raw conversation is the selected work', async () => {
  const f = await cardFixture()
  try {
    const unknown = randomUUID()
    f.store.saveUserIntent({ id: unknown, messageId: randomUUID(), conversationId: f.a.conversationId, text: '尚未确定委托归属', source: 'user', kind: 'unclassified', spans: [] })
    f.store.enqueueInput(f.a.conversationId, '尚未确定委托归属', null, unknown)
    const control = await f.control('先别发')
    expect(control.heldIntentIds).toContain(unknown)
    await f.select()
    expect(() => f.call('her:delegation-control-resolve', { conversationId: f.a.conversationId, controlId: control.id, revision: control.revision,
      kind: 'ordinary', delegationIds: [], candidateRevisions: [{ delegationId: f.a.id, currentRevision: 1 }] })).toThrow('普通输入')
    const after = f.store.listPriorityControls().find(value => value.id === control.id)!
    expect(after.heldIntentIds).toContain(unknown)
    expect(after.heldDelegationIds).toEqual([f.a.id, f.b.id])
    expect(after.status).toBe('waiting')
  } finally { await f.close() }
})
it('informed input-only work control release preserves daily and unmaterialized scope inputs', async () => {
  const f = await cardFixture()
  try {
    f.host!.delegations.cancel(f.a.id, 1); f.host!.delegations.cancel(f.b.id, 1)
    const addInput = (owner: string) => {
      const id = randomUUID()
      f.store.saveUserIntent({ id, messageId: randomUUID(), conversationId: owner, text: '未展示的输入正文', source: 'user', kind: 'unclassified', spans: [] })
      f.store.enqueueInput(owner, '未展示的输入正文', null, id)
      return id
    }
    const ordinary = addInput(f.a.conversationId), daily = addInput(f.daily.id), future = addInput(f.a.conversationId)
    f.store.insertDelegationControl({ id: randomUUID(), intentId: future, conversationId: f.a.conversationId, proposal: { id: randomUUID(), revision: 1, scope: cardScope, evidenceSpans: [[0, 8]] }, revision: 1, status: 'waiting', requestId: randomUUID(), dispatch: 'pending' })
    const control = await f.control('先别发')
    expect(f.chat.getPendingDelegationActions().filter(entry => entry.id.startsWith(`control:${control.id}:`))).toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: f.a.conversationId })]))
    const notices = f.call('her:workspace-pending')
    const destinations = await Promise.all(notices.map((notice: { id: string; version: string }) => f.call('her:workspace-resolve-pending', { id: notice.id, version: notice.version })))
    expect(destinations).toContainEqual({ conversationId: f.a.conversationId })
    await f.select()
    const card = f.call('her:delegation-details', f.a.conversationId).controls[0]
    expect(card).toMatchObject({ id: control.id, candidates: [], hasOwnedInputs: true })
    expect(JSON.stringify(card)).not.toMatch(/未展示的输入正文/)
    const input = { conversationId: f.a.conversationId, controlId: control.id, revision: control.revision, kind: 'ordinary', delegationIds: [], candidateRevisions: [] }
    expect(() => f.call('her:delegation-control-resolve', input)).toThrow('普通输入')
    await f.call('her:delegation-control-resolve', { ...input, releaseOwnedInputs: true })
    const after = f.store.listPriorityControls().find(value => value.id === control.id)!
    expect(after.heldIntentIds).not.toContain(ordinary)
    expect(after.heldIntentIds).toEqual(expect.arrayContaining([daily, future]))
    expect(() => f.call('her:delegation-control-resolve', { ...input, releaseOwnedInputs: true })).toThrow()
  } finally { await f.close() }
})
it('denial preparation is inert and only current selected original owner explicit confirmation uses the real Host producer', async () => {
  const f = await cardFixture()
  try {
    f.host!.delegations.reject({ id: 'action', delegationId: f.a.id, scopeRevision: 1, adapterId: 'compiled', adapterRevision: '1', effect: 'send', businessEffect: 'message.send', targetId: 'contact:private', payloadHash: 'payload', dataClasses: ['联系方式'], capability: 'message.send', confirmation: 'always', opaque: false })
    const denial = f.store.listDelegationDenials(f.a.id)[0]
    const c = await f.control('重新允许这一步')
    await f.select()
    const input = { conversationId: f.a.conversationId, controlId: c.id, revision: c.revision, delegationId: f.a.id, scopeRevision: 1, denialId: denial.id }
    expect(() => f.call('her:delegation-denial-prepare', { ...input, proof: { decision: 'withdraw-denial' } })).toThrow()
    await f.call('her:delegation-denial-prepare', input)
    expect(f.store.listDelegationDenials(f.a.id)[0].withdrawal).toBeUndefined()
    const prepared = f.store.listPriorityControls().find(control => control.id === c.id)!
    const confirm = { conversationId: f.a.conversationId, controlId: c.id, revision: prepared.revision }
    expect(() => f.call('her:delegation-denial-confirm', { ...confirm, revision: c.revision })).toThrow()
    await f.call('her:workspace-select', { section: 'daily' })
    expect(() => f.call('her:delegation-denial-confirm', confirm)).toThrow('原话题')
    await f.select()
    await f.call('her:delegation-denial-confirm', confirm)
    expect(f.store.listDelegationDenials(f.a.id)[0].withdrawal).toMatchObject({ intentId: c.intentId, denialId: denial.id, decision: 'withdraw-denial' })
    expect(f.store.getDelegation(f.a.id)).toMatchObject({ revision: 2, resumeRequired: true })
    expect(f.store.listPriorityControls().find(control => control.id === c.id)!.heldDelegationIds).toContain(f.b.id)
    expect(() => f.call('her:delegation-denial-confirm', confirm)).toThrow()
  } finally { await f.close() }
})

it('card resume of a persisted run rechecks selected owner after credentials before admission', async () => {
  const f = await cardFixture()
  try {
    const requestId = f.store.enqueueInput(f.a.conversationId, '原始运行', null)
    const runId = randomUUID()
    f.store.createTask({ id: runId, conversationId: f.a.conversationId, requestId, generation: 0, status: 'stopped', serviceId: 'saved-provider', modelId: 'saved-model', configRevision: 1, error: null }, { delegationId: f.a.id, scopeRevision: 1 })
    let release!: (value: any) => void
    const resolving = vi.spyOn(f.profiles, 'resolve').mockImplementation(() => new Promise(done => { release = done }))
    await f.select()
    const pending = f.call('her:delegation-resume', f.a.id, 1)
    void pending.catch(() => {})
    await expect.poll(() => resolving.mock.calls.length).toBe(1)
    expect(resolving.mock.calls[0]).toEqual(['saved-provider', 'saved-model'])
    await f.call('her:workspace-select', { section: 'daily' })
    release({ model: 'saved-model' })
    await expect(pending).rejects.toThrow('原话题')
    expect(f.store.getDelegation(f.a.id)?.revision).toBe(1)
    expect(f.store.getContinuation(runId)).toBeNull()
  } finally { await f.close() }
})
it('current delegation card rejects latest-topic drift while credentials for continuation are awaited', async () => {
  const f = await cardFixture()
  try {
    const addRun = (delegationId?: string) => {
      const requestId = f.store.enqueueInput(f.a.conversationId, '已完成的问答', null), id = randomUUID()
      f.store.createTask({ id, conversationId: f.a.conversationId, requestId, generation: 0, status: 'completed', serviceId: 'saved-provider', modelId: 'saved-model', configRevision: 1, error: null }, delegationId ? { delegationId, scopeRevision: 1 } : undefined)
      return id
    }
    const delegatedRun = addRun(f.a.id)
    addRun()
    let release!: (value: any) => void
    const resolving = vi.spyOn(f.profiles, 'resolve').mockImplementation(() => new Promise(done => { release = done }))
    await f.select()
    const pending = f.call('her:delegation-resume', f.a.id, 1)
    void pending.catch(() => {})
    await expect.poll(() => resolving.mock.calls.length).toBe(1)
    addRun()
    release({ model: 'saved-model' })
    await expect(pending).rejects.toThrow('原运行已变化')
    expect(f.store.getDelegation(f.a.id)?.revision).toBe(1)
    expect(f.store.getContinuation(delegatedRun)).toBeNull()
    expect(resolving).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it('late frozen input materialization reopens only its owner and does not revive a released candidate', async () => {
  const f = await cardFixture()
  try {
    const intentId = randomUUID()
    f.store.saveUserIntent({ id: intentId, messageId: randomUUID(), conversationId: f.daily.id, text: '另一件尚未归属的工作', source: 'user', kind: 'unclassified', spans: [] })
    f.store.enqueueInput(f.daily.id, '另一件尚未归属的工作', null, intentId)
    const c = await f.control('先别发')
    await f.select()
    await f.call('her:delegation-control-resolve', { conversationId: f.a.conversationId, controlId: c.id, revision: c.revision, kind: 'ordinary', delegationIds: [], candidateRevisions: [{ delegationId: f.a.id, currentRevision: 1 }] })
    const before = f.store.listPriorityControls().find(control => control.id === c.id)!
    expect(before.heldIntentIds).toContain(intentId)
    expect(before.heldDelegationIds).not.toContain(f.a.id)
    const scopeId = randomUUID()
    f.store.insertDelegationControl({ id: scopeId, intentId, conversationId: f.a.conversationId, proposal: { id: scopeId, revision: 1, scope: cardScope, evidenceSpans: [[0, 8]] }, revision: 1, status: 'waiting', requestId: randomUUID(), dispatch: 'pending' })
    await f.call('her:delegation-scope-approve', scopeId, 1)
    const after = f.store.listPriorityControls().find(control => control.id === c.id)!
    const admitted = f.store.getDelegationControl(scopeId)!.delegationId!
    expect(after.heldDelegationIds).toContain(admitted)
    expect(after.heldDelegationIds).toContain(f.b.id)
    expect(after.heldDelegationIds).not.toContain(f.a.id)
    const current = f.call('her:delegation-details', f.a.conversationId).controls.find((value: any) => value.id === c.id)
    expect(current.candidates.map((value: any) => value.delegationId)).toEqual([admitted])
    expect(() => f.call('her:delegation-control-resolve', { conversationId: f.a.conversationId, controlId: c.id, revision: before.revision, kind: 'ordinary', delegationIds: [], candidateRevisions: [{ delegationId: f.a.id, currentRevision: 1 }] })).toThrow()
    await f.call('her:delegation-control-resolve', { conversationId: f.a.conversationId, controlId: c.id, revision: after.revision, kind: 'ordinary', delegationIds: [], candidateRevisions: [{ delegationId: admitted, currentRevision: 2 }] })
    expect(f.store.listPriorityControls().find(control => control.id === c.id)!.heldIntentIds).not.toContain(intentId)
    expect(f.store.listPriorityControls().find(control => control.id === c.id)!.heldDelegationIds).toEqual([f.b.id])
  } finally { await f.close() }
})
it('scope cards reject wrong owner, stale revisions and a duplicate decision', async () => {
  const f = await cardFixture()
  try {
    const intentId = randomUUID(), scopeId = randomUUID()
    f.store.saveUserIntent({ id: intentId, messageId: randomUUID(), conversationId: f.daily.id, text: '请安排这件事', source: 'user', kind: 'unclassified', spans: [] })
    f.store.insertDelegationControl({ id: scopeId, intentId, conversationId: f.a.conversationId, proposal: { id: scopeId, revision: 1, scope: cardScope, evidenceSpans: [[0, 6]] }, revision: 1, status: 'waiting', requestId: randomUUID(), dispatch: 'pending' })
    await f.select(f.b.conversationId)
    expect(() => f.call('her:delegation-scope-approve', scopeId, 1)).toThrow('原话题')
    await f.select()
    expect(() => f.call('her:delegation-scope-approve', scopeId, 2)).toThrow()
    await f.call('her:delegation-scope-reject', scopeId, 1)
    expect(f.store.getDelegationControl(scopeId)?.status).toBe('rejected')
    expect(() => f.call('her:delegation-scope-approve', scopeId, 1)).toThrow()
  } finally { await f.close() }
})

it('card resume checks owner again at final admission credentials, before touching model history', async () => {
  const f = await cardFixture(true)
  try {
    const profile = await f.profiles.save({ name: 'isolated', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'saved-model', contextWindow: 128000, authMethod: 'none' })
    const requestId = f.store.enqueueInput(f.a.conversationId, '原始运行', null), runId = randomUUID()
    f.store.createTask({ id: runId, conversationId: f.a.conversationId, requestId, generation: 0, status: 'stopped', serviceId: profile.id, modelId: profile.model, configRevision: 1, error: null }, { delegationId: f.a.id, scopeRevision: 1 })
    const resolve = f.profiles.resolve.bind(f.profiles), provider = await resolve(profile.id)
    let release!: () => void
    const resolving = vi.spyOn(f.profiles, 'resolve').mockResolvedValueOnce(provider).mockImplementationOnce(() => new Promise(done => { release = () => done(provider) }))
    // Fail closed if admission reaches history; no model/server/business operation is allowed in this test.
    vi.spyOn(f.host! as unknown as { prepareModel(): Promise<void> }, 'prepareModel').mockRejectedValue(new Error('advanced past stale owner'))
    await f.select()
    const pending = f.call('her:delegation-resume', f.a.id, 1); void pending.catch(() => {})
    await expect.poll(() => resolving.mock.calls.length).toBe(2)
    await f.call('her:workspace-select', { section: 'daily' })
    release()
    await expect(pending).rejects.toThrow('原话题')
    expect(f.store.getContinuation(runId)).toBeNull()
    expect(f.store.getLatestTask(f.a.conversationId)?.id).toBe(runId)
  } finally { await f.close() }
})
it('a scope target quarantined elsewhere blocks explicit card resume before credentials', async () => {
  const f = await cardFixture(true)
  try {
    f.store.quarantineTarget('contact:private', f.b.conversationId, 'other-run', 'unknown-call')
    await f.select()
    await expect(f.call('her:delegation-resume', f.a.id, 1)).rejects.toThrow('未知')
    expect(f.store.getDelegation(f.a.id)?.revision).toBe(1)
  } finally { await f.close() }
})
it('ordinary control release requires the current versions actually shown on the owner card', async () => {
  const f = await cardFixture()
  try {
    const c = await f.control('先别发'); await f.select()
    f.host!.delegations.pause(f.a.id, 1)
    const input = { conversationId: f.a.conversationId, controlId: c.id, revision: c.revision, kind: 'ordinary', delegationIds: [], candidateRevisions: [{ delegationId: f.a.id, currentRevision: 1 }] }
    expect(() => f.call('her:delegation-control-resolve', input)).toThrow('版本')
    expect(f.store.listPriorityControls().find(value => value.id === c.id)?.heldDelegationIds).toContain(f.a.id)
    await f.call('her:delegation-control-resolve', { ...input, candidateRevisions: [{ delegationId: f.a.id, currentRevision: 2 }] })
    expect(f.store.getDelegation(f.a.id)).toMatchObject({ status: 'paused', revision: 2 })
    expect(f.store.listPriorityControls().find(value => value.id === c.id)?.heldDelegationIds).toEqual([f.b.id])
  } finally { await f.close() }
})

it('legacy task continue cannot bypass original-owner delegated resume controls', async () => {
  const f = await cardFixture()
  try {
    const requestId = f.store.enqueueInput(f.a.conversationId, '原始运行', null), runId = randomUUID()
    f.store.createTask({ id: runId, conversationId: f.a.conversationId, requestId, generation: 0, status: 'stopped', serviceId: 'saved-provider', modelId: 'saved-model', configRevision: 1, error: null }, { delegationId: f.a.id, scopeRevision: 1 })
    await f.call('her:workspace-select', { section: 'daily' })
    await expect(Promise.resolve().then(() => f.call('her:task-continue', { runId, requestId: randomUUID(), profileId: 'renderer-profile' }))).rejects.toThrow('原话题')
    await f.select()
    await expect(Promise.resolve().then(() => f.call('her:task-continue', { runId, requestId: randomUUID(), profileId: 'renderer-profile' }))).rejects.toThrow('明确继续委托')
    expect(f.store.getDelegation(f.a.id)?.revision).toBe(1)
  } finally { await f.close() }
})

it('unmaterialized frozen input has only a generic source-topic pending notice', async () => {
  const f = await cardFixture()
  try {
    f.host!.delegations.cancel(f.a.id, 1); f.host!.delegations.cancel(f.b.id, 1)
    const intentId = randomUUID()
    f.store.saveUserIntent({ id: intentId, messageId: randomUUID(), conversationId: f.daily.id, text: '尚未归属私密输入', source: 'user', kind: 'unclassified', spans: [] })
    f.store.enqueueInput(f.daily.id, '尚未归属私密输入', null, intentId)
    await f.control('先别发')
    await f.call('her:workspace-select', { section: 'daily' })
    const notices = f.call('her:workspace-pending')
    expect(notices).toHaveLength(1)
    expect(Object.keys(notices[0]).sort()).toEqual(['id', 'status', 'version'])
    expect(JSON.stringify(notices)).not.toMatch(/私密|contact|scope|candidate/)
    expect(await f.call('her:workspace-resolve-pending', { id: notices[0].id, version: notices[0].version })).toEqual({ conversationId: f.daily.id })
    expect(() => f.call('her:delegation-details', f.daily.id)).toThrow('原工作话题')
  } finally { await f.close() }
})

it('per-call approval requires current original owner and consumes the pending authorization only once', async () => {
  const f = ipcFixture()
  const { ToolApprovalService } = await import('../src/core/tools/approval')
  const approvals = new ToolApprovalService()
  const controller = new AbortController()
  try {
    const owner = randomUUID(); f.store.createWorkConversation(owner, randomUUID(), '私密动作')
    let request: import('../src/shared/types').ApprovalRequest | undefined, executed = 0
    const pending = approvals.authorize('call', { effect: 'send', target: 'private-target', summary: '冻结动作' }, { runId: 'run', callId: 'call', conversationId: owner, signal: controller.signal,
      approvalBinding: { revision: 'frozen', validate: () => true }, onApproval: value => { request = value } }).then(() => { executed++ })
    vi.spyOn(f.chat, 'getConversationTask').mockImplementation(id => id === owner && request ? { conversationId: owner, requestId: 'r', run: { id: 'run', requestId: 'r', conversationId: owner, assistantMessageId: 'a', status: 'waiting_approval', providerId: 'p', model: 'm', toolCallsCount: 1, activeMs: 0 }, approval: request } : null)
    vi.spyOn(f.chat, 'decideApproval').mockImplementation(async input => { approvals.decide(input) })
    const input = { approvalId: request!.id, revision: request!.revision, decision: 'approve' }
    await f.call('her:workspace-select', { section: 'daily' })
    expect(() => f.call('her:task-approval', input)).toThrow('原话题')
    expect(executed).toBe(0)
    await f.call('her:workspace-select', { section: 'work', conversationId: owner })
    expect(() => f.call('her:task-approval', { ...input, revision: 'stale' })).toThrow('失效')
    expect(() => f.call('her:task-approval', { ...input, proof: true })).toThrow('参数')
    await f.call('her:task-approval', input); await pending
    expect(executed).toBe(1)
    expect(() => f.call('her:task-approval', input)).toThrow('失效')
  } finally { controller.abort(); await f.manager.shutdown(); f.store.close() }
})

it('one explicit resume atomically releases only the selected delegation resolved whole-pause intent hold', async () => {
  const f = await cardFixture(true)
  try {
    const aOrigin = f.store.listDelegationControls().find(value => value.delegationId === f.a.id)!
    const bOrigin = f.store.listDelegationControls().find(value => value.delegationId === f.b.id)!
    const sibling = { ...f.a, id: randomUUID() }; f.store.insertDelegation(sibling)
    const siblingIntent = randomUUID(), siblingControl = randomUUID()
    f.store.saveUserIntent({ id: siblingIntent, messageId: randomUUID(), conversationId: f.daily.id, text: '同一话题的另一委托', source: 'user', kind: 'unclassified', spans: [] })
    f.store.insertDelegationControl({ id: siblingControl, intentId: siblingIntent, conversationId: f.a.conversationId, proposal: { id: siblingControl, revision: 1, scope: cardScope, evidenceSpans: [[0, 8]] }, revision: 1, status: 'approved', delegationId: sibling.id, requestId: randomUUID(), dispatch: 'attached' })
    const siblingInput = f.store.enqueueInput(f.a.conversationId, '另一委托原始工作', null)
    f.store.bindDelegationInput(siblingInput, siblingIntent, sibling.id)
    const inputId = f.store.enqueueInput(f.a.conversationId, '原始工作', null)
    f.store.bindDelegationInput(inputId, aOrigin.intentId, f.a.id)
    const ordinary = randomUUID()
    f.store.saveUserIntent({ id: ordinary, messageId: randomUUID(), conversationId: f.a.conversationId, text: '同话题普通工作', source: 'user', kind: 'unclassified', spans: [] })
    f.store.enqueueInput(f.a.conversationId, '同话题普通工作', null, ordinary)
    const stop = await f.control('暂停这件事')
    await f.select()
    await f.call('her:delegation-control-resolve', { conversationId: f.a.conversationId, controlId: stop.id, revision: stop.revision, kind: 'pause', delegationIds: [f.a.id, sibling.id] })
    const paused = f.store.getDelegation(f.a.id)!, control = f.store.listPriorityControls().find(value => value.id === stop.id)!
    expect(control.heldIntentIds).toContain(aOrigin.intentId)
    const details = f.call('her:delegation-details', f.a.conversationId)
    expect(details.controls.some((value: any) => value.id === stop.id)).toBe(true)
    expect(details.delegations[0].resumeControls).toEqual([{ id: stop.id, revision: control.revision }])
    // Exercise the actual atomic authority transition independently of model/network admission.
    expect(() => f.host!.delegations.resume(f.a.id, paused.revision)).toThrow('控制')
    expect(() => f.host!.delegations.resume(f.a.id, paused.revision, [{ id: stop.id, revision: control.revision - 1 }])).toThrow('控制')
    expect(f.store.getDelegation(f.a.id)).toMatchObject({ status: 'paused', revision: paused.revision })
    const resumed = f.host!.delegations.resume(f.a.id, paused.revision, [{ id: stop.id, revision: control.revision }])
    expect(resumed).toMatchObject({ status: 'active', revision: paused.revision + 1 })
    const after = f.store.listPriorityControls().find(value => value.id === stop.id)!
    expect(after.heldIntentIds).not.toContain(aOrigin.intentId)
    expect(after.heldIntentIds).toContain(siblingIntent)
    expect(after.heldIntentIds).toContain(ordinary)
    expect(f.store.getDelegation(sibling.id)?.status).toBe('paused')
    expect(after.heldDelegationIds).toContain(f.b.id)
    expect(after.revision).toBe(control.revision + 1)
    expect(f.store.getUserIntent(bOrigin.intentId)).toBeTruthy()
  } finally { await f.close() }
})


it.each(['daily', 'work'] as const)('message-send terminal control publishes opaque pending and current owner cards from idle %s', async section => {
  const f = await cardFixture()
  try {
    f.host!.delegations.pause(f.a.id, 1)
    await f.select()
    const before = f.call('her:delegation-details', f.a.conversationId)
    expect(before.controls).toEqual([])
    f.workspace.getPendingActions()
    if (section === 'daily') await f.call('her:workspace-select', { section: 'daily' })
    const input = { requestId: randomUUID(), conversationId: section === 'daily' ? f.daily.id : f.a.conversationId, profileId: 'missing', content: '先别发' }
    f.publish.mockClear(); f.onChat.mockClear(); f.onRequest.mockClear()
    const result = await f.call('her:message-send', input)
    expect(result).toMatchObject({ controlId: expect.any(String), userMessage: { conversationId: input.conversationId, content: '先别发', status: 'complete' }, assistantMessage: { conversationId: input.conversationId, hostStatus: true, status: 'complete' } })
    expect(f.publish).toHaveBeenCalledOnce()
    const [channel, notices] = f.publish.mock.calls[0]
    expect(channel).toBe('her:workspace-pending-event')
    expect(notices).toHaveLength(section === 'daily' ? 3 : 2)
    for (const notice of notices) expect(Object.keys(notice).sort()).toEqual(['id', 'status', 'version'])
    expect(JSON.stringify(notices)).not.toMatch(/私密|contact|目的/)
    const destinations = await Promise.all(notices.map((notice: { id: string; version: number }) => f.call('her:workspace-resolve-pending', { id: notice.id, version: notice.version })))
    expect(destinations).toContainEqual({ conversationId: f.a.conversationId })
    await f.select()
    const after = f.call('her:delegation-details', f.a.conversationId)
    expect(after.controls).toEqual(expect.arrayContaining([expect.objectContaining({ id: result.controlId, revision: section === 'daily' ? 2 : 3 })]))
    expect(f.host!.getActiveRequest(input.conversationId)).toBeNull()
    expect(f.store.getLatestTask(input.conversationId)).toBeNull()
    expect(f.onChat).not.toHaveBeenCalled()
    expect(f.onRequest).not.toHaveBeenCalled()
    const history = await f.host!.getMessages(input.conversationId)
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ id: result.assistantMessage.id, hostStatus: true })]))
  } finally { await f.close() }
})
