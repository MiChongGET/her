import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'
import { ProfileService } from '../src/core/storage/profiles'
import { AgentHost } from '../src/core/agent/host'
import { ChatService } from '../src/core/conversation/chat'
import { McpConnectionManager } from '../src/core/mcp/manager'
import { McpConfigService } from '../src/core/mcp/config'
import { ToolArtifactStore } from '../src/core/tools/artifacts'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { combineRegistries } from '../src/core/tools/combine'
import type { ToolExecutionContext } from '../src/core/tools/types'
import type { ChatEvent, RequestEvent } from '../src/shared/types'
import { startFixtureServer, TOOL_NAME } from './pi-sdk/wire'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const codec = { encrypt: async (text: string) => Buffer.from(text), decrypt: async (bytes: Buffer) => bytes.toString() }
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const registryWith = (name: string, run: () => void = () => {}) => {
  const registry = new SimpleToolRegistry()
  registry.register({ name, description: name, parameters: schema }, async () => { run(); return { content: [{ type: 'text', text: 'done' }] } },
    { assess: async () => ({ effect: 'read', target: name, summary: name }) })
  return registry
}

describe('combineRegistries', () => {
  it('lists every tool and routes a call to the registry that owns it', async () => {
    const calls: string[] = []
    const combined = combineRegistries([registryWith('a', () => calls.push('a')), registryWith('b', () => calls.push('b'))])
    expect(combined.getDefinitions().map(tool => tool.name)).toEqual(['a', 'b'])
    expect(Object.keys(combined.getRevisions()).sort()).toEqual(['a', 'b'])
    const context = { runId: 'r', conversationId: 'c', callId: 'k', signal: new AbortController().signal }
    await combined.execute('b', { ok: true }, context)
    expect(calls).toEqual(['b'])
    expect(await combined.execute('missing', {}, context)).toMatchObject({ isError: true })
  })

  it('refuses two registries that own the same tool name', () => {
    expect(() => combineRegistries([registryWith('same'), registryWith('same')])).toThrow('工具名称冲突')
  })
})

describe('McpConnectionManager.prepare', () => {
  async function setup(scoped: boolean, ...options: object[]) {
    const dir = mkdtempSync(join(tmpdir(), 'her-prepare-'))
    const store = new HerStore(join(dir, 'db.sqlite'))
    cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
    const configs = new McpConfigService(store, codec)
    const saved = []
    for (const [index, option] of options.entries()) saved.push(await configs.save({ name: `mock-${index}`, enabled: true, transport: 'stdio', command: process.execPath,
      args: [resolve('tests/helpers/mock-mcp.ts'), '--stdio', JSON.stringify(option)] }))
    const shared = new SimpleToolRegistry()
    const manager = new McpConnectionManager(configs, shared, new ToolArtifactStore(store), () => ({}), () => scoped)
    cleanup.push(() => manager.shutdown())
    const conversation = () => { const id = randomUUID(); store.createConversation(id, randomUUID(), 't'); return id }
    return { manager, shared, saved, conversation, configs }
  }

  it('returns the shared registry for a shared service, and a private one per conversation for a scoped service', async () => {
    const sharedSetup = await setup(false, {})
    const [shared] = await sharedSetup.manager.prepare(sharedSetup.conversation(), new AbortController().signal)
    expect(shared).toBe(sharedSetup.shared)
    expect(shared.getDefinitions()).toHaveLength(2) // the mock server advertises two tools

    const s = await setup(true, {}), a = s.conversation(), b = s.conversation()
    const forA = await s.manager.prepare(a, new AbortController().signal), forB = await s.manager.prepare(b, new AbortController().signal)
    expect(forA).toHaveLength(2)
    expect(forA[0]).toBe(s.shared)
    expect(forA[1]).not.toBe(forB[1])
    expect(s.shared.getDefinitions()).toEqual([])
    expect(combineRegistries(forA).getDefinitions()).toHaveLength(2)
  })

  it('skips a service that cannot connect instead of failing the conversation', async () => {
    const s = await setup(false, {}, {})
    await s.configs.save({ ...s.saved[1], expectedRevision: s.saved[1].revision, command: '/definitely/not/a/binary' })
    const registries = await s.manager.prepare(s.conversation(), new AbortController().signal)
    // Only the working service's two tools are present.
    expect(registries[0].getDefinitions()).toHaveLength(2)
  })

  it('stops waiting when the run is stopped', async () => {
    const s = await setup(false, { initDelay: 5000 })
    const controller = new AbortController()
    const pending = s.manager.prepare(s.conversation(), controller.signal)
    const rejected = expect(pending).rejects.toThrow('stop')
    controller.abort(new Error('stop')); await rejected
  })
})

describe('AgentHost with injected tools', () => {
  function fixture(toolsFor?: ConstructorParameters<typeof AgentHost>[3], readImage?: ConstructorParameters<typeof AgentHost>[4]) {
    const directory = mkdtempSync(join(tmpdir(), 'her-wiring-'))
    const store = new HerStore(join(directory, 'her.sqlite'))
    const profiles = new ProfileService(store, codec)
    const host = new AgentHost(store, profiles, directory, toolsFor, readImage)
    const events: ChatEvent[] = [], requests: RequestEvent[] = []
    const chat = new ChatService(store, host, event => events.push(structuredClone(event)), event => requests.push(event))
    const id = randomUUID(); store.createConversation(id, randomUUID(), 'x')
    cleanup.push(async () => { await chat.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }) })
    return { store, profiles, chat, events, requests, id }
  }

  it('runs a tool provided for the conversation and finishes the answer', async () => {
    const server = await startFixtureServer('openai', ['tool', 'text']); cleanup.push(server.close)
    const calls: string[] = [], asked: string[] = []
    const f = fixture(async conversationId => { asked.push(conversationId); return registryWith(TOOL_NAME, () => calls.push('ran')).snapshot() })
    const profile = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    const requestId = randomUUID()
    await f.chat.send({ requestId, conversationId: f.id, profileId: profile.id, content: 'go' })
    await expect.poll(() => f.requests.find(event => event.requestId === requestId && ['completed', 'failed'].includes(event.state)), { timeout: 10_000 }).toBeDefined()
    expect(asked).toEqual([f.id])
    expect(calls).toEqual(['ran'])
    expect(f.requests.at(-1)?.state).toBe('completed')
    const body = JSON.stringify(server.requests[0].body)
    expect(body).toContain(TOOL_NAME)
  }, 20_000)

  it('fails the run, without calling the model, when the tool provider throws', async () => {
    const server = await startFixtureServer('openai', 'text'); cleanup.push(server.close)
    const f = fixture(async () => { throw new Error('tools unavailable') })
    const profile = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
    const requestId = randomUUID()
    await f.chat.send({ requestId, conversationId: f.id, profileId: profile.id, content: 'go' })
    await expect.poll(() => f.requests.find(event => event.requestId === requestId && event.state === 'failed'), { timeout: 10_000 }).toBeDefined()
    expect(server.requests).toHaveLength(0)
  }, 20_000)

  describe('image tool results', () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])
    async function run(multimodal: boolean, readable = true) {
      const server = await startFixtureServer('openai', ['tool', 'text']); cleanup.push(server.close)
      let artifactId = ''
      const artifactsRef: { store?: ToolArtifactStore; read?: ConstructorParameters<typeof AgentHost>[4] } = {}
      const registry = new SimpleToolRegistry()
      registry.register({ name: TOOL_NAME, description: 'shot', parameters: schema },
        async (_args, context) => {
          const reference = await artifactsRef.store!.put(png, { conversationId: context.conversationId }, 'image/png')
          artifactId = reference.id
          return { content: [{ type: 'text', text: 'captured' }, { type: 'image', artifactId, mimeType: 'image/png' }] }
        }, { assess: async () => ({ effect: 'read', target: 'screen', summary: 'shot' }) })
      const f = fixture(async () => registry.snapshot(), (id, context) => readable ? artifactsRef.read!(id, context) : Promise.reject(new Error('gone')))
      artifactsRef.store = new ToolArtifactStore(f.store)
      artifactsRef.read = (id, context: ToolExecutionContext) => artifactsRef.store!.read(id, context)
      const profile = await f.profiles.save({ name: 'p', protocol: 'openai', baseUrl: server.baseUrl + '/v1', model: 'test-model', authMethod: 'none',
        models: [{ id: 'test-model', longOutput: false, multimodal }] })
      const requestId = randomUUID()
      await f.chat.send({ requestId, conversationId: f.id, profileId: profile.id, content: 'look' })
      await expect.poll(() => f.requests.find(event => event.requestId === requestId && ['completed', 'failed'].includes(event.state)), { timeout: 10_000 }).toBeDefined()
      return { f, requests: server.requests, state: f.requests.at(-1)?.state, base64: Buffer.from(png).toString('base64') }
    }

    it('sends the image to a vision model on the follow-up request', async () => {
      const r = await run(true)
      expect(r.state).toBe('completed')
      expect(r.requests).toHaveLength(2)
      expect(JSON.stringify(r.requests[1].body)).toContain(`data:image/png;base64,${r.base64}`)
    }, 20_000)

    it('never sends image bytes to a text-only model, only a placeholder', async () => {
      const r = await run(false)
      expect(r.state).toBe('completed')
      expect(JSON.stringify(r.requests[1].body)).not.toContain(r.base64)
      expect(JSON.stringify(r.requests[1].body)).toContain('captured')
    }, 20_000)

    it('falls back to a placeholder when the stored image cannot be read', async () => {
      const r = await run(true, false)
      expect(r.state).toBe('completed')
      expect(JSON.stringify(r.requests[1].body)).not.toContain(r.base64)
      expect(JSON.stringify(r.requests[1].body)).toContain('无法读取')
    }, 20_000)
  })
})

