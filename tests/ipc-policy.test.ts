import { randomUUID } from 'node:crypto'
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
import { ChatService } from '../src/core/conversation/chat'
import type { HerApi } from '../src/shared/types'

function ipcFixture() {
  const store = new HerStore(':memory:')
  const lifetime = new AbortController()
  const codec = { encrypt: async (text: string) => Buffer.from(text), decrypt: async (bytes: Buffer) => bytes.toString() }
  const profiles = new ProfileService(store, codec, lifetime.signal)
  const configs = new McpConfigService(store, codec, lifetime.signal)
  const registry = new SimpleToolRegistry()
  const artifacts = new ToolArtifactStore(store, lifetime.signal)
  const manager = new McpConnectionManager(configs, registry, artifacts)
  const chat = new ChatService(store)
  const mainFrame = { url: 'her://app/index.html' }
  const window = { webContents: { mainFrame } }
  registerIpc({ window: window as never, store, profiles, configs, manager, dependencies: new PresetDependencies(), artifacts, files: new FileAccessService(store, lifetime.signal), chat, lifetime: lifetime.signal, pending: new Set(), appVersion: 'test', dataDirectory: 'test', desktopPreferences: input => ({ activeProfileId: null, ...input }) })
  const event = { sender: window.webContents, senderFrame: mainFrame }
  return { store, profiles, configs, manager, lifetime, event, call: (channel: string, ...args: unknown[]) => electronMock.handlers.get(channel)!(event, ...args) }
}

it('creates persisted conversations through IPC and returns renderer summaries', async () => {
  const fixture = ipcFixture()
  try {
    const first = fixture.call('her:conversation-create')
    const second = fixture.call('her:conversation-create')
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
    expect(fixture.call('her:bootstrap').conversations).toEqual(expect.arrayContaining([first, second]))
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
  await expect(api.saveProfile({ name: sensitive, protocol: 'openai', baseUrl: sensitive, model: sensitive, authMethod: 'api-key', apiKey: sensitive })).rejects.toThrow(sensitive)
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
  const channels = ['her:queue-get', 'her:queue-cancel', 'her:queue-resume', 'her:compact', 'her:compact-stop', 'her:model-switch']
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
  await fixture.manager.shutdown(); fixture.store.close()
})
