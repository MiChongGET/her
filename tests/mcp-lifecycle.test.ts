import { afterEach, expect, it, vi } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'
import { McpConfigService } from '../src/core/mcp/config'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { createShutdown } from '../src/main/shutdown'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
afterEach(() => vi.useRealTimers())

it('fences late config and profile crypto beyond the single five-second shutdown deadline', async () => {
  vi.useFakeTimers()
  const store = new HerStore(':memory:')
  const lifetime = new AbortController()
  const gate = deferred<Buffer>()
  const codec = { encrypt: () => gate.promise, decrypt: async (bytes: Buffer) => bytes.toString() }
  const profiles = new ProfileService(store, codec, lifetime.signal)
  const configs = new McpConfigService(store, codec, lifetime.signal)
  const saves = [profiles.save({ name: 'p', protocol: 'openai', baseUrl: 'http://localhost:1234', model: 'm', contextWindow: 128000, authMethod: 'api-key', apiKey: 'secret' }), configs.save({ name: 'm', enabled: true, transport: 'stdio', command: 'node', args: [], secretValues: { TOKEN: 'secret' } })]
  const results = Promise.allSettled(saves)
  const access = vi.spyOn(store, 'getProfile'); const write = vi.spyOn(store, 'saveMcpService')
  const forced = vi.fn(); const close = vi.fn(() => store.close()); const stop = vi.fn()
  const shutdown = createShutdown({ lifetime, stop, drain: () => new Promise(() => {}), forceClose: forced, close })
  const quitting = shutdown()
  expect(lifetime.signal.aborted).toBe(true)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(shutdown()).toBe(quitting)
  await vi.advanceTimersByTimeAsync(5000)
  await quitting
  expect(forced).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1)
  access.mockClear(); write.mockClear()
  gate.resolve(Buffer.from('sealed'))
  expect((await results).every(item => item.status === 'rejected')).toBe(true)
  expect(access).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
})

import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { McpConnectionManager } from '../src/core/mcp/manager'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateShortcuts } from '../src/main/shortcuts'

const fileGate = vi.hoisted(() => ({ promise: undefined as Promise<void> | undefined, read: undefined as Promise<void> | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => { const result = await actual.readFile(...args); await fileGate.read; return result }, writeFile: async (...args: Parameters<typeof actual.writeFile>) => { await actual.writeFile(...args); await fileGate.promise } }
})


it('late decrypted connection after DB closure cannot register tools or launch a process', async () => {
  const store = new HerStore(':memory:')
  const lifetime = new AbortController()
  const gate = deferred<string>()
  const configs = new McpConfigService(store, { encrypt: async text => Buffer.from(text), decrypt: () => gate.promise }, lifetime.signal)
  const config = await configs.save({ name: 'late', enabled: true, transport: 'stdio', command: process.execPath, args: [], secretValues: { TOKEN: 'sealed' } })
  const registry = new SimpleToolRegistry()
  const manager = new McpConnectionManager(configs, registry, new ToolArtifactStore(store, lifetime.signal))
  const connecting = manager.connect(config.id)
  const result = Promise.allSettled([connecting])
  vi.useFakeTimers()
  const shutdown = createShutdown({ lifetime, stop: () => {}, drain: () => Promise.all([manager.shutdown(), result]), forceClose: () => manager.forceCloseOwnedProcesses(), close: () => store.close() })
  const quit = shutdown(); await vi.advanceTimersByTimeAsync(5000); await quit
  const read = vi.spyOn(store, 'getMcpService'); const register = vi.spyOn(registry, 'register')
  gate.resolve('{"TOKEN":"secret"}')
  expect((await result)[0].status).toBe('rejected')
  expect(read).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled(); expect(manager.getOwnedProcesses()).toEqual([])
})

it('keeps independent shortcut callbacks and rolls back registration when stop conflicts', () => {
  const previous = { shortcut: 'CommandOrControl+H', stopShortcut: 'CommandOrControl+Escape' }
  const next = { shortcut: 'CommandOrControl+J', stopShortcut: 'CommandOrControl+Shift+Escape' }
  const callbacks = new Map<string, () => void>()
  const show = vi.fn(); const stop = vi.fn(); const persist = vi.fn()
  const bindings = { show, stop, register: (key: string, action: () => void) => { callbacks.set(key, action); return true }, unregister: vi.fn() }
  updateShortcuts(previous, next, bindings, persist)
  callbacks.get(next.stopShortcut)!(); expect(stop).toHaveBeenCalledOnce(); expect(show).not.toHaveBeenCalled()
  callbacks.get(next.shortcut)!(); expect(show).toHaveBeenCalledOnce(); expect(persist).toHaveBeenCalledOnce()
  const register = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
  expect(() => updateShortcuts(previous, next, { ...bindings, register }, persist)).toThrow('停止')
  expect(bindings.unregister).toHaveBeenCalledWith(next.shortcut)
  expect(() => updateShortcuts(previous, { shortcut: 'CmdOrCtrl+Shift+Escape', stopShortcut: 'Shift+CommandOrControl+Escape' }, bindings, persist)).toThrow('不能相同')
})
