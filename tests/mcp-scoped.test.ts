import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpConnectionManager } from '../src/core/mcp/manager'
import { McpConfigService } from '../src/core/mcp/config'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { HerStore } from '../src/core/storage/store'
import type { ToolExecutionContext } from '../src/core/tools/types'
import type { MockOptions } from './helpers/mock-mcp'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

async function setup(scoped: boolean, options: MockOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'her-mcp-scoped-'))
  const store = new HerStore(join(dir, 'db.sqlite'))
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const configs = new McpConfigService(store, { encrypt: async text => Buffer.from(text), decrypt: async bytes => bytes.toString() })
  const saved = await configs.save({ name: 'mock', enabled: true, transport: 'stdio', command: process.execPath,
    args: [resolve('tests/helpers/mock-mcp.ts'), '--stdio', JSON.stringify(options)] })
  const shared = new SimpleToolRegistry()
  const manager = new McpConnectionManager(configs, shared, new ToolArtifactStore(store), () => ({}), () => scoped)
  cleanup.push(() => manager.shutdown())
  const conversation = () => { const id = randomUUID(); store.createConversation(id, randomUUID(), 't'); return id }
  const context = (conversationId: string, signal = new AbortController().signal): ToolExecutionContext =>
    ({ conversationId, runId: randomUUID(), callId: randomUUID(), signal, authorize: async () => {} })
  return { manager, configs, saved, shared, conversation, context }
}

describe('per-conversation MCP connections', () => {
  it('opens one connection per (conversation, service) for a scoped service and shares it otherwise', async () => {
    const scoped = await setup(true), a = scoped.conversation(), b = scoped.conversation()
    await scoped.manager.connect(scoped.saved.id, a); await scoped.manager.connect(scoped.saved.id, b); await scoped.manager.connect(scoped.saved.id, a)
    const pids = scoped.manager.getOwnedProcesses().map(p => p.pid)
    expect(pids).toHaveLength(2)
    expect(new Set(pids).size).toBe(2)

    const shared = await setup(false), c = shared.conversation(), d = shared.conversation()
    await shared.manager.connect(shared.saved.id, c); await shared.manager.connect(shared.saved.id, d)
    expect(shared.manager.getOwnedProcesses()).toHaveLength(1)
  })

  it('keeps scoped tools in a private registry per conversation', async () => {
    const s = await setup(true), a = s.conversation(), b = s.conversation()
    await s.manager.connect(s.saved.id, a); await s.manager.connect(s.saved.id, b)
    const registryA = s.manager.registryFor(s.saved.id, a), registryB = s.manager.registryFor(s.saved.id, b)
    expect(registryA).not.toBe(registryB)
    expect(registryA).not.toBe(s.shared)
    expect(registryA.getDefinitions().length).toBeGreaterThan(0)
    expect(s.shared.getDefinitions()).toEqual([])
    const nameA = registryA.getDefinitions()[0].name
    expect((await registryB.execute(nameA, { value: 0 }, s.context(b))).isError).not.toBe(true)
  })

  it('stopping conversation A\'s call does not disconnect A or touch B', async () => {
    const s = await setup(true, { callDelay: 400 }), a = s.conversation(), b = s.conversation()
    await s.manager.connect(s.saved.id, a); await s.manager.connect(s.saved.id, b)
    const before = s.manager.getOwnedProcesses().map(p => p.pid)
    const stopA = new AbortController()
    const callA = s.manager.call(s.saved.id, 'echo', { value: 0 }, s.context(a, stopA.signal))
    const stopped = expect(callA).rejects.toThrow()
    const callB = s.manager.call(s.saved.id, 'echo', { value: 0 }, s.context(b))
    await new Promise(resolve => setTimeout(resolve, 80))
    stopA.abort(new Error('stop A'))
    await stopped
    expect((await callB).isError).not.toBe(true)
    // A's connection survived the cancelled call and still serves new ones.
    expect(s.manager.getOwnedProcesses().map(p => p.pid).sort()).toEqual([...before].sort())
    expect(before.every(alive)).toBe(true)
    expect((await s.manager.call(s.saved.id, 'echo', { value: 0 }, s.context(a))).isError).not.toBe(true)
  })

  it('a configuration change drops every conversation\'s connection of that service', async () => {
    const s = await setup(true), a = s.conversation(), b = s.conversation()
    await s.manager.connect(s.saved.id, a); await s.manager.connect(s.saved.id, b)
    const pids = s.manager.getOwnedProcesses().map(p => p.pid)
    await s.configs.save({ ...s.saved, expectedRevision: s.saved.revision, name: 'renamed' })
    await expect(s.manager.call(s.saved.id, 'echo', { value: 0 }, s.context(a))).rejects.toThrow()
    await expect(s.manager.call(s.saved.id, 'echo', { value: 0 }, s.context(b))).rejects.toThrow()
    await s.manager.disconnect(s.saved.id)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(pids.some(alive)).toBe(false)
  })

  it('disconnect closes all conversations\' connections of the service', async () => {
    const s = await setup(true), a = s.conversation(), b = s.conversation()
    await s.manager.connect(s.saved.id, a); await s.manager.connect(s.saved.id, b)
    const pids = s.manager.getOwnedProcesses().map(p => p.pid)
    await s.manager.disconnect(s.saved.id)
    expect(s.manager.getOwnedProcesses()).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(pids.some(alive)).toBe(false)
  })
})
